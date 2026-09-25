// THE SCAN FLOW: the passive poll, tab sync, Deep scan, the page walk, pointing, the record and
// site passes, the cards that end them, and the keyboard. One module because it is one strongly
// connected graph — `run` ↔ `sync` ↔ `afterScan` ↔ `followPages` ↔ `startPointing` — and because
// the state it owns (`busy`, `stoppable`, `pressWaiting`, `scannable`, `deepOrigin`, …) is written
// by bare name in several of these functions. Everything that does not decide anything is imported.
//
// The suite pins some of this file's text: `sync`'s `t.id !== tab?.id` (test/extension.mjs),
// `run`'s reset block `deepT0 = Date.now(); … lastHop = null; … lastHopPages = 0` (test/panel.mjs),
// `pressDeep`/`followPages`' `deepOrigin` lines (test/stop-returns-to-where-you-pressed.mjs) and the
// three strings test/press-is-never-dropped.mjs mutates in `run`, `watch` and `deepBody`.
import { $, esc, sameSite, mins, shortUrl } from './panel-util.js';
import { S, tab, setTab, liveTimer, liveTab, SCAN } from './panel-state.js';
import { contextAlive, showStale, send, logIt, toggleDrawer, goScreen, bridgeIsLive } from './panel-shell.js';
import { freshTraits, chainStart, closeLive, stopScan } from './panel-sheet.js';
import { ask, closeHalf } from './panel-card.js';
import { show, paintChipFade } from './panel-readout.js';
import { loadHistory } from './panel-history.js';
import { waitOutDetails, sitesToRead, readTables } from './panel-queries.js';
import { learnDial } from './panel-dial.js';
import { liveGrow } from './panel-live.js';
import { openResults, runSummary } from './panel-results.js';

// Either checkbox, since the setting lives on the scan panel AND in Settings — see the wiring
// in init(), which keeps both mirrored. Reading both here rather than trusting the mirror alone
// means neither box being momentarily absent (a screen not yet rendered) can read as "off".
const autoFollowOn = () => !!($('autoFollow')?.checked || $('autoFollowPanel')?.checked);

let scannable = false, blockedHost = null;

// How many lists this page holds. Declared up here with the rest of the state:
// `let` below its first use is a temporal-dead-zone crash waiting for the right
// ordering, which this file has already been bitten by once.
// THE "ALSO HOLDS A LIST OF …" PICKER IS GONE, deliberately. It sat under "Follow pagination
// and load more" and asked which of the page's lists to read — a real question when a scan read
// ONE list, and a misleading one now that a deep scan takes the whole page. Offering a choice
// that no longer changes the outcome teaches the person their answer mattered. Removed rather
// than hidden: the engine's own scoring picks the list, which is exactly what happened whenever
// nobody clicked a chip, so nothing about the default path changes.
// `readTables` still runs — its detection is what reveals "See result" on a page whose only
// content is a table — it just no longer draws a control.
let busy = false;
// `busy` means the panel is mid-operation, and the PASSIVE POLL sets it too — every 2.5
// seconds, for as long as it takes. Reading it as "a scan is running" made the Deep scan
// button a Stop button at random: click during a poll and the press stopped something
// instead of starting anything. Switching tabs made it likely rather than rare, because
// arriving on a tab kicks a fresh poll. So the two verbs hang off `stoppable`, which is
// only ever true while something the user asked for is in flight — a deep scan, a
// keep-going stretch, a page hop.
let stoppable = false;

// A press that has arrived and not yet started. The poll checks this at every await it
// owns and abandons itself the moment it turns true, so the wait below is one round trip
// and not one whole walk.
let pressWaiting = false;

const WATCH_MS = 2500;

// Skipped whenever anything else is happening: a deep scan is mid-click, the tab
// is not the one we are showing, or the page is off limits. A poll that fought
// the deep scan for the page would corrupt both.
async function watch() {
  // `pressWaiting` covers the whole time a press is being answered — the wait for an earlier
  // poll AND the card that follows. A poll that started behind the card is what set `busy` at the
  // moment the person finally pressed Quick scan, and `run()` then dropped that press.
  if (busy || pressWaiting || !scannable || !contextAlive()) return;
  if (document.hidden) return;
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!t || t.id !== tab?.id || t.url !== tab?.url) return; // sync() handles moves
    await run({ peek: false, silent: true, quiet: true });
  } catch (_) { /* a poll that fails is not worth reporting */ }
}

let estimate = { triggers: 0, seconds: 0 };
// Whether THIS visit has had a deep scan. Per visit, not per page: arriving again is a
// new page as far as the panel is concerned, and the button should offer a first scan.
let deepDone = false;


async function init() {
  // One button, two verbs, and the label always says which. Disabling it while busy
  // left the panel with no visible way to stop a scan — Esc works, but only while the
  // panel has focus, and during a scan the user is watching the page.
  $('deep').addEventListener('click', () => (stoppable ? stopScan() : pressDeep()));
  $('open').addEventListener('click', () => openResults());
  // The untested-site banner's one route. Same destination the halfcard's primary action had.
  $('untestedGo').addEventListener('click', () => { toggleDrawer(true); goScreen('scBridge'); });
  // "Scan a list of pages" was removed as a feature (menu row + screen); its wiring went with it.
  // History and settings moved behind one control in the header. The panel below
  // is now only the readout and the action — everything you go looking for is
  // here, and nothing you go looking for is in the way while you scan.
  $('menu').addEventListener('click', () => toggleDrawer());
  $('menuList').querySelectorAll('.mrow').forEach((r) =>
    r.addEventListener('click', () => goScreen(r.dataset.screen)));
  document.querySelectorAll('[data-back]').forEach((b) =>
    b.addEventListener('click', () => goScreen(null)));
  wireKeys();

  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !$('drawer').classList.contains('open')) return;
    // One step back, not one step out.
    const from = S.atScreen;
    if (from) { goScreen(null); $('menuList').querySelector(`[data-screen="${from}"]`)?.focus(); }
    else { toggleDrawer(false); $('menu').focus(); }
  });

  // Edge fades follow the scroll position of the chip row.
  $('chips').addEventListener('scroll', paintChipFade, { passive: true });
  addEventListener('resize', paintChipFade);

  chrome.tabs.onActivated.addListener(() => sync());
  chrome.tabs.onUpdated.addListener((id, info) => {
    if (id === tab?.id && (info.status === 'complete' || info.url)) sync();
  });

  // The only switch here that is remembered, because it is the only one whose answer
  // belongs to an investigation rather than to a scan. The worker reads the same key and is
  // restarted by Chrome at will; a setting that lived in this checkbox alone would be off
  // again halfway through working something out.
  // The switch exists in staging only. A production build has no logging UI at all, which
  // is the difference between a promise and a build.
  try {
    const { dev } = (await send({ type: 'GET_ENV' }).catch(() => ({}))) || {};
    $('devLogRow').hidden = !dev;
    if (dev) {
      const { devLog } = await chrome.storage.local.get('devLog');
      $('devLog').checked = devLog == null ? true : !!devLog;
    }
  } catch (_) { $('devLogRow').hidden = true; }
  // TWO CHECKBOXES, ONE SWITCH. The setting belongs on the scan panel itself — it is a decision
  // about the run someone is looking at, not a preference to go hunting for in Settings — but the
  // Settings copy stays too, for the one moment it actually helps: before a FIRST scan, when the
  // main panel showing it hasn't rendered yet. Read once, on init, off (safe: a first run still
  // asks); written to storage and mirrored to its twin on every change, in either direction, so
  // neither ever shows a different answer from the other. `afterScan()` reads either box, live —
  // no storage round trip there, and no worker mirror either.
  const autoFollowBoxes = ['autoFollow', 'autoFollowPanel'].map((id) => $(id)).filter(Boolean);
  try {
    const { autoFollow } = await chrome.storage.local.get('autoFollow');
    for (const box of autoFollowBoxes) box.checked = !!autoFollow;
  } catch (_) { /* the boxes stay unchecked, which is the safe reading */ }
  for (const box of autoFollowBoxes) {
    box.addEventListener('change', async () => {
      const on = box.checked;
      for (const other of autoFollowBoxes) if (other !== box) other.checked = on;
      await chrome.storage.local.set({ autoFollow: on }).catch(() => {});
      $('caption').textContent = on
        ? 'Following pagination and load-more on its own from now on. Stop still works any time.'
        : 'Asking before turning the page or growing the feed, like before.';
    });
  }
  $('devLog').addEventListener('change', async () => {
    const on = $('devLog').checked;
    await chrome.storage.local.set({ devLog: on }).catch(() => {});
    $('caption').textContent = on
      ? 'Logging. Each finished run writes its own Downloads/HoloScrape/holoscrape-log-<time>.txt.'
      : 'Logging off.';
  });

  $('reloadPanel').addEventListener('click', () => location.reload());

  // Spotlight on the primary action only. Two custom properties, no library —
  // applying this to everything would make it decoration instead of emphasis.
  $('deep').addEventListener('pointermove', (e) => {
    const r = $('deep').getBoundingClientRect();
    $('deep').style.setProperty('--mx', `${e.clientX - r.left}px`);
    $('deep').style.setProperty('--my', `${e.clientY - r.top}px`);
  });

  // A page keeps producing assets as you use it — open a gallery, expand a
  // thumbnail, load the next batch. Scanning once on open meant everything after
  // that moment needed a manual rescan. The passive read touches nothing and
  // costs no requests, so it just runs on a timer; results union rather than
  // replace, so a deep scan's finds survive every later poll.
  setInterval(watch, WATCH_MS);
  // Lifeline: when this panel closes the port drops and the worker cleans up
  // any result windows it opened.
  try { chrome.runtime.connect({ name: 'panel' }); } catch (_) {}
  // The connection window's real lifeline. The port above is the fast path and works whenever the
  // service worker that received it is still the one running — but that listener lives inside ONE
  // worker instance, and Chrome deletes it along with everything else in that instance's memory the
  // moment the worker is evicted for being idle. A panel open longer than about thirty seconds has
  // very likely outlived at least one eviction, and from then on the fast path has nothing left to
  // notice with. A heartbeat message always reaches whichever worker happens to be running when it
  // arrives — MV3 wakes an evicted worker to handle an incoming message — so this is what actually
  // guarantees the connection window closes with the panel, not merely usually does.
  chrome.runtime.sendMessage({ type: 'BRIDGE_PANEL_PING' }).catch(() => {});
  setInterval(() => { chrome.runtime.sendMessage({ type: 'BRIDGE_PANEL_PING' }).catch(() => {}); }, 5000);
  // Catches the case where the context dies while the panel just sits open.
  setInterval(() => { if (!contextAlive()) showStale(); }, 2000);

  // AN AGENT ASKING TO SAVE FILES BECOMES A QUESTION ON THIS SCREEN.
  //
  // The only route by which an MCP call can write to disk. It cannot answer itself and it cannot be
  // pre-approved: the request arrives here, a person reads how many files and from which site, and
  // presses one of two buttons. Closing the panel is a refusal by construction — with nothing
  // listening, `sendMessage` in the worker rejects and the op refuses there.
  //
  // The card is the SAME `ask()` every other decision in this panel uses, so this looks like the
  // rest of the product rather than a security dialog someone learns to dismiss.
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type !== 'ASK_SAVE') return undefined;
    // A QUESTION NOBODY CAN SEE IS NOT A QUESTION. The panel's main view is hidden whenever the
    // current tab is not one this extension can read — a chrome:// page, the extensions page, a
    // fresh tab — and the card lives inside that view, so painting it there would leave the person
    // looking at a screen with nothing on it while the agent's call sat waiting two minutes for an
    // answer that could not be given. Say so at once instead; the reply names the fix.
    if ($('panel').hidden) {
      respond({ approved: false, unavailable: true });
      return true;
    }
    const kinds = Object.entries(msg.byType || {})
      .sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ');
    ask({
      q: `Save <b>${msg.n}</b> file${msg.n === 1 ? '' : 's'} to your Downloads?`,
      // A LIST CAN SPAN SITES, and the person pressing Save is entitled to know before they press.
      // One origin is the special case, not the shape: an agent-assembled list of picture urls
      // routinely reaches a dozen cdns.
      sub: [msg.hosts > 1 ? `${msg.hosts} sites: ${msg.origin}` : msg.origin, kinds]
        .filter(Boolean).join(' — '),
      note: msg.total > msg.n
        ? `${msg.total} were found; the agent asked for ${msg.n}.`
        : 'Asked for by the agent connected over MCP. Nothing is saved unless you press Save.',
      actions: [
        { label: `Save ${msg.n}`, value: true },
        { label: 'No', value: false, kind: 'ghost' },
      ],
    }).then((v) => respond({ approved: v === true }));
    return true; // the answer arrives when the person presses a button
  });

  await sync();
}

// --- state ------------------------------------------------------------------
async function sync({ rescan = true } = {}) {
  if (!contextAlive()) return showStale();
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  // A move is a different TAB or a different URL, not a different URL alone. The panel is
  // one document shared by every tab, so two tabs open on the same page used to read as
  // "nothing changed" — and everything below that retracts on a move stayed put: the
  // unanswered question from the first tab was still pending on the second, invisible
  // because the live sheet hides itself off its own tab, and an invisible pending question
  // makes Deep scan return without doing anything. That is the "infinite loading until you
  // close and reopen the panel" — reopening was just the only way to clear pendingAsk.
  const changed = !!t && (t.url !== tab?.url || t.id !== tab?.id);
  // AND A PAGE THAT REWRITES ITS OWN ADDRESS HAS NOT MOVED.
  //
  // This is the bug where the card after "open each one" appeared and vanished in the same
  // second. Google Maps puts the record you open into the address bar, so a pass that opens
  // 122 records rewrites the URL 122 times, and `chrome.tabs.onUpdated` reports every one of
  // them with `info.url`. Each rewrite reached here, read as a move, and retracted the
  // question that the pass had just finished asking — the pass killed its own report.
  //
  // It also threw away `resultId` on the way past, which is the table that had just been
  // saved, so "Open results" had nothing to open.
  //
  // The engine made exactly this mistake in `stamp()` and the discriminator is the same one:
  // a different SITE is somebody going somewhere, a different path on the same site is a page
  // talking about itself. Tab identity still counts as a move on its own, which is what the
  // paragraph above is about.
  const moved = !!t && (t.id !== tab?.id || !sameSite(t.url, tab?.url));
  setTab(t || null);
  S.site = tab?.url ? await send({ type: 'SITE_STATUS', url: tab.url }).catch(() => ({ status: 'unknown' }))
                  : { status: 'unknown' };
  S.bridgeLive = await bridgeIsLive();
  blockedHost = S.site.status === 'blocked' ? S.site.host : null;
  scannable = !!tab?.url && /^https?:/.test(tab.url) && !blockedHost;

  // A question belongs to the page it was asked about. Leaving retracts it — a sheet
  // about Tokopedia's feed hanging over a different tab is worse than no sheet, and an
  // answer recorded against a page the user never saw it on is worse still.
  if (moved) { S.resultId = null; S.resultsUrl = null; S.tableId = null; deepDone = false; }
  // A QUESTION belongs to the page it was asked about — a sheet about Tokopedia's feed
  // hanging over a different tab is worse than no sheet, and an answer recorded against a
  // page the user never saw it on is worse still. So questions are retracted on a move.
  //
  // A running scan is the opposite. It is still running, the sheet is the only place its
  // progress and its Stop button live, and hiding it with nothing to bring it back left
  // people watching a scan they could neither see nor stop. It follows its own tab: away
  // while you are elsewhere, back when you return.
  if (moved && S.pendingAsk) closeHalf();
  if (liveTimer) $('half').hidden = liveTab !== tab?.id;
  else if (moved) closeHalf();
  render();
  if (!scannable) { closeHalf(); return; }

  // Results belong to a page. On arriving at a page we've scanned before, show
  // THAT page's saved result rather than starting blank or mixing it with the
  // previous page's findings.
  if (changed || !S.resultId) {
    // Scoped to this tab so it returns THIS visit's result. Asked by URL alone it
    // returned a scan from days ago and the next scan merged into it.
    const { result } = await send({ type: 'GET_RESULT_FOR', url: tab.url, tabId: tab.id });
    if (result) {
      S.resultId = result.id;
      S.resultsUrl = result.url;
      show(result.items || [], result.coverage, !!result.coverage?.deep, result.scannedAt);
      reaskIfPending();
      setEstimate(result.coverage, SCAN.delay, !!result.coverage?.deep);
      loadHistory();
      return;
    }
  }
  // Nothing between opening the panel and seeing a result: the passive read is
  // instant and touches nothing, so it runs on its own. Only Deep scan — which
  // clicks — waits to be asked for.
  if (rescan && !busy) run({ peek: false, silent: true });
  loadHistory();
}

const host = () => { try { return new URL(tab.url).hostname.replace(/^www\./, ''); } catch { return 'this site'; } };

function render() {
  $('blocked').hidden = !blockedHost;
  $('arm').hidden = scannable || !!blockedHost;
  $('panel').hidden = !scannable;
  // Settings and the URL list are not properties of the current tab — a list scan
  // opens its own tabs — so the sheet stays reachable on a page we cannot read.
  if (blockedHost) {
    $('blockedHost').textContent = blockedHost;
    $('blockedWhy').textContent = S.site.why || '';
  }
  // Lives under the count now, so it only ever renders in the one state where
  // the count means anything. The off-limits and no-page cases have their own
  // full explanations on screen and never needed a second, terser copy.
  $('where').innerHTML = `<span class="led on"></span><span class="pre">on</span>`
    + `<span class="h">${esc(host())}</span>${siteBadge()}`;

  // Said before the scan finishes, not after: on a site that structurally holds
  // little, a thin result is the expected outcome, and learning that only from an
  // empty table reads as the tool being broken.
  const thin = S.site.status === 'thin';
  $('thin').hidden = !thin || !scannable;
  if (thin) $('thinWhy').textContent = S.site.why;
}

// Quiet by design. `unknown` is the default state of most of the web and is not
// a warning, so it says nothing at all — a badge on every ordinary page would
// train you to ignore the one that matters.
function siteBadge() {
  if (S.site.status === 'verified') {
    return `<span class="tag ok" title="Scanned end to end and confirmed${S.site.by === 'suite'
      ? ' by the test suite, on every release' : ' by hand'}. Finds ${esc(S.site.finds || 'assets')}.">tested</span>`;
  }
  if (S.site.status === 'thin') return '<span class="tag warn">limited</span>';
  return '';
}

// --- pointing ---------------------------------------------------------------
// A pick is a hypothesis, so every path here ends in a test. Enabling something and
// leaving the user to discover whether it worked is the part of this interaction that is
// usually missing.
let pointing = false;

// A hop that stopped with pages still to read, remembered across the trip away to clear a
// check. Origin+path only, for the same reason the engine's own state guard uses that: a
// site rewrites its own query and hash, and a captcha in particular hands you back a URL
// with new parameters on it. Judged by exact URL, coming back would look like a different
// page and the offer would never reappear.
let unfinishedHop = null;
const hopKey = () => { try { const u = new URL(tab.url); return u.origin + u.pathname; } catch { return ''; } };

async function stopPointing() {
  if (!pointing || !tab?.id) return;
  pointing = false;
  try { await send({ type: 'POINT', tabId: tab.id, op: { action: 'stop' } }); } catch (_) {}
}

// Reading the pages after this one. Nothing navigates: the engine fetches each URL and
// reads it with the selectors that read this page, so the tab the user is looking at
// never moves. The sheet reports pages and rows as they land.
// `here` walks the tab the user is looking at instead of climbing the quiet ladder. It is one
// pass, it always renders, and it is the only one that can be paused and carried on — so it is
// also what a resumed walk comes back through, and none of the reporting below has to be
// duplicated to say so.
async function followPages({ from, dial = null, nextSelector, nextClick, here = false, withDetails = false } = {}) {
  if (!tab?.id) return;
  // What this page was shown last time. A pointed next-page control is remembered per
  // path shape, so /search?q=kopi and /search?q=teh share one answer — the control
  // belongs to the template, not to the query.
  if (!nextClick) {
    const mem = await send({ type: 'POINT_MEMORY', url: tab.url }).catch(() => null);
    nextClick = mem?.nextClick;
  }
  if (!nextSelector) {
    const mem = (await send({ type: 'POINT_MEMORY', url: tab.url }).catch(() => null))?.point;
    nextSelector = mem?.nextSelector;
  }
  // Named for what it DOES. Interleaved, this one pass turns the pages and reads each page's
  // records, so calling it "fetching the next pages" would under-report it by half.
  const doneGrow = liveGrow(withDetails ? 'Reading the list, page by page' : 'Fetching the next pages',
    'pages');
  stoppable = true;
  let out = null;
  // A site that has asked you to verify has said something specific, and the answer to it
  // is never "try the same thing a different way". Every later pass is skipped, and the
  // last use of this is AFTER the try/finally — which is why it is declared out here.
  // Inside the block it threw "walled is not defined" on the one path that matters.
  // `wall` is the here-walk saying which kind it met; `why` is how every other pass says it.
  const walled = (r) => !!r?.wall || /verification|^verify$|flagged this session/.test(r?.why || '');
  // ROWS WITHOUT THEIR PICTURES IS NOT A PASS THAT WORKED.
  //
  // This is the half the ladder could not see, and the reason a real hop on Alibaba returned
  // 434 rows across seven pages with every image column empty and called itself done. The
  // rows of a list page are in the HTML the server sends, so the cheapest pass finds all of
  // them; the pictures mount as the page is scrolled, and neither a fetched document nor an
  // unscrolled tab ever scrolls. "Rows carry the URLs of their own files" is the product — a
  // hop that brings only the left half of that has not finished, and the rung above it exists
  // precisely to supply real wheels.
  //
  // Judged by COMPARISON with the live page, never against a threshold. A directory of job
  // titles has no pictures anywhere and never did; demanding some would send that hop up every
  // rung for nothing. So: the page in front of the user has pictures in most of its rows, and
  // the hopped ones almost entirely lack them.
  //
  // Declared out here for the same reason `walled` is — the closing report reads it, and that
  // runs after the try/finally.
  const shortOfPictures = (r) => {
    const p = r?.pics;
    if (!p || !p.hoppedRows || !p.liveRows) return false;
    // Half the live rows or more carry a file — this is a list with pictures to bring.
    if (p.live * 2 < p.liveRows) return false;
    // And fewer than a quarter of the hopped ones do. A quarter rather than none, because the
    // first screen of every page does mount, so a real failure still arrives holding a
    // handful — and because one slow page in a long hop should not read as success.
    return p.hopped * 4 < p.hoppedRows;
  };
  try {
    // ONE PASS, and no ladder. Walking this tab renders, paints, mounts the pictures and
    // carries the session, so there is nothing for the quiet rungs to add — and skipping them
    // is most of why this is faster: they cost a 15s frame wait, a 20s fetch cap and a 12s
    // probe before the rung that works is even reached.
    if (here) {
      $('hq').textContent = 'Walking the pages here';
      out = await send({ type: 'HOP_HERE', tabId: tab.id, from, dial, nextSelector, nextClick,
        withDetails, home: deepOrigin })
        .catch(() => null);
    } else {
      out = await send({ type: 'ROWS', tabId: tab.id,
        op: { action: 'pagehop', from, nextSelector } }).catch(() => null);
    }
    // Fetching is the cheap way and it has one blind spot: a list the site builds in the
    // browser is not in the HTML the server sends, so the fetch reads a shell. When it
    // comes back with nothing, the same pages are opened in background tabs — which
    // render — and read there. Automatic, because "point at it again" was never going to
    // help: the link was right, the method was wrong.
    // Second try, and it costs nothing: a hidden tab still loads and runs the page's
    // scripts, so a list the site builds ON LOAD is there to be read even though nothing
    // appears on screen. No question is asked because nothing is taken — no window, no
    // focus, no tab you can see.
    // Nothing NEW is not the same as nothing WORKED, and reading them as one is what put
    // a "shall I drive the pages?" question in front of a list that had simply finished.
    // `sawRows` is the engine saying it reached the site and read pages there; a zero
    // beside it means the list is exhausted, which no heavier pass can improve on.
    //
    // The second clause is the new one: rows that arrived without their pictures. See
    // `shortOfPictures` above.
    const failed = (r) => r && !r.error && !walled(r)
      && ((!r.added && !r.sawRows) || shortOfPictures(r));
    // A pass that read the pages and lost their pictures leaves rows behind, and the next
    // pass is about to read the SAME pages properly. Those rows are dropped first so the
    // good reading replaces the poor one instead of sitting beside it — see `drophopped`.
    const rereading = async (r) => {
      if (!shortOfPictures(r)) return;
      await send({ type: 'ROWS', tabId: tab.id, op: { action: 'drophopped' } }).catch(() => null);
    };
    // Skipped outright when the pictures are what is missing. This rung's advantage over the
    // fetch is that it RENDERS, which is about rows; it still does not scroll, and scrolling
    // is what mounts a picture. Trying it anyway would read every page a third time at a site
    // that is already being asked for more than a person would ask for — and come back with
    // the same answer.
    if (!here && failed(out) && !shortOfPictures(out)) {
      // Named, because this is a second attempt after a failed first one and silence here
      // reads as a stall. It is also bounded: one page to prove the approach, then out.
      $('hq').textContent = 'Loading them out of sight';
      const quietly = await send({ type: 'HOP_TABS', tabId: tab.id, from, nextSelector })
        .catch(() => null);
      if (quietly && quietly.added) out = quietly;   // kept even if it was stopped
      else if (quietly?.stopped) out = { ...out, why: 'stopped', stopped: true };
      else if (walled(quietly)) out = { ...out, why: quietly.why };
    }
    // Third: drive the page rather than ask it. The debugger protocol gives a hidden tab a
    // desktop viewport, no throttling, and real wheel events — the three things a page
    // needs in order to build a list that only appears when scrolled. Still nothing on
    // screen, but Chrome marks the tab as being debugged, so it is asked for.
    if (!here && failed(out) && !out.stopped) {
      // Two different failures reach this rung, and telling someone the wrong one is worse
      // than saying nothing. "The pages came back empty" in front of a table that just grew
      // by four hundred rows reads as a tool that cannot see its own screen — and the actual
      // problem, that every one of those rows has an empty picture column, is the thing they
      // would otherwise have to notice for themselves in the export.
      const pictures = shortOfPictures(out);
      const p = out.pics || {};
      const drive = await ask({
        q: pictures ? 'The rows arrived without their pictures.'
          : 'This list only appears when the page is scrolled.',
        sub: pictures
          ? `${p.hopped ? `Only ${p.hopped} of the ${p.hoppedRows} rows` : `None of the ${p.hoppedRows} rows`} `
            + `read from the following pages carries an image, where ${p.live} of the ${p.liveRows} `
            + 'on this page do. A shop loads a picture when it scrolls into view, and none of '
            + 'those pages was ever shown to anyone — so the rows are there and their files are '
            + 'not. HoloScrape can drive the pages instead: a real desktop window size, real '
            + 'scrolling, and nothing on screen. The pages already read are read again, with '
            + 'their images this time.'
          : 'Loading the pages was not enough — their rows arrive as you scroll, and a '
            + 'page nobody is looking at is not being drawn, so nothing arrives. HoloScrape can '
            + 'drive the pages directly instead: a real desktop window size, real scrolling, '
            + 'and nothing shown on screen.',
        note: 'Chrome will say it is debugging the page while this runs. Nothing else changes.',
        actions: [
          { label: pictures ? 'Get the pictures' : 'Drive them', value: true, kind: 'go' },
          { label: 'Open a window instead', value: 'window' },
          { label: pictures ? 'Keep the rows as they are' : 'Leave it', value: false },
        ],
      });
      if (drive === undefined || drive === false) out = { ...out, declined: true };
      else if (drive === true) {
        $('hq').textContent = 'Driving the pages';
        await rereading(out);
        const dr = await send({ type: 'HOP_TABS', tabId: tab.id, from, nextSelector, driven: true })
          .catch(() => null);
        if (dr && dr.added) out = dr;
        else if (dr) out = { ...out, why: dr.why || out.why, tried: 'tabs', trail: dr.trail };
      }
    }
    // Fourth, and last: a window in front, walked the ordinary way. Kept because driving
    // needs a permission Chrome announces, and some people would rather watch it happen.
    if (!here && failed(out) && !out.stopped && !out.declined) {
      const pictures = shortOfPictures(out);
      const p = out.pics || {};
      const go = await ask({
        q: pictures ? 'A window is the last way to get the pictures.'
          : 'This site builds its list in the browser.',
        sub: pictures
          ? `The rows from the following pages are in hand — ${p.hoppedRows} of them — and `
            + `${p.hopped ? `only ${p.hopped} carry an image` : 'not one carries an image'}. `
            + 'A shop loads a picture as it scrolls into view, and scrolling needs painting, '
            + 'which Chrome does not do for anything it is not showing. HoloScrape can open a '
            + 'small window of its own, flip it back through those pages and close it; leave '
            + 'that window in front while it works.'
          : 'Two quiet ways were tried — fetching the pages, and loading them out of '
            + 'sight — and both came back empty, so this list only appears once the page is '
            + 'scrolled. Scrolling needs painting, and Chrome paints nothing it is not '
            + 'showing. HoloScrape can open a small window of its own, flip it through the '
            + 'pages and close it; leave that window in front while it works.',
        note: 'Your tabs are not touched, and the focus comes back when it is done.',
        actions: [
          { label: 'Open a window', value: true, kind: 'go' },
          { label: pictures ? 'Keep the rows as they are' : 'Leave it', value: false },
        ],
      });
      if (go !== true) { out = { ...out, why: out.why, declined: true }; }
      else {
        liveGrow('Reading in its own window', 'pages');
        await rereading(out);
        const via = await send({ type: 'HOP_TABS', tabId: tab.id, from, nextSelector, visible: true })
          .catch(() => null);
        if (via && via.added) out = via;
        else if (via) out = { ...out, why: via.why || out.why, tried: 'tabs' };
      }
    }
  } finally { stoppable = false; doneGrow(); paintDeep(); }
  if (out?.id) S.resultId = out.id;
  // Nothing gained is the case worth handling well, because the usual reason is that the
  // link was GUESSED wrong: the numbering heuristic picked a link that answers with no
  // list. The user can see the real control, so offer to be shown it rather than
  // reporting a failure and stopping.
  // Declining is an answer, not a failure. Reporting it as one would be telling the user
  // their own decision went wrong.
  // Not a failure, and not something to work around. The site is asking the person to
  // prove they are a person, which is a thing only the person can do — so the offer is to
  // put that page in front of them, and the hop resumes from there when they come back.
  if (walled(out)) {
    // THREE different situations wear one word, and answering them the same way is how a
    // correct message becomes a useless one.
    //
    //   flagged   the site is refusing the SESSION — "we detected an anomaly", no slider, no
    //             puzzle, nothing on the page to solve. Telling someone to go and clear a
    //             check they cannot see is worse than saying nothing. The only real answer is
    //             to stop, and to say plainly that trying again is what makes it worse.
    //   paused    a wall met while walking the user's OWN tab. The page is in front of them
    //             right now, so this is not a dead end, it is a pause: they clear it and the
    //             walk carries on from that page. No tab to open, nothing to find.
    //   cooling   the quiet passes met a wall somewhere the person cannot see, so the host is
    //             left alone for a quarter of an hour and they are offered the page.
    const mins = out.cooling ? Math.ceil(out.cooling / 60000) : 0;
    const flagged = out.wall === 'flagged';
    const paused = !!out.resumeFrom;
    const got = out.added ? `The <b>${out.added}</b> rows read so far are in the table. ` : '';
    const v = await ask({
      q: flagged ? 'The site flagged this session.'
        : paused ? 'The site wants a person. It is on screen now.'
        : mins ? 'Still holding off on this site.'
        : 'The site asked you to verify.',
      sub: flagged
        ? `${got}It is not asking you to solve anything — it is saying it does not trust this `
          + 'session, which usually means too much traffic from this browser or network too '
          + 'quickly. There is no check to clear. Nothing further has been requested from it. '
          + 'Leaving the site alone for a while is the only thing that helps; asking again now '
          + 'is what turns this into a longer block.'
        : paused
        ? `${got}The tab is sitting on the page it put up, so you can clear it yourself — the `
          + 'slider, the puzzle, whatever it wants. Nothing further has been requested and the '
          + 'tab has been left exactly where it stopped. Clear it and the walk carries on from '
          + 'that page; there is nothing to start over.'
        : mins
        ? `${got}It asked for verification a moment ago, so nothing has been requested from it `
          + `since — and nothing will be for about ${mins} more minute${mins === 1 ? '' : 's'}. `
          + 'Answering a check by trying again is what turns it into a block. Open the page, '
          + 'clear the check, and “Follow the pages” picks up where this stopped.'
        : `${got}It stopped serving pages and put up a check — a slider or a puzzle — which `
        + 'means it wants a person, not a scan. Nothing further was requested from it. '
        + 'Opening the page lets you clear the check; “Follow the pages” then picks up '
        + 'where this stopped rather than starting over.',
      note: flagged
        ? 'Reading is paced to stay under these. A session can still be flagged for traffic '
          + 'that was not ours.'
        : 'Reading is paced to stay under these, but a site may still ask.',
      actions: flagged
        ? [{ label: 'Open results', value: 'results', kind: 'go' }, { label: 'Done', value: false }]
        : paused
        ? [
          { label: 'I have cleared it — carry on', value: 'resume', kind: 'go' },
          { label: 'Open results', value: 'results' },
          { label: 'Stop here', value: false },
        ]
        : [
          { label: 'Open the page', value: 'open', kind: 'go' },
          { label: 'Open results', value: 'results' },
          { label: 'Leave it', value: false },
        ],
    });
    // Carrying on is the whole point of pausing rather than stopping: the walk resumes at the
    // page they just cleared, not at page one.
    if (v === 'resume') return followPages({ from: out.resumeFrom, nextSelector, here: true });
    if (v === 'open') {
      // Remembered BEFORE the tab switch, because the switch is what erases the sheet.
      // Opening the page is the panel's own instruction, and following it used to leave
      // the user on a page with no half-card, no way to resume, and a promise in the copy
      // that nothing on screen could keep.
      unfinishedHop = { key: hopKey(), pages: out.pages || 0, why: out.why || 'the site asked you to verify' };
      // The brake comes off the moment the person takes it on themselves. The cooling
      // period is there to stop US answering a challenge by trying again; leaving it in
      // place after they have gone to clear it turns our own offer into a dead end —
      // open the page, solve the slider, come back, be told to wait a quarter of an hour.
      await send({ type: 'WALL_CLEAR', url: tab.url }).catch(() => {});
      const nx = await send({ type: 'ROWS', tabId: tab.id, op: { action: 'nextpage' } })
        .catch(() => null);
      if (nx?.href) chrome.tabs.create({ url: nx.href, active: true });
    } else if (v === 'results') openResults();
    return;
  }
  if (out?.declined) {
    // Declining the PICTURES is not declining the pages: those were read and their rows are
    // in the table. Saying "not read" over a table that just grew is how a correct decision
    // comes to look like a failed one.
    const p = out.pics || {};
    await ask({
      q: 'Left as it is.',
      sub: shortOfPictures(out)
        ? `The <b>${out.added}</b> rows already read are in the table, without their images — `
          + `${p.hopped ? `${p.hopped} of ${p.hoppedRows} carry one` : 'none of them carries one'}. `
          + 'Ask again any time; the offer comes back with the next scan.'
        : 'The pages after this one were not read. Ask again any time — the offer comes '
          + 'back with the next scan.',
      actions: [{ label: 'Open results', value: 'open', kind: 'go' }, { label: 'Done', value: false }],
    }).then((v) => { if (v === 'open') openResults(); });
    return;
  }
  // WHERE THE RECORD PASS IS OFFERED AFTER A WALK — and it was offered nowhere at all.
  //
  // Every route into `openEachRow` sits inside `afterScan()`, and nothing calls `afterScan` when a
  // hop finishes. So on 2GIS the run ended here, one step short of the thing the provider exists
  // for: its records carry the EMAIL, and reading them is step two of two. The panel walked sixty
  // records and then offered "Open results" over a table with no contacts in it.
  //
  // Nothing about the pass itself was missing. `driveTwoGis` already builds its queue from the
  // SAVED TABLE rather than the page — written for exactly this case, because a click-walk leaves
  // the SPA holding the last twelve of ninety-three — and merges the records back by firm URL. The
  // worker was ready; only the offer was absent.
  //
  // GATED ON `reads === 'fetch'`, WHICH IS THE WORKER'S OWN TEST (`openDetails`), so the offer
  // appears exactly where it can work and nowhere else. Asking `mapkind` is safe on a page a walk
  // has just left: it reads `location`, not the detected list, so it answers even when the
  // container the walk started on is long gone.
  const kind = await send({ type: 'ROWS', tabId: tab.id, op: { action: 'mapkind' } })
    .catch(() => null);
  // ALREADY READ, IF THE WALK READ THEM. An interleaved walk reads each page's records before it
  // turns, so by the end there is nothing left to offer — and offering it anyway ("Read each
  // record · 180" over a table where all 180 already carry theirs) is the tool failing to know
  // what it just did. The engine cannot answer this: `progress.detailed` counts the page's own
  // bag and the fetch lane never writes there. The walk counted, so the walk says.
  const left = Math.max(0, (out?.added || 0) - (out?.detailed || 0));
  const canRecords = kind?.reads === 'fetch' && !out?.error && left > 0;
  // First in the list, so Enter takes it: on a two-step provider this is the step, not an extra.
  const recordAction = canRecords
    ? [{ label: `Read each record · ${left}`, value: 'detail', kind: 'go' }] : [];
  const andThen = (v) => {
    if (v === 'detail') return openEachRow({ tabId: tab.id });
    if (v === 'open') openResults();
  };

  // Read fine, and there was nothing left to read. Not a failure, and above all not
  // something to offer a fix for: telling someone to point at a better control when the
  // list has ended sends them looking for a problem that is not there.
  if (out && !out.error && !out.added && out.sawRows) {
    await ask({
      q: 'That is the whole list.',
      sub: `${esc(out.why)}. ${out.total > 1
        ? `${out.total} pages have been read in total, and the last one held nothing that `
          + 'was not already in the table.'
        : 'The pages after this one were read and held nothing new.'}`,
      actions: [{ label: 'Open results', value: 'open', kind: 'go' }, { label: 'Done', value: false }],
    }).then((v) => { if (v === 'open') openResults(); });
    return;
  }
  if (!out || out.error || !out.added) {
    const why = !out || out.error === 'NO_NEXT'
      ? 'Nothing on this page looked like a link to a next one.'
      : out.error ? 'The page could not be read.'
      : out.tried === 'tabs'
        ? `${esc(out.why)}. Both ways were tried: fetching the pages, and opening them in a `
          + 'window of its own so they could render.'
          + (out.trail?.length
            ? ` What each page held: ${out.trail.map((t) => `p${t.n} ${t.saw} rows`).join(', ')}.`
            : '')
      : `${esc(out.why)}. Either the link was not the one that turns the page, or the `
        + 'site builds its list in the browser rather than sending it.'
        + (out.trail?.length
          ? ` What each page held: ${out.trail.map((t) => `p${t.n} ${t.saw} rows`).join(', ')}.`
          : '');
    const v = await ask({
      q: out?.added === 0 && !out.error
        ? 'That link brought nothing back.' : 'Those pages could not be read.',
      sub: `${why} If you can see the control that goes to the next page, point at it `
        + 'once — it is remembered for pages like this one after that.',
      actions: [
        { label: 'Point at the next page', value: 'point', kind: 'go' },
        { label: 'Open results', value: 'open' },
        { label: 'Done', value: false },
      ],
    });
    if (v === 'point') return pointNextPage();
    if (v === 'open') openResults();
    return;
  }
  // THE SAME REPORT MAPS GETS, because the same work was done.
  //
  // An interleaved walk IS the chain: step one read the list, step two read every record, and it
  // finished both. Reporting that as "Stopped with 180 rows from 15 pages" with a button offering
  // to read the records describes a run that got half way — which is not what happened, and it
  // buries the step that took most of the time. `runSummary` is the card that states both steps
  // with their own figures, and it already exists.
  //
  // The ledger is filled in from the walk's own counts rather than from the engine, for the
  // reason above it: `progress.detailed` cannot see a fetch lane's writes.
  if ((out.detailed || 0) > 0) {
    const c = S.chain || chainStart();
    c.list = { rows: out.added || 0, pages: out.pages || 0 };
    c.details = { rows: out.added || 0, filled: out.detailed || 0, left,
      viaFetch: out.detailed || 0, viaTab: 0, lost: 0 };
    return runSummary({ stoppedAt: out.stopped ? (out.added || 0) : 0, detailed: out.detailed || 0 });
  }

  // A stop is not a failure and neither is a wall: what was read is in the table either
  // way, and saying so is the difference between "you stopped it" and "you lost it".
  await ask({
    q: out.stopped
      ? `Stopped with <b>${out.added}</b> rows from <b>${out.pages}</b> ${out.pages === 1 ? 'page' : 'pages'}.`
      : `<b>${out.added}</b> more rows from <b>${out.pages}</b> ${out.pages === 1 ? 'page' : 'pages'}.`,
    sub: `${out.stopped ? 'They are in the table already — each page was added as it '
      + 'arrived, so nothing read was lost' : esc(out.why)}. ` + (out.via === 'here'
      ? 'The pages were turned in this tab and each was read the way this page was — walked, '
        + 'so its pictures were loaded — and the tab has been put back where you left it.'
      // WHAT EACH PAGE GAVE, on screen. "Ten pages scanned, four pages in the table" took a
      // day to pin down because the sheet reported one number for the whole run: a page that
      // was read and then lost looked identical to a page that was never read. Per page, read
      // against kept, is the difference — and it is two lines of copy, not a log file.
      //
      // AND IT SAYS WHAT IT MEANS. `16 → 16` reads as "sixteen became sixteen" — as though the
      // page did nothing — when it is the HEALTHY case: sixteen rows read and all sixteen kept.
      // Reported verbatim as "why so many 16→16 on amazon, what is this?" about a run that had
      // worked perfectly. The arrow is the fault: a page that lost nothing must not read like a
      // page that gained nothing. So the common case says so in words, and only a page that
      // actually held repeats spends two numbers on the difference.
      + ((out.trail || []).length > 1
        ? ` Page by page: ${out.trail.map((t) => (t.fresh === t.saw
          ? `${t.saw} all new`
          : `${t.saw} read, ${t.fresh} new`)).join(' · ')}.`
          + (out.trail.some((t) => t.fresh !== t.saw)
            ? ' Where those differ, the rest were rows an earlier page already had.' : '')
        : '')
      : out.via === 'window'
      ? 'This site builds its list in the browser, so the pages were opened in a window '
        + 'of its own and closed again — your tabs were never touched.'
      : out.via === 'driven'
        ? 'The pages were loaded out of sight and scrolled directly, which is the only way '
          + 'a list that appears on scroll can be read without a window in front of you.'
      : out.via === 'hidden'
        ? 'This site builds its list in the browser, so the pages were loaded out of sight '
          + 'and read there. Nothing appeared on screen.'
      : out.via === 'frame'
        ? 'The pages were opened inside this one, the way the site opens anything it '
          + 'embeds — same tab, same session, nothing on screen and nothing to close.'
        : 'Nothing was opened in your browser — the pages were read where they stand.')
      // Every rung has been tried and the images still are not there. Said plainly, because
      // the alternative is a cheerful row count over a table whose picture column is empty —
      // which the person finds out about in the export, having already trusted this sheet.
      + (shortOfPictures(out)
        ? ` <b>Their images did not come with them:</b> ${out.pics.hopped
          ? `${out.pics.hopped} of ${out.pics.hoppedRows} rows carry one`
          : 'not one of those rows carries a picture'}, where ${out.pics.live} of `
          + `${out.pics.liveRows} on this page do. This site only loads a picture once it has `
          + 'been scrolled to, and every way of reading those pages without showing them has '
          + 'now been tried.'
        : '')
      // Said before the buttons, because a two-step provider that stops here has produced a table
      // with no contacts in it and the person has no way to know that from a row count.
      + (canRecords
        ? ` <b>The rows are the list's own cards.</b> Each record's page carries the phone number, `
          + 'the website and — on most of them — the email address, and none of that is on a list '
          + `card. Reading all <b>${out.added}</b> costs one fetch each and opens no tabs.`
        : ''),
    actions: recordAction.concat([
      { label: 'Open results', value: 'open', kind: canRecords ? '' : 'go' },
      { label: 'Done', value: false },
    ]),
  }).then(andThen);
}

// Being shown the next-page control, which is the one thing pointing used to refuse.
// It refused because pressing a link that navigates loses the list — but we never press
// it: we read its href and fetch it. So the control the overlay called unusable is
// precisely the one worth having.
async function pointNextPage() {
  if (pointing || !tab?.id) return;
  pointing = true;
  const pick = await send({ type: 'POINT', tabId: tab.id, op: { action: 'start' } })
    .catch(() => null);
  pointing = false;
  if (!pick || pick.error || pick.cancelled) return;
  // NO ADDRESS IS NOT A REFUSAL ANY MORE — it is the other way of turning a page.
  //
  // This used to say "pagers built entirely in JavaScript cannot be followed this way", which was
  // true when it was written: the only way to reach a next page was to FETCH its URL. Clicking
  // arrived later, for 2GIS, and was left gated behind a provider declaring `grows: 'pager-click'`
  // — so an unknown site with a button pager was told no while the engine sitting behind the panel
  // could press it perfectly well. A click needs no address at all.
  //
  // The pointed control is remembered as a CLICK target rather than a URL, and the walk presses it.
  if (!pick.url) {
    if (!pick.selector) {
      const again = await ask({
        q: 'Could not get a handle on that.',
        sub: 'The control could not be identified well enough to press again on the next page. '
          + 'Pointing at the page NUMBER, or at the “next” arrow itself, usually works better than '
          + 'the icon inside it.',
        actions: [{ label: 'Point at another', value: true, kind: 'go' },
          { label: 'Leave it', value: false }],
      });
      if (again) return pointNextPage();
      return;
    }
    await send({ type: 'POINT_MEMORY', url: tab.url,
      save: { nextClick: pick.selector, nextLabel: pick.label } }).catch(() => {});
    return followPages({ nextClick: pick.selector, here: true });
  }
  // Remembered before it is used: if the fetch disappoints, the answer is still recorded
  // and the next visit does not ask again.
  await send({ type: 'POINT_MEMORY', url: tab.url,
    save: { nextSelector: pick.selector, nextLabel: pick.label } }).catch(() => {});
  return followPages({ from: pick.url, nextSelector: pick.selector, here: true });
}

async function startPointing() {
  if (pointing || !tab?.id) return;
  pointing = true;
  const pick = await send({ type: 'POINT', tabId: tab.id, op: { action: 'start' } })
    .catch(() => null);
  pointing = false;
  if (!pick || pick.error || pick.cancelled) return;

  const name = pick.iconOnly ? `${pick.tag}, no text` : `${pick.tag} · “${esc(pick.label)}”`;

  // A control that navigates is not a load-more, and pressing it would lose the list.
  // It is usually the next page — which is a real way to get the rest of the list, just
  // a different one. Offer that instead of a dead end.
  if (pick.navigates) {
    const go = await ask({
      q: 'That one turns the page.',
      sub: `${name} opens <b>${esc(pick.href)}</b> — a whole page of its own, not more of `
        + 'this one. HoloScrape can read the following pages without leaving this one.',
      actions: [
        { label: 'Follow the pages', value: 'hop', kind: 'go' },
        { label: 'Point at another', value: true },
        { label: 'Leave it', value: false },
      ],
    });
    // Its OWN href, not a fresh guess: the user just pointed at this control, and the
    // whole reason they were pointing is that guessing had failed them.
    if (go === 'hop') {
      await send({ type: 'POINT_MEMORY', url: tab.url,
        save: { nextSelector: pick.selector, nextLabel: pick.label } }).catch(() => {});
      return followPages({ from: pick.url || undefined, nextSelector: pick.selector, here: true });
    }
    if (go === true) await startPointing();
    return;   // undefined falls through here too: no answer, no action
  }

  // A pick is a hypothesis. Press it once and read the count — enabling something and
  // leaving the user to find out whether it worked is the part usually missing.
  let before = 0, after = 0, wasAt = tab.url, nowAt = tab.url, press = null;
  try {
    const p0 = await send({ type: 'ROWS', tabId: tab.id, op: { action: 'progress' } });
    before = p0?.rows || 0;
    wasAt = p0?.href || tab.url;
    press = await send({ type: 'ROWS', tabId: tab.id,
      op: { action: 'scroll', moreSelector: pick.selector } });
    // A router moving with pushState (or a load-more's rows settling in) has not
    // necessarily committed by the time the press returns, and checking the page's own
    // location/row-count exactly once used to report "nothing happened" about a page that
    // was still mid-turn. Measured live on blibli.com: the pager's router genuinely does
    // move the URL (to `?page=2&...`), but not reliably inside one fixed 700ms beat — so a
    // single check could still miss a press that worked. Polled instead, the same "ask
    // again rather than guess a bigger fixed delay" fix already applied to `contentChanged`
    // inside `scrollStep`, and on the same ~2s budget this exact site is already measured
    // to need.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const p1 = await send({ type: 'ROWS', tabId: tab.id, op: { action: 'progress' } });
      after = p1?.rows || 0;
      nowAt = p1?.href || nowAt;
      if (nowAt !== wasAt || after > before) break;
    }
  } catch (_) {}

  // Some pagers are a real <button> with a router behind them, and NOTHING in the DOM
  // says so — no href to read, on the element or above it. Pressing is the only
  // measurement available, so read its result: if the tab moved, the question the press
  // was asking has been answered, and the answer is "pager", not "nothing arrived".
  //
  // Saying "nothing arrived" here was the worst outcome available. The press had just
  // turned the page — the one thing it is most useful to know — and the panel offered
  // to point at something else instead.
  const movedTo = nowAt && nowAt !== wasAt ? nowAt : '';
  if (movedTo) {
    let where = movedTo;
    try { const u = new URL(movedTo); where = u.pathname + u.search; } catch (_) {}
    const go = await ask({
      q: 'That one turns the page.',
      sub: `Pressing it moved this tab to <b>${esc(where.slice(0, 90))}</b>. It is a pager, `
        + 'not a load-more, so the rest of the list lives on the pages after this one. '
        + 'HoloScrape can read them by fetching, without moving the tab again.',
      actions: [
        { label: 'Follow the pages', value: 'hop', kind: 'go' },
        { label: 'Leave it', value: false },
      ],
    });
    // Remembered against the page it was pointed at, not the one we landed on.
    if (go === 'hop') {
      await send({ type: 'POINT_MEMORY', url: wasAt,
        save: { nextSelector: pick.selector, nextLabel: pick.label } }).catch(() => {});
      return followPages({ from: movedTo, nextSelector: pick.selector, here: true });
    }
    return;
  }

  if (after > before) {
    await send({ type: 'POINT_MEMORY', url: tab.url,
      save: { press: true, selector: pick.selector, label: pick.label } });
    const go = await ask({
      q: `That was it — <b>${before} → ${after}</b> rows.`,
      sub: 'Remembered for this page. Later scans press it without asking.',
      actions: [
        { label: 'Keep going', value: true, kind: 'go' },
        { label: 'Done', value: false },
      ],
    });
    if (go) await run({ peek: true, press: true });
    return;
  }

  // A FOURTH SHAPE, and the one that used to be told as "I lost track of that control" even
  // when the press worked exactly as asked. A JS-driven pager REPLACES the rows rather than
  // growing them (so `after > before` is false) and the address bar never moves (so `movedTo`
  // is empty) — and replacing the rows is also what makes the pointed selector stop resolving,
  // since the element it named is gone. Both of the signals above read that as failure. The
  // page itself disagrees: `contentChanged` is the same fingerprint check `hopHere`'s automated
  // walk already trusts, and it is the only one of the four that actually asked the list.
  if (press?.contentChanged) {
    const go = await ask({
      q: 'That one turns the page.',
      sub: 'Pressing it changed what is on screen, even though the address did not move — a '
        + 'pager built in JavaScript, not a load-more. HoloScrape can read the following pages '
        + 'by pressing it again, without you pointing a second time.',
      actions: [
        { label: 'Follow the pages', value: 'hop', kind: 'go' },
        { label: 'Leave it', value: false },
      ],
    });
    if (go === 'hop') {
      await send({ type: 'POINT_MEMORY', url: wasAt,
        save: { nextClick: pick.selector, nextLabel: pick.label } }).catch(() => {});
      return followPages({ nextClick: pick.selector, here: true });
    }
    return;
  }

  // THREE outcomes, not one. "Pressed it, and nothing arrived" was told for all of them,
  // including the case where the control was never pressed at all — findLoadMore falls
  // through to the automatic finder when a pointed selector stops matching, and that
  // finder refuses pagers by design, so the honest answer is "I lost the control", and
  // "point at another" is useless advice for it.
  const lost = press && press.pointedStill === false;
  const notPressed = !lost && press && !press.clicked;
  const again = await ask({
    q: lost ? 'I lost track of that control.'
      : notPressed ? 'I found it, but could not press it.'
      : 'Pressed it, and nothing arrived.',
    sub: lost
      ? 'It was there when you pointed, and it no longer matches — sites rebuild their '
        + `controls as the list changes. Still <b>${before}</b> rows. Pointing at it again `
        + 'picks up the new one.'
      : notPressed
        ? `The control is still on the page but the press did not go through. Still `
          + `<b>${before}</b> rows.`
        : `Still <b>${before}</b> rows, and the page did not move. Either that is not the `
          + 'control, or the list has ended.',
    actions: [
      { label: 'Point at another', value: true, kind: 'go' },
      { label: 'It has ended', value: false },
    ],
  });
  if (again === undefined) return;
  if (again) await startPointing();
  else await send({ type: 'POINT_MEMORY', url: tab.url, save: { press: false } });
}

// --- keyboard ---------------------------------------------------------------
// One map, so every shortcut is visible in one place and none of them can quietly
// disagree with what a button does. Bound on the panel document only: a side panel is a
// document of its own, and a global page hook would fight the site's own shortcuts.
//
// Escape is deliberately overloaded and strictly ordered — pointing, then a running
// scan, then the sheet. It always means "back out of the thing that is happening", and
// the order is what makes that unambiguous.
const KEYS = [
  { key: 'Escape', when: () => pointing, run: () => stopPointing(), why: 'stop pointing' },
  { key: 'Escape', when: () => busy, run: () => stopScan(), why: 'stop the scan' },
  { key: 'd', when: () => !stoppable && scannable, run: () => run({ peek: true }), why: 'deep scan' },
  { key: 's', when: () => !stoppable && scannable, run: () => run({ peek: true, press: false }),
    why: 'scan without pressing anything' },
  { key: 'p', when: () => !busy && !pointing, run: () => startPointing(), why: 'point at the button' },
  // Saved to Downloads/HoloScrape/holoscrape-log-<time>.txt. One file per run, stamped, never
  // overwritten: the old fixed name was rewritten by the passive poll every couple of
  // seconds, so the run anyone wanted to read was destroyed before they could open it.
  // It also writes itself at the end of every hop; this is for the runs that never get
  // there — a hop still going, or one that ended somewhere the code did not expect.
  { key: 'l', when: () => true, why: 'save the log',
    run: async () => {
      const r = await send({ type: 'SAVE_LOG' }).catch(() => null);
      $('caption').textContent = r?.lines
        ? `Log saved — ${r.lines} lines in ${r.name || 'Downloads/HoloScrape'}`
        : (r?.skipped || 'Nothing to log yet.');
    } },
  { key: 'o', when: () => !!S.resultId, run: () => openResults(), why: 'open results' },
  // BOTH open the drawer first — `goScreen` alone leaves its target `.screen` visible (it
  // overrides `visibility` on itself) while `.drawer`, its own parent, stays visually closed:
  // a floating, backdrop-less layer that still sits at z-index:30 over the whole panel and
  // still takes every click meant for what's under it. Same bug the untested-site card hit
  // going through `goScreen` alone; fixed there the same way.
  // BOTH open the drawer first — `goScreen` alone leaves its target `.screen` visible (it
  // overrides `visibility` on itself) while `.drawer`, its own parent, stays visually closed:
  // a floating, backdrop-less layer that still sits at z-index:30 over the whole panel and
  // still takes every click meant for what's under it. Same bug the untested-site card hit
  // going through `goScreen` alone; fixed there the same way.
  { key: 'h', when: () => true, run: () => { toggleDrawer(true); goScreen('scHist'); }, why: 'history' },
  { key: ',', when: () => true, run: () => { toggleDrawer(true); goScreen('scSettings'); }, why: 'settings' },
  { key: '/', when: () => true, run: () => toggleDrawer(true), why: 'menu' },
];

function wireKeys() {
  addEventListener('keydown', (e) => {
    // Never steal a keystroke from something being typed into.
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const hit = KEYS.find((k) => k.key.toLowerCase() === e.key.toLowerCase() && k.when());
    if (!hit) return;
    e.preventDefault();
    hit.run();
  });
}

function setEstimate(cov, delayMs, wasDeep) {
  const t = cov?.triggers || 0;
  estimate = { triggers: wasDeep ? 0 : t, seconds: Math.max(1, Math.round((t * delayMs) / 1000) + 1) };
  paintDeep();
}

function paintDeep() {
  const b = $('deep').querySelector('.lbl b');
  const s = $('deep').querySelector('.lbl span');
  if (busy) return;
  // `stopScan` disables this button so one press cannot become two — a second press would
  // re-send STOP, and the row phase the first press deliberately allows to finish would be
  // killed by it. Re-enabled here rather than in the stop path, because "the run is over" is
  // exactly what `paintDeep` is called to say, on every path that ends one; the `busy` guard
  // above means a repaint mid-run cannot undo the disable early.
  $('deep').disabled = false;
  $('deep').classList.toggle('armed', estimate.triggers > 0 && !busy);
  // "Up to 180 more" is a promise about a page nobody has scanned yet: it counts the
  // media triggers standing on the page and says what opening them could add. Once a
  // deep scan HAS run, the same sentence is a lie in two directions — those triggers
  // were already opened, and the count says nothing about what a second pass would find.
  // After a scan the button stops estimating and says what pressing it does instead.
  if (deepDone) {
    b.textContent = 'Scan again';
    s.textContent = 'Looks for anything the page has added since.';
    $('deep').disabled = false;
  } else if (estimate.triggers > 0) {
    b.textContent = `Deep scan · up to ${estimate.triggers} more`;
    s.textContent = `About ${estimate.seconds}s. Nothing plays, nothing downloads.`;
    $('deep').disabled = false;
  } else {
    b.textContent = 'Deep scan';
    s.textContent = "Nothing left to open here — or run it anyway.";
  }
}



// What one item detail costs, MEASURED rather than hoped for — and this number has now been wrong in
// both directions, which is why it carries its history:
//
//   2s   guessed. A full Maps list was sold as four minutes and took ten.
//   5s   measured on the SEQUENTIAL pass: 123 records, 09:26:48 to 09:36:39, 591s, 4.8s each.
//   2s   measured on the FIVE-LANE pass: 124 records in 2m31s, 1.22s each.
//
// The 5 outlived the pass it was measured on. Records are opened five at a time now, so the card was
// quoting ten minutes for a job that takes two and a half — and over-reading is not the harmless
// direction either: it talks people out of pressing the button at all.
//
// 2 rather than the measured 1.22, deliberately. That run walked each panel too briefly (see the
// `grew` note in rows.js), so a corrected walk costs more per record than it did, by an amount nobody
// has measured yet. Round up until someone has.
// HOW MANY TABS TO WARN ABOUT. A deliberate duplicate of `LANES` in background.js — the panel
// cannot import from the worker — and the number in the sentence has to be the number that opens.
// If `LANES` changes, change this. See the shared-rule note in HANDOVER.
const LANES_SHOWN = 5;
const DETAIL_SECS = 2;

// --- scanning ---------------------------------------------------------------


// THE PRESS IS ACKNOWLEDGED BEFORE ANYTHING IS AWAITED.
//
// A click used to reach `run`, find `busy` held by the panel's own 2.5-second poll, wait
// four seconds for it, and then `return` — no scan, no label change, no explanation. The
// button looked broken because from the outside it was: the one thing a pressed button
// must always do is look pressed. So the label moves here, synchronously, in the handler,
// where nothing can come between the click and the feedback.
//
// `pressWaiting` is the other half. The poll is a guess and the press is an instruction,
// so the guess gets out of the way instead of being outwaited — it abandons itself at its
// next checkpoint rather than finishing a walk nobody is waiting for any more.
// WHERE THE PERSON WAS STANDING WHEN THEY PRESSED DEEP SCAN.
//
// The walk restores the tab to wherever IT started, which used to be the same thing and is not
// any more. Feeding the page addresses asks the person to go to page 2 (and 3) and copy the
// address bar each time — so by the time the walk begins, the tab is three pages deep and that
// is the address it faithfully returns to. Pressing Stop then leaves someone on page 3 of a list
// they opened at page 1, which reads as the tool having lost their place.
//
// Recorded at the press, before any card, and handed to the walk as `home`. Cleared when the run
// ends so a later walk that nobody deep-scanned restores to its own start as before.
let deepOrigin = '';

// WAIT FOR THE POLL, ON THE BUTTON, AND SAY SO. Returns false when it is still held after
// fifteen seconds — a stuck poll, not a busy one — and the button then says "press again"
// rather than swallowing the press. Shared by every path that turns a person's press into a
// scan, because the drop happened on BOTH of them: `pressDeep` waited here before the card, and
// then `run()` behind the card threw the answer away — see the note in `run`.
async function waitForPoll() {
  if (!busy) return true;
  pressWaiting = true;
  $('deep').querySelector('.lbl b').textContent = 'Starting…';
  $('deep').querySelector('.lbl span').textContent = 'Finishing a background read first.';
  const until = Date.now() + 15000;
  while (busy && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  pressWaiting = false;
  // Fifteen seconds and still held is a stuck poll, not a busy one. Say so — the old
  // code returned here, which is precisely how a press became nothing at all.
  if (busy) {
    $('deep').querySelector('.lbl b').textContent = 'Deep scan';
    $('deep').querySelector('.lbl span').textContent = 'The page is still busy — press again.';
    return false;
  }
  return true;
}

async function pressDeep() {
  if (!(await waitForPoll())) return;
  // TWO WAYS TO READ A LIST, AND THE PERSON PICKS BEFORE ANY TIME IS SPENT.
  //
  // Everything this panel does to find more rows is a guess about the page: scroll and watch,
  // hunt for a load-more by its wording, look for an anchor carrying the next page number. Each
  // guess has a shape it cannot see — a pager built from buttons carries no address, a dial in
  // the url FRAGMENT is read by nothing, and a site that rebuilds its controls loses a pointed
  // selector on the first press. Measured today on mail.google.com: the press worked, the page
  // turned, and the panel reported "I lost track of that control".
  //
  // The addresses are the one thing that never lies, and the person can always produce them:
  // they click the pager themselves and copy the bar twice. `dialFromPair` then DERIVES the dial
  // rather than guessing it — on amazon, where page one carries no page parameter at all, that
  // is the only method that can work.
  //
  // Asked once per press and not remembered, because the honest default depends on the page and
  // the person is the only one who knows whether this list has more behind it.
  // ASKED ONLY WHERE THE ANSWER MATTERS. A page with no list has nothing to page through, and a
  // question about pagination on it is noise in front of the one button this panel has. Measured
  // cost of getting this wrong: `test/extension.mjs` presses Deep scan and asserts "a press
  // starts a scan" — a card in front of every press turns that into a hang, and it would do the
  // same to a person on every ordinary page.
  // READ THE SHAPE THE ENGINE ACTUALLY SENDS. The first version of this asked for
  // `cands[i].rows.length` — the engine's own internal shape, where `rows` is an array of DOM
  // ELEMENTS. Nothing of the sort arrives here: a message from the page is structured-cloned, so
  // elements cannot cross at all, and what does arrive is `tables[]` with `rows` as a COUNT.
  // The gate therefore read undefined on every page, scored zero, and the card never appeared —
  // measured on an amazon search with fifty products on screen.
  //
  // The widest list on the page, not the chosen one: this is only deciding whether the question
  // is worth asking, and a page with any real list is a page worth asking about.
  deepOrigin = tab?.url || '';
  // A new deep scan is a new measurement: a stretch that stalled last time says nothing now.
  lastStretch = { key: '', rows: -1 };
  // AND THEIR SCROLL POSITION, for the same reason and at the same instant. The card that
  // follows can sit on screen for seconds while the passive poll keeps reading behind it, and a
  // poll's read scrolls the page — so the scan's own sample is no longer the person's place.
  await send({ type: 'PIN_SCROLL', tabId: tab.id }).catch(() => {});
  const seenList = await send({ type: 'ROWS', tabId: tab.id, op: { action: 'detect' } })
    .catch(() => null);
  const tables = (seenList && !seenList.error && seenList.tables) || [];
  const rowsHere = tables.reduce((m, t) => Math.max(m, Number(t.rows) || 0), 0);
  // EVERY EXIT CLEARS IT. A stale origin is worse than none: press Deep scan on page 1, walk
  // away, then follow the pages from an ordinary scan on some other list, and the tab would be
  // returned to a page nobody asked about. `try/finally` around the whole body rather than a
  // clear beside each `return`, because there are five ways out of here and one of them is a
  // retracted card.
  try {
    await deepBody(rowsHere);
  } finally {
    deepOrigin = '';
    // Backing out of the card must not leave a pin behind for whatever runs next. A pin the scan
    // consumed is already gone, so this only ever clears one nobody used.
    if (tab?.id) send({ type: 'PIN_SCROLL', tabId: tab.id, clear: true }).catch(() => {});
  }
}

// THE LAST STRETCH THE LOAD-MORE CARD RAN, so the next round can tell whether it did anything.
// Keyed by the control that was pressed; reset when a scan starts.
let lastStretch = { key: '', rows: -1 };

async function deepBody(rowsHere) {
  if (rowsHere < 5) return run({ peek: true });

  // A PAGER WITH NO ADDRESS CANNOT BE SERVED BY THE ADDRESS CARD, so it is not shown one.
  //
  // The card below learns the page numbering from two addresses the person pastes. On Gmail the
  // address is `#inbox` on every page — measured with the tab standing on "101–150 of 8,614" —
  // so both boxes hold the same string and the only possible answer is "I could not read a page
  // number out of those", which is what the person got. A descriptor that declares
  // `grows: 'pager-click'` and names the control has already answered the question the card
  // asks; the engine confirms the control is on the page, and the walk starts. Stop is on screen
  // throughout and every page is committed as it lands, which is what makes starting without
  // asking safe rather than merely quick. Nothing changes for a site whose pager carries an href.
  const traits = await freshTraits().catch(() => null);
  if (traits?.grows === 'pager-click') {
    const nx = await send({ type: 'ROWS', tabId: tab.id, op: { action: 'nextpage' } }).catch(() => null);
    if (nx && !nx.error && !nx.none && nx.click && !nx.href) {
      // STANDING PAST THE FIRST PAGE IS SAID, NOT HIDDEN. The walk reads from where the tab is;
      // with no address to drive back to, the pages behind cannot be fetched for the person, so
      // they are told which ones would be skipped and can go back themselves first.
      if ((nx.from || 1) > 1 && !autoFollowOn()) {
        const go = await ask({
          q: `You are on page <b>${nx.from}</b> of this list.`,
          sub: `I can read every page from here on, but pages 1–${nx.from - 1} are behind you and `
            + 'this site gives them no address I could open. To have them too, go back to the first '
            + 'page yourself and press Deep scan again.',
          actions: [
            { label: `Read from page ${nx.from}`, value: 'hop', kind: 'go' },
            { label: 'Cancel', value: false },
          ],
        });
        if (go !== 'hop') return;
      }
      return followPages({ here: true, withDetails: traits.reads === 'fetch' });
    }
  }

  // ONE CARD, ONE DECISION. This used to be two: pick "give it the page addresses", then a
  // second card appears asking for them. That made the better option feel like a detour —
  // you had to commit to it before you could see what it wanted — and it put the explanation
  // of the WEAKER option (a note about load-more buttons and rebuilt lists) in the reader's
  // way before either choice was legible.
  //
  // The boxes are simply there. Filling them and pressing "Read every page" is the whole
  // interaction; leaving them empty and pressing "Quick scan" is the other. Nothing has to be
  // chosen before the thing being chosen is visible.
  // AND IT COMES BACK IF THE ADDRESSES DID NOT READ. Dead-ending on "I need two addresses"
  // meant pressing Deep scan again and retyping — a punishment for the option we WANT people
  // to take. The card returns with what was typed still in it. "Quick scan" (and Escape, which
  // takes the last action) is the way out, so this cannot trap anyone.
  let typed = ['', '', ''];
  // THE POLL STANDS ASIDE WHILE THE CARD IS OPEN — see `watch`. Cleared on every way out.
  pressWaiting = true;
  try {
  for (;;) {
  const how = await ask({
    // ASK THE QUESTION THE BUTTONS ANSWER. "How far should this scan go?" invites "I don't
    // know — just scan": it asks for a judgement about depth that nobody has any basis to
    // make, when the actual decision is a plain either/or that the two buttons already state.
    // The heading is now that same either/or, and each half of the body belongs to one button.
    q: 'Read the whole list, or just this page?',
    sub: '<b>The whole list</b> — open page 2 in your browser and paste its address below. '
      + 'I work out how the pages are numbered from it and read every page, in order, from '
      + 'the first. A third address makes that reading surer.'
      + '<br><br><b>Just this page</b> — needs nothing from you. It scrolls, and presses a '
      + 'load-more if it finds one, but it cannot follow a numbered pager.',
    field: {
      slots: [
        // PAGE ONE IS THE TAB YOU ARE STANDING ON. Asking someone to fetch an address they are
        // already looking at is busywork, and leaving the first box empty made the whole card
        // look like it wanted three things when it wants one.
        { label: 'Page 1', placeholder: 'https://…', value: typed[0] || tab?.url || '' },
        { label: 'Page 2', placeholder: 'paste page 2 here', value: typed[1] },
        { label: 'Page 3', placeholder: 'optional — makes the reading surer',
          optional: true, value: typed[2] },
      ],
    },
    actions: [
      { label: 'Read every page', value: 'urls', kind: 'go' },
      { label: 'Quick scan', value: 'fast' },
    ],
  });
    if (how === undefined) return;           // the sheet was retracted — do nothing
    if (how?.value !== 'urls') break;        // quick scan, or Escape
    typed = [0, 1, 2].map((i) => how.values?.[i] || '');
    const dial = await learnDial(how.text);
    if (!dial) continue;
    // THE WHOLE POINT, FINALLY SPENT. `run({peek:true})` here was an ordinary scan of this one
    // page — the dial was learned, shown, saved, and then ignored, so "Read every page" looked
    // like a button that did nothing. Drive the walk from page one with the dial in hand.
    pressWaiting = false;
    return followPages({ here: true, from: dial.first || '', dial });
  }
  } finally { pressWaiting = false; }
  await run({ peek: true });
}

async function run({ peek, silent = false, quiet = false, press }) {
  // Undefined means "ask, or use what this page answered last time". There is no
  // switch to read: the choice is made where it matters, once per page.
  S.pressThisRun = press;
  let askAfter = false;
  // A deep scan is the user asking; the passive poll is the panel guessing. The ask wins,
  // and it still waits rather than racing the guess into the same page — two walkers on one
  // scrollbar is the collision this flag exists to prevent. But the waiting now happens in
  // `pressDeep`, before this call, where it can be shown on the button and where running
  // out of patience produces a sentence instead of silence.
  //
  // AND IT WAITS AGAIN HERE, FOR THE PRESS THAT COMES AFTER THE CARD. `pressDeep` waited for the
  // poll, showed "Read the whole list, or just this page?", and the card then sat open for as long
  // as the person took — during which the poll ticked every 2.5s and set `busy` again. "Quick
  // scan" landed on `if (busy) return` and nothing happened; a second Deep scan press, answered
  // faster, worked. Reported as "quick scan not triggered anything, had to press twice". A person's
  // press is an instruction and is never dropped: it waits, on the button, exactly as the first
  // press does. The poll is a guess and returns as before.
  if (busy) {
    if (!peek || !(await waitForPoll())) return;
  }
  busy = true;
  const d = SCAN;
  if (!quiet) {
    $('sound').classList.add('live');
  }
  if (peek) {
    S.stopped = false;
    stoppable = true;
    deepDone = false;   // a scan in progress is not a scan that has run
    // ASKED AGAIN FOR THIS PAGE. The marker is a claim about the page in front of us — "this is
    // one of three steps" — and carrying yesterday's answer to a different tab would put a step
    // count over a shop that has no steps, and hold its sheet open waiting for a pass that is
    // never coming.
    S.sawChainable = false;
    S.chainMap = '';
    S.chainTraits = { steps: 3, grows: '', reads: '' };
    S.chain = null;
    S.deepT0 = Date.now();
    // AND THE LAST WALK'S FIGURES, for the same reason and with the same argument. `lastHop` holds
    // the final reading of a walk so the card does not fall to "0 rows · 0 pages" on the tick after
    // it ends — a high-water mark of a run that is ending. It was dropped only where `liveTimer`
    // was absent, which is not the same as "a new run": a card still open from the last walk keeps
    // the timer, so a search for one thing carried the previous search's numbers, with no summary
    // and nothing offered to open. Reported as "the result still on android, never become macbook".
    S.lastHop = null;
    S.lastHopPages = 0;
    // Clear the page's stop flag exactly once, here, at the start of the whole scan —
    // and AWAITED, because the flag lives on the page and outlives everything else in
    // this extension. Left unawaited, the clear raced the walk that follows it: a page
    // stopped once could greet the next scan still flagged, abort in its first step,
    // and look dead. Reinstalling the extension does not help, because reinstalling
    // does not touch the page's own JS context — only reloading the tab does. So this
    // is the one instruction that must land before any walking starts.
    closeHalf();
    liveGrow('Reading the page', 'media');
    if (tab?.id) {
      await send({ type: 'ROWS', tabId: tab.id, op: { action: 'clearstop' } }).catch(() => {});
    }
    $('deep').querySelector('.lbl b').textContent = 'Stop';
    $('deep').querySelector('.lbl span').textContent = 'Scanning — everything found is kept.';
  } else if (!silent) $('caption').textContent = 'Reading this page…';

  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = await send({
      type: 'SCAN',
      tabId: t.id,
      opts: {
        peek,
        clickDownloads: $('clickDownloads').checked,
        // A GUESS DOES NOT MOVE SOMEBODY ELSE'S PAGE. The passive poll ran the same
        // auto-scrolling walk as a deep scan, every 2.5 seconds — which is why the button
        // went dead for seconds at a time on a heavy list, and why the page would creep
        // downward on its own while being read. Scrolling is something the user asks for.
        autoScroll: peek && $('autoScroll').checked,
        maxClicks: d.max, delayMs: d.delay, maxScrollSteps: d.scroll, scrollPauseMs: d.pause,
        // Zero presses rather than a separate flag: the asset walk's budget already
        // expresses "how many times may this press", and none is a valid answer.
        dryScreens: d.dry, maxMoreClicks: S.pressThisRun ? d.presses : 0,
        // A row pass follows a deep scan and continues the same descent, so the
        // asset walk does not spring back first — one trip down, one trip back.
        keepScroll: peek,
      },
    });

    // The worker refuses a scan on a page it is already walking. Nothing to report:
    // a skipped poll is not a failure, and the walk in progress will save more than
    // this poll could have.
    if (res.error === 'WALKING') return;
    if (res.error === 'RESTRICTED') { await sync({ rescan: false }); return; }
    if (res.error === 'NO_ACCESS') { await sync({ rescan: false }); return; }
    if (res.error) throw new Error(res.error);

    // ASKED ABOUT `t`, and `t` can now be history. A deep scan's row phase runs for as long as
    // the page takes — up to a minute, per the note on `readTables` below — long enough for the
    // person to navigate to an entirely different site before this resolves. Without this check
    // the stale answer still lands on whatever the panel is showing NOW: a scan started on 2GIS,
    // landing on allbirds.com as "26" and a caption that belongs to the page the person left. The
    // global `tab` is what `sync` keeps current on every navigation; `t` is only ever what this
    // particular call was asked about.
    if (tab?.id !== t.id || !sameSite(tab?.url, t.url)) return;

    // A press has arrived. The poll's remaining work — reading tables, redrawing the list,
    // reloading history — is worth nothing to a scan that is about to redo all of it, and
    // every step of it is time the user spends looking at a button that has not started.
    if (!peek && pressWaiting) return;

    S.resultId = res.id || null;
    S.resultsUrl = res.url || t.url || null;
    show(res.items || [], res.coverage, peek);
    setEstimate(res.coverage, d.delay, peek);
    // AN ANSWER THAT IS MISSING ITS OTHER HALF HAS TO SAY SO, ON SCREEN.
    //
    // A scan reads the rendered page AND watches what the page fetches. The second half needs a
    // debugger session, and Chrome allows one per tab — so with DevTools open it is skipped and the
    // count silently drops to whatever happened to be mounted. Measured on a long thread: 22 files
    // instead of 114, with nothing anywhere saying why. The reason was computed and thrown away.
    // A number that is a fraction of the truth, presented as the truth, is the failure this project
    // keeps paying for; the remedy is one sentence and it belongs where the number is.
    $('log').textContent = [(res.netWhy ? '⚠ ' + res.netWhy : ''), (res.log || []).join('\n')]
      .filter(Boolean).join('\n\n');
    // Same pass, no extra button: detection is six milliseconds and the panel is
    // already here reading the page.
    await readTables();
    if (!peek && pressWaiting) return;
    loadHistory();
    // AWAITED. Left unawaited, run() fell through to its `finally`, cleared `busy`
    // and stopped the animation while the row phase was still walking the page for
    // up to another minute — and clearing `busy` is what gates the 2.5-second
    // passive poll. So the poll started injecting the asset walk into a page the row
    // phase was mid-descent through: two walkers, one scrollbar, each seeking to its
    // own idea of where the page should be. That is the "animation stopped while it
    // was still scrolling", and the erratic counts that came with it.
    // USED TO RETURN HERE UNCONDITIONALLY ON `stopped` — "one press ends the scan, not one
    // phase of it". But Stop's own label already promises "Finishing the current step" /
    // "Keeping everything found so far", and ending the SCAN here means the row-walk phase —
    // the one that actually reads posts, not just media — never even starts. Reported live: a
    // Stop pressed during the media/asset phase (which can run for minutes on its own) meant
    // every extraction afterward hit `extractAll prime:false` — a plain "read what's on screen"
    // call that never walks — capping the row table at whatever ~9 posts happened to be
    // mounted, no matter how long the asset phase had run.
    // THIS ONCE RELIED ON A SECOND PRESS AND MUST NOT AGAIN. The original version cleared the
    // flag and left the phase at FULL settings, on the reasoning that pressing Stop again
    // would end it. Then Stop was made to disable its own button on the first press (asked
    // for, and right — a second press re-sends STOP and kills the very phase the first press
    // was letting finish). Together those left no way out at all: reported live, a Stop at
    // 1:00 was still climbing "hop 9" at 2:56 under a sheet reading "Stopping…". The phase is
    // bounded at the source instead — see `brief` in `openResults` — so it is over in seconds
    // and needs no escape hatch. Do not restore the full-budget walk here.
    // THE ROWS ARE READ; THE WINDOW WAITS TO BE ASKED FOR. The walk used to end by opening the
    // results window itself, so the first deep scan threw a window over the page nobody asked
    // for. The table is still filled here — See Result, `o`, or a card's Open results shows it.
    if (peek && S.resultId) {
      // A Stop during the media phase set the SAME page-level flag (`window.__holoscrapeStop`)
      // the row walk itself checks — clear it here exactly as the media phase's own start does
      // (see the `clearstop` a few screens up), or the row walk sees "already stopped" on its
      // very first step and does nothing, silently. Awaited for the same reason that one is:
      // the flag lives on the page, and racing it means the walk can start before it lands.
      if (S.stopped && tab?.id) {
        await send({ type: 'ROWS', tabId: tab.id, op: { action: 'clearstop' } }).catch(() => {});
      }
      $('deep').querySelector('.lbl b').textContent = S.stopped ? 'Finishing up…' : 'Reading lists…';
      $('deep').querySelector('.lbl span').textContent = S.stopped
        ? 'Taking the rows already found.'
        : 'Growing the list and taking its rows.';
      await openResults({ resume: $('autoScroll').checked, walk: true, brief: S.stopped,
        show: $('autoOpen').checked });
    }
    // Deliberately NOT awaited here: the sheet it opens can start another run ("Press
    // it"), and run() refuses to start while busy. Asking has to happen after the
    // finally below has released that.
    if (peek) { askAfter = true; deepDone = true; }
  } catch (e) {
    if (e.message !== 'stale') {
      $('caption').textContent = 'Could not read this page.';
      $('log').textContent = e.message;
    }
  } finally {
    busy = false;
    if (peek) stoppable = false;
    // HELD OPEN WHEN A SECOND STEP MAY FOLLOW. This closed the sheet unconditionally, which was
    // right while a card came next — a card replaces it — and is wrong now that `afterScan` may
    // hand straight over to the record pass: closing here and reopening there is a blink with no
    // Stop in it, on the seam between two passes that each take minutes. `afterScan` closes it on
    // every path that does not chain, and `stopped` is honoured because a stopped run has no
    // second step to keep it open for.
    if (peek && !S.pendingAsk && !(askAfter && S.sawChainable && !S.stopped)) closeLive();
    if (!quiet) {
      $('sound').classList.remove('live');
      $('deep').disabled = false;
    }
    paintDeep();
  }
  if (askAfter) await afterScan();
}

// --- opening each row --------------------------------------------------------------
// The list card is a summary; the record's own page holds the rest. On a feed that opens
// its records BESIDE the list, reading them costs one click each and nothing navigates —
// so this is offered at the end of a finished list rather than as a mode of its own.
//
// The zoom, if it is needed at all, is the worker's business (see `openDetails`): the
// layout has to clear 1280 CSS px or the click replaces the list instead of opening beside
// it, and HoloScrape's own side panel is usually what puts it under that line.

async function openEachRow({ tabId, chained = false } = {}) {
  // THE TAB IS AN ARGUMENT ON A CHAINED RUN. `tab` is whatever is in front of you, and by the
  // time step one has finished, opened the results window and handed over, "whatever is in front
  // of you" is a thing that has moved twice. The step that starts the chain knows which tab the
  // list is on; it says so rather than letting this read it again.
  const mine = tabId ?? tab?.id;
  if (!mine) return;
  // The stop flag lives on the PAGE and outlives the scan that set it, so a run that was
  // stopped leaves it standing — and the next press would break on its first row and look
  // like nothing happened. Pressing this is the user starting something, so it is cleared
  // once, here, and awaited before any clicking. Same rule as `regrow` and `hopHere`.
  logIt('press', { what: 'open each item detail', chained, url: (tab?.url || '').slice(-60) });
  // THE SHEET FIRST, THEN THE ERRAND. On a chained run this is the only moment between two
  // multi-minute passes, and `clearstop` is a message round trip — so retitling after it left the
  // sheet naming step one while step two was already being set up. It costs nothing to do the
  // paint first and it closes the one window in which Stop is not on screen.
  const doneGrow = liveGrow('Reading each record', 'details', mine);
  stoppable = true;
  await send({ type: 'ROWS', tabId: mine, op: { action: 'clearstop' } }).catch(() => {});
  S.stopped = false;
  // A CHAIN IS ONLY EVER STARTED BY THE CHAIN. Pressing this button on its own is one step, not
  // three — it keeps the card it has always had — and leaving a half-filled ledger behind would
  // hand the next run somebody else's start time.
  if (chained) { if (!S.chain) chainStart(); S.chain.tabId = mine; } else S.chain = null;
  // HELD, LIKE A DEEP SCAN HOLDS IT. This pass clicks its way down someone's list for minutes
  // at a time, and without `busy` the panel's own 2.5-second poll kept running straight
  // through it: injecting the asset walk into a page that was mid-click, reading the list
  // while a record's page was open over it, and saving a result on top of the one this pass
  // was building. Two runs of the same list came out different tables for that reason.
  //
  // It is released in the `finally` BEFORE the report card goes up, because answering that
  // card can start another run and `run()` refuses to start while this is held.
  busy = true;
  let out = null;
  // THE TAB THIS PASS BELONGS TO, HELD FOR THE WHOLE PASS.
  //
  // `tab` is the module-level ACTIVE tab and the panel re-points it whenever the user's focus moves
  // — see the `tab = t || null` in the tab listener. Reading it again after the wait therefore asks
  // a different tab how a pass it never ran is going, gets nothing, and reports the run as lost.
  //
  // Measured, from a run that was working perfectly: at 03:41:06 the panel sent `DETAILS_STATE` to
  // tab 1604780758 — the RESULTS WINDOW, opened moments earlier — while the pass was on 1604780244.
  // The card said "Lost track of that pass."; ninety-six seconds later the worker logged
  // `lanes.done opened=122 filled=122 lost=0`. Nothing was lost except the panel's grip on it.
  try {
    out = await send({ type: 'DETAILS', tabId: mine }).catch(() => null);
    // A LOST REPLY IS NOT A FINISHED PASS. `send` gives up after five minutes, and a full Maps
    // list takes about ten — 123 records at 4.8s each, measured — so the ordinary case for a
    // complete run was the panel abandoning a pass that was still working and reporting a made-up
    // reason for it. The pass runs in the WORKER and publishes its progress, so ask.
    if (!out) out = await waitOutDetails(mine);
  } finally {
    busy = false; stoppable = false; paintDeep();
    // The sheet stays up on a chained run — step three is about to claim it, and `ask` closes it
    // for every ending that raises a card instead. See the note at the top of `ask`.
    if (!chained) doneGrow();
  }
  // The outcome as the PANEL received it, which is not always what the worker thinks it sent.
  logIt('details.result', { error: out?.error, opened: out?.opened, filled: out?.filled,
    skipped: out?.skipped, why: out?.why, zoomed: out?.zoomed, widened: out?.widened,
    viaFetch: out?.viaFetch, viaTab: out?.viaTab, viaRail: out?.viaRail,
    frames: out?.kept?.frames, backstopped: out?.kept?.backstopped, rows: out?.rows });
  if (out?.id) S.resultId = out.id;
  if (S.chain) S.chain.details = out || { lost: true };

  // Every ending gets its own sentence. "It did not work" over a table that just gained
  // four columns, or over a window that is simply too small, is the kind of report that
  // sends someone looking for a fault that is not there.
  // `error` decides which card, never `why` — the pass also carries a `why` when it gave up
  // for a reason that has nothing to do with the window, and reading that as "too narrow"
  // would answer the wrong question confidently.
  //
  // ON A CHAINED RUN THEY ALL GO THROUGH THE SUMMARY, keeping their own words. The problem is
  // still the headline — it is what the reader needs — but it lands over the facts of the run
  // instead of instead of them: a card reading only "not enough room to open them" throws away
  // the hundred and twenty rows step one had already put in the table, which is how a partial
  // run comes to look like a lost one.
  const bail = (lead, why) => (chained
    ? runSummary({ problem: { lead, why } })
    : ask({ q: lead, sub: why,
        actions: [{ label: 'Open results', value: 'open', kind: 'go' },
          { label: 'Done', value: false }],
      }).then((v) => { if (v === 'open') openResults(); }));
  // NO ANSWER IS NOT A NARROW WINDOW. This branch used to be `if (!out || …TOO_NARROW)`, so a
  // reply that never arrived — the panel losing the worker's response when the user changes tab —
  // was reported as a width problem. Measured: at 09:31:48 of a run that went on to open 123 of
  // 124 records perfectly, the panel drew "Not enough room to open them." over a pass that was
  // still working, and the third-step prompt never appeared because this branch returns.
  //
  // The pass is running in the WORKER, not here, so losing the reply says nothing about the pass.
  // Say that, and offer the results that are already saved.
  if (!out) {
    return bail('Lost track of that pass.',
      'The reply never came back — switching tabs or windows mid-run can drop it. The pass '
      + 'itself runs in the background and is very likely still going or already finished; '
      + 'whatever it gathered is saved. Open the results to see where it got to.');
  }
  if (out.error === 'TOO_NARROW') {
    return bail('Not enough room to open them.', out?.why
      ? `${esc(out.why)}. This list puts a record's page beside itself, and below about `
        + '<b>1280px</b> of page width it replaces the list instead — which would throw '
        + 'away the rows already gathered. Widening the window is the fix.'
      : 'The page could not be read.');
  }
  // Not a fault, and not the same sentence as "these rows cannot be opened". Reading a record's
  // page means knowing where that page keeps its address, its hours and its reviews, and that
  // knowledge is per map — Google's handles are Google's. A map we have not measured yet gets
  // told the truth rather than clicked through to no effect.
  if (out.error === 'NO_MAPPING') {
    return bail('No reader for this map yet.',
      `Opening each record needs to know where <b>${out.map ? esc(out.map) : 'this site'}</b> `
      + 'keeps a place\'s address, hours and reviews, and that is different for every map. '
      + 'Google Maps is the one that has been measured. The rows from the list itself are '
      + 'untouched.');
  }
  if (out.error) {
    return bail('These rows cannot be opened.',
      'Opening a row is only safe where the page swaps its content in place. This '
      + 'list does not say that it does, so clicking a row would navigate away and take '
      + 'the rows already gathered with it.');
  }
  const { opened = 0, filled = 0 } = out;
  // STEP TWO IS DONE AND STEP THREE STARTS ITSELF.
  //
  // This is one of the two confirmation clicks that used to sit in the middle of the run. It
  // asked nothing a person can answer better than the panel can — the list is read, the records
  // are read, and the thing everybody presses this tool for is the email that only the business's
  // own site carries. `driveSites` refuses on its own terms when there is nothing to read, so the
  // count that used to be gathered to write the offer is no longer needed to make the decision.
  //
  // Stopped is the exception, and it is not a transition: a stop means "that is enough", and
  // starting ninety more page loads on the back of it would be the opposite of what was asked.
  if (chained && !S.stopped && !out.stopped) return readTheirSites({ tabId: mine, chained: true });
  // Stopped mid-chain still gets the report — everything read is in the table and the run is over,
  // which is exactly the situation the summary exists for.
  if (chained) return runSummary({ stoppedAt: 2 });
  // EVERY RECORD WAS ALREADY READ, which is a finished job and used to report as a failure:
  // "Opened 0 item details, and none of them had a page to read." Pressing again after a
  // completed pass is a perfectly ordinary thing to do — and it was also the only way back to the
  // third step once the card offering it had been dismissed, so dismissing that card used to mean
  // re-scanning the whole list to reach the emails.
  if (!opened && out.already > 0) {
    const has = await sitesToRead();
    await ask({
      q: `All <b>${out.already}</b> already read.`,
      sub: 'Every record on this list has been opened and its details are in the table.'
        + (has ? ` <b>${has.sites}</b> of them list a website, and those have not been read for `
          + 'an email yet.' : ' Their websites have been read too.'),
      actions: [
        ...(has ? [{ label: `Find emails on their ${has.sites} sites`, value: 'sites', kind: 'go' }] : []),
        { label: 'Open results', value: 'open', kind: has ? '' : 'go' },
        { label: 'Done', value: false },
      ],
    }).then((v) => {
      if (v === 'open') openResults();
      else if (v === 'sites') readTheirSites();
    });
    return;
  }
  // The websites this pass just gathered, counted before the card is written — the offer of the
  // next step has to state a number the user can decide on, and "some" is not one.
  const sites = filled ? await sitesToRead() : null;
  // ONE FACT PER LINE, same as the card that offered this pass.
  //
  // This `sub` had grown to eleven conditional clauses concatenated onto one string — what was read,
  // how the run ended, whether the window moved, whether the zoom moved, what was skipped, what did
  // not finish drawing, whether a reload is needed, and the offer of the next step. Every one of them
  // is a separate fact, and in a 400px column they arrived as an unbroken wall of prose in front of a
  // decision. A reader looking for "did it finish" had to parse a paragraph to find out.
  //
  // Built as a list rather than a string so a clause that does not apply contributes nothing at all —
  // the concatenated version had to end every branch in `: ''` and one missed one would have shown.
  const bits = [];
  if (filled) {
    // SHORT. A bullet that wraps to three lines is a paragraph wearing a dot, and this card carries
    // up to eight of them. One line each, and the reason a fact is here at all is that it changes
    // what the reader does next — not that it is interesting.
    bits.push('Adds full address, hours, plus code, international phone and coordinates.');
    // THREE DIFFERENT ENDINGS, AND THEY ARE NOT THE SAME NEWS.
    //
    //   handed over   the site challenged the fast pass and the rest were read from the list
    //                 instead. Nothing is missing, so this is information, not a problem.
    //   walled        challenged with records still outstanding — the only case that asks
    //                 anything of the reader, so it leads with the action.
    //   stopped early anything else. Given up on rather than ground through, said plainly.
    if (out.handedOver) {
      bits.push(`Google challenged after <b>${out.byTabs || 0}</b>; the last <b>${out.byRail || 0}</b> `
        + 'came from the list itself, unnoticed.'
        + (out.left > 0 ? ` <b>${out.left}</b> could not be read.` : ''));
    } else if (out.walled) {
      bits.push('<b>Google asked to verify you are a person.</b> Tick the box in the tab left open, '
        + `then press <b>Open each item detail</b> again for the last <b>${out.left || 0}</b>.`);
    } else if (out.why) {
      bits.push(`Stopped early — ${esc(out.why)}.`);
    }
    if (out.stopped) bits.push('Stopped early; everything read is in the table.');
    // Suggestion cards ("Hotels", "Things to do") link to a SEARCH, and clicking one replaces the
    // list with a different one. Skipped, and said, because a silent skip looks like a miscount.
    if (out.skipped) {
      bits.push(`<b>${out.skipped}</b> were suggestion cards, not places — clicking those replaces `
        + 'the list.');
    }
    // Ours to own, not a property of the record: a page that did not finish drawing has less on it.
    if (out.walkShort) {
      bits.push(`<b>${out.walkShort}</b> did not finish drawing, so carry only what was on screen.`);
    }
    // What it had to move to make the room. A window that changed size without explanation is
    // alarming; one that says so is not. The window IS put back; the zoom deliberately is not —
    // restoring it re-lays-out the page at the exact moment the pass ends, which is how a finished
    // table got overwritten. So it says where it left it, and how to undo it.
    if (out.widened) bits.push('The window was widened while this ran, and put back.');
    if (out.zoomed && out.zoomed !== 1) {
      bits.push(`Still zoomed to <b>${Math.round(out.zoomed * 100)}%</b> — left there on purpose, `
        + 'since resetting it moves the map. <b>Cmd/Ctrl + 0</b> undoes it.');
    }
    // A hidden tab draws no animation frames, and Maps mounts a record's page from one — so this
    // pass needs a small piece of code that is only in place from a page load. Said here rather
    // than left to be discovered as "it stopped after three".
    if (out.framesReload) {
      bits.push('<b>Reload this tab once</b> before the next run, or a background tab cannot draw '
        + 'and the pass stops early.');
    } else if (out.kept?.backstopped) {
      bits.push(`Kept drawing in the background — <b>${out.kept.backstopped}</b> frames the browser `
        + 'would not have run.');
    } else {
      bits.push('Keeps going while you work elsewhere.');
    }
    // THE NEXT STEP, NAMED AND COUNTED. The list is step one, the records are step two, and what a
    // person is usually after — an email — is on the business's own site, because Google does not
    // carry one anywhere. The cost is stated because pressing it starts immediately.
    if (sites) {
      bits.push(`<b>${sites.sites}</b> list a website${sites.places > sites.sites
        ? ` (${sites.places} rows — some share one)` : ''} — about `
        + `<b>${mins(Math.round(sites.sites * 3.5 / 5))}</b> to read them for an email.`);
    }
  }
  // THE DENOMINATOR IS WHAT WAS ASKED FOR, NOT WHAT WAS REACHED.
  //
  // This read `${filled} of ${opened}` — and `opened` is a count the pass produces as it goes,
  // so a run that quit early quietly shrank its own denominator. Measured on a 120-row Seychelles
  // list that hit a reCAPTCHA at record 110: `opened=113 filled=110 skipped=0 rows=120`, and the
  // card said "110 of 113". Eight percent of the list was never attempted and the card read as a
  // 97% success. `skipped=0` on the same line said nothing had been skipped.
  //
  // `left` is already computed by the pass (`total - filled`) and was already being used two
  // screens later to size a second press. It belongs here, where somebody is deciding whether the
  // run finished.
  const asked = filled + (out.left || 0);
  const short = (out.left || 0) > 0;
  await ask({
    q: filled
      ? `<b>${filled}</b> of <b>${asked}</b> item details read.`
        + (short ? ` <b>${out.left}</b> were never opened.` : '')
      : `Opened <b>${opened}</b> item details, and none of them had a page to read.`,
    sub: filled
      ? `<ul>${bits.map((b) => `<li>${b}</li>`).join('')}</ul>`
      : `Each one was opened and nothing named a record${out.why ? ` — ${esc(out.why)}` : ''}, `
        + 'so there was nothing to add. The rows from the list itself are untouched.',
    actions: [
      // First, so Enter takes it: it is the step this card exists to offer.
      ...(sites ? [{ label: `Find emails on their ${sites.sites} sites`, value: 'sites', kind: 'go' }] : []),
      { label: 'Open results', value: 'open', kind: sites ? '' : 'go' },
      { label: 'Done', value: false },
    ],
  }).then((v) => {
    if (v === 'open') openResults();
    else if (v === 'sites') readTheirSites();
  });
}

// What happens once a scan's passive pass is done. Two questions at most, and only one
// of them is ever asked on a given page:
//
//   the page has a load-more and this page has not been answered before
//       → "press it?" — because pressing is an action on someone else's page, and the
//         first time is the moment to ask. Answered once, then never again here.
//   the list stopped short and nothing on the page said "load more"
//       → offer to be shown it, because no word list can find what it does not know.
//
// Neither is asked while anything is scrolling: the walk has finished by the time these
// run. Nothing is frozen, and cancelling stays available throughout via Esc.
async function afterScan() {
  if (S.stopped) { closeLive(); return; }
  // `sawMore` is what the WALK saw, recorded at the bottom of the page where the control
  // lives. Asking `detect` for it here reported nothing: by this point the scroll has been
  // put back at the top and the page has unmounted the button, so the question about
  // pressing it could never be asked. This is the read that made the sheet reachable.
  let seen = null, rows = 0, dupes = 0, recycling = false, endedBy = '';
  // Whether this list's rows can be opened at all, asked of the engine rather than guessed
  // — the offer then appears exactly where it works and nowhere else.
  let canDetail = false, detailed = 0, canRead = false;
  try {
    const d = await send({ type: 'ROWS', tabId: tab.id, op: { action: 'progress' } });
    seen = d?.sawMore || null;
    rows = d?.uniq ?? d?.rows ?? 0;
    dupes = d?.dupes || 0;
    recycling = !!d?.recycling;
    endedBy = d?.endedBy || '';
    canDetail = !!d?.canDetail;
    if (d?.detailMap) S.chainMap = d.detailMap;
    if (d?.detailTraits) S.chainTraits = d.detailTraits;
    canRead = !!d?.canRead;
    detailed = d?.detailed || 0;
  } catch (_) { closeLive(); return; }
  if (!rows) { closeLive(); return; }
  let more = seen?.label || null;
  // A CONTROL THAT WAS PRESSED AND GREW NOTHING IS NOT A LOAD-MORE, whatever it is called.
  //
  // With auto-follow on, this function presses the seen control and calls itself, and nothing
  // asked whether the press had done anything. Measured on Gmail: the wording finder took the
  // "Show more messages" count dropdown for a load-more, and the log shows `chain.loadmore …
  // press=true` seven times in twenty seconds with `rows=4` on every line — a menu opening and
  // closing forever. One stretch is a fair test; a stretch that left the count where it was is
  // the answer, and the card moves on to the pager and the end-of-list offers below.
  const moreKey = seen ? (seen.selector || seen.label || '') : '';
  const stalled = !!(seen && lastStretch.key && lastStretch.key === moreKey && rows <= lastStretch.rows);
  if (stalled) {
    logIt('chain.stalled', { label: (more || '').slice(0, 40), rows, was: lastStretch.rows,
      why: 'pressing it brought no new rows — not a load-more' });
    more = null;
  }

  // --- ONE SHOT ---------------------------------------------------------------------
  //
  // A map list is read in three passes and the half-card used to sit between them asking
  // permission to carry on: "that is the whole list — open each item detail?" and then "…find
  // emails on their 84 sites?". Both of them are the same answer every time, on a run that
  // takes ten minutes and that nobody sits and watches — so what they actually did was stop the
  // job halfway and wait for somebody to come back to the screen.
  //
  // They are gone. What is NOT gone is every card that asks something only a person can answer:
  // a verification challenge, a control we cannot find, a window too narrow to work in. Those
  // are not transitions, they are questions, and suppressing one turns a run you could rescue
  // into a run that silently produced less than it should have.
  //
  // The gate is the same one the pass itself applies (`canDetail` for the shape, `canRead` for
  // the mapping) plus "the list has stopped growing" — because chaining into the record pass
  // while the rail could still be extended would read the first half of a list and call it done.
  // Everything that is NOT a map list keeps the cards it had.
  const undetailed = rows - detailed;
  // A PAGE THAT ENDED IS NOT A LIST THAT ENDED.
  //
  // The note above already states the rule — chaining into the record pass while the rail could
  // still be extended "would read the first half of a list and call it done" — and paging is
  // precisely that case. 2GIS's page one has no load-more and nothing left to scroll, so the walk
  // honestly reports `said so`, `listDone` went true, and the chain read twelve records of a
  // 6,972-place search and presented it as finished. The next-page link was in the DOM throughout.
  //
  // So the list is not done while another page is offered. Costs one engine call on every scan,
  // and on a site with no pager it answers `none` immediately and changes nothing.
  // ASKED ONLY OF PROVIDERS THAT PAGE — and the scoping is the fix, not the question.
  //
  // Asking every list cost 18 checks on Google Maps: its fixture has links a next-page guess
  // matches, so `morePages` went true, the chain was blocked, and the card became "124 rows — and
  // this is page undefined" where three steps of work should have run. Same shape of mistake as
  // suppressing the load-more globally — a 2GIS problem cured everywhere.
  //
  // It also removes an engine round-trip from every scan on every site, which it never earned.
  // Asked here, once, and used by every decision below it — `nextUp`, the load-more card, and the
  // page-following chain all turned on the same fact and all three were reading a cache.
  const traits = await freshTraits();
  const paged = traits.grows === 'pager-click';
  const nextUp = paged
    ? await send({ type: 'ROWS', tabId: tab.id, op: { action: 'nextpage' } }).catch(() => null)
    : null;
  const morePages = !!(nextUp && !nextUp.error && !nextUp.none);
  const listDone = (recycling || !!endedBy) && !morePages;
  if (canDetail && canRead && undetailed > 0 && listDone && !S.stopped) {
    chainStart();
    S.chain.tabId = tab.id;
    S.chain.list = { rows, detailed, dupes, endedBy, recycling };
    logIt('chain.step', { step: 2, of: traits.steps || 3, rows, undetailed, why: endedBy || 'recycling' });
    // The page goes back where the user stood, exactly as the two cards this replaces did
    // before offering the next step.
    send({ type: 'ROWS', tabId: tab.id, op: { action: 'gohome' } }).catch(() => {});
    return openEachRow({ tabId: tab.id, chained: true });
  }
  // Not chaining, so nothing is holding the progress sheet open any more. Every path below
  // either raises a card (which replaces it) or returns, and a returning path used to leave a
  // live sheet with a Stop button over a run that had finished.
  closeLive();

  const mem = (await send({ type: 'POINT_MEMORY', url: tab.url }).catch(() => null))?.point;

  // Already answered "press it", pressed to the ceiling, and the control is STILL
  // there: the feed is longer than one pass. Silence here read as "scraping stopped"
  // — 504 rows exported off a feed the engine can take past 1,300 if simply asked to
  // continue. So ask, and continue rather than restart.
  // The feed has run out of things to say. Not a question — asking "keep going?" of a
  // page that answers with the same 284 products is asking the user to decide something
  // we already know the answer to.
  if (recycling) {
    send({ type: 'ROWS', tabId: tab.id, op: { action: 'gohome' } }).catch(() => {});
    await ask({
      // NOT "that is everything this page has". It was, and it was not true: a recycler that
      // stops handing over new rows has stopped, which is a fact about the scan and not about the
      // page. Measured on a 733-post topic whose own timeline read "733 / 733" two nodes away
      // while this card announced 69 as the total. An honest ceiling is the rule everywhere else
      // in this project; the last sentence the person reads has to obey it too.
      q: `<b>${rows}</b> rows — the list stopped producing new ones.`,
      sub: (dupes
        ? `It kept re-serving the same items (<b>${dupes}</b> repeats skipped), so the `
          + 'scan stopped. Nothing was lost — repeats are not rows.'
        : 'The list stopped producing anything new, so the scan stopped.')
        + (canDetail && rows - detailed > 0
          ? " Each item's detail page can still be opened for what it holds." : ''),
      actions: (canDetail && rows - detailed > 0
        ? [{ label: `Open each item detail · ${rows - detailed}`, value: 'detail', kind: 'go' }]
        : []).concat([
        { label: 'Open results', value: 'open', kind: canDetail && rows - detailed > 0 ? '' : 'go' },
        { label: 'Done', value: false },
      ]),
    }).then((v) => {
      if (v === 'detail') return openEachRow();
      if (v === 'open') openResults({ reuse: true });
    });
    return;
  }

  // A PAGER BEATS A LOAD-MORE **ON PROVIDERS WE KNOW PAGE** — and the scoping is the point.
//
// The first version of this suppressed the load-more on ANY page that also offered a next link,
// which is wrong and would have cost rows: on a site whose load-more is real, it often reaches
// further than the pager does, and skipping it to page instead reads less. That is the shape of
// fix this project keeps paying for — a real bug cured globally, breaking sites nobody retested.
  //
  // 2GIS has no load-more at all. What the detector matched was the map's own "immersive roads"
  // toggle, and pressing it rewrote the URL to `?immersive=on` and grew nothing: the card said
  // "10 rows, and the feed is still going", "Keep going" did nothing forever, and because `more`
  // was truthy the next-page path below never ran. A control that changes a setting is
  // indistinguishable from one that loads more rows until you press it — so where the page offers
  // real pagination, that is what we use.
  // WHY THIS CARD DID OR DID NOT APPEAR, in the log, because three rounds of reasoning about it
  // have been wrong and a screenshot cannot show which input was false.
  logIt('chain.loadmore', { seen: !!seen, label: (seen?.label || '').slice(0, 40),
    press: mem?.press !== false, morePages, grows: traits.grows, map: traits.map || '', stalled,
    shows: !!(seen && !stalled && mem?.press !== false && !(morePages && paged)) });
  if (seen && !stalled && mem?.press !== false && !(morePages && paged)) {
    // ASKED ONCE IS ENOUGH FOR SOMEONE WHO HAS TURNED THIS ON. Same card, same control, same
    // "That is enough" available on the NEXT round through `afterScan()` — this only skips the
    // question, it does not skip Stop, and every page still commits as it lands.
    const goOn = autoFollowOn() ? true : await ask({
      q: `<b>${rows}</b> rows, and the feed is still going.`,
      sub: `“${esc(more)}” is still there. Keep going takes the next stretch from where
        this one stopped — nothing is re-walked.`
        + (dupes ? ` <b>${dupes}</b> repeats skipped so far.` : ''),
      actions: [
        { label: 'Keep going', value: true, kind: 'go' },
        { label: 'Point at another', value: 'point' },
        { label: 'That is enough', value: false },
      ],
    });
    if (goOn === 'point') return startPointing();
    if (goOn !== true) {
      // Done growing: now, and only now, the page goes back where the user stood.
      send({ type: 'ROWS', tabId: tab.id, op: { action: 'gohome' } }).catch(() => {});
      return;
    }
    const d = SCAN;
    lastStretch = { key: moreKey, rows };
    const doneGrow = liveGrow('Growing the list', 'rows');  // the live figures carry the count
    stoppable = true;
    // A stretch runs OUTSIDE run(), so nothing else puts the main button back: Stop
    // pressed here left it reading "Stopping… / Finishing the current step." for good,
    // because paintDeep is only called in run()'s finally. Every path that changes that
    // label owes it a repaint.
    try {
      await send({ type: 'ROWS', tabId: tab.id,
        op: { action: 'extractAll', regrow: true, hops: d.hops, budget: d.budget,
              clickMore: true, moreSelector: mem?.selector || seen?.selector } }).catch(() => null);
    } finally { stoppable = false; doneGrow(); paintDeep(); }
    return afterScan();   // and offer again, until the feed ends or the user does
  }

  // Offered whenever nothing was seen — not only on a page that has never been asked.
  // `!mem` was wrong: "That is enough" writes memory, so from then on a page whose
  // list stopped short with no control in sight said nothing at all. The one escape
  // hatch for a control no vocabulary can find was reachable exactly once per page,
  // and never again. A page already carrying a pointed selector is the one case that
  // stays quiet, because it has its answer.
  // A list with no load-more has usually not stopped — it has been split. Pixabay's
  // video search is 129 items and a link to page 2; Coverr's is "Go to next page".
  // Asked before the pointing offer, because pointing at a next-page link is the one
  // thing that cannot work: it navigates, and the list would be lost.
  //
  // AND ASKED WHEN THE PAGE SAYS IT IS FINISHED, TOO — which is the whole of 2GIS.
  //
  // "The page said it had reached the end" is a claim about THIS PAGE, and on a paginated site it
  // is true on every one of them. 2GIS serves twelve rows, no load-more, nothing left to scroll —
  // so the walk correctly ends with `said so`, the branch below declared "that is the whole list —
  // 12 rows", and a search holding 6,972 places was reported as finished after twelve. The
  // next-page link was sitting in the DOM the entire time and nothing ever looked at it.
  //
  // So the two conditions are asked together: nothing more to load HERE is not the same fact as
  // nothing more to load AT ALL, and only the second one ends a run.
  if (!more || endedBy === 'said so') {
    const nx = await send({ type: 'ROWS', tabId: tab.id,
      op: { action: 'nextpage', nextSelector: mem?.nextSelector } }).catch(() => null);
    if (nx && !nx.error && !nx.none) {
      // A search URL can carry a dozen parameters, and printing all of them turned the
      // question into a wall of query string. The name of the control says more about
      // what will be pressed than its address does.
      const where = nx.label ? `“${esc(nx.label)}”` : `<b>${esc(shortUrl(nx.href))}</b>`;
      // NOTHING TO ASK ON A MAP THAT ANSWERS BOTH QUESTIONS ITSELF.
      //
      // The card exists because on an unknown site each of these is a real decision: is that
      // control the next page, will walking it cost anything, is opening every record worth the
      // tabs. A provider that declares `grows` has already said which control turns the page, and
      // one that declares `reads: 'fetch'` has said reading a record costs one request and never
      // touches the tab. Both answers are in the descriptor, so putting them to the person is
      // asking them to confirm a fact the tool is more sure of than they are — three clicks and
      // two waits for a run that could have started on the first.
      //
      // So it starts. Stop is on screen throughout and every page is committed as it lands, which
      // is what makes starting without asking safe rather than merely quick.
      //
      // ASKED OF THE ENGINE, NOT OF THE PANEL'S COPY. `chainTraits` is a cache, and `closeLive`
      // resets it to the unknown-site defaults — which `ask` calls. So any card shown earlier in
      // the same run leaves this decision reading `grows: ''` for a map that pages, and the
      // prompt appears anyway. Seen exactly that way on 2gis.cz, while `mapkind` on the same tab
      // answered `{grows:'pager-click', reads:'fetch', steps:2}`.
      //
      // One message, no cache. The answer also refreshes the ledger, so a two-step map stops
      // drawing a third step it will never run.
      if (paged && traits.reads === 'fetch') {
        return followPages({ here: true, withDetails: true });
      }
      // SAME SWITCH AS THE LOAD-MORE CARD ABOVE, same reasoning: a guessed pager on an unknown
      // site is a real decision the first time, and a repeat of the same question every scan
      // once someone has already said yes. `followPages` still commits every page as it lands
      // and still answers Stop, exactly as it does when this card is actually shown.
      // STANDING ON PAGE 3 AND FOLLOWING THE PAGES MEANT PAGES 3, 4, 5 — NEVER 1 AND 2.
      //
      // The card said "and this is page 3", offered to "continue the list", and did exactly
      // that: `hopHere` starts from the tab's current address, so the two pages already behind
      // the person were simply never read. Nothing reported them missing either, because the
      // walk honestly did read every page it visited. Measured by hand: standing on page 3 of
      // an amazon search and following the pages returned 16 rows and called itself complete.
      //
      // The pages behind us are reachable whenever the address carries the number, which is the
      // same fact the url dial already learns — so ask for the dial from THIS page and the next
      // one (their page numbers are known, no guessing), and `samples[0]` is page one.
      // `from` then makes the walk drive there before it starts, which it already supports for
      // resuming after a challenge.
      let firstUrl = '';
      if ((nx.from || 0) > 1 && nx.href) {
        const learned = await send({ type: 'LEARN_DIAL', urls: [tab.url, nx.href],
          pages: [nx.from, nx.from + 1] }).catch(() => null);
        if (learned && !learned.error) firstUrl = learned.samples?.[0] || '';
      }
      const go = autoFollowOn() ? (firstUrl ? 'all' : 'hop') : await ask({
        // THE DIAL IS MACHINE TRUTH; THIS LINE IS FOR A PERSON. `nx.from` is the value in the
        // URL, and on a zero-indexed site (shopee.co.id's categories are `?page=0`) the first
        // page is genuinely 0 — which is right for the engine and wrong to say out loud, since
        // the site's own pager draws that page as "1". Standing on 0 means standing on the first.
        // TWO REAL CHOICES, AND THE REST OUT OF THE WAY.
        //
        // Four equal buttons across a 340px panel gave every label a 90px column, which took
        // the primary action down to four stacked words: "Read / every / page / from 1". The
        // prose was doing the same thing — five lines describing the mechanism (pictures,
        // tab restore, Stop) before the person could see what they were being asked.
        //
        // What they are actually deciding is: all of it, or just this page. "Carry on from
        // here" and "point at the pager" are a preference and a repair, so they go quiet
        // below. The mechanics stay, in one sentence, after the choice is legible.
        q: `<b>${rows}</b> rows here${firstUrl ? `, and you are on page ${nx.from}` : ''}.`,
        sub: (firstUrl
          ? `This list has more pages. I can read every one from the start, or carry on from `
            + `here — which would skip pages 1–${nx.from - 1}.`
          : `${where} continues the list${nx.pointed ? ', as you showed us' : ''}, and I can `
            + 'turn the pages here and add each one to this table.')
          + ' Your tab comes back to this page when it finishes, and Stop works any time.',
        // NOT ESCAPED: `note` is written with `textContent`, so an escaped `&` arrived on
        // screen as the literal text `&amp;` — every amazon address in this card read
        // `?k=android&amp;page=5&amp;qid=…`.
        note: nx.pointed ? '' : `Guessed from the links on this page: ${shortUrl(nx.href)}`,
        actions: [
          ...(firstUrl
            ? [{ label: 'Read every page', value: 'all', kind: 'go' },
               { label: 'Just this page', value: false },
               { label: `Carry on from page ${nx.from}`, value: 'hop', kind: 'thin' }]
            : [{ label: 'Follow the pages', value: 'hop', kind: 'go' },
               { label: 'Just this page', value: false }]),
          { label: 'Point at the pager', value: 'point', kind: 'thin' },
        ],
      });
      // WALKED HERE, not fetched. Reading a page in this tab renders it, paints it, mounts its
      // pictures and carries the session — so it needs no ladder of quieter attempts, and it
      // does not spend their timeouts on the way. The tab is borrowed and given back.
      if (go === 'all' && firstUrl) return followPages({ here: true, from: firstUrl });
      if (go === 'hop' || go === 'all') return followPages({ here: true });
      if (go === 'point') return pointNextPage();
      return;
    }
  }

  // THE PAGE ALREADY ANSWERED. A declared feed that printed "You've reached the end of
  // the list" has told us there is nothing more, and the card below then asked the user
  // to point at a load-more control — on Google Maps, which has none. Asking someone to
  // find a control that does not exist reads as the tool blaming them for its own stop.
  // So say what happened and offer the results, which is the only thing left to do.
  if (endedBy === 'said so') {
    // "THE FEED ENDED" IS NOT "THE SITE HAS NO MORE PAGES", and treating them as one fact is what
    // stopped a 36,501-product search at 25 rows with a pager on screen reading 1 2 3 4 5 … 20.
    //
    // The offer to point was removed from here for a good reason: on Google Maps, whose rail
    // simply scrolls, asking someone to find a next-page control reads as the tool blaming them
    // for its own stop. That reason is real and it is ALSO specific to Maps. Everywhere else, a
    // feed that reported the end of ITS OWN batch has said nothing at all about pagination, and
    // `findNextPage` missing the control is the common case rather than the rare one — it needs an
    // anchor carrying the page number, and a pager built from buttons carries none.
    //
    // So the descriptor decides instead of a guess: a provider that declares `grows: 'scroll'` has
    // no pager by definition and is not asked about one. An unknown site is asked, because the
    // person is looking at the pager we could not find and is the only one who can settle it.
    const kind = await freshTraits().catch(() => null);
    const mightPage = (kind?.grows || '') !== 'scroll';
    send({ type: 'ROWS', tabId: tab.id, op: { action: 'gohome' } }).catch(() => {});
    // A finished list is where opening its records belongs: the list is complete, so the
    // pass has a real total, and nothing else is competing for the page.
    const left = rows - detailed;
    const go = await ask({
      q: `That is the whole list — <b>${rows}</b> rows.`,
      // A count AND a cost, because opening a hundred item details is minutes and nobody should
      // find that out by waiting.
      //
      // The figure was `left * 2`, and it was wrong by more than double: a real 123-record pass
      // took 9m51s — 4.8s each — so a full Maps list was quoted at four minutes and took ten.
      // An estimate that under-reads by that much is worse than none, because it is why a healthy
      // pass looks stuck. `DETAIL_SECS` is the measured number.
      // THREE FACTS, THREE LINES. This was one paragraph carrying what the pass gives, what it costs
      // and what it risks — four lines of unbroken prose in a 400px column, in front of a decision
      // that takes minutes to undo. They are separate questions and they are read separately.
      sub: 'The page said it had reached the end, so nothing was left to load.'
        + (mightPage
          ? ' If this list has numbered pages, that message was only about this one — nothing '
            + 'on the page looked like a link to the next, so point at it and the rest follow.'
          : '')
        + (canDetail && left > 0
          ? '<ul>'
            + '<li>Adds the full postal address, opening hours, international phone number and '
            + 'exact coordinates — none of which is on the list card.</li>'
            + `<li>About <b>${mins(left * DETAIL_SECS)}</b> for <b>${left}</b>.</li>`
            // WHAT ACTUALLY HAPPENS, because this said the opposite of it.
            //
            // It read "Nothing navigates: each detail opens beside the list" — which describes the
            // RAIL pass, the one that only runs as a fallback after Google challenges the fast one.
            // What this button starts is `driveDetailsTabs`: FIVE background tabs, one page load per
            // record. Five Maps instances appearing unannounced is the single most alarming thing
            // this product does, and the card was promising it would not happen.
            //
            // The reassurance that is true belongs here too: the list tab itself is never navigated,
            // so the list is still there afterwards, and Stop keeps what has been read.
            + `<li><b>${LANES_SHOWN}</b> background tabs do the reading, one record at a time each. `
            + 'They close themselves when it ends.</li>'
            + '<li>Your list tab is not navigated and stays as it is. Stop keeps everything already '
            + 'read.</li>'
            // Said as a suggestion, not a requirement, and with the reason — each lane is a whole
            // Google Maps instance, which is one of the heaviest pages there is.
            + '<li>Worth closing anything heavy you are not using first: each of those tabs is a '
            + 'full Google Maps.</li>'
            + '</ul>'
          : ''),
      actions: (canDetail && left > 0
        ? [{ label: `Open each item detail · ${left}`, value: 'detail', kind: 'go' }]
        : []).concat(mightPage
        ? [{ label: 'There are more pages — point at it', value: 'point' }]
        : []).concat([
        { label: 'Open results', value: 'open', kind: canDetail && left > 0 ? '' : 'go' },
        { label: 'Close', value: false },
      ]),
    });
    if (go === 'point') return pointNextPage();
    if (go === 'detail') return openEachRow();
    if (go === 'open') return openResults();
    return;
  }

  if (!more && !mem?.selector) {
    const what = await ask({
      q: `The list stopped at <b>${rows}</b> rows.`,
      // A feed that simply went quiet is a different stop from a page with no control at
      // all, and it must not be described as the second: we waited ten seconds for the
      // next batch and nothing came, which is worth saying rather than implying the user
      // failed to point at something.
      sub: endedBy
        ? 'It kept loading as it was scrolled, then stopped sending anything for ten '
          + 'seconds. That is usually the end; it can also be the page rate-limiting us.'
        : 'Nothing on the page said “load more”. If there is a control for it, '
          + 'pointing at it once is enough — it is remembered after that.',
      note: 'Esc if the list has simply ended.',
      // A feed that went quiet is still a finished-enough list, so the offer belongs here
      // too — this is the ending Maps produces when it stops sending without printing its
      // sentinel, and without it the rows are simply left half-read.
      actions: (canDetail && rows - detailed > 0
        ? [{ label: `Open each item detail · ${rows - detailed}`, value: 'detail', kind: 'go' }]
        : []).concat(endedBy
        ? [
          { label: 'Open results', value: 'end', kind: canDetail ? '' : 'go' },
          { label: 'Point at a control', value: 'point' },
        ]
        : [
          { label: 'Point at it', value: 'point', kind: canDetail ? '' : 'go' },
          { label: 'It has ended', value: 'end' },
        ]),
    });
    if (what === undefined) return;
    if (what === 'detail') return openEachRow();
    if (what === 'point') await startPointing();
    // "It has ended" stops the pressing, and nothing more: it must not also silence
    // the offer, or a page can never be pointed at again.
    else await send({ type: 'POINT_MEMORY', url: tab.url, save: { press: false, ended: true } });
  }
}



// Coming back to a page that still has an unanswered question asks it again. No stash is
// needed for that: the page itself is the state — window[S].sawMore survives on the page
// until it reloads — so the same conditions that raised the question the first time raise
// it again, and a page that has since been answered or reloaded raises nothing.
async function reaskIfPending() {
  if (busy || pointing || S.pendingAsk || !scannable || !tab?.id) return;
  try {
    // An interrupted hop comes back first, because the interruption was OUR idea. The
    // panel says "opening the page lets you clear the check; Follow the pages then picks
    // up where this stopped" — and then opening the page switched tabs, which retracted
    // the question, so coming back left nothing to press and that promise was a dead end.
    // The pages already read are safe (committed as they landed); what was missing was the
    // way back in.
    if (unfinishedHop && unfinishedHop.key === hopKey()) {
      const resume = await ask({
        q: 'There are more pages waiting.',
        sub: `Reading stopped at page ${unfinishedHop.pages} — ${esc(unfinishedHop.why)}. `
          + 'Everything read up to then is already in the table. Carrying on picks up from '
          + 'where it stopped rather than starting over.',
        actions: [
          { label: 'Carry on', value: 'go', kind: 'go' },
          { label: 'Open results', value: 'open' },
          { label: 'Leave it', value: false },
        ],
      });
      if (resume === 'go') { unfinishedHop = null; return followPages({ here: true }); }
      if (resume === 'open') { unfinishedHop = null; return openResults(); }
      unfinishedHop = null;
      return;
    }
    const d = await send({ type: 'ROWS', tabId: tab.id, op: { action: 'progress' } });
    if (!d || d.error || !d.rows || !d.sawMore) return;
    const mem = (await send({ type: 'POINT_MEMORY', url: tab.url }).catch(() => null))?.point;
    if (mem) return;                 // already answered for this page
    await afterScan();
  } catch (_) { /* nothing to re-ask is not a failure */ }
}

// A declaration, not a const arrow: the menu paints on first open, which happens
// long before this line is reached in source order.
// --- the third step: the places' own websites --------------------------------
//
// A rail gives you a list, opening each record gives you the record, and the thing a person is
// actually after is usually on the business's OWN site — an email above all. Google never shows
// one, so it can only come from the site.
//
// This USED to hand the job to the URL-list screen: fill the textarea with 88 addresses, open the
// drawer, and leave the user in front of a Scan list button. Three things were wrong with that,
// in rising order of seriousness. It moved them somewhere else mid-flow, so a step in one chain
// looked like a different feature. It made them press a second button for something they had
// already chosen. And the machinery on the other side was the wrong machinery: that screen finds
// MEDIA FILES on a page, one tab at a time — it has never looked for an email, and it would have
// filed whatever it found under a new result of its own instead of into the table these rows
// came from.
//
// So the step runs where it was offered, on the lanes the second step uses, and files into the
// same rows. See `driveSites` in the worker.

// Read them, here, now. No drawer, no second button, no textarea — see the note above the
// section. The shape is the second step's, because it is the same kind of thing: hold the panel
// so its own poll cannot write over the pass, show the sheet with a Stop on it, sit with the
// worker if the reply is lost, then one card.
async function readTheirSites({ tabId, chained = false } = {}) {
  // The list's tab, handed down the chain rather than read again — see the note in `openEachRow`.
  const mine = tabId ?? tab?.id;
  if (!mine) return;
  logIt('press', { what: 'read their websites', chained, url: (tab?.url || '').slice(-60) });
  // The sheet before the errand, same as step two: this is the seam between two long passes and
  // it is the one moment where Stop could otherwise be off screen.
  const doneGrow = liveGrow('Reading their websites', 'sites', mine);
  stoppable = true;
  await send({ type: 'ROWS', tabId: mine, op: { action: 'clearstop' } }).catch(() => {});
  S.stopped = false;
  if (chained) { if (!S.chain) chainStart(); S.chain.tabId = mine; } else S.chain = null;
  busy = true;
  let out = null;
  // Held for the whole pass, for the reason spelled out in `openEachRow` — and this pass is MORE
  // exposed to it, not less: reading ninety websites is exactly when somebody opens the results
  // window to look at what has landed so far.
  try {
    out = await send({ type: 'SITES', tabId: mine }).catch(() => null);
    // Same reason as the details pass: `send` gives up long before ninety sites are read, and
    // the pass is in the worker, so a lost reply says nothing about it. See `waitOutDetails`.
    if (!out) out = await waitOutDetails(mine);
  } finally { busy = false; stoppable = false; doneGrow(); paintDeep(); }
  logIt('sites.result', { error: out?.error, opened: out?.opened, filled: out?.filled,
    lost: out?.lost, places: out?.places, sites: out?.sites, why: out?.why });
  if (out?.id) S.resultId = out.id;
  if (S.chain) S.chain.sites = out || { lost: true };
  // Same rule as step two: on a chained run every ending is the RUN's ending, so it goes through
  // the one report rather than replacing it.
  const bail = (lead, why) => (chained
    ? runSummary({ problem: { lead, why } })
    : ask({ q: lead, sub: why,
        actions: [{ label: 'Open results', value: 'open', kind: 'go' },
          { label: 'Done', value: false }],
      }).then((v) => { if (v === 'open') openResults(); }));
  if (!out) {
    return bail('Lost track of that pass.',
      'The reply never came back — switching tabs or windows mid-run can drop it. The pass '
      + 'runs in the background and whatever it read is saved. Open the results to see where '
      + 'it got to.');
  }
  if (out.error) {
    return bail('Could not read their websites.', out.error === 'LIST_GONE'
      ? 'The list this table came from is no longer on the page, and the addresses have to be '
        + 'filed onto its rows. Everything already gathered is saved — scan the list again to '
        + 'add emails to it.'
      : `${esc(out.error)}. Everything already gathered is saved.`);
  }
  // THE END OF THE CHAIN. One card, and it describes the whole run rather than this pass — see
  // `runSummary`. The pass's own card below stays for the case it was written for: somebody
  // pressing "find emails" on its own, on a table that was already read.
  if (chained) return runSummary({});
  const { filled = 0, opened = 0, lost = 0, places = 0, sites = 0 } = out;
  await ask({
    q: filled
      // The figure that matters is ROWS with an address, not sites visited: a chain with three
      // branches is one site and three leads, and the table is what the user is taking away.
      ? `<b>${places}</b> row${places === 1 ? '' : 's'} now carry an email.`
      : `Read <b>${opened}</b> website${opened === 1 ? '' : 's'}, and none of them published an email.`,
    sub: filled
      ? `From <b>${sites}</b> site${sites === 1 ? '' : 's'} — the homepage first, then its contact `
        + 'page when the homepage held nothing. The column says where each address came from, '
        + 'because they are not all worth the same: one on the business\'s own domain is theirs, '
        + 'one on Gmail is usually the owner\'s, and one on some third party\'s domain may belong '
        + 'to whoever built the site.'
        + (lost ? ` <b>${lost}</b> did not answer at all — a dead domain, or a site that refused. `
          + 'Pressing this again retries exactly those.' : '')
        + (out.noSite ? ` <b>${out.noSite}</b> of the rows list no website, so there was nowhere `
          + 'to look.' : '')
        + (out.already ? ` <b>${out.already}</b> had already been read.` : '')
      : 'Plenty of businesses publish a contact form and no address, and there is nothing behind '
        + 'a form to read. The rest of the table is untouched.'
        + (lost ? ` <b>${lost}</b> did not answer at all.` : ''),
    actions: [
      { label: 'Open results', value: 'open', kind: 'go' },
      { label: 'Done', value: false },
    ],
  }).then((v) => { if (v === 'open') openResults(); });
}

export { init, afterScan };
