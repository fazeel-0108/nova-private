"""
Nova tools — Gmail integration (OAuth2, official API).

One-time setup (5 minutes, free):
  1. console.cloud.google.com -> New Project -> enable "Gmail API"
  2. OAuth consent screen -> External -> add yourself as a Test user
  3. Credentials -> Create credentials -> OAuth client ID -> Desktop app
  4. Download the JSON next to this file as  credentials.json
  5. pip install google-auth google-auth-oauthlib google-api-python-client
  6. First run opens a browser for consent, then stores token.json (auto-refresh).

Usage (from the backend or an agent loop):
    from backend.tools.gmail import unread, draft, send
    unread(3)
    draft("bob@mail.com", "Lunch", "See you at 1pm")
    send("bob@mail.com", "Lunch", "See you at 1pm")

Voice commands in the app map onto these once wired in INTEGRATION_GUIDE.md.
"""
from __future__ import annotations

import base64
import os
from typing import Any, Dict, List, Optional

SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]
HERE = os.path.dirname(os.path.abspath(__file__))
CREDENTIALS = os.path.join(HERE, "credentials.json")
TOKEN = os.path.join(HERE, "token.json")

_service = None


def _svc():
    """Lazy singleton for the Gmail service (refreshes tokens automatically)."""
    global _service
    if _service is not None:
        return _service
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
    except ImportError as e:
        raise RuntimeError(
            "Gmail deps missing. Run: pip install google-auth google-auth-oauthlib google-api-python-client"
        ) from e

    creds: Optional[Credentials] = None
    if os.path.exists(TOKEN):
        creds = Credentials.from_authorized_user_file(TOKEN, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(CREDENTIALS):
                raise RuntimeError(
                    "credentials.json not found — follow the setup steps in backend/tools/gmail.py header"
                )
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(TOKEN, "w", encoding="utf-8") as f:
            f.write(creds.to_json())
    _service = build("gmail", "v1", credentials=creds)
    return _service


def _text_of(payload: Dict[str, Any]) -> str:
    """Extract the plain-text body from a Gmail message payload."""
    if payload.get("mimeType") == "text/plain" and payload.get("body", {}).get("data"):
        return base64.urlsafe_b64decode(payload["body"]["data"]).decode(errors="replace")
    for part in payload.get("parts", []) or []:
        t = _text_of(part)
        if t:
            return t
    return ""


def unread(max_results: int = 5) -> List[Dict[str, str]]:
    """The latest unread emails: [{from, subject, snippet, date}]."""
    svc = _svc()
    res = svc.users().messages().list(userId="me", labelIds=["UNREAD"],
                                      maxResults=max_results).execute()
    out: List[Dict[str, str]] = []
    for m in res.get("messages", []):
        msg = svc.users().messages().get(userId="me", id=m["id"],
                                         format="full").execute()
        headers = {h["name"].lower(): h["value"] for h in
                   msg["payload"].get("headers", [])}
        out.append({
            "id": m["id"],
            "from": headers.get("from", "?"),
            "subject": headers.get("subject", "(no subject)"),
            "date": headers.get("date", ""),
            "snippet": msg.get("snippet", "")[:180],
        })
    return out


def draft(to: str, subject: str, body: str) -> Dict[str, str]:
    """Create a Gmail draft (appears in the user's Drafts folder)."""
    svc = _svc()
    raw = base64.urlsafe_b64encode(
        f"To: {to}\r\nSubject: {subject}\r\n\r\n{body}".encode()
    ).decode()
    res = svc.users().drafts().create(
        userId="me",
        body={"message": {"raw": raw}},
    ).execute()
    return {"draft_id": res.get("id", ""), "to": to, "subject": subject}


def send(to: str, subject: str, body: str) -> Dict[str, str]:
    """Send an email immediately."""
    svc = _svc()
    raw = base64.urlsafe_b64encode(
        f"To: {to}\r\nSubject: {subject}\r\n\r\n{body}".encode()
    ).decode()
    res = svc.users().messages().send(
        userId="me", body={"raw": raw}
    ).execute()
    return {"message_id": res.get("id", ""), "to": to, "subject": subject, "status": "sent"}


# OpenAI function-calling schemas (mirrors NOVA_TOOLS in app.js)
OPENAI_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "gmail_unread",
            "description": "Fetch the user's latest unread emails.",
            "parameters": {"type": "object",
                           "properties": {"max_results": {"type": "integer", "default": 5}},
                           "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "gmail_draft",
            "description": "Create a Gmail draft.",
            "parameters": {"type": "object",
                           "properties": {"to": {"type": "string"},
                                          "subject": {"type": "string"},
                                          "body": {"type": "string"}},
                           "required": ["to", "subject"]},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "gmail_send",
            "description": "Send an email immediately. Confirm with the user before calling.",
            "parameters": {"type": "object",
                           "properties": {"to": {"type": "string"},
                                          "subject": {"type": "string"},
                                          "body": {"type": "string"}},
                           "required": ["to", "subject", "body"]},
        },
    },
]
