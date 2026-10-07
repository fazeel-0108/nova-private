package com.nova.assistant;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.os.Bundle;
import android.content.pm.ServiceInfo;
import android.os.Build;

/**
 * FOREGROUND WAKE SERVICE — the heart of hands-free.
 *
 * Keeps a microphone stream alive while the phone is in your pocket, screen
 * off, or Nova is closed. Chrome cannot do this — only a native app can.
 *
 * Detection: an always-ready SpeechRecognizer re-arming itself in a loop,
 * matching the wake word "nova". (Free, no external keyword files. On modern
 * Android this runs reliably in a foreground service; on some aggressive
 * OEMs you must exempt the app from battery optimization once.)
 *
 * On detection it: launches MainActivity (screen on) so the web app — already
 * listening hands-free — picks the command up.
 */
public class WakeService extends Service {

    private static final String CHANNEL = "nova_wake";
    public static final String WAKE_WORD = "nova";

    private android.speech.SpeechRecognizer recognizer;
    private android.content.SharedPreferences prefs;
    private android.media.AudioManager am;
    private boolean beepMuted = false;

    public static final String ACTION_PAUSE = "com.nova.assistant.PAUSE_WAKE";
    public static final String ACTION_RESUME = "com.nova.assistant.RESUME_WAKE";

    @Override
    public IBinder onBind(Intent i) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences("nova", MODE_PRIVATE);
        am = (android.media.AudioManager) getSystemService(AUDIO_SERVICE);
        startAsForeground();
        startListening();
    }

    /* Android's recognizer plays a system "ding" at every session start —
       with a continuous wake loop that becomes beep-after-beep. Mute the
       media stream briefly around each start, but NEVER while the user is
       actually playing music (isMusicActive guard). */
    private void muteBeep() {
        try {
            if (am == null || am.isMusicActive()) return;
            am.adjustStreamVolume(android.media.AudioManager.STREAM_MUSIC,
                    android.media.AudioManager.ADJUST_MUTE, 0);
            beepMuted = true;
        } catch (Exception ignored) {}
    }

    private void unmuteBeep() {
        try {
            if (beepMuted && am != null) {
                am.adjustStreamVolume(android.media.AudioManager.STREAM_MUSIC,
                        android.media.AudioManager.ADJUST_UNMUTE, 0);
            }
            beepMuted = false;
        } catch (Exception ignored) {}
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_PAUSE.equals(intent.getAction())) {
            // App screen is open — IT is listening now; stop the duplicate mic.
            prefs.edit().putBoolean("paused", true).apply();
            if (recognizer != null) { try { recognizer.destroy(); } catch (Exception ignored) {} recognizer = null; }
            unmuteBeep();
            return START_STICKY;
        }
        if (intent != null && ACTION_RESUME.equals(intent.getAction())) {
            prefs.edit().putBoolean("paused", false).apply();
            startListening();
            return START_STICKY;
        }
        return START_STICKY;
    }

    private void startAsForeground() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Nova wake word", NotificationManager.IMPORTANCE_LOW);
            nm.createNotificationChannel(ch);
        }
        Notification n = null;
        if (Build.VERSION.SDK_INT >= 26) {
            n = new Notification.Builder(this, CHANNEL)
                    .setContentTitle("Nova is listening")
                    .setContentText("Say \"Nova\" anytime, hands-free")
                    .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                    .setOngoing(true)
                    .build();
        } else {
            n = new Notification.Builder(this)
                    .setContentTitle("Nova is listening")
                    .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                    .setOngoing(true)
                    .build();
        }
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(1, n);
        }
    }

    private void startListening() {
        if (!android.speech.SpeechRecognizer.isRecognitionAvailable(this)) return;
        if (recognizer != null) { try { recognizer.destroy(); } catch (Exception ignored) {} }

        recognizer = android.speech.SpeechRecognizer.createSpeechRecognizer(this);
        recognizer.setRecognitionListener(new android.speech.RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) {}
            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float rmsdB) {}
            @Override public void onBufferReceived(byte[] buffer) {}
            @Override public void onEndOfSpeech() {}
            @Override public void onPartialResults(Bundle partialResults) {}
            @Override public void onEvent(int eventType, Bundle params) {}

            @Override
            public void onResults(Bundle results) {
                java.util.ArrayList<String> list = results
                        .getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION);
                if (list != null) {
                    for (String heard : list) {
                        if (heard != null && heard.toLowerCase().contains(WAKE_WORD)) {
                            onWakeWord();
                            break;
                        }
                    }
                }
                restart();
            }

            @Override
            public void onError(int error) { restart(); }

            private void restart() {
                if (prefs.getBoolean("enabled", true) && !prefs.getBoolean("paused", false)) {
                    android.os.Handler h = new android.os.Handler(getMainLooper());
                    h.postDelayed(() -> {
                        if (prefs.getBoolean("enabled", true) && !prefs.getBoolean("paused", false)) startListening();
                    }, 250);
                }
            }
        });

        android.content.Intent si = new android.content.Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        si.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        si.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE, "en-US");
        si.putExtra(android.speech.RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
        si.putExtra(android.speech.RecognizerIntent.EXTRA_MAX_RESULTS, 3);
        muteBeep();
        recognizer.startListening(si);
        new android.os.Handler(getMainLooper()).postDelayed(this::unmuteBeep, 700);
    }

    /** WAKE WORD HEARD — bring Nova to the front, screen on. */
    private void onWakeWord() {
        android.content.Intent i = new Intent(this, MainActivity.class);
        i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                | android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP);
        // Screen-on comes from the manifest's android:turnScreenOn="true" —
        // Intent.FLAG_ACTIVITY_TURN_SCREEN_ON does not exist in the SDK.
        startActivity(i);
        android.media.ToneGenerator tg = new android.media.ToneGenerator(
                android.media.AudioManager.STREAM_NOTIFICATION, 80);
        tg.startTone(android.media.ToneGenerator.TONE_PROP_BEEP, 150);
    }

    /* Screen-on is handled by the manifest's android:turnScreenOn="true";
       no extra code needed. */

    @Override
    public void onDestroy() {
        unmuteBeep();
        if (recognizer != null) { try { recognizer.destroy(); } catch (Exception ignored) {} }
        super.onDestroy();
    }
}
