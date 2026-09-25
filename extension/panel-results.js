// How a run is shown: `openResults` reads (or re-reads) the table and opens the results window;
// `runSummary` is the one card at the end of a chained run.
import { $, esc, clock } from './panel-util.js';
import { S, tab, SCAN } from './panel-state.js';
import { send, logIt } from './panel-shell.js';
import { freshTraits, chainStart } from './panel-sheet.js';
import { ask } from './panel-card.js';
import { showResults } from './panel-queries.js';
import { liveGrow } from './panel-live.js';

// Two intents, and they must not share a default.
//
//   walk:true   the tail of a deep scan — wake the page, grow the list; opens only when show:true.
//   walk:false  the Open button — show what is on the page now. A read, nothing more.
//
// This did the first thing always, so the small ghost icon whose entire label is "Open
// results" kicked off a walk with up to twenty presses. `prime:false` is what makes the
// read a read: the engine skips the walk and the hop loop and never touches the scroll.
async function openResults({ resume = false, walk = false, reuse = false, show = true,
  brief = false } = {}) {
  // OPENING A TABLE IS NOT A REASON TO READ THE PAGE AGAIN.
  //
  // This function always extracted first, so pressing "Open results" after a walk re-read whatever
  // the tab was showing — one screenful, no hops — and handed that over instead. Measured: a walk
  // gathered 69 rows over 4 hops, the button then saved 71 rows with hops=0, and the export was
  // the second one. `reuse` is passed by the callers that already HAVE the table and only want it
  // on screen; every other caller keeps extracting exactly as before.
  // Any caller, not only the ones that remember `reuse`: a table already read is shown as it stands.
  if (!walk && S.resultId && (reuse || S.resultId === S.tableId)) { await showResults(S.resultId); return; }
  if (tab?.id) {
    const d = SCAN;
    // What this page answered last time about pressing, and the control it was shown.
    let mem = null;
    if (walk) {
      try { mem = (await send({ type: 'POINT_MEMORY', url: tab.url }))?.point || null; } catch (_) {}
    }
    // `pressThisRun` is the override for one run; otherwise the page's own answer, and
    // otherwise no pressing until asked — nothing is pressed on a page that has not
    // been asked about, which is what the half-card is for.
    // Pressing is the default. The first pass used to scroll only and then ask — so
    // "deep scan" delivered a fraction and a question, which read as broken. `S` still
    // scans press-free for one run; a page answered "It has ended" stays quiet via mem.
    const press = S.pressThisRun != null ? S.pressThisRun : mem?.press !== false;
    // STOP MUST NOT BUY A SECOND SCAN. `brief` is the row walk that runs AFTER a Stop: the
    // phase still has to run (skipping it is what capped the table at the ~9 posts the DOM
    // happens to mount) but it must READ what is already there, not go hunting for more.
    // At full settings this phase is 12 wake presses and its own budget — minutes of hops —
    // which is why a Stop at 1:00 was still climbing "hop 9" at 2:56 with the button
    // disabled and no way out. One hop, no pressing, a few seconds.
    // Cheap because the rows are already in hand, not because it settles for fewer: the
    // window accumulator holds every row seen this scan, and on X the Redux read hands over
    // the whole session's posts in one pass with no hopping at all.
    const op = walk
      ? (brief
        ? { action: 'extractAll', hops: 1, budget: 8000, resume,
            wakePresses: 0, deadPresses: 1, clickMore: false }
        : { action: 'extractAll', hops: d.hops, budget: d.budget, resume,
            wakePresses: d.wakePresses, deadPresses: d.deadPresses,
            clickMore: press, moreSelector: mem?.selector })
      : { action: 'extractAll', prime: false };
    const doneGrow = walk ? liveGrow('Reading the list', 'rows') : null;
    const ex = await send({ type: 'ROWS', tabId: tab.id, op }).catch(() => null);
    // HELD WHEN THERE IS A SECOND STEP COMING. This is the end of step one, and the very next
    // thing that happens is the results window opening — a heavy operation, and the last place
    // this run can afford to have no Stop on screen. `afterScan` closes it on every path that
    // does not hand over, so nothing is left standing over a finished run.
    if (doneGrow && !S.sawChainable) doneGrow();
    if (ex?.id) S.resultId = ex.id;
    if (walk && ex?.id) S.tableId = ex.id;
  }
  if (!S.resultId) return;
  if (!show) { $('open').hidden = false; return; }
  await showResults(S.resultId);
}

// --- what the whole run did --------------------------------------------------
//
// ONE card, ONCE, at the end. This is not the status panel that the half-card replaced and it
// must not become one: it appears when the run is over, it is dismissed like every other card,
// and nothing brings it back except another run.
//
// It exists because the run is now three passes deep and nobody watches all of it. When each
// step reported itself between confirmation clicks, the reader saw all three cards go past; with
// the clicks gone they would see only the last one, which describes the smallest of the three
// passes. "63 rows now carry an email" says nothing about the hundred and twenty-four rows, the
// hundred and twenty-one records, or the eleven sites that never answered.
//
// AND IT STATES WHAT FAILED. A report that lists only what worked is worse than no report,
// because it is the one that gets believed: today's exports had rows with no details and sites
// that never answered, and the person found that out in the spreadsheet.
async function runSummary({ problem = null, stoppedAt = 0, detailed: knownDetailed = 0 } = {}) {
  const c = S.chain || chainStart();
  S.chain = null;                        // shown once — a second call has nothing to draw
  const secs = Math.max(0, Math.round((Date.now() - c.t0) / 1000));
  const d = c.details || {};
  const s = c.sites || {};

  // THE ROWS AS THE TABLE HOLDS THEM, asked of the engine rather than added up from three passes
  // that each count something slightly different. `detailed` is the only honest answer to "how
  // many of these carry their details" — the pass's own `filled` counts writes, and a write that
  // the page refused is not a row with details on it.
  let rows = c.list?.rows || d.rows || s.rows || 0;
  let detailed = 0;
  try {
    const p = await send({ type: 'ROWS', tabId: c.tabId ?? tab?.id,
      op: { action: 'progress' } });
    if (p && !p.error) { rows = p.uniq ?? p.rows ?? rows; detailed = p.detailed || 0; }
  } catch (_) { /* the list tab may be gone; the ledger still has numbers */ }
  // AND THE ENGINE CANNOT ALWAYS ANSWER IT. `progress.detailed` counts details filed in the
  // PAGE's bag, which is where the tab lanes put them. A fetch lane writes into the saved table
  // instead — nothing reaches the page — so this comes back 0 for a run that detailed every row.
  // Where the caller counted, its figure is the true one.
  if (knownDetailed > detailed) detailed = knownDetailed;
  if (knownDetailed && rows < knownDetailed) rows = knownDetailed;

  const viaFetch = d.viaFetch || 0;
  const viaTab = d.viaTab || 0;
  const viaRail = d.viaRail || 0;
  const noDetail = Math.max(0, rows - detailed);
  // RECORDS ARE NOT ROWS, and this card printed them as if they were.
  //
  // Measured on a live run: `Step 2 · their details — 111 of 111 rows carry them; 120 answered
  // without opening anything.` A hundred and twenty of a hundred and eleven. Both numbers were
  // right and putting them in one sentence made the card unbelievable — which is worse than
  // leaving one of them out, because a reader who catches an impossible sum stops trusting the
  // lines they cannot check.
  //
  // The rail lists a record per row ELEMENT; the table keys them, so two cards for one place
  // become one row. `lanes.start rows=120 records=120`, `progress uniq=111`. So the fetch/tab
  // split is stated against the records the pass actually read, named as records, and the gap
  // between the two counts is stated on its own line rather than left to be noticed.
  const records = (d.filled || 0) + (d.left || 0);

  // What each step got, one line each, in the order they ran.
  // THE FUNNEL — one bar per step, drawn to scale, in the same pixel blocks the live meter uses.
  //
  // The summary was four paragraphs of prose, and prose is the wrong instrument for "where did the
  // run lose rows". Three bars answer it without being read: a step that kept everything is full,
  // a step that dropped some is visibly short, and the gap is the loss. The blocks are `.g-seg`,
  // the same element the running card fills — so the end card is the running card at rest rather
  // than a second visual language for the same three facts.
  const SEGS = 20;
  const bar = (_of, got) => {
    const base = rows || 0;
    const lit = base > 0 ? Math.round(Math.max(0, Math.min(1, got / base)) * SEGS) : 0;
    let out = '<span class="fbar">';
    for (let i = 0; i < SEGS; i++) out += `<i class="g-seg${i < lit ? ' on' : ''}"></i>`;
    return out + '</span>';
  };
  const step = (n, name, got, of, val, note) =>
    `<li class="fstep"><span class="fhead"><span class="fname">`
    + `<i class="fnum">${n}</i>${esc(name)}</span><b>${val}</b></span>`
    + bar(of, got) + (note ? `<span class="fnote">${note}</span>` : '') + '</li>';

  const did = [];
  did.push(step(1, 'the list', rows, rows, `${rows}`, ''));
  if (c.details) {
    // HOW they were read, because the two cost the user completely different things: a fetched
    // record is one request, a tabbed one is a whole Google Maps loading in the background.
    const how = [
      viaFetch ? `<b>${viaFetch}</b> answered without opening anything` : '',
      viaTab ? `<b>${viaTab}</b> needed a tab opening` : '',
      viaRail ? `<b>${viaRail}</b> came from the list itself` : '',
    ].filter(Boolean).join(', ');
    did.push(step(2, 'their details', detailed, rows, `${detailed} of ${rows}`,
      how + (records > rows
        ? `${how ? ' · ' : ''}<b>${records - rows}</b> of the rail's <b>${records}</b> resolved to rows already held`
        : '')));
  }
  if (c.sites) {
    // THE SPLIT, SAID OUT LOUD — step two reports it and step three did not, so a run where the
    // fetch sweep answered most of the list looked identical to one where it answered none and
    // every site was opened. That is exactly the reading the user made, and they were right to:
    // the card gave them no way to tell. `byFetch`/`byTab` were already computed and returned.
    const swept = (s.byFetch || 0) + (s.byTab || 0);
    const note3 = [
      s.filled ? `<b>${s.filled}</b> published an email` : '',
      swept && s.byFetch ? `<b>${s.byFetch}</b> answered without opening anything` : '',
      s.byTab ? `<b>${s.byTab}</b> needed a tab` : '',
      s.lost ? `<b>${s.lost}</b> did not answer` : '',
    ].filter(Boolean).join(' · ');
    // NOT DRAWN ON A PROVIDER THAT HAS NO THIRD STEP. 2GIS publishes the email inside the record,
    // so nothing ever visits a business's own website — and a card reporting "their websites 0 of
    // 0" beside "12 rows list no website at all" describes work that does not exist, on records
    // that mostly DO carry a website. It reads as a failure and it is an absence.
    if (((await freshTraits()).steps || 3) >= 3) {
      did.push(step(3, 'their websites', s.opened || 0, s.sites || 0,
        `${s.opened || 0} of ${s.sites || 0}`, note3));
    }
  }

  // AND WHAT DID NOT WORK. Each of these is a real hole in the export and the reader is about to
  // open that export.
  const missed = [];
  if (stoppedAt) missed.push(`Stopped during step <b>${stoppedAt}</b> — everything read is in the table.`);
  if (noDetail > 0) {
    missed.push(`<b>${noDetail}</b> row${noDetail === 1 ? '' : 's'} carry no details`
      + (d.left ? ` — <b>${d.left}</b> of them were never opened` : '') + '.');
  }
  if (d.skipped) missed.push(`<b>${d.skipped}</b> were suggestion cards, not places — skipped.`);
  if (d.walled) {
    missed.push('<b>Google asked to verify you are a person.</b> The tab holding the challenge was '
      + 'left open; clearing it and running again picks up only what is missing.');
  }
  if (d.walkShort) missed.push(`<b>${d.walkShort}</b> record pages did not finish drawing.`);
  if (s.lost) {
    // The bar already carries the count; this line exists for the RECOVERY, which no bar can say.
    missed.push(`Those <b>${s.lost}</b> that did not answer are a dead domain, `
      + 'or a site that refused. Running the third step again retries exactly those.');
  }
  if (s.notMine) {
    missed.push(`<b>${s.notMine}</b> site${s.notMine === 1 ? ' sat' : 's sat'} on a shared host `
      + `(Linktree, a booking vendor), so nothing on ${s.notMine === 1 ? 'it' : 'them'} belongs to `
      + 'that business and nothing was filed.');
  }
  if (s.noSite) missed.push(`<b>${s.noSite}</b> rows list no website at all.`);
  if (d.zoomed && d.zoomed !== 1) {
    missed.push(`The map is still zoomed to <b>${Math.round(d.zoomed * 100)}%</b> — left there on `
      + 'purpose, since resetting it moves the map. <b>Cmd/Ctrl + 0</b> undoes it.');
  }
  if (d.framesReload) {
    missed.push('<b>Reload this tab once</b> before the next run, or a background tab cannot draw '
      + 'and the record pass stops early.');
  }

  logIt('chain.summary', { secs, rows, detailed, viaFetch, viaTab, viaRail,
    sites: s.sites, sitesRead: s.opened, emails: s.filled, misses: missed.length,
    problem: problem?.lead || '', stoppedAt });

  await ask({
    // The elapsed time belongs in the headline. It is the one number that answers "was that
    // normal", and a run that took four minutes and one that took forty look identical
    // everywhere else on this card.
    q: problem ? problem.lead
      // THE NEWLINE BETWEEN THESE TWO IS LOAD-BEARING, and it is not about layout — both spans
      // are `display:block`, so whitespace between them collapses and nothing moves. It is about
      // the TEXT. Butted together they read `Done in 3s124 rows` in `textContent`, which is what
      // a screen reader says out loud and what any assertion on this card sees. The clock and the
      // count are two separate facts and must not fuse into a number that means nothing.
      : `<span class="fclock">Done in ${clock(secs)}</span>\n<span class="frows">${rows} rows</span>`,
    sub: (problem ? `<p class="hlead">${problem.why}</p>` : '')
      + `<ul class="funnel">${did.join('')}</ul>`
      + (missed.length ? `<ul class="faults">${missed.map((b) => `<li class="miss">${b}</li>`).join('')}</ul>` : ''),
    note: missed.length ? '' : 'Everything asked for was read.',
    actions: [
      { label: 'Open results', value: 'open', kind: 'go' },
      { label: 'Done', value: false },
    ],
  }).then((v) => { if (v === 'open') openResults(); });
}
export { openResults, runSummary };
