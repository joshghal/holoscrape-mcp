// HoloScrape — service worker: driving the row engine (rows.js) and the pointer (point.js) in a page.
import { pageRows } from './rows.js';
import { DESCRIPTORS } from './providers.js';
import { pagePoint } from './point.js';
import { DEV } from './env.js';
import { restrictedHost, walking, scrollHome, scrollPinned, hopCancel, hopProgress, detailedAt,
  DETAIL_EMBARGO_MS, walledUntil, noteWall } from './bg-state.js';
import { note, devLog, saveLog, PASSIVE_OP } from './bg-log.js';
import { keepAwake, startPump, stopPump } from './bg-awake.js';
import { saveResult, itemsFromTables, walkSession } from './bg-store.js';

// --- rows ------------------------------------------------------------------
// Row detection is a conversation, not a one-shot: detect, look, cycle, extract.
// So it runs in the TOP frame only and keeps its candidate list on the page's
// window between calls. All-frames would multiply the candidate list by every
// ad iframe on the page, and the user cannot see into those anyway.
// Any tab we have outlined, so the marks can be taken off again. An extension
// that leaves a yellow box on someone's page after it closes has vandalised the
// page, not annotated it.
const marked = new Set();

// THE WALK CLAIM, PUBLISHED WHERE THE OTHER ENGINE CAN SEE IT.
//
// `walking` lives in this worker and stops a scan from STARTING. It cannot reach a scan that is
// ALREADY running inside the page, and that scan keeps scrolling — so two drivers fight over one
// pane for the rest of its budget. Measured on the recycler fixture: a harvest that must begin at
// Record 0 and return 400 began at Record 385 and returned 392.
//
// The first attempt was a heartbeat the page engine refreshed as it stepped, and it was wrong for a
// reason worth recording: a freshness window is a guess about how long a hop takes. Under a loaded
// machine a legitimate hop exceeded it, the stamp went stale, the asset walk resumed, and the same
// collision came back — green alone, red in the parallel suite. So the claim is AUTHORITATIVE now:
// set when the walk is claimed, cleared when it is released, no timing involved.
//
// The generous expiry is a self-heal, not a mechanism: if this worker is evicted between set and
// clear, the flag would otherwise mute asset scanning on that page until it reloaded. No real hop
// gap approaches a minute, so nothing legitimate is cut short by it.
const WALK_FLAG_MS = 60000;
async function markWalking(tabId, on) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: (set, ttl) => {
        if (set) window.__holoscrapeWalk = { at: Date.now(), ttl };
        else delete window.__holoscrapeWalk;
      },
      args: [!!on, WALK_FLAG_MS],
    });
  } catch (_) { /* a page that will not take an injection cannot be scanned either */ }
}

export async function clearMarks() {
  const ids = [...marked];
  marked.clear();
  for (const tabId of ids) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] }, world: 'MAIN', func: pageRows,
        args: [{ action: 'clear' }],
      });
    } catch (_) { /* tab is gone, which also removes the marks */ }
  }
}

// Injected on its own, not through the engines: both are busy in a loop, and a message
// to the worker cannot interrupt them. A separate one-line injection can, because
// executeScript runs concurrently with the script already running.
// Stopping has to reach the worker too. The flag it sets lives on the PAGE, which is
// where both engines read it — but a tab hop runs here, in the worker, and never looks at
// the page at all. So Stop set the flag, the page-side loops obeyed it, and background
// tabs kept opening one after another for as many pages as were left. This is the other
// half of the same switch.

export async function stopScan(tabId) {
  hopCancel.set(tabId, Date.now());
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: 'MAIN',
      func: () => { window.__holoscrapeStop = true; },
    });
    return { stopped: true };
  } catch (e) {
    return { error: 'NO_ACCESS' };
  }
}

export async function runPoint(tabId, op) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: 'MAIN',
      func: pagePoint, args: [op || {}],
    });
    return res?.result || { error: 'NO_RESULT' };
  } catch (e) {
    if (/Cannot access|host permission|Missing host/i.test(e.message)) return { error: 'NO_ACCESS' };
    throw e;
  }
}

// A pointed-at control is remembered per origin + path SHAPE, so /search?q=kopi and
// /search?q=teh share one memory. Keyed that way because the control is a property of
// the template, not of the query.
const pointKey = (u) => {
  try { const x = new URL(u); return `point:${x.origin}${x.pathname}`; } catch { return ''; }
};

export async function rememberPoint(pageUrl, rec) {
  const k = pointKey(pageUrl);
  if (!k) return;
  await chrome.storage.local.set({ [k]: { ...rec, at: Date.now() } });
}

export async function recallPoint(pageUrl) {
  const k = pointKey(pageUrl);
  if (!k) return null;
  return (await chrome.storage.local.get(k))[k] || null;
}

export async function forgetPoint(pageUrl) {
  const k = pointKey(pageUrl);
  if (k) await chrome.storage.local.remove(k);
}

// Which install this is. Written when Chrome installs or updates the extension, read
// once and kept in memory. It travels into the page with every row op so the engine can
// tell state it made from state the LAST install left lying on the page — see the note
// at the top of pageRows. A worker restart must not change it, which is why it is a
// stored install stamp and not simply the time this worker booted.
let epoch = 0;
chrome.runtime.onInstalled.addListener(() => {
  // Never while a value is already in flight. onInstalled can land AFTER the first row op
  // of a scan has already stamped the page — and changing the stamp then wipes the state
  // that scan is building, which cost a whole deep scan its rows and its trip home. A
  // genuine install or update always gets a fresh worker, where this is empty.
  if (epoch) return;
  epoch = Date.now();
  chrome.storage.local.set({ epoch });
});
async function currentEpoch() {
  if (epoch) return epoch;
  const r = await chrome.storage.local.get('epoch');
  // Persisted even when invented, so the value handed out now is the value read back
  // later. Left unwritten, every worker restart handed out a different one.
  epoch = r.epoch || Date.now();
  if (!r.epoch) await chrome.storage.local.set({ epoch });
  return epoch;
}

// A DOCUMENT LOAD DESTROYS THE CONTEXT A WALK RUNS IN, AND CHROME DOES NOT RELIABLY SAY SO.
//
// `page.walk` presses things from INSIDE the page. Press an ordinary <a href> and the frame it is
// running in is replaced — and the `executeScript` promise does not always reject. Measured three
// times now, twice on Stack Overflow: the tab lands correctly, the walk simply never answers, and
// the only backstop is the client's ceiling. That ceiling is TEN MINUTES, because a real walk of a
// hundred presses needs it. So the failure looks exactly like a long walk that is still working,
// for ten minutes, and the session that hit it had already finished the job it was asked to do.
//
// WHAT DOES NOT WORK, MEASURED: `status: 'loading'` on tabs.onUpdated looked like a free
// discriminator — a document commit reports it, a pushState reports only a changed url. Chrome
// reports it for BOTH, so a guard built on it trips on every SPA route change and repeals the exact
// walk the tool exists for. The control case in `test/walk-nav.mjs` caught that on the first run.
//
// `performance.timeOrigin` is the honest one: it is a property OF THE DOCUMENT, so a new document
// has a new value and a pushState has the same one. Read only when something plausible has happened
// — the onUpdated signal stays as the cheap trigger, and the stamp is what decides.
async function docStamp(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: 'MAIN', func: () => performance.timeOrigin,
    });
    return Number(r?.result) || 0;
  } catch (_) { return 0; }         // mid-navigation the injection can throw; that is not an answer
}

function navGuard(tabId, stamp0) {
  let stop = () => {};
  const tripped = new Promise((_, reject) => {
    const onUpd = async (id, info) => {
      if (id !== tabId || info.status !== 'loading') return;
      const now = await docStamp(tabId);
      if (!now || !stamp0 || now === stamp0) return;   // same document — a route change, not a load
      const e = new Error('NAVIGATED');
      e.navigatedTo = info.url || '';
      reject(e);
    };
    chrome.tabs.onUpdated.addListener(onUpd);
    stop = () => { try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (_) {} };
  });
  tripped.catch(() => {});          // the op winning the race must never be an unhandled rejection
  return { tripped, stop };
}

// THE OTHER HALF OF THE SAME FAILURE. A walk whose frame is destroyed does not always hang — it can
// also come back with nothing, and `NO_RESULT` tells the caller precisely as little as silence did.
// Same cause, same advice, so it gets the same answer.
function crossDocument(startedAt, landedOn) {
  return {
    error: 'CROSS_DOCUMENT',
    startedAt,
    landedOn,
    why: 'that press was an ordinary link, not an in-page control, so the browser loaded a new '
      + 'document and destroyed the frame the walk was running in. THE TAB ARRIVED — only the '
      + 'walk\'s answer is gone. page_grow mode:"walk" is for same-document presses (routes, panels, modals) '
      + 'and cannot cross a document boundary.\n'
      + 'Use tab_here to send a tab to a URL, and page_harvest to visit many URLs and keep their '
      + 'rows. Neither runs inside the page, so neither can be torn down by a load.',
  };
}

export async function runRows(tabId, op) {
  // Claimed synchronously, before the first await. Claiming it after one — which is
  // where this started — leaves a window in which a poll fired between the call and
  // the claim and got waved through, which is precisely the collision being
  // prevented.
  // `studypress` is `page_grow` over the bridge: it changes the page and then waits seconds for
  // rows to arrive, usually in a tab the person is NOT looking at — an agent drives a background
  // tab by design. A list that mounts its rows from requestAnimationFrame never mounts them in a
  // hidden tab without the pump, so an unarmed page_grow would report grew:false about the tab's
  // visibility rather than about the list. Armed exactly like the walks; the claim also keeps the
  // panel's passive poll from colliding with a page mid-press.
  // `collect` BELONGS HERE AND WAS MISSING, which only became visible once the asset walk could
  // move a list at all. `collect` scrolls the page a viewport at a time for up to 400 hops — it is
  // a walk by every definition this line uses — but it never claimed the tab, so `runScan`'s
  // `walking` refusal did not apply to it and the passive poll's asset walk drove the SAME pane
  // concurrently. Measured on the recycler fixture: a harvest that should start at Record 0 and
  // return 400 started at Record 385 and returned 392, because something else was scrolling.
  // Nothing about the asset walk was wrong; it was the only writer that announced itself.
  //
  // AND IT KEYS ON WHAT THE OP DOES, NOT ON WHAT IT IS CALLED — which is why this took three tries.
  // Adding `'collect'` above fixed only half of it, invisibly: `page_grow({collect})` does arrive
  // with that action, but `page_state path:"@collect(...)"` — the form the tests and every agent
  // actually use — arrives as action `'state'` carrying a PATH. So the claim kept not firing, the
  // collision kept coming back, and the list of names looked complete the whole time. `@collect`
  // harvests a recycler and `@map` expands disclosures; both move the page, whatever they are named.
  const movingPath = op?.action === 'state' && /@(collect|map)\s*\(/.test(String(op.path || ''));
  const walks = op?.action === 'extractAll' || op?.action === 'scroll' || op?.action === 'pagehop'
    || op?.action === 'details' || op?.action === 'studypress' || op?.action === 'collect'
    || movingPath;
  // A tab hop drives runRows against OTHER tabs; the claim above is per tab, so nothing
  // extra is needed here — but `container` and `pagerows` are reads and must never claim.
  // `progress` is polled four times a second while a walk is running, so it must never
  // claim the page or wait for one.

  if (walks) { walking.add(tabId); await markWalking(tabId, true); }
  // A walk is minutes of in-page waiting, and the moment the user alt-tabs the page's own
  // clock is clamped. Armed + pumped for the duration, from here so every walking caller —
  // the panel's deep scan, keep-going, a page hop — inherits it without knowing.
  // Only pump a page that HAS a keeper. Anything but Maps answers 'absent', and ticking an
  // injection into it every 150ms for the length of a walk is pure cost — and on the asset walk,
  // whose budget is a wall clock, cost is not neutral.
  if (walks && (await keepAwake(tabId, true)) === 'armed') startPump(tabId);
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const blocked = restrictedHost(tab?.url || '');
    if (blocked) return { error: 'RESTRICTED', host: blocked };
    // A site that has just asked for verification is not asked again a minute later, and
    // the refusal lives HERE rather than in the panel so that every caller inherits it —
    // the panel, the results window, and a later stretch that resumes where one stopped.
    // Answering "prove you are a person" by immediately trying again is the move that
    // turns a slider into a block.
    if (op?.action === 'pagehop') {
      const cooling = walledUntil(tab?.url || '');
      if (cooling) {
        note('pagehop.cooling', { mins: Math.ceil(cooling / 60000) });
        return { error: 'COOLING', cooling, added: 0, pages: 0,
          why: 'the site asked for verification' };
      }
    }
    // Hand the remembered position to the row pass, which is the phase that finishes
    // last and therefore the one that owns putting the page back.
    if (op?.action === 'extractAll' && op.restoreTo == null && scrollHome.has(tabId)) {
      op = { ...op, restoreTo: scrollHome.get(tabId) };
      scrollHome.delete(tabId); scrollPinned.delete(tabId);
    }
    // Taken BEFORE the walk starts, because afterwards there is nothing left to compare against.
    const walkStamp = op?.action === 'walk' ? await docStamp(tabId) : 0;
    const shot = chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: pageRows,
      // The provider table travels INTO the page: the engine cannot import, so this is how
      // it learns which maps exist. See `providers.js`.
      args: [{ ...(op || {}), providers: DESCRIPTORS, epoch: await currentEpoch() }],
    });
    // ONLY THE WALK. Every other action here either cannot navigate or navigates on purpose and
    // expects to survive it — `pagehop` exists to load page seven. Guarding them all would repeal
    // behaviour that is working, so this stays on the one action whose contract is "same document".
    const guard = op?.action === 'walk' ? navGuard(tabId, walkStamp) : null;
    let res;
    try {
      [res] = await (guard ? Promise.race([shot, guard.tripped]) : shot);
    } catch (e) {
      if (!guard) throw e;
      // ANY rejection, not just the guard's own. MEASURED on Stack Overflow: the real failure did
      // not hang and did not come back empty — it rejected, with "A listener indicated an
      // asynchronous response by returning true, but the message channel closed before a response
      // was received". That is Chrome describing its own plumbing, it names no cause the caller can
      // act on, and the session that received it simply tried the same call again. The document
      // stamp is what decides; the error text only says something went wrong.
      const after = e?.message === 'NAVIGATED' ? 0 : await docStamp(tabId);
      if (e?.message !== 'NAVIGATED' && !(after && walkStamp && after !== walkStamp)) throw e;
      const now = await chrome.tabs.get(tabId).catch(() => null);
      return crossDocument(tab?.url || '', e.navigatedTo || now?.url || '');
    } finally { if (guard) guard.stop(); }
    // CAME BACK EMPTY BECAUSE THE DOCUMENT UNDER IT CHANGED. Checked only when there is nothing to
    // report anyway, so the ordinary path pays for none of it.
    if (guard && (!res?.result || res.result.error === 'NO_RESULT')) {
      const after = await docStamp(tabId);
      if (after && walkStamp && after !== walkStamp) {
        const now = await chrome.tabs.get(tabId).catch(() => null);
        return crossDocument(tab?.url || '', now?.url || '');
      }
    }
    if (op?.mark || op?.reveal) marked.add(tabId);
    if (op?.action === 'clear') marked.delete(tabId);
    const out = res?.result || { error: 'NO_RESULT' };
    // Tables are saved through the same door as files, so History and the results
    // window need no second code path — one entry per visit holds both.
    // A page hop returns a table the same way an extraction does, and it is saved the
    // same way — the rows it added are rows, wherever the URL they came from.
    // `noSave` is for the tabs a hop owns. Reading page seven of a list is not a visit to
    // page seven — the rows belong to the page the user is on, and they are handed there by
    // `pagerows`. Without this, a ten-page hop left ten junk entries in History, one per
    // page nobody asked to scan.
    const rereads = op?.action === 'extractAll' || op?.action === 'pagehop';
    // `details` sits with `pagerows` and `commit`, not with the rereads: it CARRIES what it
    // just collected off each record's own page. Refusing it during a walk would be
    // refusing the pass its own result.
    // `dtables` is the driven pass handing over what it collected, exactly as `details` was when
    // the loop lived in the page — it reads without walking and carries the details it just
    // gathered off each record. It belongs with the carriers, not with the rereads.
    if ((rereads || op?.action === 'pagerows' || op?.action === 'commit'
        || op?.action === 'details' || op?.action === 'dtables')
        // A WALK OWNS ITS RECORD. Nothing else may write the table while one is running.
        //
        // This is where ten pages became four. `hopHere` accumulates every page's rows and
        // rewrites the record after each one; meanwhile the panel's passive poll fires every
        // 2.5 seconds, extracts whatever page the tab is on RIGHT NOW, and lands here — and
        // `saveResult` REPLACES `tables` (it unions items, not tables). So a poll that caught
        // one page wrote its 48 rows over the 480 the walk had gathered, and the table went
        // backwards while the walk was still reporting progress.
        //
        // The panel guards its poll on the tab's URL, which is why this was survivable at all:
        // it only lands in the windows where the tab happens to be back on the URL it started
        // from. That is a race, and a race is not a guard. The refusal belongs here, in the one
        // place every writer passes through, and not in the caller that happens to misbehave.
        //
        // But it has to refuse the right callers, and the line is not who calls — it is what
        // the write is made of. `pagerows` and `commit` CARRY the rows they save: they are the
        // walk handing over the page it just read, which is the per-page append itself. Only
        // `extractAll` and `pagehop` go and read whatever the tab happens to be showing, and
        // that is the write that must not land mid-walk. Refusing both alike (which the first
        // version of this guard did) silences the walk's own commits and empties the table from
        // the other direction — every quiet and driven pass writes through `pagerows`.
        && !(rereads && hopProgress.has(tabId))
        // And not for a while after a details pass — see `detailedAt`. A re-read then is reading a
        // record's panel, not the list, and it would replace the table the pass just finished.
        && !(rereads && Date.now() - (detailedAt.get(tabId) || 0) < DETAIL_EMBARGO_MS)
        && out.tables?.length && !op.noSave) {
      const saved = await saveResult({
        // WHICH KIND OF WRITE THIS IS, carried so `saveResult` can tell a re-read from the pass's
        // own handover. `dtables` is bound to the list it started on; `extractAll` reads whatever
        // the tab is showing, which after a details pass is a RECORD.
        from: op.action,
        tables: out.tables,
        // The rows' own images ARE files, and they were already extracted — an asset
        // column is a column whose values came from src/srcset. Leaving `items` empty
        // here is what produced "1,393 rows but only 344 files": the asset walk collects
        // from the page as it stands, and the row phase then grows the list by another
        // thousand products whose images the walk had already gone past. Folding them in
        // costs nothing and cannot miss, because it is the same data the table shows.
        items: itemsFromTables(out.tables, tab?.url || ''),
        url: tab?.url || '',
        log: out.tables.map((t, i) =>
          `table ${i + 1}${t.label ? ` (${t.label})` : ''}: ${t.rows.length} rows x ${t.cols.length} columns`),
      }, tab?.url || '', await walkSession(tabId, tab?.url || '', walks));
      out.id = saved.id;
      // How many files the SAVED record now holds. The panel's headline counter is the
      // asset walk's number and nothing was refreshing it during a page hop, so twenty-three
      // pages of product photos landed in storage while the screen still read the count from
      // page one — which looks exactly like rows arriving and their images not.
      out.files = (saved.result?.items || []).length;
      note('save', { action: op.action, id: saved.id, tab: tabId,
        rows: out.tables?.[0]?.rows?.length ?? -1, url: (tab?.url || '').slice(-40) });
      // HOW THE WALK WAS LEFT. One line, and the whole reason step 1 was undiagnosable: the log
      // carried tags for the details pass, the page hop and every message, and nothing at all for
      // the walk that gathers the rows. A rail that stopped at 31 of 120 read identically to a
      // rail that only had 31.
      if (out.walk) {
        // Both reasons, because they answer different questions: `endedBy` is the page's own
        // account (it declared the end, or it went quiet), `walkEndedBy` is which of this loop's
        // four exits fired. When they disagree, that disagreement is the finding.
        // `focus` and `lost` alongside `hidden`, because `hidden` answers a narrower question than
        // anyone reading this line assumes — see the note by `walkFocus` in rows.js. A walk that
        // stopped because the window was clicked away from logged `hidden=false`, which reads as
        // "the tab was fine", and `endedBy=nothing arrived for 10s`, which reads as "the list
        // ended". Two innocent-looking fields describing a lost run.
        note('rows.walk', { rows: out.walk.rows, hops: out.walk.hops, hidden: out.walk.hidden,
          focus: out.walk.focus, lostFocus: out.walk.lost,
          recycling: out.walk.recycling, endedBy: out.endedBy || '', walkEndedBy: out.walk.endedBy,
          tables: out.tables?.[0]?.rows?.length ?? -1 });
      }
      // Written when an extraction the user asked for lands. `detect` is the panel's passive
      // read — it runs on every poll tick — and the driven detail steps each save as they go,
      // so neither may write a file or the folder fills with one log per second.
      if (DEV && devLog && !PASSIVE_OP.test(op.action || '')) saveLog().catch(() => {});
    }
    // Recorded wherever it happens, not only in the tab passes. The in-page hop is the
    // FIRST thing that touches a site, so it is the first thing to be told no — and the
    // cooldown is worth nothing if the pass that heard the answer is the one pass that
    // does not write it down.
    if (op?.action === 'pagehop' && /verification/.test(out.why || '')) noteWall(tab?.url || '');
    return out;
  } catch (e) {
    if (/Cannot access|host permission|Missing host/i.test(e.message)) return { error: 'NO_ACCESS' };
    throw e;
  } finally {
    // Disarmed on the same path that releases the claim, so a stop, an error and a finish all
    // put the page's scheduling back — but ONLY if nobody else still holds it. A details pass
    // is an owner too, and disarming its keeper from under it is what turned `frames` to `off`
    // 55 records into a 124-record run.
    // THE PAGE FLAG IS CLEARED WHETHER OR NOT WE STILL OWNED THE WORKER-SIDE CLAIM.
    //
    // It used to hang off `walking.delete(tabId)` returning true, and something else deletes that
    // set — `abandon` drains it with `while (walking.has(tabId)) if (walking.delete(tabId)) break;`.
    // When that ran first, this `if` was false, `markWalking(false)` never fired, and the flag stayed
    // on the PAGE for its full 60-second life. For that whole minute every asset scan read the flag,
    // yielded on its first step, and returned one screenful — about twenty files on a long thread,
    // which is exactly the number that kept coming back while the walk itself was working fine.
    //
    // Two separate things, so two separate statements: releasing the worker's claim is bookkeeping,
    // clearing the page's flag is a promise to the other engine and must not depend on it.
    if (walks) {
      if (walking.delete(tabId)) { stopPump(tabId); await keepAwake(tabId, false); }
      await markWalking(tabId, false);
    }
  }
}
