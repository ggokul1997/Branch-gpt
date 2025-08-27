/* global React, ReactDOM */

// app.jsx
// - Popup is a multi-turn chat with merge-to-POP notes (UI-only flag isPop)
// - POP notes: compact preview, expand, Delete button (removes only that note)
// - NEW: "Edit & Send" for any USER message
//        * Click Edit → inline textarea opens inside that bubble
//        * Send → trims conversation up to BEFORE that user message,
//                 inserts edited user message, streams a fresh assistant reply,
//                 and drops all following messages (branch/regenerate)

const { useEffect, useRef, useState, useCallback } = React;

const BACKEND_BASE = "http://localhost:5000";
const MAX_HISTORY = 5;

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// POP (merged notes) helpers — UI-only
function isPopMessage(msg) {
  return !!msg.isPop; // role stays 'system' for the API
}
function toPopPreviewAndFull(msgContent) {
  const stripped = String(msgContent || "");
  const firstLine = stripped.split('\n').find(Boolean) || stripped;
  const preview = firstLine.length > 140 ? firstLine.slice(0, 140) + '…' : firstLine;
  return { preview, full: stripped };
}

function App() {
  const [messages, setMessages] = useState(() => ([
    { id: uid(), role: 'system', content: 'Welcome! Highlight any message to branch in a draggable popup. Merge to add a compact POP note.' },
  ]));
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  // Inline edit state for a single user message at a time
  const [editState, setEditState] = useState({ id: null, text: "", sending: false });

  // Active popups
  const [popups, setPopups] = useState([]);

  const chatRef = useRef(null);

  useEffect(() => {
    // Hook selection.js pill (safe if not loaded)
    window.initSelectionPill?.({
      onAsk: ({ originMessageId, selectedText }) => {
        openPopup(originMessageId, selectedText);
      }
    });
  }, []);

  const openPopup = (originMessageId, selectedText) => {
    setPopups(prev => ([
      ...prev,
      {
        id: uid(),
        originMessageId,
        selectedText,
        turns: [],
        input: selectedText,  // prefill with selection only
        status: "idle",
        dragging: false,
        x: 40,
        y: 60
      }
    ]));
  };

  const closePopup = (popupId) => {
    setPopups(prev => prev.filter(p => p.id !== popupId));
  };

  // ----- POP merge & delete -----

  const mergePopup = async (popupId) => {
    const p = popups.find(x => x.id === popupId);
    if (!p) return;

    const hasAnyAssistant = p.turns.some(t => t.role === 'assistant' && t.content.trim());
    const hasAnyUser = p.turns.some(t => t.role === 'user' && t.content.trim());
    if (!hasAnyAssistant && !hasAnyUser) {
      alert("No popup conversation to summarize yet.");
      return;
    }

    const history = messages.slice(-MAX_HISTORY).map(({role, content}) => ({ role, content }));
    const payload = {
      selection: p.selectedText.slice(0, 3000),
      popup_turns: p.turns, // send only role/content
      history
    };

    setPopups(prev => prev.map(x => x.id === popupId ? { ...x, status: "merging" } : x));

    try {
      const res = await fetch(`${BACKEND_BASE}/api/branch/summary`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok || !res.body) {
        const msg = (!res.ok && await res.json().catch(() => null)) || null;
        setPopups(prev => prev.map(x => x.id === popupId ? { ...x, status: "error" } : x));
        alert("Summary error: " + (msg?.error || res.statusText || "Unknown error"));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "", done = false;
      while (!done) {
        const { value, done: finished } = await reader.read();
        done = finished;
        if (value) acc += decoder.decode(value, { stream: true });
      }

      const popMsg = { id: uid(), role: 'system', isPop: true, content: acc || "(Empty summary)" };
      setMessages(prev => [...prev, popMsg]);

      // Close popup & scroll
      setPopups(prev => prev.filter(x => x.id !== popupId));
      setTimeout(() => chatRef.current?.scrollTo?.(0, chatRef.current.scrollHeight + 9999), 0);
    } catch (err) {
      console.error(err);
      setPopups(prev => prev.map(x => x.id === popupId ? { ...x, status: "error" } : x));
      alert("Error while summarizing popup.");
    }
  };

  const handleDeletePop = (id) => {
    setMessages(prev => prev.filter(m => m.id !== id));
  };

  // ----- Main send -----

  const sendMain = async () => {
    if (!input.trim()) return;
    const userMsg = { id: uid(), role: 'user', content: input.trim() };
    setInput("");
    setSending(true);
    setMessages(prev => [...prev, userMsg, { id: uid(), role: 'assistant', content: "" }]);

    try {
      const body = JSON.stringify({
        messages: [...messages, userMsg].map(({role, content}) => ({ role, content }))
      });

      const res = await fetch(`${BACKEND_BASE}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body
      });

      if (!res.ok || !res.body) {
        const maybeJson = await res.json().catch(() => null);
        const msg = (maybeJson && (maybeJson.error || JSON.stringify(maybeJson))) || res.statusText || "Unknown error";
        setMessages(prev => writeLastAssistant(prev, `Error from model: ${msg}`));
        setSending(false);
        return;
      }

      await streamIntoLastAssistant(res, setMessages, chatRef);
    } catch (err) {
      console.error(err);
      setMessages(prev => writeLastAssistant(prev, "[Error streaming response]"));
    } finally {
      setSending(false);
    }
  };

  // ----- Popup send -----

  const sendPopup = async (popupId) => {
    const p = popups.find(x => x.id === popupId);
    if (!p) return;

    const inputText = p.input?.trim() || "";
    if (!inputText) { alert("Type your message in the popup first."); return; }

    const history = messages.slice(-MAX_HISTORY).map(({role, content}) => ({ role, content }));

    const newUserTurn = { role: 'user', content: inputText };
    const newAssistantTurn = { role: 'assistant', content: "" };

    setPopups(prev => prev.map(x => {
      if (x.id !== popupId) return x;
      return { ...x, turns: [...x.turns, newUserTurn, newAssistantTurn], input: "", status: "generating" };
    }));

    try {
      const payload = {
        selection: p.selectedText.slice(0, 3000),
        popup_turns: [...p.turns, newUserTurn],
        history
      };

      const res = await fetch(`${BACKEND_BASE}/api/branch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok || !res.body) {
        const maybeJson = await res.json().catch(() => null);
        const msg = (maybeJson && (maybeJson.error || JSON.stringify(maybeJson))) || res.statusText || "Unknown error";
        setPopups(prev => prev.map(x => x.id === popupId ? {
          ...x,
          status: "error",
          turns: x.turns.map((t, i) => (i === x.turns.length - 1 ? { ...t, content: `Error from model: ${msg}` } : t))
        } : x));
        return;
      }

      // Stream into last assistant turn of this popup
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "", done = false;
      while (!done) {
        const { value, done: finished } = await reader.read();
        done = finished;
        if (value) {
          acc += decoder.decode(value, { stream: true });
          setPopups(prev => prev.map(x => {
            if (x.id !== popupId) return x;
            const turns = x.turns.slice();
            turns[turns.length - 1] = { ...turns[turns.length - 1], content: acc };
            return { ...x, turns };
          }));
        }
      }
      setPopups(prev => prev.map(x => x.id === popupId ? { ...x, status: "idle" } : x));
    } catch (err) {
      console.error(err);
      setPopups(prev => prev.map(x => x.id === popupId ? {
        ...x,
        status: "error",
        turns: x.turns.map((t, i) => (i === x.turns.length - 1 ? { ...t, content: "[Error streaming response]" } : t))
      } : x));
    }
  };

  // ----- Edit & Send for any USER message -----

  const startEdit = (id, content) => {
    setEditState({ id, text: content, sending: false });
  };

  const cancelEdit = () => {
    setEditState({ id: null, text: "", sending: false });
  };

  const submitEdit = async () => {
    const { id, text } = editState;
    if (!id) return;
    const edited = (text || "").trim();
    if (!edited) { alert("Edited message is empty."); return; }

    const idx = messages.findIndex(m => m.id === id);
    if (idx < 0) { cancelEdit(); return; }

    // Trim conversation BEFORE the edited user message; drop the original and everything after
    const trimmed = messages.slice(0, idx);

    // Insert new user message and assistant placeholder; replace the whole chat state
    const newUser = { id: uid(), role: 'user', content: edited };
    const newAssistant = { id: uid(), role: 'assistant', content: "" };
    setMessages([...trimmed, newUser, newAssistant]);
    setEditState({ id, text: edited, sending: true });

    try {
      // Send ONLY trimmed + edited user (no UI-only fields)
      const body = JSON.stringify({
        messages: [...trimmed, newUser].map(({role, content}) => ({ role, content }))
      });

      const res = await fetch(`${BACKEND_BASE}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body
      });

      if (!res.ok || !res.body) {
        const maybeJson = await res.json().catch(() => null);
        const msg = (maybeJson && (maybeJson.error || JSON.stringify(maybeJson))) || res.statusText || "Unknown error";
        setMessages(prev => writeLastAssistant(prev, `Error from model: ${msg}`));
        setEditState({ id: null, text: "", sending: false });
        return;
      }

      await streamIntoLastAssistant(res, setMessages, chatRef);
    } catch (err) {
      console.error(err);
      setMessages(prev => writeLastAssistant(prev, "[Error streaming response]"));
    } finally {
      // Clear edit mode regardless of success (we already replaced the path)
      setEditState({ id: null, text: "", sending: false });
    }
  };

  return (
    <div className="app">
      <div className="header">
        <h1 style={{ textAlign: "center",fontSize:"30px" }}>Multithreaded Chat • Branch Popups</h1>
      </div>

      <div className="main">
        <div className="chat" ref={chatRef} id="chat-scroll">
          <MessageList
            messages={messages}
            onDeletePop={handleDeletePop}
            editState={editState}
            onStartEdit={startEdit}
            onEditText={(t) => setEditState(s => ({ ...s, text: t }))}
            onCancelEdit={cancelEdit}
            onSubmitEdit={submitEdit}
          />
        </div>
      </div>

      <div className="composer">
        <textarea
          placeholder="Type your message..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMain(); } }}
        />
        <button className="btn" onClick={sendMain} disabled={sending || !input.trim()}>
          {sending ? "Sending..." : "Send"}
        </button>
      </div>

      {popups.map(p => (
        <Popup
          key={p.id}
          popup={p}
          onClose={() => closePopup(p.id)}
          onMerge={() => mergePopup(p.id)}
          onSend={() => sendPopup(p.id)}
          setPopups={setPopups}
        />
      ))}
    </div>
  );
}

// --------- helpers ---------

function writeLastAssistant(prev, text) {
  const copy = [...prev];
  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i].role === 'assistant') {
      copy[i] = { ...copy[i], content: text };
      break;
    }
  }
  return copy;
}

async function streamIntoLastAssistant(res, setMessages, chatRef) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let acc = "", done = false;

  while (!done) {
    const { value, done: finished } = await reader.read();
    done = finished;
    if (value) {
      acc += decoder.decode(value, { stream: true });
      setMessages(prev => writeLastAssistant(prev, acc));
      chatRef.current?.scrollTo?.(0, chatRef.current.scrollHeight + 9999);
    }
  }
}

// --------- UI components ---------

function MessageList({ messages, onDeletePop, editState, onStartEdit, onEditText, onCancelEdit, onSubmitEdit }) {
  return (
    <>
      {messages.map((m) => {
        const isEditing = editState.id === m.id && m.role === 'user';
        return (
          <div
            className={`message ${m.isPop ? 'is-pop' : ''}`}
            data-id={m.id}
            data-role={m.role}
            key={m.id}
          >
            <div className="meta">
              {m.isPop ? 'POP' : m.role.toUpperCase()}
            </div>

            <div className="content">
              {/* POP note */}
              {m.isPop ? (
                <PopCompact
                  id={m.id}
                  content={m.content}
                  onDelete={() => onDeletePop?.(m.id)}
                />
              ) : (
                <>
                  {/* USER editing view */}
                  {isEditing ? (
                    <div className="edit-area">
                      <textarea
                        className="editbox"
                        value={editState.text}
                        onChange={(e) => onEditText(e.target.value)}
                        onKeyDown={(e) => {
                          if ((e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
                            e.preventDefault();
                            onSubmitEdit();
                          }
                        }}
                        autoFocus
                      />
                      <div className="msg-actions editing">
                        <button className="btn micro success" onClick={onSubmitEdit} disabled={editState.sending}>
                          {editState.sending ? "Sending…" : "Send"}
                        </button>
                        <button className="btn micro danger" onClick={onCancelEdit} disabled={editState.sending}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {m.content}
                      {/* USER non-editing actions */}
                      {m.role === 'user' && (
                        <div className="msg-actions">
                          <button className="btn micro secondary" onClick={() => onStartEdit(m.id, m.content)}>
                            Edit
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

function PopCompact({ id, content, onDelete }) {
  const { preview, full } = toPopPreviewAndFull(content);
  const stopToggle = (e) => { e.preventDefault(); e.stopPropagation(); };
  const onDeleteClick = (e) => { stopToggle(e); onDelete?.(id); };

  return (
    <details className="notes">
      <summary className="notes-summary">
        <span className="tag">NOTES</span>
        <span className="preview">{preview}</span>
        <button
          className="notes-delete"
          title="Delete this POP note"
          aria-label="Delete POP note"
          onClick={onDeleteClick}
          onMouseDown={stopToggle}
          onTouchStart={stopToggle}
        >
          ×
        </button>
      </summary>
      <div className="notes-body">
        <pre>{full}</pre>
      </div>
    </details>
  );
}

function Popup({ popup, onClose, onMerge, onSend, setPopups }) {
  const ref = useRef(null);
  const startPos = useRef({ x: 0, y: 0, dx: 0, dy: 0 });

  const onMouseDown = (e) => {
    if (!ref.current) return;
    startPos.current = { x: e.clientX, y: e.clientY, dx: popup.x, dy: popup.y };
    setPopups(prev => prev.map(p => p.id === popup.id ? { ...p, dragging: true } : p));
    e.preventDefault();
  };
  const onMouseMove = useCallback((e) => {
    setPopups(prev => prev.map(p => {
      if (p.id !== popup.id || !p.dragging) return p;
      const nx = Math.max(8, Math.min(window.innerWidth - 440, startPos.current.dx + (e.clientX - startPos.current.x)));
      const ny = Math.max(8, Math.min(window.innerHeight - 100, startPos.current.dy + (e.clientY - startPos.current.y)));
      return { ...p, x: nx, y: ny };
    }));
  }, [popup.id, setPopups]);
  const onMouseUp = useCallback(() => {
    setPopups(prev => prev.map(p => p.id === popup.id ? { ...p, dragging: false } : p));
  }, [popup.id, setPopups]);

  useEffect(() => {
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  return (
    <div className="popup" ref={ref} style={{ left: popup.x, top: popup.y }}>
      <div className="titlebar" onMouseDown={onMouseDown}>
        <span className="badge">Branch</span>
        <div>Popup Chat</div>
      </div>

      <div className="stream">
        {popup.turns.length === 0 && (
          <div style={{ color: '#7f8bb3' }}>
            This is a separate mini chat. Your selected text is prefilled below—add your question/instruction and hit Send.
          </div>
        )}
        {popup.turns.map((t, idx) => (
          <div key={idx} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: '#9fb0e6' }}>{t.role.toUpperCase()}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{t.content}</div>
          </div>
        ))}
      </div>

      <div className="question">
        <small>Input:</small>
        <textarea
          placeholder="Your selected text is pasted here. Add your instruction/question…"
          value={popup.input}
          onChange={(e) =>
            setPopups(prev => prev.map(x => x.id === popup.id ? { ...x, input: e.target.value } : x))
          }
        />
      </div>

      <div className="actions">
        <button className="btn secondary" onClick={onSend} disabled={popup.status === 'generating'}>Send</button>
        <button className="btn success" onClick={onMerge} disabled={popup.status === 'generating'}>Merge</button>
        <button className="btn danger" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('app-root')).render(<App />);
