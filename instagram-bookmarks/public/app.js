/* ───────────────────────────────────────────────────────────────────────────
   Instagram Bookmarks — client

   Three gestures, and they must never fight each other:
     • tap        → dim / undim (a soft de-prioritize, not a delete)
     • hold+drag  → move the card anywhere in the grid
     • tool tap   → open on Instagram / expand caption / remove

   Touch drag is gated behind a hold so ordinary vertical scrolling still
   works; on a mouse a few pixels of movement is enough.
   ─────────────────────────────────────────────────────────────────────────── */

'use strict';

const HOLD_MS        = 380;   // touch: how long before a hold becomes a drag
const HOLD_SLOP      = 10;    // touch: movement that cancels the hold (= a scroll)
const MOUSE_SLOP     = 6;     // mouse: movement that starts a drag
const EDGE_ZONE      = 90;    // px from viewport edge where auto-scroll kicks in
const EDGE_SPEED     = 14;    // px per frame at full strength
const POLL_MS        = 2500;  // how often to check on pending thumbnails

const grid       = document.getElementById('grid');
const emptyState = document.getElementById('empty');
const statusEl   = document.getElementById('status');
const hintEl     = document.getElementById('hint');
const addSheet   = document.getElementById('add-sheet');
const menuSheet  = document.getElementById('menu-sheet');
const addUrl     = document.getElementById('add-url');
const addError   = document.getElementById('add-error');
const fileInput  = document.getElementById('file-input');

let items = [];              // server order == display order
let pollTimer = null;
let statusTimer = null;

// ── Utilities ─────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body && !options.raw ? { 'Content-Type': 'application/json' } : {},
    ...options
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body is fine */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function setStatus(message, isError = false) {
  clearTimeout(statusTimer);
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', Boolean(isError));
  if (message) {
    statusTimer = setTimeout(() => {
      statusEl.textContent = '';
      statusEl.classList.remove('error');
    }, isError ? 6000 : 3500);
  }
}

function buzz(ms) {
  if (navigator.vibrate) { try { navigator.vibrate(ms); } catch { /* unsupported */ } }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function buildCard(item) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.id = item.id;
  card.setAttribute('role', 'listitem');

  card.innerHTML = `
    <div class="card-media">
      <div class="card-tools">
        <button class="tool js-expand" title="Show the whole caption" aria-label="Show the whole caption">⤢</button>
        <a class="tool js-open" target="_blank" rel="noopener noreferrer"
           title="Open on Instagram" aria-label="Open on Instagram">↗</a>
        <button class="tool danger js-remove" title="Remove" aria-label="Remove">✕</button>
      </div>
    </div>
    <div class="card-body">
      <span class="card-author"></span>
      <p class="card-caption"></p>
    </div>`;

  updateCard(card, item);
  return card;
}

function updateCard(card, item) {
  const media   = card.querySelector('.card-media');
  const author  = card.querySelector('.card-author');
  const caption = card.querySelector('.card-caption');
  const open    = card.querySelector('.js-open');

  card.classList.toggle('dimmed', item.dimmed);
  card.setAttribute('aria-label',
    `${item.author ? '@' + item.author + '. ' : ''}${item.caption || 'No caption'}. ` +
    `${item.dimmed ? 'Dimmed' : 'Active'}. Tap to ${item.dimmed ? 'restore' : 'dim'}.`);

  open.href = item.url;

  author.textContent  = item.author ? '@' + item.author : '';
  author.hidden       = !item.author;

  caption.textContent = item.caption || 'No caption';
  caption.classList.toggle('empty', !item.caption);

  // Only touch the media layer when it actually changed — replacing a loaded
  // <img> on every poll would make the grid flicker.
  const wanted = item.thumb ? `/media/${item.thumb}` : `state:${item.thumbState}`;
  if (media.dataset.showing !== wanted) {
    media.dataset.showing = wanted;
    media.querySelectorAll('img, .fallback, .spinner').forEach(el => el.remove());

    if (item.thumb) {
      const img = document.createElement('img');
      img.src = `/media/${item.thumb}`;
      img.alt = item.caption ? item.caption.slice(0, 120) : 'Saved Instagram post';
      img.loading = 'lazy';
      img.decoding = 'async';
      media.prepend(img);
    } else if (item.thumbState === 'pending') {
      const spinner = document.createElement('div');
      spinner.className = 'spinner';
      media.prepend(spinner);
    } else {
      const fallback = document.createElement('div');
      fallback.className = 'fallback';
      fallback.innerHTML =
        `<span class="glyph">🔗</span><span>No preview<br>tap ↗ to open</span>`;
      media.prepend(fallback);
    }
  }
}

// Reconcile by id so cards keep their DOM identity (and their in-flight
// animations) across refreshes.
function render() {
  const existing = new Map(
    [...grid.children].map(el => [el.dataset.id, el]));

  items.forEach((item, index) => {
    let card = existing.get(item.id);
    if (card) {
      updateCard(card, item);
      existing.delete(item.id);
    } else {
      card = buildCard(item);
    }
    if (grid.children[index] !== card) {
      grid.insertBefore(card, grid.children[index] || null);
    }
  });

  existing.forEach(el => el.remove());

  emptyState.hidden = items.length > 0;
  grid.hidden = items.length === 0;

  const dimmed = items.filter(i => i.dimmed).length;
  const undimLabel = document.getElementById('undim-count');
  if (undimLabel) {
    undimLabel.textContent = dimmed
      ? `${dimmed} post${dimmed === 1 ? '' : 's'} currently dimmed`
      : 'Nothing is dimmed right now';
  }

  schedulePoll();
}

// ── Loading & polling ─────────────────────────────────────────────────────────

async function load() {
  try {
    const data = await api('/api/bookmarks');
    items = data.items;
    render();
  } catch (err) {
    setStatus(`Could not load your library: ${err.message}`, true);
  }
}

// Freshly added posts arrive without a thumbnail; the server fills them in
// behind the scenes, so poll while anything is still pending.
function schedulePoll() {
  const pending = items.some(i => i.thumbState === 'pending');
  if (!pending) {
    clearTimeout(pollTimer);
    pollTimer = null;
    return;
  }
  if (pollTimer) return;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    if (!drag) await load();
    else schedulePoll();
  }, POLL_MS);
}

// ── Dim / undim ───────────────────────────────────────────────────────────────

async function toggleDim(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;

  const card = grid.querySelector(`[data-id="${id}"]`);
  const next = !item.dimmed;

  // Optimistic: the tap must feel instant.
  item.dimmed = next;
  if (card) {
    card.classList.toggle('dimmed', next);
    card.classList.remove('pulse');
    void card.offsetWidth;            // restart the animation
    card.classList.add('pulse');
  }
  buzz(next ? 12 : 8);

  try {
    await api(`/api/bookmarks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ dimmed: next })
    });
    render();
  } catch (err) {
    item.dimmed = !next;
    if (card) card.classList.toggle('dimmed', !next);
    setStatus(`Could not save that: ${err.message}`, true);
  }
}

// ── Drag to reorder ───────────────────────────────────────────────────────────
//
// Positions are computed in document space using offsetLeft/offsetTop, which
// are layout values and therefore unaffected by the transforms we apply. That
// keeps hit-testing stable even while other cards are mid-animation.

let drag = null;
let pending = null;    // a pointer that is down but has not become a drag yet

const docX = e => e.clientX + window.scrollX;
const docY = e => e.clientY + window.scrollY;

grid.addEventListener('pointerdown', event => {
  if (event.button !== undefined && event.button > 0) return;   // right/middle click
  if (event.target.closest('.tool')) return;                    // tool buttons win

  const card = event.target.closest('.card');
  if (!card || !grid.contains(card)) return;

  const isTouch = event.pointerType === 'touch' || event.pointerType === 'pen';

  pending = {
    card,
    id: card.dataset.id,
    isTouch,
    pointerId: event.pointerId,
    startX: docX(event),
    startY: docY(event),
    grabX: docX(event) - card.offsetLeft,
    grabY: docY(event) - card.offsetTop,
    moved: false,
    timer: isTouch ? setTimeout(() => beginDrag(), HOLD_MS) : null
  };
});

function beginDrag() {
  if (!pending || drag) return;

  drag = pending;
  pending = null;
  clearTimeout(drag.timer);

  drag.card.setPointerCapture(drag.pointerId);
  drag.card.classList.add('dragging');
  grid.classList.add('is-dragging');
  document.body.classList.add('is-dragging');
  buzz(18);

  positionDragged(drag.lastX ?? drag.startX, drag.lastY ?? drag.startY);
  startEdgeScroll();
}

function positionDragged(x, y) {
  const dx = (x - drag.grabX) - drag.card.offsetLeft;
  const dy = (y - drag.grabY) - drag.card.offsetTop;
  drag.card.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.05)`;
}

window.addEventListener('pointermove', event => {
  if (pending && event.pointerId === pending.pointerId) {
    const dx = docX(event) - pending.startX;
    const dy = docY(event) - pending.startY;
    const distance = Math.hypot(dx, dy);

    pending.lastX = docX(event);
    pending.lastY = docY(event);

    if (pending.isTouch) {
      // Movement before the hold completes means they meant to scroll.
      if (distance > HOLD_SLOP) { clearTimeout(pending.timer); pending = null; }
    } else if (distance > MOUSE_SLOP) {
      beginDrag();
    }
    return;
  }

  if (!drag || event.pointerId !== drag.pointerId) return;

  drag.moved = true;
  drag.lastX = docX(event);
  drag.lastY = docY(event);
  positionDragged(drag.lastX, drag.lastY);
  reorderTo(drag.lastX, drag.lastY);
}, { passive: true });

// Once a drag is live, swallow touch scrolling.
window.addEventListener('touchmove', event => {
  if (drag) event.preventDefault();
}, { passive: false });

// Find the card whose centre is nearest the pointer and slot the dragged card
// into its place, animating everything that has to shift (a FLIP).
function reorderTo(x, y) {
  const cards = [...grid.children];
  let target = null;
  let best = Infinity;

  for (const card of cards) {
    if (card === drag.card) continue;
    const cx = card.offsetLeft + card.offsetWidth / 2;
    const cy = card.offsetTop + card.offsetHeight / 2;
    const distance = (x - cx) ** 2 + (y - cy) ** 2;
    if (distance < best) { best = distance; target = card; }
  }
  if (!target) return;

  const from = cards.indexOf(drag.card);
  const to   = cards.indexOf(target);
  if (from === to) return;

  // Record where everything is, move the node, then play the difference back.
  const before = new Map(cards.map(card => [card, { x: card.offsetLeft, y: card.offsetTop }]));

  if (to > from) target.after(drag.card);
  else           target.before(drag.card);

  for (const card of cards) {
    if (card === drag.card) continue;
    const old = before.get(card);
    const dx = old.x - card.offsetLeft;
    const dy = old.y - card.offsetTop;
    if (!dx && !dy) continue;

    card.classList.remove('shifting');
    card.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    requestAnimationFrame(() => {
      card.classList.add('shifting');
      card.style.transform = '';
    });
  }

  // The dragged card's own layout slot just changed — keep it under the finger.
  positionDragged(x, y);
}

async function endDrag(event) {
  if (pending && event.pointerId === pending.pointerId) {
    const wasTouch = pending.isTouch;
    clearTimeout(pending.timer);
    const id = pending.id;
    const distance = Math.hypot(
      (pending.lastX ?? pending.startX) - pending.startX,
      (pending.lastY ?? pending.startY) - pending.startY);
    pending = null;
    // A press that never became a drag and never travelled is a tap.
    if (distance <= (wasTouch ? HOLD_SLOP : MOUSE_SLOP)) toggleDim(id);
    return;
  }

  if (!drag || event.pointerId !== drag.pointerId) return;

  const { card, id, moved } = drag;
  stopEdgeScroll();

  try { card.releasePointerCapture(drag.pointerId); } catch { /* already released */ }
  card.classList.add('shifting');
  card.style.transform = '';
  card.classList.remove('dragging');
  grid.classList.remove('is-dragging');
  document.body.classList.remove('is-dragging');
  setTimeout(() => card.classList.remove('shifting'), 240);

  const index = [...grid.children].indexOf(card);
  drag = null;

  // A hold that never moved still counts as a deliberate press, not a tap —
  // dimming here would be a nasty surprise after a long press.
  if (!moved) return;

  const previous = items.slice();
  const from = items.findIndex(i => i.id === id);
  if (from !== -1 && from !== index) {
    const [item] = items.splice(from, 1);
    items.splice(index, 0, item);
  }

  try {
    await api(`/api/bookmarks/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ index })
    });
  } catch (err) {
    items = previous;
    render();
    setStatus(`Could not save the new position: ${err.message}`, true);
  }
}

window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', event => {
  if (pending && event.pointerId === pending.pointerId) {
    clearTimeout(pending.timer);
    pending = null;
    return;
  }
  if (drag && event.pointerId === drag.pointerId) {
    drag.moved = true;      // treat as a move so it never turns into a dim
    endDrag(event);
  }
});

// ── Edge auto-scroll while dragging ───────────────────────────────────────────

let edgeFrame = null;

function startEdgeScroll() {
  const step = () => {
    if (!drag) return;
    const y = drag.lastY - window.scrollY;      // back to viewport space
    const height = window.innerHeight;
    let delta = 0;

    if (y < EDGE_ZONE)               delta = -EDGE_SPEED * (1 - y / EDGE_ZONE);
    else if (y > height - EDGE_ZONE) delta =  EDGE_SPEED * (1 - (height - y) / EDGE_ZONE);

    if (delta) {
      const before = window.scrollY;
      window.scrollBy(0, delta);
      const actual = window.scrollY - before;
      if (actual) {
        drag.lastY += actual;                  // the finger stayed put; the page moved
        positionDragged(drag.lastX, drag.lastY);
        reorderTo(drag.lastX, drag.lastY);
      }
    }
    edgeFrame = requestAnimationFrame(step);
  };
  edgeFrame = requestAnimationFrame(step);
}

function stopEdgeScroll() {
  if (edgeFrame) cancelAnimationFrame(edgeFrame);
  edgeFrame = null;
}

// ── Card tools ────────────────────────────────────────────────────────────────

grid.addEventListener('click', async event => {
  const tool = event.target.closest('.tool');
  if (!tool) return;
  event.stopPropagation();

  const card = tool.closest('.card');
  const id = card.dataset.id;

  if (tool.classList.contains('js-expand')) {
    card.classList.toggle('expanded');
    return;
  }

  if (tool.classList.contains('js-remove')) {
    event.preventDefault();
    const item = items.find(i => i.id === id);
    const label = item && item.author ? `@${item.author}'s post` : 'this bookmark';
    if (!confirm(`Remove ${label} from your library?\n\nThis only affects this app — your Instagram save is untouched.`)) return;

    const previous = items.slice();
    items = items.filter(i => i.id !== id);
    render();
    try {
      await api(`/api/bookmarks/${id}`, { method: 'DELETE' });
      setStatus('Removed.');
    } catch (err) {
      items = previous;
      render();
      setStatus(`Could not remove that: ${err.message}`, true);
    }
  }
});

// ── Adding ────────────────────────────────────────────────────────────────────

function openAddSheet(prefill = '') {
  addError.hidden = true;
  addUrl.value = prefill;
  addSheet.showModal();
  setTimeout(() => addUrl.focus(), 50);
}

document.getElementById('btn-add').addEventListener('click', () => openAddSheet());
document.getElementById('empty-add').addEventListener('click', () => openAddSheet());

document.getElementById('add-form').addEventListener('submit', event => {
  // `method="dialog"` closes the sheet; intercept so we can validate first.
  if (event.submitter && event.submitter.value !== 'save') return;
  event.preventDefault();
  addBookmark(addUrl.value);
});

async function addBookmark(url) {
  const value = (url || '').trim();
  if (!value) return;

  const submit = document.getElementById('add-submit');
  submit.disabled = true;
  addError.hidden = true;

  try {
    const data = await api('/api/bookmarks', {
      method: 'POST',
      body: JSON.stringify({ url: value })
    });
    items.unshift(data.item);
    render();
    addSheet.close();
    addUrl.value = '';
    setStatus('Added — fetching the preview…');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    addError.textContent = err.status === 409
      ? 'That post is already in your library.'
      : err.message;
    addError.hidden = false;
  } finally {
    submit.disabled = false;
  }
}

// ── Options sheet ─────────────────────────────────────────────────────────────

document.getElementById('btn-menu').addEventListener('click', () => menuSheet.showModal());
document.getElementById('empty-import').addEventListener('click', () => fileInput.click());

menuSheet.addEventListener('close', () => {
  if (menuSheet.returnValue === 'import') fileInput.click();
  if (menuSheet.returnValue === 'undim')  undimAll();
  if (menuSheet.returnValue === 'export') exportLibrary();
});

async function undimAll() {
  const dimmed = items.filter(i => i.dimmed);
  if (!dimmed.length) { setStatus('Nothing was dimmed.'); return; }

  setStatus(`Restoring ${dimmed.length}…`);
  await Promise.all(dimmed.map(item =>
    api(`/api/bookmarks/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ dimmed: false })
    }).then(() => { item.dimmed = false; }).catch(() => {})
  ));
  render();
  setStatus('All restored.');
}

function exportLibrary() {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), items }, null, 2)],
    { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `bookmarks-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ── Import ────────────────────────────────────────────────────────────────────

fileInput.addEventListener('change', async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;

  setStatus(`Reading ${file.name}…`);
  try {
    const text = await file.text();
    const data = await api(`/api/import?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      raw: true,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: text
    });

    items = data.items;
    render();

    const parts = [`Imported ${data.added}`];
    if (data.duplicates) parts.push(`${data.duplicates} already saved`);
    if (data.skipped)    parts.push(`${data.skipped} unreadable`);
    setStatus(parts.join(' · ') + (data.added ? ' · fetching previews…' : ''));
  } catch (err) {
    setStatus(`Import failed: ${err.message}`, true);
  } finally {
    fileInput.value = '';
  }
});

// ── Hint ──────────────────────────────────────────────────────────────────────

const HINT_KEY = 'ig-bookmarks:hint-seen';

function maybeShowHint() {
  if (localStorage.getItem(HINT_KEY) || !items.length) return;
  hintEl.hidden = false;
}

document.getElementById('hint-dismiss').addEventListener('click', () => {
  hintEl.hidden = true;
  localStorage.setItem(HINT_KEY, '1');
});

// ── Boot ──────────────────────────────────────────────────────────────────────

(async function start() {
  await load();
  maybeShowHint();

  // Arriving from the Android share sheet: /share redirects here with ?add=
  const shared = new URLSearchParams(location.search).get('add');
  if (shared) {
    history.replaceState(null, '', location.pathname);
    openAddSheet(shared);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell is optional */ });
  }

  // Someone may have added a post on another device.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !drag) load();
  });
})();
