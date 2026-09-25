// WHAT STATE WAS THE PAGE IN WHEN WE READ IT — AND ONE RULE FOR "IS IT READY".
//
// Two things live here because they are one question asked at two moments.
//
//   pageProbe()   "is this tab painting at all?"            -> page: { hidden, frames }
//   settle()      "has it stopped arriving, or did we stop waiting?"  -> { settled, settleMs, why? }
//
// WHY THE PROBE EXISTS. Chrome runs no IntersectionObserver, no requestAnimationFrame and no paint
// lifecycle for a tab that is not the active tab of its window. A read there SUCCEEDS over empty
// sections: measured on one shopee.co.id category url in two tabs of one window, 60 of 60 rows
// populated in front and 0 of 60 behind, and 0 of 20 record pages in background lanes — with
// `withVisibleTab` (CDP focus + lifecycle emulation) applied. Nothing in any reply said so. The count
// is identical either way, so nothing count-based can see it; a frame either runs or it does not.
//
// WHY THE SETTLE EXISTS. `HARVEST_SETTLE_MS = 1500` was a bet — "too short for a slow page, paid by
// every fast one" in this project's own words — and every other server that does this swallows its
// cap. Constants are taken from source, not invented (research/PLAYWRIGHT-DEVTOOLS-MCP-STUDY.md §C):
//
//   Playwright MCP  backend/utils.ts:20-57     requests the action caused must FINISH; 500 ms of
//                                              quiet after the last one; request cap 5,000 ms;
//                                              `load` cap 10,000 ms when it navigated
//   DevTools MCP    WaitForHelper.ts:31-34     100 ms for a navigation to BEGIN; MutationObserver
//                                              silence on the DOM; caps of 3,000 ms
//
// THREE THINGS NEITHER OF THEM DOES, and each is the reason this file is not a port:
//
//   1. EVERY WAIT IS TIMED FROM THE WORKER. Both time with an in-page `setTimeout`, which a hidden
//      tab clamps to 1 s, and to 60 s after five minutes hidden (HIDDEN-TAB.md rows 3-4). They can
//      afford it because they own their browser and launch it with backgrounding disabled. We are
//      in the person's Chrome. The page only ever COUNTS (mutations, finished resources, frames);
//      the worker's clock decides how long is long enough.
//   2. A CEILING HIT IS `settled:false`, WITH THE REASON. Both `.catch(() => {})` their timeout and
//      reply as if settled. That is their version of the failure this project keeps paying for —
//      an answer about a page that was not ready, delivered as a success.
//   3. QUIET IS REPORTED BESIDE `frames`, because in a tab that is not painting "the DOM went
//      quiet" can mean FROZEN, not finished: a rAF-driven mount never starts, so the observer sees
//      silence at once. `settled:true, frames:false` is a legible pair; `settled:true` alone is not.
//
// Nothing here knows a hostname. Site knowledge stays in provider descriptors.

export const SETTLE = {
  // A navigation that is going to begin has begun by now. DevTools uses 100 ms inside a browser it
  // owns; `tabs.onUpdated` crosses one more process boundary here, so the study's 150.
  NAV_EXPECT_MS: 150,
  // Playwright's cap on `load` after an action navigated.
  NAV_CAP_MS: 10000,
  // Playwright's settle: this long with nothing finishing, after the last request finished.
  NET_QUIET_MS: 500,
  // DevTools debounces 100 ms with an in-page timer. Polled from the worker at POLL_MS the same
  // rule needs a window wider than one poll or a single late mutation slips between two reads.
  DOM_QUIET_MS: 300,
  // Playwright's request cap. The one ceiling for the quiet phase: a page still fetching or still
  // rewriting itself after this long is not going to be called ready by waiting politely.
  CEILING_MS: 5000,
  POLL_MS: 100,
  // HOW LONG A QUIET PAGE THAT HOLDS NOTHING IS GIVEN TO START.
  //
  // This is the old HARVEST_SETTLE_MS, kept at its value and demoted from "every thin page sleeps
  // this long" to "the most a page gets when it is quiet, can still run script, and has produced
  // NOTHING that was asked for". That case is a client-rendered shell before its first paint, and
  // no signal can see a timer that has not fired yet — so it is the one place a bounded guess
  // survives. `test/harvest-run.mjs` holds the fixture (fields mount from a 700 ms timer with no
  // request behind it); 1500 is what that and the Tokopedia measurement above `harvest` were
  // satisfied by. Everything else exits on evidence.
  PATIENCE_MS: 1500,
  // The frame probe's bound. A painting tab answers in one frame (measured in this suite: 2-9 ms
  // including the injection), so the bound is only ever PAID by a tab that is not painting or a
  // main thread stuck in a long task — which is why it can be generous without costing anything.
  FRAME_BOUND_MS: 250,
  // A lane that has already measured `frames:false` is the same tab in the same window on its next
  // page. Three frames' worth is enough to notice it has started painting again.
  FRAME_REBOUND_MS: 60,
  // An injection that does not come back at all is a paused renderer (an open dialog, a crashed
  // frame). DevTools races its own setup against the timeout for the same reason.
  INJECT_MS: 1500,
  // A VISIBLE TAB THAT MISSED THE FRAME BOUND IS PROBABLY BUSY, NOT BLIND. A long task blocks the
  // frame and the injection alike, and both land together the moment it ends. This is the one
  // more look, a few frames later, that separates "the main thread was stuck" from "nothing is
  // painting this" — and it is added to the bound in the header's wording, so the number a caller
  // reads is the time that was actually waited.
  BUSY_RELOOK_MS: 100,
  // How often `settle` may run the caller's semantic `expect` check when nothing else says so. A
  // DOM read per poll would be paid on every 100 ms tick; the count rule only needs a few looks.
  EXPECT_EVERY_MS: 250,
  // THE ONE-LOOK FORM's budget (`settleBrief`): the most an op that did not navigate spends
  // establishing that the page is still — nothing at all when the watcher is already in place
  // and says it has been.
  BRIEF_MS: 400,
  // The nav waiter's wake-up slice. It is woken by the `tabs.onUpdated` event itself; this is only
  // the longest it sleeps between checks when no event arrives, so the cap is honoured to within
  // one slice.
  NAV_WAKE_MS: 50,
  // Polls in a row that could not read the page at all (mid-navigation, or gone) before the settle
  // gives up on it having never seen a snapshot. At POLL_MS that is two seconds of blindness.
  MAX_UNREAD_POLLS: 20,
};

// What a request must be for a page to be waiting on it. Playwright's list: bodies that build the
// page. Images, fonts and media arrive forever on a storefront and nothing we read depends on them.
const WAITED = new Set(['Document', 'Stylesheet', 'Script', 'XHR', 'Fetch']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOUND = Symbol('bound');

// --- the page side ---------------------------------------------------------------------------
// ONE function, injected into the ISOLATED world. Isolated on purpose: on Maps `raf.js` replaces
// the MAIN world's `requestAnimationFrame` with a backstopped one, and a probe that asked THAT
// would be told frames are flowing by our own keeper. The isolated world's binding is the real one.
//
// It only counts. `performance.now()` stamps ride along as HISTORY — they let a read say "nothing
// has changed for two seconds" on the first look instead of having to watch for 300 ms to find
// out — but no wait is ever made in here. The single `setTimeout` below is housekeeping: it lets a
// probe promise that will never see a frame be collected. Nothing reads its timing.
function hsPage(scope, probeId) {
  const W = window;
  let s = W.__hsSettle;
  if (!s) {
    s = { muts: 0, mutAt: -1, res: 0, resAt: -1, frameFor: 0, root: null, scope: null, t0: performance.now() };
    Object.defineProperty(W, '__hsSettle', { value: s, enumerable: false, configurable: true });
    try {
      s.po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          // Only what BUILDS a page. Pictures, fonts and media arrive for as long as a storefront
          // is open, and counting them would mean no product grid ever goes quiet. Same list as
          // WAITED in the worker, in the vocabulary resource timing uses.
          if (!/^(xmlhttprequest|fetch|script|link|iframe|navigation)$/.test(e.initiatorType || '')) continue;
          s.res++;
          // `responseEnd`, not now: `buffered` replays everything the document has already
          // fetched in one callback, and stamping those with the time of the replay would make a
          // page that finished loading a minute ago look as if it finished this instant.
          if (e.responseEnd > s.resAt) s.resAt = e.responseEnd;
        }
      });
      s.po.observe({ type: 'resource', buffered: true });
    } catch (_) { /* no resource timing here — the network half simply has no page-side evidence */ }
  }
  // `scope === null` means KEEP WATCHING WHATEVER IS WATCHED. Re-binding resets the history, and
  // the history is what lets a second look answer at once instead of watching for 300 ms again.
  let want = null;
  if (scope) { try { want = document.querySelector(scope); } catch (_) { want = null; } }
  const keep = scope === null && s.root && s.root.isConnected;
  const root = keep ? s.root : (want || document.body || document.documentElement);
  // Re-bound when the scope changes OR when the node we were watching has been replaced — an
  // in-app router swaps the container wholesale, and an observer on a detached node hears
  // nothing for ever, which would read as the quietest page in the world.
  if (root && (s.root !== root || !root.isConnected)) {
    try { if (s.mo) s.mo.disconnect(); } catch (_) {}
    s.mo = new MutationObserver((recs) => { s.muts += recs.length; s.mutAt = performance.now(); });
    // childList + subtree, NOT attributes. DevTools watches attributes on the whole body, and that
    // is why it needs a 3 s cap: a carousel, a countdown or an ad slot toggling a class keeps the
    // page "unstable" for ever. What we wait for is nodes arriving.
    s.mo.observe(root, { childList: true, subtree: true });
    s.root = root;
    s.scoped = !!want;
    s.t0 = performance.now();
    s.mutAt = -1;
  }
  const snap = () => {
    const now = performance.now();
    return {
      hidden: document.visibilityState !== 'visible',
      ready: document.readyState,
      muts: s.muts,
      res: s.res,
      // How long the watched region has been still, by the page's own monotonic clock. Before the
      // first mutation that is "since we started watching", which is all that can honestly be said.
      domStillMs: Math.round(now - (s.mutAt >= 0 ? s.mutAt : s.t0)),
      netStillMs: s.resAt >= 0 ? Math.round(now - s.resAt) : -1,
      scoped: keep ? !!s.scoped : !!want,
      // Whether a mutation has EVER been seen here, and for how long anyone has been looking. A
      // watcher bound a moment ago has no opinion about the second before it existed.
      mutSeen: s.mutAt >= 0,
      // A document with no script and no frame cannot change itself. Not a heuristic: there is
      // nothing on it that could run.
      inert: document.scripts.length === 0 && !document.querySelector('iframe,frame,object,embed'),
      // The last probe whose frame actually ran. Compared in the worker, so a frame that lands
      // late is still seen by the next look without asking for another one.
      frameFor: s.frameFor,
    };
  };
  if (!probeId) return snap();
  return new Promise((resolve) => {
    requestAnimationFrame(() => { s.frameFor = probeId; resolve(snap()); });
    setTimeout(() => resolve(snap()), 8000);
  });
}

let probeSeq = 0;

async function inject(tabId, args) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: hsPage, args });
    return (r && r[0] && r[0].result) || null;
  } catch (_) {
    return null;   // a restricted page, a tab that has gone, a frame mid-navigation
  }
}

// An injection raced against the WORKER's clock, so a renderer that never answers costs a bounded
// wait and not the op.
const injectWithin = (tabId, args, ms) => Promise.race([inject(tabId, args), sleep(ms).then(() => BOUND)]);

// IS THIS TAB PAINTING? One injection. It resolves from inside a real animation frame, so on a tab
// that is painting it costs a frame; the bound is timed HERE and only a tab that is not painting
// ever reaches it. Returns null when the page cannot be asked at all.
export async function pageProbe(tabId, { scope = '', boundMs = SETTLE.FRAME_BOUND_MS } = {}) {
  const began = Date.now();
  // From the clock, not a bare counter: the worker is evicted and restarted at will, the page's
  // record of "the last probe whose frame ran" is not, and a counter that restarted at 1 would be
  // outranked by a stale answer left on the page.
  probeSeq = Math.max(probeSeq + 1, Date.now() * 100);
  const id = probeSeq;
  const first = await injectWithin(tabId, [scope, id], boundMs);
  if (first === null) return null;
  if (first !== BOUND && first.frameFor >= id) {
    return { ...first, frames: true, probeMs: Date.now() - began, boundMs };
  }
  // NO FRAME INSIDE THE BOUND. Ask again, synchronously, for what the page can still tell us —
  // visibility, and whether the frame turned up in the meantime.
  let snap = await injectWithin(tabId, [scope, 0], SETTLE.INJECT_MS);
  if (snap === BOUND || !snap) {
    return { hidden: null, frames: false, stuck: true, probeMs: Date.now() - began, boundMs };
  }
  let frames = await frameArrived(tabId, scope, id);
  // One more look for a VISIBLE tab that missed the bound — see BUSY_RELOOK_MS. A HIDDEN tab gets
  // no second look: no frame in a background tab is the expected fault, not a surprise.
  if (!frames && !snap.hidden) {
    await sleep(SETTLE.BUSY_RELOOK_MS);
    frames = await frameArrived(tabId, scope, id);
  }
  return { ...snap, frames, probeMs: Date.now() - began, boundMs };
}

async function frameArrived(tabId, scope, id) {
  const again = await injectWithin(tabId, [scope, 0], SETTLE.INJECT_MS);
  return again !== BOUND && !!again && again.frameFor >= id;
}

// THE HEADER. The contract's shape, and nothing else: `page: { hidden, frames, settled, settleMs,
// why? }`. `why` is present only when something is wrong, because a line that is always there is
// a line nobody reads.
export function pageHeader(probe, st) {
  const settled = st ? st.settled !== false : true;
  const out = {
    hidden: probe ? probe.hidden : null,
    frames: probe ? !!probe.frames : null,
    settled,
    settleMs: st ? (st.settleMs || 0) : 0,
  };
  const why = [];
  if (probe && !probe.frames) {
    why.push(probe.stuck
      ? `the page did not answer within ${SETTLE.INJECT_MS}ms — a dialog is open or the renderer is paused, so nothing about it could be measured`
      : probe.hidden
        ? `this tab is NOT PAINTING: it is in the background (visibilityState hidden) and no animation frame ran in ${probe.boundMs}ms. `
          + 'Chrome runs no observers, frames or paint there, so content that mounts lazily — on view, on scroll, on a frame — '
          + 'may be MISSING from this read even though the read succeeded. Treat an empty section as unread, not as absent.'
        : `no animation frame ran in ${probe.boundMs + SETTLE.BUSY_RELOOK_MS}ms although the tab reports visible — it is not being painted `
          + '(covered, minimised or stalled), so lazily mounted content may be MISSING from this read. Treat an empty section as unread, not as absent.');
  }
  if (!probe) why.push('the page could not be asked about its state (a restricted page, or the tab went away)');
  if (st && st.settled === false && st.why) why.push(st.why);
  if (why.length) out.why = why.join(' ');
  return out;
}

// --- the network half, where a debugger session is already held --------------------------------
//
// BORROWED, NEVER OPENED. This adds a listener and nothing else: it never attaches, never
// detaches and never touches `Network.enable`, so it cannot disturb a `@net` watch or a feed
// reader on the same tab (the five rules above `cdpHold` in background.js). `cdpHold` already
// enables the Network domain on every session it opens — the lanes hold one for their whole life,
// and every bridge op holds one for the length of the call — so the events are already flowing
// and already paid for. No new permission, no new banner.
//
// CAUSAL, which is Playwright's point and the reason this is not `networkidle`: only requests that
// START after `reset()` are counted. A long-poll, a beacon or a socket that was already open when
// the navigation began cannot hold the wait.
export function netTrack(tabId) {
  const st = { inflight: new Map(), lastDoneAt: 0, started: 0, since: Date.now(), closed: false };
  const onEvent = (src, method, params) => {
    if (src.tabId !== tabId) return;
    if (method === 'Network.requestWillBeSent') {
      if (!WAITED.has(params.type)) return;
      st.inflight.set(params.requestId, Date.now());
      st.started++;
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      if (st.inflight.delete(params.requestId)) st.lastDoneAt = Date.now();
    }
  };
  chrome.debugger.onEvent.addListener(onEvent);
  return {
    reset() { st.inflight.clear(); st.lastDoneAt = 0; st.started = 0; st.since = Date.now(); },
    close() { if (!st.closed) { st.closed = true; chrome.debugger.onEvent.removeListener(onEvent); } },
    // How long since the last counted request finished — or since we began listening, when none has.
    read() {
      return { inflight: st.inflight.size, started: st.started,
        stillMs: Date.now() - (st.lastDoneAt || st.since) };
    },
  };
}

// --- did a navigation begin? -------------------------------------------------------------------
//
// ARMED BEFORE THE ACTION, for the reason DevTools gives at WaitForHelper.ts:209-212: a listener
// started after the action can miss the very event it exists to see, and then waits out its cap.
//
// What it replaces is `waitForLoad`, which resolves on `complete` OR on its timeout and cannot say
// which — a 25 s cap hit and a page that loaded in 300 ms hand back the same nothing, so a read of
// a half-loaded document went out as an ordinary success. Here the cap is an answer:
// `loaded:false`, which `settle` turns into `settled:false` with the reason.
//
// THE EXPECTATION WINDOW is for the case where no document load may be coming at all: an address
// that differs only after the `#`. MEASURED, and not what was assumed — `chrome.tabs.update` to a
// fragment of the same document DOES raise `loading` then `complete` in current Chrome
// (test/settle-shared.mjs D: three hash-routed record pages in 556 ms on the old code), so nothing
// was burning a budget there. The window therefore costs nothing today and is kept as the guard
// for the day that stops being true: a navigation that has not begun inside NAV_EXPECT_MS is not
// coming, and the page is read where it stands rather than after the full cap.
export function armNav(tabId) {
  let began = false;
  let complete = false;
  let wake = null;
  const fn = (id, info) => {
    if (id !== tabId) return;
    if (info.status === 'loading') { began = true; complete = false; }
    // Only a `complete` that FOLLOWS a `loading` we saw. The previous document finishing late
    // must not be taken for the new one arriving.
    if (info.status === 'complete' && began) complete = true;
    if (wake) wake();
  };
  chrome.tabs.onUpdated.addListener(fn);
  const until = async (test, ms) => {
    const end = Date.now() + ms;
    while (!test() && Date.now() < end) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.race([new Promise((r) => { wake = r; }), sleep(Math.min(SETTLE.NAV_WAKE_MS, Math.max(1, end - Date.now())))]);
    }
    wake = null;
    return test();
  };
  return {
    // `certain`: the caller KNOWS a document load is coming (a different address was asked for),
    // so the expectation window does not apply and only the cap does. Reading the old document
    // because the new one was slow to start is the worst failure shape this project has.
    //
    // `created`: the tab was made WITH this address a moment ago, so there was no tabId to arm
    // against before the navigation began. A small page can be `complete` before this runs; that
    // is an arrival, not a navigation that never started.
    async wait({ certain = false, created = false, capMs = SETTLE.NAV_CAP_MS } = {}) {
      const t0 = Date.now();
      try {
        if (!began) {
          const t = await chrome.tabs.get(tabId).catch(() => null);
          if (t && t.status === 'loading') began = true;
          else if (created && t && t.status === 'complete' && t.url && !/^about:blank/.test(t.url)) {
            return { navigated: true, loaded: true, ms: Date.now() - t0 };
          }
        }
        if (!began) await until(() => began, certain ? capMs : SETTLE.NAV_EXPECT_MS);
        if (!began) return { navigated: false, loaded: !certain, ms: Date.now() - t0 };
        const left = Math.max(0, capMs - (Date.now() - t0));
        const done = await until(() => complete, left);
        return { navigated: true, loaded: done, ms: Date.now() - t0 };
      } finally {
        chrome.tabs.onUpdated.removeListener(fn);
      }
    },
    dispose() { chrome.tabs.onUpdated.removeListener(fn); },
  };
}

// True when two addresses name the same DOCUMENT — they differ, if at all, only after the `#`.
export function sameDocument(a, b) {
  const cut = (u) => String(u || '').split('#')[0];
  return !!a && !!b && cut(a) === cut(b);
}

// --- the rule ----------------------------------------------------------------------------------
//
//   settle(tabId, {
//     scope       css for the list / record container when one is KNOWN; otherwise <body>
//     net         a `netTrack` handle when a debugger session is held; otherwise the page's own
//                 PerformanceObserver is the (weaker) evidence — it sees completions, not starts
//     ignoreNet   the caller has learned this site keeps a request open for ever
//     expect      async ({quiet}) => ({ ok, ... }) — THE SEMANTIC CHECK, and the final word. The
//                 engine's own rule: the row count held, the fields asked for are there.
//     expectEveryMs / expectWhenQuiet   how often the semantic check may run
//     narrowAfterMs   when `expect` names the container it found (`{ok, scope}`) and the ONLY thing
//                 still moving after this long is the DOM outside it, watch that container instead
//     patienceMs  how long a QUIET page that fails `expect` is given before it is believed
//     ceilingMs   the hard stop
//     nav, navCertain, navCapMs         an `armNav` handle taken before the action
//   })
//
// FOUR SIGNALS, ANDed, ONE BUDGET: the document is complete · the requests this navigation
// started have finished and stayed finished for NET_QUIET_MS · the watched region has had no
// nodes arrive for DOM_QUIET_MS · `expect` agrees. The first three are cheap evidence that it is
// WORTH LOOKING; only the last is an outcome.
//
// Returns { settled, settleMs, why?, met?, value?, navigated?, busy? }. `settled:false` means a
// ceiling was hit, and `why` names what was still moving. It is never folded into a success.
export async function settle(tabId, {
  scope = '', net = null, ignoreNet = false, expect = null, expectEveryMs = SETTLE.EXPECT_EVERY_MS,
  expectWhenQuiet = false, patienceMs = 0, ceilingMs = SETTLE.CEILING_MS, narrowAfterMs = 0,
  nav = null, navCertain = false, navCapMs = SETTLE.NAV_CAP_MS,
} = {}) {
  const began = Date.now();
  const out = (settled, extra = {}) => ({ settled, settleMs: Date.now() - began, ...extra });

  let navigated = false;
  if (nav) {
    const n = await nav.wait({ certain: navCertain, capMs: navCapMs });
    navigated = n.navigated;
    if (!n.loaded) {
      return out(false, { navigated,
        why: n.navigated
          ? `the document had not finished loading after ${n.ms}ms`
          : `no navigation began within ${n.ms}ms of asking for one` });
    }
  }

  const t0 = Date.now();
  // The worker's own record of WHEN each counter last moved. The page's stamps are history and
  // are believed when they say "still for longer than you have been watching"; they are never the
  // only witness, because a page clock can be stopped (a frozen tab, virtual time) and this one
  // cannot.
  let muts = null; let res = null;
  let mutMovedAt = t0; let resMovedAt = t0;
  let lastExpectAt = 0;
  let last = null; let value; let met;
  let unread = 0;

  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await injectWithin(tabId, [scope, 0], SETTLE.INJECT_MS);
    const now = Date.now();
    let busy = [];
    if (snap === BOUND || !snap) {
      // Mid-navigation, or gone. Not evidence of anything except that we cannot see yet.
      unread++;
      busy = ['the page could not be read'];
    } else {
      last = snap;
      const mutMoved = muts !== null && snap.muts !== muts;
      const resMoved = res !== null && snap.res !== res;
      if (mutMoved) mutMovedAt = now;
      if (resMoved) resMovedAt = now;
      muts = snap.muts; res = snap.res;
      // THE ONE-LOOK FORM (ceilingMs 0) CANNOT WATCH, so a region nobody has seen change is taken
      // as still — with the document complete and the network history quiet, that is the honest
      // reading. Any form with a budget watches for the full window instead of assuming.
      const domStill = mutMoved ? 0
        : (ceilingMs <= 0 && !snap.mutSeen) ? Infinity
          : Math.max(now - mutMovedAt, snap.domStillMs);
      // A document that has never fetched anything has nothing to be quiet AFTER.
      const pageNetStill = resMoved ? 0
        : (snap.netStillMs < 0 && res === 0) ? Infinity
          : Math.max(now - resMovedAt, snap.netStillMs);
      const track = (!ignoreNet && net) ? net.read() : null;
      if (snap.ready !== 'complete') busy.push('the document is still loading');
      if (domStill < SETTLE.DOM_QUIET_MS) busy.push(`nodes are still arriving${snap.scoped && scope ? ` in ${scope}` : ''}`);
      if (!ignoreNet) {
        if (track && track.inflight > 0) busy.push(`${track.inflight} request(s) the page started have not finished`);
        else if (track && track.started > 0 && track.stillMs < SETTLE.NET_QUIET_MS) busy.push('a request finished a moment ago');
        else if (pageNetStill < SETTLE.NET_QUIET_MS) busy.push('a request finished a moment ago');
      }
    }
    const quiet = busy.length === 0;

    if (expect && (quiet || !expectWhenQuiet) && now - lastExpectAt >= expectEveryMs) {
      lastExpectAt = now;
      // eslint-disable-next-line no-await-in-loop
      const e = await Promise.resolve(expect({ quiet, snap: last })).catch(() => null);
      if (e) { value = e; met = !!e.ok; }
      // A CAROUSEL BESIDE A FINISHED LIST MUST NOT HOLD THE LIST HOSTAGE — AND A GRID STILL
      // MOUNTING BESIDE A FINISHED FOOTER MUST.
      //
      // Those two look identical for the first moments: nodes arriving somewhere that is not the
      // container `expect` found. They stop looking identical with time — a grid that is mounting
      // changes the COUNT, and the count rule then refuses the early answer on its own — so the
      // whole document is watched first, and only a page that has kept churning for
      // `narrowAfterMs` with a request-quiet network and an unmoved count is narrowed to the
      // container. Measured on the carousel fixture in test/settle-shared.mjs: watching <body>
      // for ever cost `tab.here` its entire 3 s budget (612 ms before any of this existed) and
      // reported a finished twelve-row list as unsettled.
      if (e && e.scope && narrowAfterMs && e.scope !== scope && now - t0 >= narrowAfterMs
        && busy.length && busy.every((b) => /nodes/.test(b))) {
        scope = e.scope;
        muts = null; mutMovedAt = now;
      }
    }

    if (quiet) {
      if (!expect || met) return out(true, { navigated, ...(expect ? { met: true, value } : {}) });
      // QUIET, AND STILL NOT WHAT WAS ASKED FOR. Either it is never coming, or it is behind a
      // timer no signal can see. A document that cannot run anything is the first kind by
      // construction; anything else gets the caller's patience and then the truth.
      if ((last && last.inert) || now - began >= patienceMs) {
        return out(true, { navigated, met: false, value });
      }
    }
    if (now - t0 >= ceilingMs) {
      return out(false, { navigated, busy, ...(expect ? { met: !!met, value } : {}),
        why: `${ceilingMs <= 0 ? 'NOT SETTLED at the moment of this read' : `NOT SETTLED after ${now - t0}ms`} — ${busy.join('; ')}. `
          + 'This read was taken of a page still changing; read it again before concluding anything is absent.' });
    }
    if (unread > SETTLE.MAX_UNREAD_POLLS && !last) {
      return out(false, { navigated, busy, why: 'the page could not be read while it settled' });
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(SETTLE.POLL_MS);
  }
}

// THE ONE-LOOK FORM, for an op that reads a page it did not just navigate. It spends at most
// `budgetMs` (SETTLE.BRIEF_MS) establishing that the page is still — nothing at all when the
// watcher is already in place and says it has been — and says so when it could not. A `NO_MATCH`
// beside `settled:false` is "read it again"; beside `settled:true, frames:true` it is an answer.
export async function settleBrief(tabId, { scope = '', net = null, budgetMs = SETTLE.BRIEF_MS } = {}) {
  return settle(tabId, { scope, net, ceilingMs: budgetMs });
}
