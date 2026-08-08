// ─────────────────────────────────────────────────────────────────────────────
// Tests — node:test, stdlib only.
//
//   node --test instagram-bookmarks/test.js
//
// Runs against a throwaway data directory so your real library is untouched.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-bookmarks-test-'));
process.env.IG_BOOKMARKS_DATA = SANDBOX;
process.env.PORT = '0';   // let the OS pick a free port

const store    = require('./lib/store');
const metadata = require('./lib/metadata');
const importer = require('./lib/importer');

store.load();

test.after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });

// ── URL parsing ───────────────────────────────────────────────────────────────

test('parseUrl accepts the shapes Instagram links actually arrive in', () => {
  const cases = [
    ['https://www.instagram.com/p/CxAbC123/',              'CxAbC123', 'post'],
    ['https://instagram.com/p/CxAbC123',                   'CxAbC123', 'post'],
    ['http://www.instagram.com/p/CxAbC123/?igshid=abc',    'CxAbC123', 'post'],
    ['https://www.instagram.com/reel/DzQ9xYz/',            'DzQ9xYz',  'reel'],
    ['https://www.instagram.com/reels/DzQ9xYz/',           'DzQ9xYz',  'reel'],
    ['https://www.instagram.com/tv/AbC-9_x/',              'AbC-9_x',  'igtv'],
    ['Look at this https://www.instagram.com/p/CxAbC123/ 🔥', 'CxAbC123', 'post']
  ];

  for (const [input, shortcode, kind] of cases) {
    const parsed = metadata.parseUrl(input);
    assert.ok(parsed, `expected to parse: ${input}`);
    assert.equal(parsed.shortcode, shortcode, input);
    assert.equal(parsed.kind, kind, input);
  }
});

test('parseUrl normalises tracking params and scheme away', () => {
  const a = metadata.parseUrl('https://instagram.com/p/CxAbC123?igshid=1&utm_source=x');
  const b = metadata.parseUrl('https://www.instagram.com/p/CxAbC123/');
  assert.equal(a.url, b.url);
  assert.equal(a.url, 'https://www.instagram.com/p/CxAbC123/');
});

test('parseUrl rejects anything that is not an Instagram post', () => {
  for (const bad of [
    'https://example.com/p/abc',
    'https://www.instagram.com/someuser/',        // a profile, not a post
    'https://evil.com/instagram.com/p/abc',
    'https://www.instagram.com/p/',               // no shortcode at all
    'not a link at all',                          // prose must not become a post
    'hello world',
    'abc',                                        // too short to be a shortcode
    '', null, undefined, 42
  ]) {
    assert.equal(metadata.parseUrl(bad), null, `should reject: ${String(bad)}`);
  }
});

test('parseUrl still accepts a bare shortcode on its own', () => {
  const parsed = metadata.parseUrl('CxAbC123xy');
  assert.equal(parsed.shortcode, 'CxAbC123xy');
  assert.equal(parsed.url, 'https://www.instagram.com/p/CxAbC123xy/');
});

test('parseUrl keeps the shortcode when the link has extra path segments', () => {
  for (const url of [
    'https://www.instagram.com/p/CxAbC123/liked_by/',
    'https://www.instagram.com/p/CxAbC123/embed/'
  ]) {
    assert.equal(metadata.parseUrl(url).shortcode, 'CxAbC123', url);
  }
});

// ── Open Graph parsing ────────────────────────────────────────────────────────

test('og:title splits into author and caption', () => {
  const { author, caption } =
    metadata.splitOgTitle('travelgram on Instagram: "Sunrise over the fjords"');
  assert.equal(author, 'travelgram');
  assert.equal(caption, 'Sunrise over the fjords');
});

test('og:description splits past the like/comment counts', () => {
  const { author, caption } = metadata.splitOgDescription(
    '1,234 likes, 56 comments - chefsteps on March 3, 2024: "Braised short ribs"');
  assert.equal(author, 'chefsteps');
  assert.equal(caption, 'Braised short ribs');
});

test('metaTag reads content before or after the property attribute', () => {
  const html = `
    <meta property="og:image" content="https://scontent.cdninstagram.com/x.jpg">
    <meta content="hello &amp; goodbye" property="og:title">`;
  assert.equal(metadata.metaTag(html, 'og:image'), 'https://scontent.cdninstagram.com/x.jpg');
  assert.equal(metadata.metaTag(html, 'og:title'), 'hello & goodbye');
});

// ── Importer ──────────────────────────────────────────────────────────────────

const DYI_JSON = JSON.stringify({
  saved_saved_media: [
    { title: 'chefsteps', string_map_data: { 'Saved on': {
        href: 'https://www.instagram.com/p/AAA111/', timestamp: 1700000000 } } },
    { title: 'travelgram', string_map_data: { 'Saved on': {
        href: 'https://www.instagram.com/reel/BBB222/', timestamp: 1690000000 } } },
    { title: 'chefsteps', string_map_data: { 'Saved on': {
        href: 'https://www.instagram.com/p/AAA111/', timestamp: 1700000000 } } },
    { title: 'someone', string_map_data: { 'Saved on': {
        href: 'https://www.instagram.com/someuser/', timestamp: 1680000000 } } }
  ]
});

test('importer reads Meta saved_posts.json', () => {
  const { entries, skipped } = importer.parse(DYI_JSON, 'saved_posts.json');

  assert.equal(entries.length, 2, 'two unique posts, the repeat collapsed');
  assert.equal(skipped, 0, 'a profile link was never a post, so nothing failed');

  const codes = entries.map(e => e.shortcode);
  assert.deepEqual(codes.sort(), ['AAA111', 'BBB222']);

  const post = entries.find(e => e.shortcode === 'AAA111');
  assert.equal(post.author, 'chefsteps');
  assert.equal(post.source, 'import');
  assert.equal(post.savedAt, new Date(1700000000 * 1000).toISOString());
});

test('importer reverses so the newest save lands on top after unshifting', () => {
  const { entries } = importer.parse(DYI_JSON, 'saved_posts.json');
  // Meta lists newest first; entries come back oldest first.
  assert.equal(entries[0].shortcode, 'BBB222');   // older (1690000000)
  assert.equal(entries[1].shortcode, 'AAA111');   // newer (1700000000)
});

test('importer reads the HTML export too', () => {
  const html = `<!DOCTYPE html><html><body>
    <div><a href="https://www.instagram.com/p/CCC333/">chefsteps</a></div>
    <div><a href="https://www.instagram.com/reel/DDD444/">x</a></div>
    <div><a href="https://help.instagram.com/">Help</a></div>
  </body></html>`;
  const { entries } = importer.parse(html, 'saved_posts.html');
  assert.deepEqual(entries.map(e => e.shortcode).sort(), ['CCC333', 'DDD444']);
});

test('importer falls back to link scraping when the file is mislabelled', () => {
  const html = '<a href="https://www.instagram.com/p/EEE555/">x</a>';
  const { entries } = importer.parse(html, 'saved_posts.json');   // wrong extension
  assert.equal(entries.length, 1);
  assert.equal(entries[0].shortcode, 'EEE555');
});

test('importer counts links it recognised but could not parse', () => {
  // Looks like a post link, is not on Instagram — exactly what `skipped` is for.
  const sneaky = JSON.stringify({
    items: [
      { href: 'https://evil.example.com/instagram.com/p/BAD123/' },
      { href: 'https://www.instagram.com/p/GOOD01/' }
    ]
  });
  const { entries, skipped } = importer.parse(sneaky, 'saved_posts.json');
  assert.deepEqual(entries.map(e => e.shortcode), ['GOOD01']);
  assert.equal(skipped, 1);
});

test('importer repairs Meta mojibake', () => {
  // Meta escapes each UTF-8 byte separately: "’" (E2 80 99) comes through
  // as the three code points U+00E2 U+0080 U+0099.
  assert.equal(importer.fixMojibake('donât'), 'don’t');
  assert.equal(importer.fixMojibake('plain ascii'), 'plain ascii');
  assert.equal(importer.fixMojibake('already ’ fine'), 'already ’ fine');
});

test('importer survives an unexpected structure', () => {
  const odd = JSON.stringify({ a: { b: [{ c: { url: 'https://www.instagram.com/p/FFF666/' } }] } });
  const { entries } = importer.parse(odd, 'whatever.json');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].shortcode, 'FFF666');
});

// ── Store ─────────────────────────────────────────────────────────────────────

function seed(count) {
  for (const item of store.all().slice()) store.remove(item.id);
  return Array.from({ length: count }, (_, i) =>
    store.add({ url: `https://www.instagram.com/p/S${i}/`, shortcode: `S${i}`, caption: `#${i}` }));
}

test('add puts new bookmarks on top', () => {
  seed(0);
  store.add({ url: 'https://www.instagram.com/p/X1/', shortcode: 'X1' });
  store.add({ url: 'https://www.instagram.com/p/X2/', shortcode: 'X2' });
  assert.deepEqual(store.all().map(i => i.shortcode), ['X2', 'X1']);
});

test('move relocates to an absolute index', () => {
  seed(5);   // stored order is S4 S3 S2 S1 S0
  const order = () => store.all().map(i => i.shortcode);
  assert.deepEqual(order(), ['S4', 'S3', 'S2', 'S1', 'S0']);

  const target = store.all()[0];
  store.move(target.id, 3);
  assert.deepEqual(order(), ['S3', 'S2', 'S1', 'S4', 'S0']);

  store.move(target.id, 0);
  assert.deepEqual(order(), ['S4', 'S3', 'S2', 'S1', 'S0']);
});

test('move clamps out-of-range indexes instead of dropping the item', () => {
  seed(3);
  const first = store.all()[0];
  store.move(first.id, 99);
  assert.equal(store.all().length, 3);
  assert.equal(store.all()[2].id, first.id);

  store.move(first.id, -5);
  assert.equal(store.all()[0].id, first.id);
});

test('reorder keeps ids the client did not know about', () => {
  const [a, b, c] = seed(3);          // list is c b a
  store.reorder([a.id, b.id]);        // a stale client that never saw `c`
  const order = store.all().map(i => i.id);
  assert.equal(order.length, 3, 'nothing is lost');
  assert.deepEqual(order.slice(0, 2), [a.id, b.id]);
  assert.equal(order[2], c.id, 'unknown ids go to the end');
});

test('dim state round-trips through disk', () => {
  const [item] = seed(2);
  store.update(item.id, { dimmed: true });
  store.flush();

  const onDisk = JSON.parse(fs.readFileSync(store.STORE_FILE, 'utf8'));
  const saved = onDisk.items.find(i => i.id === item.id);
  assert.equal(saved.dimmed, true);
});

test('remove deletes the cached thumbnail with the bookmark', () => {
  const [item] = seed(1);
  const thumb = `${item.id}.jpg`;
  fs.writeFileSync(path.join(store.MEDIA_DIR, thumb), 'not really a jpeg');
  store.update(item.id, { thumb, thumbState: 'ok' });

  store.remove(item.id);
  assert.equal(fs.existsSync(path.join(store.MEDIA_DIR, thumb)), false);
});

test('a corrupt library file is parked, not lost', () => {
  store.flush();
  fs.writeFileSync(store.STORE_FILE, '{ this is not json');
  store.load();

  assert.deepEqual(store.all(), []);
  const parked = fs.readdirSync(SANDBOX).filter(f => f.includes('corrupt'));
  assert.ok(parked.length > 0, 'the unreadable file was kept for recovery');
});

// ── HTTP API ──────────────────────────────────────────────────────────────────

test('HTTP API', async t => {
  seed(0);
  const server = require('./server');
  await new Promise(resolve => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  await t.test('rejects a non-Instagram link', async () => {
    const res = await fetch(`${base}/api/bookmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/nope' })
    });
    assert.equal(res.status, 400);
  });

  await t.test('adds, then refuses the same post twice', async () => {
    const add = () => fetch(`${base}/api/bookmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.instagram.com/p/HTTP01/' })
    });

    const first = await add();
    assert.equal(first.status, 202);

    const second = await add();
    assert.equal(second.status, 409);
  });

  await t.test('toggles dim', async () => {
    const { items } = await (await fetch(`${base}/api/bookmarks`)).json();
    const id = items[0].id;

    const res = await fetch(`${base}/api/bookmarks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dimmed: true })
    });
    const { item } = await res.json();
    assert.equal(item.dimmed, true);
  });

  await t.test('ignores fields it does not own', async () => {
    const { items } = await (await fetch(`${base}/api/bookmarks`)).json();
    const id = items[0].id;

    await fetch(`${base}/api/bookmarks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'hacked', url: 'https://evil.com', dimmed: false })
    });

    const after = store.find(id);
    assert.equal(after.id, id);
    assert.ok(after.url.startsWith('https://www.instagram.com/'));
  });

  await t.test('moves a bookmark', async () => {
    seed(4);
    const target = store.all()[0];
    const res = await fetch(`${base}/api/bookmarks/${target.id}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: 2 })
    });
    assert.equal(res.status, 200);
    assert.equal(store.all()[2].id, target.id);
  });

  await t.test('rejects a non-numeric move index', async () => {
    const target = store.all()[0];
    const res = await fetch(`${base}/api/bookmarks/${target.id}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: 'top' })
    });
    assert.equal(res.status, 400);
  });

  await t.test('imports an export file', async () => {
    seed(0);
    const res = await fetch(`${base}/api/import?filename=saved_posts.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: DYI_JSON
    });
    const data = await res.json();
    assert.equal(data.added, 2);
    assert.equal(data.skipped, 0);
    assert.equal(data.items.length, 2);
  });

  await t.test('a second import of the same file adds nothing', async () => {
    const res = await fetch(`${base}/api/import?filename=saved_posts.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: DYI_JSON
    });
    const data = await res.json();
    assert.equal(data.added, 0);
    assert.equal(data.duplicates, 2);
  });

  await t.test('will not serve files outside the media directory', async () => {
    const res = await fetch(`${base}/media/..%2f..%2f..%2fetc%2fpasswd`);
    assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`);
  });

  await t.test('share target bounces the shared link into the UI', async () => {
    const res = await fetch(`${base}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'url=https%3A%2F%2Fwww.instagram.com%2Fp%2FSHARED1%2F',
      redirect: 'manual'
    });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /^\/\?add=/);
  });

  await t.test('serves the app shell', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /<div id="grid"/);
  });
});
