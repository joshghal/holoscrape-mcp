// Keeping animation frames coming when the tab is not being looked at.
//
// THE BUG THIS EXISTS FOR. A run of "open each record" left going while the user watched a video
// in another browser came back with **3 records of 120**. Measured, driving the pass from the
// service worker so the page was never asked to keep time:
//
//     nothing suppressed        →  3 of 3 panels arrived, first in 544ms
//     page timers clamped to 1s →  3 of 3 arrived, first in 1069ms
//     requestAnimationFrame off →  0 of 3 arrived, after 33 SECONDS of asking
//
// **A hidden tab does not run `requestAnimationFrame` at all** — not slowly, not eventually,
// never — and Google Maps mounts a record's panel from a rAF callback. So the panel never draws,
// the pass never sees the record it clicked, and after three of those it stops by design. Three
// is `DETAIL_MISSES`. That is the whole of the reported failure, and it happens within SECONDS of
// the tab going to the background — nothing to do with the five-minute throttling threshold that
// was blamed first.
//
// WHY THIS IS A `document_start` CONTENT SCRIPT AND NOT PART OF THE PASS. The obvious fix —
// replace `window.requestAnimationFrame` when the pass starts — was tried and changed nothing:
// still 0 of 3. Maps takes its reference to rAF when its bundle loads, so a replacement installed
// later is invisible to it; it goes on calling the function it already holds. The wrapper has to
// be in place BEFORE the page's own code runs, which is what `document_start` buys, and in the
// page's own world, which is what `"world": "MAIN"` buys.
//
// With that ordering, under full rAF suppression: **3 of 3 panels arrived, first in 543ms, and the
// first record read 17 fields.** The same wrapper left dormant, as a control: 0 of 3.
//
// IT IS DORMANT UNTIL ARMED — but it TRACKS EVEN WHILE DORMANT, and that is not an optimisation,
// it is the difference between working and not.
//
// Measured: a wrapper that armed at pass-start and merely passed requests through until then
// still gave **0 of 3**, while the same wrapper armed from page load gave 3 of 3. The reason is
// that Maps renders from a SELF-PERPETUATING CHAIN — each frame callback requests the next one.
// Pass a request through to a hidden tab's rAF and the callback never runs, so it never asks for
// another frame, and the chain is DEAD. Arming afterwards cannot revive it: there is no callback
// left running to request anything.
//
// So every request is recorded whichever state we are in, and arming RETRO-FITS a backstop onto
// everything still pending — which restarts the chains that died while the tab sat hidden.
// Dormant, the cost is a map entry per frame, removed as soon as the frame runs; no timers.
//
// `keepFrames` in `rows.js` arms it when a pass starts and disarms it when the pass ends, however
// it ends.
//
// THE FRAME BACKSTOP ALONE IS NOT ENOUGH, and the report that proved it was exact: the pass
// "forfeits AT THE TIME a user changes window (alt+tab)". Throttling takes minutes to bite; an
// EVENT fires instantly. Maps listens for `visibilitychange` and pauses itself the moment the
// browser says hidden — stops loading, defers rendering — so keeping frames alive was feeding a
// page that had been told to stop working. This is the standing problem "keep active" extensions
// solve (Always Active Window; the Page Visibility spoofing technique), and the solution is
// three mechanisms TOGETHER, armed and disarmed as one:
//
//   1. the frame backstop (below)
//   2. the Page Visibility API answering "visible" — `document.hidden` false,
//      `document.visibilityState` 'visible' — so code that ASKS is told the page is in front
//   3. the `visibilitychange` event blocked in the capture phase, so code that LISTENS is never
//      told otherwise
//
// And the backstop's own clock cannot be a page timer: a hidden tab clamps those to one second,
// which drags a chain of frames from 60/s to 1/s — a panel needing thirty chained frames takes
// half a minute to mount. So the box exposes `pump()`, and the SERVICE WORKER — whose clock the
// page's visibility cannot touch — calls it a few times a second while a pass runs. `pump()`
// flushes every due backstop and every due engine wait, which makes the worker the metronome and
// the page timers merely a fast path for when the tab is in front.
(() => {
  const KEY = '__holoscrapeFrames';
  if (window[KEY]) return;                       // a second injection is not a second wrapper
  const realRaf = window.requestAnimationFrame && window.requestAnimationFrame.bind(window);
  const realCancel = window.cancelAnimationFrame && window.cancelAnimationFrame.bind(window);
  if (!realRaf) return;                          // nothing to wrap; leave the page alone

  const held = new Map();
  // Our ids live above any real one, so `cancelAnimationFrame` can tell whose id it was handed.
  const TAG = 1e9;
  let seq = 0;
  // How many pending requests to remember while dormant. A tab that sits hidden for an hour
  // accumulates requests the browser will never call, and remembering all of them is a leak;
  // forgetting the oldest is safe because `run` copes with its own entry being gone, and the
  // browser still honours the real request if the tab comes back.
  const KEEP = 500;
  const REVIVE = 50;    // how soon a retro-fitted backstop fires — see `arm`

  // Engine waits that must survive a frozen page — `nap()` registers here while armed, and
  // either its own setTimeout (the foreground fast path) or a `pump()` resolves it, whichever
  // is first.
  const waits = new Set();

  // THE PAGE'S OWN TIMERS, and this is the fourth mechanism — established by bisection, not
  // guessed. Measured with everything else in place:
  //
  //     timers clamped to 1s   →  3 of 3 records (an ordinary hidden tab: fixed)
  //     timers clamped to 60s  →  0 of 3         (hidden over five minutes: still broken)
  //
  // Frames were flowing in both. What stalls at 60s is MAPS' OWN `setTimeout` work — it fetches
  // a record and finishes rendering on a timer, so the panel cannot mount however many frames it
  // is given. Chrome's intensive throttling takes a hidden tab's timers to roughly one a minute
  // after five minutes, which is exactly the window someone is away for when they leave a run
  // going and go and watch something.
  //
  // So while armed, the page's timers are recorded here as well, and `pump()` runs the ones that
  // are due. The real timer is still set — in front it wins the race and this costs nothing —
  // and a `done` flag makes sure a callback runs exactly once whichever side gets there first.
  const timers = new Map();
  const TTAG = 2e9;                 // above the frame ids, so `clear*` can tell all three apart
  let tseq = 0;
  const realST = window.setTimeout.bind(window);
  const realCT = window.clearTimeout.bind(window);
  const realSI = window.setInterval.bind(window);
  const realCI = window.clearInterval.bind(window);

  const fireTimer = (id, now) => {
    const rec = timers.get(id);
    if (!rec || rec.running) return 0;
    if (rec.every) {
      // An interval survives its own firing; its next due time moves on. Never more than one
      // catch-up per pump, or a tab hidden for an hour would fire thousands at once.
      rec.due = (now || performance.now()) + rec.every;
    } else {
      if (rec.done) return 0;
      rec.done = true;
      try { realCT(rec.realId); } catch (_) {}
      timers.delete(id);
    }
    rec.running = true;
    try { rec.fn(...(rec.args || [])); } catch (_) { /* the page's callback, the page's problem */ }
    rec.running = false;
    return 1;
  };

  window.setTimeout = function (fn, delay, ...args) {
    // Not armed, or not a function (a string of code, which is nobody's business but the page's):
    // straight through, no bookkeeping.
    if (!box.on || typeof fn !== 'function') return realST(fn, delay, ...args);
    const id = TTAG + (++tseq);
    const ms = Math.max(0, delay || 0);
    const rec = { fn, args, due: performance.now() + ms, every: 0, done: false, running: false };
    rec.realId = realST(() => fireTimer(id), ms);
    timers.set(id, rec);
    return id;
  };
  window.setInterval = function (fn, delay, ...args) {
    if (!box.on || typeof fn !== 'function') return realSI(fn, delay, ...args);
    const id = TTAG + (++tseq);
    const ms = Math.max(1, delay || 1);
    const rec = { fn, args, due: performance.now() + ms, every: ms, done: false, running: false };
    rec.realId = realSI(() => fireTimer(id), ms);
    timers.set(id, rec);
    return id;
  };
  window.clearTimeout = function (id) {
    if (typeof id === 'number' && id > TTAG) {
      const rec = timers.get(id);
      if (rec) { rec.done = true; try { realCT(rec.realId); } catch (_) {} timers.delete(id); }
      return;
    }
    realCT(id);
  };
  window.clearInterval = function (id) {
    if (typeof id === 'number' && id > TTAG) {
      const rec = timers.get(id);
      if (rec) { rec.done = true; try { realCI(rec.realId); } catch (_) {} timers.delete(id); }
      return;
    }
    realCI(id);
  };

  // Our own waits use `realST`/`realCT` throughout, never the wrapped globals: registering our
  // bookkeeping timers with our own bookkeeping is a loop with no purpose.
  const box = {
    on: false, ms: 250, realRaf, realCancel, held, waits, timers,
    made: 0, backstopped: 0, revived: 0, pumped: 0, blocked: 0,
    // Arming is what makes a dead chain live again: give every request still outstanding a
    // backstop, soonest first, then keep doing that for new ones.
    arm() {
      box.on = true;
      for (const [id, h] of held) {
        if (h.timer) continue;
        h.timer = realST(() => { h.byTimer = true; box.revived++; h.run(performance.now()); }, REVIVE);
        held.set(id, h);
      }
      return 'armed';
    },
    disarm() {
      box.on = false;
      for (const h of held.values()) {
        if (h.timer) { realCT(h.timer); h.timer = 0; }
      }
      // The page's own timers stop being tracked, but their REAL timers were always set, so the
      // page loses nothing — it goes back to being scheduled by the browser alone.
      timers.clear();
      // Waits resolve rather than hang: the pass that made them is ending anyway, and a promise
      // nobody will ever resolve is a leak with a stack trace attached.
      for (const w of waits) { try { w.fire(); } catch (_) {} }
      waits.clear();
      return 'off';
    },
    // A wait the page's own clock cannot strand. Used by the engine's `nap` while armed.
    wait(ms) {
      return new Promise((resolve) => {
        const due = performance.now() + ms;
        const w = { due, fire: () => { waits.delete(w); realCT(w.t); resolve(); } };
        w.t = realST(w.fire, ms);      // fast path, in front
        waits.add(w);
      });
    },
    // THE WORKER'S TICK — and it has to advance a CHAIN, not one frame.
    //
    // Measured, firing one round per tick: 0 records of 3. Maps mounts a panel through frames
    // that each request the next, so one link per 300ms tick means a mount needing fifty links
    // takes fifteen seconds — past the ten the pass allows for a record to arrive. Frames are
    // not throttled by wall-clock in the browser either; they are as fast as the work.
    //
    // So each call runs several ROUNDS: fire everything outstanding, yield to microtasks so the
    // page's own promise work lands, and fire whatever that produced — up to `rounds`. A tick
    // therefore advances a chain by up to `rounds` links instead of one, and the cap is what
    // stops a self-renewing chain from spinning forever inside a single call.
    async pump(rounds = 12) {
      box.pumped++;
      let frames = 0;
      let woke = 0;
      if (!box.on) return { frames, woke, held: held.size, waits: waits.size, on: false };
      for (let r = 0; r < rounds; r++) {
        const now = performance.now();
        let did = 0;
        // THE PAGE'S OWN DUE TIMERS FIRST — Maps finishes rendering a record on a timer, and at
        // one tick a minute that is what stalls a mount no number of frames can rescue.
        for (const [id, rec] of [...timers]) {
          if (now >= rec.due && !rec.running) did += fireTimer(id, now);
        }
        for (const [, h] of [...held]) {
          // Anything the page has not run yet. No age threshold: when the page's own timers are
          // clamped this is the only clock, and a frame the browser is never going to draw has
          // nothing to wait for.
          if (!h.byTimer) {
            h.byTimer = true;
            did++;
            try { h.run(now); } catch (_) {}
          }
        }
        // Waits DO need real time to pass — they are the engine's deliberate pauses.
        for (const w of [...waits]) {
          if (now >= w.due) { woke++; try { w.fire(); } catch (_) {} }
        }
        frames += did;
        if (!did) break;
        // Let the page's microtasks run between links, so promise-driven work keeps up with the
        // frames it is interleaved with.
        await Promise.resolve();
      }
      return { frames, woke, held: held.size, waits: waits.size, timers: timers.size, on: box.on };
    },
  };
  window[KEY] = box;

  // --- the page is never told it is hidden, while armed -------------------------------
  //
  // Maps pauses itself on `visibilitychange` — that is why a run dies AT the alt-tab, not
  // minutes later. Two halves, because pages both ASK and LISTEN:
  //   asked  → the getters answer as if in front
  //   told   → the event is stopped in the capture phase before any page listener sees it
  // Dormant, both halves stand aside entirely.
  try {
    const hid = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    const vis = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    if (hid?.get && vis?.get) {
      const realHidden = hid.get;
      const realVis = vis.get;
      Object.defineProperty(Document.prototype, 'hidden', {
        ...hid, get() { return box.on ? false : realHidden.call(this); },
      });
      Object.defineProperty(Document.prototype, 'visibilityState', {
        ...vis, get() { return box.on ? 'visible' : realVis.call(this); },
      });
      // THE TRUTH, KEPT WHERE OUR OWN CODE CAN ASK FOR IT. The spoof above is for the PAGE —
      // Maps must believe it is in front — but the engine runs in the same world and reads the
      // same getter, so every walk report on Maps printed `hidden=false` whatever the tab was
      // doing. That field looked like a measurement, was a constant, and cost an investigation:
      // a run logged `hidden=false focus=false` and was read as "the tab was fine, the list
      // ended". The keeper is the one thing that still knows, because it captured the getter
      // before replacing it.
      box.trueHidden = () => { try { return !!realHidden.call(document); } catch (_) { return null; } };
      box.trueVis = () => { try { return realVis.call(document); } catch (_) { return null; } };
    }
  } catch (_) { /* a page that seals its prototypes keeps them; the pump still works */ }
  for (const ev of ['visibilitychange', 'webkitvisibilitychange']) {
    window.addEventListener(ev, (e) => {
      if (!box.on) return;
      box.blocked++;
      e.stopImmediatePropagation();
    }, true);
    document.addEventListener(ev, (e) => {
      if (!box.on) return;
      box.blocked++;
      e.stopImmediatePropagation();
    }, true);
  }

  window.requestAnimationFrame = (fn) => {
    box.made++;
    const mine = TAG + (++seq);
    let done = false;
    // THE RACE. A real frame and a timer, whichever comes first, exactly once. With the tab in
    // front the frame wins in ~16ms and the timer is cleared unused; hidden, the frame never comes
    // and the timer runs the callback instead. Deliberately no check of `document.hidden`:
    // whether a frame actually arrives is the thing that matters, and racing them measures it
    // rather than predicting it from a flag.
    const run = (t) => {
      if (done) return;
      done = true;
      const h = held.get(mine);
      if (h) {
        try { realCancel(h.raf); } catch (_) {}
        realCT(h.timer);
        held.delete(mine);
        if (h.byTimer) box.backstopped++;
      }
      try { fn(t); } catch (_) { /* the page's callback, the page's problem */ }
    };
    let raf = 0;
    try { raf = realRaf(run); } catch (_) {}
    // `run` is kept on the entry so `arm` and `pump` can reach it later — reviving chains that
    // died while dormant, and firing backstops whose own timers the page never ran. `at` is what
    // lets `pump` see that a backstop is overdue.
    const entry = { raf, byTimer: false, timer: 0, run, at: performance.now() };
    if (box.on) entry.timer = realST(() => { entry.byTimer = true; run(performance.now()); }, box.ms);
    held.set(mine, entry);
    // Dormant and hidden, nothing ever calls these back; keep the map from growing without end.
    if (held.size > KEEP) {
      const oldest = held.keys().next().value;
      const h = held.get(oldest);
      if (h?.timer) realCT(h.timer);
      held.delete(oldest);
    }
    return mine;
  };

  window.cancelAnimationFrame = (id) => {
    if (id > TAG) {
      const h = held.get(id);
      if (h) {
        try { realCancel(h.raf); } catch (_) {}
        realCT(h.timer);
        held.delete(id);
      }
      return;
    }
    try { realCancel(id); } catch (_) {}
  };
})();
