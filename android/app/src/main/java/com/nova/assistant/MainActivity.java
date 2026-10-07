package com.nova.assistant;

import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.ArrayList;

/**
 * Full-screen WebView into the Nova web app.
 *
 * Android WebView has no window.SpeechRecognition — so this activity bridges
 * the NATIVE Android recognizer into JavaScript:
 *
 *   JS: NovaNative.start() / .stop() / .isAvailable()
 *   Native -> JS: window.NovaSpeechResult(transcript, isFinal) / NovaSpeechError(code)
 *
 * The web app prefers the bridge when present (window.NovaNative), so voice
 * works fully inside the APK, including the hands-free loop.
 */
public class MainActivity extends Activity {
    private WebView web;
    private SpeechRecognizer recog;
    private boolean listening = false;

    private static final int REQ_MIC = 9001;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);

        web.addJavascriptInterface(new Bridge(), "NovaNative");

        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    // Auto-grant WebView media (mic) once the user allowed it at app level.
                    if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(request.getResources());
                    } else {
                        request.deny();
                    }
                });
            }
        });

        askMicPermission();
        web.loadUrl("https://luxury-frangollo-487c4e.netlify.app/");

        // Start the always-on wake service (screen off, app closed = still listening).
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            android.content.Intent svc = new android.content.Intent(this, WakeService.class);
            if (android.os.Build.VERSION.SDK_INT >= 26) startForegroundService(svc);
            else startService(svc);
        }
    }

    private void askMicPermission() {
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, REQ_MIC);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code == REQ_MIC && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            web.reload(); // now the WebView can capture audio too
        }
    }

    /** Native recognizer control, called from JavaScript. */
    public class Bridge {
        @JavascriptInterface
        public boolean isAvailable() {
            return SpeechRecognizer.isRecognitionAvailable(getApplicationContext());
        }

        @JavascriptInterface
        public void start() {
            runOnUiThread(() -> startNativeListening());
        }

        @JavascriptInterface
        public void stop() {
            runOnUiThread(() -> { listening = false; if (recog != null) { try { recog.cancel(); } catch (Exception ignored) {} } });
        }

        @JavascriptInterface
        public String deviceName() {
            return android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL;
        }

        @JavascriptInterface
        public void vibrate(int ms) {
            android.os.Vibrator v = (android.os.Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (v != null && v.hasVibrator()) v.vibrate(ms);
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(() -> android.widget.Toast.makeText(MainActivity.this, msg, android.widget.Toast.LENGTH_SHORT).show());
        }
    }

    private void startNativeListening() {
        if (listening) return;
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            evalJs("window.NovaSpeechError && NovaSpeechError('not-allowed')");
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            evalJs("window.NovaSpeechError && NovaSpeechError('unavailable')");
            return;
        }
        listening = true;
        if (recog != null) { try { recog.destroy(); } catch (Exception ignored) {} }
        recog = SpeechRecognizer.createSpeechRecognizer(this);
        recog.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle p) { evalJs("window.NovaSpeechReady && NovaSpeechReady()"); }
            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float r) {
                evalJs("window.NovaSpeechRms && NovaSpeechRms(" + r + ")");
            }
            @Override public void onBufferReceived(byte[] b) {}
            @Override public void onEndOfSpeech() {}
            @Override public void onPartialResults(Bundle p) {
                ArrayList<String> list = p.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                if (list != null && !list.isEmpty()) {
                    String partial = android.text.TextUtils.join(" ", list).replace("\\", "\\\\").replace("\"", "\\\\\"").replace("\n", " ");
                    evalJs("window.NovaSpeechPartial && NovaSpeechPartial(\"" + partial + "\")");
                }
            }
            @Override public void onEvent(int t, Bundle p) {}

            @Override
            public void onResults(Bundle results) {
                listening = false;
                ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                String said = (list != null && !list.isEmpty()) ? list.get(0) : "";
                String safe = said.replace("\\", "\\\\").replace("\"", "\\\\\"").replace("\n", " ");
                evalJs("window.NovaSpeechResult && NovaSpeechResult(\"" + safe + "\", true)");
                // Auto re-arm so the hands-free loop keeps flowing (JS can also restart explicitly).
            }

            @Override
            public void onError(int err) {
                listening = false;
                String code = (err == SpeechRecognizer.ERROR_NO_MATCH || err == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) ? "no-speech"
                        : (err == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) ? "not-allowed"
                        : (err == SpeechRecognizer.ERROR_NETWORK || err == SpeechRecognizer.ERROR_NETWORK_TIMEOUT) ? "network"
                        : (err == SpeechRecognizer.ERROR_AUDIO) ? "audio-capture" : "unknown";
                evalJs("window.NovaSpeechError && NovaSpeechError('" + code + "')");
            }
        });

        android.content.Intent si = new android.content.Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        si.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        si.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US");
        si.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        muteBeep();
        recog.startListening(si);
        new android.os.Handler(getMainLooper()).postDelayed(this::unmuteBeep, 700);
    }

    /* Same ding-suppression as WakeService: Android plays a system beep at
       every recognizer start; hands-free cycles would beep constantly. */
    private boolean beepMuted = false;
    private void muteBeep() {
        try {
            android.media.AudioManager am = (android.media.AudioManager) getSystemService(AUDIO_SERVICE);
            if (am == null || am.isMusicActive()) return;
            am.adjustStreamVolume(android.media.AudioManager.STREAM_MUSIC,
                    android.media.AudioManager.ADJUST_MUTE, 0);
            beepMuted = true;
        } catch (Exception ignored) {}
    }
    private void unmuteBeep() {
        try {
            android.media.AudioManager am = (android.media.AudioManager) getSystemService(AUDIO_SERVICE);
            if (beepMuted && am != null) {
                am.adjustStreamVolume(android.media.AudioManager.STREAM_MUSIC,
                        android.media.AudioManager.ADJUST_UNMUTE, 0);
            }
            beepMuted = false;
        } catch (Exception ignored) {}
    }

    private void evalJs(String js) {
        if (web != null) web.post(() -> web.evaluateJavascript(js, null));
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    @Override
    protected void onResume() { super.onResume(); if (web != null) web.onResume();
        // App is in front — it listens now. Pause the background wake mic so
        // there is exactly ONE active recognizer (and no double beeps).
        startService(new Intent(this, WakeService.class).setAction(WakeService.ACTION_PAUSE)); }

    @Override
    protected void onPause() { super.onPause(); if (web != null) web.onPause();
        // Leaving the app — background wake word takes the mic back.
        startService(new Intent(this, WakeService.class).setAction(WakeService.ACTION_RESUME)); }

    @Override
    protected void onDestroy() {
        if (recog != null) { try { recog.destroy(); } catch (Exception ignored) {} }
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
