// HoloScrape — service worker: following the pages of a list — through hidden or visible tabs of our
// own (`hopTabs`), or by walking the tab the person is looking at (`hopHere`).
import { chooseWalkTable, listThatMoved, rowHasRecord, urlForPage, rowIdentity, rowLinkKey, rowMainText } from './bridge-ops.js';
import { DEV } from './env.js';
import { restrictedHost, walking, hopCancel, hopProgress, detailRun, noteWall, walledUntil } from './bg-state.js';
import { note, devLog, saveLog } from './bg-log.js';
import { runRows } from './bg-rows.js';
import { CDP_VERSION, cdpPrepare, cdpWalk, withAwakeTab, pressForReal, waitForLoad } from './bg-cdp.js';
import { sessionFor, holdSession, keepSession, saveResult, itemsFromTables } from './bg-store.js';
import { runScan, filesFor } from './bg-scan.js';
import { openDetails, foldOrphans } from './bg-details.js';

// Fallback for pages auto-detection can't crack: open each URL in a background
// tab, scan it, close it. Sequential and unhurried on purpose — a burst of tabs
// is what gets people rate-limited.
// --- page hop through real tabs ---------------------------------------------
// The in-page hop fetches each URL and parses it, which costs one request and leaves the
// user's tab alone. It has one blind spot, and it is a big one: a list the site builds in
// the browser is not in the HTML the server sends, so the fetch comes back with a shell.
// Alibaba's category pages are that shape — point at the right next-page link and the
// fetch still reports no list, because there is no list in what it received.
//
// A tab renders. So when fetching finds nothing, the same pages are opened in inactive
// background tabs, read with the SAME container selector, and closed. Slower and visible
// in the tab strip, which is why it is the fallback and not the default.
// Reading the pages after this one, in the cheapest way that works.
//
// A hidden tab is not dead. It loads, parses and runs scripts — `load` fires and the
// network is not throttled — so a list the site BUILDS ON LOAD does get built, and can be
// read without anything appearing on screen. What a hidden tab cannot do is paint, and
// three things depend on paint: requestAnimationFrame, IntersectionObserver, and therefore
// every list that grows only when you scroll. Timers are clamped to a second too.
//
// So there are two passes, and the invisible one is tried first:
//
//   visible:false  a hidden tab, loaded and read WITHOUT scrolling. Costs the user
//                  nothing and nobody sees it. Enough for any list rendered on load.
//   visible:true   a window of its own, in front, walked properly. The only way to reach
//                  a list that needs scrolling — and it borrows the screen, so it is
//                  asked for rather than assumed.
//
// (A third way exists and is not built: `chrome.debugger` can un-throttle a hidden tab
// outright via Page.setWebLifecycleState and Emulation.setFocusEmulationEnabled. It would
// make the second pass invisible too, at the price of a debugging banner across the tab.)
// How long a pass may spend before the next one gets its turn. The passes are a ladder,
// and a ladder is only worth climbing if each rung is quick to test: three passes at
// twenty-five seconds each is over a minute of nothing before the user is even asked a
// question. The QUIET pass gets one page to prove itself — if the first page it loads
// holds no list, no later page will either, because it is the same template.
const PROBE_MS = 12000;

// How long to wait between one page and the next, in both tab passes. Duplicated from the
// row engine's `pace()` on purpose — that one is serialised into the page and can export
// nothing — and the two must be edited together, like the wording lists.
//
// MEASURED, not guessed at. On a local fixture that serves instantly, pacing was 62% of the
// whole walk — 15.9 of 25.6 seconds over three page turns, averaging 5.3s a page, because the
// one-in-five long pause fired twice. The competitor turns a page on a flat 1500ms and is not
// walled more often for it, which is the only evidence either way that anyone has.
//
// So the shape stays and the size comes down: still jittered, because a constant interval is
// itself the tell and behavioural scoring reads variance as much as mean, and still with an
// occasional longer pause, because a person does sometimes stop and look. Mean is now ~1.7s
// against ~5.3s. Being too fast earns a wall that ends the run and being too slow only costs
// seconds, so this is deliberately not as fast as it could be.
const pace = () => 1100 + Math.floor(Math.random() * 900)
  + (Math.random() < 0.1 ? 1200 + Math.floor(Math.random() * 1400) : 0);

export async function hopTabs(tabId, { selector, from, nextSelector, pages = 25, visible = false,
  since = 0, driven: opts_driven = false }) {
  const rows = [];
  const seen = new Set();
  let read = 0, url = from, why = 'no further pages';
  const visited = new Set();
  const cancelled = () => (hopCancel.get(tabId) || 0) > since;
  const trail = [];   // what each page actually gave, for a report that can be argued with
  let lastId = null;  // the saved result, updated as each page lands
  // Whether the rows arriving bring their PICTURES, counted in the live page where the rows
  // are joined — see `assetTally` in the row engine. A pass that reads a page without
  // scrolling it gets every row and almost none of the images, and until this was carried
  // back the ladder could not tell that from a pass that worked.
  let pics = null;
  const say = (u) => hopProgress.set(tabId, { pages: read, added: rows.length, url: u || '',
    via: visible ? 'window' : 'hidden', trail: trail.slice(-6) });
  say(from);

  note('hop.start', { from, visible, driven: !!opts_driven, selector: (selector || '').slice(-60) });
  let win = null, tab = null, tid = null, mine = null;
  // `driven` asks the debugger protocol to do the walking: a real desktop viewport, no
  // throttling, and wheel events rather than scrollTo. It is what makes a hidden tab read
  // a list that only appears when scrolled — the case every gentler pass fails at.
  let driven = !!opts_driven, attached = null;
  try {
    try { mine = (await chrome.tabs.get(tabId)) || null; } catch (_) {}
    let base = { left: 0, top: 0, width: 1200, height: 800 };
    if (visible) {
      try {
        const cur = await chrome.windows.getCurrent();
        base = { left: cur.left ?? 0, top: cur.top ?? 0, width: cur.width ?? 1200, height: cur.height ?? 800 };
      } catch (_) {}
    }

    while (url && read < pages) {
      if (cancelled()) { why = 'stopped'; break; }
      if (visited.has(url)) { why = 'that page pointed back at itself'; break; }
      visited.add(url);
      if (restrictedHost(url)) { why = 'that site is off limits'; break; }
      say(url);
      note('hop.page', { n: read + 1, url: url.slice(0, 110) });

      if (!tid) {
        if (visible) {
          // Deliberately small and off to one side: it is a worker, not something to read.
          win = await chrome.windows.create({
            url, type: 'popup', focused: true,
            // Wide enough to stay on the site's DESKTOP layout. A 600px window trips most
            // responsive breakpoints, and a mobile layout is a different DOM — different
            // wrappers, different classes, so page one's selector finds nothing and the
            // hop reports empty pages that were never empty.
            width: Math.max(1100, Math.min(1440, base.width - 60)),
            height: Math.max(700, Math.min(900, base.height - 60)),
            left: Math.round(base.left + 30),
            top: Math.round(base.top + 40),
          });
          tid = win.tabs?.[0]?.id;
        } else {
          tab = await chrome.tabs.create({ url, active: false });
          tid = tab.id;
        }
        if (!tid) { why = 'a page could not be opened'; break; }
      } else {
        await chrome.tabs.update(tid, { url });
      }
      // The first page of the quiet pass is a probe, and probes are bounded tightly: this
      // is a test of whether the approach works at all, not an attempt to be patient.
      await waitForLoad(tid, !visible && read === 0 ? PROBE_MS : 25000);
      // Attached once, kept for the life of the hop. From here the tab has a desktop
      // viewport, no throttling and a page that believes it is focused — which is what
      // makes reading it in a window you are not looking at work at all.
      if (driven && !attached) {
        try {
          await chrome.debugger.attach({ tabId: tid }, CDP_VERSION);
          attached = { tabId: tid };
          note('hop.attached', {});
        } catch (e) {
          driven = false;   // DevTools already has it, or the user said no
          note('hop.attach-failed', { err: (e.message || '').slice(0, 80) });
        }
      }
      if (attached) { await cdpPrepare(attached); await cdpWalk(attached, { press: tid }); }

      // `complete` means the document finished loading, which on a page that builds its
      // list in the browser means almost nothing: the probe extracted an empty page three
      // seconds in and then asked why it was empty. So wait for the LIST, not the load —
      // poll until the container has rows or the budget runs out.
      if (!attached) {
        const deadline = Date.now() + (read === 0 ? PROBE_MS : 20000);
        while (Date.now() < deadline) {
          const n = await runRows(tid, { action: 'container' }).catch(() => null);
          if (n && !n.error && n.rows > 0) break;
          if (cancelled()) break;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      // Checked again after the wait: a page takes seconds, and a Stop pressed during that
      // must not be answered by reading the page anyway and going on to the next.
      if (cancelled()) { why = 'stopped'; break; }

      // Hidden: read what loaded, and do not scroll — scrolling a tab that cannot paint
      // wakes nothing and costs a settle a screen. Visible: walk it properly, because a
      // rendered list is usually a lazy one.
      // Driven, the walking has already happened above and the page is as grown as it is
      // going to get — so read it, do not walk it again.
      const out = await runRows(tid, (visible && !attached)
        ? { action: 'extractAll', hops: 8, budget: 20000, clickMore: true, restoreTo: 0, noSave: true }
        : { action: 'extractAll', prime: false, noSave: true });
      // The container this scan chose, in preference to page one's selector: a rendered
      // page can wrap its list differently, and the detection here is the real thing
      // rather than a path resolved against a document with no layout.
      const t0 = (out?.tables || []).find((x) => x.selector === selector) || out?.tables?.[0];
      let fresh = 0;
      for (const r of t0?.rows || []) {
        const key = Object.values(r).find((v) => /^https?:/.test(v || '')) || JSON.stringify(r);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(r);
        fresh++;
      }
      // Asked before concluding anything, because a challenge page is a fast, listless
      // 200 and looks exactly like "this approach does not work here". Reading it as the
      // latter is what would keep loading page after page at a site that has just asked
      // you to slow down.
      if (!(t0?.rows || []).length) {
        const ch = await runRows(tid, { action: 'challenge' }).catch(() => null);
        const seen = await runRows(tid, { action: 'container' }).catch(() => null);
        note('hop.empty', { tables: out?.tables?.length || 0, challenge: !!ch?.challenge,
          word: ch?.word || '', marker: ch?.marker || '', chars: ch?.chars ?? -1,
          containerRows: seen?.rows ?? -1, err: out?.error || seen?.error || '' });
        if (ch?.challenge) { why = 'verify'; noteWall(url); break; }
      }
      // HANDED OVER PER PAGE, not hoarded until the end. Everything gathered used to be
      // committed in one go after the last page, so a Stop — or a page that failed, or a
      // wall — threw away every row read up to that point: ten pages of work, nothing in
      // the table. It also meant the table sat unchanged while the hop ran, which looks
      // exactly like a hop that is not working.
      if (fresh) {
        const batch = rows.slice(rows.length - fresh);
        const saved = await runRows(tabId, { action: 'pagerows', rows: batch }).catch((e) => ({ error: e.message }));
        note('hop.commit', { batch: batch.length, id: saved?.id || '', err: saved?.error || '',
          tableRows: saved?.tables?.[0]?.rows?.length ?? -1,
          pics: saved?.pics ? `${saved.pics.hopped}/${saved.pics.hoppedRows} vs live `
            + `${saved.pics.live}/${saved.pics.liveRows}` : '' });
        if (saved?.id) lastId = saved.id;
        if (saved?.pics) pics = saved.pics;
      }
      note('hop.read', { n: read + 1, saw: (t0?.rows || []).length, fresh,
        tables: out?.tables?.length || 0 });
      read++;
      // Per page, in the site's own terms: how many rows its table held and how many of
      // those were new. "Nothing was added" is a useless sentence when the question is
      // whether the pages were empty or merely repeats.
      trail.push({ n: read, saw: (t0?.rows || []).length,
        tables: out?.tables?.length || 0, fresh });
      say(url);
      if (!fresh) {
        // Said plainly, because in the visible pass the likeliest cause is not the site:
        // click back into your own window and Chrome stops rendering this one, so the list
        // it was building stops being built. A silent zero would look like the site's doing.
        let shown = true;
        if (visible && win) { try { shown = (await chrome.windows.get(win.id)).focused; } catch (_) {} }
        why = shown ? `page ${read} held nothing new`
          : 'the window lost focus, so the site stopped rendering';
        break;
      }

      const nx = await runRows(tid, { action: 'nextpage', nextSelector });
      url = nx && !nx.error && !nx.none ? nx.href : null;
      // Paced. Loading page after page as fast as they answer is the behaviour that earns
      // a slider in the first place, and the whole point of this is to be less trouble
      // than the person clicking through by hand.
      //
      // Jittered, not fixed. 800ms every single time is not a delay, it is a signature:
      // behavioural scoring reads the variance as much as the mean, and nobody turns
      // twenty-five pages at exactly 0.80s apiece. Same reasoning as `pace()` in the row
      // engine — the two costs are not symmetric, and being too fast ends the run.
      if (url) await new Promise((r) => setTimeout(r, pace()));
    }
  } catch (e) {
    why = 'that page could not be opened';
  } finally {
    // Whatever was opened is closed, and the focus goes back where it was. Leaving either
    // behind is the part a user would have to clean up by hand.
    if (attached) { try { await chrome.debugger.detach(attached); } catch (_) {} }
    if (win?.id) { try { await chrome.windows.remove(win.id); } catch (_) {} }
    else if (tid) { try { await chrome.tabs.remove(tid); } catch (_) {} }
    if (visible && mine?.id) {
      try { await chrome.tabs.update(mine.id, { active: true }); } catch (_) {}
      try { await chrome.windows.update(mine.windowId, { focused: true }); } catch (_) {}
    }
  }
  if (url && read >= pages) why = 'reached the limit';
  hopProgress.delete(tabId);
  note('hop.end', { pages: read, added: rows.length, why, via: attached ? 'driven' : visible ? 'window' : 'hidden',
    pics: pics ? `${pics.hopped}/${pics.hoppedRows}` : '' });
  // Written without being asked, WHEN ASKED FOR: a log you have to remember to save is a
  // log that exists for every run except the one that went wrong — but a file appearing in
  // Downloads unbidden is not something an extension should do to anyone.
  // Automatic writing is a STAGING affordance. In production a file appears in someone's
  // Downloads folder only because they pressed something that said it would.
  if (DEV && devLog) saveLog().catch(() => {});
  return { rows, pages: read, added: rows.length, why, trail, id: lastId, pics,
    via: attached ? 'driven' : visible ? 'window' : 'hidden' };
}

// --- walking the tab the user is looking at --------------------------------------------
//
// Every other pass in this file exists to keep one promise — that your tab does not move —
// and each one is the price of keeping it: a frame `X-Frame-Options` can refuse, a fetch the
// site can hook, a hidden tab that cannot paint. Measured on Alibaba, all three fail: the
// frame is denied outright, the fetch returns 703 KB with the products in a script blob and
// `window.fetch` wrapped by the site's own anti-bot, and the hidden tab renders rows but
// mounts no pictures. What the promise actually bought there was "your tab stays put and the
// images are missing".
//
// A real tab has layout, runs the page's scripts, paints, fires IntersectionObserver, carries
// the session and produces the headers a navigation produces. So this pass has no framing
// problem, no bot-signal problem and no unmounted-picture problem — and it is faster for the
// plain reason that it does not spend three bounded failures on the way. (Ultimate Web
// Scraper does only this; see `UWS-PAGINATION.md`.)
//
// Three things it owes the user, because it is their tab:
//
//   ASKED FOR      it interrupts whatever was on screen, so the panel asks first.
//   GIVEN BACK     the start URL is remembered and restored, however the walk ends.
//   NEVER HOARDED  a navigation destroys `window.__holoscrapeRows`, so rows cannot live on the
//                  page between pages. They accumulate here and are written to the record
//                  after every page — the same rule the other tab passes follow, for the same
//                  reason: a stop must keep what it read.
//
// And one thing it gains: when a site puts up a wall, the wall is in front of the person. It
// is not a dead end any more, it is a pause — so `hopHere` stops, leaves the tab on that page,
// and says so. Nothing is cooled off and nothing is retried behind their back.
const HERE_LOAD_MS = 25000;
const HERE_LIST_MS = 12000;


// `rowIdentity` ITSELF NOW LIVES IN bridge-ops.js, pure and unit-tested (test/row-identity.mjs),
// for the reason `listThatMoved` does: a rule buried in the walk can only be argued with in a
// browser. It is no longer "the longest link" — read the note there for the measurement (26 of 30
// quotes, a tag link naming three different rows) and for why the finer name cannot re-admit the
// repeats everything above is about.
// How long to wait after `complete` before reading the new page.
//
// Was 120ms, on the grounds that "the list poll below is the wait that matters" and that a fixed
// 2500ms had been 30% of a whole walk. That reasoning holds for a server-rendered list — amazon
// reads 16 of 16 on every page with it — and fails on a framework that mounts its cards after
// load. Measured on a shopee.co.id search of 16 pages: page one read 60 rows because it got the
// full walk, and every page after it read NINE, because nine is what shopee has mounted 120ms
// after `complete`. Page three then re-read page two's same nine, which is honestly "no new rows",
// and the walk stopped — correct behaviour on a page that had barely started existing. 69 rows
// collected out of roughly 960 available.
//
// A second is a bigger constant, not a different kind of answer: it moves the failure to the next
// site slower than a second rather than removing it. The measured fix is to read on a CONDITION —
// wait until the list's first-row identity changes and its row count stops climbing — and that is
// still worth building. This is the interim.
const HERE_GRACE_MS = 1000;
// How long a click is ALLOWED to take, and how often we ask. A fixed sleep is pure waste here —
// measured at 3.2s spent on a turn that commits in a few hundred milliseconds.
const HERE_CLICK_MAX = 8000;
const HERE_POLL_MS = 150;
// How long the walk sits in front of a puzzle before it gives up and hands the run back, and how
// often it looks. Three minutes because the thing being waited for is a person noticing a tab —
// they may be in another window, or another application, and the cost of waiting is nothing: the
// poll reads the tab's own DOM and never touches the site. Two seconds because a slider is solved
// in one gesture and a slower look would leave the walk standing on a page that is already open.
// Mutable so the harness can shorten it: `test/wall-session.mjs` drives the real wait and would
// otherwise spend three minutes per walled walk proving a timeout that is not what it is testing.
export const HERE_WAIT = { ms: 180000, poll: 2000 };
// AND OVERRIDABLE THROUGH STORAGE, NOT THROUGH THIS OBJECT. Mutating the object worked exactly
// until Chrome evicted the service worker, which re-evaluates this module and puts the three
// minutes back — so `test/rows.mjs` set 1.5s, lost it to an eviction mid-run, and sat through the
// full default twice. Storage outlives the worker; the object does not.
async function hereWait() {
  try {
    const { hereWait: w } = await chrome.storage.local.get('hereWait');
    return { ms: w?.ms ?? HERE_WAIT.ms, poll: w?.poll ?? HERE_WAIT.poll };
  } catch (_) { return { ...HERE_WAIT }; }
}
// How long a page with no list and nothing to read is given to say what it is. Three quarters of a
// second apiece because that is a CDN round trip, and four of them because past that the page is
// genuinely empty rather than late.
const HERE_SETTLE_TRIES = 4;
const HERE_SETTLE_MS = 750;
const HERE_SETTLE_CHARS = 24;
// Jittered like `pace()` and about a quarter of it. Never a constant: an exact interval is the
// signature a rate limiter looks for, whatever its length.
const clickPace = () => 300 + Math.floor(Math.random() * 500);

// WE ASKED FOR ONE PAGE AND ARE STANDING ON ANOTHER.
//
// The general form of "this is a wall", and the reason it is a MEASUREMENT and not a list. eBay
// answers page two with a redirect to `/splashui/challenge`; Amazon uses `/errors/validateCaptcha`;
// the next site will use something nobody has seen. What they share is not a path or a phrase —
// it is that the document answering us is not the document we requested. That is observable
// without knowing whose wall it is, and it does not grow by one line per site.
//
// Compared REQUESTED against LANDED, never previous against landed: a pager that walks
// `/list/page/2` → `/list/page/3` changes path every single time and is not a detour, because
// page three is what was asked for. Only the query differing is never a detour either — that is
// what ordinary pagination looks like.
//
// On its own this says nothing: sites redirect for canonical urls, locales, http→https, trailing
// slashes. It is only half a signal, and the caller pairs it with the other half — that the list
// did not survive the trip.
function tookUsElsewhere(want, got) {
  if (!want || !got) return false;
  try {
    const a = new URL(want);
    const b = new URL(got);
    return a.origin !== b.origin || a.pathname.replace(/\/+$/, '') !== b.pathname.replace(/\/+$/, '');
  } catch (_) { return false; }
}

// REVERTED: THIS WALK DOES NOT HOLD THE TAB VISIBLE, AND THAT IS DELIBERATE.
//
// It briefly did. The reasoning was sound — `list_extract` returns a runId and keeps walking after
// the op boundary, so a dispatch-level hold would cover the setup and none of the pages — and the
// result was a regression in the one path that had always worked.
//
// Measured on the person's own side panel, walking a /questions listing: "Fetching the next pages"
// sat at 0 rows and 0 pages through 26s, 58s, then 1m22s, and Stop would not take. `sidepanel.js`
// sends HOP_HERE here, so the panel inherited the hold — and `cdpPrepare` overrides device metrics
// to 1440x900, which RELAYS THE PAGE the panel had already captured its selector against. The walk
// turned the pages and matched nothing, because the layout underneath it had changed.
//
// The lesson is narrower than "no holds here": a hold that resizes the viewport is safe on a lane
// tab nobody is looking at and is NOT safe on the tab a person is watching, whose selector was
// captured at their width. If a background walk needs visibility, it needs a prepare that does not
// touch device metrics — not this one.
export async function hopHere(tabId, opts = {}) {
  return withAwakeTab(tabId, () => hopHereWalk(tabId, opts));
}

// `nextHref` and `nameTier` arrive from `list.extract {next}` and from tests respectively.
//   nextHref   an ADDRESS the caller gave for the next page where no control on the page carries it:
//              it names page two only, so it is spent on the first turn and the detector takes over.
//   nameTier   `false` switches the accessible-name tier of `findNextPage` off, so a test can show
//              the walk failing without it (test/pager-by-name.mjs, the control run).
async function hopHereWalk(tabId, { from, home = '', dial = null, nextSelector, nextClick = '', nextHref = '', nameTier, pages = 0, withDetails = false } = {}) {
  // STAMPED HERE, not taken from the caller. `hopCancel` holds when Stop was last pressed on
  // this tab, ever — so a `since` of 0 means every walk starts already cancelled by a Stop from
  // an earlier scan. Same trap the tab passes hit and the same cure: compare against when THIS
  // walk began.
  const since = Date.now();
  const cancelled = () => (hopCancel.get(tabId) || 0) > since;
  // And the flag on the PAGE outlives a navigation only in the sense that it outlives us: a
  // Stop pressed during some earlier scan is still sitting on this document, and the first
  // `extractAll` would obey it and read nothing. Pressing "Follow the pages" is the user
  // starting something, so it is cleared once, here, before any walking.
  await runRows(tabId, { action: 'clearstop' }).catch(() => {});
  let start = '';
  try { start = (await chrome.tabs.get(tabId)).url || ''; } catch (_) {}
  if (from) {
    // Resuming: the walk was paused on a wall the person has now dealt with, and `from` is
    // where it should pick up. The tab is already there, or is sent there.
    try { if ((await chrome.tabs.get(tabId)).url !== from) { await chrome.tabs.update(tabId, { url: from }); await waitForLoad(tabId, HERE_LOAD_MS, HERE_GRACE_MS); } } catch (_) {}
  }
  // WHERE TO PUT THE TAB BACK, which is no longer always where the walk began.
  //
  // `start` is the walk's own first address. That was the person's place too, until feeding the
  // page addresses started asking them to visit page 2 and 3 to copy the address bar — after
  // which the walk begins on page 3 and dutifully returns there. `home` is the panel's record of
  // where they were when they pressed Deep scan, and it wins when it is set. Everything else
  // still keys on `start`: this changes where the tab is LEFT, not what the run is filed under.
  const back = home || start;
  note('here.start', { start: start.slice(0, 100), from: (from || '').slice(0, 90),
    home: (home || '').slice(0, 90), dial: dial ? `${dial.key}+${dial.step}` : '' });

  // WHICH PROVIDERS MUST BE CLICKED THROUGH. Asked of the page rather than guessed from the URL,
  // because the engine already names the map and a URL string is a proxy for the thing itself.
  // ASKED, NOT LISTED. The worker kept its own `CLICK_PAGER` set until the provider table in
  // rows.js became the single source; now it reads the trait.
  let clickPager = false;
  // What a RECORD link looks like on this map, so the walk can tell one row from another by the
  // thing the row is about. Without it the longest URL wins and 2GIS rows key by their category
  // chip — see `rowIdentity`.
  let recordHref = '';
  // How this map's records are read. Only a FETCH lane can run between pages — see the interleave
  // below.
  let reads = '';
  try {
    const k = await runRows(tabId, { action: 'mapkind' }).catch(() => null);
    // A POINTED CONTROL MAKES ANY SITE A CLICK-THROUGH SITE. `grows: 'pager-click'` is how a
    // PROVIDER declares it; pointing is how a person declares it for a site we have never seen.
    // Both end in the same press, and gating the press on the declaration alone is what left an
    // unknown site's button pager unreachable while the engine behind the panel could work it.
    clickPager = k?.grows === 'pager-click' || !!nextClick;
    recordHref = k?.recordHref || '';
    reads = k?.reads || '';
  } catch (_) {}

  const sid = await sessionFor(tabId, start);
  // The merged table, built here because the page cannot hold it across a navigation. Columns
  // are first-seen order over every page, exactly as `extractOne` unions them for one page.
  const merged = { rows: [], cols: [], index: 0, label: '', selector: '', mode: 'here' };
  const colAt = new Map();
  // What each column is CALLED, learned from the page that named it and kept for the whole walk.
  const colName = new Map();
  // The canonical column set, so every page's cells land in the SAME columns instead of minting
  // new ones. `canonName` for columns the engine named; `canonSlot` for the rest, by position
  // within their kind. See the re-key below.
  const canonName = new Map();
  const canonSlot = new Map();
  // Page one's column order, which the engine ranked. The whole walk is laid out by it.
  const pageOrder = [];
  const seen = new Set();
  // The same rows by their longest link alone — what `here.kept` compares against. See `rowLinkKey`.
  const seenLinks = new Set();
  // ROWS THE WALK READ AND DID NOT KEEP, because a drop nobody is told about is the fault even
  // when the drop is right. Measured 2026-09-22: three pages of ten came back as 26 rows and the
  // reply said only "reached the limit" — four rows gone and no way to know from outside whether
  // the site served four repeats or the engine ate four quotes (it ate them; see `rowIdentity`).
  // Counted here so the finished run can say `dropped: { n, reason }` and be checked against the
  // page: `repeats` are rows named the same as one already taken, `copies` are the rows
  // `dedupeRows` found identical in every cell on one page.
  const dropped = { repeats: 0, copies: 0, sample: [] };
  const trail = [];
  // FILES FROM EVERY PAGE, not only from the one the button was pressed on. Accumulated across the
  // walk for the same reason `merged` is: each page's write carries everything read so far, so a
  // stop, a wall or a page that will not load cannot take the earlier pages with it.
  const shots = [];
  const shotAt = new Set();
  // The first row of the page just read, so the next page's wait can tell "the new list has
  // arrived" from "the old one has not left yet". See the list wait after each turn.
  let lastFirst = '';
  // The fullest page this walk has seen. A pager serves a constant page size, so this is what
  // "the page has finished arriving" gets measured against — see the settle loop.
  let bestPage = 0;
  // The page's other lists, kept so writing ours does not delete them — see the commit below.
  const others = [];
  let read = 0, why = 'no further pages', wall = '', at = start, lastId = null;
  // WHAT THE PAGER SAID WHEN IT SAID NO, kept so the finished walk can show it. "no further pages"
  // was a complete sentence that named nothing: measured on books.toscrape.com, it was returned
  // over a link reading "next". `verdict` is `nextpage`'s own negative, carried out unchanged.
  let verdict = null;
  // A load-more control still on the last page read. See `growable` in rows.js.
  let growable = null;
  // A WALL WE DID NOT RECOGNISE IS STILL A REPLACED DOCUMENT.
  //
  // `wall` means "we know what this page is". `blind` means "the site answered the next page with
  // something we could not read, and we cannot say why" — an interstitial whose wording is in no
  // list, a soft block, an error page. The session consequence is identical either way, and it is
  // the consequence that matters: see the hold in the `finally`.
  let blind = false;
  // THE URL WE ASKED FOR, so the one we landed on can be compared against it. See `tookUsElsewhere`.
  let wanted = '';
  // The fullest page this walk has actually read, which is what a collapse is measured against.
  // Kept here rather than reusing `bestPage`: that one is the settle loop's view of a page still
  // painting, and it moves for reasons that have nothing to do with what was merged.
  let bestRead = 0;
  // THE LIST THIS WALK LOCKED ONTO, AND WHETHER IT HAS EVER MOVED.
  //
  // `prevIds` is the chosen table's row identities on the page before this one; `repicked` makes
  // the correction below fire at most once, so a site where nothing ever changes cannot put the
  // walk in a loop. See the block that uses them.
  let prevIds = null;
  let repicked = false;
  // HOW MANY PAGE TURNS THE CHOSEN LIST HAS ANSWERED WITH NEW ROWS. Furniture answers none; a
  // list that has answered even one is alive, and a later stall is its END, not a wrong pick.
  // `listThatMoved` reads it — see the shopee run in that function's own comment.
  let turnsMoved = 0;
  // HOW MANY MERGED ROWS CARRIED A RECORD LINK, as the provider describes one. Once the list has
  // shown that its rows are records, a table whose rows are not is not the list — see
  // `chooseWalkTable`.
  let recordsSeen = 0;
  const recRx = recordHref ? new RegExp(recordHref) : null;
  const max = pages > 0 ? pages : Number.MAX_SAFE_INTEGER;
  // WHAT THE WALK IS DOING RIGHT NOW, and from here that is two different things. Turning a page
  // and reading that page's records are separate pieces of work with separate costs, and the
  // panel polls this one object for both — so `reading` is how the record sub-pass becomes
  // visible at all. Without it the ledger sat on step one for the whole run while most of the
  // time was going into step two, which is what "the stepper never turns into the second step"
  // was: not a stuck pass, an invisible one.
  let reading = null;
  // Rows this walk read records for, as the record pass counted them. The panel cannot get this
  // from the engine — `progress.detailed` counts the PAGE's bag, and a fetch lane never writes
  // there — so a walk that detailed everything still looked entirely undetailed from outside,
  // and the end card kept offering to do the work again. See `here.details`.
  let detailedHere = 0;
  // List waits that ran out of budget instead of ending, and what all the waits cost. See the
  // wait loop below; reported on the way out so the cap is never folded into a success.
  const unsettledHere = [];
  let settleMsHere = 0;
  // Sitting still in front of a check, which is a third thing the walk does and the panel has to
  // be able to say. Without it the card reads "reading page 3" for as long as the person takes to
  // solve a slider, and the run looks hung at the one moment it is behaving correctly.
  let waiting = null;
  const say = () => hopProgress.set(tabId, { pages: read, added: merged.rows.length,
    url: at, via: 'here', trail: trail.slice(-6), reading, waiting });
  say();

  // WAIT FOR THE PERSON INSTEAD OF ENDING THE RUN UNDER THEM.
  //
  // A puzzle is the one stop a walk can recover from on its own terms: the check is on screen, the
  // tab is already in front of whoever started this, and clearing it is a thing only they can do.
  // Ending there and offering "carry on" afterwards is a worse version of the same wait — it drops
  // the run's position and, on a site that answers the next page WITH the challenge, the document
  // the visit was keyed on with it.
  //
  // NOTHING IS ASKED OF THE SITE WHILE IT WAITS. `challenge` reads the tab's own DOM and touches
  // the network not at all, which is the whole difference between waiting and the retry that turns
  // a slider into a block.
  //
  // AND 'flagged' IS NOT WAITED ON. There is no check on the page, so watching for one to go away
  // is watching for nothing — and staying pointed at a site that has just refused the session is
  // how a quarter-hour cool-off becomes a longer one. Those stop, exactly as before.
  // `stale` is carried through because the two wall paths ask DIFFERENT questions and only one of
  // them is answerable without it. A soft block leaves the list on the page and puts the check over
  // the top, so `challenged(doc, hasList, stale=false)` returns false on sight — a list is normally
  // proof we were let through. Polling without the flag therefore reported "cleared" on the first
  // look, the walk gave back the page and re-read it, found the same soft block, and went round
  // again: not a slow wait, an infinite one. `test/rows.mjs` hung on exactly this.
  //
  // `tries` bounds the give-back for the same reason. Even asking correctly, a page that clears and
  // then still holds nothing new must not be re-read forever.
  let staleAgain = 0;
  const cleared = async (kind, stale = false) => {
    if (kind !== 'puzzle') return false;
    if (stale && ++staleAgain > 2) {
      note('here.staleGaveUp', { n: read });
      return false;
    }
    const wait = await hereWait();
    const until = Date.now() + wait.ms;
    const began = Date.now();
    note('here.waiting', { kind, secs: Math.round(wait.ms / 1000) });
    while (Date.now() < until && !cancelled()) {
      waiting = { kind, since: began, until, url: at };
      say();
      await new Promise((r) => setTimeout(r, wait.poll));
      const ch = await runRows(tabId, { action: 'challenge', stale }).catch(() => null);
      // Gone means gone — but only when asked the same way. On the ordinary path a list on the page
      // IS the proof; on the stale path it is not, which is what `stale` carries.
      if (ch && !ch.error && !ch.challenge) {
        waiting = null; say();
        note('here.cleared', { waited: Math.round((Date.now() - began) / 1000) });
        return true;
      }
    }
    waiting = null; say();
    note('here.gaveup', { waited: Math.round((Date.now() - began) / 1000) });
    return false;
  };

  try {
    while (read < max && !cancelled()) {
      at = (await chrome.tabs.get(tabId).catch(() => ({}))).url || at;
      if (restrictedHost(at)) { why = 'that site is off limits'; break; }
      say();

      // WALKED, not merely read. This is the whole reason to be in a tab that paints: the walk
      // presses a load-more if there is one and scrolls the list, which is what mounts the
      // pictures every quieter pass leaves behind.
      //
      // Timed per phase, and the timings are kept rather than added for one investigation.
      // "It is slower than X" is unanswerable without them: the walk, the pacing, the load and
      // the wait for the list are four different costs with four different cures, and guessing
      // which one is dominant is how a fast path gets optimised in the wrong place.
      const tPage = Date.now();
      const out = await runRows(tabId, {
        action: 'extractAll', hops: 8, budget: 20000, clickMore: true, restoreTo: 0, noSave: true,
      }).catch((e) => ({ error: e.message }));
      if (cancelled()) { why = 'stopped'; break; }

      const msWalk = Date.now() - tPage;
      // THE CHOSEN LIST, NOT THE BIGGEST ONE.
      //
      // `extractAll` returns every list on the page and LEADS with the selected one. Sorting by
      // row count therefore walks whichever list is longest, which on a page with a filter sidebar
      // is the sidebar. Measured on an amazon.com search, from the user's own log:
      //
      //   save action=extractAll rows=16          the grid, chosen and saved
      //   here.read n=1 saw=54 fresh=1 total=1    the walk reading the 54-row refinement panel
      //   here.read n=2 saw=54 fresh=0 total=1    page two, nothing new, walk over
      //
      // Every refinement links to `/s`, so all 54 rows key alike, dedupe to one, and page two
      // honestly brings no new identities. "Stopped at page 2" and "1 more rows from 2 pages" are
      // both this line. The two writers were also carrying different tables at each other —
      // `save.keptFuller from=commit had=22 now=16` is the walk's sidebar refusing the panel's grid.
      // PICK THE SAME TABLE, NOT WHATEVER extractAll RANKS FIRST TODAY. `extractAll` scores every
      // candidate fresh on every page, independent of what page one settled on — so a rebuilt DOM
      // that happens to score a different section higher (a "you might also like" rail, a wider
      // wrapper) silently swaps in a WRONG table with no error and no warning. Measured on a real
      // walk (blibli.com/cari/android): page one's grid gave 25 clean single-product rows, and
      // from page two on `tables[0]` became a related-products rail whose "rows" were entire
      // clusters of unrelated products crammed into generic Text/Link columns — 53 rows in the
      // final table, mangled, where a clean multi-page walk should have given far more.
      //
      // Exact selector match first — cheap, and the common case when the DOM structure survives
      // intact. When it does not (the exact case selectors go stale for everywhere else in this
      // file — `resolve`, the pointed-control front-trim, all of it), fall back to column shape:
      // whichever candidate's columns overlap the ALREADY ESTABLISHED canonical set from page one
      // the most is almost certainly the same table wearing a different selector, and a rail of
      // merged clusters overlaps it barely at all.
      const tables = out?.tables || [];
      // THE DECISION LIVES IN `chooseWalkTable`, pure and unit-tested (test/list-gone-is-the-end.mjs).
      // What it settled, in short: the same selector wins; failing that the table whose columns
      // overlap page one's; failing THAT the list is not on this page and `t0` is null — never
      // `tables[0]`. That fallback is how a shopee walk read a category rail and a footer as
      // pages nine to eleven: every junk row was "fresh", so the walk could not end, and the
      // repick rule then threw away 439 rows. A page past the end of a list has other lists on it.
      const pick = chooseWalkTable({ tables, selector: merged.selector, canonName, canonSlot,
        recordHref, recordsSeen, read });
      let t0 = pick.t0;

      // THE LIST THAT DOES NOT CHANGE WHEN THE PAGE TURNS IS NOT THE LIST.
      //
      // This is the general form of a bug that has been fixed site by site all year, each fix a
      // weight nudged into `scoreOf`, each one shifting the global ranking and breaking the last
      // site: shopee's filter panel, gmail's three-row promo wrapper, and now an amazon search
      // where the walk locked onto 43 rows of page furniture — sponsored slots, a "Social media
      // picks" rail, a book, "Related searches" — that are IDENTICAL on every page. Measured from
      // the user's own log: `here.read n=1 saw=43 fresh=1`, `here.read n=2 saw=43 fresh=0`,
      // `here.end pages=2 rows=1 why=page 2 held nothing new`, while `here.list` beside it read
      // the real grid at 16 rows. The page turned perfectly. The wrong table was being read.
      //
      // So stop tuning the prior. `scoreOf` is a guess made from geometry with no page turn to
      // learn from, and it stays exactly as it is — this is EVIDENCE, and it is only allowed to
      // speak when it has some: a page turn that left the chosen table's row identities entirely
      // unchanged while some other candidate brought rows nobody has seen. On every page where
      // the prior was already right the chosen table changes, `changed` is true, and not a line
      // of this runs. That is what makes it safe to add where another weight would not be.
      //
      // Restarting rather than carrying on: the rows already merged came from the wrong table,
      // and pages 1..n of the RIGHT one were never read. Resetting the accumulators and walking
      // again from `start` with the selector now locked costs one extra page and reuses this
      // loop wholesale, which is far less risky than a second merge path written beside it.
      if (prevIds && prevIds.size && t0 && !repicked && tables.length > 1) {
        const idsOf = (t) => {
          const out = new Set();
          for (const r of (t.rows || [])) out.add(rowIdentity(r, recordHref));
          return out;
        };
        // THE DECISION ITSELF LIVES IN `listThatMoved`, pure and unit-tested. What is left here
        // is only the consequence: reset and walk again. Keeping the two apart is the point —
        // the rule can be argued with in a test file instead of in a browser.
        const moved = listThatMoved({
          prevIds,
          chosenIds: idsOf(t0),
          rivals: tables.filter((t) => t !== t0).map((t) => ({ t, ids: idsOf(t) })),
          seen,
          turnsMoved,
        });
        if (moved) {
          const best = moved.pick.t;
          note('here.repick', { n: read, was: (merged.selector || '').slice(0, 60),
            wasRows: t0.rows.length, now: (best.selector || '').slice(0, 60),
            nowRows: best.rows.length, fresh: moved.fresh, dropped: merged.rows.length,
            why: 'the table we were reading did not change when the page turned' });
          repicked = true;
          merged.selector = best.selector || '';
          merged.label = best.label || '';
          merged.rows = []; merged.cols = [];
          seen.clear(); colAt.clear(); canonName.clear(); canonSlot.clear();
          seenLinks.clear(); dropped.repeats = 0; dropped.copies = 0; dropped.sample.length = 0;
          others.length = 0;
          read = 0; bestRead = 0; prevIds = null; turnsMoved = 0; recordsSeen = 0;
          try {
            if ((await chrome.tabs.get(tabId)).url !== start) {
              await chrome.tabs.update(tabId, { url: start });
              await waitForLoad(tabId, HERE_LOAD_MS, HERE_GRACE_MS);
            }
          } catch (_) {}
          at = start;
          continue;
        }
      }
      // GUARDED, BECAUSE `t0` IS LEGITIMATELY NULL HERE.
      //
      // `chooseWalkTable` answers null on a page with no tables AND on a page whose tables are
      // not the list, and neither is an error — a wall, a challenge, an empty page or a page past
      // the end is handled a few lines below, which is where it has always been handled. Reading
      // `t0.rows` before that point turned every walled page into
      // "the walk stopped: Cannot read properties of undefined (reading 'rows')" and cost three
      // test files (`splashwall`, `wall-session`, `rows`) their wall detection outright.
      prevIds = t0 ? (() => {
        const out = new Set();
        for (const r of (t0.rows || [])) out.add(rowIdentity(r, recordHref));
        return out;
      })() : prevIds;

      // BOTH HALVES, OR NEITHER. Taken somewhere we did not ask for AND the list did not survive
      // it. Either alone is ordinary: sites redirect to canonical urls all day and still serve the
      // list, and a genuinely short final page is short at the address we asked for.
      //
      // The collapse is measured against the fullest page THIS walk has read, not against a
      // constant — "fewer than three rows" would have called eBay's challenge a list, since it
      // carries a readable three-row table ("Something went wrong on our end") that the walk
      // merged as data. 60 rows a page and then 3 is not a short page, it is a different page.
      const gotRows = t0?.rows?.length || 0;
      if (read && bestRead && tookUsElsewhere(wanted, at)
          && gotRows < Math.max(3, Math.floor(bestRead / 2))) {
        note('here.detour', { want: String(wanted).slice(-48), got: String(at).slice(-48),
          rows: gotRows, was: bestRead });
        wall = 'puzzle'; why = 'verify'; break;
      }
      if (gotRows > bestRead) bestRead = gotRows;

      if (!t0 || !t0.rows.length) {
        // A wall is a fast, listless page and reads exactly like "nothing here" — so ask,
        // before concluding anything, and say WHICH kind it is.
        // AN EMPTY BODY IS NOT AN ANSWER, so it is waited on rather than concluded from.
        //
        // `CHALLENGE_ONLY` catches the vendors we know by their bootstrap, but a site that renders
        // its check from its own bundle has no such tell — and a page with no list AND nothing to
        // read has simply not said anything yet. Cheap, and only ever reached on a page that
        // already looks empty: the alternative is calling a check "no list on this page".
        let ch = await runRows(tabId, { action: 'challenge' }).catch(() => null);
        for (let i = 0; i < HERE_SETTLE_TRIES
          && !ch?.challenge && (ch?.chars ?? -1) < HERE_SETTLE_CHARS; i++) {
          await new Promise((r) => setTimeout(r, HERE_SETTLE_MS));
          ch = await runRows(tabId, { action: 'challenge' }).catch(() => null);
        }
        note('here.empty', { challenge: ch?.kind || '', word: ch?.word || '', chars: ch?.chars ?? -1,
          said: (ch?.sample || '').slice(0, 120) });
        if (ch?.challenge) {
          // Cleared while we watched: this page was never read, so go round again and read it.
          if (await cleared(ch.kind || 'puzzle')) continue;
          wall = ch.kind || 'puzzle'; why = 'verify'; break;
        }
        // THE LIST IS NOT ON THIS PAGE, AND OTHER LISTS ARE. That is what a page past the end of
        // a capped list looks like — shopee answers `?page=8` with its chrome, its footer and an
        // empty grid — and it is an ordinary document, not a replaced one: nothing to hold the
        // session against, and the walk ends where the list did. Said with the row counts of
        // what WAS there, so "it stopped at page 8" can be checked against the page.
        if (read && (pick.via === 'gone' || pick.via === 'no-records')) {
          note('here.gone', { n: read + 1, via: pick.via, tables: (pick.saw || []).slice(0, 8),
            why: pick.via === 'no-records'
              ? 'the list container is here but none of its rows is a record'
              : 'no table on this page matched the list the walk locked onto' });
          why = `page ${read + 1} did not carry the list — it ends at page ${read}`;
          break;
        }
        // Not a wall as far as anything here can tell — but the page it landed on is not the page
        // it asked for, and the document has been replaced all the same. Carry the visit.
        blind = true;
        why = read ? `page ${read + 1} held no list we could read` : 'no list on this page';
        break;
      }
      if (!merged.selector) { merged.selector = t0.selector || ''; merged.label = t0.label || ''; }

      // ONE COLUMN SET FOR THE WHOLE WALK, NOT ONE PER PAGE.
      //
      // A column key is a DOM path, and 2GIS's class names are build hashes — so the same visual
      // cell arrives under a different key on page 2 than on page 1. Unioning the keys therefore
      // grew the table instead of filling it: a real 22-row walk came out **67 columns** where one
      // page has 29, most of them sparse duplicates of a cell that already had a home, and every
      // duplicate unnamed. That is the "text dominant" width.
      //
      // So each page's columns are mapped onto the FIRST page's before its rows are taken:
      //
      //   named   → by name. The engine names a page's columns before handing them over
      //             (`nameFromState`, then `nameCols`), and a name is the same fact on every page.
      //   unnamed → by slot: its position among the unnamed columns of its own kind. The card
      //             template is identical page to page, so the third unnamed text cell on page 2
      //             is the third unnamed text cell on page 1.
      //
      // A key with no counterpart is genuinely new and keeps its own column.
      const remap = new Map();
      const slotN = new Map();
      for (const c of (t0.cols || [])) {
        if (!c || !c.key) continue;
        if (c.name) {
          const seenKey = canonName.get(c.name);
          if (seenKey) { remap.set(c.key, seenKey); } else { canonName.set(c.name, c.key); }
          colName.set(canonName.get(c.name), c.name);
          continue;
        }
        const kind = c.kind || 'text';
        const n = (slotN.get(kind) || 0) + 1;
        slotN.set(kind, n);
        const slot = `${kind}#${n}`;
        const seenKey = canonSlot.get(slot);
        if (seenKey) remap.set(c.key, seenKey); else canonSlot.set(slot, c.key);
      }

      let fresh = 0;
      const freshLinks = [];
      dropped.copies += Number(t0.collapsed) || 0;
      for (const row of t0.rows) {
        const key = rowIdentity(row, recordHref);
        if (seen.has(key)) {
          dropped.repeats++;
          if (dropped.sample.length < 3) dropped.sample.push(rowMainText(row).slice(0, 80));
          continue;
        }
        seen.add(key);
        seenLinks.add(rowLinkKey(row, recordHref));
        // Re-keyed onto the canonical set. Built fresh rather than mutated so a value that lands
        // on a key the row already carries cannot clobber it.
        const put = {};
        for (const [k, v] of Object.entries(row)) {
          const to = remap.get(k) || k;
          if (put[to] == null || String(put[to]).trim() === '') put[to] = v;
        }
        merged.rows.push(put);
        for (const k of Object.keys(put)) if (!colAt.has(k)) colAt.set(k, true);
        // The record link of a row THIS page brought, so the detail pass below reads only what is
        // new. Without it every page would re-read every row before it — twelve, then twenty-four,
        // then thirty-six, for the same twelve facts.
        if (recRx) {
          for (const v of Object.values(put)) {
            if (typeof v !== 'string' || !/^https?:/i.test(v)) continue;
            try { if (recRx.test(new URL(v).pathname)) { freshLinks.push(v); break; } } catch (_) {}
          }
          if (rowHasRecord(put, recRx)) recordsSeen++;
        }
        fresh++;
      }
      // A turn the chosen list answered with new rows. Page one is not a turn.
      if (read && fresh) turnsMoved++;
      // AND THE NAMES THE PAGE WORKED OUT COME WITH THEM.
      //
      // This rebuilt every column from its key alone, which silently threw away `name` — so a walk
      // produced `Text 1 … Text 11` even where the page's own extraction had named them. The engine
      // does the naming (`nameFromState`, then `nameCols`), and it does it per page; the merge has
      // no business re-deciding it and no information with which to.
      //
      // First name wins and is never overwritten: page one is where the typed record lives, so it
      // is the page whose naming is best evidenced. See `nameFromState` — the layout is a property
      // of the card template, so page one's answer is the right answer for all of them.
      for (const c of (t0.cols || [])) {
        if (c && c.key && c.name && !colName.has(c.key)) colName.set(c.key, c.name);
      }
      // A WALK NEVER STARTS BEHIND WHAT THIS VISIT ALREADY HAS.
      //
      // Page one is read fresh, and a fresh read of page one is not always the fullest account of
      // it. Two ordinary cases: a rail that virtualises, where the scan saw 124 rows and the walk
      // now mounts 25; and a list that repeats an entry across two slots, where `rowIdentity`
      // correctly collapses 60 into 59. Either way the walk's first write is SMALLER than what is
      // stored, and everything downstream then has to decide whether that is a loss — which is
      // the wrong place to decide it. It is fixed here instead, by not shrinking.
      //
      // Strictly this visit's own record: looked up by `sid` through history rather than by URL
      // across every record on disk, so a scan of the same address from last week cannot leak
      // rows into this run.
      //
      // AFTER `fresh` IS COUNTED, deliberately. These rows are not new arrivals — they were
      // already here — and counting them would make page one look productive on a re-walk and
      // page two look empty, which is the signal the walk ends on.
      if (!read && !lastId) {
        try {
          const { history: hist = [] } = await chrome.storage.local.get('history');
          const was = hist.find((h) => h.sid === sid);
          const rec = was?.id
            ? (await chrome.storage.local.get('table:' + was.id))['table:' + was.id] : null;
          const mine = (rec?.tables || [])
            .find((t) => (t.selector || '') === (merged.selector || ''));
          let took = 0;
          for (const row of (mine?.rows || [])) {
            // BY LONGEST LINK, AS THIS LOOP ALWAYS WAS — not by the finer name the merge above
            // uses. These are two reads of the SAME page seconds apart; see `rowLinkKey`.
            const lk = rowLinkKey(row, recordHref);
            const k = rowIdentity(row, recordHref);
            if (seenLinks.has(lk) || seen.has(k)) continue;
            seenLinks.add(lk);
            seen.add(k);
            merged.rows.push(row);
            for (const c of Object.keys(row)) if (!colAt.has(c)) colAt.set(c, true);
            took++;
          }
          if (took) note('here.kept', { rows: took, from: was.id,
            why: 'rows this visit already had that page one did not hand back' });
        } catch (_) {}
      }
      // Rebuilt from the union each page: `kind` comes from the key, so this is cheap and
      // cannot drift from what the rows actually hold.
      merged.cols = [...colAt.keys()].map((key) => ({
        key,
        kind: /\b(src|data-src|data-original|data-lazy-src|srcset|data-srcset)$/.test(key) ? 'asset'
          : /\bhref$/.test(key) ? 'link' : 'text',
        filled: merged.rows.filter((r) => r[key]).length,
        ...(colName.has(key) ? { name: colName.get(key) } : {}),
      }));
      // PAGE ONE'S ORDER, FOR THE WHOLE WALK.
      //
      // This used to sort by KIND — assets, then links, then text — on the stated grounds that it
      // matched `extractOne`. It stopped matching the moment `extractOne` started ordering by
      // MEANING (name, rating, address, contact… see `ORDER`), and nobody changed this one. So a
      // scan and a walk of the same list produced two different tables: the walk opened
      // `Rubric link | Branches link | Website | Page | Phone`, five URLs before the first
      // readable word, while a single page opened `Brand | Category | Rubric | Description`.
      //
      // The engine already ranked page one's columns, so that ranking is simply kept: page one's
      // order, then anything a later page introduced, in the order it appeared. One list, one
      // order, whichever way the rows were gathered.
      if (!pageOrder.length) pageOrder.push(...(t0.cols || []).map((c) => remap.get(c.key) || c.key));
      const seat = (k) => { const i = pageOrder.indexOf(k); return i < 0 ? pageOrder.length : i; };
      merged.cols = merged.cols
        .map((c, i) => [c, i])
        .sort((a, b) => (seat(a[0].key) - seat(b[0].key)) || (a[1] - b[1]))
        .map(([c]) => c);
      // Only the combined table can see a later page's template variants. See `foldOrphans`.
      foldOrphans(merged, !!recordHref);
      read++;
      trail.push({ n: read, saw: t0.rows.length, tables: out.tables.length, fresh });

      // WRITTEN NOW. A navigation is coming and it takes the page's memory with it; anything
      // held back here is lost to a stop, a wall, or a page that will not load.
      //
      // Beside the page's OTHER tables, not over them. `saveResult` unions items within a
      // session but REPLACES tables, and a page with a grid and a sidebar list has two — so
      // writing ours alone would delete the one we are not walking. Read once, on the first
      // page, and carried from there.
      if (read === 1) {
        const rec = lastId ? null : (await chrome.storage.local.get(null));
        const key = Object.keys(rec || {}).find((k) => k.startsWith('table:')
          && rec[k]?.url === start && (rec[k].tables || []).length);
        for (const t of (key ? rec[key].tables : [])) {
          if ((t.selector || '') !== (merged.selector || '')) others.push(t);
        }
      }
      // THIS PAGE'S FILES, GATHERED BEFORE THE WRITE so they travel in it.
      //
      // Reported as "I could only get images from first page never from next ones", and it was
      // never the whole file list: `itemsFromTables` carries anything sitting in an ASSET COLUMN,
      // so a card's own <img> survived every hop. What did not survive was everything a row has no
      // column for — CSS backgrounds, og:image, a video's poster, srcset-only sources — because
      // the asset engine ran once, from the panel, and the walk never called it again.
      //
      // No second scroll: the walk has already been down this page, so the lazy images are loaded
      // and pressing further is the walk's own job, not this pass's. `walked` is what gets it past
      // the `WALKING` refusal that exists to keep the passive poll out.
      const want = filesFor.get(tabId);
      if (want && want.sid === sid) {
        try {
          const got = await runScan(tabId, { ...want.opts, walked: true, noSave: true,
            peek: false, autoScroll: false, maxMoreClicks: 0, keepScroll: false });
          let fresh = 0;
          for (const it of got?.items || []) {
            if (!it?.url || shotAt.has(it.url)) continue;
            shotAt.add(it.url); shots.push(it); fresh++;
          }
          if (fresh) note('here.files', { n: read + 1, fresh, total: shots.length });
        } catch (_) { /* a page that will not scan still has its rows */ }
      }
      const all = [merged, ...others];
      const saved = await saveResult({
        // WHOSE WRITE THIS IS. Without it the walk was judged as a re-read and refused — see the
        // `walk` branch in `saveResult`, and `ETSY-TABLE-FREEZE.md` for the run that named it.
        from: 'walk',
        tables: all,
        // The rows' own assets, plus everything the asset engine found on each page that a row
        // has no column for. Row-derived first, so a file that is both keeps its row's title.
        items: (() => {
          const rows = itemsFromTables(all, start);
          const has = new Set(rows.map((i) => i.url));
          return [...rows, ...shots.filter((i) => !has.has(i.url))];
        })(),
        url: start,
        log: [`walked ${read} page(s) in place: ${merged.rows.length} rows`],
      }, start, sid).catch((e) => {
        // A WRITE THAT FAILS MUST SAY SO. This was `.catch(() => null)`, and the only trace a
        // failed save left was an empty `id=` on the `here.read` line beside it — which nobody
        // reads as "nothing was stored". Measured on a shopee walk of nine pages: the save
        // rejected from page five onward, `here.read` climbed 225, 281, 319, 378 while the stored
        // table sat at 190, and the panel reported 378 rows over a table holding half that.
        // "It said 300+ but the table has 100+" is this line swallowing its reason.
        note('here.saveFailed', { n: read, rows: merged.rows.length, files: shots.length,
          why: String(e?.message || e).slice(0, 120) });
        return null;
      });
      if (saved?.id) lastId = saved.id;
      const msSave = Date.now() - tPage - msWalk;
      note('here.read', { n: read, saw: t0.rows.length, fresh, total: merged.rows.length,
        id: saved?.id || '', msWalk, msSave });
      say();

      // READ THIS PAGE'S RECORDS BEFORE TURNING TO THE NEXT ONE.
      //
      // The passes used to run end to end: walk every page, then go back over the whole table and
      // read every record. Two costs, both paid by the person watching. Stopping a walk left a
      // table of names and nothing else — the work that makes it useful had not started — and the
      // detail pass then re-read from row one, so the last page's records arrived long after the
      // page itself did. Interleaved, STOP MEANS DONE: whatever pages were read are complete.
      //
      // Only where the records are FETCHED. A lane that opens each record in the tab would have to
      // navigate away from the list and back for every row, and the pager's position — which is
      // held in the page, not the URL — would not survive it. `reads: 'fetch'` is precisely the
      // promise that reading a record does not disturb the tab.
      //
      // `only` is this page's fresh links, so the pass never re-reads a row an earlier page
      // already did.
      if (withDetails && reads === 'fetch' && freshLinks.length) {
        walking.delete(tabId);
        reading = { at: 0, of: freshLinks.length, filled: 0 };
        say();
        // The record pass keeps its own tally in `detailRun`; this copies it into the hop status
        // every quarter second so the figure climbs on screen rather than jumping at the end.
        const beat = setInterval(() => {
          const run = detailRun.get(tabId);
          if (!run) return;
          reading = { at: run.opened || 0, of: run.total || freshLinks.length, filled: run.filled || 0 };
          say();
        }, 250);
        const got = await openDetails(tabId, { only: freshLinks }).catch(() => null);
        clearInterval(beat);
        reading = null;
        say();
        walking.add(tabId);
        detailedHere += got?.filled || 0;
        note('here.details', { n: read, asked: freshLinks.length,
          opened: got?.opened || 0, filled: got?.filled || 0, lost: got?.lost || 0 });
        // TAKEN FROM THE STORE, NOT FROM THE PAGE — and reaching for `lastTables` here was wrong
        // in a way that looked right. It re-extracts (`dtables`), so it answers with the LIST as
        // the page currently renders it: twelve rows and twenty columns, none of the record's
        // twenty-five. Adopting that threw the enrichment away every page, the walk then offered
        // a narrower table than the one in storage, `save.keptWider` refused it — correctly — and
        // the store sat at twelve rows while the walk cheerfully counted 24, 36, 48.
        //
        // The detail pass WROTE what we want. Read that.
        const rec = lastId ? await chrome.storage.local.get('table:' + lastId).catch(() => null) : null;
        const back = rec ? rec['table:' + lastId] : null;
        // Matched by selector first, and falling back to the CHOSEN table rather than the biggest
        // one — same reason as `t0` above. A fallback that picks a different list than the walk
        // has been reading hands the walk somebody else's rows.
        const mine = (back?.tables || []).find((t) => (t.selector || '') === (merged.selector || ''))
          || (back?.tables || [])[0];
        if (mine && mine.rows.length >= merged.rows.length) {
          merged.rows = mine.rows;
          merged.cols = mine.cols;
          // AND ITS COLUMNS JOIN THE WALK'S OWN SET, which is the half I first left out.
          //
          // `merged.cols` is rebuilt each page from the keys the ROWS carry, and only rows arriving
          // that page are scanned for keys. So page two rebuilt the list's twenty columns and
          // dropped the twenty-five the record had just added — a narrower table than the one in
          // storage, which `save.keptWider` then refused, correctly. The walk kept reporting
          // 24, 36, 48 rows while the store still held twelve, and every later detail pass read
          // that stale twelve and found nothing new to do.
          for (const c of (mine.cols || [])) {
            colAt.set(c.key, true);
            if (c.name) colName.set(c.key, c.name);
            if (!pageOrder.includes(c.key)) pageOrder.push(c.key);
          }
        }
      }

      // A PAGE THAT HELD NOTHING NEW MIGHT BE A WALL, and the difference decides whether the
      // person is asked or merely told. A soft block does not answer with an empty page: it
      // keeps serving a list — the one already read, or the real one with a slider over it —
      // so the only outward sign is that nothing new arrived. Read as "the list ran out", it
      // ends the walk, reports "nothing new", and then drives the tab home, away from the
      // check the person needed to see. That is the "it stopped instead of waiting for me".
      if (!fresh) {
        const ch = await runRows(tabId, { action: 'challenge', stale: true }).catch(() => null);
        note('here.stale', { challenge: ch?.kind || '', word: ch?.word || '' });
        if (ch?.challenge) {
          // A SOFT BLOCK IS RE-READ, NOT SKIPPED. Here the site kept serving a list and put the
          // check over the top, so what we merged a moment ago is the page UNDER the slider — the
          // one already had. Once it clears, the real page is behind it and this page number has
          // to be read again, so the count it already took is given back before going round.
          if (await cleared(ch.kind || 'puzzle', true)) { read--; continue; }
          wall = ch.kind || 'puzzle'; why = 'verify'; break;
        }
        why = `page ${read} held nothing new`;
        break;
      }
      if (read >= max) { why = 'reached the limit'; break; }

      // Where next. The pointed control wins, as everywhere else; the numbering guess is the
      // fallback for pages nobody has pointed at.
      const tNext = Date.now();
      // A LEARNED DIAL OUTRANKS THE GUESS, because it is the one thing here that is not a guess.
      //
      // Until now the dial was learned, shown to the person, saved — and then nothing read it
      // back. Pressing "Read every page" studied the numbering and then ran an ordinary scan,
      // which is indistinguishable from the button doing nothing. This is the line that spends
      // it: the address of page n+1 is arithmetic, so there is no pager to find, no anchor to
      // need, and no next-link for a rebuilt list to lose.
      //
      // Still falls through to the detector when the dial cannot answer — it only knows pages
      // it can compute, and a site that stops before the number does is a real ending.
      // `read` IS ALREADY THE COUNT OF PAGES READ. It is incremented well above this point, so
      // after page one it is 1 and the page we want next is `read + 1`. Asking for `read + 2`
      // skipped one every time — on shopee's zero-indexed pager that put page one straight to
      // `?page=2`, which is its page THREE.
      let nx = null;
      if (dial) {
        const want = urlForPage(dial, read + 1);
        if (want && want !== at) {
          nx = { href: want, label: `page ${read + 1}`, page: read + 1, from: read,
            pointed: true, byDial: true };
        }
      }
      if (!nx) {
        nx = await runRows(tabId, { action: 'nextpage', nextSelector,
          ...(nameTier === false ? { nameTier: false } : {}) }).catch(() => null);
      }
      // AN ADDRESS THE CALLER GAVE, spent once. Only when the page itself offered nothing — a
      // pointed control that resolves outranks it, and after the first turn it would point
      // backwards.
      if (nextHref && read === 1 && (!nx || nx.none) && nextHref !== at) {
        nx = { href: nextHref, label: 'the address given as next', page: 2, from: 1, pointed: true };
      }
      const msNext = Date.now() - tNext;
      // AN ABSENT HREF IS NOT AN ABSENT NEXT PAGE — not on a provider we click through.
      //
      // `findNextPage` needs an anchor carrying the page number, and 2GIS's pager is a sliding
      // window with an ellipsis (`1 … 11 [12] 13 14 15 ‹ ›`) whose arrow is a `<div>` with no
      // href at all. So the walk reached page 12 and then reported "nothing on this page looked
      // like a link to a next one" while the list was still going and the arrow was on screen.
      //
      // For a click provider the URL was only ever a label; `clicknext` presses the number if it
      // is there and the arrow if it is not. So synthesise the target from where we actually are.
      //
      // AND ALWAYS, NOT ONLY WHEN THE HREF IS MISSING — which is the bug behind "pointing at the
      // pager works, and then no more rows arrive".
      //
      // A pointed next-page selector outranks every guess in `findNextPage`, and it reads the page
      // number OFF THE POINTED ELEMENT'S OWN HREF. That is right for a site whose pager is a fixed
      // "next" link and wrong for 2GIS, whose pager is a sliding window: point at the anchor
      // reading `2` on page one, walk to page two, and the anchor at that position now reads
      // something else. So the walk asks for a page it has already read, `clicknext` obligingly
      // presses it, the page brings nothing new, and the walk ends on `page N held nothing new`
      // with the list still going.
      //
      // On a provider we click through, WHERE WE ARE is the only trustworthy input — the click is
      // what moves us, and the pointed control is at best a label.
      //
      // The href is dropped rather than carried, because every use of it below assumes a page we
      // are about to NAVIGATE to: `nx.href === at` ends the walk as "that page pointed back at
      // itself", and `at = nx.href` records a position we never went to. On this path the tab is
      // moved by `clicknext` and nowhere else, so an href here is not a shortcut — it is a second,
      // wrong answer to the question `atpage` has just answered properly. The resume point is
      // unaffected: `at` is re-read from the tab at the top of every turn.
      // A pointed control needs no page number: it is pressed, and whether it worked is read off
      // the list itself. Asking `atpage` here would answer 1 forever on a site whose URL never
      // changes, and the walk would conclude it had stopped moving.
      // WHAT WE ARE GOING TO PRESS, decided once, from the freshest information available.
      //
      // `nextpage` has just run against the CURRENT document, so `nx.click` is the pager as it
      // exists on this page — which is the only version that can be clicked. A selector the person
      // pointed at is the fallback for controls the detector does not recognise.
      const clickTarget = nx?.click || nextClick || '';

      // A DECLARED CONTROL THAT SAID NO IS THE END, NOT A GAP TO GUESS ACROSS. The synthesis below
      // exists for a click provider whose pager the detector cannot read (2GIS's sliding window);
      // it must not run over a descriptor's own control that is on the page and disabled — that is
      // the site stating its last page in the one vocabulary that cannot be misread. Measured on
      // the Gmail fixture: "disabled — this is the last page" from `nextpage`, then a synthesised
      // "page 4" pressed and the walk ending on "page 4 is not in the pager". A control the person
      // pointed at still outranks it, as everywhere else.
      if (nx?.none && nx?.declared && !nextClick) {
        why = nx.why || 'no further pages';
        verdict = nx;
        break;
      }
      if (clickPager && !clickTarget) {
        const now = await runRows(tabId, { action: 'atpage' }).catch(() => null);
        if (now?.page) {
          nx = { href: '', label: nx?.label || 'next page',
            page: now.page + 1, from: now.page, pointed: !!nx?.pointed };
        }
      }
      // A POINTED CONTROL WITH NO DETECTED PAGER still needs somewhere to go. Merged rather than
      // replaced — the previous version assigned a fresh object here and threw away `nx.click` and
      // `nx.page` in the process, so the detector's answer was discarded the moment anyone pointed.
      if (nextClick && !nx?.click) {
        nx = { ...(nx || {}), href: '', label: nx?.label || 'next page', pointed: true };
      }
      // A CLICK TARGET IS AS GOOD AS AN HREF, and leaving it out of this guard is what made the
      // whole button-pager path unreachable: `nx.href` is empty for a pager, `clickPager` is false
      // on a site with no provider, so a perfectly good detected pager broke straight out with
      // "no further pages".
      if ((!nx?.href && !clickTarget && !clickPager) || nx?.error
          || (!clickTarget && !nx?.page && nx?.none)) {
        why = 'no further pages';
        if (nx?.none) verdict = nx;
        break;
      }
      if (nx.href && nx.href === at) { why = 'that page pointed back at itself'; break; }

      // Paced like a person turning a page, for the same reason as everywhere else: a burst is
      // what earns a wall, and this pass is the one the site can see most clearly.
      // PACED FOR THE REQUEST ACTUALLY BEING MADE. `pace()` is 1.2-3.4s, sized for pulling a whole
      // document from the origin — the thing a burst of which earns a wall. An in-app click
      // fetches one JSON payload the site was going to serve anyway, and the reference
      // implementation ships zero delay against this very site.
      const tPace = Date.now();
      await new Promise((r) => setTimeout(r, clickPager ? clickPace() : pace()));
      const msPace = Date.now() - tPace;
      if (cancelled()) { why = 'stopped'; break; }
      if (nx.href) { at = nx.href; wanted = nx.href; }
      say();
      const tNav = Date.now();
      // NAVIGATE, OR PRESS? On most sites these are the same thing. On 2GIS they are not: a
      // navigation to page six answers 302 back to page one — verified on five separate exit IPs,
      // which made a sixty-record ceiling look architectural — while pressing the pager's own
      // anchor walks on indefinitely. So the URL is still what NAMES the next page (`nextpage`
      // found it, and it is what a resume point is written from); the click is only how we GO
      // there. See the `clicknext` note in rows.js.
      let hopped = false;
      // PRESSED, AND JUDGED BY THE LIST RATHER THAN BY THE URL. A JavaScript pager may not touch
      // the address bar at all, so the only honest evidence that a page turned is that the rows
      // changed — which is exactly what `listMark` fingerprints.
      if (clickTarget) {
        // RE-DETECTED EVERY PAGE, not remembered from the first one. `nextpage` has just run
        // against the CURRENT document, so `nx.click` points at the pager as it exists now and
        // `nx.page` says which number to press — where a selector captured on page one describes
        // a DOM that a single-page app has since rebuilt. The pointed selector stays as the
        // fallback for controls the detector cannot recognise.
        const c = await runRows(tabId, { action: 'clicknext', selector: clickTarget, page: nx?.page })
          .catch(() => null);
        if (c?.clicked) {
          const was = c.mark || '';
          const wasUrl = c.before || '';
          // TWO WITNESSES, AND NEITHER IS TRUSTED ALONE.
          //
          // The rows are what we came for, so a changed fingerprint ends the wait immediately. The
          // address bar is the more RELIABLE witness — measured on blibli, the press moved the tab
          // to `?page=2&start=40` while the fingerprint sat on the footer's links — but it is also
          // the EARLIER one: a router commits the URL and re-renders afterwards, and returning on
          // the URL alone is how a walk reads page one twice and concludes the list ended.
          //
          // So a moved URL is remembered, not acted on. The loop keeps waiting for the rows; only
          // if they never visibly change does the URL carry the decision on its own — which is
          // exactly the case where the fingerprint is looking at page chrome and always will.
          let urlMoved = false;
          for (let waited = 0; waited < HERE_CLICK_MAX; waited += HERE_POLL_MS) {
            await new Promise((r) => setTimeout(r, HERE_POLL_MS));
            const now = await runRows(tabId, { action: 'atpage' }).catch(() => null);
            if (now?.href && wasUrl && now.href !== wasUrl) urlMoved = true;
            if (now?.mark && now.mark !== was) { hopped = true; break; }
          }
          if (!hopped && urlMoved) {
            hopped = true;
            note('here.urlOnly', { n: read,
              why: 'the address bar moved but the rows never looked different — trusting the URL' });
          }
          // THE PRESS THE PAGE IGNORED IS PRESSED AGAIN, FOR REAL. `clicknext` used `el.click()`,
          // which is not a trusted event, and a closure/jsaction control — Gmail's "Older" — runs
          // its handler only for a trusted one: measured, the same 50 rows before and after, and
          // the walk reading that as "this looks like the last page" on page one of 173. So when
          // the rows did not change and the engine told us where the control is, dispatch a real
          // mouse press there through the debugger and wait for the rows once more. Only on a
          // press that visibly did nothing, so a site whose pager answers a plain click never
          // pays the attach (and its yellow bar).
          if (!hopped && c.box && !c.box.onScreen) {
            note('here.noBox', { n: read, box: c.box,
              why: 'the control has no pressable box on screen, so no real press was made' });
          }
          if (!hopped && c.box && c.box.onScreen) {
            const real = await pressForReal(tabId, c.box).catch(() => false);
            if (real) {
              for (let waited = 0; waited < HERE_CLICK_MAX; waited += HERE_POLL_MS) {
                await new Promise((r) => setTimeout(r, HERE_POLL_MS));
                const now = await runRows(tabId, { action: 'atpage' }).catch(() => null);
                if (now?.mark && now.mark !== was) { hopped = true; break; }
              }
              note('here.pressedReal', { n: read, hopped, via: c.via || 'pointed', box: c.box,
                why: 'the page ignored a scripted click, so it was pressed as real input' });
            }
          }
          // The mark is logged because "nothing changed" and "we cannot tell whether anything
          // changed" look identical from the outside and have completely different fixes.
          const seenNow = await runRows(tabId, { action: 'atpage' }).catch(() => null);
          note(hopped ? 'here.pressed' : 'here.stuck', { n: read, via: c.via || 'pointed',
            was: (was || '').slice(0, 40), now: (seenNow?.mark || '').slice(0, 40),
            blind: !was && !seenNow?.mark });
        }
        if (!hopped) {
          // Disabled controls say so; a press that changed nothing is the end of the list, not a
          // failure to report as one.
          why = c?.why || 'pressing that control brought no new rows — this looks like the last page';
          break;
        }
      } else if (clickPager && nx.page) {
        const c = await runRows(tabId, { action: 'clicknext', page: nx.page }).catch(() => null);
        if (c?.clicked) {
          // POLLED, NOT SLEPT. A fixed 3.2s wait is paid in full on every page even when the
          // in-app router commits in a fraction of it — and it is fast, because nothing loads: it
          // swaps a list it has already fetched. `parser-2gis` waits on the site's own in-flight
          // request count for the same reason, and ships `delay_between_clicks = 0`.
          // BOTH FACTS, NOT JUST THE URL. The page number and the rows change at different
          // moments, and returning on the number alone re-read the previous page — see `atpage`.
          const was = c.mark || '';
          let now = null;
          for (let waited = 0; waited < HERE_CLICK_MAX; waited += HERE_POLL_MS) {
            await new Promise((r) => setTimeout(r, HERE_POLL_MS));
            now = await runRows(tabId, { action: 'atpage' }).catch(() => null);
            // A click that does not move us is the anti-bot bouncing us home, and that is NOT the
            // end of the list — reading it as one is how a 236-record run reports 60.
            if (now && now.page === nx.page && now.mark && now.mark !== was) break;
          }
          if (now && now.page === nx.page) {
            hopped = true;
            note('here.pressed', { page: nx.page, via: 'click' });
          } else {
            // THE BOUNCE IS THE INTERESTING LINE: the anti-bot sent us home, and that is NOT the
            // end of the list. Reading it as one is how a 236-record run reports 60.
            note('here.bounced', { wanted: nx.page, landed: now?.page ?? '?' });
          }
        }
        if (!hopped) { why = c?.why || 'the pager would not take us further'; break; }
      }
      if (!hopped) await chrome.tabs.update(tabId, { url: nx.href });
      // `waitForLoad` resolves either way — it reports nothing, by design, because a page that
      // never reaches `complete` may still have rendered its list. So nothing is concluded from
      // it: the list wait below and the next extraction are what decide whether this page
      // worked, and both already say so in the user's terms.
      //
      // AND IT IS SKIPPED ENTIRELY AFTER A CLICK, because there is no load to wait for. An in-app
      // router swaps the list and never touches the document lifecycle, so `waitForLoad` sits out
      // its full 25 SECONDS and reports nothing — per page. Measured on 2GIS: 29s to turn one
      // page, of which ~3s was the actual work. The run looked hung and was only waiting for an
      // event that could not arrive.
      if (!hopped) await waitForLoad(tabId, HERE_LOAD_MS, HERE_GRACE_MS);
      // `complete` is the document, not the list. A page that builds its list in the browser
      // answers `complete` with an empty container, so wait for rows the way every other pass
      // does rather than trusting the status.
      const msLoad = Date.now() - tNav;
      // WAIT FOR THE LIST TO SETTLE, NOT FOR IT TO EXIST.
      //
      // This loop used to break on `rows > 0` — the first card to mount ended the wait. On a
      // server-rendered list the first row and the last arrive together, so the two are the same
      // instant and amazon reads 16 of 16 on every page. On a framework that mounts progressively
      // they are not: measured on a shopee.co.id search, page one read 60 rows (it got the full
      // walk) and pages two and three read NINE, because nine is what had mounted when the first
      // card tripped this break. Page three then re-read page two's same nine, which is honestly
      // "no new rows", and the walk stopped at 69 of roughly 960.
      //
      // TWO CONDITIONS, because `rows > 0` is wrong in two different ways:
      //
      //   settled   the count has stopped climbing — two identical readings. Catches the PARTIAL
      //             render, where the list is the right one but half of it is still arriving.
      //   swapped   the first row is not the row the previous page opened with. Catches the STALE
      //             one, where an in-app router has not replaced the list yet and every row still
      //             on screen is a row we already have — `rows > 0` is true of that too.
      //
      // Bounded by `HERE_LIST_MS` as before, so a page that never settles costs the same as one
      // that never rendered. A constant grace cannot do this job: it is simultaneously too slow
      // for a server-rendered page and too fast for the next framework.
      // A PAUSE IS NOT AN ENDING, and the count alone cannot tell them apart.
      //
      // "Stopped climbing" was the first version of this and it is not enough: a grid that mounts
      // five cards, stalls, then mounts fifty-five more looks finished during the stall. Measured
      // on the shopee run this loop had already rescued from 69 rows to 378, the trail read
      // `60 . 5 . 60 . 60 . 60 . 60 . 60 . 60 . 5`. Seven pages whole, and two that settled on a
      // plateau of five. The last of those brought no new rows, so the walk stopped at page nine
      // of sixteen.
      //
      // The evidence needed is on the walk itself: earlier pages gave SIXTY, so five is not a
      // page. A pager serves a constant page size — that is what makes it a pager — so a settle
      // below half of the fullest page seen so far is not taken at face value; it has to hold for
      // considerably longer before it is believed.
      //
      // Not a refusal, because a genuine LAST page really is short and must still be read. It
      // costs that page about two extra seconds, once, at the end of a walk, and `HERE_LIST_MS`
      // still bounds the whole thing.
      const until = Date.now() + HERE_LIST_MS;
      let held = -1;
      let still = 0;
      let sig = '';
      // Did the wait END, or did it RUN OUT? Both used to leave this loop the same way, so a page
      // whose count was still moving at twelve seconds was merged like any other.
      let listSettled = false;
      const tList = Date.now();
      const floor = Math.floor(bestPage / 2);
      while (Date.now() < until && !cancelled()) {
        // `fresh` — re-detect each poll. Without it the first poll's choice (made before the list
        // painted) is what every later poll reports, and the wait settles on the sort bar.
        const n = await runRows(tabId, { action: 'container', fresh: true }).catch(() => null);
        const rows = n && !n.error ? (n.rows || 0) : 0;
        sig = n?.first || '';
        // No signature to compare on the first page, or a reader that could not produce one:
        // fall back to the count alone rather than waiting for a change that cannot be observed.
        const swapped = !lastFirst || !sig || sig !== lastFirst;
        if (rows > 0 && swapped) {
          // Two identical readings is enough for a page of a believable size; a suspiciously
          // short one has to stay short for about two and a half seconds.
          const enough = rows >= floor ? 2 : 6;
          if (rows === held) { if (++still >= enough) { listSettled = true; break; } } else { still = 0; held = rows; }
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      settleMsHere += Date.now() - tList;
      if (!listSettled && !cancelled()) {
        unsettledHere.push({ page: read + 1, rows: Math.max(0, held),
          why: `the list on page ${read + 1} had not held still after ${HERE_LIST_MS}ms (${Math.max(0, held)} rows at the cap)` });
      }
      if (held > bestPage) bestPage = held;
      if (sig) lastFirst = sig;
      note('here.list', { n: read, rows: held, ms: Date.now() - tNav - msLoad,
        first: (sig || '').slice(-40) });
      // The four costs of turning one page, kept apart so the slow one can be named.
      note('here.turn', { n: read, msWalk, msSave, msNext, msPace, msLoad,
        msList: Date.now() - tNav - msLoad, msPage: Date.now() - tPage });
    }
    // ASKED BEFORE THE TAB IS PUT BACK, because it is a question about the last page read and the
    // restore below navigates away from it. Not on a wall or a stop: the page in front of us then
    // is the site's check or a half-read list, and a load-more seen there says nothing.
    if (!wall && !blind && why !== 'stopped' && read > 0) {
      const g = await runRows(tabId, { action: 'growable' }).catch(() => null);
      if (g && g.selector && !g.none && !g.error) growable = { selector: g.selector, label: g.label || '' };
      note('here.growable', { found: !!growable, label: growable?.label || '', via: g?.via || '' });
    }
  } catch (e) {
    why = `the walk stopped: ${String(e.message || e).slice(0, 60)}`;
  } finally {
    // THE COUNTER ARRIVES WHERE THE SUMMARY STARTS, and until this line it did not.
    //
    // The published figure only moved when a page's rows were MERGED, and the last merge is
    // followed immediately by the exit — so the final total existed for a few hundred
    // milliseconds, often less than one turn of the panel's half-second poll. What a person
    // watching actually saw was the card stop at the second-to-last page and the summary open on
    // a bigger number: reported from a live etsy run as "126 rows added · 2 pages" handing over
    // to "190 more rows from 3 pages", which reads as rows being lost at the finish.
    //
    // Published here, BEFORE the restore, so the true total stands for the whole tail — putting
    // the tab back is a real navigation and the slowest part of it. `test/kept.mjs` samples the
    // status for the length of a walk and asserts the last reading is the one the summary opens
    // with; before this it read 23/2 against a summary of 35/3.
    reading = null; waiting = null;
    try { say(); } catch (_) {}
    // GIVEN BACK, on every path out — a stop, a wall, a throw. Except on a wall: the page the
    // site put up is the page the person needs to see, and navigating away from it would take
    // away the only thing they can act on.
    //
    // THE SESSION IS KEPT ON EVERY PATH, INCLUDING THE WALL — and it was the `!wall` on this block
    // that cost it. The restore is what this guard is for and the restore is what it should skip;
    // carrying the visit is not, and a wall is the navigation that needs it most, because the site
    // replaced the document to put its check up. Without it the passive poll two seconds later
    // minted a new visit, the run's rows were stranded under the old one, and the person came back
    // from the slider to an empty table. Measured: 36 rows read, 0 in the table, 3 history rows for
    // one run. See `test/wall-session.mjs`.
    // `wall || blind`, and the `blind` half is the eBay case. eBay answered the next page with an
    // interstitial whose wording matches no list we carry, so `challenged()` said false, so this
    // hold did not run — and the run came apart into FOUR history rows: 60 in the first, the 273
    // the walk then read in the third, and "Open results" opening a fourth that held 60. The rows
    // were never lost, they were filed under a visit nothing pointed at. Reported as "the list
    // never got appended"; measured in `test/blindwall.mjs`.
    //
    // Holding by URL is what makes this work where the restore below does not: `holdSession`
    // writes URLs and `sessionFor` matches them WITHOUT the document token, which is the one
    // thing guaranteed to be gone after a site swaps the page under us.
    if (start && (wall || blind)) {
      // Held by URL rather than by document, because the person's own navigation is still to come.
      try {
        const on = await chrome.tabs.get(tabId).then((t) => t.url).catch(() => at);
        await holdSession(tabId, sid, [start, at, on]);
      } catch (_) {}
    }
    if (back && !wall) {
      try {
        const now = (await chrome.tabs.get(tabId)).url;
        if (now !== back) { await chrome.tabs.update(tabId, { url: back }); await waitForLoad(tabId, HERE_LOAD_MS, HERE_GRACE_MS); }
        // AND THE RUN COMES BACK WITH IT. That navigation replaces the document, so the token
        // `sessionFor` keys on is gone and the next save mints a NEW visit — measured, twenty
        // milliseconds after a 115-row walk finished, and every record the detail pass then read
        // was filed against a thirteen-row record that had just been created. See `keepSession`.
        // Written INSIDE the finally, before `here.end`, so it lands ahead of the passive poll.
        // Keyed on the address the tab now HOLDS, or the next save mints a fresh visit against
        // a document that is not there — the same fault this line was added to prevent.
        await keepSession(tabId, back, sid);
      } catch (_) {}
    }
    // LAST, NOT FIRST — the walk still owns the visit while it is putting the tab back.
    //
    // This used to be the opening line of the `finally`, which handed the visit up for grabs
    // across the whole restore: a `tabs.update` plus a full page load, seconds during which the
    // tab is on a document nobody has claimed. A poll landing in that window minted a visit of
    // its own — measured by `test/kept.mjs`, which asks `sessionFor` every 250ms for the length
    // of a walk and got two answers where there is one run. `keepSession` above cannot help,
    // because it has not run yet; that is the point of the window.
    hopProgress.delete(tabId);
  }
  note('here.end', { pages: read, rows: merged.rows.length, why, wall });
  if (DEV && devLog) saveLog().catch(() => {});
  return {
    added: merged.rows.length, pages: read, why, wall, via: 'here', id: lastId, trail,
    // SAID, NOT SWALLOWED. Absent when nothing was dropped, so a reply that carries it is always
    // news. The reason is written for someone deciding whether to believe the row count.
    ...((dropped.repeats + dropped.copies) ? { dropped: {
      n: dropped.repeats + dropped.copies,
      reason: [
        dropped.repeats ? `${dropped.repeats} row(s) were a record already taken — the same links `
          + 'and the same main text as an earlier row, which is a page serving a row again '
          + '(overlapping pages, a pager that loops, an advert repeating a result)' : '',
        dropped.copies ? `${dropped.copies} row(s) were identical in every cell to another row on `
          + 'the same page' : '',
      ].filter(Boolean).join('; ') + '. They are repeats, not rows that failed to read.',
      ...(dropped.sample.length ? { sample: dropped.sample.slice() } : {}),
    } } : {}),
    stopped: why === 'stopped',
    detailed: detailedHere,
    // THE CAP IS NOT SWALLOWED. Which pages' list waits ran out of budget rather than ending, and
    // what the waits cost in all — `run.status` folds these into the reply's `page` header.
    unsettled: unsettledHere, settleMs: settleMsHere,
    // Where it stopped, so "Continue" can pick up from the page the person just cleared.
    resumeFrom: wall ? at : null,
    home: start,
    sawRows: merged.rows.length > 0,
    // ONLY WHEN IT ENDED FOR WANT OF A NEXT PAGE — the names are the contract's
    // (research/CONTRACT-2026-09-22.md). A walk that hit its limit or a wall did not judge the
    // pager at all, and near misses beside that would read as a reason it never gave.
    ...(verdict ? { saw: verdict.saw || {}, nearMisses: (verdict.nearMisses || []).slice(0, 5),
      override: verdict.override || '' } : {}),
    ...(growable ? { growable } : {}),
  };
}

// Asks the page what it is looking at, hops the following pages, and hands the rows back
// to the page so they land in the same table as its own.
//
// `visible` picks the pass: false loads each page in a hidden tab and reads it without
// scrolling — free, unseen, and enough for any list built on load; true opens a window in
// front and walks it, which is the only way to reach a list that appears only when
// scrolled. The panel tries the quiet one first and asks before the other.
export async function hopThroughTabs({ tabId, from, nextSelector, visible = false, driven = false }) {
  note('pass', { kind: driven ? 'driven' : visible ? 'window' : 'hidden', from: (from || '').slice(0, 90) });
  // Refused before anything is opened. Escalating to a heavier pass at a site that has just
  // asked for verification is the exact move that turns a slider into a block, and the
  // ladder is built to escalate — so the brake belongs here, in front of all of it.
  const cooling = walledUntil(from || '');
  if (cooling) {
    note('pass.cooling', { mins: Math.ceil(cooling / 60000) });
    return { error: 'COOLING', cooling, added: 0, pages: 0, why: 'the site asked for verification' };
  }
  // A timestamp, compared against when this hop began — not a flag cleared on start.
  // Clearing meant a Stop pressed in the gap between one pass giving up and the next
  // beginning was simply forgotten, and the pages opened anyway.
  const since = Date.now();
  const info = await runRows(tabId, { action: 'container', nextSelector });
  if (!info || info.error) {
    note('pass.no-container', { err: info?.error || 'NOT_DETECTED' });
    return { error: info?.error || 'NOT_DETECTED', added: 0, pages: 0 };
  }
  note('pass.container', { rows: info.rows, next: (info.next || 'none').slice(0, 90) });
  const start = from || info.next;
  if (!start) return { error: 'NO_NEXT', added: 0, pages: 0 };
  const got = await hopTabs(tabId,
    { selector: info.selector, from: start, nextSelector, visible, since, driven });
  const halted = got.why === 'stopped';
  // Nothing to save here: each page committed itself as it landed, which is what makes a
  // stop keep its rows and the table grow while the hop is still running.
  return { added: got.added, pages: got.pages, why: got.why, via: got.via, id: got.id,
    stopped: halted, trail: got.trail, pics: got.pics };
}
