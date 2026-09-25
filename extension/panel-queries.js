// Small asks of the worker that report back rather than act: the state of a detail pass, which
// sites a third step would read, table detection, and opening a saved result.
import { $, sameSite } from './panel-util.js';
import { S, tab } from './panel-state.js';
import { send, logIt } from './panel-shell.js';

// SIT WITH A PASS WHOSE REPLY WAS LOST, until the worker says it is done.
//
// Reported as "Not enough room to open them ... while the step 2 still progressing". The panel's
// send bound is five minutes; the pass took 9m51s and finished all 123 records. Nothing was wrong
// with it — the panel had simply stopped listening, and the branch that handles "no answer" said
// the window was too narrow.
//
// The worker keeps the pass's progress (`detailRun`), so this asks rather than assumes: while it
// reports `running`, keep waiting and keep the count on screen; when it stops, take the real
// result. A pass with no state at all — a worker that really did die — returns null, and the caller
// says THAT, which is a different sentence.
const DETAIL_ASK_MS = 2000;
const DETAIL_GIVE_UP_MS = 45 * 60 * 1000;   // an hour-long list is somebody else's problem

async function waitOutDetails(tabId) {
  const began = Date.now();
  let seen = null;
  while (Date.now() - began < DETAIL_GIVE_UP_MS) {
    const st = await send({ type: 'DETAILS_STATE', tabId }).catch(() => null);
    if (!st) return seen ? { ...seen.result, why: seen.result?.why || 'the pass stopped reporting' } : null;
    seen = st;
    if (!st.running) return st.result || null;
    // The sheet's own ticker is still polling `progress` and painting the figures — `doneGrow`
    // does not run until this returns — so there is nothing to repaint here. Only the log needs
    // to say that the panel is waiting rather than wedged.
    logIt('details.waiting', { opened: st.opened, filled: st.filled, total: st.total });
    await new Promise((r) => setTimeout(r, DETAIL_ASK_MS));
  }
  return seen?.result || null;
}

// WHAT THE THIRD STEP WOULD READ, asked of the engine rather than counted off the saved table.
//
// The number in the offer has to be the number the pass will visit, and those differ when they
// come from two rules. The table's Website column holds a cell per row — including the Facebook
// pages people type into Maps as their website, the booking vendors, and the two branches of one
// chain that share a domain. `slinks` applies the rules the pass applies, so the offer states
// what is about to happen rather than an upper bound on it.
async function sitesToRead(tabId) {
  const mine = tabId ?? tab?.id;
  if (!mine) return null;
  const d = await send({ type: 'ROWS', tabId: mine, op: { action: 'slinks' } }).catch(() => null);
  if (!d || d.error || !(d.links || []).length) return null;
  return { sites: d.links.length, places: d.places || 0, none: d.none || 0,
    already: d.already || 0 };
}

async function showResults(id) {
  const r = await send({ type: 'OPEN_RESULTS', id });
  if (r?.error) $('log').textContent = 'Could not open results: ' + r.error;
}

// --- rows -------------------------------------------------------------------
// Detection runs inside the same passive read that already looks for files, so
// there is nothing to press and nothing to decide. Six milliseconds, and the
// panel reports what it found. Everything that ACTS on a table — export,
// loading more, correcting the guess, renaming columns — lives in the results
// window next to the table itself.
// Counting only. `detect` is a read — one sweep of the element list, no DOM
// changes, nothing written — so it is safe on the 2.5-second poll. Pulling the
// cells out of every row is NOT: on a 246-row table that is thousands of node
// visits plus a storage write, every 2.5 seconds, forever. That work waits until
// someone actually opens the results.
// DETECTION ONLY — it draws nothing. The chips this used to render were removed (see the note
// near the top of this file); what survives is the one thing that decision still needs: a
// page whose content is a table and no files has something worth opening, and only a detect
// can say so.
async function readTables() {
  if (!tab?.id) return;
  // ASKED ABOUT ONE PAGE, ANSWERED FOR WHOEVER IS CURRENT. `detect` is a round trip to the
  // content script, and a deep scan's own row phase can keep this in flight for a while — long
  // enough for the person to navigate to an entirely different site before it resolves. Without
  // this stamp the late answer still lands: 2GIS's list names and counts drawn over "on
  // allbirds.com", untouched by anything short of closing and reopening the panel, because
  // nothing else ever re-ran `readTables` to overwrite it. Same discriminator `sync` already
  // uses for a real move — tab id or a different origin — checked again on the way back in.
  const askedTab = tab.id, askedUrl = tab.url;
  const stillCurrent = () => tab?.id === askedTab && sameSite(tab?.url, askedUrl);
  try {
    const d = await send({ type: 'ROWS', tabId: tab.id, op: { action: 'detect' } });
    if (!stillCurrent()) return;
    const found = (d && !d.error && d.tables) || [];
    if (!found.length) return;
    // There is something worth opening even on a page with no files at all.
    if (!S.resultId) $('open').hidden = false;
  } catch (_) { /* a page that will not be read is not worth a message here */ }
}

export { waitOutDetails, sitesToRead, showResults, readTables };
