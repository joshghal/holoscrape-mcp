// HoloScrape — service worker: driving a tab from outside through the debugger protocol, and the
// one shared, refcounted debugger session per tab that every capture borrows.
import { note } from './bg-log.js';
import { runRows } from './bg-rows.js';

// --- driving a page instead of asking it nicely -------------------------------
//
// Everything above works by injecting script and hoping the page behaves: scroll it, wait,
// see what mounted. On a site that renders its list in the browser and grows it on scroll,
// that hope keeps failing in ways that are hard to tell apart — the window was too narrow
// and the layout changed, the tab was not painting so no observer fired, the scroll went
// to the wrong element. Each one looks the same from outside: pages that open and yield
// nothing.
//
// The debugger protocol removes the hoping. It is part of Chrome, it needs only the
// `debugger` permission at install — no native host, no separate binary, nothing for the
// user to set up — and it gives four things nothing else does:
//
//   Emulation.setDeviceMetricsOverride     a real desktop viewport whatever the window size,
//                                          so the site serves its desktop layout
//   Page.setWebLifecycleState 'active'     un-throttles a tab that is not being shown
//   Emulation.setFocusEmulationEnabled     the page believes it has focus
//   Input.dispatchMouseEvent 'mouseWheel'  a REAL wheel event — the thing lazy loaders
//                                          listen for, which window.scrollTo is not
//
// The price is honest and unavoidable: Chrome shows a yellow "HoloScrape started debugging
// this browser" bar on the tab, and only one debugger may attach to a tab at a time, so it
// cannot be used on a tab with DevTools open.
export const CDP_VERSION = '1.3';

export async function cdp(target, method, params) {
  return chrome.debugger.sendCommand(target, method, params || {});
}

// Prepared once per attachment: desktop metrics, no throttling, focused as far as the page
// can tell. After this the tab behaves like one you are looking at, whether or not you are.
export async function cdpPrepare(target) {
  await cdp(target, 'Page.enable').catch(() => {});
  // `Runtime.enable` is NOT called, and its absence is the point.
  //
  // It is the single most-checked automation tell there is. Enabling the Runtime domain
  // makes the page's console plumbing observable from inside the page: build an object
  // whose `id` is a getter, log it, and see whether the getter ran. Nothing reads it in an
  // ordinary browser. With Runtime.enable active, something does — and Cloudflare and
  // DataDome both probe for exactly that. It is the leak the whole rebrowser-patches
  // project exists to close in Puppeteer and Playwright, and we were volunteering it.
  //
  // Nothing here needs it. `Runtime.evaluate` works against the default context without the
  // domain being enabled; enable only buys `executionContextCreated` events and console
  // forwarding, and `cdpEval` wants neither. So the driven pass — the strongest one we
  // have, used precisely on the sites that scrutinise hardest — stopped announcing itself
  // for the price of deleting a line.
  await cdp(target, 'Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  }).catch(() => {});
  await cdp(target, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await cdp(target, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
}

// AWAKE, BUT NOT RESIZED. The half of `cdpPrepare` that is safe on a tab a person is watching.
//
// `cdpPrepare` does three things, and only one of them is dangerous:
//
//   Emulation.setFocusEmulationEnabled   the page believes it is focused      harmless
//   Page.setWebLifecycleState: active    the page is not frozen or throttled  harmless
//   Emulation.setDeviceMetricsOverride   the page is RELAID OUT at 1440x900   not harmless
//
// The third is what unthrottles a lane tab whose real viewport is whatever Chrome gave it, and it
// is also what broke the side panel: the panel captures a row selector at the person's own width,
// and a walk that resized the page mid-run turned pages and matched nothing — 0 rows, 0 pages, and
// Stop taking a whole page-load budget to land.
//
// The first two are enough to stop Chrome throttling a background tab, which is the actual thing a
// walk needs. Measured live on shopee.co.id, the same category page in a tab with active:false:
// `tab_here` reported 60 rows (its read holds the tab), and `list_extract` immediately afterwards
// returned 15 and said "reached the limit" — because the walk had no hold at all. The rows were
// never missing; the observers that fill them were not being run.
async function cdpAwake(target) {
  await cdp(target, 'Page.enable').catch(() => {});
  await cdp(target, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await cdp(target, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
}

// The same borrow as `withVisibleTab`, minus the resize. Use this on any tab the person might be
// looking at; use `withVisibleTab` only on lanes this extension opened itself.
export async function withAwakeTab(tabId, fn) {
  const target = { tabId };
  let held = false;
  try {
    await cdpHold(target);
    held = true;
    await cdpAwake(target);
  } catch (_) { /* DevTools open, or another debugger — run anyway, just throttled */ }
  try { return await fn(held); } finally {
    if (held) await cdpRelease(target).catch(() => {});
  }
}

// A wheel, not a jump. `window.scrollTo` moves the scroll position and fires a scroll
// event; a great many lazy loaders wait for a wheel or for the compositor, and get neither.
// This is the same event a hand on a trackpad produces.
async function cdpWheel(target, y = 700) {
  await cdp(target, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 600, y: 400, deltaX: 0, deltaY: y,
    pointerType: 'mouse',
  }).catch(() => {});
}

const cdpEval = async (target, expr) => {
  const r = await cdp(target, 'Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  }).catch(() => null);
  return r?.result?.value;
};

// A press that the page cannot tell from a hand.
//
// `el.click()` fires an event whose `isTrusted` is false. The flag is immutable and
// unforgeable from script, and every behavioural detector reads it — it is the single
// clearest statement a page can receive that nobody is there. Inside the user's own tab
// that is the right trade: they pressed the button, they are watching, and attaching a
// debugger to say so would put a banner across their page for no gain. Out here we are
// already attached, so the press can be dispatched as what it actually is.
//
// Coordinates are viewport coordinates, which is why the page is asked where the control
// is immediately before pressing and the answer is refused unless it is on screen.
async function cdpClick(target, x, y) {
  const base = { x, y, button: 'left', clickCount: 1, buttons: 1, pointerType: 'mouse' };
  await cdp(target, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 40 + Math.floor(Math.random() * 90)));
  await cdp(target, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }).catch(() => {});
  // A real press is held. Zero milliseconds between down and up is its own tell.
  await new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 80)));
  await cdp(target, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 }).catch(() => {});
}

// `page_walk`'s ESCALATION for a control the page's own untrusted click could not move — see the
// long note by `cdpClick`. Tried ONLY after `walkSite` already tried the free, silent path and it
// came back `changed: false` on a live tab the person is actually looking at (Gmail's own icon-only
// "Older"/"Newer" pager is the case this was built for: `el.click()` on it changes nothing at all,
// confirmed by reading the same 50 rows before and after). Attaching the debugger here shows
// Chrome's "controlled by automated test software" banner, which is exactly why this only runs for
// the rows that demonstrably need it, attaches ONCE for every row a single `page_walk` call has to
// escalate rather than once per row, and detaches the moment they are done.
//
// `changed` ONLY EVER READS `false` WHEN THE CALLER PASSED `read` — see `walkSite` in rows.js. A
// generic "did the page's own text change" check sounds like a reasonable fallback for when no
// `read` is given, and was tried: measured on a live rail of 23 pressable rows, six real presses
// that recorded state with no VISIBLE text of their own came back `changed: false` under that
// check and were pressed a second time for real — 29 presses landing on 23 controls. A false
// "it worked" is nowhere near as costly as a false "it didn't", so a bare press with no `read`
// is trusted at face value and never escalates on this path; only a navigation (`moved`) can.
export async function walkPressRealBatch(tabId, rows, { selector, text, read, waitMs, back }) {
  if (!rows.some((r) => !r.error && !r.changed)) return;
  const target = { tabId };
  let attached = false;
  try {
    // BORROWED, NOT SEIZED. This used to call `chrome.debugger.attach` directly, and only one
    // debugger may attach to a target at a time — so the moment ANYTHING else in this extension
    // held a session on the tab, the attach threw "already attached", this returned, and the
    // escalation silently did not happen. The free untrusted click had already failed by
    // definition (that is why we are here), so the press was simply lost and the row came back
    // `changed: false` with nothing saying why.
    //
    // It went unnoticed because nothing else used to hold a session during a walk. When the MCP op
    // table began holding one for the length of every call, `page.walk`'s own escalation became
    // the thing it locked out — measured: test/walk-trusted-click green before, red after, with
    // `pressed: "Older"` and `moved: false`.
    //
    // `cdpHold` is the refcounted borrow that exists for exactly this, and its own comment says so
    // ("a grow or a collect running while a @net() watch was open took the session away"). Using it
    // means this nests inside any existing hold instead of fighting it, and releases without
    // pulling the session out from under whoever else still has it.
    attached = await cdpHold(target);
  } catch (e) {
    // DevTools is open on this tab, or the target is gone. Nothing to do but leave the rows as the
    // free click left them.
    note('walk.attach-failed', { err: (e.message || '').slice(0, 80) });
    return;
  }
  if (!attached) { note('walk.attach-failed', { err: 'no session' }); return; }
  try {
    for (const row of rows) {
      if (row.error || row.changed) continue;
      // eslint-disable-next-line no-await-in-loop
      const box = await runRows(tabId, { action: 'walkbox', selector, text, index: row.at, read }).catch(() => null);
      if (!box || box.error || !box.onScreen) continue;
      // eslint-disable-next-line no-await-in-loop
      await cdpClick(target, box.x, box.y);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, Math.min(8000, Math.max(400, Number(waitMs) || 1500))));
      // eslint-disable-next-line no-await-in-loop
      const after = await runRows(tabId, {
        action: 'walkAfter', was: row.url, read, back, waitMs, readBefore: box.readBefore,
      }).catch(() => null);
      if (after) Object.assign(row, after, { escalated: true });
    }
  } finally {
    if (attached) await cdpRelease(target).catch(() => {});
  }
}

// ONE REAL PRESS AT A BOX THE ENGINE MEASURED — the here-walk's escalation for a pager that ignores
// `el.click()`. The same borrow-and-release as `walkPressRealBatch`, for one control: `cdpHold`
// nests inside any session another op already holds instead of fighting it, and the release does
// not pull that session from under whoever else has it. Returns false when nothing could attach
// (DevTools open on the tab), and the caller then reads the page as it stands.
export async function pressForReal(tabId, box) {
  const target = { tabId };
  let attached = false;
  try { attached = await cdpHold(target); } catch (e) {
    note('here.attach-failed', { err: (e.message || '').slice(0, 80) });
    return false;
  }
  if (!attached) { note('here.attach-failed', { err: 'no session' }); return false; }
  try {
    await cdpClick(target, box.x, box.y);
    // The events are in the renderer's queue; give them a beat before the session goes.
    await new Promise((r) => setTimeout(r, 150));
    return true;
  } finally {
    await cdpRelease(target).catch(() => {});
  }
}

// Walk a prepared tab the way a person would, and stop when it stops growing.
//
// `press` is the tab id, when the caller wants the walk to operate a load-more as well as
// scroll past it. The page is asked where the control is (`morebox`) rather than told to
// click it, so the press itself happens out here as real input.
export async function cdpWalk(target, { steps = 24, quiet = 3, pause = 450, press = null } = {}) {
  let last = -1, dry = 0, pressed = 0;
  for (let i = 0; i < steps; i++) {
    await cdpWheel(target, 900);
    await new Promise((r) => setTimeout(r, pause));
    const h = await cdpEval(target, 'document.documentElement.scrollHeight');
    const atEnd = await cdpEval(target,
      'innerHeight + scrollY >= document.documentElement.scrollHeight - 8');
    if (press != null && pressed < 6) {
      const box = await runRows(press, { action: 'morebox' }).catch(() => null);
      if (box && !box.error && !box.none && box.onScreen) {
        await cdpClick(target, box.x, box.y);
        pressed++;
        note('hop.pressed', { label: (box.label || '').slice(0, 30), n: pressed });
        await new Promise((r) => setTimeout(r, 900));
        dry = 0;
        continue;
      }
    }
    if (h > last) { last = h; dry = 0; continue; }
    if (++dry >= quiet && atEnd) break;
  }
}

// The grace after `complete` is for frameworks that mount a beat later. It scales with the
// budget: a probe that may only spend twelve seconds cannot spend two and a half of them
// waiting on a page that has already finished.
// The grace after `complete` is for callers that read the page immediately and have no other
// way to know whether it has settled. A caller that POLLS for the list afterwards needs none of
// it — and paid 2.57s a page for it, measured: 30% of an entire walk, spent asleep on a local
// fixture that had already finished serving. So it is a parameter now, and the here-walk passes
// almost nothing because its next move is to poll until rows appear.
export function waitForLoad(tabId, timeout = 25000, graceMs = null) {
  const grace = graceMs != null ? graceMs
    : Math.max(600, Math.min(2500, Math.round(timeout / 6)));
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(fn); clearTimeout(t); setTimeout(resolve, grace); };
    const fn = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const t = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(fn);
  });
}

// --- ⚠ THE NETWORK SESSION IS SHARED. NEVER DISTURB A WATCH OR A FETCH THAT IS ALREADY READING. --
//
// THE RULE, and it is not a style preference:
//
//   1. There is ONE capture on this tab and every caller borrows it. Do not write a second
//      listener, a second attach, or a per-feature copy of any of this. A parallel capture is how
//      the watcher and the feed reader start losing events to each other.
//   2. Chrome allows ONE debugger client per tab. So an attach while someone else holds the tab
//      THROWS, and a detach while someone else is still reading KILLS THEIR CAPTURE SILENTLY —
//      their listener stays registered, no error is raised anywhere, and events simply stop. That
//      failure looks exactly like "the site sent nothing", which is the worst thing it could look
//      like.
//   3. Therefore hold and release are REFCOUNTED, below. The session is attached on the first
//      borrow and detached on the last release. `netWatch`'s persistent watch and `growFeed`'s
//      body reader outlive single calls, so any new caller — the asset scan is one — must borrow
//      through `cdpHold`/`cdpRelease` and never touch `chrome.debugger.attach`/`detach` directly.
//   4. `Network.enable` is only re-issued to GROW the buffers, never to shrink them. A caller that
//      wants no bodies must not shrink the buffers a feed reader is depending on: that would evict
//      the bodies mid-walk, and the feed would report its last few pages as if that were all of it.
//
//   5. THE EXEMPTION, so nobody "fixes" it later: the lane and hop paths attach directly to tabs
//      THEY created and close themselves. Nothing else can be reading those, so there is no session
//      to share and no watch to disturb. The rule is about the PERSON'S tab, which is the only one
//      a watch or a feed reader is ever pointed at.
//
// Cost of learning any of this the other way is a run that returns less than the page has and says
// nothing about why. That is the one failure mode this project keeps paying for.
const cdpHeld = new Map();   // tabId -> { n, bodies }

export async function cdpHold(target, { bodies = 0 } = {}) {
  const id = target.tabId;
  const held = cdpHeld.get(id);
  if (held) {
    held.n++;
    // Grow only. See rule 4.
    if (bodies && !held.bodies) {
      held.bodies = 1;
      await cdp(target, 'Network.enable',
        { maxTotalBufferSize: 256 * 1024 * 1024, maxResourceBufferSize: 32 * 1024 * 1024 })
        .catch(() => {});
    }
    return true;
  }
  await chrome.debugger.attach(target, CDP_VERSION);
  cdpHeld.set(id, { n: 1, bodies: bodies ? 1 : 0 });
  // A FEED'S BODIES HAVE TO SURVIVE UNTIL THE WALK ENDS. CDP evicts response bodies from a
  // per-resource and a total buffer, and the defaults are sized for a page load, not for forty
  // scrolls' worth of JSON. `getResponseBody` on an evicted entry throws, which would show up as a
  // feed that mysteriously returns only its last few pages.
  await cdp(target, 'Network.enable', bodies
    ? { maxTotalBufferSize: 256 * 1024 * 1024, maxResourceBufferSize: 32 * 1024 * 1024 }
    : {});
  return true;
}

export async function cdpRelease(target) {
  const id = target.tabId;
  const held = cdpHeld.get(id);
  if (!held) return;
  held.n--;
  if (held.n > 0) return;          // somebody else is still reading this tab
  cdpHeld.delete(id);
  await chrome.debugger.detach(target).catch(() => {});
}

// The session can die without anyone releasing it: the tab closes, the person opens DevTools, or
// Chrome takes the target away. Forgetting the refcount here is what stops the NEXT borrow from
// believing a session exists that does not.
chrome.debugger.onDetach.addListener((src) => { if (src?.tabId != null) cdpHeld.delete(src.tabId); });

// MAKE A TAB BELIEVE IT IS BEING LOOKED AT, FOR THE LENGTH OF ONE CALL.
//
// A lazy list is filled by an IntersectionObserver, and Chrome does not run those for a tab nobody
// is watching. So a grow driven while the window sits behind an editor scrolls the page, reaches the
// bottom, and loads nothing — measured on a storefront: `grew:false`, recordLinks 15 -> 15, while
// the SAME page scrolled by hand filled to 180.
//
// This uses the mechanism the lane tabs already use (`cdpPrepare`: focus emulation and an active
// web-lifecycle state) rather than injecting anything into the page. Nothing is added to the
// document, no events are swallowed, no timers are wrapped — an earlier attempt did inject and
// suppressed the very loading it was meant to enable. Attached for the call and detached after, so
// the debugging banner is visible for exactly as long as it is true.
export async function withVisibleTab(tabId, fn) {
  const target = { tabId };
  let held = false;
  try {
    // BORROWED. This used to attach and detach directly, which meant a grow or a collect running
    // while a `@net()` watch was open took the session away from the watch on its way out — the
    // watch's listener stayed registered and its events just stopped. Rule 2 above `cdpHold`.
    await cdpHold(target);
    held = true;
    await cdpPrepare(target);
  } catch (_) { /* DevTools open, or another debugger — run anyway, just throttled */ }
  try { return await fn(held); } finally {
    if (held) await cdpRelease(target);
  }
}
