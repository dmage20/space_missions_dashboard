// ─────────────────────────────────────────────────────────────────────────────
// Bookmark store — flat-file JSON persistence, stdlib only.
//
// The item array IS the display order. Reordering is a splice, which keeps the
// on-disk shape trivial to inspect, diff and hand-edit.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

// Override with IG_BOOKMARKS_DATA to keep the library somewhere else (a synced
// folder, a different disk) — also what the tests use to stay isolated.
const DATA_DIR   = process.env.IG_BOOKMARKS_DATA
  ? path.resolve(process.env.IG_BOOKMARKS_DATA)
  : path.join(__dirname, '..', 'data');
const MEDIA_DIR  = path.join(DATA_DIR, 'media');
const STORE_FILE = path.join(DATA_DIR, 'bookmarks.json');

let state = { version: 1, items: [] };
let writeTimer = null;

// ── Load / save ───────────────────────────────────────────────────────────────

function load() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  if (!fs.existsSync(STORE_FILE)) {
    state = { version: 1, items: [] };
    flush();
    return state;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    state = {
      version: 1,
      items: Array.isArray(parsed.items) ? parsed.items.map(normalize) : []
    };
  } catch (err) {
    // Never lose data to a parse error — park the bad file and start clean.
    const backup = `${STORE_FILE}.corrupt-${Date.now()}`;
    fs.renameSync(STORE_FILE, backup);
    console.error(`[store] could not parse bookmarks.json (${err.message})`);
    console.error(`[store] moved it to ${backup} and started a fresh library`);
    state = { version: 1, items: [] };
    flush();
  }
  return state;
}

// Writes are debounced (drag-reorder fires a lot) but always land via
// tmp-file + rename so a crash mid-write can't truncate the library.
function save() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = null; flush(); }, 120);
}

function flush() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

function normalize(item) {
  return {
    id:         item.id,
    url:        item.url,
    shortcode:  item.shortcode || null,
    kind:       item.kind      || 'post',
    author:     item.author    || null,
    caption:    typeof item.caption === 'string' ? item.caption : '',
    thumb:      item.thumb     || null,      // filename inside data/media
    thumbState: item.thumbState || 'pending', // pending | ok | failed
    dimmed:     item.dimmed === true,
    savedAt:    item.savedAt   || null,      // when Instagram saved it (imports)
    addedAt:    item.addedAt   || new Date().toISOString(),
    source:     item.source    || 'url'
  };
}

// ── Queries ───────────────────────────────────────────────────────────────────

const all      = () => state.items;
const find     = id => state.items.find(b => b.id === id) || null;
const findByUrl = url => state.items.find(b => b.url === url) || null;
const findByShortcode = code =>
  code ? state.items.find(b => b.shortcode === code) || null : null;

// ── Mutations ─────────────────────────────────────────────────────────────────

function nextId() {
  return 'b_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// New bookmarks go to the top: the thing you just saved is the thing you are
// most likely to want to place.
function add(fields) {
  const item = normalize({ ...fields, id: nextId() });
  state.items.unshift(item);
  save();
  return item;
}

function update(id, patch) {
  const item = find(id);
  if (!item) return null;
  Object.assign(item, patch);
  save();
  return item;
}

function remove(id) {
  const idx = state.items.findIndex(b => b.id === id);
  if (idx === -1) return null;
  const [item] = state.items.splice(idx, 1);
  if (item.thumb) {
    try { fs.unlinkSync(path.join(MEDIA_DIR, item.thumb)); } catch { /* already gone */ }
  }
  save();
  return item;
}

// Move `id` to absolute position `index` in the list.
function move(id, index) {
  const from = state.items.findIndex(b => b.id === id);
  if (from === -1) return null;

  const to = Math.max(0, Math.min(state.items.length - 1, Math.trunc(index)));
  if (from === to) return state.items[from];

  const [item] = state.items.splice(from, 1);
  state.items.splice(to, 0, item);
  save();
  return item;
}

// Apply a full ordering by id. Ids missing from `ids` keep their relative
// order and are appended, so a stale client can never drop a bookmark.
function reorder(ids) {
  const rank = new Map(ids.map((id, i) => [id, i]));
  state.items.sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
    const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
    return ra - rb;
  });
  save();
  return state.items;
}

module.exports = {
  DATA_DIR, MEDIA_DIR, STORE_FILE,
  load, save, flush,
  all, find, findByUrl, findByShortcode,
  add, update, remove, move, reorder
};
