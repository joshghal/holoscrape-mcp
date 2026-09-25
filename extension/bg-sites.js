// HoloScrape — service worker: the third step — the businesses' own websites, read for a contact address.
// The third step's reader. Its own file for the same reason `scan.js` is: it runs inside a page
// and must stay self-contained, and it is the one part of that step worth testing on its own.
import { pageMail } from './mail.js';
// The IANA root zone, passed INTO `pageMail` rather than imported by it — see `tld.js`.
import { TLDS } from './tld.js';
import { DEV } from './env.js';
import { restrictedHost, walking, laneTabs, abandoned, detailRun, detailedAt, sharedHost } from './bg-state.js';
import { note, devLog, saveLog } from './bg-log.js';
import { runRows } from './bg-rows.js';
import { CDP_VERSION, cdp, cdpPrepare, waitForLoad } from './bg-cdp.js';
import { laneTick, laneStopped, lastTables } from './bg-details.js';

// --- the third step: the businesses' own websites --------------------------------------------
//
// The list gives you names, the records give you addresses and phone numbers, and the thing most
// people are doing this for — an address they can write to — is on the business's own site.
// Google never shows it, on the card or on the panel, so it can only come from the site itself.
//
// Built as the SECOND STEP'S TWIN, deliberately: five lanes, a shared queue, batched filing, one
// injection per page. It is the same problem with two differences, and both make it easier:
//
//   nobody is counting     Five Maps place pages a second from one address draws a reCAPTCHA
//                          after a hundred (see `driveDetailsTabs`). Ninety small-business sites
//                          each get ONE visit from one browser. There is no rate to trip.
//   the target is text     A record's photos are data we keep, so the Maps lanes cannot block
//                          images. An email is never in a JPEG we could read, so this pass can —
//                          and on arbitrary sites the imagery is most of the bytes.
//
// What is HARDER is that these are pages nobody has measured. Maps is one site whose markup we
// have taken apart; this is ninety sites built by ninety people. So the reading is done by
// `pageMail` (see `mail.js`), which looks for the five places an address can hide rather than for
// any particular markup, and hands back where to look next when a homepage holds nothing.
const SITE_LANES = 5;

// HOW MANY SITES ARE FETCHED AT ONCE, AND WHY IT IS NOT `SITE_LANES`.
//
// These are two different costs wearing the same word "concurrency". A LANE owns a tab with a
// debugger attached and a renderer behind it, which is why there are five of them. A FETCH owns a
// socket. Folding this into `SITE_LANES` — which reads like a tidy-up and is not — would put the
// sweep back at about 75s and erase the entire change, because business websites are slow and a
// blocked one sits out its whole timeout: stalls are exactly what concurrency hides.
//
// MEASURED on the same 116 sites, highest concurrency first so cache warming favoured the slower
// runs. Yield is emails found, which is the number that decides this:
//
//   116 at once    9.1s    98 answered / 18 failed    82 emails
//    32 at once   10.2s   101 answered / 15 failed    84 emails   <- this
//    12 at once   15.0s   101 answered / 15 failed    84 emails
//
// 32 is 1.48x faster than 12 for an identical result. Going to 116 saves one more second and COSTS
// three sites and two real addresses — saturating the link makes marginal servers time out that
// would otherwise have answered, and that is a lead lost to buy a second. It would be worse on a
// slower connection than the one this was measured on.
const SITE_FETCH_POOL = 32;
// STEP TWO'S EQUIVALENT SWITCH WAS REMOVED — reading a Maps record without opening it turned out
// to have no honest case for turning off, so it is unconditional now (see `laneRecord`). This one
// stays a switch on purpose, for a different reason: not because anyone should choose it, but so
// the two arms of the choice can be MEASURED against each other on one list in one sitting, which
// is the only honest way to say what the change bought. No UI offers it — set `sitesFetch` in
// storage directly to run the comparison. Off means every site is opened, which is exactly what
// step three did before.
let sitesFetch = true;
chrome.storage.local.get('sitesFetch').then((r) => {
  if (r.sitesFetch != null) sitesFetch = !!r.sitesFetch;
}).catch(() => {});
chrome.storage.onChanged.addListener((c) => { if (c.sitesFetch) sitesFetch = !!c.sitesFetch.newValue; });
// ONE FETCH'S PATIENCE. Shorter than the tab budget on purpose: a site that has not answered in
// seven seconds is going to the tab pass anyway, so waiting longer only holds a slot in the sweep
// that another site could be using. The cost of cutting it short is bounded — the tab pass reads
// it properly — while the cost of holding the slot is paid by every site behind it.
const SITE_FETCH_MS = 7000;
// A page bigger than this is not a small-business homepage, it is an application. The address is in
// the head, the footer or a contact link, and reading four megabytes to find it costs the parse
// more than the request. Truncation is safe for what this reads: `pageMail` looks at anchors, JSON-LD
// and text nodes, and a truncated document still parses.
const SITE_FETCH_BYTES = 3_000_000;

// A page load on somebody's WordPress site, not a Maps app boot — so these are much shorter than
// the lane budgets above, and a site that cannot answer in eight seconds is one of ninety.
const SITE_LOAD_MS = 8000;
// The whole errand for one site, homepage and contact page together. Reached only by a site that
// keeps answering slowly; the common case is a footer address on the homepage, about 1.5s.
const SITE_TOTAL_MS = 16000;
// TWO PAGES AFTER THE HOMEPAGE. Measured elsewhere (`MAPS-CHAIN.md`, fetch-only): about half the
// sites publish an address on the homepage and most of the rest have it on a contact page. The
// third page is where the returns stop — an `/about` that did not have it usually means there
// isn't one to find, and a form instead.
const SITE_HOPS = 2;

// THE BYTES AN EMAIL IS NEVER IN. Unlike the Maps lanes — where blocking is off because a
// record's photo URLs are part of what the pass collects — nothing here is lost by refusing an
// image: `pageMail` reads text nodes, anchors and JSON. On a small-business homepage the hero
// image and the webfonts are routinely 80% of the transfer.
const SITE_BLOCKED = [
  '*.jpg*', '*.jpeg*', '*.png*', '*.gif*', '*.webp*', '*.avif*', '*.bmp*', '*.ico*',
  '*.woff*', '*.woff2*', '*.ttf*', '*.otf*', '*.eot*',
  '*.mp4*', '*.webm*', '*.mov*', '*.m4v*', '*.mp3*', '*.wav*',
  '*fonts.gstatic.com/*', '*googletagmanager.com/*', '*google-analytics.com/*',
  '*doubleclick.net/*', '*connect.facebook.net/*', '*hotjar.com/*', '*.hotjar.io/*',
];

// ENOUGH TEXT TO COUNT AS A PAGE THAT WAS READ. This decides whether a site with no address is
// recorded as answered — which means never visited again — or left for the next press to retry, so
// the two errors are not symmetrical: too high costs a few repeated page loads, too low silently
// hides a business forever. Biased low for that reason, and only reached at all once `dead` has
// ruled out an error page, which is the precise instrument for the case this used to guess at.
const SITE_MIN_TEXT = 200;

// A URL that would DOWNLOAD instead of rendering. Navigating a tab to a PDF is a file in the
// user's Downloads folder they did not ask for, times ninety.
const SITE_FILE = /\.(pdf|zip|rar|7z|tar|gz|dmg|exe|msi|apk|docx?|xlsx?|pptx?|csv|mp4|mp3)(\?|#|$)/i;

// --- reading a site without opening it ----------------------------------------------------------
//
// The worker fetches; the offscreen document parses. See `offscreen.html` for why the parse cannot
// happen here — an MV3 service worker has no DOM and therefore no `DOMParser` — and `mail.js` for
// why the answer is a second WAY IN to one reader rather than a second reader.
//
// The port is opened by the offscreen document as soon as it loads and is held for the whole pass.
let mailPort = null;
let mailOpen = null;                 // resolves when the document has connected
const mailJobs = new Map();          // id -> resolve
let mailSeq = 0;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'hs-mail') return;
  mailPort = port;
  port.onMessage.addListener((msg) => {
    if (!msg || msg.dg !== 'read') return;
    const done = mailJobs.get(msg.id);
    if (!done) return;
    mailJobs.delete(msg.id);
    done(msg);
  });
  port.onDisconnect.addListener(() => {
    mailPort = null;
    // Everything still in flight will never be answered. Failing them is what lets those sites fall
    // through to the tab pass instead of hanging the sweep on a document that has gone away.
    for (const [id, done] of mailJobs) { mailJobs.delete(id); done({ out: null, why: 'parser closed' }); }
  });
  if (mailOpen) { const go = mailOpen; mailOpen = null; go(); }
});

async function mailStart() {
  if (mailPort) return true;
  if (!chrome.offscreen?.createDocument) return false;   // Chrome older than 109
  try {
    // `hasDocument` rather than remembering: the worker is evicted and respawned constantly, and a
    // second `createDocument` on a document that is already there throws.
    const has = await chrome.offscreen.hasDocument?.();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: 'Parsing the HTML of a business website that was fetched rather than opened, '
          + 'so most rows never need a tab.',
      });
    }
  } catch (e) {
    // Already open is not a failure — two passes can race here.
    if (!/single offscreen|already/i.test(e.message || '')) {
      note('sites.noParser', { why: (e.message || '').slice(0, 80) });
      return false;
    }
  }
  if (mailPort) return true;
  // The document loads, then connects. Bounded, because a parser that never arrives must degrade to
  // the tab pass rather than stop the run.
  const ok = await new Promise((r) => {
    const t = setTimeout(() => { mailOpen = null; r(false); }, 4000);
    mailOpen = () => { clearTimeout(t); r(true); };
  });
  if (!ok) note('sites.noParser', { why: 'the parser did not connect' });
  return ok;
}

async function mailStop() {
  mailPort = null;
  try { if (await chrome.offscreen?.hasDocument?.()) await chrome.offscreen.closeDocument(); }
  catch (_) {}
}

// One body, read. Returns exactly what `pageMail` returns from a tab, or null.
function readHtml(url, html) {
  if (!mailPort) return Promise.resolve(null);
  const id = ++mailSeq;
  return new Promise((done) => {
    mailJobs.set(id, (msg) => done(msg?.out || null));
    try { mailPort.postMessage({ dg: 'read', id, url, html }); }
    catch (_) { mailJobs.delete(id); done(null); }
    // A parse should take milliseconds. This is only here so one pathological document cannot hold
    // a slot in the sweep forever.
    setTimeout(() => { if (mailJobs.delete(id)) done(null); }, 8000);
  });
}

// ONE SITE, BY FETCH, INCLUDING ITS CONTACT PAGE.
//
// The same errand as `siteRead` and deliberately the same shape: read the homepage, and if it holds
// no address follow the contact link the page itself names. The hop is kept because it is where
// about half the addresses are, and dropping it would trade the whole point of the pass for a
// second of wall clock.
//
// WHAT IT CANNOT DO is run the site's JavaScript, so a page that assembles its address in the
// browser comes back with nothing. That is not a failure to correct here — it is precisely the
// case the tab pass exists for, and a site with no address is sent there by definition.
async function siteFetch(url, t0) {
  const left = () => SITE_TOTAL_MS - (Date.now() - t0);
  const tried = new Set();
  let at = url;
  let best = null;
  let bestPage = '';
  let first = null;
  let seen = 0;
  let text = 0;
  let status = 0;
  let why = '';
  const others = new Map();
  for (let hop = 0; hop <= SITE_HOPS; hop++) {
    if (!at || tried.has(at) || left() < 800) break;
    tried.add(at);
    const ctl = new AbortController();
    const cut = setTimeout(() => ctl.abort(), Math.min(SITE_FETCH_MS, Math.max(1200, left())));
    let html = '';
    try {
      // NO CREDENTIALS. `laneRecord` sends them because it is reading the user's own Google session;
      // there is no reason to hand a stranger's website the browser's cookies, and every reason not
      // to. `redirect: follow` is the default and is wanted — a business's site is frequently a
      // redirect to the host that actually serves it.
      const res = await fetch(at, { credentials: 'omit', redirect: 'follow', signal: ctl.signal });
      status = res.status;
      if (!res.ok) { why = `HTTP ${res.status}`; break; }
      // NOT A DOCUMENT, so there is nothing here to read and nothing to be gained by reading it as
      // if there were. A PDF or an image would otherwise be handed to the parser as text.
      const type = (res.headers.get('content-type') || '').toLowerCase();
      if (type && !/text\/html|application\/xhtml|text\/plain|^$/.test(type)) {
        why = `not a page (${type.split(';')[0]})`; break;
      }
      html = await res.text();
      if (html.length > SITE_FETCH_BYTES) html = html.slice(0, SITE_FETCH_BYTES);
    } catch (e) {
      why = ctl.signal.aborted ? 'timed out' : (e.message || 'no answer').slice(0, 60);
      break;
    } finally { clearTimeout(cut); }
    const r = await readHtml(at, html);
    if (!r) { why = why || 'not parsed'; break; }
    if (!first) first = r;
    seen++;
    text += r.len || 0;
    for (const e of r.emails || []) {
      if (!best || e.score > best.score) { best = e; bestPage = r.href || at; }
      else if (e.v !== best.v) others.set(e.v, true);
    }
    if (best) break;
    // SAME HOST ONLY, and that is `pageMail`'s rule rather than one imposed here — `follow` is
    // already filtered to the site's own domain, which is what keeps one errand from becoming four.
    at = (r.follow || []).find((u) => !tried.has(u)) || '';
  }
  return { best, page: bestPage, others: [...others.keys()], seen, text, status, why,
    ms: Date.now() - t0, said: first, viaFetch: true };
}

// ONE SITE, IN ONE TAB, INCLUDING ITS CONTACT PAGE.
//
// Returns what was found and what it cost. `page` is the URL the address was actually on, which
// is not the URL we were given whenever the homepage sent us on — worth carrying, because "found
// on /contact-us" is the difference between a table someone trusts and one they spot-check.
// `prevHost` is THE LAST SITE THIS LANE ACTUALLY READ, and it is the whole of the stale-page fix
// below. See the note by the `settled` loop.
export async function siteRead(tabId, url, t0, prevHost = '') {
  const left = () => SITE_TOTAL_MS - (Date.now() - t0);
  const hostOfUrl = (u) => { try { return new URL(u).host.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
  let stale = 0;
  let at = url;
  let seen = 0;             // pages actually read
  let text = 0;             // characters of readable text, summed — a parked domain has none
  const tried = new Set();
  let best = null;
  let bestPage = '';
  let first = null;         // what the HOMEPAGE said — see the return
  const others = new Map();
  for (let hop = 0; hop <= SITE_HOPS; hop++) {
    if (!at || tried.has(at) || left() < 1500) break;
    tried.add(at);
    const hopAt = Date.now();
    try { await chrome.tabs.update(tabId, { url: at }); } catch (e) { break; }
    await waitForLoad(tabId, Math.min(SITE_LOAD_MS, Math.max(1200, left())), 250);
    // ISOLATED, not MAIN, and on purpose: this reads the DOM and nothing else, so there is no
    // reason to share a world with the JavaScript of a site nobody has vetted. `allFrames`
    // because a contact form — and the address beside it — is often in an iframe.
    // BOUNDED, because `executeScript` is not. Every other wait in this function has a ceiling and
    // this one had none: a page that never lets the injection settle — a modal, a frame that will
    // not finish, a renderer in trouble — would hold its lane open forever, and the pass is a
    // `Promise.all` over five lanes, so one stuck site stops the whole thing with no message. An
    // empty answer is read as "no page here", which is the right conclusion for such a site.
    let frames = [];
    try {
      frames = await Promise.race([
        chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: pageMail,
          // `null` and `''` mean "this page": in a tab the reader takes the live document and its
          // own URL. Only the TLD list has to be carried in, because the function is serialised to
          // source and can close over nothing.
          args: [null, '', TLDS] }),
        new Promise((r) => setTimeout(() => r([]), Math.max(2000, Math.min(6000, left())))),
      ]);
    } catch (e) { break; }
    const top = frames.find((f) => f.frameId === 0)?.result || null;
    // THE PAGE WE READ MUST BE THE PAGE WE ASKED FOR — and until this check existed it sometimes
    // was not, so one business's contact details were exported under another business's name.
    //
    // Measured, `plumber in bandung`, 42 sites. Two rows carried an email from a domain with
    // nothing to do with their own website, and a third carried another company's social links:
    //
    //   lane 1   quickrooterbandung.com  then  bandungrooter.com     both -> info@quickrooterbandung.com
    //   lane 2   allir.id                then  gelarborbandung…      both -> admin@allir.id
    //                                                                and both -> GTM/GA/Meta/TikTok
    //   lane 3   mitra10.com             then  gelora-gir.com        mitra10's linkedin/fb/ig/tiktok
    //
    // Every one of them is the SAME LANE, consecutively. Across all 190 pairs of reads that
    // produced an email, exactly 2 pairs shared one, and both were same-lane-consecutive — if the
    // sharing were coincidence that would be about one in twenty.
    //
    // The cause is that `waitForLoad` can answer about the document already standing in the tab.
    // It has just finished loading — the lane read it a moment ago — so it is `complete`, the wait
    // returns at once, and `executeScript` runs against the PREVIOUS site.
    //
    // The test is deliberately narrow: not "does the loaded host match the requested host", which
    // would reject every legitimate cross-domain redirect (AZKO's website really is ruparupa.com),
    // but "is this specifically the page this lane read last". That has no false positives, and it
    // is the only case the measurement shows.
    if (top && prevHost && !stale) {
      const now = hostOfUrl(top.href);
      if (now && now === prevHost && now !== hostOfUrl(at)) {
        stale = 1;
        note('sites.stale', { want: hostOfUrl(at), saw: now,
          why: 'the lane was still showing the previous site — waiting and reading again' });
        await waitForLoad(tabId, Math.min(SITE_LOAD_MS, Math.max(1500, left())), 250);
        hop--;                 // this hop did not happen; do it again against the right document
        tried.delete(at);
        continue;
      }
    }
    // THE OTHER HALF OF THE SAME FAULT, and it costs data rather than corrupting it.
    //
    // Reading a tab that has not navigated yet does not always return the previous page — often it
    // returns nothing, and nothing is filed as `no answer`, which is a claim that the BUSINESS'S
    // WEBSITE IS DOWN. Measured on the same run, 12 sites were called `no answer` and three of
    // them gave up in under a second and a half:
    //
    //   blipompa.co.id             523ms   lane 0, straight after ruparupa.com
    //   jasapipabocorbandung.com   899ms   lane 3, straight after nusakaryasipil.com
    //   putraanugrah.com          1038ms   lane 4, straight after tokopedia.com
    //
    // All three followed another read in their own lane. A refused connection really is that
    // fast, so the timing alone cannot separate the two — but a real host does not answer in
    // 523ms with a document that has no top frame at all. Asking twice costs one wait on a
    // genuinely dead host and rescues a live one, so it is asked twice.
    if ((!top || top.dead) && Date.now() - hopAt < 3000 && stale < 2 && left() > 2500) {
      stale++;
      note('sites.tooFast', { host: hostOfUrl(at), ms: Date.now() - hopAt,
        why: 'nothing came back faster than a page can load — waiting and reading again' });
      await waitForLoad(tabId, Math.min(SITE_LOAD_MS, Math.max(1500, left())), 250);
      hop--;
      tried.delete(at);
      continue;
    }
    // Not a page. See `dead` in `mail.js`: an error page reads as a site that publishes nothing,
    // and that difference is whether pressing again retries this host or skips it forever.
    if (!top || top.dead) break;
    if (!first) first = top;
    seen++;
    for (const f of frames) {
      const r = f?.result;
      if (!r) continue;
      text += r.len || 0;
      for (const e of r.emails || []) {
        if (!best || e.score > best.score) { best = e; bestPage = r.href || at; }
        else if (e.v !== best.v) others.set(e.v, true);
      }
    }
    if (best) break;
    // Nothing here. The page itself says where its contact details live — a guess at `/contact`
    // is wrong on every site whose page is `/contact-us`, `/kontakt` or `/pages/contact`.
    at = (top?.follow || []).find((u) => !tried.has(u)) || '';
  }
  return { best, page: bestPage, others: [...others.keys()], seen, text, ms: Date.now() - t0,
    // WHAT THE SITE SAID ABOUT ITSELF, taken from the FIRST page read rather than the last. The
    // homepage is where a business states its platform, its phone and its social links; a contact
    // page reached on a hop is a thinner document and would overwrite good answers with blanks.
    said: first };
}

export async function driveSites(listTab, { limit = 0, lanes = 0 } = {}) {
  const found = await runRows(listTab, { action: 'slinks' });
  if (found?.error) return { ...found, opened: 0, filled: 0 };
  const all = (found.links || []).filter((l) => !restrictedHost(l.url) && !SITE_FILE.test(l.url));
  const queue = limit > 0 ? all.slice(0, limit) : all;
  const total = queue.length;
  lanes = Math.max(1, Math.min(lanes > 0 ? lanes : SITE_LANES, total));
  note('sites.start', { rows: found.rows, sites: total, places: found.places,
    noSite: found.none, already: found.already, refused: (found.links || []).length - all.length,
    lanes });
  if (!total) {
    return { opened: 0, filled: 0, lost: 0, sites: 0, places: 0,
      noSite: found.none || 0, already: found.already || 0,
      why: found.already ? '' : 'none of these rows list a website',
      ...(await lastTables(listTab)) };
  }

  let opened = 0; let filled = 0; let lost = 0; let places = 0; let notMine = 0;
  let sharePer = '';
  const FILE_EVERY = 8;
  const SAVE_EVERY = 24;
  const pending = [];
  let sinceSave = 0;
  // MERGED, NOT SET — see `dputMany`. These records were already read by the second step, and a
  // plain write would replace an address, hours and coordinates with an email.
  const flush = async (force = false) => {
    if (pending.length) {
      const items = pending.splice(0, pending.length);
      const put = await runRows(listTab, { action: 'dputMany', items, merge: true }).catch(() => null);
      const landed = put?.got ?? 0;
      if (landed < items.length) {
        note('sites.notFiled', { short: items.length - landed,
          why: put?.error || 'the list would not take them' });
      }
      sinceSave += items.length;
    }
    if (sinceSave >= SAVE_EVERY || (force && sinceSave)) {
      sinceSave = 0;
      await runRows(listTab, { action: 'dtables' }).catch(() => {});
    }
  };

  walking.add(listTab);
  abandoned.delete(listTab);
  detailRun.set(listTab, { running: true, at: Date.now(), total, opened: 0, filled: 0, sites: true });

  // ONE PLACE THAT DECIDES WHAT A SITE'S ANSWER MEANS, because there are now two ways of getting
  // one. Everything below used to sit inside the lane loop, where it could only ever be reached by
  // a tab; a fetched site has to be filed by exactly the same rules or the two paths produce
  // different tables from the same page, which is the failure this whole change must not introduce.
  //
  // Returns what happened, so the caller can count it: `filled` an address, `read` the site and it
  // publishes none, `lost` no answer at all, `shared` somebody else's page.
  const fileOne = (link, r) => {
    const got = {};
    // APPENDED, not added beside — see `dputMany`'s `add`. Each of these is a fact the table
    // already has a column for, so a second column would be the same information twice.
    const add = {};
    // WHAT THE SITE IS, WHICH IS TRUE OF EVERY SITE. This is the field that makes the visit
    // always worth making: an email is on about half of them, and this is on all of them —
    // including the ones that refuse, where "no answer" about a business's own website is itself
    // a fact worth exporting.
    //
    // ALL OF IT SURVIVES THE FETCH, and that had to be checked rather than assumed: `platform`,
    // `year` and `pixels` are read off the `generator` meta and the `src` attributes of scripts
    // and links, which are in the served HTML — they were never a property of the page having
    // been rendered. A pass that got faster by silently dropping three columns would be a
    // regression, so `test/site-mail.mjs` asserts them on the fetch path specifically.
    const said = r.said || null;
    // WAS THERE A SITE HERE — and this is asked of the CONTENT, not of a character count.
    //
    // The count was standing in for the question while there was nothing better to ask. Now
    // there is: a page that gave up a platform, a phone, a social page or an address was
    // unambiguously a page, whatever its length.
    //
    // `thin` now means what it says: it answered, and there was nothing on it. A parked domain, a
    // holding page, a splash screen. That distinction is the one the reader needs, and it is
    // also what decides whether a second press visits this host again.
    const anything = !!(r.best || said?.platform || said?.year || said?.phones?.length
      || said?.social?.length || said?.services?.length);
    const read = r.seen && (anything || r.text > SITE_MIN_TEXT);
    // `@Site` DROPPED on request. `read` is still computed — it decides whether an empty
    // `@Email` means "read, publishes nothing" or "never answered", and whether a second press
    // revisits this host.
    void read;

    if (said?.platform) got['@Platform'] = said.platform;
    if (said?.year) got['@Site year'] = String(said.year);
    if (said?.pixels?.length) got['@Tracking'] = said.pixels.join(', ');
    // The number a human answers is often not the one on Maps, so it goes INTO the phone column
    // and the dedupe decides whether it was new.
    if (said?.phones?.length) add['@Phone (intl)'] = said.phones;
    // `@Web links` DROPPED on request — the site's social pages no longer get a column.
    // ITS OWN COLUMN, AND THIS IS THE ROOT OF THE POLLUTION rather than the filter upstream.
    // What a site says it does is NOT what Maps calls it, and merging them destroys the one fact
    // that was reliable — measured on `plumber in bandung`, where `Saluran Mampet` came back with
    // its real Maps category replaced by its own navigation.
    if (said?.services?.length) add['@Services'] = said.services;
    let how = 'lost';
    if (r.best) {
      got['@Email'] = r.best.v;
      // `@Email found` DROPPED on request. `via`, `whose` and `where` are no longer surfaced.
      if (r.others.length) got['@Emails'] = r.others.slice(0, 4).join(' | ');
      how = 'filled';
    } else if (read) {
      // READ, AND IT LISTS NO ADDRESS — which is an answer, not a failure. Plenty of sites
      // publish a contact FORM and nothing else. Filed as blank so the column says so, and
      // so a second press does not spend another visit rediscovering it (see `slinks`).
      got['@Email'] = '';
      how = 'read';
    }
    if (Object.keys(got).length || Object.keys(add).length) {
      for (const key of link.keys) pending.push({ key, got, add });
    }
    return how;
  };

  // WHAT THE TAB FOUND, OVER WHAT THE FETCH FOUND, FIELD BY FIELD — never one result replacing the
  // other. Both halves of that matter and each has a real case behind it:
  //
  //   a site behind a bot wall answers 403 to the fetch and opens perfectly in a tab, so the tab
  //   must win where it has anything;
  //   a site that answered 200 with its platform, year and tracking in the HTML and then TIMED OUT
  //   in a tab must not have those three columns wiped by the retry that was only ever there to
  //   look for an address.
  //
  // Taking whichever result is "better" as a whole gets the second case wrong, and it is the more
  // common one.
  const merge = (fetched, tabbed) => {
    if (!fetched) return tabbed;
    if (!tabbed) return fetched;
    const a = tabbed.said || null;
    const b = fetched.said || null;
    const pick = (k) => (a && a[k] && (!Array.isArray(a[k]) || a[k].length) ? a[k] : (b ? b[k] : undefined));
    return {
      ...fetched, ...tabbed,
      best: tabbed.best || fetched.best,
      page: tabbed.best ? tabbed.page : fetched.page,
      others: tabbed.best ? tabbed.others : fetched.others,
      seen: (fetched.seen || 0) + (tabbed.seen || 0),
      text: Math.max(fetched.text || 0, tabbed.text || 0),
      said: (a || b) ? { ...(b || {}), ...(a || {}),
        platform: pick('platform') || '', year: pick('year') || 0,
        pixels: pick('pixels') || [], phones: pick('phones') || [],
        social: pick('social') || [], services: pick('services') || [],
        follow: pick('follow') || [] } : null,
    };
  };

  const tabs = [];
  const targets = [];
  laneTabs.set(listTab, { tabs, targets });
  // LANES ARE OPENED WHEN ONE IS NEEDED, NOT WHEN THE PASS STARTS. On a list where every site
  // answers by fetch this now opens NO tabs at all — which is not just tidiness: five tabs with
  // `chrome.debugger` attached means five yellow "HoloScrape is debugging this browser" banners for a
  // pass that never looked at a page. Step two has the same latent waste and is left alone here:
  // on the user's last run 119 of 120 records were answered by fetch and its five lanes sat open
  // and idle throughout.
  const openLane = async () => {
    const t = await chrome.tabs.create({ url: 'about:blank', active: false });
    tabs.push(t.id);
    try {
      await chrome.debugger.attach({ tabId: t.id }, CDP_VERSION);
      const target = { tabId: t.id };
      // The same preparation the record lanes get, for the same reason and one more. A tab in
      // the background runs no animation frames at all (see `keepFrames` in rows.js), and a
      // great many small-business sites are built on frameworks that mount their content from
      // one — so without this a Wix or React site answers with an empty page and the email it
      // does publish reads as "no address on this site".
      await cdpPrepare(target);
      await cdp(target, 'Network.enable').catch(() => {});
      await cdp(target, 'Network.setBlockedURLs', { urls: SITE_BLOCKED }).catch(() => {});
      targets.push(target);
    } catch (e) {
      note('sites.noDebugger', { why: e.message });
      targets.push(null);
    }
    return t.id;
  };

  let byFetch = 0;   // sites answered with an address without opening anything
  let byTab = 0;     // sites that had to be opened
  let noParse = 0;   // sites the fetch could not even attempt
  try {
    // --- stage one: fetch every site -----------------------------------------------------------
    //
    // "curl all first, then open one by one, only open item which have no email". Every site is
    // fetched; only the ones that come back without an address go on to stage two. A row whose
    // fetch found an address is never opened at all, which is where most of the saving is.
    //
    // MEASURED on 116 sites: the sweep answers 62 of them and takes ~10s at 32 concurrent, against
    // ~80s for opening all 116 in five lanes. It is also ADDITIVE rather than merely faster — 12
    // addresses that the tab pass never found are plainly present as `mailto:` links in the served
    // HTML, so this recovers real leads as well as time.
    const leftovers = [];
    const fetched = new Map();          // link -> what the sweep found
    const t1 = Date.now();
    const parser = sitesFetch && await mailStart();
    if (!parser) {
      note('sites.fetchSkipped', { why: sitesFetch ? 'no parser — every site will be opened'
        : 'fetch-first is switched off — every site will be opened' });
    }
    if (parser) {
      let cursor = 0;
      const pool = Math.max(1, Math.min(SITE_FETCH_POOL, total));
      await Promise.all(Array.from({ length: pool }, async () => {
        for (;;) {
          if (abandoned.has(listTab)) return;
          if (cursor >= queue.length) return;
          const link = queue[cursor++];
          // REFUSED BEFORE THE REQUEST, not after it. Nothing on a link-in-bio, a WhatsApp deep
          // link or a marketplace storefront belongs to this business (see `SHARED_HOSTS`), so the
          // page cannot be attributed however it reads — and fetching it only to throw the answer
          // away costs a request and a timeout slot for a result that is blank by construction.
          if (sharedHost(link.url)) {
            notMine++;
            note('site.shared', { i: link.i, host: link.host,
              why: 'shared or platform host — nothing on it could belong to this business' });
            // Blank, not absent: `@Email` empty means "looked, nothing attributable", which is what
            // stops a second press paying for the same page again.
            for (const key of link.keys) pending.push({ key, got: { '@Email': '' }, add: {} });
            opened++;
            if (pending.length >= FILE_EVERY) await flush();
            await laneTick(listTab, { at: opened, of: total, opened, filled, lost, lanes });
            continue;
          }
          const r = await siteFetch(link.url, Date.now())
            .catch((e) => ({ best: null, seen: 0, text: 0, why: e.message, viaFetch: true }));
          note('site.fetch', { i: link.i, host: link.host, ms: r.ms, status: r.status || 0,
            pages: r.seen, email: r.best?.v || '', platform: r.said?.platform || '',
            why: r.why || (r.best ? '' : 'no address in the served HTML') });
          if (r.best) {
            // Answered. This row is finished and no tab will ever be opened for it.
            const how = fileOne(link, r);
            byFetch++;
            opened++;
            if (how === 'filled') { filled++; places += link.keys.length; }
            if (pending.length >= FILE_EVERY) await flush();
            await laneTick(listTab, { at: opened, of: total, opened, filled, lost, lanes });
          } else {
            // No address. Held — NOT filed — until the tab pass has had its turn, so the two
            // answers are merged once instead of appending the site's phones and services twice.
            fetched.set(link, r);
            leftovers.push(link);
          }
          detailRun.set(listTab, { ...detailRun.get(listTab), running: true, total, opened, filled });
        }
      }));
    } else {
      noParse = total;
      for (const link of queue) leftovers.push(link);
    }
    note('sites.swept', { sites: total, ms: Date.now() - t1, pool: SITE_FETCH_POOL,
      answered: byFetch, toOpen: leftovers.length, refused: notMine });

    // --- stage two: open only what the fetch could not answer -----------------------------------
    //
    // A SHARED QUEUE, NOT SLICES DEALT OUT IN ADVANCE — and this was a measured waste.
    //
    // Dealing the work out up front means each lane owns a fixed fifth of it, so the run ends at the
    // speed of the unluckiest lane. From a real run of 103 sites: the last 47 seconds had exactly one
    // lane working because its slice happened to hold several dead hosts at 13-14s of timeout each,
    // while four idle tabs sat next to it. One cursor, and a lane takes the next thing whenever it
    // is free. The tail then costs one slow item instead of one slow fifth.
    lanes = Math.max(1, Math.min(lanes > 0 ? lanes : SITE_LANES, leftovers.length));
    const per = [];
    if (leftovers.length && !abandoned.has(listTab) && !(await laneStopped(listTab))) {
      note('sites.open', { sites: leftovers.length, lanes,
        why: 'these answered the fetch with no address' });
      let cursor = 0;
      const lastHost = [];
      for (let i = 0; i < lanes; i++) { per.push(0); lastHost.push(''); }
      await Promise.all(Array.from({ length: lanes }, async (_x, li) => {
        let tid = null;
        for (;;) {
          if (abandoned.has(listTab)) return;
          if (await laneStopped(listTab)) return;
          if (cursor >= leftovers.length) return;
          const link = leftovers[cursor++];
          // The tab is created on the first item this lane actually gets, so a sweep that left
          // three sites opens three lanes and not five.
          if (tid == null) tid = await openLane();
          per[li]++;
          // WHAT THIS LANE READ LAST, carried into the next read so it can recognise its own stale
          // page. See the note in `siteRead` — without it the lane exported one business's email
          // under another business's name, three times in forty-two sites.
          const t = await siteRead(tid, link.url, Date.now(), lastHost[li])
            .catch((e) => ({ best: null, seen: 0, text: 0, why: e.message }));
          try { lastHost[li] = new URL(link.url).host.replace(/^www\./, '').toLowerCase(); }
          catch (_) { lastHost[li] = ''; }
          const r = merge(fetched.get(link), t);
          byTab++;
          opened++;
          const how = fileOne(link, r);
          if (how === 'filled') { filled++; places += link.keys.length; }
          else if (how === 'lost') lost++;
          if (pending.length >= FILE_EVERY) await flush();
          await laneTick(listTab, { at: opened, of: total, opened, filled, lost, lanes });
          note('site', { i: link.i, lane: li, host: link.host, ms: t.ms, pages: r.seen,
            email: r.best?.v || '', via: r.best?.via || '', whose: r.best?.whose || '',
            // The yield question, per site, so one real run answers it: how often is each of these
            // actually there, and how much of it was NEW rather than a repeat of what Maps gave.
            platform: r.said?.platform || '', year: r.said?.year || 0,
            phones: r.said?.phones?.length || 0, social: r.said?.social?.length || 0,
            services: r.said?.services?.length || 0, tracking: (r.said?.pixels || []).join('/'),
            rows: link.keys.length,
            why: t.why || (r.best ? '' : !r.seen ? 'no answer' : how === 'read' ? 'no address on the site' : 'thin') });
          detailRun.set(listTab, { ...detailRun.get(listTab), running: true, total, opened, filled });
        }
      }));
    } else if (leftovers.length) {
      // Stopped before the tab pass could start. What the fetch did learn about these sites is
      // still worth filing — the platform, the year and the tracking stack are on the row whether
      // or not anybody ever opened it.
      for (const link of leftovers) {
        const how = fileOne(link, fetched.get(link) || { best: null, seen: 0, text: 0 });
        if (how === 'lost') lost++;
      }
    }
    await flush(true);
    sharePer = per.join('/');
  } finally {
    await flush(true).catch(() => {});
    await mailStop();
    laneTabs.delete(listTab);
    for (const t of targets) if (t) await chrome.debugger.detach(t).catch(() => {});
    for (const tid of tabs) await chrome.tabs.remove(tid).catch(() => {});
    detailedAt.set(listTab, Date.now());
    walking.delete(listTab);
  }
  // `per` says how the shared queue actually divided up. Wildly uneven numbers are not a fault here —
  // they are the queue doing its job, giving the fast lane more work.
  note('sites.done', { opened, filled, lost, places, total, lanes, per: sharePer,
    // HOW EACH SITE WAS ANSWERED, counted rather than only logged — this is the number that says
    // whether the fetch path is earning its keep, and step two computed the same thing for weeks
    // and threw it away on every run. It is also the difference the user feels: a fetched site
    // costs one request, a tabbed one costs a whole page load in a tab with a debugger on it.
    byFetch, byTab, tabs: tabs.length,
    // How many sites were REFUSED because the host was somebody else's. Reported, because a run
    // where this is high is a list whose businesses mostly have no site of their own — a fact about
    // the list, not a fault in the pass.
    notMine });
  if (DEV && devLog) saveLog().catch(() => {});
  const out = { opened, filled, lost, places, sites: total, notMine, byFetch, byTab, noParse,
    // HOW MANY TABS THE PASS ACTUALLY OPENED, which is now a number that can be zero. It is the
    // one figure that says whether the user's browser was disturbed at all.
    tabs: tabs.length,
    noSite: found.none || 0, already: found.already || 0,
    left: Math.max(0, total - filled - lost), lanes, via: 'sites', rows: found.rows,
    ...(await lastTables(listTab)) };
  detailRun.set(listTab, { running: false, at: Date.now(), total, opened, filled, result: out });
  return out;
}
