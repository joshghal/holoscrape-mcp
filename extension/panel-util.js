// Pure helpers for the side panel: DOM lookup, escaping, URL and time formatting. No state, no
// messaging — anything here can be called from any other panel module without a dependency.
const $ = (id) => document.getElementById(id);

// SAME SITE, WHATEVER THE PATH SAYS — see `sync`. A single-page app rewrites its address as
// you use it and Maps rewrites it as the engine works, so path equality answers "has the user
// gone somewhere else" with a no that is wrong on every SPA. Origin answers it.
// Unparseable or missing addresses fall back to string equality, which is strict: a question
// is retracted rather than left hanging over a page nobody can identify.
//
// A DECLARATION, not a const: `init()` is called at the top of this file and `sync()` runs
// inside it, so a `const` here is only defined by the grace of an await landing first.
function sameSite(a, b) {
  if (!a || !b) return a === b;
  try { return new URL(a).origin === new URL(b).origin; } catch (_) { return a === b; }
}

// Loopback, a bracketed IPv6 loopback, or a bare filename — nothing a dictionary of the web
// could ever have an entry for. Used to keep the untested-site card quiet on your own machine.
function isLocalHost(url) {
  if (!url) return true;
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  } catch (_) { return true; }
}

const clock = (secs) =>
  `${Math.floor(secs / 60) ? Math.floor(secs / 60) + 'm ' : ''}${secs % 60}s`;

// A duration to put in a question, rounded the way someone deciding would round it. "About
// 4 minutes" is the answerable version of 234 seconds.
const mins = (secs) => (secs < 90 ? `${Math.max(5, Math.round(secs / 5) * 5)} seconds`
  : `${Math.round(secs / 60)} minute${Math.round(secs / 60) === 1 ? '' : 's'}`);

// WHAT THE PAGE WAS, in the words the user searched with.
//
// A Maps result page carries its query in the path and a dozen parameters after it; a search page
// carries it in `?q=`. Printing the URL instead means the one thing that identifies the run — what
// was asked for — is the one thing missing from the row.
function pageLabel(u) {
  const raw = String(u || '');
  if (raw.startsWith('list:')) return { host: 'pasted list', what: raw.replace('list:', '') };
  try {
    const x = new URL(raw);
    const host = x.hostname.replace(/^www\./, '');
    const nice = (s) => decodeURIComponent(String(s || '').replace(/\+/g, ' ')).trim();
    const maps = /\/maps\/search\/([^/@]+)/.exec(x.pathname);
    if (maps) return { host, what: `maps · ${nice(maps[1])}` };
    if (/\/maps\/place\//.test(x.pathname)) {
      const place = /\/maps\/place\/([^/@]+)/.exec(x.pathname);
      return { host, what: place ? `maps · ${nice(place[1])}` : 'maps' };
    }
    const q = x.searchParams.get('q') || x.searchParams.get('query');
    if (q) return { host, what: `${x.pathname === '/search' ? 'search · ' : ''}${nice(q)}` };
    const path = x.pathname.replace(/\/$/, '');
    return { host, what: path && path !== '' ? path.replace(/^\//, '') : host };
  } catch { return { host: '', what: raw }; }
}

function shortUrl(u) {
  if (String(u).startsWith('list:')) return u.replace('list:', '');
  try {
    const x = new URL(u);
    // A search URL can carry a dozen parameters, and printing all of them turns a
    // sentence into a wall of query string. Enough to recognise it, no more.
    const q = x.search.length > 34 ? x.search.slice(0, 32) + '\u2026' : x.search;
    return x.hostname.replace(/^www\./, '') + x.pathname + q;
  } catch { return u; }
}

// The timeline's own column is narrow by design — the time is a position on a spine, not a
// sentence. "4 min ago" does not fit it and truncates to "4 min a…", which is worse than the
// number alone; a list where every row ends in an ellipsis has told you nothing four times.
function shortAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export { $, esc, sameSite, isLocalHost, clock, mins, pageLabel, shortUrl, shortAgo, ago };
