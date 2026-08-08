// ─────────────────────────────────────────────────────────────────────────────
// Meta "Download Your Information" importer.
//
// Handles saved_posts.json / saved_collections.json and their HTML twins.
// Meta reshuffles these files often, so rather than pattern-matching one exact
// shape we walk the whole structure looking for Instagram post links and pick
// up whatever title/timestamp sits nearest to each one.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const metadata = require('./metadata');

// Meta escapes each UTF-8 *byte* as its own code point, so "don’t" — the three
// bytes E2 80 99 — arrives as "â". Round-tripping through
// latin1 reassembles the bytes. The guard looks for a UTF-8 lead byte followed
// by a continuation byte, a pairing intact text never produces.
const MOJIBAKE = /[Â-ô][-¿]/;

function fixMojibake(str) {
  if (typeof str !== 'string' || !MOJIBAKE.test(str)) return str;
  try {
    const fixed = Buffer.from(str, 'latin1').toString('utf8');
    return fixed.includes('�') ? str : fixed;
  } catch {
    return str;
  }
}

// Matches post links anywhere, including on the wrong host — parseUrl is what
// actually validates, and anything it turns down is reported as skipped.
const isPostLink = value =>
  typeof value === 'string' && /instagram\.com\/(p|reel|reels|tv)\//i.test(value);

// ── JSON exports ──────────────────────────────────────────────────────────────

function fromJson(text) {
  const data = JSON.parse(text);
  const found = [];

  // Depth-first walk. `context` carries the nearest enclosing title, which in
  // Meta's format is the post author's handle.
  (function walk(node, context) {
    if (node === null || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      node.forEach(child => walk(child, context));
      return;
    }

    const title = typeof node.title === 'string' ? fixMojibake(node.title) : context.title;
    const timestamp = typeof node.timestamp === 'number' ? node.timestamp : context.timestamp;
    const nested = { title, timestamp };

    if (isPostLink(node.href)) {
      found.push({ href: node.href, author: title || null, timestamp: timestamp || null });
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'href') continue;
      if (isPostLink(value)) {
        found.push({ href: value, author: title || null, timestamp: timestamp || null });
      } else {
        walk(value, nested);
      }
    }
  })(data, { title: null, timestamp: null });

  return found;
}

// ── HTML exports ──────────────────────────────────────────────────────────────

function fromHtml(text) {
  const found = [];
  const anchor = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = anchor.exec(text)) !== null) {
    const href = metadata.decodeEntities(m[1]);
    if (isPostLink(href)) found.push({ href, author: null, timestamp: null });
  }
  return found;
}

// ── Public entry point ────────────────────────────────────────────────────────

// Returns { entries, skipped } where each entry is ready for store.add().
// `skipped` counts things that looked like post links but could not be parsed;
// links that were never posts to begin with (profiles, help pages) are simply
// not part of the import and are not reported.
//
// Duplicate shortcodes inside the same file are collapsed here; duplicates
// against the existing library are filtered by the caller.
function parse(text, filename = '') {
  const trimmed = text.replace(/^﻿/, '').trim();

  let raw;
  if (/\.html?$/i.test(filename) || /^<(!doctype|html)/i.test(trimmed)) {
    raw = fromHtml(trimmed);
  } else {
    try {
      raw = fromJson(trimmed);
    } catch {
      // A mislabelled or partial file still usually has the links in it.
      raw = fromHtml(trimmed);
    }
  }

  const entries = [];
  const seen = new Set();
  let skipped = 0;

  for (const row of raw) {
    const parsed = metadata.parseUrl(row.href);
    if (!parsed) { skipped++; continue; }
    if (seen.has(parsed.shortcode)) continue;
    seen.add(parsed.shortcode);

    entries.push({
      url:       parsed.url,
      shortcode: parsed.shortcode,
      kind:      parsed.kind,
      author:    row.author && /^[A-Za-z0-9._]{1,30}$/.test(row.author) ? row.author : null,
      caption:   '',
      savedAt:   row.timestamp ? new Date(row.timestamp * 1000).toISOString() : null,
      source:    'import'
    });
  }

  // Meta lists most-recently-saved first; reverse so that after each entry is
  // unshifted onto the library the newest saves end up on top.
  entries.reverse();

  return { entries, skipped };
}

module.exports = { parse, fixMojibake };
