"""
Nova tools — system automation (the laptop actuator as a Python module).

The stdlib version lives in serve.py (/api/act). This module is the clean,
importable version for the FastAPI backend: mount it, or call the functions
directly from your own agent loop.

All actions are allow-listed. Nothing arbitrary is executed.
"""
from __future__ import annotations

import base64
import os
import re
import subprocess
from typing import Callable, Dict, Union

ActionResult = Union[str, dict]

APP_ALIASES: Dict[str, str] = {
    "youtube": "https://youtube.com",
    "spotify": "spotify:",
    "whatsapp": "https://web.whatsapp.com",
    "gmail": "https://mail.google.com",
    "maps": "https://maps.google.com",
    "calendar": "https://calendar.google.com",
    "drive": "https://drive.google.com",
    "netflix": "https://netflix.com",
    "github": "https://github.com",
    "chatgpt": "https://chatgpt.com",
    "calculator": "calc.exe",
    "notepad": "notepad.exe",
    "paint": "mspaint.exe",
    "explorer": "explorer.exe",
    "files": "explorer.exe",
    "cmd": "cmd.exe",
    "vscode": "code",
    "code": "code",
    "settings": "ms-settings:",
}


def act_open(target: str) -> ActionResult:
    """Open an app by alias, a URL, or an installed executable name."""
    target = (target or "").strip().lower()
    if not target:
        return "no target given"
    val = APP_ALIASES.get(target, target)
    if re.match(r"^https?://|^[\w-]+:", val):
        os.startfile(val)  # type: ignore[attr-defined]  # noqa: S606
        return f"opened {target}"
    subprocess.Popen([val], shell=False)
    return f"launched {target}"


def act_volume(level: str) -> ActionResult:
    """Set speaker volume 0-100 (Windows). 'mute' toggles mute."""
    ps = (
        "$o=New-Object -ComObject WScript.Shell;"
        "function Bar([int]$p){for($i=0;$i-lt$p;$i++){$o.SendKeys([char]175)}}"
        "for($i=0;$i-lt50;$i++){$o.SendKeys([char]174)}"  # to zero
    )
    if str(level).lower() in ("mute", "unmute"):
        subprocess.run(["powershell", "-c", ps + ";$o.SendKeys([char]173)"],
                       capture_output=True, timeout=20)
        return "muted" if str(level).lower() == "mute" else "unmuted"
    try:
        n = max(0, min(100, int(float(level))))
    except (TypeError, ValueError):
        return "bad level"
    subprocess.run(["powershell", "-c", ps + f";Bar([Math]::Round({n}/2))"],
                   capture_output=True, timeout=25)
    return f"volume {n}%"


def act_type(text: str) -> ActionResult:
    """Type text into the focused window."""
    text = (text or "").replace("'", "''")
    ps = f"$w=New-Object -ComObject WScript.Shell; $w.SendKeys('{text}')"
    subprocess.run(["powershell", "-c", ps], capture_output=True, timeout=15)
    return f"typed {len(text)} chars"


def act_key(combo: str) -> ActionResult:
    """Send a key combo to the focused window, e.g. '%{F4}' or '^c'."""
    combo = (combo or "").replace("'", "''")
    ps = f"$w=New-Object -ComObject WScript.Shell; $w.SendKeys('{combo}')"
    subprocess.run(["powershell", "-c", ps], capture_output=True, timeout=15)
    return f"sent keys {combo}"


def act_clipboard(_: str = "") -> ActionResult:
    r = subprocess.run(["powershell", "-c", "Get-Clipboard | Out-String"],
                       capture_output=True, timeout=15)
    return r.stdout.decode(errors="replace")[:2000]


def act_notify(message: str) -> ActionResult:
    """Fire a Windows toast notification."""
    message = str(message or "Nova").replace("<", "")
    ps = (
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WJH2] > $null;"
        "[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WJH2] > $null;"
        "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WJH2] > $null;"
        "$x=@\"<toast><visual><binding template=\\\"ToastText02\\\"><text id=\\\"1\\\">Nova</text>"
        f"<text id=\\\"2\\\">{message}</text></binding></visual></toast>\"@;"
        "$xml=New-Object Windows.Data.Xml.Dom.XmlDocument; $xml.LoadXml($x);"
        "$t=New-Object Windows.UI.Notifications.ToastNotification $xml;"
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(\"Nova\").Show($t)"
    )
    subprocess.run(["powershell", "-c", ps], capture_output=True, timeout=20)
    return "notified"


def act_lock(_: str = "") -> ActionResult:
    subprocess.run(["rundll32.exe", "user32.dll,LockWorkStation"],
                   capture_output=True, timeout=10)
    return "locked"


def act_battery(_: str = "") -> ActionResult:
    r = subprocess.run(["powershell", "-c",
                        "(Get-WmiObject Win32_Battery).EstimatedChargeRemaining"],
                       capture_output=True, timeout=20)
    out = r.stdout.decode(errors="replace").strip()
    return f"laptop battery: {out}%" if out.isdigit() else "battery unknown"


def act_screenshot(_: str = "") -> ActionResult:
    """Capture the primary screen; returns {'image': data-uri} for chat display."""
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


ACTIONS: Dict[str, Callable[[str], ActionResult]] = {
    "open": act_open,
    "volume": act_volume,
    "type": act_type,
    "key": act_key,
    "clipboard": act_clipboard,
    "notify": act_notify,
    "lock": act_lock,
    "battery": act_battery,
    "screenshot": act_screenshot,
}


def run(action: str, arg: str = "") -> ActionResult:
    """Entry point used by the API layer and the agent loop."""
    fn = ACTIONS.get((action or "").lower())
    if not fn:
        raise KeyError(f"unknown action '{action}'. known: {sorted(ACTIONS)}")
    return fn(arg)


# OpenAI function-calling schema (mirrors NOVA_TOOLS.control_laptop in app.js)
OPENAI_SCHEMA = {
    "type": "function",
    "function": {
        "name": "control_laptop",
        "description": "Control the user's laptop: open apps/sites, volume, lock, screenshot, battery, notifications.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string",
                           "enum": list(ACTIONS)},
                "arg": {"type": "string"},
            },
            "required": ["action"],
        },
    },
}
