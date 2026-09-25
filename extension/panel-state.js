// THE PANEL'S SHARED MUTABLE STATE, in one module, so every other panel module reads and writes the
// same copy. ES modules are singletons: whoever imports `S` gets this object, never a duplicate.
//
// Two shapes, on purpose. Everything below hangs off `S` as a plain field (`S.busy`-style), which any
// importer can assign. Three names — `tab`, `liveTimer`, `liveTab` — are exported as LIVE BINDINGS
// with a setter each, because the test suite greps `sidepanel.js` for them bare (`tab?.id` in
// `sync`, `!liveTimer || … !== liveTab` in `liveGrow`; see test/extension.mjs and test/panel.mjs).
// An imported binding cannot be assigned from outside its module, hence the setters.
//
// State that only `sidepanel.js` touches (`busy`, `stoppable`, `pressWaiting`, `scannable`,
// `deepOrigin`, …) stays declared there — it is not shared, so it does not belong here.

export const S = {
  // What we know about this site, asked of the worker rather than kept here as a
  // second copy of the same list.
  site: { status: 'unknown' },
  // Whether an agent is live RIGHT NOW — asked fresh each `sync()`, not derived from `site`, so
  // the untested-site card can tell "nobody's connected" from "one already is" and stop saying
  // "set up" to someone who already has a window open. See `bridgeIsLive` and its use in `show`.
  bridgeLive: false,
  resultId: null,
  resultsUrl: null,
  // The result that already HOLDS a read table — a deep scan's row walk, or a list scan. Opened as it
  // stands, never re-read: re-reading one screenful over it is the 69-rows-become-71 overwrite.
  tableId: null,
  stopped: false,    // this scan was cancelled, so it must not read as finished
  lastHistoryCount: 0,
  // The sheet has two levels: the menu, and one screen per entry. Escape steps back
  // through them in the order you arrived — screen to menu, menu to closed — rather
  // than dumping you out of the sheet from wherever you are.
  atScreen: null,
  // Held by `ask` so leaving the page can retract the question — see `ask` and `closeHalf`.
  pendingAsk: null,
  // WHICH LIVE SHEET A TICK BELONGS TO, and it exists because clearing the interval is not enough.
  //
  // A tick is `async`: it asks the page for progress and paints when the answer comes back. Clear
  // the timer while one is in flight and that one still lands — and `liveGrow` and `ask` write to
  // the SAME three nodes, so what the user saw was a finished pass reporting itself and then being
  // overwritten half a second later by the progress sheet: "Opening each one · 0 opened · 0 with
  // details · ELAPSED 3m 24s" under a pair of [Open results] [Done] buttons. The report card was
  // rendered, correctly, and then painted over.
  //
  // So every tick carries the generation it was started in and drops its paint if that has moved
  // on. Bumped when a sheet starts and again when it closes.
  liveGen: 0,
  // One instrument, read three ways — because the phases differ in what they can honestly
  // promise. Media knows its total, so the marker is completion. The row pass does not, so
  // the marker is how far down the page the scan has reached, which is real and moves.
  // Page hop has neither, so the line accumulates a tick per page instead of filling.
  //
  //   hero    the figure the phase is about, with its denominator kept subordinate
  //   catch   what has been gained so far, right-aligned, ticking when it grows
  //   foot    elapsed, and a plain sentence when there is something to explain
  lastCatch: -1,
  // The last real hop status, kept so the card cannot fall to zero on the tick after a walk
  // ends — the worker forgets the run there, and `HOP_STATUS` answering null is not the same
  // fact as "no rows". Cleared with the rest of the run's state in `closeLive`.
  lastHop: null,
  // Which phase is running, so the sheet can report the figures that phase actually
  // moves. One title and four zeros is what made the media phase read as a hang: on a
  // stock-video site it runs for a minute before the row engine exists, so `rows`,
  // `images`, `repeats` and `hops` were all structurally zero and nothing on screen
  // changed but the clock. Depth and requests-in-flight are what move during it.
  livePhase: 'rows',
  liveTitle: '',
  // PROVIDER TRAITS, READ FROM THE ENGINE — never a list kept here.
  //
  // This was two private sets, `STEP_COUNT` and `PAGED`, and they are exactly how one fact about a
  // provider ended up in three files. The engine owns the provider table (`PROVIDERS` in rows.js)
  // and ships the traits with every poll, so the panel asks instead of remembering.
  //
  // The defaults matter: an unknown provider gets three steps and does not page, which is what
  // every non-map site has always been.
  chainTraits: { steps: 3, grows: '', reads: '' },
  // --- the run ledger ----------------------------------------------------------
  // What the whole chain did, kept in one place so the card at the end can be assembled from
  // facts rather than from whatever the last pass happened to return. Each pass reports its own
  // numbers and then hands over; without this the summary could only ever describe step three,
  // which is the smallest and least interesting of the three.
  //
  // Null when no chained run is in flight. A pass started from a card on its own starts one too
  // (`from`), so pressing "find emails" by hand still ends in a report rather than in silence.
  chain: null,
  // WHEN THE USER PRESSED THE BUTTON, which is not when the chain is decided.
  //
  // The chain is started by `afterScan`, i.e. after step one has already run — so timing it from
  // there reported a run that took 2m 20s as "Done in 1m 46s". Measured, on the live run of
  // 2026-08-06: Deep scan at +12s, summary at +152s, card said 1m 46s. The whole of step one, the
  // longest and most visible part, was missing from the one number that answers "was that normal".
  deepT0: 0,
  // SEEN, not assumed. Step 1 on a page with no step 2 is an invented promise — most pages are
  // not lists whose rows can be opened — so the marker stays off until the engine says this list
  // can be detailed. On a map list `canDetail` is true from the first poll of the row phase, so
  // in practice the marker appears within half a second of the walk starting; on a shop it never
  // appears at all, which is correct.
  sawChainable: false,
  // Which map the chain is running on, so the ledger can draw the right number of steps. Set from
  // the same poll that sets `sawChainable`, and cleared with it — it is a claim about the run that
  // is ending, not about the panel.
  chainMap: '',
  // WHICH STEP THIS SHEET BELONGS TO, held rather than derived on every paint. `livePhase` moves
  // to `stopping` when Stop is pressed, and deriving the step from it there would renumber a
  // half-finished third step as a first one at the exact moment somebody is watching it end.
  liveStep: 0,
  // How many pages had landed the last time the table was written to storage. Reset with the
  // ticker, so a new hop commits from its first page rather than from wherever the last one
  // happened to stop.
  lastHopPages: 0,
  // --- scanning ---------------------------------------------------------------
  // `press` overrides the switch for one run — the keyboard's "scan without pressing".
  // Undefined means "whatever the switch says".
  pressThisRun: true,
};

// The active tab — what `sync` keeps current on every navigation. Everything that talks to the
// page addresses `tab.id`.
export let tab = null;
export const setTab = (v) => { tab = v; };

// One timer for the whole scan: phases hand the sheet to each other by calling `liveGrow`
// again, which retitles without hiding — no flicker between "opening media" and
// "reading the list". The sheet is up from the moment Deep scan is pressed, because a
// scan whose progress lives somewhere you are not looking reads as a hang.
export let liveTimer = null;
export const setLiveTimer = (v) => { liveTimer = v; };
// Which tab the live sheet is reporting on. A scan keeps running while you look at another
// tab, and the sheet is the only way to watch it or stop it — so it has to know whose it
// is: hidden while you are elsewhere, back when you return, and never repainted with some
// other tab's numbers in the meantime.
export let liveTab = null;
export const setLiveTab = (v) => { liveTab = v; };

// One setting, not three, and it is fixed at everything.
//
// This was a Light / Normal / Thorough control. Nobody presses a button labelled
// "deep scan" wanting some of the page — the button already states the intent, and
// asking again in a settings screen only offered the user a way to get less than
// they asked for, then wonder why the list was short. The two lower settings existed
// to make scans quick, which is a job the early-stopping rules already do: a page
// that stops producing new content ends the walk on its own, so a finite page never
// pays for these numbers. What they buy is the infinite feed, which is exactly the
// case where stopping short is indistinguishable from a bug.
//
// THE config. There is no settings screen any more, so this block is it: every number
// that decides how hard a scan tries lives here and nowhere else.
//
// The asset walk (scan.js) and the row engine (rows.js) each carry the same values as
// their own defaults, because both are serialised to source and can import nothing —
// so the defaults exist twice by necessity. These are what actually ship; the copies
// only apply to callers that pass nothing, such as the results window's "More" button.
export const SCAN = {
  // --- the asset walk: opening media, one item at a time ---------------------
  max: 120,      // media triggers to click at most (a lightbox, a play button)
  delay: 200,    // ms between those clicks
  scroll: 220,   // screens to walk. Nothing can be clicked before the page mounts it,
                 // and a page only mounts what has passed through the viewport.
  pause: 550,    // ms to dwell per screen, on top of waiting for any request in flight
  dry: 12,       // screens producing nothing new before the walk gives up

  // --- pressing the page's own load-more ------------------------------------
  // Four separate budgets because they answer four separate questions. Raising one
  // does not raise the others.
  presses: 5,    // ASSET walk: total presses while collecting files. Each one costs a
                 // round trip to the site and a batch of new images to measure.
  // Raised from 3/2, but NOT all the way to the asset walk's own 220 — on a genuinely
  // infinite feed (X's home timeline essentially never dries up), `deadPresses` rarely
  // fires early, so a big `wakePresses` means EVERY scan runs close to the full cap, every
  // time: minutes instead of seconds, as a mandatory default rather than a rare edge case.
  // 12/3 is a real improvement over 3/2 without turning every ordinary scan into a
  // multi-minute wait. Stopping early is always fine regardless of this number — more
  // presses monotonically means more rows, so a partial run still beats the old cap.
  wakePresses: 12, // ROW engine, waking phase: presses allowed while walking the page
                 // to find out what is on it.
  deadPresses: 3, // ROW engine: presses that produce NO new rows before the button is
                 // called spent and the list declared finished.
  hops: 0,       // 0 = unlimited. A hop scrolls, presses what is in reach, waits and
                 // re-counts; the scan ends when the PAGE ends or the user stops it.
  budget: 0,     // 0 = unlimited. Kept as knobs so a test can bound itself; whichever runs
                 // first is what stops it, and the panel says so rather than implying
                 // the list ended.
};
