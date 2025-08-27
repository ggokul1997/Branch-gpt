// selection.js
// Vanilla JS helper to detect text selection INSIDE a .message, show an "Ask" pill,
// and hand control to React via a callback.
// React registers the callback with window.initSelectionPill({ onAsk }).

(function () {
  let onAskCallback = null;
  let pillEl = null;

  function createPill() {
    const btn = document.createElement('button');
    btn.className = 'ask-pill';
    btn.textContent = 'Ask';
    btn.style.display = 'none';
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const text = sel.toString().trim();
      if (!text) return;
      const range = sel.getRangeAt(0);
      const originEl = closestMessage(range.commonAncestorContainer);
      if (!originEl) return;
      const originMessageId = originEl.getAttribute('data-id');

      hidePill();
      if (onAskCallback) {
        onAskCallback({
          originMessageId,
          selectedText: text
        });
      }
      sel.removeAllRanges(); // optional: clear selection after opening popup
    });
    document.body.appendChild(btn);
    return btn;
  }

  function showPillAt(rect) {
    if (!pillEl) pillEl = createPill();
    pillEl.style.left = `${Math.min(rect.left + rect.width/2, window.innerWidth - 60)}px`;
    pillEl.style.top = `${rect.top - 36}px`;
    pillEl.style.display = 'inline-block';
  }

  function hidePill() {
    if (pillEl) pillEl.style.display = 'none';
  }

  function closestMessage(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && !el.classList?.contains('message')) {
      el = el.parentElement;
    }
    return el;
  }

  document.addEventListener('mouseup', () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { hidePill(); return; }
    const text = sel.toString().trim();
    if (!text) { hidePill(); return; }

    const range = sel.getRangeAt(0);
    const originEl = closestMessage(range.commonAncestorContainer);
    if (!originEl) { hidePill(); return; }

    const rect = range.getBoundingClientRect();
    if (!rect || !rect.height) { hidePill(); return; }
    showPillAt(rect);
  });

  document.addEventListener('scroll', hidePill, true);
  window.addEventListener('resize', hidePill);

  window.initSelectionPill = function ({ onAsk }) {
    onAskCallback = onAsk;
  };
})();
