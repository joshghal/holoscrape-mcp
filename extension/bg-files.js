// HoloScrape — service worker: files — naming, typing, sizing, downloading, and the CSV export.
import { resolveXVideo, videoIdFromUrl, looksLikeXVideoAsset } from './x-video-resolve.js';

// --- csv -------------------------------------------------------------------
// Excel decides a file's encoding from the BOM and its delimiter from the first
// line, so both are explicit here: without the BOM, accented product names come
// out as mojibake on a default Windows install.
// A DASH FOR A CELL WITH NOTHING IN IT — in the FILE, not only on screen.
//
// The results window has drawn one since the naming work, but in CSS (`#sheetBody td:empty::before`),
// and the note there explains why it must not be in the DOM: those cells are `contenteditable`, so a
// dash in the markup becomes real content the moment somebody clicks one and types. That argument is
// about the DOM and says nothing about the export, which is written here, once, from the data.
//
// And the export is where it actually matters. On screen an empty cell is obviously empty. In a
// spreadsheet of 56 columns it is indistinguishable from a column that failed to read — the reader
// cannot tell "this business publishes no email" from "the email pass never ran".
//
// The one cost, stated because it is a real change to the file: a cell holding `-` is text, so
// `ISBLANK` and blank-filters in Excel or Sheets no longer match it. Filter on `-` instead.
const CSV_EMPTY = '-';

export function toCsv(rows, cols) {
  const keys = (cols?.length ? cols.map((c) => c.key) : [...new Set(rows.flatMap((r) => Object.keys(r)))]);
  // THE HEADER IS THE COLUMN'S NAME, NOT ITS KEY. A key is a DOM path — `div/div/div 5/div` on a
  // site with hashed classes — and shipping that as a CSV header is the same failure as `Text 6`,
  // only less readable. The results window and its own exports resolve `col.name` first
  // (`headerNames`); this did not, so the two disagreed. Unreachable today (nothing sends
  // `EXPORT_CSV`) and fixed rather than left as a trap for whoever wires it up.
  const heads = (cols?.length ? cols.map((c, i) => c.name || keys[i]) : keys);
  const quote = (s) => (/[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    // Whitespace-only counts as nothing; anything with a character in it is kept exactly as it is,
    // spaces included, because trimming values is not this function's business.
    return quote(s.trim() ? s : CSV_EMPTY);
  };
  // The HEADER never takes a dash. It used to share `cell`, which would have turned an unnamed
  // column into a `-` header — a missing NAME reading as a missing VALUE.
  const head = heads.map((k) => quote(k == null ? '' : String(k))).join(',');
  const body = rows.map((r) => keys.map((k) => cell(r[k])).join(',')).join('\r\n');
  return '﻿' + head + '\r\n' + body + '\r\n';
}

export async function exportCsv({ rows = [], cols = [], url = '' }) {
  if (!rows.length) return { error: 'NO_ROWS' };
  const csv = toCsv(rows, cols);
  const site = clean(siteOf({ url }) || 'page', 40);
  const name = `HoloScrape/${site}/${site}_${stampNow()}_rows.csv`;
  // A data: URL is the only route that works from a service worker — there is no
  // URL.createObjectURL here, and a blob: URL from another context dies with it.
  const b64 = btoa(unescape(encodeURIComponent(csv)));
  const id = await chrome.downloads.download({
    url: `data:text/csv;charset=utf-8;base64,${b64}`,
    filename: name,
    saveAs: false,
  });
  return { id, name, rows: rows.length, bytes: csv.length };
}

// What the server says a URL actually is. The mapping is deliberately narrow:
// anything unrecognised returns null, which means "no opinion", never "not media".
export function mimeKind(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (!m) return null;
  // Manifests are served as audio/* and application/* by different CDNs, so they
  // have to be matched before the family prefixes below.
  if (/mpegurl|dash\+xml|f4m|vnd\.ms-sstr|\+xml$/.test(m) && !/^image\//.test(m)) {
    return /mpegurl|dash\+xml|f4m|vnd\.ms-sstr/.test(m) ? 'stream' : null;
  }
  if (m === 'text/html' || m === 'application/xhtml+xml') return 'page';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m === 'application/pdf') return 'pdf';
  if (m === 'text/vtt' || m === 'application/x-subrip') return 'subtitle';
  return null;
}

const MEDIA_KINDS = new Set(['image', 'audio', 'video', 'stream', 'pdf', 'doc', 'file', 'subtitle']);

// SAVING FILES IS THE PERSON'S DECISION, EVERY TIME, AND AN AGENT CANNOT MAKE IT.
//
// Reading a page an agent was already allowed to read leaves nothing behind. Writing a hundred and
// forty files into somebody's Downloads folder is an effect outside the browser, on a machine, and
// it is the kind of thing a poisoned page would love to talk an unattended agent into. So this is
// not covered by origin consent and there is deliberately no way to pre-authorise it: the request
// goes to the side panel, a person reads what it is about to save and from where, and presses a
// button. No standing grant, no "remember this", no allow-list — one press per batch.
//
// The panel being CLOSED is a refusal, not an error to work around. There is nobody to ask, which
// is exactly the situation the gate exists for, and the refusal says so in words the agent can
// relay rather than retry.
export async function askToSave(detail) {
  let reply;
  try {
    reply = await Promise.race([
      chrome.runtime.sendMessage({ type: 'ASK_SAVE', ...detail }),
      // A person who walks away is a person who did not agree. Two minutes is long enough to read
      // the question and short enough that the agent is not left holding a call forever.
      new Promise((r) => setTimeout(() => r({ timedOut: true }), 120000)),
    ]);
  } catch (_) {
    // `sendMessage` rejects when nothing is listening — the panel is not open.
    return { ok: false, why: 'the HoloScrape side panel is not open, so there is nobody to ask. '
      + 'Saving files needs a person to press a button; ask them to open the panel and call this again.' };
  }
  if (reply?.timedOut) {
    return { ok: false, why: 'the request was shown in the HoloScrape panel and nobody answered it '
      + 'within two minutes. Nothing was saved.' };
  }
  // The panel is open but showing its other face, because the tab in front is one this extension
  // cannot read. Distinct from a decline: nothing was asked, so asking again after the person moves
  // to the page is exactly the right move — which is the opposite of what a decline means.
  if (reply?.unavailable) {
    return { ok: false, why: 'the HoloScrape panel is open but the tab in front of it is not a page '
      + 'this extension can read, so it cannot show the question. Ask the person to switch to the '
      + 'page the files came from, then call this again.' };
  }
  if (!reply?.approved) {
    return { ok: false, declined: true,
      why: 'the person declined. Nothing was saved, and this cannot be retried without them '
        + 'pressing Save — asking again immediately is how a prompt gets clicked without being read.' };
  }
  return { ok: true };
}

// Downloading is the one place where being wrong costs the user a file. An asset
// that answers with HTML is a page — a Vimeo embed, a hotlink-protection notice,
// a login wall — and saving it produces a .bin full of markup that looks like a
// successful download until you open it. Ask first, and say what was skipped.
//
// Probed WITH credentials, unlike the size pass: chrome.downloads sends cookies,
// so an uncredentialed probe would answer a different question than the one that
// matters here.
export async function downloadAll(items) {
  let n = 0;
  const skipped = [];
  let resolvedX = 0;
  // One stamp for the whole batch, so everything taken in one click sorts
  // together instead of straddling a minute boundary halfway down the list.
  const stamp = stampNow();
  for (let it of items) {
    // X'S OWN CAPTURED VIDEO URL OFTEN ISN'T A FILE. `chrome.downloads` carries the person's
    // cookies, which is why the raw `amplify_video/...` url does not fail the way an outside
    // fetch of it would — but a growing share of X's delivery is CMAF/DASH, and the captured
    // asset can be one small `.m4s` timed fragment rather than the whole clip: the download
    // "succeeds" and plays a second or two, which is worse than an honest failure because it
    // looks done. `it.statusId` is attached by `pageScan` (scan.js) by cross-referencing the
    // video's own internal id against its post's permalink — when it's there, ask X's public
    // syndication API for the real, complete, plain mp4 first and fall back to the raw url on
    // any failure (no video found, network error, tweet deleted since scan).
    // `playUrl` was resolved at scan time from the page's own store (see scan.js) — a real
    // mp4 for a captured fragment, free and already in hand. Preferred over the syndication
    // round trip below for the same reason the preview path prefers it: no network, and it
    // works on the fragments the `statusId` cross-reference never matched.
    if (it.type === 'video' && it.playUrl && it.playUrl !== it.url) {
      it = { ...it, url: it.playUrl };
      resolvedX++;
    } else if (it.type === 'video' && it.statusId && looksLikeXVideoAsset(it.url)) {
      try {
        const real = await resolveXVideo(it.statusId, videoIdFromUrl(it.url));
        if (real) { it = { ...it, url: real }; resolvedX++; }
      } catch (_) { /* fall back to the raw url below */ }
    }
    let mime = '';
    if (MEDIA_KINDS.has(it.type) && /^https?:/.test(it.url)) {
      mime = await contentType(it.url);
      if (mimeKind(mime) === 'page') {
        skipped.push({ url: it.url, name: it.name || it.url, reason: 'the server returns a web page, not a file' });
        continue;
      }
    }
    try {
      await chrome.downloads.download({ url: it.url, filename: safeName(it, mime, stamp) });
      n++;
      await new Promise((r) => setTimeout(r, 250)); // stay polite
    } catch (_) {
      skipped.push({ url: it.url, name: it.name || it.url, reason: 'the browser refused the download' });
    }
  }
  return { downloaded: n, skipped, ...(resolvedX ? { resolvedX } : {}) };
}

async function contentType(url) {
  for (const init of [
    { method: 'HEAD', credentials: 'include' },
    // A byte, for the servers that refuse HEAD. Cheap enough to be worth it when
    // the alternative is saving somebody a folder of HTML.
    { method: 'GET', credentials: 'include', headers: { Range: 'bytes=0-0' } },
  ]) {
    try {
      const r = await fetch(url, init);
      const t = r.headers.get('content-type');
      if (t) return t;
    } catch (_) { /* try the next shape */ }
  }
  return '';
}

// Real file sizes.
//
// Resource Timing reports 0 bytes for any cross-origin response without
// Timing-Allow-Origin, which is most files worth taking. The service worker
// holds <all_urls>, and extension-initiated requests are not subject to CORS, so
// it can simply ask the server. A HEAD costs no body.
//
// Never called for tracker rows: a HEAD to a beacon IS the beacon firing, and
// measuring one would be indistinguishable from being tracked.
const sizeCache = new Map();

export async function measure(urls = []) {
  const todo = urls.filter((u) => /^https?:/.test(u) && !sizeCache.has(u)).slice(0, 200);
  const queue = [...todo];
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const url = queue.shift();
      sizeCache.set(url, await probe(url));
    }
  });
  await Promise.all(workers);
  // `kinds` is the derived answer, not the raw header, so the mapping from MIME
  // to type lives in exactly one place and the table cannot drift from it.
  const sizes = {}, kinds = {};
  for (const u of urls) {
    const p = sizeCache.get(u);
    if (!p) continue;
    if (p.bytes) sizes[u] = p.bytes;
    const k = mimeKind(p.mime);
    if (k) kinds[u] = k;
  }
  return { sizes, kinds };
}

// Items typed by assertion — an <img> tag, og:video, a JSON-LD contentUrl —
// carry no extension to check, so the type on screen is only as good as the
// page's own claim about itself. One probe settles it before the row is drawn.
// Cached, because the panel re-scans on a poll and this must not re-fire per tick.
export async function verifyTypes(items = []) {
  const todo = items.filter((i) => (i.tags || []).includes('unverified') && /^https?:/.test(i.url));
  if (!todo.length) return;
  await measure(todo.map((i) => i.url));
  for (const it of todo) {
    const p = sizeCache.get(it.url) || {};
    const kind = mimeKind(p.mime);
    it.tags = it.tags.filter((t) => t !== 'unverified');
    if (p.bytes && !it.bytes) it.bytes = p.bytes;
    if (!kind) { it.tags.push('unconfirmed'); continue; } // server gave no usable answer
    if (kind === 'page') { it.type = 'page'; it.mime = 'text/html'; continue; }
    it.type = kind;
    it.mime = String(p.mime).split(';')[0].trim();
  }
}

async function probe(url) {
  // "bytes 0-0/12345" — the number after the slash is the whole file.
  const totalFromRange = (r) => {
    const cr = r.headers.get('content-range');
    const n = cr ? +String(cr).split('/')[1] : 0;
    return n > 0 ? n : 0;
  };
  let mime = '';
  try {
    const r = await fetch(url, { method: 'HEAD', credentials: 'omit', cache: 'force-cache' });
    mime = r.headers.get('content-type') || '';
    if (r.ok) {
      const len = +r.headers.get('content-length');
      if (len > 0) return { bytes: len, mime };
      const t = totalFromRange(r);
      if (t) return { bytes: t, mime };
    }
  } catch (_) { /* plenty of servers refuse HEAD outright */ }
  try {
    // One byte, purely to read the total out of Content-Range. Content-Length
    // here is 1 — the length of the RANGE, not of the file — so reading it was
    // reporting every image as "1 B".
    const r = await fetch(url, { method: 'GET', credentials: 'omit', headers: { Range: 'bytes=0-0' } });
    mime = r.headers.get('content-type') || mime;
    const t = totalFromRange(r);
    if (t) return { bytes: t, mime };
    // 200 rather than 206 means the server ignored the Range and sent the lot,
    // so its Content-Length really is the file size.
    return { bytes: r.status === 200 ? (+r.headers.get('content-length') || 0) : 0, mime };
  } catch (_) { return { bytes: 0, mime }; }
}

// Every asset column of every table, as files. Named from its own row — the first text
// the row carries — so a downloaded image arrives called "Kertas HVS 75 A4" rather than
// a hashed CDN path.
// A row's asset column says WHERE the file is, never what it is. The column kind comes
// from the attribute name (src/srcset), so a <video src> and an <img src> are both
// "asset" — and typing every one of them as an image made Pexels report 1,740 images and
// 18 videos for a table whose every row carries an .mp4. The extension is the answer the
// URL already gives.
const KIND_BY_EXT = [
  [/\.(mp4|webm|mov|m4v|avi|mkv|ogv)(\?|#|$)/i, 'video'],
  [/\.(mp3|wav|m4a|aac|flac|opus|oga|ogg)(\?|#|$)/i, 'audio'],
  [/\.(pdf|docx?|xlsx?|pptx?|csv|txt|epub|zip)(\?|#|$)/i, 'doc'],
];

export function kindFromUrl(url) {
  for (const [re, kind] of KIND_BY_EXT) if (re.test(url)) return kind;
  // Extensionless media behind a path that names itself — Pexels serves
  // /video-files/<id>/<name>.mp4, but plenty of CDNs drop the suffix entirely.
  if (/\/video[-_/]|\/videos?\//i.test(url) && !/\.(jpe?g|png|webp|gif|avif|svg)(\?|#|$)/i.test(url)) {
    return 'video';
  }
  return 'image';
}

// Extensionless CDN URLs are normal — the server states the format in a header
// instead. Falling back to ".bin" left correct files that no application would
// open, so the header is asked before the placeholder is used.
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/tiff': 'tif',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/webm': 'weba',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
  'application/pdf': 'pdf', 'text/vtt': 'vtt', 'application/zip': 'zip',
};

// Where it came from, when you took it, what it is — in that order, because that
// is the order you look for a file in. Titles repeat across sites ("preview",
// "hero", "cover") and Chrome answers a repeat with "cover (3).jpg", which tells
// you nothing; the site and the stamp make every name stand on its own even after
// the file has been moved out of its folder.
//
// The site is the PAGE's host, not the asset's: files come off CDNs with names
// like elements-resized.envatousercontent.com, which is not where you were.
function siteOf(it) {
  for (const u of [it.page, it.url]) {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) {}
  }
  return 'site';
}

// Local time, not ISO: this names a file on your machine, and 20260728-1432 sorts
// chronologically while staying readable at a glance.
export function stampNow(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

const clean = (s, max) => String(s).replace(/[^\w\d\-. ]+/g, '_').replace(/_{2,}/g, '_').slice(0, max).trim();

export function safeName(it, mime, stamp = stampNow()) {
  const site = clean(siteOf(it), 40);
  const base = clean(it.title || it.name || 'file', 60) || 'file';
  const fromUrl = (it.url.match(/\.([a-z0-9]{2,5})(?:\?|$)/i) || [])[1];
  const ext = fromUrl || MIME_EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || 'bin';
  // A folder per site keeps a 200-file scan navigable; the name repeats the site
  // so a file dragged out of that folder still says where it came from.
  return `HoloScrape/${site}/${site}_${stamp}_${base}.${ext}`;
}
