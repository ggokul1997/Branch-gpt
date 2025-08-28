// selection.js
// Floating "Ask" pill for MAIN and POPUP containers.
// Fix: don't hide the pill when clicking on the pill itself.

(function () {
  let pill;

  function ensurePill() {
    if (pill) return pill;
    pill = document.createElement('button');
    pill.className = 'ask-pill';
    pill.style.position = 'absolute';
    pill.style.display = 'none';
    pill.style.zIndex = '3000';
    pill.type = 'button';
    pill.textContent = 'Ask';
    document.body.appendChild(pill);
    return pill;
  }

  function hidePill() {
    if (!pill) return;
    pill.style.display = 'none';
    pill.onclick = null;
  }

  function showPillAt(x, y, onClick) {
    const el = ensurePill();
    el.style.left = `${Math.max(8, x)}px`;
    el.style.top  = `${Math.max(8, y)}px`;
    el.style.display = 'inline-block';
    el.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { onClick(); } finally { hidePill(); }
      const sel = window.getSelection?.();
      if (sel && sel.removeAllRanges) sel.removeAllRanges();
    };
  }

  function handleSelection(container, onAsk) {
    return function () {
      const sel = window.getSelection?.();
      if (!sel || sel.isCollapsed) { hidePill(); return; }

      const anchor = sel.anchorNode;
      if (container && anchor && !container.contains(anchor)) { hidePill(); return; }

      const text = (sel.toString() || '').trim();
      if (!text) { hidePill(); return; }

      let rect;
      try { rect = sel.getRangeAt(0).getBoundingClientRect(); }
      catch { hidePill(); return; }

      const x = rect.right + window.scrollX + 6;
      const y = rect.top + window.scrollY - 30;

      showPillAt(x, y, () => onAsk({ selectedText: text }));
    };
  }

  function makeBinding(container, onAsk) {
    const handler = handleSelection(container, onAsk);
    const target = container || document;

    target.addEventListener('mouseup', handler);
    target.addEventListener('keyup', handler);

    // IMPORTANT: don't hide the pill when clicking the pill itself
    const globalHide = (e) => {
      if (pill && (e.target === pill || pill.contains(e.target))) return;
      hidePill();
    };
    document.addEventListener('mousedown', globalHide);

    return function detach() {
      target.removeEventListener('mouseup', handler);
      target.removeEventListener('keyup', handler);
      document.removeEventListener('mousedown', globalHide);
    };
  }

  // MAIN: attach to chat container (or body)
  window.initSelectionPill = function ({ onAsk } = {}) {
    const container = document.querySelector('.chat') || document.body;
    return makeBinding(container, onAsk || (() => {}));
  };

  // POPUP: attach to a specific element (e.g., popup's .stream)
  window.registerSelectionPillFor = function (el, onAsk) {
    if (!el) return () => {};
    return makeBinding(el, onAsk || (() => {}));
  };
})();
