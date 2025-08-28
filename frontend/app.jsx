/* global React, ReactDOM */

// app.jsx
// Multi-branch popups:
// - Highlight in MAIN → top-level popup (depth=1)
// - Highlight in POPUP → child popup (depth=parent+1, capped at 3)
// - Child Merge → POP summary + POP transcript appended to PARENT
// - Top-level Merge → POP summary appended to MAIN
// - Parent cannot close while it has open children
// - Child/Parent streaming via /api/branch; summaries via /api/branch/summary
// - Context for child = last 5 turns of its parent; top-level uses MAIN last 5
// Existing goodies: POP delete, Edit & Send for user, streaming, draggable

const { useEffect, useRef, useState, useCallback } = React;

const BACKEND_BASE = "https://branch-gpt.onrender.com";
const MAX_HISTORY = 5;
const MAX_DEPTH = 3;

function uid() { return Math.random().toString(36).slice(2, 10); }

// UI helpers for POP notes (merged)
function isPopMessage(msg) { return !!msg.isPop; }
function toPopPreviewAndFull(msgContent) {
  const stripped = String(msgContent || "");
  const firstLine = stripped.split('\n').find(Boolean) || stripped;
  const preview = firstLine.length > 140 ? firstLine.slice(0, 140) + '…' : firstLine;
  return { preview, full: stripped };
}

// --- NEW: Build a POP "Transcript" block out of a popup's chat turns
function buildTranscriptPop(turns, depth) {
  const lines = [];
  for (const t of turns) {
    if (t?.isPop) continue;                 // skip pop notes inside the child
    if (t?.role === 'user' || t?.role === 'assistant') {
      const role = t.role.toUpperCase();
      const content = (t.content || "").trim();
      if (content) lines.push(`${role}:\n${content}`);
    }
  }
  const header = `Transcript (Branch L${depth}) — ${lines.length} entries`;
  const body = lines.length ? `${header}\n\n${lines.join('\n\n')}` : `${header}\n\n(Empty)`;
  return { id: uid(), role: 'system', isPop: true, content: body };
}

function App() {
  const [messages, setMessages] = useState(() => ([
    { id: uid(), role: 'system', content: 'Welcome! Highlight any message to branch in a draggable popup. Merge to add a compact POP note.' },
  ]));
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  // Inline edit for one user message at a time
  const [editState, setEditState] = useState({ id: null, text: "", sending: false });

  // Popups tree
  // popup: { id, parentId|null, depth:1..MAX_DEPTH, x,y,z, dragging, selectedText, input, status, turns:[{role,content,isPop?}] }
  const [popups, setPopups] = useState([]);
  const maxZRef = useRef(1200);

  const chatRef = useRef(null);

  // --- MAIN selection pill → open top-level popup (bind to .chat explicitly)
  useEffect(() => {
    const container = document.querySelector('.chat');
    const detach = window.registerSelectionPillFor?.(container, ({ selectedText }) => {
      openTopLevelPopup(selectedText);
    });
    return () => { detach && detach(); };
  }, []);

  // Open a top-level popup from MAIN
  const openTopLevelPopup = (selectedText) => {
    setPopups(prev => ([
      ...prev,
      {
        id: uid(),
        parentId: null,
        depth: 1,
        x: 50, y: 70, z: ++maxZRef.current,
        dragging: false,
        selectedText,
        input: selectedText, // prefill only with selection; user adds question
        status: "idle",
        turns: []
      }
    ]));
  };

  // Open a child popup from a parent popup
  const openChildPopup = (parentId, selectedText) => {
    setPopups(prev => {
      const parent = prev.find(p => p.id === parentId);
      if (!parent) return prev;
      if (parent.depth >= MAX_DEPTH) {
        alert(`Max depth ${MAX_DEPTH} reached. Merge or cancel existing child to continue.`);
        return prev;
      }
      return [
        ...prev,
        {
          id: uid(),
          parentId,
          depth: parent.depth + 1,
          x: Math.min(parent.x + 30, window.innerWidth - 460),
          y: Math.min(parent.y + 30, window.innerHeight - 140),
          z: ++maxZRef.current,
          dragging: false,
          selectedText,
          input: selectedText,
          status: "idle",
          turns: []
        }
      ];
    });
  };

  // Bring popup to front
  const focusPopup = (popupId) => {
    setPopups(prev => prev.map(p => p.id === popupId ? { ...p, z: ++maxZRef.current } : p));
  };

  // Close popup with child guard
  const closePopup = (popupId) => {
    setPopups(prev => {
      const hasChildren = prev.some(p => p.parentId === popupId);
      if (hasChildren) {
        alert("Close/merge/cancel child popups first.");
        return prev;
      }
      return prev.filter(p => p.id !== popupId);
    });
  };

  // Helper: sanitize turns/history to {role, content}
  const justRC = (arr) => arr.map(({ role, content }) => ({ role, content }));

  // Compute context for a popup request
  const historyFor = (popup) => {
    if (popup.parentId) {
      const parent = popups.find(p => p.id === popup.parentId);
      const turns = parent ? parent.turns : [];
      return justRC(turns.slice(-MAX_HISTORY));
    }
    // top-level → main
    return justRC(messages.slice(-MAX_HISTORY));
  };

  // --- Merge popup: child → PARENT (summary + transcript POPs); top-level → MAIN (summary POP)
  const mergePopup = async (popupId) => {
    const p = popups.find(x => x.id === popupId);
    if (!p) return;

    const hasContent = p.turns.some(t => (t.role === 'assistant' || t.role === 'user') && (t.content || "").trim());
    if (!hasContent) { alert("No popup conversation to summarize yet."); return; }

    const payload = {
      selection: (p.selectedText || "").slice(0, 3000),
      popup_turns: justRC(p.turns),
      history: historyFor(p)
    };

    // mark merging
    setPopups(prev => prev.map(x => x.id === popupId ? { ...x, status: "merging" } : x));

    try {
      const res = await fetch(`${BACKEND_BASE}/api/branch/summary`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      if (!res.ok || !res.body) {
        const maybeJson = await res.json().catch(() => null);
        alert("Summary error: " + (maybeJson?.error || res.statusText || "Unknown error"));
        setPopups(prev => prev.map(x => x.id === popupId ? { ...x, status: "error" } : x));
        return;
      }

      // stream summary text
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "", done = false;
      while (!done) {
        const { value, done: finished } = await reader.read();
        done = finished;
        if (value) acc += decoder.decode(value, { stream: true });
      }

      const summaryNote = { id: uid(), role: 'system', isPop: true, content: acc || "(Empty summary)" };

      if (p.parentId) {
        // CHILD MERGE → append to PARENT:
        // 1) POP summary (as before)
        // 2) POP transcript (full child history, compact dropdown)
        const transcriptNote = buildTranscriptPop(p.turns, p.depth);
        setPopups(prev => prev.map(x => {
          if (x.id !== p.parentId) return x;
          return { ...x, turns: [...x.turns, summaryNote, transcriptNote] };
        }));
      } else {
        // TOP-LEVEL MERGE → append summary POP to MAIN (unchanged)
        setMessages(prev => [...prev, summaryNote]);
      }

      // Close current popup
      setPopups(prev => prev.filter(x => x.id !== popupId));

      // Scroll MAIN a bit
      setTimeout(() => chatRef.current?.scrollTo?.(0, chatRef.current.scrollHeight + 9999), 0);
    } catch (e) {
      console.error(e);
      setPopups(prev => prev.map(x => x.id === popupId ? { ...x, status: "error" } : x));
      alert("Error while summarizing popup.");
    }
  };

  // --- MAIN send
  const sendMain = async () => {
    if (!input.trim()) return;
    const userMsg = { id: uid(), role: 'user', content: input.trim() };
    setInput("");
    setSending(true);
    setMessages(prev => [...prev, userMsg, { id: uid(), role: 'assistant', content: "" }]);

    try {
      const body = JSON.stringify({ messages: justRC([...messages, userMsg]) });
      const res = await fetch(`${BACKEND_BASE}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!res.ok || !res.body) {
        const maybeJson = await res.json().catch(() => null);
        const msg = (maybeJson && (maybeJson.error || JSON.stringify(maybeJson))) || res.statusText || "Unknown error";
        setMessages(prev => writeLastAssistant(prev, `Error from model: ${msg}`));
        setSending(false); return;
      }
      await streamIntoLastAssistant(res, setMessages, chatRef);
    } catch (e) {
      console.error(e);
      setMessages(prev => writeLastAssistant(prev, "[Error streaming response]"));
    } finally {
      setSending(false);
    }
  };

  // --- Popup send
  const sendPopup = async (popupId) => {
    const p = popups.find(x => x.id === popupId);
    if (!p) return;

    const inputText = (p.input || "").trim();
    if (!inputText) { alert("Type your message in the popup first."); return; }

    // local push: user + assistant placeholder
    const newUserTurn = { role: 'user', content: inputText };
    const newAssistantTurn = { role: 'assistant', content: "" };

    setPopups(prev => prev.map(x => {
      if (x.id !== popupId) return x;
      return { ...x, turns: [...x.turns, newUserTurn, newAssistantTurn], input: "", status: "generating" };
    }));

    try {
      const payload = {
        selection: (p.selectedText || "").slice(0, 3000),
        popup_turns: justRC([...p.turns, newUserTurn]),
        history: historyFor(p)
      };
      const res = await fetch(`${BACKEND_BASE}/api/branch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      if (!res.ok || !res.body) {
        const maybeJson = await res.json().catch(() => null);
        const msg = (maybeJson && (maybeJson.error || JSON.stringify(maybeJson))) || res.statusText || "Unknown error";
        setPopups(prev => prev.map(x => x.id === popupId ? {
          ...x, status: "error",
          turns: x.turns.map((t, i) => (i === x.turns.length - 1 ? { ...t, content: `Error from model: ${msg}` } : t))
        } : x));
        return;
      }

      // stream into last assistant turn for this popup
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
    } catch (e) {
      console.error(e);
      setPopups(prev => prev.map(x => x.id === popupId ? {
        ...x, status: "error",
        turns: x.turns.map((t, i) => (i === x.turns.length - 1 ? { ...t, content: "[Error streaming response]" } : t))
      } : x));
    }
  };

  // --- POP delete (from MAIN)
  const handleDeletePop = (id) => {
    setMessages(prev => prev.filter(m => m.id !== id));
  };

  // --- User Edit & Send (MAIN)
  const startEdit = (id, content) => setEditState({ id, text: content, sending: false });
  const cancelEdit = () => setEditState({ id: null, text: "", sending: false });

  const submitEdit = async () => {
    const { id, text } = editState;
    if (!id) return;
    const edited = (text || "").trim();
    if (!edited) { alert("Edited message is empty."); return; }
    const idx = messages.findIndex(m => m.id === id);
    if (idx < 0) { cancelEdit(); return; }

    const trimmed = messages.slice(0, idx);
    const newUser = { id: uid(), role: 'user', content: edited };
    const newAssistant = { id: uid(), role: 'assistant', content: "" };
    setMessages([...trimmed, newUser, newAssistant]);
    setEditState({ id, text: edited, sending: true });

    try {
      const body = JSON.stringify({ messages: justRC([...trimmed, newUser]) });
      const res = await fetch(`${BACKEND_BASE}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!res.ok || !res.body) {
        const maybeJson = await res.json().catch(() => null);
        const msg = (maybeJson && (maybeJson.error || JSON.stringify(maybeJson))) || res.statusText || "Unknown error";
        setMessages(prev => writeLastAssistant(prev, `Error from model: ${msg}`));
        setEditState({ id: null, text: "", sending: false });
        return;
      }
      await streamIntoLastAssistant(res, setMessages, chatRef);
    } catch (e) {
      console.error(e);
      setMessages(prev => writeLastAssistant(prev, "[Error streaming response]"));
    } finally {
      setEditState({ id: null, text: "", sending: false });
    }
  };

  return (
    <div className="app">
      <div className="header">
        <h1>Multithreaded Chat • Branch Popups</h1>
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
          focus={() => focusPopup(p.id)}
          onClose={() => closePopup(p.id)}
          onMerge={() => mergePopup(p.id)}
          onSend={() => sendPopup(p.id)}
          openChild={(sel) => openChildPopup(p.id, sel)}
          setPopups={setPopups}
        />
      ))}
    </div>
  );
}

// ---- Helpers ----
function writeLastAssistant(prev, text) {
  const copy = [...prev];
  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i].role === 'assistant') { copy[i] = { ...copy[i], content: text }; break; }
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

// ---- UI Components ----
function MessageList({ messages, onDeletePop, editState, onStartEdit, onEditText, onCancelEdit, onSubmitEdit }) {
  return (
    <>
      {messages.map((m) => {
        const isEditing = editState.id === m.id && m.role === 'user';
        return (
          <div className={`message ${m.isPop ? 'is-pop' : ''}`} data-id={m.id} data-role={m.role} key={m.id}>
            <div className="meta">{m.isPop ? 'POP' : m.role.toUpperCase()}</div>
            <div className="content">
              {m.isPop ? (
                <PopCompact id={m.id} content={m.content} onDelete={() => onDeletePop?.(m.id)} />
              ) : (
                <>
                  {isEditing ? (
                    <div className="edit-area">
                      <textarea
                        className="editbox"
                        value={editState.text}
                        onChange={(e) => onEditText(e.target.value)}
                        onKeyDown={(e) => { if ((e.key === 'Enter') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSubmitEdit(); } }}
                        autoFocus
                      />
                      <div className="msg-actions editing">
                        <button className="btn micro success" onClick={onSubmitEdit} disabled={editState.sending}>
                          {editState.sending ? "Sending…" : "Send"}
                        </button>
                        <button className="btn micro danger" onClick={onCancelEdit} disabled={editState.sending}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {m.content}
                      {m.role === 'user' && (
                        <div className="msg-actions">
                          <button className="btn micro secondary" onClick={() => onStartEdit(m.id, m.content)}>Edit</button>
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
        {onDelete && (
          <button
            className="notes-delete"
            title="Delete this POP note"
            aria-label="Delete POP note"
            onClick={onDeleteClick}
            onMouseDown={stopToggle}
            onTouchStart={stopToggle}
          >×</button>
        )}
      </summary>
      <div className="notes-body"><pre>{full}</pre></div>
    </details>
  );
}

function Popup({ popup, focus, onClose, onMerge, onSend, openChild, setPopups }) {
  const ref = useRef(null);
  const streamRef = useRef(null);
  const startPos = useRef({ x: 0, y: 0, dx: 0, dy: 0 });

  // Attach Ask pill inside this popup's stream
  useEffect(() => {
    const detach = window.registerSelectionPillFor?.(streamRef.current, ({ selectedText }) => {
      openChild(selectedText);
    });
    return () => { detach && detach(); };
  }, [openChild]);

  const onMouseDownTitle = (e) => {
    focus(); // raise z-index
    if (!ref.current) return;
    startPos.current = { x: e.clientX, y: e.clientY, dx: popup.x, dy: popup.y };
    setPopups(prev => prev.map(p => p.id === popup.id ? { ...p, dragging: true } : p));
    e.preventDefault();
  };
  const onMouseMove = useCallback((e) => {
    setPopups(prev => prev.map(p => {
      if (p.id !== popup.id || !p.dragging) return p;
      const nx = Math.max(8, Math.min(window.innerWidth - 460, startPos.current.dx + (e.clientX - startPos.current.x)));
      const ny = Math.max(8, Math.min(window.innerHeight - 140, startPos.current.dy + (e.clientY - startPos.current.y)));
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
    <div
      className="popup"
      ref={ref}
      onMouseDown={focus}
      style={{ left: popup.x, top: popup.y, zIndex: popup.z }}
    >
      <div className="titlebar" onMouseDown={onMouseDownTitle}>
        <span className="badge">Branch L{popup.depth}</span>
        <div>Popup Chat</div>
      </div>

      {/* Popup chat log (includes POP notes appended from children) */}
      <div className="stream" ref={streamRef}>
        {popup.turns.length === 0 && (
          <div style={{ color: '#7f8bb3' }}>
            This is a separate mini chat. Your selected text is prefilled below—add your question/instruction and hit Send.
            Highlight any text here to open a child popup.
          </div>
        )}
        {popup.turns.map((t, idx) => (
          <div key={idx} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: '#9fb0e6' }}>{t.isPop ? 'POP' : t.role.toUpperCase()}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>
              {t.isPop ? (
                // POPs inside popups are not deletable (they belong to the branch)
                <PopCompact id={`p-${popup.id}-${idx}`} content={t.content} onDelete={null} />
              ) : (
                t.content
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Input box (prefilled with selection initially) */}
      <div className="question">
        <small>Input:</small>
        <textarea
          placeholder="Your selected text is pasted here. Add your instruction/question…"
          value={popup.input}
          onChange={(e) =>
            setPopups(prev => prev.map(x => x.id === popup.id ? { ...x, input: e.target.value } : x))
          }
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
          }}
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
