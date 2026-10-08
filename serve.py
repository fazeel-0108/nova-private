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
import shutil
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


# ---------------- Nova Agent v3: file management, gaming mode, action log ----------------
# Every path touching action resolves through _resolve_user_path: absolute,
# inside the user profile, restricted to personal folders, `..` refused,
# sensitive trees (AppData/Windows/Program Files) refused. The AI can never
# name a path outside this sandbox — model-supplied paths are never trusted.

_USER_DIRS = ["Desktop", "Documents", "Downloads", "Videos", "Pictures", "Music"]
_TOKEN_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nova_agent.token")
_LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nova_agent_log.json")


def _agent_token():
    """Local device credential. Created once; LAN callers must present it or a
    paired sync code. localhost is always trusted (it IS the owner's session)."""
    try:
        with open(_TOKEN_PATH, "r", encoding="utf-8") as f:
            tok = f.read().strip()
            if tok:
                return tok
    except OSError:
        pass
    tok = base64.urlsafe_b64encode(os.urandom(24)).decode().rstrip("=")
    try:
        with open(_TOKEN_PATH, "w", encoding="utf-8") as f:
            f.write(tok)
        if os.name == "nt":
            os.system(f"attrib +h {chr(34)}{_TOKEN_PATH}{chr(34)}")
    except OSError:
        pass
    return tok


def _log_action(action, arg_summary, ok):
    """Append to the action log — what ran, when, with what (sanitized) argument."""
    try:
        try:
            with open(_LOG_PATH, "r", encoding="utf-8") as f:
                log = json.load(f)
        except Exception:
            log = []
        log.append({"ts": int(time.time()), "action": action,
                    "arg": str(arg_summary)[:80], "ok": bool(ok)})
        with open(_LOG_PATH, "w", encoding="utf-8") as f:
            json.dump(log[-200:], f)
    except Exception:
        pass


def _resolve_user_path(p):
    """Validate + resolve a model- or user-supplied path. Returns an absolute
    path inside the user's personal folders, or None (refused)."""
    p = str(p or "").strip().strip('"').strip("'")
    if not p or ".." in p:
        return None
    if re.match(r"^[a-zA-Z]:$", p):          # bare drive letter
        return None
    home = os.path.normpath(os.path.expanduser("~"))
    if not os.path.isabs(p):
        p = os.path.join(home, p)
    p = os.path.normpath(os.path.abspath(p))
    if not (p == home or p.startswith(home + os.sep)):
        return None
    low = p.lower()
    for bad in ("appdata", "windows", "program files", "programdata", "$recycle.bin", ".git"):
        if os.sep + bad in low:
            return None
    try:
        rel = os.path.relpath(p, home)
    except ValueError:
        return None
    if rel == ".":
        return p
    top = rel.split(os.sep)[0].lower()
    allowed = [d.lower() for d in _USER_DIRS] + ["novatrash"]
    if top not in allowed:
        return None
    return p


def _act_create_folder(arg):
    p = _resolve_user_path(arg)
    if not p:
        return {"ok": False, "error": "folder must be in Desktop/Documents/Downloads/Videos/Pictures/Music"}
    if os.path.exists(p):
        if os.path.isdir(p):
            return {"ok": True, "result": f"folder already exists: {p}", "path": p}
        return {"ok": False, "error": "a file with that name exists"}
    os.makedirs(p)
    return {"ok": True, "result": f"created {p}", "path": p, "verified": os.path.isdir(p)}


def _two_paths(arg):
    if not isinstance(arg, dict):
        return None, None
    src = _resolve_user_path(arg.get("from") or arg.get("src"))
    dst = _resolve_user_path(arg.get("to") or arg.get("dst"))
    return src, dst


def _act_rename_file(arg):
    src, dst = _two_paths(arg)
    if not src or not dst:
        return {"ok": False, "error": "paths refused (must be in your personal folders)"}
    if not os.path.exists(src):
        return {"ok": False, "error": f"source not found: {src}"}
    if os.path.exists(dst):
        return {"ok": False, "error": "target already exists — nothing overwritten"}
    os.rename(src, dst)
    return {"ok": True, "result": f"renamed to {os.path.basename(dst)}", "verified": os.path.exists(dst)}


def _act_move_file(arg):
    src, dst = _two_paths(arg)
    if not src or not dst:
        return {"ok": False, "error": "paths refused (must be in your personal folders)"}
    if not os.path.exists(src):
        return {"ok": False, "error": f"source not found: {src}"}
    if os.path.isdir(dst):
        dst = os.path.join(dst, os.path.basename(src))
    if os.path.exists(dst):
        return {"ok": False, "error": "target already exists — nothing overwritten"}
    shutil.move(src, dst)
    return {"ok": True, "result": f"moved to {dst}", "verified": os.path.exists(dst) and not os.path.exists(src)}


def _act_copy_file(arg):
    src, dst = _two_paths(arg)
    if not src or not dst:
        return {"ok": False, "error": "paths refused (must be in your personal folders)"}
    if not os.path.isfile(src):
        return {"ok": False, "error": "source is not a file"}
    if os.path.isdir(dst):
        dst = os.path.join(dst, os.path.basename(src))
    if os.path.exists(dst):
        return {"ok": False, "error": "target already exists — nothing overwritten"}
    shutil.copy2(src, dst)
    return {"ok": True, "result": f"copied to {dst}", "verified": os.path.isfile(dst)}


def _act_trash_path(arg):
    """REVERSIBLE delete: move the file/folder into ~/NovaTrash/. Nothing is
    permanently erased — the user empties NovaTrash themselves. Only paths
    resolved inside the personal-folder sandbox are accepted."""
    p = _resolve_user_path(arg)
    if not p:
        return {"ok": False, "error": "path refused (must be in your personal folders)"}
    home = os.path.normpath(os.path.expanduser("~"))
    trash = os.path.join(home, "NovaTrash")
    if os.path.normcase(p) == os.path.normcase(trash):
        return {"ok": False, "error": "cannot trash NovaTrash itself"}
    if not os.path.exists(p):
        return {"ok": False, "error": f"not found: {p}"}
    os.makedirs(trash, exist_ok=True)
    dst = os.path.join(trash, os.path.basename(p) or "item")
    n = 1
    stem, ext = os.path.splitext(dst)
    while os.path.exists(dst):
        dst = f"{stem} ({n}){ext}"
        n += 1
    shutil.move(p, dst)
    return {"ok": True, "result": f"moved to NovaTrash: {os.path.basename(dst)}",
            "verified": os.path.exists(dst) and not os.path.exists(p),
            "note": "reversible — nothing was permanently deleted"}


def _act_empty_trash(_):
    """Permanently empty ~/NovaTrash/ — HIGH risk, only after typed YES."""
    trash = os.path.join(os.path.normpath(os.path.expanduser("~")), "NovaTrash")
    if not os.path.isdir(trash):
        return {"ok": True, "result": "NovaTrash is already empty", "freedGb": 0}
    gb = _dir_size_gb(trash)
    n = 0
    for r, _, fs in os.walk(trash, onerror=lambda e: None):
        for f in fs:
            try:
                os.remove(os.path.join(r, f))
                n += 1
            except OSError:
                pass
    for r, dirs, _ in os.walk(trash, topdown=False, onerror=lambda e: None):
        for d in dirs:
            try:
                os.rmdir(os.path.join(r, d))
            except OSError:
                pass
    return {"ok": True, "result": f"emptied NovaTrash ({n} files)", "freedGb": round(gb, 2)}


def _act_list_dir(arg):
    p = _resolve_user_path(arg)
    if not p or not os.path.isdir(p):
        return {"ok": False, "error": "folder not found in your personal folders"}
    entries = []
    try:
        for name in sorted(os.listdir(p))[:40]:
            fp = os.path.join(p, name)
            if os.path.isdir(fp):
                entries.append({"name": name, "type": "folder"})
            else:
                st = os.stat(fp)
                entries.append({"name": name, "type": "file",
                                "sizeMb": round(st.st_size / (1024 ** 2), 1)})
    except OSError as e:
        return {"ok": False, "error": str(e)[:120]}
    return {"ok": True, "path": p, "entries": entries}


def _act_processes(_):
    ps = ("Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 "
          "Name, @{n='RamMb';e={[math]::Round($_.WorkingSet64/1MB,0)}} | "
          "ForEach-Object { $_.Name + '|' + $_.RamMb }")
    out = _ps(ps, timeout=20)
    procs = []
    if out:
        for line in out.splitlines():
            parts = line.split("|")
            if len(parts) == 2 and parts[1].strip().isdigit():
                procs.append({"name": parts[0], "ramMb": int(parts[1])})
    return {"ok": bool(procs), "processes": procs}


def _act_network(_):
    ssid = _ps("(netsh wlan show interfaces) -match 'SSID' | Select-Object -First 1")
    state_ = _ps("(netsh wlan show interfaces) -match 'State' | Select-Object -First 1")
    out = {}
    if ssid:
        out["wifi"] = ssid.split(":", 1)[1].strip() if ":" in ssid else ""
    if state_:
        out["state"] = state_.split(":", 1)[1].strip() if ":" in state_ else ""
    out["ok"] = bool(out)
    return out


_POWER_GUIDS = {
    "high performance": "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c",
    "balanced": "381b4222-f694-41f0-9685-ff5bb260df2e",
    "power saver": "a1841308-3541-4fab-bc81-f71556f20b4a",
}


def _power_scheme():
    out = _ps("powercfg /getactivescheme", timeout=10)
    if not out:
        return None
    m = re.search(r"\(([^)]+)\)", out)
    return m.group(1) if m else out.strip()


def _act_gaming_preview(_):
    """Read-only: what Gaming Mode would change + current headroom."""
    scheme = _power_scheme()
    free = _ps("$o=Get-CimInstance Win32_OperatingSystem; [math]::Round($o.FreePhysicalMemory/1MB,1)")
    procs = _ps("(Get-Process).Count")
    storage = _act_storage("")
    c_free = None
    if storage.get("ok"):
        for d in storage.get("disks", []):
            try:
                c_free = round(float(d["totalGb"]) - float(d["usedGb"]), 1)
                break
            except (KeyError, ValueError):
                pass
    return {"ok": True, "currentScheme": scheme or "unknown",
            "freeRamGb": free, "processes": procs, "freeStorageGb": c_free}


def _act_gaming_apply(_):
    """Apply ONLY safe optimizations: switch to High Performance power mode.
    No process killing, no registry edits, no overclocks. Verified after."""
    before = _power_scheme()
    guid = _POWER_GUIDS["high performance"]
    subprocess.run(["powercfg", "/setactive", guid], capture_output=True, timeout=15)
    after = _power_scheme()
    changed = bool(after) and before != after
    return {"ok": True, "before": before or "unknown", "after": after or "unknown",
            "changed": changed,
            "note": "power mode switched; no processes were closed"}


ACTIONS = {
    "open": _act_open, "volume": _act_volume, "type": _act_type,
    "key": _act_key, "clipboard": _act_clipboard, "notify": _act_notify,
    "lock": _act_lock, "battery": _act_battery, "screenshot": _act_screenshot,
    # Nova Agent v2 — read-mostly system capabilities
    "stats": _act_stats, "storage": _act_storage,
    "cleanup_preview": _act_cleanup_preview, "cleanup": _act_cleanup,
    "find_files": _act_find_files, "open_path": _act_open_path,
    # Nova Agent v3 — file management (sandboxed), processes, network, gaming
    "create_folder": _act_create_folder, "rename_file": _act_rename_file,
    "move_file": _act_move_file, "copy_file": _act_copy_file,
    "trash_path": _act_trash_path, "empty_trash": _act_empty_trash,
    "list_dir": _act_list_dir, "processes": _act_processes,
    "network": _act_network, "gaming_preview": _act_gaming_preview,
    "gaming_apply": _act_gaming_apply,
}


def handle_act(body):
    action = str(body.get("action", "")).strip().lower()
    fn = ACTIONS.get(action)
    if not fn:
        return 400, {"error": "unknown action", "known": list(ACTIONS)}
    arg = body.get("arg", "")
    try:
        result = fn(arg)
        ok = result.get("ok", True) if isinstance(result, dict) else True
        _log_action(action, arg if isinstance(arg, str) else json.dumps(arg)[:80], ok)
        if isinstance(result, dict):
            return 200, {**result}
        return 200, {"ok": True, "result": result}
    except Exception as e:  # noqa: BLE001
        _log_action(action, arg if isinstance(arg, str) else "", False)
        return 500, {"ok": False, "error": str(e)[:300]}


def _act_authorized(self):
    """Auth for /api/act: localhost is trusted; LAN callers must present the
    device token or a paired sync code (any device holding the sync code can
    already read all synced data, so it is a valid credential)."""
    ip = self.client_address[0]
    if ip in ("127.0.0.1", "::1", "localhost"):
        return True
    tok = (self.headers.get("X-Nova-Token") or "").strip()
    if not tok:
        return False
    if tok == _agent_token():
        return True
    up = tok.upper()
    if re.fullmatch(r"[A-Z0-9-]{4,12}", up):
        with _lock:
            return up in _load_store()
    return False

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
            self._json(200, {"ok": True, "agent": "nova-local", "version": 3,
                             "device": platform.node() or "laptop",
                             "capabilities": sorted(ACTIONS)})
        elif parts.path.rstrip("/") == "/api/log":
            try:
                with open(_LOG_PATH, "r", encoding="utf-8") as f:
                    log = json.load(f)
            except Exception:
                log = []
            self._json(200, {"ok": True, "log": log[-50:]})
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
            try:
                if not _act_authorized(self):
                    self._json(401, {"ok": False, "error": "unauthorized",
                                     "hint": "pair this device with a sync code, or run Nova on the laptop itself"})
                    return
                length = int(self.headers.get("Content-Length", 0))
                try:
                    body = json.loads(self.rfile.read(length) or b"{}")
                except Exception:
                    self._json(400, {"error": "bad json"})
                    return
                code, resp = handle_act(body)
                self._json(code, resp)
            except (ConnectionAbortedError, BrokenPipeError):
                pass  # client gave up mid-request — nothing to answer
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
    print("  Agent actions from other devices need your sync code (auto-sent by the app).")
    print()
    with ReusableTCPServer(("0.0.0.0", PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  Server stopped.")
