"""
Nova — tiny local server for testing the app on your phone.
Run:  python serve.py            (then open the LAN URL it prints on your phone)

It also proxies /api/chat to the free Pollinations AI (no API key needed),
because browsers are blocked by its bot-protection but server calls are fine.
"""
import http.server
import json
import os
import re
import socket
import socketserver
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

PORT = 8080
AI_UPSTREAM = "https://text.pollinations.ai/openai"
STORE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nova_sync_store.json")
OLLAMA = "http://localhost:11434"

# ---------------- JARVIS: local system actuator (this laptop) ----------------
# POST /api/act {action: "open"|"volume"|"type"|"key"|"clipboard"|"notify"|"lock"|"battery"|"screenshot"}
# Commands from the phone run HERE on the laptop. Safe allow-list only.
import base64


def _act_open(target):
    target = target.strip().lower()
    apps = {
        "youtube": "https://youtube.com", "spotify": "spotify:",
        "whatsapp": "https://web.whatsapp.com", "gmail": "https://mail.google.com",
        "maps": "https://maps.google.com", "calendar": "https://calendar.google.com",
        "drive": "https://drive.google.com", "netflix": "https://netflix.com",
        "github": "https://github.com", "chatgpt": "https://chatgpt.com",
        "calculator": "calc.exe", "notepad": "notepad.exe", "paint": "mspaint.exe",
        "explorer": "explorer.exe", "files": "explorer.exe", "cmd": "cmd.exe",
        "vscode": "code", "code": "code", "settings": "ms-settings:",
    }
    val = apps.get(target, target)
    if re.match(r"^https?://|^[\w-]+:", val):
        os.startfile(val)  # noqa: S606 — Windows shell open
        return f"opened {target}"
    subprocess.Popen([val], shell=False)
    return f"launched {target}"


def _act_volume(level):
    # level 0..100 or "mute"/"unmute"
    if level == "mute":
        subprocess.run(["powershell", "-c", "(New-Object -ComObject WScript.Shell).SendKeys([char]173)"],
                       capture_output=True, timeout=15)
        return "muted"
    try:
        n = max(0, min(100, int(level)))
    except Exception:
        return "bad level"
    ps = (
        "$k=[Math]::Round(" + str(n) + "/2);"
        "$w=New-Object -ComObject WScript.Shell;"
        "$w.SendKeys([char]174)*50;"  # start from 0
        "for($i=0;$i-lt$k;$i++){$w.SendKeys([char]175)}"
    )
    subprocess.run(["powershell", "-c", ps], capture_output=True, timeout=20)
    return f"volume {n}%"


def _act_type(text):
    ps = "$w=New-Object -ComObject WScript.Shell; $w.SendKeys('" + \
        text.replace("'", "''") + "')"
    subprocess.run(["powershell", "-c", ps], capture_output=True, timeout=15)
    return f"typed {len(text)} chars"


def _act_key(combo):
    ps = "$w=New-Object -ComObject WScript.Shell; $w.SendKeys('" + \
        str(combo).replace("'", "''") + "')"
    subprocess.run(["powershell", "-c", ps], capture_output=True, timeout=15)
    return f"sent keys {combo}"


def _act_clipboard():
    ps = "Get-Clipboard | Out-String"
    r = subprocess.run(["powershell", "-c", ps], capture_output=True, timeout=15)
    return r.stdout.decode(errors="replace")[:2000]


def _act_notify(msg):
    ps = (
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, "
        "ContentType = WJH2] | Out-Null;"
        "[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WJH2] | Out-Null;"
        "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WJH2] | Out-Null;"
        "$x=@\"<toast><visual><binding template=\"ToastText02\"><text id=\"1\">Nova</text>"
        "<text id=\"2\">" + str(msg).replace("<", "") + "</text></binding></visual></toast>\"@;"
        "$xml=New-Object Windows.Data.Xml.Dom.XmlDocument; $xml.LoadXml($x);"
        "$t=New-Object Windows.UI.Notifications.ToastNotification $xml;"
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(\"Nova\").Show($t)"
    )
    subprocess.run(["powershell", "-c", ps], capture_output=True, timeout=20)
    return "notified"


def _act_lock(_):
    subprocess.run(["rundll32.exe", "user32.dll,LockWorkStation"], capture_output=True, timeout=10)
    return "locked"


def _act_battery(_):
    r = subprocess.run(["powershell", "-c",
                        "(Get-WmiObject Win32_Battery).EstimatedChargeRemaining"],
                       capture_output=True, timeout=20)
    out = r.stdout.decode(errors="replace").strip()
    return f"laptop battery: {out}%" if out.isdigit() else "battery unknown"


def _act_screenshot(_):
    ps = (
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
        "$b=New-Object Drawing.Bitmap [Windows.Forms.Screen]::PrimaryScreen.Bounds.Width,"
        "[Windows.Forms.Screen]::PrimaryScreen.Bounds.Height;"
        "$g=[Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(0,0,0,0,$b.Size);"
        "$ms=New-Object IO.MemoryStream; $b.Save($ms,[Drawing.Imaging.ImageFormat]::Png);"
        "[Convert]::ToBase64String($ms.ToArray())"
    )
    r = subprocess.run(["powershell", "-c", ps], capture_output=True, timeout=30)
    b64 = r.stdout.decode(errors="replace").strip()
    if not b64:
        return "screenshot failed"
    return {"image": "data:image/png;base64," + b64[:6_000_000]}


ACTIONS = {
    "open": _act_open, "volume": _act_volume, "type": _act_type,
    "key": _act_key, "clipboard": _act_clipboard, "notify": _act_notify,
    "lock": _act_lock, "battery": _act_battery, "screenshot": _act_screenshot,
}


def handle_act(body):
    action = str(body.get("action", "")).strip().lower()
    fn = ACTIONS.get(action)
    if not fn:
        return 400, {"error": "unknown action", "known": list(ACTIONS)}
    try:
        result = fn(body.get("arg", ""))
        if isinstance(result, dict):
            return 200, {"ok": True, **result}
        return 200, {"ok": True, "result": result}
    except Exception as e:  # noqa: BLE001
        return 500, {"error": str(e)[:300]}

# ---------------- Tiny sync store (laptop <-> phone) ----------------
# POST /api/sync  {code, device, payload}  -> merges payload into the store
# GET  /api/sync?code=XXXX&since=N         -> returns {rev, data} for that code
_lock = threading.Lock()
_sse_lock = threading.Lock()
_sse_clients = {}  # code -> set of streaming handlers


def _load_store():
    try:
        with open(STORE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_store(store):
    tmp = STORE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(store, f)
    os.replace(tmp, STORE_PATH)


def _deep_merge(dst, src):
    """Merge maps; lists of dicts merge by key (ts/id/q), other lists union."""
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _deep_merge(dst[k], v)
        elif isinstance(v, list) and isinstance(dst.get(k), list):
            if v and isinstance(v[0], dict):
                def key_of(x):
                    for kk in ("ts", "id", "q", "text"):
                        if kk in x:
                            return str(x[kk])
                    return json.dumps(x, sort_keys=True)
                seen = {key_of(x): x for x in dst[k]}
                for item in v:
                    kk = key_of(item)
                    if kk in seen:
                        # keep the newer one (ts larger wins)
                        if isinstance(item.get("ts"), (int, float)) and isinstance(seen[kk].get("ts"), (int, float)):
                            if item["ts"] >= seen[kk]["ts"]:
                                seen[kk] = item
                        else:
                            seen[kk] = item
                    else:
                        seen[kk] = item
                dst[k] = list(seen.values())
            else:
                merged = list(dst[k])
                for item in v:
                    if item not in merged:
                        merged.append(item)
                dst[k] = merged
        else:
            dst[k] = v


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def handle_sync(self, query, body=None):
        """GET/POST /api/sync — the device-pairing store."""
        body = body or {}
        code = (query.get("code", [""])[0] if query else str(body.get("code", ""))).strip().upper()
        if not re.fullmatch(r"[A-Z0-9-]{4,12}", code):
            self._json(400, {"error": "bad code"})
            return
        with _lock:
            store = _load_store()
            if self.command == "POST":
                if not body:
                    length = int(self.headers.get("Content-Length", 0))
                    try:
                        body = json.loads(self.rfile.read(length) or b"{}")
                    except Exception:
                        self._json(400, {"error": "bad json"})
                        return
                dev = str(body.get("device", "dev"))[:40]
                payload = body.get("payload")
                if not isinstance(payload, dict):
                    self._json(400, {"error": "payload must be an object"})
                    return
                entry = store.setdefault(code, {"rev": 0, "data": {}, "devices": {}})
                data = entry.setdefault("data", {})
                _deep_merge(data, payload)
                entry["devices"][dev] = time.time()
                entry["rev"] = int(entry.get("rev", 0)) + 1
                store[code] = entry
                _save_store(store)
                self._last_code = code
                self.push_sse(entry["rev"])  # instant nudge to other devices
                self._json(200, {"ok": True, "rev": entry["rev"], "data": entry["data"]})
            else:
                entry = store.get(code)
                if not entry:
                    self._json(200, {"rev": 0, "data": {}})
                    return
                self._json(200, {"rev": entry.get("rev", 0), "data": entry.get("data", {})})

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parts = urllib.parse.urlparse(self.path)
        if parts.path.rstrip("/") == "/api/sync":
            self.handle_sync(urllib.parse.parse_qs(parts.query))
        elif parts.path.rstrip("/") == "/api/ollama/models":
            self.ollama_models()
        elif parts.path.rstrip("/") == "/api/sync/events":
            self.sync_events(urllib.parse.parse_qs(parts.query))
        else:
            super().do_GET()

    def sync_events(self, query):
        """GET /api/sync/events?code=XXXX — Server-Sent Events stream that fires
        the moment any paired device pushes (instant cross-device sync)."""
        code = (query.get("code", [""])[0] or "").strip().upper()
        if not re.fullmatch(r"[A-Z0-9-]{4,12}", code):
            self._json(400, {"error": "bad code"})
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        last_rev = None
        # register this stream so pushes can nudge it instantly
        with _sse_lock:
            _sse_clients.setdefault(code, set()).add(self)
        try:
            # initial revision snapshot
            with _lock:
                entry = _load_store().get(code, {})
                last_rev = entry.get("rev", 0)
            self.wfile.write(f"event: rev\ndata: {json.dumps({'rev': last_rev})}\n\n".encode())
            self.wfile.flush()
            while True:
                time.sleep(1)
                with _lock:
                    entry = _load_store().get(code, {})
                    rev = entry.get("rev", 0)
                if rev != last_rev:
                    last_rev = rev
                    self.wfile.write(f"event: rev\ndata: {json.dumps({'rev': rev})}\n\n".encode())
                    self.wfile.flush()
                else:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
        except Exception:
            pass
        finally:
            with _sse_lock:
                clients = _sse_clients.get(code)
                if clients and self in clients:
                    clients.discard(self)

    def push_sse(self, rev):
        """Nudge all live SSE streams for this code (called after a push)."""
        code = self._last_code
        if not code:
            return
        with _sse_lock:
            clients = list(_sse_clients.get(code, set()))
        for c in clients:
            try:
                c.wfile.write(f"event: rev\ndata: {json.dumps({'rev': rev})}\n\n".encode())
                c.wfile.flush()
            except Exception:
                pass

    def ollama_models(self):
        """GET /api/ollama/models — list locally installed Ollama models."""
        try:
            req = urllib.request.Request(OLLAMA + "/api/tags", method="GET")
            with urllib.request.urlopen(req, timeout=8) as up:
                data = json.loads(up.read().decode())
            models = [{"id": m.get("name"), "label": m.get("name") +
                       (" — local" if m.get("size") else "")}
                      for m in data.get("models", [])]
            self._json(200, {"ok": True, "models": models})
        except Exception:
            self._json(200, {"ok": False, "models": []})

    def do_POST(self):
        if self.path.rstrip("/") == "/api/chat":
            self.proxy_chat()
        elif self.path.rstrip("/") == "/api/sync":
            length = int(self.headers.get("Content-Length", 0))
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                self._json(400, {"error": "bad json"})
                return
            self.handle_sync({}, body=body)
        elif self.path.rstrip("/") == "/api/act":
            length = int(self.headers.get("Content-Length", 0))
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                self._json(400, {"error": "bad json"})
                return
            code, resp = handle_act(body)
            self._json(code, resp)
        elif self.path.rstrip("/") == "/api/ollama/chat":
            self.ollama_chat()
        else:
            self.send_error(404, "Unknown API path")

    def ollama_chat(self):
        """POST /api/ollama/chat — stream a local Ollama model (OpenAI-style SSE)."""
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length else b"{}"
            payload = json.loads(body or b"{}")
            payload.setdefault("stream", True)
            req = urllib.request.Request(OLLAMA + "/v1/chat/completions",
                data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=600) as up:
                self.send_response(up.status)
                self.send_header("Content-Type", up.headers.get("Content-Type", "text/event-stream"))
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                while True:
                    chunk = up.read(1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            try:
                self.wfile.write(e.read())
            except Exception:
                pass
        except Exception as e:  # noqa: BLE001
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"ollama proxy failed: {e}"}).encode())

    def proxy_chat(self):
        """Forward /api/chat to the free Pollinations AI (streaming pass-through)."""
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length else b"{}"
            req = urllib.request.Request(
                AI_UPSTREAM,
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=180) as up:
                self.send_response(up.status)
                self.send_header("Content-Type", up.headers.get("Content-Type", "text/event-stream"))
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                while True:
                    chunk = up.read(1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            try:
                self.wfile.write(e.read())
            except Exception:
                pass
        except Exception as e:  # noqa: BLE001
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"proxy failed: {e}"}).encode())


class ReusableTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    ip = lan_ip()
    print()
    print("  NOVA local server")
    print("  -----------------")
    print(f"  On this computer :  http://localhost:{PORT}")
    print(f"  On your phone    :  http://{ip}:{PORT}   (same Wi-Fi, for install testing)")
    print()
    with ReusableTCPServer(("0.0.0.0", PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  Server stopped.")
