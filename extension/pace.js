// HOW LONG THE DETAILS PASS WAITS, AND FOR WHAT.
//
// Split out of `background.js` because pacing is the part of that pass most often reported as a
// bug — "it is extremely delayed", "it stopped at 47" — and it is pure logic with no browser in
// it, so out here it can be tested in milliseconds instead of by driving a real Maps page. See
// `test/details-pace.mjs`.
//
// The service worker is a module (`"type": "module"` in the manifest), so it can import this. The
// injected engines CANNOT — `scan.js` and `rows.js` are serialised to source by
// `chrome.scripting.executeScript` — which is why their duplication stays where it is and only
// worker-side logic moves here.

// TRIES, NOT MILLISECONDS. A count of attempts means the same thing whether the page is answering
// in 20ms or in a second, which a fixed deadline does not.
export const D = {
  // Ten seconds of asking. Measured arrival is 544ms with the tab in front and ~1.1s with its
  // timers clamped — but a hidden tab's frames come from a backstop TIMER (see `keepFrames`), and
  // a clamped timer makes a chain of frames take seconds rather than milliseconds.
  arriveTries: 40, arriveWait: 250,
  walkSteps: 26, walkWait: 220,          // measured 8-10 steps in front; headroom for a slow page
  settle: 2,                             // bottom + no growth + cannot move, twice
  webTries: 20, webWait: 200,            // the frame loads on arrival at the bottom
  webGrace: 4,                           // probes allowed for the block to APPEAR — see waitForWeb
  misses: 3,                             // records in a row that never opened → stop
  pace: () => 350 + Math.floor(Math.random() * 450),
};

export const rest = (ms) => new Promise((r) => setTimeout(r, ms));

// THE WEB RESULTS BLOCK — and the two different waits that were being treated as one.
//
// Reported: "the detail has been loaded but there is 2-3s pause before continuing to the next
// item." This was it. `dweb` answers two separate questions — `seen`, is there a website block on
// this record at all, and `ready`, has the one that exists finished loading. The loop collected
// `seen` for the report and then ignored it, breaking only on `ready` or `gone`. So a record with
// NO website — and plenty of places have none — waited out the entire budget, 20 probes × 200ms =
// four seconds, for something that was never going to arrive. After its detail was already on
// screen, which is exactly what "loaded but then pauses" describes.
//
// Split in two, because they deserve different budgets:
//
//   waiting for the block to APPEAR   a short grace period — it renders with the panel, and if
//                                     four probes have not seen it, it is not there
//   waiting for it to LOAD            the full budget, because a block that exists is worth
//                                     waiting for and the iframe behind it is somebody else's
//                                     server
//
// The grace window counts probes, not consecutive misses, so a block that renders late still gets
// picked up — it only has to appear before the window closes, and after that the full budget is
// available to it.
//
// `ask` and `wait` are passed in so the pacing can be measured without a browser or a real clock.
export async function waitForWeb(ask, cfg = D, wait = rest) {
  let seen = false;
  for (let t = 0; t < cfg.webTries; t++) {
    const w = await ask();
    seen = seen || !!w?.seen;
    if (w?.ready) return { web: w.text || '', seen: true, probes: t + 1 };
    if (w?.gone) return { web: '', seen, probes: t + 1 };
    // Nothing has turned up to wait FOR. Stop, rather than pay for the whole budget.
    if (!seen && t + 1 >= cfg.webGrace) return { web: '', seen: false, probes: t + 1 };
    await wait(cfg.webWait);
  }
  return { web: '', seen, probes: cfg.webTries };
}
