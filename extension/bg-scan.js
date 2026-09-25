// HoloScrape — service worker: the asset scan (scan.js) of a page, and of a list of pages.
import { pageScan } from './scan.js';
import { DESCRIPTORS } from './providers.js';
import { mergeFrames } from './frames.js';
import { RESTRICTED } from './sites.js';
import { DEV } from './env.js';
import { restrictedHost, walking, scrollHome, scrollPinned } from './bg-state.js';
import { note, devLog, saveLog } from './bg-log.js';
import { keepAwake, startPump, stopPump } from './bg-awake.js';
import { waitForLoad } from './bg-cdp.js';
import { netOpen, netClose } from './bg-net.js';
import { saveResult, itemsFromNet, sessionFor, docToken, sameSpot, visitKey, holdSession, newId } from './bg-store.js';
import { verifyTypes } from './bg-files.js';

// WHAT A DEEP SCAN ASKED FOR, SO THE WALK CAN ASK FOR THE SAME THING ON PAGE TWO.
//
// The asset engine used to be injected from exactly one place — the panel's SCAN message — and the
// page walk never called it. Files therefore came off page one and no other, for anything the ROW
// table has no column for: a card's own <img> rides along inside the row, a CSS background does
// not. `test/shots.mjs` measures the split (p1=2 backgrounds, p2=0, p3=0).
//
// Keyed by the visit as well as the tab, so a scan of one page cannot make the walk of the next
// one gather files nobody asked for.
export const filesFor = new Map(); // tabId -> { sid, opts }

// See the note at the save inside `runScan`. A deliberate scan opens a visit; a passive poll joins
// the one that is open, and only mints its own when there is none.
// A RUN CLAIMS THE ADDRESS ITS OWN SCROLLING MOVED TO — the same claim `walkSession` makes for a
// walk, which a scan needed just as much and never had. Without it the media phase of a deep scan
// drifts the url, and the rows phase that follows computes a different visit key and files into a
// new table. Nothing site-specific: it compares where the run began with where the tab is now.
async function claimDrift(tabId, sid, startedAt) {
  if (!sid || !startedAt) return sid;
  const ended = (await chrome.tabs.get(tabId).catch(() => null))?.url || '';
  if (!ended || visitKey(ended) === visitKey(startedAt)) return sid;
  await holdSession(tabId, sid, [startedAt, ended]);
  note('scan.drifted', { from: visitKey(startedAt).slice(-46), to: visitKey(ended).slice(-46), sid });
  return sid;
}

async function scanSession(tabId, url, deliberate) {
  if (deliberate) return sessionFor(tabId, url);
  try {
    const doc = await docToken(tabId);
    const { sessions = {} } = await chrome.storage.local.get('sessions');
    const held = sessions[tabId];
    // Same document AND still the same place. The second half is not optional: an SPA never
    // replaces its document, so without it every route a person clicked through inherited the
    // previous route's files. A poll still may not OPEN a visit — that is the whole of the 97->21
    // fix — but it may only join one it is actually standing in.
    if (held?.sid && doc && held.doc === doc && sameSpot(held, url)) return held.sid;
  } catch (_) { /* fall through to the ordinary path */ }
  return sessionFor(tabId, url);
}

export async function runScan(tabId, opts) {
  // A deep scan is the caller that owns the page and is allowed to wait its turn;
  // a passive poll is not, and is simply skipped. The WALK is the third case: it owns the page
  // more completely than either, and it is the caller that `walking` was set by.
  if (walking.has(tabId) && !opts?.walked) return { error: 'WALKING' };
  try {
    if (opts?.keepScroll && !scrollPinned.has(tabId)) {
      try {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] }, world: 'MAIN',
          func: () => window.scrollY || document.documentElement.scrollTop || 0,
        });
        scrollHome.set(tabId, r?.result || 0);
      } catch (_) {} // an unreadable page is one we cannot scan either
    }
    // Defence in depth: blocked even if the panel somehow asks.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const blocked = restrictedHost(tab?.url || '');
    if (blocked) return { error: 'RESTRICTED', host: blocked };
    // The asset walk is minutes of in-page waiting too, and dies of the same clamped clock the
    // moment the user alt-tabs. Armed and pumped for the span; a page with no keeper (anything
    // that is not Maps) answers 'absent' and both calls are no-ops.
    const scanWalks = !!opts?.autoScroll;
    // Same rule as `runRows`: pump only a page that has a keeper. See there.
    if (scanWalks && (await keepAwake(tabId, true)) === 'armed') startPump(tabId);
    // WATCH THE WIRE WHILE THE PAGE IS READ, using the capture that already sees everything.
    //
    // The page reader can only report what is mounted. This is the same tab's network, asked for
    // one DevTools category, so a file that was fetched and then unmounted is still counted. Opened
    // BEFORE the read so the walk's own scrolling is inside the window, closed after.
    //
    // Attach can fail — Chrome allows one debugger client per tab, and someone watching the very
    // panel this mirrors holds the slot. That is not an error: the scan falls back to the DOM alone,
    // exactly as it always did, and `netWhy` says so instead of the count silently dropping.
    // ONLY FOR A SCAN THE PERSON ASKED FOR. The panel's passive poll calls this function every 2.5
    // seconds; attaching a debugger session on that cadence would thrash the tab and flash Chrome's
    // "started debugging this browser" bar over and over for a read nobody requested. `peek` and
    // `autoScroll` are what a deliberate scan sets — the same signal the walk itself is gated on.
    const wanted = !!(opts?.peek || opts?.autoScroll);
    const eyes = wanted ? await netOpen(tabId, '', { kinds: ['*'] }).catch(() => null) : null;
    let res; let out;
    // The borrow is released in the `finally` below, whatever happens in between.
    try {
      try {
      res = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true }, // embedded players live in cross-origin frames
        world: 'MAIN', // needed to see the page's own objects
        func: pageScan,
        // The list travels INTO the page: a restricted site embedded as an iframe
        // is invisible to the tab-level check above, so each frame refuses itself.
        args: [{ ...opts, restricted: RESTRICTED, providers: DESCRIPTORS }],
      });
    } finally {
      if (scanWalks) { stopPump(tabId); await keepAwake(tabId, false); }
    }
    out = mergeFrames(res, tab?.url);
    // THE LAST SCREEN'S IMAGES ARE STILL ON THE WIRE WHEN THE READ RETURNS.
    //
    // The page reader finishes the moment its own loop ends; the requests that loop just caused are
    // still arriving. Closing the capture there drops the tail — the deeper the walk went, the more
    // it drops, which is the worst possible bias. So wait for the wire to go QUIET rather than for a
    // fixed delay: no new image for `NET_IMG_QUIET_MS` means the batch has landed, and the cap stops
    // a page that streams forever from holding the scan open.
    if (eyes && eyes.attached) {
      const NET_IMG_QUIET_MS = 500;
      const NET_IMG_WAIT_MAX = 4000;
      const until = Date.now() + NET_IMG_WAIT_MAX;
      for (;;) {
        const idle = Date.now() - (eyes.last || 0);
        if (idle >= NET_IMG_QUIET_MS || Date.now() > until) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 120));
      }
    }
      const netMerge = itemsFromNet(out.items, eyes, tab?.url || '');
    const fetched = netMerge.added;
      if (eyes) {
        if (fetched || netMerge.enriched) note('scan.net', { added: fetched,
          confirmed: netMerge.enriched, seen: eyes.hits?.size || 0 });
        // SAY IT IN WORDS THE PERSON CAN ACT ON. `eyes.why` is Chrome's message, which names no cause
      // a caller can do anything about. There is exactly one common reason the attach fails and it
      // has a one-step remedy, so the reply says that instead of the raw error — and it says how
      // much was lost, because "22 images" with no note reads as the whole page.
      else if (eyes.why) {
        out.netWhy = /debugg|attach|Another/i.test(eyes.why)
          ? 'Only what is rendered was read — the network could not be watched because something '
            + 'else is debugging this tab (DevTools open, usually). Close it and scan again for '
            + 'every image the page actually fetched, which on a long thread is several times more.'
          : eyes.why;
      }
      }
    } finally {
      // ALWAYS RELEASED. runScan has an outer catch, so releasing only on the happy path meant a
      // page read that threw left the session held — and a held session keeps focus emulation on,
      // which changes how the NEXT caller's page behaves. Rule 3 above `cdpHold`.
      if (eyes) await netClose(eyes).catch(() => {});
    }
    await verifyTypes(out.items);
    // `noSave` is the walk's. It gathers this page's files and folds them into its OWN write, with
    // the URL of the page the person is on — a hop's page-seven scan is not a visit to page seven,
    // which is the same rule `runRows` already follows. It also keeps the walk the single writer,
    // and a second writer racing this one is `ETSY-TABLE-FREEZE.md`'s lost update.
    if (out.items?.length && !opts?.noSave) {
      // Held rather than inlined, because arming the walk needs the same visit this write lands
      // in — `saveResult` returns `{ id, result }` and never the sid it was given.
      // A GUESS MUST NOT START A NEW VISIT — measured, from a user's own log.
      //
      // The panel's passive poll calls this every 2.5 seconds with `peek: false`. On a page that
      // rewrites its URL as you scroll, each poll saw a "different" url, minted a NEW visit, and
      // saved the one screenful it could see into it. The panel follows the newest id, so a deep
      // scan that had just collected 97 files was replaced on screen by a poll holding 21 — and the
      // next twenty polls all re-saved 21, which is why the counter appeared to fluctuate and never
      // add up, and why the exported table held images the counter had never shown.
      //
      //   08:02:43  save action=scan id=mt43baw81xx files=97      <- the deep scan
      //   08:03:15  save action=scan id=mt43cqma3u8 files=21      <- a poll, new visit
      //   08:03:17  save action=scan id=mt43cqma3u8 files=21      <- and again, and again
      //
      // A deliberate scan may open a visit; a poll may only JOIN one. Same document and a visit
      // already held means the poll belongs to it, whatever the address bar now says. If there is
      // no held visit the poll behaves exactly as before, so a first read of a fresh page is
      // unchanged.
      const sid = await scanSession(tabId, tab?.url || out.url, !!opts?.peek);
      // AND THE VISIT KEEPS THE ADDRESS THE SCAN'S OWN SCROLLING MOVED TO.
      //
      // `tab` was read before the walk, so the visit above is keyed to where the scan BEGAN —
      // correct, and not enough on its own. The phase that runs next (the rows pass of a deep scan)
      // starts from where the tab is NOW, and until this claim existed that address belonged to no
      // visit, so it opened its own and the media phase's files were orphaned under the old id.
      // Only a scan that actually moved the page has anything to claim, so a passive poll skips it.
      if (opts?.autoScroll) await claimDrift(tabId, sid, tab?.url || '');
      const saved = await saveResult(out, out.url, sid);
      out = { ...saved.result, id: saved.id };
      note('save', { action: 'scan', id: saved.id, tab: tabId, files: out.items?.length ?? -1 });
      // Only a scan the USER asked for arms the walk. A passive poll runs every 2.5 seconds and
      // arming from it would make every walk on every page pay for an asset pass nobody wanted.
      if (opts?.peek) filesFor.set(tabId, { sid, opts });
    }
    // Only a pass the USER asked for writes the file. `opts.peek` marks a deep scan; the two
    // callers that pass `peek: false` are both automatic — the panel's watch() poll and the
    // rescan after a page change — and wiring the file to those is what produced a download
    // every 2.5 seconds, each erasing the last.
    if (DEV && devLog && opts?.peek) saveLog().catch(() => {});
    return out;
  } catch (e) {
    if (/Cannot access|host permission|Missing host/i.test(e.message)) {
      return { error: 'NO_ACCESS' };
    }
    throw e;
  }
}

export async function scanList(urls, opts) {
  const items = [];
  const seen = new Set();
  const log = [];
  const cov = { triggers: 0, clicked: 0, skipped: 0, dismissed: 0, blockedDownloads: 0, unmatched: 0, deep: true };
  let failed = 0;

  for (const url of urls.slice(0, 50)) {
    if (restrictedHost(url)) { log.push(`${url.slice(0, 40)} → skipped, restricted site`); continue; }
    let tab;
    try {
      tab = await chrome.tabs.create({ url, active: false });
      await waitForLoad(tab.id);
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true }, world: 'MAIN', func: pageScan,
        args: [{ ...opts, restricted: RESTRICTED, providers: DESCRIPTORS }],
      });
      const r = mergeFrames(res, url);
      for (const it of r?.items || []) if (!seen.has(it.url)) { seen.add(it.url); items.push(it); }
      for (const k of Object.keys(cov)) if (typeof cov[k] === 'number') cov[k] += r?.coverage?.[k] || 0;
      log.push(`${new URL(url).pathname.slice(0, 40)} → ${r?.items?.length || 0}`);
    } catch (e) {
      failed++;
      log.push(`${url.slice(0, 40)} → failed`);
    } finally {
      if (tab?.id) { try { await chrome.tabs.remove(tab.id); } catch (_) {} }
    }
    await new Promise((r) => setTimeout(r, 700)); // stay polite
  }

  await verifyTypes(items);
  log.unshift(`${urls.length} pages · ${items.length} files · ${failed} failed`);
  const out = { items, log, coverage: cov, url: `list:${urls.length} pages` };
  // No session: a batch over a list of URLs is not a visit to a page, and it gets
  // an entry of its own every time it is run.
  if (items.length) out.id = (await saveResult(out, out.url, newId())).id;
  return out;
}
