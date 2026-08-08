// ─────────────────────────────────────────────────────────────────────────────
// Instagram link parsing + best-effort metadata fetching.
//
// Instagram has no public API for saved posts, and its post pages are often
// behind a login wall for logged-out clients. So everything here is BEST
// EFFORT: we try oEmbed (if a token is configured), then Open Graph tags on
// the public page. When both fail the bookmark is still saved — it just shows
// a placeholder, and the caption can be typed in by hand.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const store = require('./store');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MAX_REDIRECTS = 5;
const MAX_HTML      = 4 * 1024 * 1024;   // 4 MB
const MAX_IMAGE     = 8 * 1024 * 1024;   // 8 MB
const TIMEOUT_MS    = 12_000;

// Image bytes are only ever pulled from Instagram's own CDNs.
const IMAGE_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net|instagram\.com)$/i;

// ── URL handling ──────────────────────────────────────────────────────────────

// Anchored: the shortcode is a whole path segment, so trailing segments
// (/liked_by/, /embed/) are fine but stray text cannot be read as a code.
const POST_PATH = /^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)(?:\/.*)?$/;

// What a bare shortcode may look like. Instagram's are 11 characters; the
// range is loose but still strict enough that prose can never qualify.
const BARE_SHORTCODE = /^[A-Za-z0-9_-]{5,30}$/;

// Accepts a bare shortcode, a full URL, or a shared string with surrounding
// text ("Check this out https://instagram.com/p/ABC/ 🔥").
function parseUrl(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;

  const match = text.match(/https?:\/\/[^\s"'<>]+/);
  let raw;

  if (match) {
    raw = match[0];
  } else {
    // No URL in there. Only treat it as a shortcode if it actually looks like
    // one — otherwise arbitrary text would be turned into a bookmark.
    const bare = text.replace(/^\/+|\/+$/g, '');
    if (!BARE_SHORTCODE.test(bare)) return null;
    raw = 'https://www.instagram.com/p/' + bare;
  }

  let url;
  try { url = new URL(raw); } catch { return null; }

  if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return null;

  const parts = url.pathname.match(POST_PATH);
  if (!parts) return null;

  // Canonical path segment vs. the human-readable kind we store.
  const segment   = parts[1] === 'reels' ? 'reel' : parts[1];
  const kind      = segment === 'p' ? 'post' : segment === 'tv' ? 'igtv' : segment;
  const shortcode = parts[2];

  return {
    url: `https://www.instagram.com/${segment}/${shortcode}/`,
    shortcode,
    kind
  };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function get(url, { headers = {}, maxBytes = MAX_HTML, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) return reject(new Error('too many redirects'));

    const req = https.get(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers
      }
    }, res => {
      const { statusCode, headers: h } = res;

      if (statusCode >= 300 && statusCode < 400 && h.location) {
        res.resume();
        const next = new URL(h.location, url).toString();
        return resolve(get(next, { headers, maxBytes, redirects: redirects + 1 }));
      }

      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode}`));
      }

      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          return reject(new Error('response too large'));
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({
        body: Buffer.concat(chunks),
        contentType: h['content-type'] || '',
        finalUrl: url
      }));
    });

    req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error('timed out')); });
    req.on('error', reject);
  });
}

// ── Metadata extraction ───────────────────────────────────────────────────────

function decodeEntities(str) {
  return str
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

function metaTag(html, property) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i');
  const alt = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`, 'i');
  const m = html.match(re) || html.match(alt);
  return m ? decodeEntities(m[1]) : null;
}

// og:title on Instagram looks like:
//   "handle on Instagram: "the caption text""
// og:description is similar with a like/comment count prefix. Peel both apart.
function splitOgTitle(title) {
  if (!title) return { author: null, caption: '' };
  const m = title.match(/^(.+?)\s+on Instagram:\s*["""]?([\s\S]*?)[""»"]?\s*$/);
  if (m) return { author: cleanHandle(m[1]), caption: m[2].trim() };
  return { author: null, caption: title.trim() };
}

function splitOgDescription(desc) {
  if (!desc) return { author: null, caption: '' };
  // e.g. `1,234 likes, 56 comments - handle on March 3, 2024: "caption"`
  const m = desc.match(/-\s*([A-Za-z0-9._]+)\s+on\s+[^:]+:\s*[""""]?([\s\S]*?)[""""]?\s*$/);
  if (m) return { author: cleanHandle(m[1]), caption: m[2].trim() };
  return { author: null, caption: desc.trim() };
}

function cleanHandle(str) {
  if (!str) return null;
  const m = str.match(/\(@([A-Za-z0-9._]+)\)/) || str.match(/@?([A-Za-z0-9._]{1,30})/);
  return m ? m[1].replace(/^@/, '') : null;
}

// ── Fetch strategies ──────────────────────────────────────────────────────────

// Meta's oEmbed endpoint. Requires an app access token; without one we skip it.
async function viaOEmbed(postUrl) {
  const token = process.env.IG_OEMBED_TOKEN;
  if (!token) return null;

  const endpoint = 'https://graph.facebook.com/v19.0/instagram_oembed' +
    `?url=${encodeURIComponent(postUrl)}&omitscript=true&access_token=${encodeURIComponent(token)}`;

  const { body } = await get(endpoint);
  const data = JSON.parse(body.toString('utf8'));
  if (!data || data.error) return null;

  return {
    author:   data.author_name || null,
    caption:  typeof data.title === 'string' ? data.title : '',
    imageUrl: data.thumbnail_url || null
  };
}

// Scrape Open Graph tags off the public post page.
async function viaOpenGraph(postUrl) {
  const { body } = await get(postUrl);
  const html = body.toString('utf8');

  const fromTitle = splitOgTitle(metaTag(html, 'og:title'));
  const fromDesc  = splitOgDescription(metaTag(html, 'og:description'));
  const imageUrl  = metaTag(html, 'og:image');

  const caption = fromTitle.caption || fromDesc.caption || '';
  const author  = fromTitle.author  || fromDesc.author  || null;

  if (!caption && !author && !imageUrl) return null;
  return { author, caption, imageUrl };
}

// ── Thumbnail caching ─────────────────────────────────────────────────────────

// Instagram CDN URLs are signed and expire within days, so hotlinking them
// would leave a library of broken images. Copy the bytes down instead.
async function cacheImage(imageUrl, id) {
  let parsed;
  try { parsed = new URL(imageUrl); } catch { return null; }
  if (parsed.protocol !== 'https:' || !IMAGE_HOSTS.test(parsed.hostname)) return null;

  const { body, contentType } = await get(imageUrl, {
    maxBytes: MAX_IMAGE,
    headers: { Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' }
  });

  if (!/^image\//i.test(contentType)) return null;

  const ext = /webp/i.test(contentType) ? 'webp'
            : /png/i.test(contentType)  ? 'png'
            : /avif/i.test(contentType) ? 'avif'
            : 'jpg';

  const filename = `${id}.${ext}`;
  fs.writeFileSync(path.join(store.MEDIA_DIR, filename), body);
  return filename;
}

// ── Public entry point ────────────────────────────────────────────────────────

// Enrich a stored bookmark in place. Always resolves; failure just marks the
// thumbnail state so the UI can offer a retry.
async function enrich(id) {
  const item = store.find(id);
  if (!item) return null;

  let meta = null;
  const errors = [];

  for (const strategy of [viaOEmbed, viaOpenGraph]) {
    try {
      meta = await strategy(item.url);
      if (meta) break;
    } catch (err) {
      errors.push(`${strategy.name}: ${err.message}`);
    }
  }

  if (!meta) {
    console.warn(`[metadata] ${item.url} → no metadata (${errors.join('; ') || 'no data'})`);
    return store.update(id, { thumbState: 'failed' });
  }

  const patch = {};
  if (meta.author && !item.author)                  patch.author  = meta.author;
  if (meta.caption && !item.caption)                patch.caption = meta.caption;

  if (meta.imageUrl) {
    try {
      const filename = await cacheImage(meta.imageUrl, item.id);
      if (filename) { patch.thumb = filename; patch.thumbState = 'ok'; }
      else            patch.thumbState = 'failed';
    } catch (err) {
      console.warn(`[metadata] ${item.url} → image download failed (${err.message})`);
      patch.thumbState = 'failed';
    }
  } else {
    patch.thumbState = 'failed';
  }

  return store.update(id, patch);
}

module.exports = { parseUrl, enrich, splitOgTitle, splitOgDescription, metaTag, decodeEntities };
