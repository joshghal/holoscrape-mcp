import { DESCRIPTORS } from './providers.js';
// `pageMail` and `mergeFrames` are here for the test hook below; the passes that use them live in
// bg-sites.js and bg-scan.js.
import { pageMail } from './mail.js';
import { mergeFrames } from './frames.js';
// One catalogue of what we know about a site: what we refuse, what we expect to
// come back thin, and what has actually been verified. The blocked list used to
// be written out here AND in the panel — two copies of the same fact.
import { RESTRICTED, siteStatus } from './sites.js';
// prod or stg — see env.js. The staging build is the only one that keeps a log.
import { ENV, DEV } from './env.js';
// The MCP bridge. Two files because the transport (staying connected, pairing, consent) has
// nothing to do with the vocabulary (what an agent may ask for), and mixing them is how a
// security boundary quietly acquires an exception.
import {
  bridgeStart, bridgeOps, bridgeState, bridgeAllows, bridgePair, bridgeEnable, bridgeGrant, bridgeShow,
  bridgePanelPing, bridgeReleaseHost, bridgeReconnectHost, bridgeKillHost, bridgeSetAutoWindow,
  bridgeSetKeepOnClose, bridgeSettings,
} from './bridge.js';
import { bridgeOpTable, dialFromPair, dialFromUrls, urlForPage } from './bridge-ops.js';
// What state the page was in when it was read (`page: {hidden, frames, settled, settleMs}`), and
// the one rule for "is it ready". Its own file: both are used by the lanes here AND by the bridge
// ops, and neither belongs to either.
import { settle, settleBrief, pageProbe, pageHeader, netTrack, armNav, sameDocument, SETTLE } from './settle.js';

// THE WORKER'S OWN MODULES. background.js is the entry: it registers the listeners that must exist
// on the worker's first turn and wires the passes together. Each bg-*.js owns one concern; the map,
// and the order they import each other in (a DAG — no module imports one that imports it):
//
//   bg-state.js     the claims, registries and walls every pass shares          (leaf)
//   bg-log.js       the ring-buffer log and its file                            (leaf)
//   bg-windows.js   the results popup windows                                   (leaf)
//   bg-files.js     naming, typing, sizing and downloading files; the CSV       (leaf)
//   bg-store.js     visits (sessions) and the result store                      state, log, files
//   bg-awake.js     the frame keeper and its pump for hidden tabs               log
//   bg-rows.js      driving the row engine and the pointer in a page            state, log, awake, store
//   bg-cdp.js       the debugger protocol: session hold, prepare, real input    log, rows
//   bg-net.js       capturing what a page fetched; the watch; feed walking      rows, cdp
//   bg-scan.js      the asset scan of a page and of a list of pages             state, log, awake, cdp, net, store, files
//   bg-details.js   the second step: opening rows (lanes, rail, 2GIS)           state, log, awake, rows, cdp, store
//   bg-sites.js     the third step: the businesses' own websites                state, log, rows, cdp, details
//   bg-harvest.js   page_harvest — a list into its records, in lanes            state, log, rows, cdp, net, store
//   bg-walk.js      following pages: hidden/visible tabs, or the tab in front   state, log, rows, cdp, store, scan, details
//
// Static imports only — MV3 service workers do not support dynamic import(). Every listener a module
// registers is registered at its top level, so it runs during this worker's first turn.
import { restrictedHost, pinnedFor, laneTabs, abandoned, walking, detailRun, hopCancel, hopProgress,
  scrollHome, scrollPinned, walledUntil, forgetWall } from './bg-state.js';
import { LOG, devLog, note, logText, saveLog } from './bg-log.js';
import { closeAllResults, openResults } from './bg-windows.js';
import { toCsv, exportCsv, mimeKind, downloadAll, askToSave, measure, verifyTypes, safeName, kindFromUrl } from './bg-files.js';
import { saveResult, itemsFromTables, sessionFor, keepSession, endSession, normUrl, visitKey, visitId, docToken,
  getResultFor, clearHistory } from './bg-store.js';
import { pumps, keepAwake, stopPump, lateKeeper, armFrames } from './bg-awake.js';
import { runRows, stopScan, runPoint, rememberPoint, recallPoint, forgetPoint, clearMarks } from './bg-rows.js';
import { waitForLoad, walkPressRealBatch, withVisibleTab } from './bg-cdp.js';
import { netOpen, netTake, netClose, netCatalogue, netWatch, growFeed } from './bg-net.js';
import { runScan, scanList } from './bg-scan.js';
import { openDetails, driveDetailsTabs, savedTablesFor } from './bg-details.js';
import { driveSites, siteRead } from './bg-sites.js';
import { harvest, harvestLinks } from './bg-harvest.js';
import { hopTabs, hopThroughTabs, hopHere, HERE_WAIT } from './bg-walk.js';

export { RESTRICTED };
// The names this module exported before the split, kept exported from here.
export { restrictedHost, pinnedFor, walledUntil, forgetWall } from './bg-state.js';
export { toCsv, mimeKind } from './bg-files.js';

// HoloScrape — service worker.
// Opens the side panel on toolbar click and runs the page scan on demand.

// Host access is granted at install, so the icon has exactly one job: open the
// panel. No activeTab dance, no per-site prompts, no state to fall out of sync.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  // EVERY MESSAGE, LOGGED AT THE DOOR. Reported repeatedly and correctly: the log could not tell
  // us what happened, because nothing the PANEL did was ever written down — 45 log points existed
  // and all of them were in here, none in the side panel, and none per record. A log that records
  // the worker's opinion of a run but not the run's actions cannot answer "why did it stop at 47".
  //
  // `LOG` is the panel's own door into it (see `logIt` in sidepanel.js), so a press, a phase and a
  // card answer all land in the same file in the order they happened. The per-record lines come
  // from `driveDetails`.
  if (msg.type === 'LOG') {
    note(msg.tag || 'panel', msg.data || {});
    respond({ ok: true });
    return false;
  }
  // The d* actions of a details pass are thousands of calls; logging each would bury everything
  // else. They are summarised per record instead — see `record` lines.
  if (msg.type !== 'ROWS' || !/^d(click|mark|step|web|read|gate|done|tables|screen)$|^stopped$|^progress$/.test(msg.op?.action || '')) {
    note('msg', { type: msg.type, action: msg.op?.action, tab: msg.tabId });
  }
  if (msg.type === 'SCAN') {
    runScan(msg.tabId, msg.opts).then(respond).catch((e) => respond({ error: e.message }));
    return true; // async
  }
  if (msg.type === 'DOWNLOAD') {
    downloadAll(msg.items).then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  if (msg.type === 'EXPORT_CSV') {
    exportCsv(msg).then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  // Set the page's stop flag. Its own message rather than a ROWS op, because it has to
  // get through while a ROWS call is already in flight — that is the entire point.
  // Pointing: start (resolves when the user picks or cancels), stop, or re-resolve a
  // remembered selector on a later visit.
  // LEARN A PAGE DIAL FROM URLS THE PERSON PASTED. Pure string work — see `dialFromPair`. It
  // touches no tab and reads no page, which is why it can answer synchronously on a site whose
  // pager the automatic finders cannot see at all.
  // PIN THE PERSON'S PLACE BEFORE ANYTHING IS ASKED OF THEM. Sent by the panel the instant deep
  // scan is pressed, and cleared if they back out of the card without starting anything.
  if (msg.type === 'PIN_SCROLL') {
    if (msg.clear) {
      scrollHome.delete(msg.tabId); scrollPinned.delete(msg.tabId);
      respond({ ok: true }); return true;
    }
    (async () => {
      try {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: msg.tabId, frameIds: [0] }, world: 'MAIN',
          func: () => window.scrollY || document.documentElement.scrollTop || 0,
        });
        scrollHome.set(msg.tabId, r?.result || 0);
        scrollPinned.add(msg.tabId);
      } catch (_) {} // an unreadable page is one we cannot scan either
      respond({ ok: true });
    })();
    return true;
  }
  if (msg.type === 'LEARN_DIAL') {
    const urls = (msg.urls || []).map((u) => String(u || '').trim()).filter(Boolean);
    if (urls.length < 2) { respond({ error: 'two addresses are needed — one page apart is enough' }); return true; }
    // THE LAST PAIR, NOT THE FIRST. With three urls the person usually pastes page 1, 2, 3; the
    // widest gap is the most informative, and page one is the one most likely to carry no dial.
    // ORDER-INDEPENDENT, AND HONEST ABOUT THE GAP. This passed the FIRST and LAST address and
    // told `dialFromPair` they were one page apart — so three filled boxes doubled every step
    // (measured on shopee: pages 0,1,2 in, "page 1 -> ?page=0, page 2 -> ?page=4" out). It also
    // assumed the boxes were in page order, which nobody promised. `dialFromUrls` reads each
    // address's own number and sorts by it. `msg.pages` still wins when the caller genuinely
    // knows the numbers — that is the pager card, which does.
    const dial = msg.pages
      ? dialFromPair(urls[0], urls[urls.length - 1], msg.pages[0], msg.pages[msg.pages.length - 1])
      : dialFromUrls(urls);
    if (!dial || dial.error) { respond({ error: dial?.error || 'could not read a page number out of those' }); return true; }
    // CONFIRMED AGAINST THE THIRD, when there is one. A dial that cannot rebuild the middle url
    // the person actually visited is the wrong dial, however plausible it scored.
    let confirmed = null;
    if (urls.length >= 3) {
      const mid = urls[1];
      let hit = false;
      for (let n = 1; n <= 50 && !hit; n++) hit = urlForPage(dial, n) === mid;
      confirmed = hit;
    }
    respond({ dial: { ...dial, confirmed }, samples: [1, 2, 3].map((n) => urlForPage(dial, n)) });
    return true;
  }
  if (msg.type === 'POINT_MEMORY') {
    const { url, save, forget } = msg;
    (forget ? forgetPoint(url) : save ? rememberPoint(url, save) : Promise.resolve())
      .then(() => recallPoint(url)).then((r) => respond({ point: r }))
      .catch(() => respond({ point: null }));
    return true;
  }
  if (msg.type === 'POINT') {
    runPoint(msg.tabId, msg.op).then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  if (msg.type === 'STOP') {
    stopScan(msg.tabId).then(respond).catch(() => respond({ error: 'STOP_FAILED' }));
    return true;
  }
  // The fallback hop: real tabs, for a site whose list only exists once rendered.
  // Read four times a second while a hop runs, so the sheet has something true to show.
  if (msg.type === 'GET_ENV') { respond({ env: ENV, dev: DEV }); return false; }
  // The bridge, as the panel sees it. Deliberately five small messages rather than one
  // settings blob: pairing, switching on, pinning and granting are four different decisions, and
  // a single "save settings" would let one of them ride in on another's confirmation.
  if (msg.type === 'BRIDGE_STATE') {
    Promise.all([bridgeSettings(), pinnedTab()])
      .then(([cfg, pin]) => respond({
        ...bridgeState(),
        enabled: !!cfg.enabled,
        off: !!cfg.off,
        autoWindow: cfg.autoWindow !== false,
        keepOnClose: !!cfg.keepOnClose,
        hasToken: !!cfg.token,
        origins: Object.keys(cfg.origins || {}),
        pinned: pin ? { tabId: pin.id, title: pin.title, url: pin.url } : null,
      }))
      .catch((e) => respond({ error: e.message }));
    return true;
  }
  if (msg.type === 'BRIDGE_PAIR') {
    bridgePair(msg.token).then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  if (msg.type === 'BRIDGE_ENABLE') {
    bridgeEnable(msg.on).then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  if (msg.type === 'BRIDGE_SET_AUTOWINDOW') {
    bridgeSetAutoWindow(msg.on).then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  if (msg.type === 'BRIDGE_SET_KEEP_ON_CLOSE') {
    bridgeSetKeepOnClose(msg.on).then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  // A CLICK, WHICH IS THE ONE THING THAT CAN ALWAYS BRING THE WINDOW FORWARD.
  //
  // `chrome.windows.create({focused:true})` only raises a window when Chrome can attribute the call
  // to a genuine user gesture. Reload, browser startup and the unattended reconnect all open the
  // window from code with no click behind it, and Chrome is allowed to create it without raising it
  // — measured: it opened, correctly, and sat behind the main browser window regardless of the flag.
  // No amount of retrying that call fixes it; the button click here is a fresh, real gesture, so it
  // is the one path guaranteed to work.
  if (msg.type === 'BRIDGE_SHOW') {
    bridgeShow().then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  // The panel's heartbeat — see bridge.js. A plain message rather than the panel's existing 'panel'
  // port, because a message always reaches whichever worker instance is currently running, while
  // that port's own disconnect listener can be silently lost to an eviction that happened between
  // the panel opening and closing. This is what notices when the fast path cannot.
  if (msg.type === 'BRIDGE_PANEL_PING') {
    bridgePanelPing().then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  if (msg.type === 'BRIDGE_GRANT') {
    bridgeGrant(msg.origin, msg.on).then((o) => respond({ origins: Object.keys(o) }))
      .catch((e) => respond({ error: e.message }));
    return true;
  }
  // One host, not all of them — the panel's per-row Release/Reconnect buttons.
  if (msg.type === 'BRIDGE_RELEASE_HOST') {
    bridgeReleaseHost(msg.port).then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  if (msg.type === 'BRIDGE_RECONNECT_HOST') {
    bridgeReconnectHost(msg.port).then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  if (msg.type === 'BRIDGE_KILL_HOST') {
    bridgeKillHost(msg.port).then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  if (msg.type === 'BRIDGE_PIN') {
    pinTab(msg.tabId ?? null)
      .then((t) => respond({ pinned: t ? { tabId: t.id, title: t.title, url: t.url } : null }))
      .catch((e) => respond({ error: e.message }));
    return true;
  }
  if (msg.type === 'GET_LOG') { respond({ text: logText(), lines: LOG.length }); return false; }
  if (msg.type === 'SAVE_LOG') {
    // Pressed by a person, so it always writes — the floor exists to stop automatic bursts,
    // not to refuse someone who asked.
    saveLog({ force: true }).then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  // The user is going to clear the check themselves, so the brake comes off.
  if (msg.type === 'WALL_CLEAR') { forgetWall(msg.url || ''); respond({ ok: true }); return false; }
  if (msg.type === 'HOP_STATUS') {
    respond(hopProgress.get(msg.tabId) || null);
    return false;
  }
  if (msg.type === 'HOP_TABS') {
    hopThroughTabs(msg).then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  // Walk the tab the user is looking at. Not behind a cooling period: this pass does not go
  // behind anyone's back, and its answer to a wall is to stop and hand the tab over.
  if (msg.type === 'HOP_HERE') {
    hopHere(msg.tabId, msg).then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  if (msg.type === 'ROWS') {
    runRows(msg.tabId, msg.op).then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  // Open every row and read the page behind it. Its own message rather than a ROWS op
  // because it may have to change the tab's ZOOM first, which only the worker can do.
  if (msg.type === 'DETAILS') {
    openDetails(msg.tabId, msg).then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  // And the third step: the businesses' own sites, read for a contact address. Its own message
  // rather than an option on DETAILS because it reads DIFFERENT PAGES — ninety sites nobody has
  // measured, not one map we have — and the two passes fail in unrelated ways.
  if (msg.type === 'SITES') {
    driveSites(msg.tabId, msg).then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  // How that pass is getting on, for a panel whose reply never arrived. See `detailRun`. Both
  // passes publish here — only one of them runs on a tab at a time.
  if (msg.type === 'DETAILS_STATE') { respond(detailRun.get(msg.tabId) || null); return false; }
  if (msg.type === 'SCAN_LIST') {
    scanList(msg.urls, msg.opts).then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  if (msg.type === 'SIZES') {
    measure(msg.urls).then(respond).catch(() => respond({ sizes: {}, kinds: {} }));
    return true;
  }
  if (msg.type === 'SITE_STATUS') {
    respond(siteStatus(msg.url));
    return false;
  }
  if (msg.type === 'GET_HISTORY') {
    chrome.storage.local.get('history').then((r) => respond({ history: r.history || [] }));
    return true;
  }
  if (msg.type === 'GET_RESULT_FOR') {
    getResultFor(msg.url, msg.tabId).then((r) => respond({ result: r }))
      .catch(() => respond({ result: null }));
    return true;
  }
  if (msg.type === 'CLEAR_HISTORY') {
    clearHistory().then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
  if (msg.type === 'OPEN_RESULTS') {
    openResults(msg.id).then(respond).catch((e) => respond({ error: e.message }));
    return true;
  }
});

// The panel holds a port open for its lifetime; losing it means it closed.
//
// AND CLOSING IT STOPS EVERYTHING. The panel is the only thing that starts work and the only thing
// that reports it, so once it is gone a running pass has nobody to report to and no way to be
// stopped — it would go on clicking somebody's page, or worse, go on holding five background tabs
// open with a debugger attached and a yellow bar on each. Nothing should outlive the window that
// asked for it.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  port.onDisconnect.addListener(() => {
    closeAllResults();
    clearMarks();
    abandonAll('the panel was closed');
  });
});

// The other two ways a run can be left without an owner.
//
// A worker teardown would strand five tabs with debuggers on them, and nothing else would ever close
// them — `laneTabs` lives in memory and goes with the worker.
chrome.runtime.onSuspend?.addListener?.(() => { abandonAll('the extension was suspended'); });
// And the LIST tab going away ends its run: there is nothing left to read, and the lanes are only
// open on its behalf. `endSession` already handles the session; this handles the work.
chrome.tabs.onRemoved.addListener((closedId) => {
  if (laneTabs.has(closedId) || walking.has(closedId)) abandon(closedId, 'the list tab was closed');
  // A lane tab closed by hand is not an error — drop it from the registry so the run does not later
  // try to close a tab that is already gone, and so a stale id cannot match a NEW tab with the same
  // number after Chrome reuses one.
  for (const [owner, held] of laneTabs) {
    const at = held.tabs.indexOf(closedId);
    if (at >= 0) {
      held.tabs.splice(at, 1);
      held.targets.splice(at, 1);
      note('lanes.tabClosed', { owner, left: held.tabs.length });
    }
  }
});

// Put a tab's work down: the page's own stop flag, the pump, the keeper, its lane tabs and their
// debuggers, and any hop. Every step is independently guarded, because this runs when things are
// already going wrong and a throw here would leave the rest of it running.
async function abandon(tabId, why) {
  abandoned.add(tabId);
  note('abandon', { tab: tabId, why });
  hopCancel.set(tabId, Date.now());
  // The flag lives on the page and is what an in-page walk actually watches.
  await stopScan(tabId).catch(() => {});
  stopPump(tabId);
  await keepAwake(tabId, false).catch(() => {});
  const held = laneTabs.get(tabId);
  if (held) {
    laneTabs.delete(tabId);
    for (const t of held.targets) if (t) await chrome.debugger.detach(t).catch(() => {});
    for (const id of held.tabs) await chrome.tabs.remove(id).catch(() => {});
    note('abandon.lanes', { closed: held.tabs.length });
  }
  const run = detailRun.get(tabId);
  if (run?.running) detailRun.set(tabId, { ...run, running: false, why });
  // The claim goes last: releasing it earlier would let the panel's own poll — if anything is still
  // polling — extract from a page that is mid-teardown.
  while (walking.has(tabId)) if (walking.delete(tabId)) break;
}

// Everything, everywhere. The union of what the worker currently has in flight, so a pass whose tab
// is not the one the panel was showing is stopped as well.
async function abandonAll(why) {
  const ids = new Set([
    ...walking.n.keys(), ...pumps.keys(), ...laneTabs.keys(), ...hopProgress.keys(),
    ...[...detailRun.entries()].filter(([, v]) => v?.running).map(([k]) => k),
  ]);
  if (!ids.size) return;
  note('abandonAll', { tabs: ids.size, why });
  for (const id of ids) await abandon(id, why).catch(() => {});
  if (DEV && devLog) saveLog({ force: true }).catch(() => {});
}

// Test hook: the worker cannot receive its own sendMessage, so the integration
// harness needs a way to drive the real pipeline rather than a copy of it.
globalThis.__holoscrape = {
  runScan, scanList, openResults, restrictedHost, saveResult, mergeFrames,
  measure, verifyTypes, downloadAll, safeName, mimeKind, siteStatus, RESTRICTED,
  runRows, exportCsv, toCsv, stopScan, runPoint, itemsFromTables, kindFromUrl, rememberPoint, recallPoint, forgetPoint,
  harvest,
  hopTabs, hopThroughTabs, hopHere, hopProgress, HERE_WAIT, note, logText, saveLog, ENV, DEV, forgetWall, walledUntil,
  openDetails, sessionFor, keepSession, endSession, normUrl, visitKey, visitId, docToken, walking,
  driveDetailsTabs, abandon, abandonAll, laneTabs, abandoned,
  driveSites, siteRead, pageMail,
  bridgeState, bridgePair, bridgeEnable, bridgeGrant, bridgeSettings, pinnedTab, pinTab,
  bridgeReleaseHost, bridgeReconnectHost, bridgeKillHost, bridgeSetAutoWindow, bridgeShow, bridgeStart,
  settle, settleBrief, pageProbe, pageHeader, netTrack, armNav, SETTLE,
};

// --- the MCP bridge ------------------------------------------------------------------------------
// A PINNED TAB IS A SELECTION; FOCUS IS NOT. Figma's plugin bridge can ask what the person has
// selected and get a stable answer, because a selection survives them walking away to type. Browser
// focus does not: composing a prompt means leaving Chrome, and alt-tabbing on the way means the
// "active tab" is wherever they landed. So the panel offers "use this page", and that pin outranks
// focus whenever it is set.
async function pinnedTab() {
  const { bridgePin } = await chrome.storage.local.get('bridgePin');
  if (!bridgePin) return null;
  const t = await chrome.tabs.get(bridgePin).catch(() => null);
  // A pin to a tab that has been closed is worse than no pin, because it silently points the agent
  // at nothing. Forgotten rather than reported.
  if (!t) { await chrome.storage.local.remove('bridgePin'); return null; }
  return t;
}
async function pinTab(tabId) {
  if (tabId == null) await chrome.storage.local.remove('bridgePin');
  else await chrome.storage.local.set({ bridgePin: tabId });
  return pinnedTab();
}

const bridgeTable = bridgeOpTable({
  hopHere, hopProgress, runRows, stopScan, savedTablesFor, exportCsv, pinnedFor,
  restrictedHost, waitForLoad, pinnedTab, harvest, harvestLinks, netOpen, netTake, netClose,
  downloadAll, askToSave,
  growFeed, walkPressRealBatch,
  netCatalogue, netWatch, lateKeeper, armFrames, withVisibleTab,
  settle, settleBrief, pageProbe, pageHeader, netTrack, armNav, sameDocument,
  descriptors: DESCRIPTORS,
  allows: bridgeAllows,
});
bridgeOps(bridgeTable);
// Same reason as the hook above: the bridge-level behavior — `list_extract`'s selector pin,
// `page_grow`'s container targeting — lives in this table, and the harness has to drive the REAL
// table rather than a copy of it, without standing up a paired WebSocket per test.
globalThis.__holoscrape.bridgeOpsTable = bridgeTable;
bridgeStart().catch(() => {});
