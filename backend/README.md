Nova backend — optional FastAPI layer
======================================

You do NOT need this to run Nova. `python serve.py` already gives you chat,
sync, Ollama proxy and the laptop actuator with zero dependencies.

This folder is the production upgrade path from the JARVIS spec:
WebSocket real-time sync, LLM routing (local-first), and importable tool
modules with OpenAI function-calling schemas.

Install
-------
    pip install "fastapi" "uvicorn[standard]" websockets httpx

Run (serves the same Nova UI on the same port)
----------------------------------------------
    uvicorn backend.server:app --host 0.0.0.0 --port 8080
    (or:  python -m backend.server)

What you get over serve.py
--------------------------
  · /ws/{code}          WebSocket rooms: chat mirror, voice-state sync,
                        tool execution logs — instant, bi-directional.
  · /api/chat           Streaming OpenAI-compatible router that prefers
                        LOCAL Ollama first, then OpenRouter
                        (z-ai/glm-5.3-flash, upstage/solar-mini4).
  · /api/ollama/models  Same contract as serve.py.
  · Static serving of your existing frontend — no duplication.

Environment variables
---------------------
    OPENROUTER_API_KEY   your OpenRouter key (sk-or-...) for cloud fallback
    OLLAMA_URL           default http://localhost:11434
    NOVA_PORT            default 8080

Tools (backend/tools/)
----------------------
    python -m backend.tools.system   — self-test of every laptop action
    backend/tools/system.py          — allow-listed actuator + OpenAI schema
    backend/tools/gmail.py           — OAuth2 Gmail unread/draft/send + schemas

Gmail one-time setup (free, 5 minutes)
--------------------------------------
    1. console.cloud.google.com -> New Project -> enable "Gmail API"
    2. OAuth consent screen -> External -> add yourself as Test user
    3. Credentials -> OAuth client ID -> Desktop app -> download JSON
       next to gmail.py as  credentials.json
    4. pip install google-auth google-auth-oauthlib google-api-python-client
    5. First use opens a consent page, then caches token.json (auto-refresh).

Security notes
--------------
    · The system actuator is ALLOW-LISTED — no arbitrary shell input.
    · Gmail tokens stay local (token.json). Never commit credentials.json.
    · WS rooms are keyed by your sync code — use a code only your devices know.
