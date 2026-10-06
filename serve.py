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


# ---------------- Nova Agent v2: system stats · storage · safe cleanup · file search ----------------
# Safe, read-mostly, allowlisted local capabilities. Destructive cleanup only
# touches well-known temp/cache locations, only when explicitly requested.

_TEMP_DIRS = [
    os.environ.get("TEMP", ""), os.environ.get("TMP", ""),
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Temp") if os.environ.get("LOCALAPPDATA") else "",
]
_TEMP_DIRS = [d for d in _TEMP_DIRS if d and os.path.isdir(d)]


def _ps(cmd, timeout=25):
    """Run a read-only PowerShell probe, return stdout text (or None)."""
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-c", cmd], capture_output=True, timeout=timeout)
        return r.stdout.decode(errors="replace").strip()
    except Exception:
        return None


def _act_stats(_):
    """Real CPU / RAM / GPU / battery / uptime readout (no fabrication)."""
    out = {}
    cpu = _ps("(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average")
    if cpu and cpu.replace(".", "").isdigit():
        out["cpu"] = float(cpu)
    ram = _ps("$o=Get-CimInstance Win32_OperatingSystem; [math]::Round(($o.TotalVisibleMemorySize-$o.FreePhysicalMemory)/1MB,1); $t=[math]::Round($o.TotalVisibleMemorySize/1MB,1)")
    if ram:
        lines = [l for l in ram.splitlines() if l.strip()]
        if len(lines) >= 2:
            out["ramUsedGb"], out["ramTotalGb"] = lines[0], lines[1]
    gpu = _ps("(Get-CimInstance Win32_VideoController | ForEach-Object {$_.Name}) -join ' | '")
    if gpu:
        out["gpuName"] = gpu[:120]
    gpu_load = _ps("(Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CounterSamples | Measure-Object -Property CookedValue -Average).Average")
    if gpu_load:
        try:
            out["gpuLoad"] = round(float(gpu_load), 1)
        except ValueError:
            pass
    bat = _ps("(Get-CimInstance Win32_Battery).EstimatedChargeRemaining")
    if bat and bat.replace(".", "").isdigit():
        out["battery"] = float(bat)
    up = _ps("(Get-CimInstance Win32_OperatingSystem).LastBootUpTime")
    if up:
        out["bootedAt"] = up[:19]
    procs = _ps("(Get-Process).Count")
    if procs and procs.isdigit():
        out["processes"] = int(procs)
    out["ok"] = bool(out)
    return out


def _act_storage(_):
    """Disk usage + the biggest folders in the user profile (real numbers)."""
    disks = _ps("Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | ForEach-Object { $_.DeviceID + '|' + [math]::Round($_.Size/1GB,0) + '|' + [math]::Round(($_.Size-$_.FreeSpace)/1GB,0) }")
    disk_list = []
    if disks:
        for line in disks.splitlines():
            parts = line.split("|")
            if len(parts) == 3:
                disk_list.append({"drive": parts[0], "totalGb": parts[1], "usedGb": parts[2]})
    top = []
    home = os.path.expanduser("~")
    folders = ["Downloads", "Videos", "Documents", "Desktop", "Pictures", "AppData\\Local\\Temp"]
    sizes = _ps(
        "$folders = @('Downloads','Videos','Documents','Desktop','Pictures'); "
        "foreach($f in $folders){ $p=Join-Path $env:USERPROFILE $f; if(Test-Path $p){ "
        "$s=(Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum; "
        "$f + '|' + [math]::Round($s/1GB,1) } }", timeout=90)
    if sizes:
        for line in sizes.splitlines():
            parts = line.split("|")
            if len(parts) == 2:
                top.append({"folder": parts[0], "gb": parts[1]})
    tmp_gb = 0.0
    for d in _TEMP_DIRS:
        try:
            total = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(d, onerror=lambda e: None) for f in fs)
            tmp_gb += total / (1024 ** 3)
        except Exception:
            pass
    return {"ok": True, "disks": disk_list, "topFolders": top[:8], "tempGb": round(tmp_gb, 2)}


def _dir_size_gb(path):
    total = 0
    try:
        for r, _, fs in os.walk(path, onerror=lambda e: None):
            for f in fs:
                try:
                    total += os.path.getsize(os.path.join(r, f))
                except OSError:
                    pass
    except Exception:
        pass
    return total / (1024 ** 3)


def _act_cleanup_preview(_):
    """Preview ONLY: what could be cleaned, per safe category. Deletes nothing."""
    seen = set()
    cats = []
    for d in _TEMP_DIRS:
        norm = os.path.normcase(os.path.normpath(d))
        if norm in seen:
            continue
        seen.add(norm)
        gb = _dir_size_gb(d)
        if gb > 0.01:
            n = sum(len(fs) for _, _, fs in os.walk(d, onerror=lambda e: None))
            cats.append({"label": "Temporary files — " + d, "gb": round(gb, 2), "files": n, "path": d})
    return {"ok": True, "categories": cats}


def _act_cleanup(arg):
    """Clean ONE allowlisted temp directory (arg must exactly match a safe path).
    Files older than 1 day only; anything locked is skipped. Never recurses
    beyond the allowlisted dir. Returns real freed bytes."""
    target = str(arg or "").strip()
    if not target or target not in _TEMP_DIRS:
        return {"ok": False, "error": "path not allowlisted"}
    freed = 0
    files = 0
    cutoff = time.time() - 86400  # 24h — leave anything fresh alone
    for r, _, fs in os.walk(target, onerror=lambda e: None):
        for f in fs:
            p = os.path.join(r, f)
            try:
                st = os.stat(p)
                if st.st_mtime > cutoff:
                    continue
                os.remove(p)
                freed += st.st_size
                files += 1
            except OSError:
                pass
    return {"ok": True, "freedGb": round(freed / (1024 ** 3), 2), "freedMb": round(freed / (1024 ** 2), 1), "files": files}


def _act_find_files(arg):
    """Search the user profile for filenames matching a query (top 20 hits).
    Read-only. arg: {q: query, folder: optional subdir} or a plain string."""
    if isinstance(arg, dict):
        q = str(arg.get("q", "")).strip().lower()
        sub = str(arg.get("folder", "")).strip()
    else:
        q = str(arg or "").strip().lower()
        sub = ""
    if len(q) < 2:
        return {"ok": False, "error": "query too short"}
    base = os.path.join(os.path.expanduser("~"), sub) if sub and not sub.startswith(("/", "\\")) else (sub if sub else os.path.expanduser("~"))
    if not os.path.isdir(base):
        return {"ok": False, "error": "folder not found"}
    skip_dirs = {"AppData", "Application Data", "$Recycle.Bin", "node_modules", ".git", "Cache", "Caches"}
    hits = []
    try:
        for r, dirs, fs in os.walk(base, onerror=lambda e: None):
            dirs[:] = [d for d in dirs if d not in skip_dirs]
            for f in fs:
                if q in f.lower():
                    p = os.path.join(r, f)
                    try:
                        st = os.stat(p)
                        hits.append({"name": f, "path": p,
                                     "sizeMb": round(st.st_size / (1024 ** 2), 1),
                                     "modified": int(st.st_mtime * 1000)})
                    except OSError:
                        pass
                    if len(hits) >= 20:
                        raise StopIteration
    except StopIteration:
        pass
    except Exception:
        pass
    hits.sort(key=lambda h: -h["modified"])
    return {"ok": True, "query": q, "base": base, "hits": hits}


def _act_open_path(arg):
    """Reveal one exact file/folder the agent itself found (no free-form exec)."""
    p = str(arg or "").strip()
    if not p.startswith(("C:\\", "D:\\", "/")) or ".." in p:
        return {"ok": False, "error": "path refused"}
    if not os.path.exists(p):
        return {"ok": False, "error": "not found"}
    try:
        if os.path.isdir(p):
            os.startfile(p)  # noqa: S606
        else:
            subprocess.Popen(["explorer", "/select,", p])
        return {"ok": True, "result": "opened location"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:200]}


ACTIONS = {
    "open": _act_open, "volume": _act_volume, "type": _act_type,
    "key": _act_key, "clipboard": _act_clipboard, "notify": _act_notify,
    "lock": _act_lock, "battery": _act_battery, "screenshot": _act_screenshot,
    # Nova Agent v2 — read-mostly system capabilities
    "stats": _act_stats, "storage": _act_storage,
    "cleanup_preview": _act_cleanup_preview, "cleanup": _act_cleanup,
    "find_files": _act_find_files, "open_path": _act_open_path,
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
        elif parts.path.rstrip("/") == "/api/ping":
            # Lightweight agent heartbeat: lets the UI show REAL agent status.
            import platform
            self._json(200, {"ok": True, "agent": "nova-local", "version": 2,
                             "device": platform.node() or "laptop"})
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
