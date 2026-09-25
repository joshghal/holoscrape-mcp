// HoloScrape — service worker: keeping a hidden tab's page engine moving (the frame keeper and its pump).
import { note } from './bg-log.js';

// --- keeping a hidden tab working, from the one clock it cannot slow ---------------------
//
// Three things break a pass the moment the user alt-tabs, and the page-side keeper (`raf.js`)
// holds the fix for all three — but its backstop timers are page timers, clamped like any other.
// The unthrottled clock this extension already owns is THIS worker. So while any walk or details
// pass runs, the worker arms the keeper and PUMPS it a few times a second: each pump runs every
// overdue frame backstop and every overdue engine wait. In front, the page's own timers win the
// race and the pump finds nothing due; hidden, the pump is what keeps everything moving.
const PUMP_MS = 150;   // each tick advances a chain by up to a dozen links — see `pump`
export const pumps = new Map();   // tabId → interval id

export async function keepAwake(tabId, on) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: 'MAIN',
      func: (want) => {
        const box = window['__holoscrapeFrames'];
        if (!box) return 'absent';
        return want ? box.arm() : box.disarm();
      },
      args: [!!on],
    });
    return r?.result || 'absent';
  } catch (_) { return 'absent'; }
}

export function startPump(tabId) {
  if (pumps.has(tabId)) return;
  let busy = false;
  const id = setInterval(async () => {
    if (busy) return;               // a slow injection must not stack behind itself
    busy = true;
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] }, world: 'MAIN',
        func: () => window['__holoscrapeFrames']?.pump?.(),
      });
    } catch (_) {
      // The tab is gone or navigated somewhere we cannot reach; the pass that started this
      // pump will notice on its own next call. Stop ticking against a wall.
      clearInterval(id);
      pumps.delete(tabId);
    } finally { busy = false; }
  }, PUMP_MS);
  pumps.set(tabId, id);
}

export function stopPump(tabId) {
  const id = pumps.get(tabId);
  if (id) { clearInterval(id); pumps.delete(tabId); }
}

// The frame wrapper is a `document_start` content script (see `raf.js`), so a tab that was
// already open when the extension was installed or updated does not have one — and neither does a
// Google domain outside the manifest's list, since match patterns cannot wildcard a TLD.
//
// Both are fixed by the same thing: register it for this origin, which makes every future load of
// it carry the wrapper, and tell the user that a reload is what turns it on. Not a silent
// failure and not a reload we perform ourselves — reloading the tab would throw away the rail
// they just spent minutes gathering.
// Tabs whose keeper went in AFTER the page had loaded, so the reports can stay honest about which
// half of it is working.
export const lateKeepers = new Set();

// PUT A KEEPER IN NOW, rather than asking for a reload and giving up.
//
// This is the reason the background-tab failure survived eight rounds of work on the keeper: the
// keeper was fine and was never there. `raf.js` is a `document_start`, MAIN-world content script,
// and Chrome cannot put one of those into a tab that is already open — so reloading the EXTENSION
// does nothing for the Maps tab you already had, `armFrames` registered it for next time, printed
// "reload the tab once", and the pass then failed in exactly the way the keeper exists to prevent.
// Eight iterations improving a mechanism, none checking it was loaded.
//
// Injecting the same file late gets three of its four mechanisms working immediately:
//
//   visibility spoof    `defineProperty` on Document.prototype — no load-time requirement
//   event swallow       capture phase on window, which runs before any listener on document
//   timer backstop      wraps setTimeout/setInterval, so every FUTURE timer is covered
//   frame backstop      NOT recovered — Maps captured `requestAnimationFrame` at bundle load and
//                       holds its own reference, which a later wrapper cannot reach
//
// The first of those is the one that matters most (see HIDDEN-TAB.md §1: Maps pauses ITSELF on
// `visibilitychange`, instantly, which is what "forfeits at the time you alt-tab" describes). So a
// late arm is most of the fix, and it costs one injection.
export async function lateKeeper(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: 'MAIN', files: ['raf.js'],
    });
    const state = await keepAwake(tabId, true);
    note('raf.late', { state, got: 'spoof+events+timers', missing: 'frame backstop' });
    if (state === 'armed') { lateKeepers.add(tabId); return true; }
    return false;
  } catch (e) {
    note('raf.lateFailed', { why: e.message });
    return false;
  }
}

export async function armFrames(tabId, gate) {
  if (gate?.frames !== 'absent') { lateKeepers.delete(tabId); return {}; }
  // Now, not next time.
  if (await lateKeeper(tabId)) return { framesLate: true };
  try {
    const tab = await chrome.tabs.get(tabId);
    const origin = new URL(tab.url).origin;
    const id = `raf-${origin}`;
    const have = await chrome.scripting.getRegisteredContentScripts({ ids: [id] }).catch(() => []);
    if (!have.length) {
      await chrome.scripting.registerContentScripts([{
        id,
        matches: [`${origin}/maps/*`],
        js: ['raf.js'],
        runAt: 'document_start',
        world: 'MAIN',
        persistAcrossSessions: true,
      }]);
      note('raf.registered', { origin });
    }
  } catch (e) { note('raf.registerFailed', { why: e.message }); }
  return { framesReload: true };
}
