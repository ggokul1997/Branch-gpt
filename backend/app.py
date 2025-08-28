# app.py
# Flask backend that proxies to Groq's OpenAI-compatible Chat Completions API
# and streams chunks back to the frontend. No persistence. CORS enabled.
#
# ENV:
#   GROQ_API_KEY=sk_...                  (in backend/.env)
#   GROQ_MODEL=llama-3.3-70b-versatile   (optional override; default set below)
#
# Endpoints:
#   POST /api/chat              -> { messages: [{role, content}, ...] }
#   POST /api/branch            -> { selection, history, question? (single-turn), popup_turns? (multi-turn) }
#   POST /api/branch/summary    -> { selection, history, popup_turns }
#
# Notes:
# - No global system prompt (per your spec).
# - Temperature=0.2, max_tokens=800, model configurable via env.
# - Verifies upstream response first; if Groq returns 4xx/5xx, relays JSON error.
# - Streams plain text chunks; frontend reads via fetch ReadableStream.

import json
import os
from typing import Generator, List, Dict, Any
from flask import Flask, request, Response
import requests

app = Flask(__name__)

def load_dotenv_manual():
    """
    Minimal .env loader to avoid extra dependencies.
    Example .env:
      GROQ_API_KEY=sk_xxx
      GROQ_MODEL=llama-3.3-70b-versatile
    """
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(env_path):
        return
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except Exception:
        pass

load_dotenv_manual()

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")  # configurable
TEMPERATURE = 0.2
MAX_TOKENS = 800
BASE_URL = "https://api.groq.com/openai/v1"

def add_cors_headers(resp: Response) -> Response:
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    return resp

@app.after_request
def after(resp):
    return add_cors_headers(resp)

@app.route("/api/chat", methods=["POST", "OPTIONS"])
def chat():
    if request.method == "OPTIONS":
        return add_cors_headers(Response(status=204))
    if not GROQ_API_KEY:
        return add_cors_headers(Response(json.dumps({"error": "GROQ_API_KEY missing"}), status=500, mimetype="application/json"))

    data = request.get_json(force=True, silent=True) or {}
    messages = data.get("messages", [])
    # (No system prompt per spec.)
    return stream_completion(messages)

@app.route("/api/branch", methods=["POST", "OPTIONS"])
def branch():
    """
    Multi-purpose endpoint for popup conversation turns.
    Accepts either:
      - single-turn: { selection, question, history }
      - multi-turn : { selection, popup_turns: [{role,content}...], history }
    Always includes the selection as an anchoring context message.
    """
    if request.method == "OPTIONS":
        return add_cors_headers(Response(status=204))
    if not GROQ_API_KEY:
        return add_cors_headers(Response(json.dumps({"error": "GROQ_API_KEY missing"}), status=500, mimetype="application/json"))

    data = request.get_json(force=True, silent=True) or {}
    selection = (data.get("selection") or "")[:3000]
    history = data.get("history") or []
    question = (data.get("question") or "").strip()
    popup_turns = data.get("popup_turns") or []  # list of {role, content}

    if not selection.strip():
        return add_cors_headers(Response(json.dumps({"error": "selection required"}), status=400, mimetype="application/json"))

    messages: List[Dict[str, Any]] = []
    # Include last-N main messages as context first (provided by client)
    for m in history:
        if isinstance(m, dict) and "role" in m and "content" in m:
            messages.append({"role": m["role"], "content": m["content"]})

    # Inject the selected text as an explicit context message
    messages.append({"role": "user", "content": f"Selected Context:\n{selection}"})

    # Mode A: multi-turn popup chat provided
    if popup_turns:
        for t in popup_turns:
            role = t.get("role")
            content = (t.get("content") or "")
            if role in ("user", "assistant") and isinstance(content, str):
                messages.append({"role": role, "content": content})
    # Mode B: single question field
    elif question:
        messages.append({"role": "user", "content": question})
    else:
        return add_cors_headers(Response(json.dumps({"error": "Provide either popup_turns or question"}), status=400, mimetype="application/json"))

    return stream_completion(messages)

@app.route("/api/branch/summary", methods=["POST", "OPTIONS"])
def branch_summary():
    """
    Summarize an entire popup chat (plus selection and last-N main messages)
    into a concise, student-friendly summary to attach back to the main thread.
    Body: { selection, popup_turns: [{role,content}...], history }
    """
    if request.method == "OPTIONS":
        return add_cors_headers(Response(status=204))
    if not GROQ_API_KEY:
        return add_cors_headers(Response(json.dumps({"error": "GROQ_API_KEY missing"}), status=500, mimetype="application/json"))

    data = request.get_json(force=True, silent=True) or {}
    selection = (data.get("selection") or "")[:3000]
    popup_turns = data.get("popup_turns") or []
    history = data.get("history") or []

    if not selection.strip():
        return add_cors_headers(Response(json.dumps({"error": "selection required"}), status=400, mimetype="application/json"))

    # Build messages to request a crisp summary.
    messages: List[Dict[str, str]] = []
    # Include limited main history first (same order as normal)
    for m in history:
        if isinstance(m, dict) and "role" in m and "content" in m:
            messages.append({"role": m["role"], "content": m["content"]})

    # Provide selected context explicitly
    messages.append({"role": "user", "content": f"Selected Context:\n{selection}"})

    # Provide the popup conversation transcript
    if popup_turns:
        # Add a compact header before the transcript so the model knows what's coming
        messages.append({"role": "user", "content": "Below is the branch conversation transcript:"})
        for t in popup_turns:
            role = t.get("role")
            content = (t.get("content") or "")
            if role in ("user", "assistant") and isinstance(content, str):
                prefix = "User:" if role == "user" else "Assistant:"
                messages.append({"role": "user", "content": f"{prefix} {content}"})

    # Final instruction for summarization (kept in a user message to avoid global system prompts)
    messages.append({
        "role": "user",
        "content": (
            "Write a concise summary of the branch conversation for a student.\n"
            "- 5–8 bullet points\n"
            "- 1-line key takeaway at the end\n"
            "- Do NOT repeat the full selected text; focus on the conversation's conclusions and clarifications."
        )
    })

    return stream_completion(messages)

def stream_completion(messages) -> Response:
    """
    Proxies to Groq's streaming endpoint and re-streams plain text chunks,
    but only after verifying the upstream response is 200.
    If Groq returns 4xx/5xx, pass the error JSON/text to the client.
    """
    url = f"{BASE_URL}/chat/completions"
    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": MODEL,
        "messages": messages,
        "temperature": TEMPERATURE,
        "max_tokens": MAX_TOKENS,
        "stream": True
    }

    # Make the request first (so we can inspect status before streaming)
    try:
        r = requests.post(url, headers=headers, json=payload, stream=True, timeout=300)
    except requests.RequestException as e:
        err = {"error": f"Network error contacting Groq: {str(e)}"}
        return add_cors_headers(Response(json.dumps(err), status=502, mimetype="application/json"))

    # If Groq says 4xx/5xx, return the error body (don’t start streaming)
    if r.status_code != 200:
        try:
            body = r.json()
            # Groq often uses {"error": {"message": "..."}}
            if isinstance(body, dict) and "error" in body and isinstance(body["error"], dict) and "message" in body["error"]:
                body = {"error": body["error"]["message"]}
        except Exception:
            body = {"error": (r.text or "Unknown error from Groq")}
        return add_cors_headers(Response(json.dumps(body), status=r.status_code, mimetype="application/json"))

    # OK — now stream chunks
    def generate() -> Generator[bytes, None, None]:
        for line in r.iter_lines(decode_unicode=True):
            if not line:
                continue
            # OpenAI-compatible stream frames are prefixed with "data: "
            if line.startswith("data: "):
                data_str = line[len("data: "):].strip()
                if data_str == "[DONE]":
                    break
                try:
                    event = json.loads(data_str)
                    delta = event["choices"][0]["delta"].get("content", "")
                    if delta:
                        yield delta.encode("utf-8")
                except Exception:
                    # Ignore malformed chunks
                    continue

    resp = Response(generate(), mimetype="text/plain; charset=utf-8")
    return add_cors_headers(resp)

if __name__ == "__main__":
    # For local dev only.
    print("Using model:", MODEL, "Key present:", bool(GROQ_API_KEY))
    app.run(host="0.0.0.0", port=5000, debug=True, threaded=True)
