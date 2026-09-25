// HoloScrape — service worker: the second step — opening every row and reading the record behind it
// (lanes, the rail, the 2GIS fetch pass), and the room a rail needs to survive a click.
import { placeUrl, parseBody, readPlace } from './place.js';
import { firmId, firmUrl, readFirmHtml, FIRM_INIT } from './twogis.js';
import { D, rest, waitForWeb } from './pace.js';
import { DEV } from './env.js';
import { walking, laneTabs, abandoned, detailRun, detailedAt, noteWall } from './bg-state.js';
import { note, devLog, saveLog } from './bg-log.js';
import { startPump, stopPump, lateKeepers, armFrames } from './bg-awake.js';
import { runRows } from './bg-rows.js';
import { CDP_VERSION, cdp, cdpPrepare } from './bg-cdp.js';
import { sessionFor } from './bg-store.js';

// --- opening every row ---------------------------------------------------------------
//
// The engine does the clicking; the one thing it cannot do for itself is make the page
// WIDER, and on a list that opens its records beside itself that is the difference between
// working and destroying the list.
//
// Measured on Google Maps: at 1280 CSS px and above, clicking a card opens the place panel
// beside the rail and the rail keeps every row. At 1180 and below the same click REPLACES
// the rail — it leaves the DOM entirely — so a pass that clicked anyway would delete the
// list it was reading, one row in.
//
// That threshold is why this reads as broken in ordinary use and looked like a zoom
// problem: HoloScrape's own side panel takes ~400px off the page, so a 1440px window leaves
// Maps about 1040px to lay out in. Zooming out is not a setting the user should have to
// find — it is arithmetic, and it belongs here.
//
// The zoom is BORROWED: whatever it was is read first and put back however the pass ends.
const DETAIL_MARGIN = 40;   // a little over the threshold, not exactly on it
// Only used if the page could not be asked what width it has — see `openDetails`. The engine owns
// the real threshold (`DETAIL_MIN_WIDTH`); this is the number to reason from when the page is
// unreachable, and it must not silently disagree with it.
const DETAIL_MIN_WIDTH_FALLBACK = 1280;
const CHROME_MIN_ZOOM = 0.25;

// --- driving the pass from HERE, because the page cannot be trusted to keep time ---------
//
// THE BUG THIS FIXES: a run left going while the user looked at something else came back with
// **3 records of 120**. Chrome clamps a hidden tab's `setTimeout` to one second, and once the tab
// has been hidden five minutes, intensive throttling takes it to about one a MINUTE. The pass
// used to wait on those timers while measuring three- and twelve-second deadlines, so every
// record overshot, "never arrived", and after three of those the pass stopped by design.
//
// Reproduced by clamping `setTimeout` in the page, which is what Chrome does:
//     no clamp   →  4 of 4 records, 9.9s
//     1s clamp   →  4 of 4 records, 15.1s      (an ordinary hidden tab: survivable)
//     60s clamp  →  0 of 3, "3 records in a row did not open"   ← the reported failure
//
// So the waiting moved here. The worker's timers are not the page's: `executeScript` runs when
// the worker asks, whatever the tab is doing, and each call below does one bounded piece of DOM
// work and returns at once. A throttled page then answers each call as it comes and the pass
// takes the same number of steps it always did.
//
// Pacing for the details pass lives in `pace.js` — `D`, `rest` and `waitForWeb`. It moved out
// because it is pure logic with no browser in it, and it is the part of this pass most often
// reported as a bug, so it earns a test that runs in milliseconds. See test/details-pace.mjs.

// --- reading records in their own tabs, several at a time --------------------------------------
//
// The sequential pass clicks row i in the rail and waits for the panel to mount beside it: measured
// at 4.80s a record, 123 records in 9m51s. Every row already carries the link to its own page, and
// measured against the same 20 records (`test/detail-lanes.mjs`):
//
//   lanes   per record   120 records
//       1       1.09s        131s        going direct is already 4.4x faster than the rail click
//       5       0.42s         50s        <- 11.5x, and where the curve flattens
//      10       0.39s         46s        8% more for double the tabs and memory
//
// Five, then, and the reason ten is not worth it: the cost is ARRIVAL — navigation plus Maps' app
// boot, 2-3s a record — and that is CPU, so lanes only hide it up to the cores available. Beyond
// five they start fighting: average walk time went 0.32s -> 0.86s -> 1.48s as lanes were added.
//
// Each lane pulls the next record off a shared queue rather than working in rounds of five. Rounds
// run at the speed of the slowest record in every group, which over 120 records is a great deal of
// idle time in four tabs.
// HOW MANY LANES THE MACHINE CAN STAND — asked of the machine, not assumed.
//
// A fixed number is the wrong shape: each lane is a whole Maps instance, which is one of the heaviest
// web apps there is, and eight of them on a four-core laptop will thrash while eight on a workstation
// will not. Both numbers this reads are available to a service worker and cost nothing:
//
//   navigator.hardwareConcurrency   logical cores
//   navigator.deviceMemory          approximate RAM in GiB, rounded down by Chrome for privacy
//
// Half the cores, because a lane is not a busy loop — it spends most of its time waiting on the
// network and on Maps booting, so lanes and cores are not one-to-one — and then bounded by memory at
// roughly 1 GiB a lane with 2 GiB left for the browser and the user's own tabs. Floor of 2 so the pass
// still parallelises on a small machine; ceiling of 8 because beyond that the earlier measurements
// show contention rather than gain.
// FIVE. A constant, on purpose.
//
// This was derived from the machine for a while — cores, then free memory via `chrome.system.memory` —
// and both readings were worse than a fixed number. `navigator.deviceMemory` reports TOTAL RAM rounded
// to a power of two and capped at 8, which says nothing about what is left. And `availableCapacity`,
// which does measure free memory, is misleading on macOS: it excludes cached and purgeable pages, so a
// MacBook Pro with ample headroom reports a small figure and the arithmetic chose TWO lanes. A number
// that halves throughput on a capable machine because the platform accounts memory differently is not
// a measurement worth having.
//
// So: five, and the budgets below are set so that five lanes clear 120 records in two to three minutes.
// The protection against a struggling machine is no longer a lane count guessed from specs — it is the
// budgets themselves (a slow record is waited for, not abandoned) and the pacing in the lane loop,
// which slows down after three failures in a row and stops guessing about causes.
const LANES = 5;

const LANE_NAV_MS = 8000;          // the URL committing — NOT the map finishing, see `laneArrive`
// THE PANEL, and this budget now has to cover the whole app boot.
//
// It was 8000, and that lost seventeen records. When the wait for `status === 'complete'` came out of
// `laneArrive`, the starting line moved EARLIER without the budget growing: arrive used to begin on a
// page that had finished loading, and now begins the moment the URL commits. On the run that lost
// records a SUCCESS at record 100 took 23.5s in total, so navigation alone was around 11s — an 8s
// arrive expires long before Maps has booted, and reports "no panel" on a page that was simply still
// coming. A cap costs nothing when it is not needed: a ready page still answers in under a second.
const LANE_ARRIVE_MS = 22000;
// BUDGETS SET FROM THE TARGET, not from caution.
//
// 124 records over 5 lanes is 25 records a lane, so two and a half minutes allows ~6s a record. Where
// that goes, measured:
//
//   navigation      ~1-2s   the URL committing — polled on the tab, no injection
//   the panel       ~1-2s   Maps booting; capped high because a record cut off mid-boot returns nothing
//   walk ‖ web      ~2s     these run TOGETHER now, so the cost is the longer of the two, not the sum
//   the read        ~0.3s   one engine injection
//
// The walk and web ceilings are what is left to trim, and they are trimmed to the point where their
// overlap lands at ~2s. The arrive ceiling is deliberately NOT trimmed: it is only reached by a record
// that would otherwise have failed, and seventeen of those is worse than thirty seconds.
// 3000, NOT 1600 — and this ceiling is nearly free.
//
// The walk exits the moment the panel settles at its bottom (two quiet steps), so this number is a
// CEILING reached only by the long panels — the ones with many photos, reviews and attributes. Cutting
// it to 1600 to save time therefore saved nothing on a short record and, on a long one, stopped the
// scroll before it reached the bottom. Reaching the bottom is what makes Maps create the web-results
// frame at all, so that trim silently emptied the Web results column on all 124 records of one run.
// 5000, and the reason is measured. A COLD TAB IS NOT A SETTLED PAGE.
//
// These ceilings were set from the rail pass, where the app is already warm and a panel is complete
// the instant it appears — rail records finish in 268-1312ms end to end. A lane record is a whole
// Maps boot: 3.4s at best, 8.8s median, 31.7s at worst on one run of 124. The panel appears early
// in that and keeps mounting sections afterwards, so the walk needs room to follow it down.
//
// With the within-call `grew` bug in `detailStep` this made no difference — the walk exited after
// 140ms whatever the ceiling was. With growth measured across naps the ceiling starts to matter,
// and 3000 is the number that was tuned against the wrong page.
const LANE_WALK_MS = 5000;
// And the website block: 1500 was the ceiling, but the real problem was the 400ms GRACE inside
// `dgrab` for it to appear at all. It is a separate fetch Maps makes after the panel draws, and under
// five lanes it routinely takes longer than that — which is why `web` went false from record 38 while
// `ms` was climbing. Both are raised; both are still caps.
// And the frame itself: it is an iframe onto `google.com/search`, requested only once the section
// scrolls into view, and on a cold tab that request queues behind the app's own boot traffic with
// four other lanes competing. 2200 was measured against a warm page too.
// ZERO — DO NOT WAIT FOR THE WEB-RESULTS FRAME. Asked for, and the numbers agree with the ask.
//
// This was 3500, then 6000, and raising it did work: web results went from 35 of 98 records to 98 of
// 120. But the cost lands in the wrong place. On that same run the 22 records that came back WITHOUT
// the frame averaged 17.7s against 10.5s for the ones that got it — a success exits the moment the
// frame reads, so nearly the whole of this budget is spent on the records it fails to serve, twice
// over: once in the walk-to-the-bottom that creates the request, once waiting for it to answer.
//
// Zero means `walkWeb` skips the wait and reads the frame ONCE at the end, free, if Maps happens to
// have loaded it while the walk scrolled past. The column keeps whatever costs nothing and the pass
// stops paying for the rest. Set it back to 6000 to buy the column at ~7s a miss.
// BACK TO 6000, because zero was measured and the trade is bad.
//
// Seychelles, 120 records, web wait OFF:  2.68s a record, `Web results` filled on 10 of 110.
// Jakarta,    120 records, web wait 6000: 2.94s a record, `Web results` filled on 98 of 120.
//
// Nine percent faster for seventy-three points of the column. The arithmetic was always against it:
// arrival is 70-80% of a record, so removing everything else can only ever buy the remaining fifth.
// The free end-of-walk read stays and does work — it caught 10 records at zero cost — it just cannot
// substitute for waiting, because Maps has usually not loaded the frame by the time the walk ends.
const LANE_WEB_MS = 6000;

// THE BYTES A LANE NEVER READS. Five Maps tabs at once spend most of their effort painting a map
// nobody will look at: vector tiles, imagery, fonts, logging beacons. Blocked through the debugger
// that is already attached, so it costs nothing extra.
//
// Blocking a request does NOT remove the element that asked for it — an `<img>` keeps its `src`
// whether or not the bytes arrived — so every photo and street-view URL the record read still comes
// out. Nothing in the field set is fetched to be read; it is all attributes and text.
const LANE_BLOCKED = [
  '*/maps/vt/*', '*/maps/vt?*', '*/maps/vt/stream*',   // the map itself
  '*/gen_204*', '*/log?format=*',                      // logging beacons
  '*fonts.gstatic.com/*',
  '*.ggpht.com/*',
];

// `cdpPrepare` plus the blocking. Kept separate so the page-hop pass, which DOES want the imagery it
// walks past, is untouched by this.
// OFF, AND NOW MEASURED PROPERLY — it is a LOSS, not the 10% gain once claimed.
//
// `test/_lane-speed.mjs`, 40 real Cimahi records, every lane busy, same records in every arm:
//
//   5 lanes                42.4s   1.06s/record   web 40 of 40   → 120 records ~127s
//   5 lanes + blocking     67.3s   1.68s/record   web 21 of 40   → 120 records ~202s
//   8 lanes                66.0s   1.65s/record   web  9 of 40
//   10 lanes               91.0s                  filled 0 of 40   <- collapse
//
// So blocking costs 58% MORE time and halves the web-results column. The mechanism is visible in
// that column: the results frame is a request to `google.com/search`, and interfering with the tab's
// request pipeline is not free even when the blocked patterns are only tiles and beacons.
//
// An earlier arm of this same sweep reported blocking 18% FASTER with no data cost. That arm had
// SEVEN records against five lanes — more lanes than work — so it timed tab setup, not throughput.
// It is recorded here because it is exactly the shape of measurement that gets a bad change shipped.
//
// The lane count is settled by the same run: FIVE. Eight is slower and loses two thirds of the web
// results; ten reads nothing. Do not raise `LANES` without re-running that sweep.
const LANE_BLOCK = false;

async function lanePrepare(target) {
  await cdpPrepare(target);
  if (!LANE_BLOCK) return;
  await cdp(target, 'Network.enable').catch(() => {});
  await cdp(target, 'Network.setBlockedURLs', { urls: LANE_BLOCKED }).catch(() => {});
}

// WHICH RECORD A PAGE IS, from its URL. Maps place URLs carry the place id as `!19s<ChIJ…>`, and
// the older form carries the feature pair as `!1s0x…:0x…`. Either is a stable identity that survives
// Maps rewriting the rest of the path around it.
function placeToken(href) {
  const m = /!19s([A-Za-z0-9_-]{10,})/.exec(href || '')
    || /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/.exec(href || '');
  return m ? m[1] : '';
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// WAIT FOR THE NAVIGATION ON THE TAB, NOT IN THE PAGE.
//
// `chrome.tabs.update` starts a navigation and returns immediately; the previous document is still
// there. Injecting during that window is what made five lanes read their first record 124 times —
// and polling for it by injection costs an engine parse per attempt. `chrome.tabs.get` answers the
// same question for nothing, so the wait happens here and the page is touched once.
// HAS STOP BEEN PRESSED — asked the cheap way. `stopWanted` goes through `runRows`, which serialises
// and injects the whole 231KB engine to read one boolean. Called once a record over 124 records that
// is 124 engine parses on the list tab, for a flag that a two-line function can read.
// THE LIVE FIGURES, WITHOUT THE ENGINE. `progress` reads `st.detail` off the page, and that used to
// ride along with each `dput` — which meant a 231KB engine parse per record just to move a number.
// The state object is a known global, so two lines can write it.
export async function laneTick(tabId, d) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: 'MAIN',
      func: (v) => { const st = window.__holoscrapeRows; if (st) st.detail = v; },
      args: [d],
    });
  } catch (_) {}
}

export async function laneStopped(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: 'MAIN',
      func: () => !!window.__holoscrapeStop,
    });
    return !!r?.result;
  } catch (_) { return false; }
}

// WAIT FOR THE NAVIGATION TO COMMIT — NOT FOR THE MAP TO FINISH PAINTING.
//
// The first version also required `tab.status === 'complete'`, and that is what turned a 13-second
// pass into 4m48s. Maps keeps streaming vector tiles, imagery and logging beacons for tens of
// seconds after the panel is perfectly readable, so `complete` arrives far too late: per-record
// times in the log climb to 20.4s, 21.5s and 27.3s — the 15s navigation ceiling plus the rest.
//
// The panel is what this pass needs, and `dgrab` waits for the panel itself, in the page, where it
// can actually see it. All that is needed out here is proof that the document being injected into is
// the NEW one — which the URL carrying this record's place id establishes on its own.
async function laneArrive(tabId, want) {
  const t0 = Date.now();
  for (;;) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { ok: false, why: 'the tab went away' };
    if (!want || String(tab.url || '').includes(want)) return { ok: true, ms: Date.now() - t0 };
    if (Date.now() - t0 > LANE_NAV_MS) return { ok: false, why: 'the tab never reached this record' };
    await rest(80);
  }
}

// One record, in a tab of its own, in ONE injection. See the `dgrab` case in rows.js for why that
// matters: the engine is serialised and re-parsed on every call, so a poll loop out here costs more
// than everything it is waiting for.
// WARM THE LANE: load the list once, and read every record by CLICKING it after that.
//
// The whole cost of the tab pass is arrival — a Maps boot per record — and that cost is also what draws
// the wall. Measured on one live run of 124 records: navigating cost 3.4-31.7s a record (median 8.8),
// degraded steadily, drew a reCAPTCHA at 103, and returned the web-results block on 3 of 98. The same
// run's rail fallback, which clicks rows in the already-loaded app, read 24 records at 268-1312ms each
// and got web results on 22. Five cold boots instead of 124, and no document loads at all after that.
//
// Returns the container's row count on success. A lane that cannot be warmed says so and the caller
// leaves it on the navigating path — one lane failing must not take the pass with it.
// OFF, AND THE MEASUREMENT IS WHY. This was the right idea and the answer is no.
//
// The theory: a lane that has the list already open reads a record by CLICKING it, the way the rail
// fallback does at 268-1312ms a record against 3.4-31.7s for a page load. The unknown, flagged before
// it was built, was whether Maps' panel — which mounts from a `requestAnimationFrame` — would mount at
// all in a tab nobody is looking at. `cdpPrepare` tells that tab it is visible and focused, and the
// frame keeper is armed on top of it.
//
// It does not. First live run: **14 records opened, 0 filled, 1m2s** — about twenty seconds each,
// which is the arrive budget being burned in full. The click lands, the app accepts it, and no panel
// is ever drawn. Slower and worse than the page loads it was meant to replace.
//
// Left in place rather than deleted, because the idea is still correct — it is what makes the rail
// pass fast and quiet — and what is missing is a way to make a background tab draw. Whoever picks
// this up: the thing to solve is the frame, not the click. `Page.setWebLifecycleState` and focus
// emulation are not enough, so the next thing to try is driving the tab visible for real, or reading
// the panel from something that does not need a paint.
const LANE_WARM = false;
const LANE_WARM_MS = 30000;      // one app boot plus the rail's first rows; generous, paid once
const LANE_HUNT_MS = 8000;       // scrolling this lane's rail to mount a row that is far down

// TWO CLICKS, MEASURED, ON ONE LANE — so the next ordinary run answers why the warm path fails.
//
// The failure is specific and unexplained: the click lands, `history` never moves, and the same call
// on an active tab routes in under a second. Guessing at that from the outside has already produced
// one wrong answer — the note above says "solve the frame, not the click", and the log says the URL
// never changed, which happens long before anything is painted.
//
// So rather than turning the warm path back on and hoping, ONE lane warms, clicks TWO records with
// the `dwarm` probe attached, and goes cold whatever happens. The other four never warm at all, and
// those two records are read by navigation afterwards like any other miss — this cannot cost the run
// more than the arrive budget twice, and it cannot cost it a single record.
//
// ANSWERED, SO OFF. Two live runs, two different cities, the same reading:
//
//   Cimahi   saw=1 prevented=1 pushes=0 ticks=1718 hidden=false backstopped=0
//   Jakarta  saw=1 prevented=1 pushes=0 ticks=1901 hidden=false backstopped=1
//
// The click IS received, Maps' own handler DOES intercept it (`prevented`), animation frames are
// being delivered at ~80/s, and then no navigation is scheduled. It is not the paint and it is not
// the input path — Maps declines to route in a tab that has never been looked at.
//
// Turning it off costs nothing to know and gives lane 0 its records back: the probe's warm plus two
// dead clicks left it at 20 records against 25 for every other lane.
//
// Whoever picks the warm path up: hook `replaceState` and the `location` setter next, and catch
// anything the handler throws. Flip this back to true to re-measure.
const LANE_PROBE = false;
const LANE_PROBE_N = 2;

async function warmLane(tabId, listUrl) {
  try {
    await chrome.tabs.update(tabId, { url: listUrl });
  } catch (e) { return { ok: false, why: e.message }; }
  const t0 = Date.now();
  // Wait for the rail, not for the document. `complete` on Maps arrives long after the app is usable
  // and long before it is — the rows are the only thing worth waiting for.
  for (;;) {
    if (Date.now() - t0 > LANE_WARM_MS) return { ok: false, why: 'the list never appeared in this tab' };
    await rest(500);
    const d = await runRows(tabId, { action: 'detect' }).catch(() => null);
    if (d && !d.error && (d.rows || 0) > 0) {
      // `dgate`, NOT just `detect` — it is what arms the frame keeper (`keepFrames(true)`), and the
      // panel mounts from a `requestAnimationFrame` that a tab nobody is looking at does not run.
      // `cdpPrepare` claims this tab is visible and focused, which SHOULD be enough on its own; the
      // keeper is what actually made the sequential pass work in the background, and arming it costs
      // nothing. `gate.frames` also tells us whether `raf.js` is even present in this tab.
      //
      // Its width check comes along for free and is worth having: each lane has a forced 1440px
      // viewport from `cdpPrepare`, so a TOO_NARROW here would mean the metrics override never
      // applied — which would make every click replace the rail instead of opening beside it.
      const gate = await runRows(tabId, { action: 'dgate' }).catch(() => null);
      await armFrames(tabId, gate).catch(() => {});
      return { ok: !gate?.error, rows: d.rows, frames: gate?.frames || 'unknown',
        why: gate?.error || '', ms: Date.now() - t0 };
    }
  }
}

// ONE RECORD, WITHOUT LOADING A PAGE. The lane already has the list open, so the record is a click.
// `noRow` is not a failure: it means this lane's copy of the search does not hold that place, and the
// caller navigates to it the old way instead — see `dwarm`.
async function laneClick(tabId, link, probe = false) {
  const t0 = Date.now();
  const want = placeToken(link.href);
  if (!want) return { key: link.key, ms: 0, noRow: true, why: 'no place token in the row link' };
  const r = await runRows(tabId, {
    action: 'dwarm', href: link.href, name: link.name, token: want, probe,
    arrive: LANE_ARRIVE_MS, walk: LANE_WALK_MS, web: LANE_WEB_MS, hunt: LANE_HUNT_MS,
  }).catch((e) => ({ error: e.message }));
  if (!r || r.error) {
    return { key: link.key, ms: Date.now() - t0, noRow: true, why: r?.error || 'no answer' };
  }
  if (r.probe) note('lanes.probe', { i: link.i, ...r.probe, why: r.why || '' });
  // A lane whose rail is gone cannot click anything again — the caller drops it back to navigating
  // for the rest of the run rather than asking 20 more times.
  if (r.noList) return { key: link.key, ms: Date.now() - t0, noList: true, why: r.why };
  if (r.noRow) return { key: link.key, ms: Date.now() - t0, noRow: true, why: r.why };
  if (!r.ready) {
    return { key: link.key, ms: Date.now() - t0, timedOut: true, link,
      why: r.why || 'nothing readable', saw: r.saw, mains: r.mains,
      wall: !!r.wall, title: r.title, len: r.len };
  }
  if (link.name && r.name && norm(r.name) !== norm(link.name)) {
    return { key: link.key, ms: Date.now() - t0, timedOut: true,
      why: `panel said ${r.name}`, name: r.name };
  }
  return { key: link.key, ms: Date.now() - t0, got: r.got, fields: r.fields,
    web: !!r.web, steps: r.steps, name: r.name, warm: true };
}

// WAITING FOR SOMETHING THAT IS NOT COMING, AND THIS IS THE WHOLE OF THE SLOWDOWN.
//
// `web` is a CAP, so a record whose web-results frame arrives pays only what it took; one whose
// frame never arrives pays the cap in full. That is fine while frames arrive. Partway through a
// run they stop, and from then on every record buys six seconds of nothing.
//
// Measured, 104 records, with the per-record breakdown this build added:
//
//   band     total    nav    after nav   web found
//   0- 17     7.3s   1.3s      6.0s        100%
//  18- 35     8.6s   2.0s      6.6s        100%
//  36- 53     9.4s   2.0s      7.4s         89%
//  54- 71    13.7s   1.7s     12.0s          0%     <- frames stop; after-nav doubles
//  72- 89    12.7s   2.6s     10.1s         61%
//
// 6.0s to 12.0s is +6.0s, and `LANE_WEB_MS` is 6000. Navigation accounted for 18% of the
// increase; this is the other 82%.
//
// So the budget follows the evidence. While frames are arriving it stays full. After
// `WEB_GIVE_UP` records in a row without one it drops to a probe — long enough to catch a frame
// that is already there, far too short to wait for one that is not. A single success puts it
// back, because the earlier arm of this same question is on record: removing the web wait
// outright cost 73 points of the `Web results` column for 9% of the time. This gives up the wait
// only where it was already buying nothing.
const WEB_GIVE_UP = 6;
const WEB_PROBE_MS = 400;

// READ THE RECORD WITHOUT OPENING IT — always, not a choice.
//
// `/maps/preview/place` returns the same data the panel renders, in 348ms and FLAT (measured over
// 120 records), against a DOM path that runs 9-18s and degrades as a run goes on. It carries
// eleven of the panel's roughly fifteen columns, including the rating breakdown — Top review,
// Review topics, Web results, Claimed and Photos are the only ones either absent from that
// response or rendered client-side, and no amount of parsing recovers them.
//
// This used to be a switch a person could turn off. It was removed on purpose: there was no
// scenario where opening every record instead of only the ones a thin fetch requires was the
// better choice, only ways to make a run slower for no return — so it stopped being a decision
// worth asking anyone to make. Anything that comes back thin is still opened properly rather than
// filed as a stub, so the five columns a fetch cannot carry are still collected on the records
// that need them — just not on the majority that do not.

// A fetch is only allowed to STAND IN for the panel when it actually came back with the record.
// Six is the floor because the nine it can carry are not all present on every place — a business
// with no phone, no website and no hours still yields name, category, address, plus code and
// coordinates — while a thin or throttled reply yields one or two.
const FETCH_MIN_FIELDS = 6;

async function laneRecord(tabId, link, webMs = LANE_WEB_MS) {
  const t0 = Date.now();
  const u = placeUrl(link.href || '');
  if (u) {
    try {
      const res = await fetch(u, { credentials: 'include', cache: 'no-store' });
      if (res.ok) {
        const got = readPlace(parseBody(await res.text()), { name: link.name });
        const n = got ? Object.keys(got).length : 0;
        if (n >= FETCH_MIN_FIELDS) {
          return { key: link.key, ms: Date.now() - t0, nav: 0, got, fields: n,
            web: false, steps: 0, name: got['@Name'] || link.name, viaFetch: true };
        }
        // Too thin to trust. Fall through and open it properly rather than file a stub — a
        // half-read record is the one failure this whole path must not introduce.
        note('fetch.thin', { i: link.i, fields: n, name: (link.name || '').slice(0, 30) });
      } else {
        note('fetch.status', { i: link.i, status: res.status });
      }
    } catch (e) { note('fetch.failed', { i: link.i, why: (e.message || '').slice(0, 60) }); }
  }
  const want = placeToken(link.href);
  await chrome.tabs.update(tabId, { url: link.href }).catch(() => {});
  const nav = await laneArrive(tabId, want);
  if (!nav.ok) return { key: link.key, ms: Date.now() - t0, timedOut: true, why: nav.why };
  const r = await runRows(tabId, {
    action: 'dgrab', href: link.href, name: link.name, token: want,
    arrive: LANE_ARRIVE_MS, walk: LANE_WALK_MS, web: webMs,
  }).catch((e) => ({ error: e.message }));
  if (!r || r.error || !r.ready) {
    // `nav` ON THE FAILURE PATH TOO. A record that took 20 seconds and never arrived is a
    // different problem depending on whether the NAVIGATION took 19 of them or 1, and without this
    // the two are the same line in the log.
    return { key: link.key, ms: Date.now() - t0, nav: nav.ms, timedOut: true, link,
      why: r?.why || r?.error || 'nothing readable', saw: r?.saw, mains: r?.mains,
      wall: !!r?.wall, title: r?.title, len: r?.len };
  }
  // The identity proof again, out here, because a page can only be trusted about itself so far: if
  // the panel names a different place than the row did, this is somebody else's record and must not
  // be filed under this key.
  if (link.name && r.name && norm(r.name) !== norm(link.name)) {
    return { key: link.key, ms: Date.now() - t0, timedOut: true,
      why: `panel said ${r.name}`, name: r.name };
  }
  return { key: link.key, ms: Date.now() - t0, nav: nav.ms, got: r.got, fields: r.fields,
    web: !!r.web, steps: r.steps, name: r.name };
}

// READING 2GIS RECORDS. No tabs, no rail, no third step — and each of those absences is measured.
//
// NO TABS, because the firm page is SERVER-RENDERED: `2gis.kz/almaty/firm/<id>` answers 200 with
// the whole record inline in `initialState`, so a tab would render exactly the bytes a fetch
// already has. There is nothing to fall back to, which is why this has no equivalent of
// `laneRecord`'s fetch-first-then-open. Measured: 60 records in 21.4s across 6 lanes, 357ms each,
// 60/60 parsed.
//
// AND NOT TABS FOR SAFETY, TOO. The Google lane pass draws "a reCAPTCHA after about 100 loads from
// one address". A 236-record 2GIS list opened as tabs would walk straight into that. Fetching does
// not: 400 firm-page requests on one address came back clean, and every refusal seen anywhere in
// this investigation came from a BROWSER signature, never from a fetch at any volume.
//
// NO THIRD STEP, because the email is already here. On Google the address is not in the record at
// all, so `driveSites` goes to each business's own website to find one. 2GIS publishes it:
// measured 70% email and 70% website on 60 records of a B2B vertical, with zero external requests.
// The whole expensive stage simply does not exist for this provider.
const TWOGIS_LANES = 6;          // 8 measured clean; 6 leaves margin on a host we cannot re-probe
const TWOGIS_BATCH = 12;         // one page of results per flush

// The run's own table, read from where it was written rather than from the page it ended on.
export async function savedTablesFor(tabId) {
  try {
    let url = '';
    try { url = (await chrome.tabs.get(tabId)).url || ''; } catch (_) {}
    const { history = [] } = await chrome.storage.local.get('history');
    // THE SESSION KEY DOES NOT SURVIVE PAGING, and that is not a bug in `sessionFor` — it is
    // built from the document token plus the visit URL precisely so that two visits to one page
    // are two runs. A click-walk ends on page 8 of a new document, so asking it here derives a
    // sid the run was never saved under, the lookup misses, and a table holding ninety-three
    // records reads as NOT_DETECTED.
    //
    // So the session is tried first, and the SEARCH ITSELF is the fallback: every page of one
    // search shares `/<city>/search/<query>`, which is the one thing paging does not change.
    const sid = await sessionFor(tabId, url).catch(() => '');
    let row = sid ? history.find((h) => h.sid === sid) : null;
    // A MATCHING SESSION IS NOT PROOF IT IS THE RUN — and this is why the fallback below never
    // saved us. It is guarded on the sid MISSING, and after a click-walk's restore the sid does
    // not miss: the navigation minted a new visit and the passive poll gave it a history row
    // within twenty milliseconds. So the lookup hit a thirteen-row record while the run's
    // hundred and fifteen sat under the previous id, and every record read was filed against
    // rows that did not exist (`2gis.unmatched short=12`).
    //
    // `keepSession` now stops that happening at all. This is the belt: for one search, the
    // FULLER table is the run. A re-read never legitimately shrinks a list — the same rule
    // `saveResult` already applies within a session, applied across the seam where a session
    // was lost.
    const base = String(url).replace(/\/page\/\d+\/?$/, '').replace(/[?#].*$/, '');
    const sameSearch = history.filter((h) => {
      const hb = String(h.url || '').replace(/\/page\/\d+\/?$/, '').replace(/[?#].*$/, '');
      return hb && (hb === base || base.startsWith(hb) || hb.startsWith(base));
    });
    const fullest = sameSearch.sort((a, b) => (b.rows || 0) - (a.rows || 0))[0];
    if (!row) {
      row = fullest;
      if (row) note('2gis.sessionMiss', { why: 'matched the run by search URL instead', id: row.id });
    } else if (fullest && fullest.id !== row.id && (fullest.rows || 0) > (row.rows || 0)) {
      note('2gis.thinSession', { why: 'the session matched a smaller table for the same search',
        had: row.rows || 0, took: fullest.rows || 0, from: row.id, id: fullest.id });
      row = fullest;
    }
    if (!row?.id) return {};
    const k = 'table:' + row.id;
    const got = (await chrome.storage.local.get(k))[k];
    return got ? { id: row.id, tables: got.tables || [], items: got.items || [] } : {};
  } catch (_) { return {}; }
}

async function driveTwoGis(listTab, limit = 0, only = null) {
  // THE ROWS ARE IN THE TABLE, NOT ON THE PAGE — and this is where the Google shape does not
  // transfer.
  //
  // `dlinks` reads the DETECTED LIST on the page in front of you, which is right for Google: its
  // rail is one scrolling list, so what is on screen is the whole run. 2GIS pages, and `hopHere`
  // walks it — after eight pages the SPA has replaced the list DOM, the detected candidate is
  // gone (`NOT_DETECTED`) and the page shows the last twelve records of ninety-three.
  //
  // So the queue comes from the SAVED TABLE, which is the merged result of every page walked, and
  // `dlinks` is only the fallback for the case where no walk has happened yet and the list on
  // screen really is all there is.
  // FROM STORAGE, NOT FROM THE PAGE. `lastTables` goes through `dtables`, which reads the live
  // list and CORRECTLY refuses (`LIST_GONE`) once the container it started on is gone — which is
  // exactly the state an eight-page click-walk leaves behind. Asking it for the run's rows
  // therefore returns nothing, the queue comes back empty, and the pass reports NOT_DETECTED on a
  // table holding ninety-three records.
  //
  // The merged table is on disk under `table:<id>`, keyed by the session, put there by
  // `saveResult` as each page landed. That is the run; the page is just where it ended.
  const saved = await savedTablesFor(listTab);
  const tableId = saved.id || '';
  const fromTable = [];
  for (const t of (saved.tables || [])) {
    for (const row of (t.rows || [])) {
      // A row is a bag of cells; the firm link is whichever value looks like one. Taken by SHAPE
      // rather than by column name, because column keys are per-row DOM paths and a table merged
      // across eight pages has no single key that every row shares.
      for (const v of Object.values(row)) {
        const id = typeof v === 'string' && firmId(v);
        // THE KEY IS `identOf`'s KEY, NOT ONE OF OUR OWN — and inventing one cost a whole pass.
        //
        // `dputMany` files a record into `bag.details` under the row key the ENGINE computed, and
        // that key is `identOf`: the longest href in the row, reduced to `origin + pathname`. A
        // made-up key sets a map entry nothing ever reads, so all 24 records were fetched, parsed
        // and filed under keys belonging to no row — reported as "0 of 24 read, 24 lost" while the
        // fetches were answering 200 with 590KB each.
        //
        // `firmUrl()` already produces exactly that shape, because it strips the `?stat=` blob
        // 2GIS hangs off every result link.
        if (id) { fromTable.push({ key: firmUrl(v), href: v, name: '' }); break; }
      }
    }
  }
  let links = fromTable;
  let via = 'table';
  if (!links.length) {
    const found = await runRows(listTab, { action: 'dlinks' });
    if (found?.error) return { ...found, opened: 0, filled: 0 };
    // RE-KEYED BY FIRM URL, because the engine's key cannot match on this provider.
    //
    // `dlinks` hands back `identOf`: the row's LONGEST link, reduced to `origin + pathname`. On
    // Google that is the record. On 2GIS an advertiser row carries a call-to-action pointing at
    // `link.2gis.com/4.2/<id>/<base64>` — and the base64 payload is in the PATH, so it runs to
    // thousands of characters and beats `…/firm/<id>` every time. Measured on a real export:
    // eight of twelve rows.
    //
    // `flush()` matches on `firmUrl(v)`, so those rows key as a tracker and are looked up as a
    // firm — they can never meet, and the pass reports `unmatched` on records it read perfectly.
    // The `fromTable` branch above already keys by `firmUrl`; this makes the fallback agree, so
    // there is ONE definition of a 2GIS row's identity rather than two that differ on the rows
    // that matter most.
    links = (found.links || []).filter((l) => firmId(l.href || ''))
      .map((l) => ({ ...l, key: firmUrl(l.href) }));
    via = 'page';
  }
  // ONLY `/firm/<id>` — a 2GIS rail also carries category chips and "similar nearby" cards whose
  // links are SEARCHES. `RECORD_HREF` already filters these in the engine; this is the second
  // gate, because a search URL fetched as a record returns a list and parses as nothing.
  const seenId = new Set();
  // NAMED BY THE CALLER, when the walk is reading page by page. Without it each page's pass would
  // start again from row one — the same records re-fetched once per page, for nothing.
  if (only && only.length) {
    const want = new Set(only.map((h) => firmId(h || '')).filter(Boolean));
    links = links.filter((l) => want.has(firmId(l.href || '')));
  }
  const queue = (limit > 0 ? links.slice(0, limit) : links.slice())
    .filter((l) => { const id = firmId(l.href || ''); 
      if (!id || seenId.has(id)) return false; seenId.add(id); return true; });
  const found = { rows: queue.length, map: '2gis', already: 0 };
  const total = queue.length;
  // WHICH TABLE, AND HOW BIG. `rows` alone said 12 on every page of a walk that had 36 saved, and
  // three different explanations fitted that one number. The id it read and the id it will write
  // back to are the two facts that separate them.
  note('2gis.start', { rows: found.rows, records: total, lanes: TWOGIS_LANES, via,
    id: tableId, have: (saved.tables || []).reduce((a, t) => a + (t.rows || []).length, 0),
    only: only ? only.length : 0 });
  if (!total) {
    return { opened: 0, filled: 0, lost: 0, map: found.map, already: found.already || 0,
      why: found.already ? '' : 'no firm links on this list', rows: found.rows,
      ...(await lastTables(listTab)) };
  }

  let opened = 0, filled = 0, lost = 0, walled = '';
  const t0 = Date.now();
  const pending = [];
  detailRun.set(listTab, { running: true, at: Date.now(), total, opened: 0, filled: 0 });
  // The list tab is claimed for the whole pass, exactly as the lane pass claims it: its own
  // 2.5-second poll must not re-read the page and save over what is being built.
  walking.add(listTab);

  // WRITTEN INTO THE SAVED TABLE, NOT INTO THE PAGE — and this is the whole reason the first
  // build reported "12 answered without opening anything" and exported twelve unnamed columns.
  //
  // `dputMany` files a record into `bag.details`, which belongs to the CANDIDATE ON THE PAGE. That
  // is right for Google, where the list never leaves one document. A click-walk's rows live in
  // `merged` — built in the worker, written to `table:<id>` by `saveResult` as each page landed —
  // so the page in front of you holds the last twelve of a hundred and thirteen. Details filed
  // there are attached to a bag nothing exports, and `dtables` then reads that page rather than
  // the run. Every record was fetched and parsed correctly and none of it reached the export.
  //
  // So the merge happens where the rows actually are: match on the firm URL, which is the row key
  // `identOf` already produced, and write the table back.
  const flush = async (force = false) => {
    if (!pending.length && !force) return;
    const items = pending.splice(0, pending.length);
    if (!items.length) return;
    const by = new Map(items.map((i) => [i.key, i.got]));
    try {
      const { history = [] } = await chrome.storage.local.get('history');
      const row = history.find((h) => h.id === tableId);
      const k = 'table:' + (row?.id || tableId);
      const store = (await chrome.storage.local.get(k))[k];
      if (!store) { lost += items.length; filled -= items.length; return; }
      // ONE COLUMN PER THING, ACROSS BOTH STEPS.
      //
      // Step 1 names the list's own columns (`Category`, `Phone`, `Website`, `Rating`, …) and the
      // record reader produces `@Category`, `@Phone`, `@Website`, `@Rating` … for the same facts.
      // Written blind, step 2 therefore appended a SECOND column for every one of them: two
      // `Category`, two `Phone`, two `Rating`, and a table that doubled in width and read as
      // reshuffled because a whole parallel set landed at the end.
      //
      // So a record field goes into the column step 1 already opened for it, and only creates a
      // column when there is genuinely no home. Same names, same order, and the record's value —
      // which is the better one: a clean `+7…` rather than a `tel:` href, the real website rather
      // than a `link.2gis.com` tracker.
      const LABEL = (k) => k.slice(1).replace(/ (src|srcset|href)$/, '');
      // The two vocabularies agree everywhere except here, where the reader is more precise than
      // the card. Listed rather than fuzzy-matched: a wrong merge silently overwrites a column.
      const ALIAS = { 'Street address': 'Address', 'Phone (intl)': 'Phone intl' };
      let hit = 0;
      for (const t of (store.tables || [])) {
        const home = new Map();
        for (const c of (t.cols || [])) if (c.name) home.set(c.name, c.key);
        const into = (k) => {
          const label = LABEL(k);
          return home.get(ALIAS[label] || label) || home.get(label) || k;
        };
        for (const r of (t.rows || [])) {
          for (const v of Object.values(r)) {
            if (typeof v !== 'string') continue;
            const got = by.get(firmUrl(v));
            if (!got) continue;
            for (const [k, val] of Object.entries(got)) {
              if (val == null || String(val).trim() === '') continue;
              r[into(k)] = val;
            }
            hit++;
            break;
          }
        }
      }
      // AND THE TABLE HAS TO GROW COLUMNS TO SHOW THEM. This is "filled=38, lost=0, and the
      // table looks exactly the same".
      //
      // `Object.assign` puts `@Phone`, `@Email`, `@Website` on the row objects, and that is the
      // whole of what this pass was doing. But the results window and every export render from
      // `t.cols` — `s.cols.filter(…)` in `table.js`, never `Object.keys(row)` — so a key with no
      // column entry is in storage and on screen nowhere. Measured: `2gis.done opened=38
      // filled=38 lost=0` over a run that showed no contact column at all.
      //
      // The engine never has this problem because it derives columns FROM the rows every time it
      // extracts (`extractOne`: first-seen key order, `filled` counted as non-empty). This path
      // writes storage directly and so has to do the same job here, by the same rules — one
      // definition of what a column is, not two.
      //
      // Existing columns are kept as they stand, names and all: `nameCols` has already worked out
      // what the list's own columns are called, and re-deriving them would throw that away. New
      // keys are appended in first-seen order. `filled` is recomputed for EVERY column, because
      // the merge changes the counts and `filled` is what the results window hides a sparse
      // column by — a stale zero would hide the very column this pass exists to add.
      const ASSET_KEY = /\b(src|data-src|data-original|data-lazy-src|srcset|data-srcset)$/;
      const nonEmpty = (v) => v != null && String(v).trim() !== '';
      for (const t of (store.tables || [])) {
        const cols = t.cols || (t.cols = []);
        const known = new Set(cols.map((c) => c.key));
        for (const r of (t.rows || [])) {
          for (const key of Object.keys(r)) {
            if (known.has(key)) continue;
            known.add(key);
            cols.push({ key,
              kind: ASSET_KEY.test(key) ? 'asset' : /\bhref$/.test(key) ? 'link' : 'text',
              // THE `@` IS A MARKER AND NEVER REACHES THE USER — `nameCols` strips it, and this
              // path does not go through `nameCols`, so a column would have shipped headed
              // `@Phone`. Same rule, stated once more where the other half of the work happens.
              ...(key.startsWith('@')
                ? { name: key.slice(1).replace(/ (src|srcset|href)$/, '') } : {}),
              filled: 0 });
          }
        }
        for (const c of cols) c.filled = (t.rows || []).filter((r) => nonEmpty(r[c.key])).length;
        // AND EVERY `@` COLUMN CARRIES ITS NAME, not only the ones this pass created. A table
        // written by an earlier build has record columns with no `name`, and they shipped as
        // `Text 45`, `Text 48`, `Text 60` — the phone, the email and the firm id, numbered like
        // DOM paths. Repaired on every merge rather than only on creation.
        for (const c of cols) {
          if (!c.name && c.key.startsWith('@')) {
            c.name = c.key.slice(1).replace(/ (src|srcset|href)$/, '');
          }
        }

        // DEDUPE, AT THE END OF STEP 2. Two columns under one name is not a table — the results
        // window offers the same header twice in its column menu and the export writes one key
        // twice, so whichever comes last silently wins. Merging record fields into the column step
        // 1 opened (above) prevents most of it; this is the sweep that guarantees it, including for
        // tables written by an earlier build.
        //
        // The FULLER column keeps the name and takes any value the other holds where it is empty,
        // so deduping never loses a cell. A column left with nothing in it is dropped outright —
        // the same rule the engine applies: a column that holds no information is not a column.
        // STEP 1'S ORDER IS THE TABLE'S ORDER, ENFORCED RATHER THAN HOPED FOR.
        //
        // Everything below preserves it — the merge writes into columns that already exist, the
        // dedupe keeps the earlier position — but "preserves it as a side effect" is how it broke
        // three times. So it is now stated: whatever step 1 settled on keeps its sequence, and
        // step 2 may only APPEND. `seq` is that record, and the sort at the end obeys it.
        const seq = new Map();
        (t.cols || []).forEach((c, i) => seq.set(c.key, i));

        // THE EARLIER COLUMN SURVIVES — position is step 1's, values are step 2's.
        //
        // Letting the FULLER column win was wrong and moved the table: `@Photo` fills twelve rows
        // where the card's thumbnail filled one, so `Photo` jumped from its step-1 slot to the end.
        // Every merged name did the same and the whole table read as reshuffled.
        //
        // So the survivor is always the one already in place, and the record's value wins inside
        // it — that is the better value anyway (`+7…` over a `tel:` href, the real photo over a
        // thumbnail). Order comes from step 1, content from step 2, and neither fights the other.
        const keep = new Map();
        for (const c of cols) {
          if (!c.name) continue;
          const first = keep.get(c.name);
          if (!first) { keep.set(c.name, c); continue; }
          for (const r of (t.rows || [])) {
            if (nonEmpty(r[c.key])) r[first.key] = r[c.key];
          }
          first.filled = (t.rows || []).filter((r) => nonEmpty(r[first.key])).length;
          c.drop = true;
        }
        t.cols = cols.filter((c) => !c.drop && (c.filled > 0 || !c.name));
        // Step 1's columns in step 1's order, then the record's, in the order the reader produced
        // them. Stable, so anything the map does not know about keeps where it was put.
        // Again after the record lands: its fields give the orphans more named columns to be
        // proved against than the list alone ever had.
        foldOrphans(t, true);
        const seqOf = (c) => (seq.has(c.key) ? seq.get(c.key) : seq.size + 1);
        t.cols = t.cols
          .map((c, i) => [c, i])
          .sort((a, b) => (seqOf(a[0]) - seqOf(b[0])) || (a[1] - b[1]))
          .map(([c]) => c);
      }
      // A record that matched no row is genuinely lost — it was read and has nowhere to go.
      const short = items.length - hit;
      if (short > 0) { lost += short; filled -= short; note('2gis.unmatched', { short }); }
      note('2gis.merged', { hit, cols: (store.tables || []).map((t) => t.cols.length).join('+') });
      await chrome.storage.local.set({ [k]: store });
    } catch (e) {
      lost += items.length; filled -= items.length;
      note('2gis.mergeFailed', { why: (e.message || '').slice(0, 60) });
    }
  };

  try {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(TWOGIS_LANES, total) }, async () => {
      for (;;) {
        if (walled || await laneStopped(listTab)) return;
        const i = cursor++;
        if (i >= total) return;
        const link = queue[i];
        const t0 = Date.now();
        try {
          const res = await fetch(firmUrl(link.href), FIRM_INIT);
          if (!res.ok) {
            // A 403 here is the bot wall, not a missing record — and it must stop the pass rather
            // than be counted as 60 individually broken businesses.
            if (res.status === 403 || res.status === 429) { walled = `HTTP ${res.status}`; return; }
            lost++; note('2gis.status', { i, status: res.status }); continue;
          }
          const html = await res.text();
          if (/2GIS Captcha|подозрительную активность/i.test(html.slice(0, 4000))) {
            walled = 'challenge'; return;
          }
          const got = readFirmHtml(html, { id: firmId(link.href), name: link.name });
          opened++;
          if (got) {
            filled++;
            pending.push({ key: link.key, got });
            if (pending.length >= TWOGIS_BATCH) await flush();
          } else { lost++; }
          note('2gis.record', { i, ms: Date.now() - t0, fields: got ? Object.keys(got).length : 0,
            name: (got?.['@Name'] || link.name || '').slice(0, 34) });
        } catch (e) {
          lost++; note('2gis.failed', { i, why: (e.message || '').slice(0, 60) });
        }
        detailRun.set(listTab, { ...detailRun.get(listTab), running: true, total, opened, filled });
      }
    }));
    await flush(true);
  } finally {
    walking.delete(listTab);
  }

  if (walled) noteWall(queue[0]?.href || 'https://2gis.kz/');
  const out = { opened, filled, lost, total, map: '2gis',
    // Every record came from a fetch. Said explicitly so the card can report it the way the Google
    // pass reports `viaFetch` — on this provider it is always all of them.
    viaFetch: filled, viaTab: 0,
    walled: !!walled, left: walled ? Math.max(0, total - opened) : 0,
    why: walled ? `2GIS asked us to slow down (${walled})` : '',
    ...(await lastTables(listTab)) };
  detailRun.set(listTab, { running: false, at: Date.now(), total, opened, filled, result: out });
  // ONE SUMMARY LINE, THEN THE FILE. `driveDetailsTabs` and `driveDetails` both end this way and
  // this pass was silently the exception — a 2GIS run wrote no log at all, which is the same class
  // of gap as the asset walk that produced no file and left "why did it stop" unanswerable.
  note('2gis.done', { total, opened, filled, lost, walled: walled || '', left: out.left,
    secs: Math.round((Date.now() - t0) / 1000) });
  if (DEV && devLog) saveLog().catch(() => {});
  return out;
}

export async function driveDetailsTabs(listTab, limit = 0, lanes = 0) {
  // NO WIDTH CHECK HERE, and this was a shipped bug worth naming.
  //
  // The first version called `dgate` before anything else. `dgate` refuses below 1280px, because a
  // click in a narrow window REPLACES the rail — and so, on a 1118px window, the tab path returned
  // TOO_NARROW on its first call and fell straight through to the rail-click pass. A width gate in
  // front of the one path that has no use for width: the lanes never click the rail, and each one
  // has its own 1440px viewport from `cdpPrepare` whatever the real window is.
  //
  // `dlinks` asks the only questions that matter here — is there a detected list, is it still
  // standing, is this a map we know how to read — and refuses on its own terms.
  const found = await runRows(listTab, { action: 'dlinks' });
  if (found?.error) return { ...found, opened: 0, filled: 0 };
  const queue = limit > 0 ? found.links.slice(0, limit) : found.links.slice();
  const total = queue.length;
  // Never more lanes than there are records to read; otherwise the constant.
  lanes = Math.max(1, Math.min(lanes > 0 ? lanes : LANES, total));
  note('lanes.start', { rows: found.rows, records: total, skipped: found.skipped,
    already: found.already, lanes, map: found.map });
  if (!total) {
    // `already` is carried out, and it is the difference between two opposite situations that
    // both arrive here as "nothing to open": a list whose rows cannot be opened at all, and one
    // whose records have ALL been read. The second is a finished job, and the panel needs to know
    // that to say so — and to offer the step after it. See `openDetails`, which without this
    // fell through and re-ran the whole rail pass to discover the same nothing.
    return { opened: 0, filled: 0, lost: 0, skipped: found.skipped || 0, map: found.map,
      already: found.already || 0,
      why: found.already ? '' : 'no record links on this list', rows: found.rows,
      ...(await lastTables(listTab)) };
  }

  let opened = 0; let filled = 0; let lost = 0;
  // HOW THE RECORD WAS ANSWERED, counted rather than only logged.
  //
  // `laneRecord` has returned `viaFetch` since the fetch-first path was built, and nothing read it —
  // so the one number that says whether that path is earning its keep existed and was thrown away on
  // every run. It is also the difference the user feels: a fetched record costs one request and no
  // page load, a tabbed one costs a whole Google Maps. A summary that says "119 answered without
  // opening anything, 1 opened in a tab" describes what actually happened to their browser.
  let byFetch = 0;
  // DISTINCT records actually read. `filled` counted 124 while the table held five places repeated,
  // because a count of writes says nothing about what was written. If this ends up far below
  // `filled`, lanes are reading each other's leftovers again — see `laneRecord`.
  // SHARED ACROSS LANES ON PURPOSE. The frames stop arriving for the whole pass at once, not per
  // lane, so five lanes each counting to six privately would take five times as long to notice.
  let webMiss = 0;
  let webCut = false;
  const webBudget = () => (webCut ? WEB_PROBE_MS : LANE_WEB_MS);
  const webSaw = (got) => {
    if (got) {
      if (webCut) note('lanes.webBack', { why: 'a web-results frame arrived again - full wait restored' });
      webMiss = 0; webCut = false;
      return;
    }
    if (++webMiss >= WEB_GIVE_UP && !webCut) {
      webCut = true;
      note('lanes.webCut', { after: webMiss, from: LANE_WEB_MS, to: WEB_PROBE_MS,
        why: 'no web-results frame in six records running - not buying the full wait any more' });
    }
  };
  const seenNames = new Set();
  // Records that gave nothing, kept so they can be tried once more after a pause — and whether the
  // site actually asked for verification, which changes what the pause is for.
  const missed = [];
  // FILED IN BATCHES, AND SAVED ALONG THE WAY.
  //
  // Two separate problems, one buffer. `dput` per record meant 124 engine parses on the list tab, the
  // one tab every lane queues behind. And nothing reached STORAGE until `dtables` at the very end — so
  // when a run met a reCAPTCHA at record 103, everything it had gathered lived only in that page's
  // memory, and reloading the tab to solve the challenge threw all of it away. Confirmed from a real
  // run: "our systems have detected unusual traffic from your computer network".
  const FILE_EVERY = 8;
  const SAVE_EVERY = 24;
  const pending = [];
  let sinceSave = 0;
  const flush = async (force = false) => {
    if (pending.length) {
      const items = pending.splice(0, pending.length);
      const put = await runRows(listTab, { action: 'dputMany', items }).catch(() => null);
      const landed = put?.got ?? 0;
      if (landed < items.length) {
        // Counted optimistically when read; corrected here if the page would not take them.
        const short = items.length - landed;
        filled = Math.max(0, filled - short);
        lost += short;
        note('lanes.notFiled', { short, why: put?.error || 'the list would not take them' });
      }
      sinceSave += items.length;
    }
    // `dtables` reads the rail and goes through the save gate, so this is what puts the details on
    // disk. Every 24 records, and always on the way out: a pass that is interrupted keeps what it got.
    if (sinceSave >= SAVE_EVERY || (force && sinceSave)) {
      sinceSave = 0;
      await runRows(listTab, { action: 'dtables' }).catch(() => {});
    }
  };
  let walled = false;
  let streak = 0;
  let regained = 0;
  let sharePer = '';
  const link0 = queue[0]?.href || '';
  // The list tab is claimed for the whole run: its own poll must not extract while details are
  // still arriving, exactly as in the sequential pass. Counted, so nothing else releases it.
  walking.add(listTab);
  abandoned.delete(listTab);
  detailRun.set(listTab, { running: true, at: Date.now(), total, opened: 0, filled: 0 });
  const tabs = [];
  const targets = [];
  // Registered as they are created, not after: if the panel closes while the third lane is still
  // being set up, `abandon` has to be able to close the two that already exist.
  laneTabs.set(listTab, { tabs, targets });
  try {
    for (let i = 0; i < Math.min(lanes, total); i++) {
      const t = await chrome.tabs.create({ url: 'about:blank', active: false });
      tabs.push(t.id);
      // The debugger gives what no injection can: a desktop viewport whatever the window is, and a
      // tab that is not throttled for being out of sight. See `cdpPrepare`.
      try {
        await chrome.debugger.attach({ tabId: t.id }, CDP_VERSION);
        const target = { tabId: t.id };
        await lanePrepare(target);
        targets.push(target);
      } catch (e) {
        note('lanes.noDebugger', { why: e.message });
        targets.push(null);
      }
    }
    // WARM EACH LANE WITH THE LIST ITSELF, so every record after this is a click and not a page load.
    // Done in parallel — five boots at once, once, instead of one per record — and a lane that will not
    // warm simply stays on the navigating path. See `warmLane`.
    const listUrl = (await chrome.tabs.get(listTab).catch(() => null))?.url || '';
    const warm = tabs.map(() => false);
    const clickFails = tabs.map(() => 0);
    let probeLeft = 0;
    let warming = null;
    if (LANE_WARM && listUrl) {
      const w = await Promise.all(tabs.map((tid) => warmLane(tid, listUrl).catch((e) => ({ ok: false, why: e.message }))));
      w.forEach((r, i) => { warm[i] = !!r.ok; });
      note('lanes.warm', { ok: w.filter((r) => r.ok).length, of: tabs.length,
        rows: w.map((r) => r.rows || 0).join('/'), frames: w.map((r) => r.frames || '?').join('/'),
        ms: w.map((r) => r.ms || 0).join('/'), why: w.map((r) => r.why || '').filter(Boolean).join(' | ') });
    } else if (LANE_PROBE && listUrl) {
      // STARTED, NOT AWAITED. Warming is a page load with a 30s ceiling, and awaiting it here would
      // hold all five lanes at the start of the run for a measurement four of them have no use for.
      // Lane 0 collects it on its own first turn; the others are already reading by then.
      warming = warmLane(tabs[0], listUrl).catch((e) => ({ ok: false, why: e.message }));
    }
    // ONE SHARED QUEUE, taken from one at a time. The comment here used to describe a shared queue
    // and the code dealt out fixed interleaved slices instead — which has the same tail problem as
    // rounds, just less visible: the run ends at the speed of the unluckiest fifth. Measured on the
    // site pass, which had the identical shape: the last 47 seconds of a run had one lane working and
    // four tabs idle. A cursor costs nothing and the tail becomes one slow record, not one slow slice.
    let cursor = 0;
    const per = tabs.map(() => 0);
    await Promise.all(tabs.map(async (tid, li) => {
      for (;;) {
        if (cursor >= queue.length) return;
        const link = queue[cursor++];
        per[li]++;
        // Two ways to stop: the user pressed Stop (a flag on the page), or the panel went away and
        // there is nobody left to stop it. The second is checked FIRST because it is free — asking
        // the page costs an injection, and a page whose panel has closed may be gone too.
        if (abandoned.has(listTab)) return;
        // A CHALLENGE SEEN BY ONE LANE IS A CHALLENGE FOR ALL FIVE. Without this, each remaining lane
        // spends its own full arrive budget rediscovering the same wall — five records and twenty-odd
        // seconds to learn something already known, every one of them another request against a door
        // that is already shut.
        if (walled) return;
        if (await laneStopped(listTab)) return;
        opened++;
        // CLICK IF THIS LANE IS WARM, NAVIGATE IF IT IS NOT — and fall back per record, not per pass.
        //
        // Three ways a click declines, and only one of them is about the lane: `noRow` means this
        // lane's copy of the search does not hold that place, so navigate to it and carry on clicking
        // the rest. `noList` means the rail is gone from this tab and no further click can work, so
        // the lane goes cold for good. Anything else is a real read failure and is reported as one.
        // The probe's warm, collected on lane 0's first turn rather than before the pass.
        if (li === 0 && warming) {
          const w = await warming;
          warming = null;
          warm[0] = !!w.ok;
          probeLeft = w.ok ? LANE_PROBE_N : 0;
          note('lanes.probeWarm', { ok: !!w.ok, rows: w.rows || 0, frames: w.frames || '?',
            ms: w.ms || 0, records: probeLeft, why: w.why || '' });
        }
        const probing = probeLeft > 0 && li === 0;
        if (probing) probeLeft--;
        let r = warm[li]
          ? await laneClick(tid, link, probing).catch((e) => ({ key: link.key, noRow: true, why: e.message }))
          : null;
        // The probe is spent whatever it found. Two records is the measurement; a third would be
        // the experiment this is deliberately not running.
        if (probing && probeLeft <= 0) {
          warm[0] = false;
          note('lanes.wentCold', { lane: 0, why: 'the probe has its two records' });
        }
        if (r && r.noList) { warm[li] = false; note('lanes.wentCold', { lane: li, why: r.why }); }
        // TWO FAILED CLICKS AND THE LANE STOPS CLICKING. This guard is the difference between an
        // experiment that costs nothing and one that costs the whole run.
        //
        // A click that LANDS and then never yields a panel returns `timedOut`, not `noRow`, so the
        // per-record fallback below did not fire and every record burned the full arrive budget
        // instead. Measured on the first live run: 14 opened, 0 filled, 1m2s — twenty seconds a
        // record, slower than the page loads the clicking was meant to replace, and it would have
        // run the whole list that way.
        //
        // So a lane proves the click works or gives it up. Two in a row is enough: one can be a
        // genuinely bad record, two is the tab.
        if (r && r.timedOut) {
          clickFails[li] = (clickFails[li] || 0) + 1;
          if (clickFails[li] >= 2) {
            warm[li] = false;
            note('lanes.wentCold', { lane: li, why: 'two clicks in a row drew no panel' });
          }
          // Not filed as a loss — the navigating path below gets to try this record properly.
          r = null;
        } else if (r && r.got) clickFails[li] = 0;
        if (r && (r.noRow || r.noList)) {
          note('lanes.byNav', { lane: li, i: link.i, why: r.why });
          r = null;
        }
        if (!r) {
          r = await laneRecord(tid, link, webBudget())
            .catch((e) => ({ key: link.key, timedOut: true, why: e.message }));
          // A navigation leaves this tab on a place page, so its rail is gone and the lane is cold
          // from here on. Re-warming per record would be the page load we are trying to avoid.
          if (warm[li]) { warm[li] = false; note('lanes.wentCold', { lane: li, why: 'navigated away from the list' }); }
        }
        if (r.got && Object.keys(r.got).length) {
          // BUFFERED, not filed one at a time — see `dputMany`. Every `dput` was a full engine parse
          // on the list tab, the one tab all five lanes queue behind.
          pending.push({ key: r.key, got: r.got });
          if (r.viaFetch) byFetch++;
          filled++; streak = 0;
          if (pending.length >= FILE_EVERY) await flush();
        } else {
          lost++;
          // KEPT FOR A SECOND ATTEMPT. Seventeen records at the tail of a 124-record pass failed
          // together — the shape of a site that has had enough, not of seventeen broken records —
          // and they were simply dropped. A miss goes on the list instead.
          missed.push(link);
          // AND IF THE SITE ASKED FOR VERIFICATION, EVERY LANE STOPS NOW.
          //
          // Confirmed from a real run: a reCAPTCHA on a /maps/place/ URL — "our systems have detected
          // unusual traffic from your computer network". Once that appears, every further record is a
          // request against a wall that is already up, and continuing to send them is how a soft
          // challenge becomes a hard block. See the note by `walledUntil`.
          // LOGGED BEFORE RETURNING. This `return` used to jump out above the `note('record')` below,
          // so the five records that met the wall left no trace at all: a log showing 98 record lines
          // under `opened=103`, with the five that explain the whole run missing. The one line that
          // matters most was the one being dropped.
          if (r.wall) {
            walled = true;
            note('record', { i: link.i, lane: li, arrived: false, ms: r.ms, fields: 0, web: false,
              via: 'tab', filled, name: (link.name || '').slice(0, 34),
              why: 'the site asked to verify you are a person' });
            return;
          }
          // Failures arriving in a row mean the site is pushing back; going faster at that moment is
          // the wrong move. Same reasoning as the pace in `hopTabs`, applied per lane.
          streak++;
          if (streak >= 3) await rest(Math.min(6000, 800 * streak));
        }
        await laneTick(listTab, { at: opened, of: total, opened, filled, lost, lanes });
        // The NAME goes in the line. Without it the log of the repeating-payload run looked perfect:
        // 124 records, 124 filled, 17-20 fields each — and every one of them the same five places.
        // A count cannot show that; a name can, at a glance.
        // WHERE THE TIME WENT, not just how much of it there was — and this line has been costing
        // real conclusions by omitting it.
        //
        // `ms` here is the WHOLE record: navigate, wait for the panel, walk it, wait for the web
        // frame. Read as an arrival time it says the site is throttling us; read correctly it
        // might say nothing of the kind, because `LANE_WALK_MS` is 5s and `LANE_WEB_MS` is 6s, so
        // up to eleven seconds of every record is OUR OWN BUDGET.
        //
        // The evidence that this matters: navigating to a record and waiting for its panel to name
        // itself, measured on its own over 36 records in one reused tab, costs **0.4-1.2s and does
        // not degrade** (`test/_throttle-source.mjs`). The same operation inside a run logs 9-18s.
        // Whatever doubles across a run, it is not the part that was being blamed.
        //
        // `laneRecord` has returned `nav` and `steps` all along and this line dropped both — the
        // same fault as the website read only to be discarded, and the wall computed and not
        // logged. Third time. The rule is: carry the whole object and name what you drop.
        // FED BACK BEFORE THE LINE IS WRITTEN, so `web=` in the log and the budget the next
        // record gets are the same fact. A record that never arrived says nothing about whether
        // frames are still coming, so only real reads count.
        if (!r.timedOut) webSaw(!!r.web);
        note('record', { i: link.i, lane: li, arrived: !r.timedOut, ms: r.ms,
          nav: r.nav, steps: r.steps, webMs: webBudget(),
          // `via` now distinguishes the two ways a lane can read a record, because the whole point of
          // the warm path is that these two columns should look different: a click should be an order
          // of magnitude faster and should carry web results, and this line is where that is checked.
          fields: r.fields || 0, web: !!r.web, via: r.warm ? 'click' : 'tab', filled,
          name: (r.got?.Name || r.got?.['@Name'] || link.name || '').slice(0, 34),
          why: r.why || '' });
        if (r.got) seenNames.add(norm(r.got.Name || r.got['@Name'] || link.name || String(link.i)));
        detailRun.set(listTab, { ...detailRun.get(listTab), running: true, total, opened, filled });
      }
    }));
    sharePer = per.join('/');
    // Whatever is still buffered goes in now, and on disk, before anything else is decided.
    await flush(true);

    // A SECOND ATTEMPT FOR THE MISSES, on two lanes instead of five.
    //
    // A 124-record pass lost its last seventeen together: `ms` had been climbing from 4s to 23s and
    // the website block had stopped rendering thirty records earlier. That is a site slowing us down
    // and then refusing — not seventeen individually broken records — and the same records read
    // perfectly at the start of the run. So they are worth asking for again, once, quietly.
    //
    // Two lanes, not five, and a pause first. If the site actually asked for verification the pause
    // is longer and the whole thing is written off, because answering a challenge by trying again is
    // exactly how a soft refusal becomes a ban — see the note by `walledUntil`.
    if (missed.length && !abandoned.has(listTab) && !(await laneStopped(listTab))) {
      note('lanes.retry', { misses: missed.length, walled, after: walled ? 60 : 15 });
      if (walled) {
        noteWall(link0 || 'https://www.google.com/maps');
        note('lanes.gaveUp', { why: 'the site asked for verification', misses: missed.length });
      } else {
        // THE PAUSE IS FOR A SITE PUSHING BACK, so it should be sized by the evidence that it is.
        //
        // A flat 15s cost 21 seconds to recover ONE record on a real run: `lanes.retry misses=1
        // walled=false after=15`, then the record read in 5.8s. The pause exists because seventeen
        // misses arriving together is a site that has had enough — but one miss with no wall is a
        // single slow record, and there is nothing to cool off from.
        //
        // Three seconds a miss, capped at the original fifteen. One miss waits 3s; a real pile-up
        // still gets the full quarter-minute.
        await rest(Math.min(15000, 3000 * missed.length));
        const again = missed.slice();
        const pair = tabs.slice(0, 2);
        await Promise.all(pair.map(async (tid, li) => {
          for (let n = li; n < again.length; n += pair.length) {
            if (abandoned.has(listTab) || await laneStopped(listTab)) return;
            const link = again[n];
            const r = await laneRecord(tid, link).catch(() => ({ timedOut: true }));
            if (r.got && Object.keys(r.got).length) {
              const put = await runRows(listTab, { action: 'dput', key: r.key, got: r.got,
                at: opened, of: total, opened, filled: filled + 1, lost: Math.max(0, lost - 1),
                lanes }).catch(() => null);
              if (put?.got) { filled++; lost = Math.max(0, lost - 1); regained++;
                if (r.viaFetch) byFetch++; }
            }
            note('record', { i: link.i, lane: `retry${li}`, arrived: !r.timedOut, ms: r.ms,
              fields: r.fields || 0, via: 'tab', filled, name: (link.name || '').slice(0, 34),
              why: r.why || '' });
            if (r.got) seenNames.add(norm(r.got.Name || r.got['@Name'] || link.name || ''));
            await rest(1200);
          }
        }));
        note('lanes.retried', { regained, stillLost: lost });
      }
    }
  } finally {
    // Last chance: a pass that threw, was stopped, or was abandoned still keeps what it read.
    await flush(true).catch(() => {});
    // `abandon` may already have taken these; both paths are idempotent because every call is
    // guarded and `laneTabs.delete` happens before the closing starts.
    laneTabs.delete(listTab);
    for (const t of targets) if (t) await chrome.debugger.detach(t).catch(() => {});
    // ONE TAB SURVIVES A CHALLENGE, AND IT IS BROUGHT TO THE FRONT.
    //
    // This is the fix for the worst part of a walled run. The challenge appears in a LANE tab, which
    // is opened in the background and closed here — so the reCAPTCHA the user has to solve was being
    // destroyed before they could ever see it, and the card said nothing about it. A pass that tells
    // somebody to verify themselves while shutting the only window that could is no help at all.
    //
    // So on a wall the first lane is kept and focused, its debugger already detached so it behaves
    // like an ordinary tab. Solving it there clears the challenge for the whole browser; the pass can
    // then be started again and will skip everything already read.
    const keep = walled ? tabs.shift() : null;
    for (const tid of tabs) await chrome.tabs.remove(tid).catch(() => {});
    if (keep != null) {
      // KEPT, BUT NOT BROUGHT FORWARD. An earlier version focused it, which was right when a wall
      // ended the run — and is wrong now that it does not. The rest of the records are about to be
      // read on the LIST tab, and pulling focus away from that mid-pass is both alarming and the kind
      // of interference this pass has already been bitten by. The tab stays available for whoever
      // wants to clear the challenge; nothing waits on them.
      note('lanes.leftOpen', { tab: keep,
        why: 'the challenge is in this tab if you want to clear it — the rest is read from the list' });
    }
    detailedAt.set(listTab, Date.now());
    walking.delete(listTab);
  }
  // `distinct` is the number that matters. filled=124 distinct=5 is the repeating-payload bug; the
  // two should be within a handful of each other (a list really can hold two branches of one name).
  note('lanes.done', { opened, filled, distinct: seenNames.size, lost, regained, walled,
    skipped: found.skipped, lanes, total, per: sharePer, viaFetch: byFetch,
    viaTab: Math.max(0, filled - byFetch),
    warn: seenNames.size * 2 < filled ? 'DISTINCT FAR BELOW FILLED — lanes may be repeating' : '' });
  if (DEV && devLog) saveLog().catch(() => {});
  // WHAT STOPPED IT, carried out to the panel. `why` was hardcoded empty, so a run that met a
  // reCAPTCHA reported the same nothing as a run that finished — and the card had no way to offer the
  // one action that would help. `left` is what a second press would still have to read.
  const out = { opened, filled, lost, skipped: found.skipped || 0, map: found.map,
    walled, left: Math.max(0, total - filled),
    why: walled ? 'the site asked to verify you are a person' : '',
    // CARRIED TO THE PANEL, because "how many of these needed a tab opening" is a question about
    // the user's own browser and the only place it can be answered is the summary.
    viaFetch: byFetch, viaTab: Math.max(0, filled - byFetch),
    lanes, via: 'tabs', rows: found.rows, ...(await lastTables(listTab)) };
  detailRun.set(listTab, { running: false, at: Date.now(), total, opened, filled, result: out });
  return out;
}

async function driveDetails(tabId, limit = 0) {
  const gate = await runRows(tabId, { action: 'dgate' });
  if (gate?.error) return { ...gate, opened: 0, filled: 0 };
  const frames = await armFrames(tabId, gate);

  const total = limit > 0 ? Math.min(limit, gate.rows) : gate.rows;
  let opened = 0; let filled = 0; let lost = 0; let miss = 0;
  let webSeen = 0; let webRead = 0; let walkShort = 0; let skipped = 0;
  let why = '';
  note('details.start', { rows: gate.rows, total, map: gate.map, frames: gate.frames,
    width: gate.width });
  detailRun.set(tabId, { running: true, at: Date.now(), total, opened: 0, filled: 0 });
  // Held for the whole pass rather than per call: the panel's own poll must not read the list
  // while a record's page is open over it, and each of these calls is far too short to hold it.
  walking.add(tabId);
  // The pump is what keeps this pass moving when the tab is hidden: `dgate` armed the keeper,
  // and the worker's tick fires whatever the page's clamped timers never get to.
  startPump(tabId);
  // `ddone` puts the page's `requestAnimationFrame` back (see `keepFrames`), so it has to run on
  // EVERY way out of here — finished, stopped, or an error two records in. A shim over somebody
  // else's scheduling primitive is not a thing to leave behind because of an early return.
  let quit = null;
  try {
    for (let i = 0; i < total; i++) {
      if (await stopWanted(tabId)) break;
      const c = await runRows(tabId, { action: 'dclick', i, of: total, opened, filled });
      if (c?.error) { quit = { ...c, opened, filled }; break; }
      // THE LIST WENT. Stop at once — do not re-detect, do not keep clicking. Below 1280px a
      // click replaces the rail, and continuing is how a restaurant search comes back full of
      // hotels. Everything gathered so far is kept.
      if (c.listGone) { why = 'the list was replaced by the click, so the pass stopped there'; break; }
      if (c.already) continue;
      // A suggestion card, not a place. Skipped rather than clicked, and counted so the report can
      // say so.
      if (c.notRecord) { skipped++; continue; }
      if (!c.ok) { lost++; continue; }
      opened++;

      let arrived = false;
      let last = null;
      const t0 = Date.now();
      for (let t = 0; t < D.arriveTries && !arrived; t++) {
        await rest(D.arriveWait);
        last = await runRows(tabId, { action: 'dmark', id: c.id, wasMark: c.wasMark });
        if (last?.listGone) break;
        arrived = !!last?.arrived;
      }
      const arriveMs = Date.now() - t0;
      if (last?.listGone) {
        why = 'the list was replaced while a record was opening, so the pass stopped there';
        break;
      }
      if (!arrived) {
        // WHY it did not arrive, said in terms the user can act on. A hidden tab whose frames are
        // not being kept alive is a different problem from a slow page, and "3 records in a row
        // did not open" told nobody which they had.
        // WHAT THE PAGE SAID, not just that it disappointed us — `dmark` works all of this out on
        // the failing record (`detailMark`: `wall`, `saw`, `mains`, `why`) and this line used to
        // carry none of it. On the 120-row Seychelles run that lost ten records the log read
        // `i=110 arrived=false backstopped=10 miss=1`, three times, and then "3 records in a row
        // did not open" — while the page had already decided the answer was "the site asked for
        // verification" and handed it over. Same fault as the website column: the fact is computed
        // and thrown away at the point where somebody would use it.
        note('record', { i, arrived: false, ms: arriveMs, hidden: last?.hidden,
          frames: last?.frames, backstopped: last?.backstopped, miss: miss + 1,
          wall: !!last?.wall, mains: last?.mains, saw: (last?.saw || '').slice(0, 30),
          why: last?.why });
        // A WALL ENDS THE PASS NOW, rather than after three of them.
        //
        // The hand-over runs on the list tab on the reasoning that it "loads no pages" — but
        // opening a record still fetches that record, so a challenge the lane pass met is in front
        // of this pass too. Spending two more records to rediscover that is both pointless and the
        // exact behaviour the cooldown by `walledUntil` exists to prevent: answering a soft
        // challenge by trying again is how it becomes a hard block.
        //
        // And the sentence matters as much as the stopping. "3 records in a row did not open"
        // sends somebody looking at their window size; this one names the thing they can actually
        // go and clear, in the tab `lanes.leftOpen` deliberately kept for them.
        if (last?.wall) {
          why = 'the site asked to verify you are a person — clear the challenge in the tab left '
            + 'open, then press again and it will skip everything already read';
          note('rail.walled', { i, read: filled, why: 'the challenge is in front of the list tab too' });
          break;
        }
        if (++miss >= D.misses) {
          // Three different sentences, because they need three different actions from the user.
          // The middle one is new: a keeper that went in late covers the visibility half but cannot
          // reach the frames Maps captured at load, so a reload is still the full fix — and saying
          // "no keeper" there would be false, while saying nothing would send them looking at the
          // window size.
          if (last?.hidden && lateKeepers.has(tabId)) {
            why = 'the tab was in the background, and the frame keeper could only be added after '
              + 'this page had loaded — reload the tab once for the whole fix';
          } else if (last?.hidden && last?.frames !== 'armed') {
            why = 'the tab was in the background and this page has no frame keeper — reload the tab once';
          } else {
            why = `${miss} records in a row did not open`;
          }
          break;
        }
        continue;
      }
      miss = 0;

      // The walk, one step per call. Stopping is the same three facts as before — at the bottom,
      // no taller than it was, and unable to move — confirmed twice.
      // NOT THREADING THE PREVIOUS HEIGHT INTO `dstep`, AND THE MEASUREMENT IS WHY.
      //
      // It looks like it should: `detailStep` compares against `op.height`, so calling it bare
      // makes `grew` false on every step. But the break needs all three of bottom, not-grown and
      // not-moved, and `moved` stays true the whole way down a real panel — so a stuck `grew` never
      // ends the walk early. Measured against live Maps, `test/_driven-fields.mjs`, eight records:
      //
      //   bare            19 20 17 20 20 20 19 20 fields   17-26 walk steps   5.16s each
      //   height threaded 20 17 20 20 20 19 20 13 fields    8-26 walk steps   4.60s each
      //
      // Same columns below the fold either way. This was a candidate for the thin records a rail
      // hand-over returned on one run, and it is not the cause.
      let still = 0; let bottom = false;
      for (let s = 0; s < D.walkSteps; s++) {
        const st = await runRows(tabId, { action: 'dstep' });
        if (st?.gone) break;
        bottom = !!st?.bottom;
        if (bottom && !st.grew && !st.moved) { if (++still >= D.settle) break; } else still = 0;
        await rest(D.walkWait);
      }
      if (!bottom) walkShort++;

      const got = await waitForWeb(() => runRows(tabId, { action: 'dweb' }));
      const web = got.web;
      if (got.seen) webSeen++;

      const r = await runRows(tabId, { action: 'dread', key: c.key, href: c.href, web });
      if (r?.got) { filled++; if (r.web) webRead++; }
      // ONE LINE PER RECORD. This is the line that answers "it stopped at 47": how long the record
      // took to arrive, whether the walk reached the bottom, how many fields came out, and whether
      // the tab was hidden at the time.
      // `len` IS THE PANEL'S OWN SIZE, and it is here so the next thin record does not need a
      // fourth hypothesis. `fields` says how much was read; `len` says how much there was.
      // `ms` is ARRIVAL ONLY — reading it as the record's cost is a mistake already made once,
      // from this very line, so it is named.
      note('record', { i, arrived: true, arriveMs, bottom, fields: r?.fields ?? 0, len: r?.len,
        web: !!r?.web, hidden: last?.hidden, frames: last?.frames,
        backstopped: last?.backstopped, filled });
      // Published per record, so a panel that lost its reply can watch this instead of guessing.
      detailRun.set(tabId, { ...detailRun.get(tabId), running: true, total, opened, filled });
      if (i + 1 < total) await rest(D.pace());
    }
  } finally {
    stopPump(tabId);
    // Stamped BEFORE the claim is released, so the first poll after this pass is already inside
    // the embargo — see `detailedAt`. A gap of even one poll is a lost table.
    detailedAt.set(tabId, Date.now());
    walking.delete(tabId);
  }

  const end = await runRows(tabId, { action: 'ddone' }).catch(() => null);
  // Everything the run did, in one line in the log — which is the point of the log. Reported as
  // "the step became problematic" is not something anybody can act on; this is.
  // `revived` is gone: nothing in `rows.js` ever produced it, so it printed `undefined` on every
  // run and read as a counter sitting at zero. `keeper` is the real question it was gesturing at.
  note('details.done', { opened, filled, lost, skipped, walkShort, webSeen, webRead, why,
    frames: end?.frames, backstopped: end?.backstopped, keeper: end?.keeper,
    hidden: end?.hidden });
  // WRITTEN OUT, because a log nobody can read is not a log. Same file the pages walk writes —
  // `Downloads/HoloScrape/holoscrape-log-<stamp>.txt`, never overwritten — and only in a staging
  // build with logging on, which is what `DEV && devLog` means.
  if (DEV && devLog) saveLog().catch(() => {});
  // Kept where the panel can fetch it. The reply below may have nowhere to land — a five-minute
  // send bound, a panel that was closed and reopened, a tab switch — and the pass's outcome is
  // worth more than the channel it was going to travel on.
  const done = quit
    ? { ...quit, ...frames }
    : { opened, filled, lost, skipped, why, webSeen, webRead, walkShort, map: gate.map, ...frames,
      // The rail loads no pages and fetches nothing — it clicks inside the app that is already
      // open. Named so the summary does not have to report a rail read as a tab that never opened.
      viaFetch: 0, viaTab: 0, viaRail: filled,
      kept: { frames: end?.frames, backstopped: end?.backstopped, revived: end?.revived },
      rows: end?.rows ?? gate.rows, ...(await lastTables(tabId)) };
  detailRun.set(tabId, { running: false, at: Date.now(), total, opened, filled, result: done });
  return done;
}

// Whether the user has pressed Stop. Asked of the page, which is where the flag lives, and
// cheap enough to ask once per record.
async function stopWanted(tabId) {
  const s = await runRows(tabId, { action: 'stopped' }).catch(() => null);
  return !!s?.stopped;
}

// The tables, read once at the end. The in-page loop returned them as part of its own result;
// driven from here it is its own call — and it is `dtables`, NOT `extractAll`: that action
// scrolls the list before reading, which at the end of a details pass would re-walk the whole
// rail for nothing.
export async function lastTables(tabId) {
  const out = await runRows(tabId, { action: 'dtables' }).catch(() => null);
  if (out?.error) {
    // `LIST_GONE` is the engine refusing to hand over a page that is no longer the list — see the
    // `dtables` case. Returning nothing is CORRECT here: `saveResult` only replaces tables when it
    // is given some, so refusing leaves the last good table in place. Reported as "the result was
    // completely gone"; this is the half of that fix which lives on this side.
    note('details.noTables', { why: out.error });
    return {};
  }
  return out ? { tables: out.tables, items: out.items, coverage: out.coverage } : {};
}

// How many times to correct the zoom. One calculation SHOULD be enough — CSS pixels scale
// linearly with the zoom factor — and measured against a real window it is not always: Chrome
// snaps to its own ladder of zoom levels (90, 80, 75, 67, 50…), so asking for 0.83 gets 0.8 or
// 0.75, and asking for 0.97 gets 1.0 and changes nothing. So it measures, corrects, and measures
// again rather than trusting the arithmetic.
const ZOOM_TRIES = 4;

// MEASURE THE SCREEN BEFORE ZOOMING ANYTHING, and widen the window if the screen allows it.
//
// Zooming out is the crude instrument: it shrinks every word on the page to buy layout width. If
// the window is simply smaller than the screen — a half-width window on a 1728px display — then
// making the window wider costs nothing and reads normally afterwards. Zoom is for the case where
// the screen itself is the limit.
//
// The arithmetic, and each number comes from the place that actually knows it:
//   the page reports `inner` (CSS px Maps lays out in) and `outer` (the window with its frame)
//   the worker reports the zoom factor
//   content px = inner × zoom          — real pixels the page owns
//   overhead   = outer − content px    — window frame plus HoloScrape's side panel
//   widening to `availW` gives (availW − overhead) ÷ zoom CSS pixels
async function widenWindow(tabId, need) {
  const m = await runRows(tabId, { action: 'dscreen' }).catch(() => null);
  if (!m || m.error) return { ok: false };
  let zoom = 1;
  try { zoom = await chrome.tabs.getZoom(tabId); } catch (_) { zoom = 1; }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const win = tab ? await chrome.windows.get(tab.windowId).catch(() => null) : null;
  const contentPx = Math.round(m.inner * zoom);
  const overhead = Math.max(0, m.outer - contentPx);
  const couldBe = Math.floor((m.availW - overhead) / zoom);
  note('details.screen', { inner: m.inner, outer: m.outer, availW: m.availW, dpr: m.dpr,
    zoom, overhead, couldBe, need, state: win?.state });
  // Already as wide as the screen allows, or maximised: widening is not on the table.
  if (!win || win.state === 'maximized' || win.state === 'fullscreen') return { ok: false, couldBe, m };
  if (couldBe < need) return { ok: false, couldBe, m };
  const before = { left: win.left, top: win.top, width: win.width, height: win.height };
  try {
    await chrome.windows.update(win.id, { left: 0, width: m.availW, state: 'normal' });
  } catch (e) {
    note('details.widenFailed', { why: e.message });
    return { ok: false, couldBe, m };
  }
  await new Promise((r) => setTimeout(r, 600));
  const after = await runRows(tabId, { action: 'dscreen' }).catch(() => null);
  note('details.widened', { from: before.width, to: m.availW, inner: after?.inner });
  return { ok: (after?.inner || 0) >= need, couldBe, m, before, windowId: win.id };
}

// THE THRESHOLD IS A MEASUREMENT, AND A MEASUREMENT CAN BE WRONG ON SOMEBODY ELSE'S SCREEN.
//
// `DETAIL_MIN_WIDTH` (1280) came from a real probe: the rail survives a click at 1440 and 1280 and
// is gone at 1180. But it was measured on one machine, and a report came back with the rail
// destroyed while the gate had let the pass through — so on that setup the layout collapses ABOVE
// 1280. Reported as "I'm not seeing zoom out mechanism", and the zoom was working perfectly; it
// was never asked to run.
//
// Predicting the layout is what failed. So the pass also OBSERVES it: if the first click replaces
// the list, that is the threshold being wrong, and the answer is the same as being too narrow —
// get more width and try again — with the list restored first, because a click that replaced it
// left the tab on a record's page.
const LIST_LOST = /list was replaced/;

async function restoreList(tabId) {
  try {
    await chrome.tabs.goBack(tabId);
  } catch (e) { note('details.backFailed', { why: e.message }); return false; }
  // The rail is rebuilt by Maps, not by us; give it the time a page needs and then re-detect,
  // because the state describing the old list went with it.
  await new Promise((r) => setTimeout(r, 2500));
  const d = await runRows(tabId, { action: 'detect' }).catch(() => null);
  note('details.listRestored', { rows: d?.rows ?? 0 });
  return (d?.rows || 0) > 0;
}

// BUY THE ROOM BEFORE CLICKING ANYTHING — this is what "no zoom out at all" was about.
//
// The old flow only zoomed AFTER the engine refused for being under 1280 CSS px. On a window that
// reports more than that, nothing ever fired, and the rail was destroyed anyway because that
// machine's real floor is higher. A check that passes and then loses the list is worse than no
// check: it is a mechanism that exists and never runs.
//
// So this runs FIRST, every time, and gets the page to `want` (1600) by the cheapest means:
// widen the window if the screen has the room, then zoom out for whatever is still missing.
// Both are borrowed and both are given back by `openDetails`'s `finally`.
async function buyRoom(tabId) {
  const m = await runRows(tabId, { action: 'dscreen' }).catch(() => null);
  if (!m || m.error) return {};
  const want = m.want || DETAIL_MIN_WIDTH_FALLBACK;
  note('details.room', { inner: m.inner, want, availW: m.availW, outer: m.outer, dpr: m.dpr });
  if (m.inner >= want) return { room: 'already wide enough' };

  const out = {};
  // 1. The window, if the screen allows — a wider window keeps the text its normal size.
  const wide = await widenWindow(tabId, want);
  if (wide.before) out.windowBack = { id: wide.windowId, ...wide.before };
  if (wide.ok) { out.widened = true; return out; }

  // 2. Zoom for the rest. Chrome snaps to its own ladder (90, 80, 75, 67, 50…), so this measures
  //    after each step and corrects rather than trusting one calculation.
  let at = 1;
  try { at = await chrome.tabs.getZoom(tabId); } catch (e) {
    note('details.zoomUnavailable', { why: e.message });
    return out;
  }
  out.zoom0 = at;
  for (let t = 0; t < ZOOM_TRIES; t++) {
    const now = await runRows(tabId, { action: 'dscreen' }).catch(() => null);
    const inner = now?.inner || 0;
    if (inner >= want) break;
    const contentPx = inner * at;
    let next = Math.max(CHROME_MIN_ZOOM, contentPx / want);
    if (t > 0) next = Math.min(next, at * 0.9);      // step past the ladder on a retry
    next = Math.max(CHROME_MIN_ZOOM, +next.toFixed(3));
    if (next >= at) { note('details.zoomFloor', { at, inner, want }); break; }
    note('details.zoom', { try: t + 1, from: at, to: next, inner, want });
    try { await chrome.tabs.setZoom(tabId, next); } catch (e) {
      note('details.zoomFailed', { why: e.message });
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
    at = await chrome.tabs.getZoom(tabId).catch(() => next);
  }
  const end = await runRows(tabId, { action: 'dscreen' }).catch(() => null);
  out.zoomed = +at.toFixed(2);
  note('details.roomBought', { inner: end?.inner, want, zoom: out.zoomed, widened: !!out.widened });
  return out;
}

// THE TABS UNTIL THEY ARE NOTICED, THEN THE RAIL FOR WHATEVER IS LEFT.
//
// Two paths that cost completely different things, and that difference is the whole design:
//
//   tabs   one PAGE LOAD per record, several at a time — fast, and visible. Measured on a real run:
//          a reCAPTCHA after about 100 loads from one address.
//   rail   a CLICK inside the already-loaded app, which fetches over XHR and loads NO page at all.
//          Slower per record, and it has never once been challenged.
//
// So: run the fast one until the site objects, then finish on the one it cannot see. Nothing is
// dropped. The rail pass always picks the next row WITHOUT details, so the records the lanes already
// filed are skipped automatically and only the remainder — every lane failure included — is read.
export async function openDetails(tabId, { limit = 0, lanes = 0, only = null } = {}) {
  // PROVIDER FIRST. The tabs-then-rail ladder below is Google's shape, and it is the right shape
  // there: the panel is client-rendered, so a fetch gets nine of fifteen columns and the tab pass
  // exists to finish the job. 2GIS is the opposite — the firm page is server-rendered and complete,
  // so a fetch is not the cheap-but-partial option, it is the whole answer. Running the ladder on
  // it would open hundreds of tabs to read bytes we already have, and draw a captcha doing it.
  const kind = await runRows(tabId, { action: 'mapkind' }).catch(() => null);
  if (kind?.reads === 'fetch') return driveTwoGis(tabId, limit, only);

  let fromTabs = null;
  if (lanes >= 0) {
    const byTabs = await driveDetailsTabs(tabId, limit, lanes).catch((e) => ({ error: e.message }));
    // Challenged with records still to read is NOT a finished pass — carry the counts and continue.
    if (byTabs?.walled && byTabs.left > 0) {
      fromTabs = byTabs;
      note('lanes.handOver', { read: byTabs.filled, left: byTabs.left,
        why: 'the site challenged the tab pass — finishing on the list, which loads no pages' });
    } else if (byTabs && !byTabs.error
      && (byTabs.opened > 0 || byTabs.skipped > 0 || byTabs.already > 0)) {
      // `already > 0` ends it here rather than falling through. Every record on this list has been
      // read, and the rail pass below would spend a pass on the same list to discover exactly
      // that. A finished job is not a failure to hand over.
      return byTabs;
    } else {
      note('lanes.fellBack', { why: byTabs?.error || byTabs?.why || 'no records to open' });
    }
  }
  const out = await openDetailsOnRail(tabId, { limit });
  if (!fromTabs) return out;
  // ONE JOB, TWO PASSES — reported as one. The counts are added rather than replaced, or the card
  // would say the rail pass read 18 and lose the 102 the lanes had already filed.
  // `filled`, NOT `opened`, FROM THE LANE PASS — because the rail OPENS THEM AGAIN.
  //
  // Adding the two `opened` counts reported "120 of 132" on a list of 120. The lanes opened 110 and
  // delivered 98; the twelve they failed were handed to the rail, which opened them a second time.
  // Summing both passes' `opened` therefore counts every lane failure twice, and the denominator
  // grows past the number of records that exist — which reads as though rows appeared from nowhere.
  // What the lanes contributed to the denominator is what they actually delivered; everything else
  // they touched is inside the rail's own count.
  const both = { ...out,
    opened: (fromTabs.filled || 0) + (out.opened || 0),
    filled: (fromTabs.filled || 0) + (out.filled || 0),
    lost: Math.max(0, (out.lost || 0)),
    // Only the lane pass fetches; the rail clicks inside the already-loaded app. So the fetched
    // count comes from the lanes alone, and everything else it read was a page load.
    viaFetch: fromTabs.viaFetch || 0,
    viaTab: Math.max(0, (fromTabs.filled || 0) - (fromTabs.viaFetch || 0)),
    viaRail: out.filled || 0,
    handedOver: true, byTabs: fromTabs.filled || 0, byRail: out.filled || 0,
    why: out.why || '',
    // The challenge happened and the tab holding it is still open, so the card must still say so —
    // but it is no longer a dead end, because the remainder was read another way.
    walled: true, left: Math.max(0, (fromTabs.left || 0) - (out.filled || 0)) };
  // AND THE MERGED RESULT IS PUBLISHED, not just returned.
  //
  // Returning it is only enough when the panel is still listening, and on a hand-over it usually is
  // not: `send` gives up after five minutes and a walled run plus a rail pass is longer than that.
  // The panel then falls back to `DETAILS_STATE`, which reads `detailRun` — and `detailRun` was last
  // written by the RAIL pass with the rail's own numbers.
  //
  // Measured, from the run that exposed this: 98 records read by the lanes, 24 by the rail, and the
  // card said "24 of 24 item details read" with no mention of a hand-over. Everything was in the
  // table; the report threw away four fifths of it, which reads as data loss and is not.
  detailRun.set(tabId, { running: false, at: Date.now(),
    // Same arithmetic as `opened` above, and wrong the same way if it uses the lanes' `opened`.
    total: (fromTabs.filled || 0) + (fromTabs.left || 0), opened: both.opened, filled: both.filled,
    result: both });
  return both;
}

async function openDetailsOnRail(tabId, { limit = 0 } = {}) {
  let zoom0 = null;
  let windowBack = null;
  try {
    // Room first, always. Everything below stays as the backstop for a page that still refuses.
    const room = await buyRoom(tabId);
    if (room.zoom0 != null) zoom0 = room.zoom0;
    if (room.windowBack) windowBack = room.windowBack;
    let out = await driveDetails(tabId, limit);
    if (room.zoomed && room.zoomed !== 1) out = { ...out, zoomed: room.zoomed };
    if (room.widened) out = { ...out, widened: true };
    // The layout collapsed even though the gate was satisfied. Treat it as what it is — not
    // enough width — and say what the page actually reported, so the widening below has numbers
    // to work from rather than the threshold that just proved too low.
    if (LIST_LOST.test(out?.why || '')) {
      const m = await runRows(tabId, { action: 'dscreen' }).catch(() => null);
      note('details.thresholdWrong', { inner: m?.inner, need: m?.need, filled: out.filled });
      if (await restoreList(tabId)) {
        // Ask for more than the threshold that failed: whatever this screen was doing at that
        // width, it needs more than we thought.
        out = { ...out, error: 'TOO_NARROW', width: m?.inner || 0,
          need: Math.round((m?.inner || DETAIL_MIN_WIDTH_FALLBACK) * 1.25) };
      }
    }
    if (out?.error !== 'TOO_NARROW') return out;

    // The window first, because a wider window is a better answer than a smaller page.
    const wide = await widenWindow(tabId, out.need);
    if (wide.before) windowBack = { id: wide.windowId, ...wide.before };
    if (wide.ok) {
      out = await driveDetails(tabId, limit);
      if (out?.error !== 'TOO_NARROW') return { ...out, widened: true };
    }

    // Still short. Now zoom, using the width the page reported rather than an assumption.
    try { zoom0 = await chrome.tabs.getZoom(tabId); } catch (e) {
      note('details.zoomUnavailable', { why: e.message });
      zoom0 = null;
    }
    if (!zoom0) return { ...out, why: 'the window is too narrow to open rows without losing the list' };
    // Whether zoom can even get there, said in numbers before trying: at Chrome's floor of 25%,
    // the page would lay out `content ÷ 0.25` CSS pixels wide.
    const ceiling = Math.floor((out.width * zoom0) / CHROME_MIN_ZOOM);
    if (ceiling < out.need) {
      note('details.tooSmallScreen', { ceiling, need: out.need, width: out.width, zoom0 });
      return { ...out,
        why: `this screen cannot give the page ${out.need}px even at the smallest zoom `
          + `(${ceiling}px is the most it can reach) — a wider window or display is the only fix` };
    }

    let at = zoom0;
    for (let t = 0; t < ZOOM_TRIES && out?.error === 'TOO_NARROW'; t++) {
      // The window's own pixels do not change; only how many CSS pixels Maps lays out inside them.
      const windowPx = out.width * at;
      const want = Math.max(CHROME_MIN_ZOOM, windowPx / (out.need + DETAIL_MARGIN));
      // Never zoom IN — that would narrow the layout, which is the problem, not the cure. And step
      // DOWN past the target on a retry, because the first ask was rounded up onto Chrome's ladder
      // and asking for the same number again would land in the same place.
      let next = Math.min(at, want);
      if (t > 0) next = Math.min(next, at * 0.9);
      next = Math.max(CHROME_MIN_ZOOM, +next.toFixed(3));
      if (next >= at) {
        note('details.zoomStuck', { at, want, width: out.width, need: out.need });
        return { ...out, why: 'this window cannot be made wide enough — try a wider window' };
      }
      note('details.zoom', { try: t + 1, from: at, to: next, was: out.width, need: out.need });
      await chrome.tabs.setZoom(tabId, next);
      // The page relays out on zoom; read it after it has, not during.
      await new Promise((r) => setTimeout(r, 600));
      at = await chrome.tabs.getZoom(tabId).catch(() => next);
      out = await driveDetails(tabId, limit);
      if (out?.error === 'TOO_NARROW') {
        note('details.stillNarrow', { asked: next, got: at, width: out.width, need: out.need });
      }
    }
    if (out?.error === 'TOO_NARROW') {
      return { ...out, why: 'this window cannot be made wide enough — try a wider window' };
    }
    return { ...out, zoomed: +at.toFixed(2) };
  } finally {
    // THE ZOOM IS LEFT WHERE THE PASS PUT IT. Deliberately, and this used to be restored here.
    //
    // Putting it back re-lays-out the whole page, and on a map that means the camera moves and
    // Maps rewrites its URL — at the exact moment the pass ends and the panel's poll comes round
    // again. Reported as "returning the zoom to the original replaces the table", and it was: a
    // re-read landed on a page mid-relayout and saved that over the finished list. The guards in
    // `saveResult` now refuse that write, but the cheapest fix is not to shake the page at all
    // once there is something worth keeping on it.
    //
    // It is also not much of a loss. Zoom is per-origin, visible, and one keystroke to undo
    // (Cmd/Ctrl+0), and the panel says it was left changed — see the `zoomed` clause on the
    // report card. The WINDOW is a different matter and is still put back: a window stretched
    // across somebody's screen is not something they asked for and not something a keystroke
    // fixes.
    if (windowBack?.id != null) {
      try {
        await chrome.windows.update(windowBack.id, {
          left: windowBack.left, top: windowBack.top,
          width: windowBack.width, height: windowBack.height,
        });
      } catch (_) {}
    }
  }
}

// WHAT MAKES A ROW THE SAME ROW.
//
// This is where four pages of Alibaba went. The key used to be "the first value in the row that
// looks like a URL":
//
//   Object.values(row).find((v) => /^https?:/.test(v))
//
// On Alibaba the first URL in a card is very often not the product at all — it is the country
// flag `…/flags/1.0.0/assets/cn.png`, or the 20x21 "Assessed Supplier" badge
// `…O1CN01H0fqnK1Gpp8Bpra4W_!!…svg`, and those are the SAME URL on every card on every page. So
// every row that led with furniture collapsed onto the first one that did: eight pages were
// walked, 384 rows were read, 192 survived, and because `fresh` counts survivors the loop then
// decided the list had "held nothing new" and stopped.
//
// Identity is the row's OWN link, with the query removed — Alibaba stamps a fresh `priceId` on
// every link on every page load, so keeping the query means the same product on two pages reads
// as two products, and dropping the link entirely means furniture decides. Failing that, the
// WHOLE row: two rows that differ anywhere are two rows. Never one arbitrary field, which is
// what made a badge able to delete a product.
// WHICH ROW THIS IS — and on a map that publishes a record link, THE RECORD LINK SAYS SO.
//
// The longest-URL rule is a decent guess on an unknown site and a silent disaster on 2GIS, where
// it cost 34 of 60 rows and looked exactly like page overlap:
//
//   rubric link  /almaty/search/%D0%90%D0%B2%D1%82%D0%BE%D1%81%D0%B5%D1%80%D0%B2%D0%B8%D1%81   62 chars
//   firm link    /almaty/firm/70000001094187683                                                30 chars
//
// The rubric chip wins on length, so every row was keyed by ITS CATEGORY. Seven of page one's
// twelve cards say «Автосервис», so every later «Автосервис» — a different business, different
// address, different phone — was discarded as a duplicate. The arithmetic matched the defect
// exactly: pages 2 and 3 contributed 5 and 3 rows, and 5 and 3 are precisely how many rubrics
// on those pages had not been seen before.
//
// Measured against the live site: pages 1 and 2 share ZERO firm ids. There was never any overlap
// to collapse. So where the provider names what a record link looks like, that is the identity —
// it is the one URL on the card that is about THIS row and no other.

// THE SAME FACT, ARRIVING IN A DIFFERENT SLOT ON A LATER PAGE.
//
// The engine folds a card's template variants together while it reads ONE page (`mergeTemplates`),
// and that is as far as it can see. A walk stacks six pages whose cards are built differently, so
// the combined table grows a second set of columns for facts page one already named — read off a
// real six-page export:
//
//   Link 1   /branches/70000001038673300        `Branches link` holds exactly this on other rows
//   Link 2   +7‒778‒777‒07‒53                   `Phone`
//   Text 4   Кульджинский тракт, 8/5, Алматы    `Address` says «Кульджинский тракт, 8/5»
//   Text 8   Реклама                            `Реклама`
//   Text 10  Написать в WhatsApp                `Website label` says the same words on that row
//
// Only the combined table has both halves, so only here can they be put back. Each rule below
// PROVES the pair from the data rather than guessing at it, because a wrong fold writes a value
// under someone else's heading and that is worse than leaving it as `Text 4`:
//
//   badge      the orphan's single literal IS the named column's name.
//   twin       wherever both are present they are equal — one column, read twice.
//   part       on the rows they share, one value contains the other. «Кульджинский тракт, 8/5,
//              Алматы» contains «Кульджинский тракт, 8/5»: the same address, written longer.
//   shape      disjoint, same kind, and both sides are URLs or both are not — the rule that keeps
//              a website out of `Phone`, whose values after tidying are bare numbers.
//
// Anything that clears none of them stays unnamed. `Text 5` holds «*1–30.06.26.» and `Text 7`
// holds «51 оценка» while `Reviews` says 20 — different facts, and they keep their own columns.
export function foldOrphans(t, strip) {
  const rows = t.rows || [];
  const cols = t.cols || [];
  if (rows.length < 4) return;
  const at = (c) => rows.map((r) => {
    const v = r[c.key];
    return v == null || String(v).trim() === '' ? '' : String(v).trim();
  });
  const url = (xs) => xs.filter(Boolean).every((v) => /^https?:\/\//i.test(v));
  const med = (xs) => {
    const n = xs.map((x) => x.length).filter(Boolean).sort((a, b) => a - b);
    return n.length ? n[Math.floor(n.length / 2)] : 0;
  };
  const named = cols.filter((c) => c.name && !c.key.startsWith('@'));
  for (const u of cols) {
    if (u.name || u.key.startsWith('@')) continue;
    const uv = at(u);
    const un = uv.filter(Boolean).length;
    if (!un) continue;
    let win = null;
    let score = 0;
    for (const n of named) {
      const nv = at(n);
      if (!nv.filter(Boolean).length) continue;
      const both = uv.map((v, i) => (v && nv[i] ? i : -1)).filter((i) => i >= 0);
      const one = [...new Set(uv.filter(Boolean))];
      let sc = 0;
      if (one.length === 1 && one[0] === n.name) sc = 100;
      else if (both.length && both.every((i) => uv[i] === nv[i])) sc = 90;
      // CASE-FOLDED, because the two halves disagree about it and nothing else. The card writes
      // «Улица Минусинская, 17, Алматы» and the record writes «улица Минусинская, 17» — the same
      // address, one capital letter apart, and a case-sensitive compare left nineteen rows of
      // addresses sitting under `Text 4`.
      else if (both.length >= 2 && both.every((i) => {
        const a = uv[i].toLowerCase(); const b = nv[i].toLowerCase();
        return a.includes(b) || b.includes(a);
      })) sc = 80;
      // A DISJOINT COLUMN WHOSE EVERY VALUE THE NAMED ONE ALREADY CARRIES is the same column, seen
      // on rows where the other template put it elsewhere. `Номинант 2026` is what `Award` holds;
      // arriving in its own slot on one card does not make it a different fact. Bounded to a small
      // vocabulary so a free-text column cannot drift in on one coincidence.
      else if (!both.length && one.length <= 4
               && one.every((v) => nv.includes(v))) sc = 70;
      else if (!both.length && u.kind === n.kind) {
        if (u.kind === 'link') sc = url(uv) === url(nv) ? 40 : 0;
        else if (med(uv) >= 40 && med(nv) >= 40) sc = 60;
      }
      if (sc > score) { score = sc; win = n; }
    }
    if (!win || !score) continue;
    // The named column keeps its seat and its heading; the orphan only donates the rows it alone
    // filled. Never the other way round — an overwrite here would lose a value nobody can get back.
    for (let i = 0; i < rows.length; i++) {
      const v = rows[i][u.key];
      if (v == null || String(v).trim() === '') continue;
      const held = rows[i][win.key];
      if (held == null || String(held).trim() === '') rows[i][win.key] = v;
      delete rows[i][u.key];
    }
    u.drop = true;
    win.filled = at(win).filter(Boolean).length;
  }
  t.cols = cols.filter((c) => !c.drop);

  // AND WHAT IS LEFT GOES, when the map is one whose columns are supposed to be named.
  //
  // The survivors are not columns. They are ONE DOM SLOT that 2GIS reuses, holding a different
  // fact per row — «Закрыто» on one, «76 оценок» on the next, «Написать в WhatsApp» on a third.
  // No heading is true of that, and a heading that is true of none of its rows is worse than no
  // column: it invites the reader to filter on it.
  //
  // TWO GUARDS, because this deletes data and both of them are load-bearing:
  //   `strip`  only a provider that declares what a record looks like asks for this. An ordinary
  //            site's table is unnamed almost end to end — stripping there empties it.
  //   five     and even then, only where naming plainly WORKED. A 2GIS search page also carries a
  //            53-column side table the namer never touches; without this it would be reduced to
  //            nothing.
  if (strip && t.cols.filter((c) => c.name).length >= 5) {
    const lose = t.cols.filter((c) => !c.name && !c.key.startsWith('@'));
    for (const c of lose) for (const r of rows) delete r[c.key];
    t.cols = t.cols.filter((c) => !lose.includes(c));
  }
}
