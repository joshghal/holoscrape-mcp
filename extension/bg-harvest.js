// HoloScrape — service worker: page_harvest — following a list into its records, in lanes, without
// the model in the loop.
// What state the page was in when it was read, and the one rule for "is it ready" — see settle.js.
import { settle, pageProbe, pageHeader, netTrack, armNav, sameDocument, SETTLE } from './settle.js';
import { laneTabs } from './bg-state.js';
import { note } from './bg-log.js';
import { runRows } from './bg-rows.js';
import { cdpHold, cdpRelease, withVisibleTab } from './bg-cdp.js';
import { netOpen, netReset, netTake, netClose } from './bg-net.js';
import { HISTORY_MAX, newId, normUrl } from './bg-store.js';

// FOLLOWING A LIST INTO ITS RECORDS, WITHOUT THE MODEL IN THE LOOP.
//
// Measured on a 250-film cast scrape driven by five agents: 52m33s, 733 tool calls. Splitting the
// gaps by which tool preceded them gave the number this exists for — the BROWSER was 17% of it, and
// ~80% was the model reading rows out of one call and typing them into the next. 164 of those calls
// were file appends that existed only because the model was the thing holding the data.
//
// The lane driver beside this one already does the same job for maps in two calls, because there the
// extension iterates. It is not reachable for anything else, for two reasons: it reads ONE record
// per page (`readPlace`), and it merges that record into the list row it came from. A cast is
// neither — 79 rows that belong to no column.
//
// So this iterates in the worker, extracts with `harvest.js` (which is provider-agnostic and tries
// schema.org before any selector), accumulates in the extension, and hands back a resultId. The
// agent makes one call and never sees a row. Pure browser cost is what is left: 250 pages across 5
// lanes at ~5s is about four minutes, which is the whole budget.
const HARVEST_LANES = 5;
const HARVEST_NAV_MS = 25000;
// A run that is being turned away should say so in seconds, not grind through the whole queue at the
// full patient budget. GIVE_UP_SOON shortens the wait once the refusals start; GIVE_UP_AFTER ends
// the run. Both count CONSECUTIVE misses, reset by any page that reads — one bad link in a list is
// ordinary, five in a row is an answer.
const HARVEST_GIVE_UP_MS = 6000;
const GIVE_UP_SOON = 2;
const GIVE_UP_AFTER = 5;
// A CLIENT-RENDERED PAGE IS NOT A REFUSAL, AND ONE READ CANNOT TELL THEM APART.
//
// `waitForLoad` answers when the DOCUMENT is complete. On a storefront or any app that paints from
// JavaScript, complete is the shell: a header, a spinner, and none of the fields that were asked
// for. The read lands there, returns `thin`, and the page is filed as a failure — identical in the
// reply to a challenge page. Measured on a Tokopedia product listing: `page_harvest` returned
// `pages: 3, read: 0`, all three thin, and the SAME url read fine through `page_state` three calls
// later. Nothing was blocking it; the read was early.
//
// So a thin first read buys ONE more look after a short settle, and nothing else changes: the same
// spec, the same tab, no reload, no extra request against the site. The cost is bounded — it is
// paid only on pages that already returned nothing, and at most GIVE_UP_AFTER times before the run
// ends anyway. Pages that needed it are counted, because a queue where most pages read late is a
// fact about the site the caller should be told.
//
// THE SETTLE USED TO BE A NUMBER — `HARVEST_SETTLE_MS = 1500` — AND IT WAS WRONG IN BOTH DIRECTIONS
// AT ONCE. Measured in test/settle-shared.mjs on the old code: a record page whose reviews mount
// when a 2.5 s request answers was re-read at 1.5 s and filed as "read fine, no rows" (3 of 3
// pages, `late: 0`); a page complete at load that simply HAS no reviews slept the full 1.5 s anyway
// (1,695 ms a page, six pages, 10.2 s). It is now `settle()` in settle.js: the requests this
// navigation started have finished, nodes have stopped arriving, and the read itself is the final
// word. The 1500 survives in exactly one place, as SETTLE.PATIENCE_MS — see the note there.

// The extractor, injected and then called. Two steps rather than one `func`, because a function
// handed to `executeScript` is serialised without its closure — `readHarvest` calls half a dozen
// helpers, and none of them would travel.
async function harvestRead(tabId, spec) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['harvest-inject.js'] });
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (s) => globalThis.__hsHarvest.readHarvest(document, s),
    args: [spec],
  });
  return r?.result || null;
}

// The links a list is pointing at, read once, in the page. The alternative is the agent typing 250
// URLs into a tool call — about 12KB of the exact output this whole change exists to delete.
export async function harvestLinks(tabId, sel) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (css) => {
      let els = [];
      try { els = [...document.querySelectorAll(css)]; } catch (_) { return []; }
      return els.map((a) => String(a.href || '')).filter((h) => /^https?:/.test(h));
    },
    args: [sel],
  });
  // DE-DUPLICATED BY THE PAGE, NOT BY THE QUERY STRING.
  //
  // In order, because a chart links the same title from its poster and its heading and reading a
  // film twice is a minute of someone's afternoon. But a raw Set over full hrefs does not catch the
  // case that actually matters on a storefront: the SAME product appears in an ad slot and again
  // organically, with different tracking parameters — `?extParam=…&search_id=…` — so the two look
  // like two products and get opened twice. Measured on a live Tokopedia search: an ad slot whose
  // slug named a laptop resolved to the same page as an organic phone listing.
  //
  // Identity is origin+pathname, the same rule `rowIdent` uses for rows, so the two halves of a job
  // agree about what "the same item" is. The FIRST full url wins, keeping whatever parameters the
  // page actually navigates with — only the duplicate is dropped, never the parameters.
  const seen = new Set();
  const out = [];
  for (const h of (r?.result || [])) {
    let id = h;
    try { const u = new URL(h); id = `${u.origin}${u.pathname}`; } catch (_) { /* keep raw */ }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(h);
  }
  return out;
}

// WHERE A LANE LIVES: A BACKGROUND TAB, OR — IF THE PERSON ASKED — A SMALL WINDOW OF ITS OWN.
//
// Measured headed, no launch flags, nothing attached to the pages, on Google Chrome 153.0.8010.48
// and Chrome for Testing 151.0.7922.34, macOS 15.7.3, with a fixture whose sections mount ONLY from
// an IntersectionObserver and whose counter advances ONLY from requestAnimationFrame
// (`probe/work-window.mjs`, table in `research/WORK-WINDOW-EXPERIMENT.md`):
//
//   a background tab of the focused window              hidden,  0 frames / 3s,  0 of 5 sections
//   the ACTIVE tab of a small window we own, unfocused  visible, 360 frames,     5 of 5 in 45ms
//     half covered, or another application in front     the same
//     FULLY covered by another application              hidden,  0 frames,       0 of 5
//     fully covered by another window of this Chrome    visible for ~100-300ms after each load, then hidden
//     minimised after it was shown                      hidden,  0 frames,       0 of 5
//     CREATED minimised                                 visible, ~6 frames / 3s, 5 of 5 in ~1.0s
//   one window holding six tabs                         only its one active tab paints
//   six small windows tiled / six stacked on one spot   all six paint / only the top one does
//
// So a window helps exactly as long as some of it is showing, and parallel lanes mean ONE WINDOW
// PER LANE, laid out so none can sit wholly behind a sibling. It does NOT replace the hold in
// `withVisibleTab`: the same run measured focus emulation giving a background tab real visibility
// (visible, 355 frames, 5 of 5 in 79ms) and keeping a fully covered window painting — the two are
// complementary. The window is what still paints when the debugger cannot attach (DevTools open on
// the lane, a managed Chrome that blocks it); the hold is what still paints when the window is
// covered. Hence opt-in, default OFF: windows appearing on someone's desk is theirs to choose.
//
//   chrome.storage.local `laneWindow`:  absent / anything else   background tabs, as always
//                                       'window'                  one small unfocused popup per lane
//                                       'minimized'               one popup per lane, created minimised.
//                                                                 EXPERIMENTAL: it rests on Chrome not
//                                                                 telling a never-shown window it is
//                                                                 hidden, which nothing documents.
const LANE_WINDOW_MODES = new Set(['off', 'window', 'minimized']);
// THE DEFAULT IS NEITHER. It is `auto`: background tabs while the hold can attach, one window per
// lane the moment it cannot. Measured with the real `harvest()`, 3 lanes, the whole screen under
// another application: hold available, background tabs 12 of 12; hold made to fail, background
// tabs 0 of 6 and lane windows 6 of 6 uncovered. Nobody should have to know a setting exists to
// get the second number instead of the first — DevTools open on a lane, or a managed Chrome that
// blocks `debugger.attach` (policy from Chrome 155), is exactly when a person is least likely to
// go looking for one. The probe costs one attach on the first lane, which the lane was about to
// pay anyway.
// Small on purpose — it is a worker, not something to read. The page does not lay out at this
// size while the hold is on (`cdpPrepare` gives it 1440x900); without the hold it does, and a site
// may then serve its narrow layout. That trade is stated in the write-up rather than hidden by
// opening desktop-sized windows on someone's screen.
const LANE_WIN = { width: 420, height: 320, left: 24, top: 96, step: 56 };

async function laneWindowMode() {
  try {
    const { laneWindow } = await chrome.storage.local.get('laneWindow');
    return LANE_WINDOW_MODES.has(laneWindow) ? laneWindow : 'auto';
  } catch (_) { return 'auto'; }
}

// Can a debugger session be held on this tab at all? Borrowed and released at once, through the
// same refcounted `cdpHold` the lane will use, so a hold somebody else already has is not
// disturbed and a `false` here is the same failure the lane would have met a moment later.
async function holdAvailable(tabId) {
  const target = { tabId };
  try { await cdpHold(target); } catch (_) { return false; }
  await cdpRelease(target).catch(() => {});
  return true;
}

// Opens lane number `i` and returns its tab id. Closing that tab closes a lane window with it (a
// popup cannot outlive its only tab), so every existing clean-up path — the run's own `finally`,
// `abandon`, the panel closing — needs no knowledge of which kind of lane it is closing.
async function openLaneTab(i, mode) {
  if (mode === 'window' || mode === 'minimized') {
    try {
      const w = await chrome.windows.create(mode === 'minimized'
        // `state` cannot be combined with bounds or `focused`; Chrome refuses the call.
        ? { type: 'popup', url: 'about:blank', state: 'minimized' }
        : { type: 'popup', url: 'about:blank', focused: false, width: LANE_WIN.width, height: LANE_WIN.height,
          // A diagonal cascade: every window keeps a strip of its own showing whatever the others
          // do. Identical bounds is the measured failure — five of six stacked lanes went hidden.
          left: LANE_WIN.left + i * LANE_WIN.step, top: LANE_WIN.top + i * LANE_WIN.step });
      const id = w?.tabs?.[0]?.id;
      if (id) { note('lanes.window', { lane: i, mode, window: w.id }); return id; }
    } catch (e) {
      // A window that cannot be opened must not cost the run: fall back to what always worked.
      note('lanes.windowFailed', { lane: i, mode, why: String(e?.message || e).slice(0, 120) });
    }
  }
  return (await chrome.tabs.create({ url: 'about:blank', active: false })).id;
}

// `shouldStop` IS THE ONLY WAY TO END A BACKGROUNDED HARVEST, AND IT DID NOT EXIST.
//
// `run.stop` called `stopScan(rec.tabId)`, which stops a page WALK on a list tab. A harvest owns
// no list tab — its `tabId` is routinely 0 — so stopping one did nothing at all while returning
// `{stopping: true}`. Measured with five agents on one browser: a coordinator stopped run_3,
// believed it, started a replacement, and did that five times; every stopped run kept driving its
// lanes, and the person counted 23 tabs against the five they asked for. A stop that reports
// success and changes nothing is worse than no stop, because it is acted upon.
// `awaitFor` REPLACES A GUESSED SETTLE WITH A NAMED CONDITION, PER PAGE.
//
// The settle that follows a thin read is evidence-based now (settle.js), but it still cannot know
// WHICH node the caller is waiting for. It used to be a flat 1500 ms, and that was a bet: too short
// for a slow page, paid by every fast one.
// Measured with four agents on the same 120 products, same selector, same code — two got five
// reviews on every product and two got none on four of five. The pages were not different; the
// timing was. A caller who knows what they are waiting for ("the review list", "the spinner gone")
// can say so, and then no page waits longer than it has to and none is read too early.
//
// Same grammar as the `@await` path, because it IS that path: `<css> :: <mode> :: <ms>`.
export async function harvest({ tabId = 0, urls = [], links = '', record = null, rows = null,
  lanes = 0, limit = 0, network = '', matched = 0, from = 0, onTick = null,
  shouldStop = null, awaitFor = '' } = {}) {
  let queue = (urls || []).filter((u) => /^https?:/.test(String(u)));
  if (!queue.length && links && tabId) queue = await harvestLinks(tabId, links).catch(() => []);
  const found = matched || queue.length;
  if (limit > 0) queue = queue.slice(0, limit);
  if (!queue.length) {
    return { error: links ? `no links matched "${links}" on that page` : 'no urls to harvest' };
  }

  const spec = { record: record || null, rows: rows || null };
  const n = Math.max(1, Math.min(lanes > 0 ? lanes : HARVEST_LANES, queue.length));
  const out = [];
  const failed = [];
  let capped = false;
  let done = 0;
  let walled = false;
  let refused = false;
  let misses = 0;
  // How many pages needed the settle-and-look-again. Zero is a server-rendered site; a queue where
  // most pages land here is client-rendered, and worth saying out loud rather than absorbing.
  let late = 0;
  // WHAT STATE THE PAGES WERE IN WHEN THEY WERE READ, kept per run because a lane tab is a
  // background tab BY CONSTRUCTION — `active: false` — which is exactly where Chrome stops painting.
  // Measured on shopee.co.id: 0 of 20 record pages populated in lanes, `failedCount: 0`, with
  // `withVisibleTab` applied. The hold did not fix it and nothing said so; this is the saying so.
  const env = { probed: 0, hidden: 0, noFrames: 0, settles: 0, settleMs: 0, settleMaxMs: 0, unsettled: [], blind: [] };
  // A site that keeps one request open for ever (a long-poll, a streamed fetch) makes "the network
  // went quiet" unanswerable, and every thin page would then sit out the whole ceiling. Learned per
  // run, from the run's own evidence, and bounded: two ceilings spent on nothing but the network
  // and the network stops being asked.
  let netUseless = 0;
  let substituted = 0;            // pages where ld+json stood in for a named path
  const missedPaths = new Map();  // named path -> how many pages it matched nothing on
  // Pages whose capture found no matching response, and the first reason capture was unavailable.
  // Both are reported: a filter that matches nothing is the commonest mistake with this parameter,
  // and it is indistinguishable from an empty site unless the reply says so.
  let netMissed = 0;
  let netWhy = '';
  // A PAGE THAT READ FINE AND MATCHED NO ROWS IS NOT A FAILURE, AND IS NOT NOTHING EITHER.
  //
  // A film with no cast listed and a film whose cast selector is wrong look identical from here:
  // both give a good header and an empty row group. Calling them failures would be false — the page
  // was read — and staying silent is how a selector that matched on the pilot and nothing else
  // returns "250 pages" with a tenth of the rows and no hint why. So they are counted and reported.
  let noRows = 0;
  // ROWS MADE SO FAR, COUNTED AS THEY ARE MADE. `out` is not filled until every lane has finished —
  // the slots are flattened at the end to keep the table in the list's order — so a progress tick
  // that reads `out.length` reports 0 for the entire run and the true figure only in the final
  // reply. Measured on a live run: `rowsSoFar: 0` at 13%, 38%, 50%, 75%, 88%, then 35 at `done`,
  // which reads as "it is finding nothing" right up until it isn't. The earlier version of this
  // line reported `done`, i.e. the PAGE count labelled as rows, which was wrong in the other
  // direction. Neither is the number; this is.
  let made = 0;

  const tabs = [];
  const nets = new Map();
  // Registered BEFORE the first lane exists and filled as they open, the way the details lanes do
  // it: opening a window takes longer than opening a tab, and a panel closed while the second lane
  // is still being set up has to be able to close the first.
  let laneMode = await laneWindowMode();
  const laneAsked = laneMode;
  let laneHeld = true;
  for (let i = 0; i < n; i++) {
    let t;
    if (i === 0 && laneMode === 'auto') {
      // Decided once, on the first lane, for the whole run: a tab is opened as always and the hold
      // is tried on it. If it takes, every lane is a tab (the proven arrangement). If it does not,
      // that tab goes and every lane is a window instead — the only arrangement measured to paint
      // without the hold.
      t = { id: (await chrome.tabs.create({ url: 'about:blank', active: false })).id };
      if (await holdAvailable(t.id)) laneMode = 'off';
      else {
        laneHeld = false;
        await chrome.tabs.remove(t.id).catch(() => {});
        laneMode = 'window';
        note('lanes.fallback', { why: 'the debugger cannot attach on this browser; lanes open as windows' });
        t = { id: await openLaneTab(i, laneMode) };
      }
    } else {
      t = { id: await openLaneTab(i, laneMode) };
    }
    tabs.push(t.id);
    if (i === 0) laneTabs.set(tabId || tabs[0], { tabs, targets: [] });
    // ATTACHED ONCE PER LANE, BEFORE ANY NAVIGATION. Per-page attach/detach flickers the debugging
    // banner on every page and costs a round trip each time; the lane pattern elsewhere in this
    // file already settled that. A lane that cannot attach still runs — DOM-only — because failing
    // the whole harvest over an unavailable debugger would make one open DevTools window fatal.
    if (network) {
      const st = await netOpen(t.id, String(network));
      nets.set(t.id, st);
      if (st.why && !netWhy) netWhy = st.why;
    }
  }
  // (Registered above, the moment the first one exists, so a panel closed mid-run still closes
  // them. Every tab this opens is one the person would otherwise close by hand.)

  // IN THE ORDER THEY WERE ASKED FOR, NOT THE ORDER THEY FINISHED.
  //
  // Five lanes finish out of order by nature — a film with a short page overtakes the one queued
  // before it — so appending as they arrive shuffles the table against the list it came from. That
  // is a real cost to the reader: the whole point of harvesting a ranked chart is that row 1 is
  // rank 1. Each page writes into its own slot and the slots are flattened at the end, which costs
  // one array and makes the output deterministic.
  // THE RUN'S PAGE HEADER: the contract's shape, summed over lanes. `hidden`/`frames` are the WORST
  // seen, because one lane reading blind is a table with holes in it; `settleMs` is the total spent
  // settling across every page (lanes overlap, so it is a cost, not a duration).
  const pageSoFar = () => {
    const why = [];
    if (env.noFrames) {
      why.push(`${env.noFrames} of ${env.probed} record pages were read in a tab that was NOT PAINTING `
        + `(${env.hidden} reported hidden; no animation frame ran). Lanes are background tabs, and Chrome runs no `
        + 'observers, frames or paint there — content that mounts lazily (reviews, descriptions below the fold, '
        + 'anything on view or on scroll) may be MISSING from those rows even though they read. Treat empty fields '
        + 'as unread, not as absent.');
    }
    if (env.unsettled.length) {
      why.push(`${env.unsettled.length} page(s) hit the settle ceiling and were read while still changing — `
        + `first: ${env.unsettled[0].why}`);
    }
    if (netUseless >= 2) {
      why.push('this site keeps a request open for ever, so after two ceilings the network was no longer waited on.');
    }
    return {
      hidden: env.hidden > 0,
      frames: env.probed ? env.noFrames === 0 : null,
      settled: env.unsettled.length === 0,
      settleMs: env.settleMs,
      ...(why.length ? { why: why.join(' ') } : {}),
    };
  };
  const bucket = new Array(queue.length);
  const next = (() => { let i = 0; return () => (i < queue.length ? { url: queue[i], i: i++ } : null); })();

  // HELD VISIBLE FOR THE LANE'S WHOLE LIFE, not per page. A lane tab is created with
  // `active: false` and is therefore a tab nobody is looking at by construction — which is exactly
  // the state in which Chrome stops running observers, rAF and the paint lifecycle. Every detail
  // page this pass has ever read was read in that state: a product page whose reviews mount from
  // an observer handed back four copies of the site's schema.org boilerplate and `failedCount: 0`,
  // and the run was reported as a success. Once per lane rather than once per page for the same
  // reason the network attach above is: the banner should appear once and the round trip should be
  // paid once. See the dispatch wrapper in bridge-ops.js for the measurement this comes from.
  const lane = async (tid) => withVisibleTab(tid, async (held) => {
    // BORROWED FROM THE HOLD THIS LANE ALREADY HAS. `withVisibleTab` attached the debugger and
    // `cdpHold` enabled the Network domain, so the events are already flowing; this only listens.
    // A lane that could not attach settles on the page's own evidence instead (settle.js).
    const track = held ? netTrack(tid) : null;
    let painting = true;
    try {
    for (let job = next(); job; job = next()) {
      const { url, i: slot } = job;
      // Checked HERE, at the top of each page, rather than only between batches: a stop asked for
      // mid-run should cost at most one more page load, not the rest of the queue.
      if (walled || refused || (shouldStop && shouldStop())) return;
      try {
        if (network) netReset(nets.get(tid));
        // CAUSAL: only what THIS navigation starts is waited for. Armed before the navigation for
        // the reason the listener below is — an event that fires first is an event never seen.
        if (track) track.reset();
        const nav = armNav(tid);
        const was = (await chrome.tabs.get(tid).catch(() => null))?.url || '';
        await chrome.tabs.update(tid, { url });
        // A SITE THAT HAS ALREADY REFUSED FIVE IN A ROW IS REFUSING, AND WAITING LONGER IS THE
        // BEHAVIOUR THAT TURNS THROTTLING INTO A BLOCK. Once the run is clearly being turned away,
        // stop giving each page the full patient budget — the budget exists for a slow page, not
        // for a door that is shut.
        //
        // The budgets are the ones this pass has always used. What changed is that running out of
        // one is no longer silent: `waitForLoad` resolved identically on `complete` and on its
        // timeout, so a page still loading at the cap was read and filed like any other.
        const navd = await nav.wait({ certain: !sameDocument(was, url),
          capMs: misses >= GIVE_UP_SOON ? HARVEST_GIVE_UP_MS : HARVEST_NAV_MS });
        // IS THIS LANE PAINTING? One injection, a frame's worth of time on a tab that is; it also
        // starts the mutation and resource counters the settle below reads, so by the time a thin
        // read asks "has it gone quiet" the watch has already been running for the length of that
        // read. A lane that has measured `frames:false` once is the same tab in the same window on
        // its next page, so it is re-asked on the short bound rather than paying the long one
        // per page.
        const probe = await pageProbe(tid, { boundMs: painting ? SETTLE.FRAME_BOUND_MS : SETTLE.FRAME_REBOUND_MS });
        if (probe) {
          painting = !!probe.frames;
          env.probed++;
          if (probe.hidden) env.hidden++;
          if (!probe.frames) env.noFrames++;
        }
        let st = navd.loaded ? null : { settled: false, settleMs: navd.ms,
          why: `the document had not finished loading after ${navd.ms}ms` };
        // BEFORE the network is taken and before the first read: the condition is what says the
        // page is ready, so everything downstream should happen after it, not alongside it.
        //
        // NOT INSTEAD OF `waitForLoad`, AND THAT WAS TRIED. Skipping the load event and reading
        // the moment a named condition was met would cut a Shopee product page from 15-20s to
        // roughly its first packet, because the description ships in `<head>`. It was reverted
        // unrun: it changes when EVERY descriptor-driven harvest reads, there is no fixture for
        // it, and a local fixture cannot tell "read at first byte" from "read after load" because
        // it serves both in the same millisecond. The saving is real and so is the risk of
        // reading a half-built page; proving it needs a live run, not an argument.
        if (awaitFor) {
          await runRows(tid, { action: 'state', path: `@await(${awaitFor})` }).catch(() => null);
        }
        // The captured payload belongs to THIS page, so the spec is rebuilt per page rather than
        // shared — five lanes writing `net` into one object is five pages' JSON in whichever order
        // they happened to finish.
        const net = network ? await netTake(nets.get(tid)) : null;
        if (net?.why && !netWhy) netWhy = net.why;
        if (network && !net?.bodies.length) netMissed++;
        const pageSpec = net ? { ...spec, net: net.bodies } : spec;
        let got = await harvestRead(tid, pageSpec);
        // A PAGE THAT ANSWERED WITH SOMETHING ELSE IS AS EMPTY AS ONE THAT DID NOT ANSWER.
        //
        // This used to read `!got || got.thin`, and `thin` means NO rows. Measured on
        // shopee.com.br, asked for `$.items` off the search API: every page returned exactly ONE
        // row — the site's schema.org `WebSite` object, `@type` / `name` / `potentialAction` /
        // `sameAs` — which is boilerplate present on every page of the site before the app has
        // painted anything. One row is not thin, so the settle retry never ran, and the run
        // finished `pages: 4, rows: 4, failedCount: 0` over four copies of a search-box
        // declaration. The caller asked for products and was told it succeeded.
        //
        // The engine already knew: `missed` names the paths that matched nothing, `substituted`
        // says the columns came from somewhere the caller never named, and `netMissed` counts a
        // filter that caught nothing. All three were set and none of them were allowed to mean
        // "look again". They mean it now — the retry is the same one, on the same tab, with no
        // extra request against the site, and it is exactly the case it was built for: the read
        // was early.
        const wrongAnswer = !!got && !got.thin
          && (got.substituted || !!got.missed?.length || (network && !net?.bodies.length));
        if (!got || got.thin || wrongAnswer) {
          // NOT-THIN IS NOT ENOUGH WHEN THE FIRST ANSWER WAS ALREADY NOT-THIN. On the shopee run
          // the second look would have returned the SAME schema.org row, and swapping one copy of
          // the wrong answer for another would have counted as arriving late — a run that reported
          // `late: 4` and still held no products. So a retry provoked by a wrong answer has to
          // beat it: the replacement is kept only if it stopped missing what was asked for.
          const better = (a) => !!a && !a.thin
            && (!wrongAnswer || !(a.substituted || a.missed?.length));
          let again = null;
          let net2 = null;
          // The second look re-reads the network too: on a slow page the response the first read
          // waited for may simply not have landed yet, and re-running the DOM alone would keep
          // finding the same nothing. Only when the capture HOLDS something, though — `netTake`
          // on an empty capture waits out its own six seconds, which is a look that would outlast
          // the ceiling it is running inside.
          const look = async (force = false) => {
            const ns = nets.get(tid);
            net2 = (network && (force || ns?.hits?.size)) ? await netTake(ns) : null;
            const spec2 = net2?.bodies.length ? { ...spec, net: net2.bodies } : pageSpec;
            again = await harvestRead(tid, spec2).catch(() => null);
            return { ok: better(again) };
          };
          // THE READ IS THE FINAL WORD; QUIET IS ONLY THE EVIDENCE THAT IT IS WORTH LOOKING AGAIN.
          //
          // A page that gave NOTHING is the client-rendered shell before its first paint, and no
          // signal can see a timer that has not fired — so it keeps the old patience. A page that
          // gave its header and is merely missing a row group has visibly rendered: once it is
          // quiet, a second identical read IS the answer, and it is taken at once instead of
          // after a second and a half of nothing happening.
          const s = await settle(tid, {
            net: track, ignoreNet: netUseless >= 2,
            expect: () => look(), expectWhenQuiet: true,
            patienceMs: (!got || got.thin) ? SETTLE.PATIENCE_MS : 0,
            ceilingMs: misses >= GIVE_UP_SOON ? SETTLE.PATIENCE_MS : SETTLE.CEILING_MS,
          });
          // The ceiling never looked (it only looks at a quiet page), and an empty capture was
          // never waited on. One last look covers both, which is the look the fixed sleep used to
          // be followed by.
          if (!s.met && (s.settled === false || (network && !net?.bodies.length && !net2?.bodies.length))) {
            await look(true).catch(() => null);
          }
          st = st || s;
          env.settles++;
          env.settleMs += s.settleMs;
          if (s.settleMs > env.settleMaxMs) env.settleMaxMs = s.settleMs;
          if (s.settled === false && !better(again)
            && (s.busy || []).length && (s.busy || []).every((b) => /request/.test(b))) netUseless++;
          const betterNow = better(again);
          if (betterNow) {
            got = again;
            late++;
            if (network && net2?.bodies.length && !net?.bodies.length) netMissed--;
          }
        }
        // WHAT THE CALLER ASKED FOR AND DID NOT GET, counted across pages, and read AFTER the settle
        // retry so a page that only answered on the second look is judged on its real answer.
        // `readHarvest` has always known this per page; it died at this boundary, so a run whose
        // named path matched nothing reported a clean success over columns nobody requested.
        if (got?.missed?.length) {
          for (const m of got.missed) missedPaths.set(m, (missedPaths.get(m) || 0) + 1);
          if (got.substituted) substituted++;
        }
        // PER PAGE, AND ONLY WHEN IT SAYS SOMETHING. A header on every one of 250 rows is a column
        // nobody reads; a header on the pages that were read blind or read early is the diagnosis.
        const hdr = pageHeader(probe, st);
        if (st && st.settled === false) env.unsettled.push({ url, settleMs: st.settleMs, why: st.why });
        if (!got || got.thin) {
          // THIN IS NOT A ROW OF NOTHING. A challenge page and a script-drawn page both land here,
          // and filing either as an empty success is how a run reports 250 pages and 0 cast.
          failed.push({ url, why: got ? 'thin — nothing extractable on the page' : 'could not read the page',
            ...(hdr.why ? { page: hdr } : {}) });
          // CONSECUTIVE, NOT TOTAL. One bad page in a list is ordinary — a nav link caught by the
          // links selector, a deleted record. Five in a row is the site saying no, and every further
          // page is another request against a door that is already shut, paid for at the full
          // per-page budget. Measured: 21 refusals at 2 lanes cost four and a half minutes and
          // returned nothing, which is indistinguishable from the tool being broken.
          if (++misses >= GIVE_UP_AFTER) {
            refused = true;
            return;
          }
        } else {
          misses = 0;
          if (got.capped) capped = true;
          const head = got.record || {};
          const slotRows = [];
          // A ROW MAY OVERRIDE A HEADER FIELD, BUT MAY NOT SILENTLY DESTROY IT.
          //
          // The row wins, because the caller named both maps and the row is the more specific fact.
          // What is not acceptable is the header's value vanishing without trace: on the first real
          // run a `name` column held the actor where the film's title belonged, and nothing in the
          // reply said a column had been overwritten. Anything displaced is kept under `page.<key>`,
          // so the table can still be read and the collision is visible in the column list.
          if (got.rows.length) {
            for (const r of got.rows) {
              const row = { ...head, ...r, sourceUrl: url };
              for (const k of Object.keys(r)) {
                if (k in head && head[k] !== r[k]) row[`page.${k}`] = head[k];
              }
              slotRows.push(row);
            }
          } else {
            if (spec.rows?.at) noRows++;
            slotRows.push({ ...head, sourceUrl: url });
          }
          bucket[slot] = slotRows;
          made += slotRows.length;
          // A PAGE THAT GAVE ROWS FROM A TAB THAT WAS NOT PAINTING IS NAMED, not only counted:
          // those are the rows whose empty fields are unread rather than absent, and a caller
          // who wants to re-read them needs the urls, not a percentage.
          if (hdr.frames === false) env.blind.push({ url, page: hdr });
        }
      } catch (e) {
        const why = String(e?.message || e);
        failed.push({ url, why: why.slice(0, 160) });
        // THE SAME RULE THE LANE PASS USES: once a site has asked for verification, every further
        // request is against a wall that is already up. Stop and report it; never work around it.
        if (/verify|unusual traffic|captcha|are you a (human|robot)/i.test(why)) walled = true;
      }
      done++;
      if (onTick) await onTick({ done, of: queue.length, rows: made, failed: failed.length, page: pageSoFar() });
    }
    } finally { if (track) track.close(); }
  });

  try {
    await Promise.all(tabs.map((tid) => lane(tid)));
    for (const slotRows of bucket) if (slotRows) out.push(...slotRows);
  } finally {
    laneTabs.delete(tabId || tabs[0]);
    // DETACH BEFORE THE TAB GOES. Closing the tab drops the session anyway, but leaving the event
    // listener registered leaks one per lane per run in a worker that outlives both.
    for (const st of nets.values()) await netClose(st).catch(() => {});
    for (const tid of tabs) await chrome.tabs.remove(tid).catch(() => {});
  }

  // Columns in first-seen order, so a table reads the way the caller named its fields rather than
  // however Object.keys happened to fall.
  const seen = [];
  for (const r of out) for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k);
  const cols = seen.map((k) => ({ key: k, name: k }));

  // A COLUMN THAT IS PRESENT ON EVERY ROW AND USELESS ON A QUARTER OF THEM IS NOT A FULL COLUMN.
  //
  // `thin` asks whether a PAGE gave anything; it cannot fire while name, price and rating are all
  // there. So a description that came back as a single character rides along as a filled cell, and
  // an audit that counts non-empty reports 100%. Measured on a 529-row storefront run: every column
  // "100% filled", and 130 of the descriptions were ONE character — a quarter of the table unusable
  // with nothing in the reply saying so.
  //
  // Reported as a measurement rather than a verdict: how many rows carry the field at all, and the
  // median length of the ones that do. No threshold decides what "too short" means — the numbers sit
  // next to each other and a median of 710 beside 130 one-character cells is legible on sight.
  const fields = {};
  for (const c of cols) {
    const vals = out.map((r) => String(r[c.key] ?? ''));
    const nonEmpty = vals.filter((v) => v.trim()).length;
    const lens = vals.filter((v) => v.trim()).map((v) => v.length).sort((a, b) => a - b);
    const tiny = lens.filter((n) => n <= 2).length;
    // HOW MANY DIFFERENT ANSWERS THE COLUMN ACTUALLY HOLDS.
    //
    // `filled` says a column has values; it cannot say they are values OF THE ROW. A field named for
    // one thing and reading another is the most expensive mistake this reply can enable, because
    // unlike an empty column it looks verified. Measured on a marketplace run: a `rating` column
    // asked for per listing came back filled 66 of 70 and was documented as each book's rating. It
    // was the SHOP's — provable from the same table, where a row rated "4 out of 5 stars" carried
    // three five-star reviews of its own. Nothing in the reply contradicted the claim.
    //
    // Reported as a FACT, never as a warning. A threshold tight enough to flag that case would fire
    // on every honest rating, currency and category column in the product — a real rating holds about
    // nine distinct values — and a `fieldsWhy` that cries wolf trains the reader to skip the line
    // that does matter. So the engine states the number and declines to interpret it: 50 pages
    // answering with 5 different values is something the caller can reason about, and only the caller
    // knows what they asked the field to mean.
    //
    // Omitted when every value differs, because `distinct === filled` says nothing.
    const distinct = new Set(vals.filter((v) => v.trim())).size;
    fields[c.key] = {
      filled: nonEmpty,
      ...(nonEmpty ? { median: lens[Math.floor(lens.length / 2)] } : {}),
      ...(distinct < nonEmpty ? { distinct } : {}),
      ...(tiny ? { tiny } : {}),
    };
  }
  const thinCols = Object.entries(fields)
    .filter(([, f]) => f.tiny && f.tiny >= Math.ceil(out.length / 20))
    .map(([k, f]) => `${k}: ${f.tiny} of ${f.filled} are 1-2 characters`);

  const first = queue[0] || '';
  const id = await saveHarvest({
    rows: out, cols, url: first, title: `harvest of ${queue.length} pages`,
    pages: queue.length, failed, capped,
  });

  // NAMING THE OTHER ROUTE AT THE MOMENT IT IS THE ANSWER.
  //
  // Capture is opt-in, and nothing in a reply used to mention it — so a run whose pages came back
  // thin was told "that is the site refusing... do not retry", which is a full stop. It is correct
  // about the DOM and silent about the fact that the same pages may hold the fields in a response
  // body. That is the shape of failure this project has measured twice already: a capability nobody
  // is told about at the deciding moment does not exist. `tab_here` shipped weeks before two
  // sessions concluded there was no navigate primitive.
  //
  // Only when the caller is NOT already capturing, and only on the signals that actually mean
  // "the markup is not where the data is".
  const netAdvice = () => {
    if (network) return '';
    const badUrl = (failed[0] && failed[0].url) || queue[0] || '';
    const how = `tab_here({tabId, url: "${badUrl}", network: "*"}) maps every response that page `
      + 'fetches and prints the $. paths inside them; then re-run this with '
      + 'network:"<part of that url>" and $. paths as fields. It reads the payload the page renders '
      + 'FROM, so it does not wait for the DOM and does not care about hashed classnames.';
    if (refused) {
      return `Before you wait: ${failed.length} pages gave nothing to the SELECTORS. If this site `
        + `renders from JavaScript, that is not the same as being turned away. ${how}`;
    }
    // A SHARE, NOT A COUNT. One bad page in a list is ordinary — a nav link caught by the `links`
    // selector, a deleted record — and advising a whole second approach on the strength of it is
    // noise in every otherwise-clean reply. The same reasoning that makes `misses` consecutive.
    if (failed.length >= Math.max(2, Math.ceil(done / 4))) {
      return `${failed.length} of ${done} pages gave nothing extractable. ${how}`;
    }
    // Most pages only answering on the second look IS the definition of client-rendered, and the
    // settle is costing real time on each of them (`settleMs` in the reply says how much).
    if (late && done && late >= Math.ceil(done / 2)) {
      return `${late} of ${done} pages only answered on the second look — they paint from script, `
        + `and each cost an extra settle. ${how}`;
    }
    return '';
  };
  const advice = netAdvice();

  return {
    resultId: id,
    pages: queue.length,
    // FROM WHAT WAS ACTUALLY ATTEMPTED. `queue.length - failed.length` assumed every page was
    // visited, which stopped being true the moment the run could end early — unvisited pages would
    // have been counted as read, and a run that gave up after five would report 245 successes.
    read: Math.max(0, done - failed.length),
    rows: out.length,
    columns: cols.map((c) => c.name),
    // TWENTY IN THE REPLY, ALL OF THEM ON THE RECORD. The cap is right — a reply is not a place
    // for 200 urls — but it used to be the only copy, so the other 180 were unrecoverable and the
    // only way to retry ten failures was to re-run all 625. Measured: that cost two full passes
    // over a 625-product site, merged by hand afterwards on the source url.
    failed: failed.slice(0, 20),
    ...(failed.length ? { failedAll: failed } : {}),
    failedCount: failed.length,
    noRows,
    fields,
    // A NAMED PATH THAT MATCHED NOTHING, SAID OUT LOUD.
    //
    // The dangerous case is not the miss, it is the miss PLUS a substitution: ld+json fills the empty
    // half, every column comes back populated, and the reply reads as a success against a path that
    // never matched. Measured on a Bazaarvoice widget whose body was JSONP and so never parsed —
    // 24 rows of `offers` returned under a request for `$.Results`, with nothing saying so.
    ...(missedPaths.size ? {
      pathsMissed: [...missedPaths.entries()].map(([pp, n]) => `${pp} matched nothing on ${n} page(s)`),
    } : {}),
    ...(substituted ? {
      pathsWhy: `THE COLUMNS ARE NOT FROM THE PATH YOU NAMED. On ${substituted} page(s) the row path `
        + 'you asked for matched nothing and schema.org (ld+json) rows were returned in its place, so '
        + 'every column is populated and none of them answer the request. Compare the column names '
        + 'against what you asked for. If the body is JSONP (a callback(...) wrapper) or the array '
        + 'sits under another key, name the real path; tier:"selector" refuses the fallback outright.',
    } : {}),
    ...(thinCols.length ? {
      fieldsWhy: `PRESENT BUT NOT USABLE — ${thinCols.join('; ')}. Those rows are filled and empty `
        + 'at the same time, so a count of non-empty columns will report 100%. Say so in your '
        + 'answer, or re-run those pages with a $. path from the payload instead of a selector.',
    } : {}),
    // NOT DECORATION. A caller looking at a slow run needs to know whether the time went to the
    // network or to pages that only answered on the second look, because those are different
    // problems with different fixes.
    late,
    // NEVER SWALLOWED. `settled:false` means at least one page was read at a ceiling, still
    // changing; `settleMs` is what settling cost in total. Top level because the first question
    // about a short table is "was it ready", and `page` because every reply that read a page
    // answers it in the same shape.
    settled: env.unsettled.length === 0,
    settleMs: env.settleMs,
    ...(env.settles ? { settledPages: env.settles, settleMaxMs: env.settleMaxMs } : {}),
    ...(env.unsettled.length ? { unsettledPages: env.unsettled.slice(0, 5), unsettledCount: env.unsettled.length } : {}),
    ...(env.blind.length ? { blindPages: env.blind.slice(0, 5), blindCount: env.blind.length } : {}),
    page: pageSoFar(),
    ...(advice ? { tryNetwork: advice } : {}),
    // WHAT THE LIMIT LEFT BEHIND. A run that harvested 40 of 85 and says only "40" is a confident
    // wrong answer about the whole list, and nothing in it looks wrong.
    ...(found > from + queue.length ? {
      matched: found,
      skipped: found - (from + queue.length),
      // THE CALL THAT FINISHES THE JOB, written out. A number a caller has to work out is a number
      // a caller gets wrong, and the failure mode is silent: an off-by-one here re-reads a page or
      // skips one, and nothing in the output would show it.
      nextFrom: from + queue.length,
      // NOT `why` — that key belongs to the refused block below, and a run can be both capped and
      // refused. Two different facts must not overwrite one another on the way out.
      skippedWhy: `\`links\` matched ${found} pages; this run did ${from + 1}-${from + queue.length}. `
        + `${found - (from + queue.length)} are still unread — DO NOT report this as the whole list. `
        + `Run the SAME call again with from: ${from + queue.length} to take the next fold, and `
        + 'repeat until `skipped` is absent. Or drop `limit` and do them all in one go.',
    } : {}),
    ...(network ? {
      network: String(network),
      // A HARVEST THAT CAPTURED NOTHING ON EVERY PAGE IS A WRONG FILTER, NOT AN EMPTY SITE, AND THE
      // TWO ARE INDISTINGUISHABLE IN A TABLE OF BLANK COLUMNS. Say it here, where the caller looks.
      netMissed,
      ...(netWhy ? { netWhy } : {}),
    } : {}),
    capped,
    walled,
    // STOPPING EARLY IS A RESULT, AND IT HAS TO SAY SO IN THE REPLY. Without this the run looks like
    // it read the whole queue and simply found less — the same shape as a wrong selector. `left` is
    // what was never attempted, so a caller can resume rather than start again.
    ...(refused ? {
      refused: true,
      left: Math.max(0, queue.length - done),
      // WHAT THIS CAN AND CANNOT CONCLUDE.
      //
      // It knows one thing: the SELECTORS got nothing, twice, on five pages running. It used to
      // report that as "the site is refusing" and tell the caller to wait — a full stop, and an
      // overreach. A page whose fields arrive as JSON and are drawn by script looks exactly like
      // this from the DOM, and those responses are sitting in the browser the whole time, under
      // the same origin approval that allowed the read. Saying "wait" there is wrong advice about
      // a page that could be read right now.
      why: `${GIVE_UP_AFTER} pages in a row gave the SELECTORS nothing, so the run stopped rather `
        + 'than keep asking. Each was read twice — at load and after a settle — so they are not '
        + 'merely slow. Two things look identical from here and only one of them means stop: the '
        + 'site turning you away, OR the fields never being in the markup at all because the page '
        + 'draws them from a response it fetched. Check the second BEFORE waiting — see '
        + '`tryNetwork` in this reply. If that comes back empty too, then it is the site: wait, '
        + 'and do not retry in a loop.',
    } : {}),
    // WHERE THE PAGES WERE ACTUALLY READ. The caller cannot see the browser, and the arrangement
    // decides whether a count can be trusted: a lane that is a background tab with no debugger
    // hold paints nothing (measured: 0 of 6), the same lane with the hold reads 12 of 12 with the
    // screen covered, and a lane window reads 6 of 6 uncovered. `auto` chooses between them at
    // run time, so without this line the reply cannot say which one it got.
    lanes: { count: n, as: laneMode === 'off' ? 'background tabs' : `${laneMode} per lane`,
      held: laneHeld, ...(laneMode !== laneAsked ? { asked: laneAsked, why: 'the debugger could not attach' } : {}) },
    tabsLeft: 0,
  };
}

// A HARVEST GETS ITS OWN HISTORY ENTRY, AND DOES NOT GO THROUGH `saveResult`.
//
// Everything guarding `saveResultNow` exists for one situation: a RE-READ of a live page must not
// replace a fuller stored table with whatever happens to be mounted. Those guards are right, and
// every one of them was written after a real loss.
//
// None of them apply here, and applying them anyway would be actively harmful. A harvest is an
// accumulation that is complete by construction — it was assembled across N pages that are no longer
// open, so "the list only grows within a visit" has nothing to compare against. Worse, a harvest run
// from a list page shares that page's URL and session, so routing it through `saveResult` would put
// 12,750 cast rows into the slot holding the 250-film list and trip the shrink guards on the way.
//
// So it writes its own row. The result store's shape is the contract — `tables[0].cols` and `.rows`
// — and `results.get` / `results.export` read it unchanged.
async function saveHarvest({ rows, cols, url, title, pages, failed, capped }) {
  const id = newId();
  const scannedAt = new Date().toISOString();
  const out = {
    items: [],
    tables: [{ cols, rows }],
    from: 'harvest',
    coverage: { deep: true },
    harvest: { pages, failed: failed.length, capped },
  };
  await chrome.storage.local.set({ ['table:' + id]: { ...out, id, url, key: normUrl(url), scannedAt } });
  const { history = [] } = await chrome.storage.local.get('history');
  const entry = {
    id, sid: '', key: normUrl(url), url, scannedAt,
    count: 0, types: {}, deep: true,
    title: title || '',
    tables: 1,
    rows: rows.length,
  };
  const next = [entry, ...history].slice(0, HISTORY_MAX);
  const dropped = history.filter((h) => !next.some((n) => n.id === h.id));
  await chrome.storage.local.set({ history: next });
  if (dropped.length) await chrome.storage.local.remove(dropped.map((d) => 'table:' + d.id));
  return id;
}
