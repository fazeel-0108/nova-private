"""
Nova JARVIS — FastAPI backend (optional upgrade path over serve.py).

Your app already works with `python serve.py` (stdlib, zero deps). This
FastAPI server adds the production-grade layer from the JARVIS spec:
  · WebSocket real-time bi-directional sync (chat, voice states, tool logs)
  · Streaming LLM router (Ollama local / OpenAI-compatible endpoints)
  · Tool-calling bridge (same NOVA_TOOLS schema as the frontend)
  · Static serving of the existing Nova frontend

Install:
    pip install "fastapi" "uvicorn[standard]" websockets httpx

Run (serves the same UI on port 8080):
    uvicorn backend.server:app --host 0.0.0.0 --port 8080

The frontend needs no changes: it keeps talking to /api/* and now also
opens a WebSocket to /ws/<code> when present.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("NOVA_PORT", "8080"))

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OPENROUTER_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

# Which model the router prefers, in order (first available wins).
MODEL_PREFERENCE = [
    ("local", "llama3.2"),                      # Ollama (private, free)
    ("openrouter", "z-ai/glm-5.3-flash"),       # low-latency cloud (spec target)
    ("openrouter", "upstage/solar-mini4"),      # fallback per spec
]

app = FastAPI(title="Nova JARVIS", version="1.0")

# ------------------------------------------------------------------ #
# Connection manager: every paired device joins a room by sync code. #
# ------------------------------------------------------------------ #
class Room:
    def __init__(self) -> None:
        self.clients: Dict[WebSocket, str] = {}   # ws -> device name
        self.state: Dict[str, Any] = {"rev": 0}   # last synced app state

    async def join(self, ws: WebSocket, device: str) -> None:
        await ws.accept()
        self.clients[ws] = device
        await self.send_to(ws, {"type": "hello", "device": device, "state": self.state})

    def drop(self, ws: WebSocket) -> None:
        self.clients.pop(ws, None)

    async def broadcast(self, message: dict, exclude: Optional[WebSocket] = None) -> None:
        dead = []
        for ws in list(self.clients):
            if ws is exclude:
                continue
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.drop(ws)

    async def send_to(self, ws: WebSocket, message: dict) -> None:
        try:
            await ws.send_text(json.dumps(message))
        except Exception:
            self.drop(ws)


ROOMS: Dict[str, Room] = {}


def room(code: str) -> Room:
    return ROOMS.setdefault(code.upper(), Room())


# ------------------------------------------------------------------ #
# WebSocket: /ws/{code} — chat + voice states + tool execution logs. #
# ------------------------------------------------------------------ #
@app.websocket("/ws/{code}")
async def ws_endpoint(ws: WebSocket, code: str) -> None:
    device = "device"
    r = room(code)
    await r.join(ws, device)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue

            kind = msg.get("type")

            if kind == "state":                      # full app-state merge
                r.state["rev"] += 1
                payload = msg.get("payload") or {}
                r.state["data"] = _merge(r.state.get("data") or {}, payload)
                await r.broadcast({"type": "state", "rev": r.state["rev"], "data": r.state["data"]}, exclude=ws)

            elif kind == "voice-state":              # idle/listening/processing/speaking
                await r.broadcast({"type": "voice-state", "device": msg.get("device"), "state": msg.get("state")}, exclude=ws)

            elif kind == "chat":                     # live message mirror
                await r.broadcast({"type": "chat", "message": msg.get("message")}, exclude=ws)

            elif kind == "tool-log":                 # tool execution feed
                await r.broadcast({"type": "tool-log", "entry": msg.get("entry")}, exclude=ws)

            elif kind == "ping":
                await r.send_to(ws, {"type": "pong"})
    except WebSocketDisconnect:
        r.drop(ws)


def _merge(dst: dict, src: dict) -> dict:
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _merge(dst[k], v)
        else:
            dst[k] = v
    return dst


# ------------------------------------------------------------------ #
# LLM router: prefer local Ollama, fall back to OpenRouter cloud.    #
# ------------------------------------------------------------------ #
async def pick_route() -> tuple[str, str, str]:
    async with httpx.AsyncClient(timeout=3) as c:
        try:
            r = await c.get(OLLAMA_URL + "/api/tags")
            ids = [m.get("name") for m in r.json().get("models", [])]
            for want, model in MODEL_PREFERENCE:
                if want == "local" and ids:
                    for have in ids:
                        if model in have:
                            return ("local", have, OLLAMA_URL + "/v1/chat/completions")
            if ids:
                return ("local", ids[0], OLLAMA_URL + "/v1/chat/completions")
        except Exception:
            pass
    if OPENROUTER_KEY:
        for want, model in MODEL_PREFERENCE:
            if want == "openrouter":
                return ("openrouter", model, OPENROUTER_URL)
    return ("none", "", "")


@app.post("/api/chat")
async def chat(body: Dict[str, Any]) -> StreamingResponse:
    """OpenAI-compatible streaming chat with the same tool schema the UI uses."""
    provider, model, url = await pick_route()
    if provider == "none":
        return JSONResponse({"error": "no route: start Ollama or set OPENROUTER_API_KEY"}, status_code=503)

    headers = {"Content-Type": "application/json"}
    if provider == "openrouter":
        headers["Authorization"] = f"Bearer {OPENROUTER_KEY}"
        headers["HTTP-Referer"] = "http://localhost:8080"
        headers["X-Title"] = "Nova JARVIS"

    payload = {
        "model": body.get("model") or model,
        "messages": body.get("messages", []),
        "stream": True,
    }
    if body.get("tools"):
        payload["tools"] = body["tools"]

    async def stream():
        async with httpx.AsyncClient(timeout=None) as c:
            async with c.stream("POST", url, headers=headers, json=payload) as up:
                async for chunk in up.aiter_bytes():
                    yield chunk

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.get("/api/ollama/models")
async def ollama_models() -> JSONResponse:
    try:
        async with httpx.AsyncClient(timeout=4) as c:
            r = await c.get(OLLAMA_URL + "/api/tags")
            models = [{"id": m["name"], "label": m["name"] + " — local"}
                      for m in r.json().get("models", [])]
        return JSONResponse({"ok": True, "models": models})
    except Exception:
        return JSONResponse({"ok": False, "models": []})


# ------------------------------------------------------------------ #
# Serve the existing Nova frontend (same files, zero duplication).   #
# ------------------------------------------------------------------ #
app.mount("/", StaticFiles(directory=ROOT, html=True), name="nova")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
