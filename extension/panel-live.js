// The live sheet's ticker: `liveGrow` opens the sheet for a phase and repaints its gauge twice a
// second off the engine's own counters, until the closer it returns is called.
//
// test/panel.mjs greps this function's text (`function liveGrow`, `!liveTimer || … !== liveTab`, the
// `HOP_STATUS` read falling back to `lastHop`), so `liveTimer`/`liveTab`/`tab` stay bare here.
import { $, esc } from './panel-util.js';
import { S, tab, liveTimer, liveTab, setLiveTimer, setLiveTab } from './panel-state.js';
import { send, logIt } from './panel-shell.js';
import { gauge, stepOf, head, closeLive, stopScan } from './panel-sheet.js';

let liveT0 = 0;

// The sheet as a progress surface: no question, one Stop, and the numbers the user
// asked to see — rows, hop N of M, elapsed — updating twice a second off the engine's
// own counters. Returns the closer.
// One timer for the whole scan: phases hand the sheet to each other by calling this
// again, which retitles without hiding — no flicker between "opening media" and
// "reading the list". The sheet is up from the moment Deep scan is pressed, because a
// scan whose progress lives somewhere you are not looking reads as a hang.
function liveGrow(title, phase = 'rows', tabId) {
  // Every phase change, so the file reads as a sequence of what the run was doing rather than a
  // pile of worker internals.
  logIt('phase', { phase, title });
  // A CHANGE OF TAB IS A CHANGE OF RUN, whatever the timer says. Everything reset here belongs to
  // one pass over one page, and `liveTab` is what that pass is pinned to — so a chained run moving
  // to another tab must not inherit the last one's high-water marks.
  if (!liveTimer || (tabId ?? tab?.id) !== liveTab) {
    liveT0 = Date.now(); S.lastCatch = -1; S.lastHopPages = 0; S.lastHop = null;
  }
  clearInterval(liveTimer);
  // PINNED. The ticker used to poll `tab.id`, which is whatever tab you are looking at
  // now — so switching tabs mid-scan pointed the readout at a page that was not being
  // scanned, and the figures became another page's.
  //
  // AND ON A CHAINED RUN THE CALLER SAYS WHICH. `tab` is still "whatever is in front of you",
  // and by step two that has moved at least once — the results window opens between the passes.
  // The step knows the tab its pass belongs to and hands it in; `stopScan` reads the same
  // `liveTab`, so Stop keeps pointing at the pass rather than at the page being looked at.
  const tid = tabId ?? tab?.id;
  setLiveTab(tid);
  S.livePhase = phase;
  S.liveTitle = title;
  // The two later steps are only ever reached from a list that can be detailed, so arriving in
  // one is proof of the thing the marker waits for — and without this a run started from a card
  // rather than from a fresh walk would show no marker at all.
  if (phase === 'details' || phase === 'sites') S.sawChainable = true;
  S.liveStep = stepOf(phase);
  head(title);
  $('hsub').hidden = false;
  $('hnote').hidden = true;
  // Stop carries a glyph now because it is the one control on a sheet that is otherwise
  // all numbers — it has to be findable without reading. The label lives in its own span
  // so `Stopping…` can replace the words without wiping the mark.
  $('hacts').innerHTML =
    '<button class="stop" type="button"><i class="sq" aria-hidden="true"></i><span>Stop</span></button>';
  const stopBtn = $('hacts').querySelector('button');
  stopBtn.addEventListener('click', () => stopScan());
  // A STOP ALREADY PRESSED SURVIVES THIS REBUILD. Every call to `liveGrow` replaces `#hacts`
  // wholesale, so a phase starting AFTER a stop — which is now the normal case, since Stop
  // means "finish the step you're on" and the row phase runs on past it — handed back a fresh,
  // enabled Stop button and silently undid `stopScan`'s disable. Reported live: pressed once,
  // the sheet came back headed "Reading the page" with Stop clickable again, and a second
  // press killed the very phase the first was letting finish. `head()` already re-asserts the
  // "Stopping…" title through a tick for the same reason; this is the button's half of it.
  if (S.stopped) {
    stopBtn.disabled = true;
    const lbl = stopBtn.querySelector('span');
    if (lbl) lbl.textContent = 'Stopping…';
  }
  $('half').classList.add('live');
  $('half').classList.remove('recycling');
  $('half').hidden = false;
  const gen = ++S.liveGen;
  const tick = async () => {
    if (!tid || gen !== S.liveGen) return;
    try {
      const d = await send({ type: 'ROWS', tabId: tid, op: { action: 'progress' } });
      // The answer arrived — but this sheet may have closed while it was in the air, and the
      // card that replaced it must not be painted over. See `liveGen`.
      if (gen !== S.liveGen) return;
      if (d && !d.error) {
        const secs = Math.round((Date.now() - liveT0) / 1000);
        const wire = d.inflight || 0;
        const files = parseInt($('count').textContent.replace(/\D/g, ''), 10) || 0;
        // Asked here rather than only at the end of the walk, because the marker is worth most
        // DURING the longest step, not after it. One `if`, on a poll that already runs.
        if (d.canDetail) S.sawChainable = true;
        if (d.detailMap) S.chainMap = d.detailMap;
        if (d.detailTraits) S.chainTraits = d.detailTraits;
        if (S.livePhase === 'media') {
          // Three states, not two. A page with no media triggers on it still enters the
          // opening phase — there is simply nothing in the queue — and announcing that as
          // "Opening media · 0 opened" describes work that does not exist, with a bare
          // zero where the count should be because `0/0` has no denominator worth
          // printing. What is actually happening then is collecting, and it is finished.
          const s = d.scan || {};
          // "of the page read" has to mean the PAGE. This was walked/maxSteps — the
          // scroll BUDGET — and on a finite page the two agree closely enough that it
          // read as sensible. An endless feed spends the whole budget long before the
          // page ends, so the bar sat at 100% while the walk was visibly still going,
          // and then the phase changed under it: full meter, "Opening media", page
          // still scrolling. Three statements, none of which agreed.
          //
          // Position in the document is what the label claims to report, so report it.
          // The budget stays as the fallback for a page whose height we cannot read.
          const pos = d.docH ? Math.min(1, (d.y + (d.vh || 0)) / d.docH) : 0;
          const budget = s.screens ? Math.min(1, (s.walked || 0) / s.screens) : 0;
          // And never 100% while it is still walking. A full bar over a moving page is
          // the one reading that is wrong no matter which number produced it — on a feed
          // that keeps growing, "finished" is a claim we are in no position to make.
          const raw = pos || budget;
          const walk = s.phase === 'walking' ? Math.min(0.99, raw) : raw;
          const peek = s.triggers ? Math.min(1, (s.clicked || 0) / s.triggers) : 0;
          const opening = s.phase === 'peeking' && s.triggers > 0;
          const nothingToOpen = s.phase === 'peeking' && !s.triggers;
          const found = s.files || files;
          head(opening ? 'Opening media'
            : nothingToOpen ? 'Collecting files' : 'Reading the page');
          $('hsub').innerHTML = gauge({
            hero: opening ? (s.clicked || 0) : nothingToOpen ? found : `${Math.round(walk * 100)}%`,
            of: opening ? s.triggers : null,
            what: opening ? 'opened' : nothingToOpen ? 'files found' : 'of the page read',
            // Not repeated beside itself when it is already the headline figure.
            ...(nothingToOpen ? {} : { catchN: found, catchLabel: 'files' }),
            at: opening ? 0.35 + peek * 0.65 : nothingToOpen ? 1 : walk * 0.35,
            notch: 0.35,
            // WHAT THE TRACK MEASURES, which is not what the hero measures. The hero is the page;
            // the track is the whole scan, of which reading the page is the first third.
            // SHORT ENOUGH TO SURVIVE. This line sits beside the clock on a 400px panel and
             // clips like anything else that does not fit — "how far down the page the walk has
             // reach…" was photographed doing exactly that. Every one of these is measured
             // against the box it lands in; see the legend check in `test/_sheet-shots.mjs`.
            scale: opening ? 'the whole scan · opening its media'
              : nothingToOpen ? 'the whole scan · nothing left to open'
              : 'the whole scan · reading the page first',
            secs,
            why: wire ? `waiting on ${wire} request${wire > 1 ? 's' : ''} the page has not answered`
              : nothingToOpen ? 'nothing on this page needs opening' : '',
          });
        } else if (S.livePhase === 'details' || S.livePhase === 'sites') {
          // This phase DOES know its total — it is opening a list it already holds — so the
          // meter fills rather than accumulating, and the figure is a position in that list.
          //
          // The third step shares the instrument and none of the words. It counts SITES, not
          // records, and its total is smaller than the row count for two ordinary reasons —
          // rows with no website, and branches sharing one — so a readout saying "opened" over
          // 84 of 124 would read as forty failures. See `driveSites`.
          // THE FETCH LANE NEVER TOUCHES THE PAGE, SO THE PAGE CANNOT REPORT IT.
          //
          // `progress` asks the ENGINE what it has done, which is right for the lane that opens
          // each record in a TAB — it clicks, so the page counts. 2GIS is read by FETCH: no tab,
          // no click, nothing for the page to count, so `d.detail` never arrives and this card sat
          // at `0 opened · 0 with details` for a whole run while the worker was three-quarters
          // done. The elapsed clock ran, which is what made it look hung rather than idle.
          //
          // Two places to look, exactly as the `pages` branch below already does for its own two
          // kinds of pass: the tab lanes count on the page, the fetch lane counts in the WORKER
          // (`detailRun`, updated after every record). Ask the page first, fall back to the worker.
          let dt = d.detail;
          if (!dt) {
            const w = await send({ type: 'DETAILS_STATE', tabId: tid }).catch(() => null);
            if (w) dt = { at: w.opened || 0, of: w.total || 0, filled: w.filled || 0 };
          }
          dt = dt || {};
          const site = S.livePhase === 'sites';
          head();
          $('hsub').innerHTML = gauge({
            hero: dt.at || 0, of: dt.of || 0, what: site ? 'sites read' : 'opened',
            catchN: dt.filled || 0, catchLabel: site ? 'with an email' : 'with details',
            at: dt.of ? (dt.at || 0) / dt.of : 0,
            // Here the track and the hero DO measure the same thing, and saying so is worth a line:
            // it is the one phase where the meter can honestly be read as completion.
            scale: dt.of
              ? (site ? `${dt.of} sites to read` : `${dt.of} records on this list`)
              : (site ? 'the sites on this list' : 'the records on this list'),
            secs,
            // THE REAL COUNT, when the pass sends one. Deriving it as opened-minus-filled measures
            // how many records are IN FLIGHT, which with five lanes is about four all the time — and
            // it was drawn as "4 had no page to read" through an entire run in which the log said
            // lost=0. The lane pass carries `lost`; the sequential pass has at most one record in
            // flight, so the old derivation is still safe as its fallback.
            why: dt.lost > 0
              ? (site ? `${dt.lost} did not answer` : `${dt.lost} had no page to read`)
              : (!site && dt.lost == null && dt.at && dt.filled != null && dt.at - dt.filled > 2
                ? `${dt.at - dt.filled} had no page to read` : ''),
          });
        } else if (S.livePhase === 'pages') {
          // No total and no depth here, so the line accumulates instead of filling: one
          // tick per page landed. It advances by arriving, which is what happens.
          // Two places to look, because there are two kinds of pass. The fetch pass counts
          // on the page, where this poll already goes; the tab passes count in the WORKER,
          // and asking only the page meant five windows could open while the sheet read
          // "0 rows added, 0 pages" the entire time.
          // AND THE COUNTER NEVER GOES BACKWARDS. The worker forgets a walk the moment it is
          // over, so `HOP_STATUS` answers null on the tick after the last page — and `|| {}`
          // turned that into a card reading "0 rows added · 0 pages" over a finished run of a
          // hundred and ninety. The status is a high-water mark of a run that is ending, not a
          // live subscription, so the last real reading is kept and drawn until the summary
          // replaces it. Reset in `closeLive`, with everything else belonging to the run.
          const fresh = d.hop
            || (await send({ type: 'HOP_STATUS', tabId: tab?.id }).catch(() => null));
          if (fresh) S.lastHop = fresh;
          const h = fresh || S.lastHop || {};
          // Shown short, readable in full on hover. The line is one row of a narrow panel
          // and a search URL is routinely two hundred characters, so the ellipsis has to
          // stay — but a truncated URL is the one thing on this sheet you might actually
          // need to read exactly, because it is the answer to "which page is it on, and is
          // that even the right link". The title carries the WHOLE thing, origin included:
          // the visible part drops the host to save room, and a path with no host is not
          // something you can paste anywhere.
          // COMMITTED PER PAGE, not hoarded until the hop ends. Sixteen pages were read,
          // the site asked for verification, and the only way to answer that is to leave
          // and clear it — which threw away all sixteen, because nothing had been written
          // yet. The tab passes already commit as each page lands; this is the in-page hop
          // catching up. One extra message per PAGE, not per poll.
          if ((h.pages || 0) > S.lastHopPages) {
            S.lastHopPages = h.pages;
            send({ type: 'ROWS', tabId: tid, op: { action: 'commit' } })
              .then((r) => { if (r?.id) S.resultId = r.id; })
              .catch(() => {});
          }
          let where = '';
          try { const u = new URL(h.url); where = u.pathname + u.search; } catch (_) {}
          const link = where
            ? `<span class="hop-url" title="${esc(h.url || '')}">${esc(where)}</span>`
            : '';
          // NOT retitled here. The phase sets its own name — "Fetching the next pages",
          // "Loading them out of sight", "Reading in its own window" — and a tick that
          // overwrote it every half second meant none of those names was ever seen.
          // READING THIS PAGE'S RECORDS IS STEP TWO, AND IT SAYS SO WHILE IT HAPPENS.
          //
          // Interleaved, one pass does both jobs, and most of its time goes into the second one:
          // turning a page costs about a second, reading its twelve records three or four. Drawn
          // as a single step, the ledger sat on "Reading the list, page by page" for the whole
          // run with a greyed step two underneath that never lit — which reads as a pass that
          // stopped, not one that is working. It is the same instrument as the standalone record
          // pass, pointed at the same numbers, so it also fills rather than counts.
          // SITTING IN FRONT OF A CHECK IS NOT BEING STUCK, and from outside they look identical.
          //
          // The walk now waits for the person rather than ending under them, which is right and
          // which is also the exact shape of a hang: the page count stops moving, the row count
          // stops moving, and the elapsed clock keeps going. So it has to SAY so, and say what is
          // wanted — the tab is already on the check, and nothing happens until they clear it.
          //
          // No bar, because there is no progress to draw. A countdown instead, since the wait does
          // end: what is left is the honest number, and it is the one thing that is moving.
          if (h.waiting) {
            S.liveStep = 1;
            head('Waiting for you');
            const left = Math.max(0, Math.round(((h.waiting.until || 0) - Date.now()) / 1000));
            $('hsub').innerHTML = gauge({
              hero: h.added || 0, what: 'rows held',
              catchN: h.pages || 0, catchLabel: 'pages read',
              at: 0, secs,
              scale: `the site put up a check on page ${(h.pages || 0) + 1} — clear it in the tab`,
              why: left
                ? `Nothing is being requested from the site. Carrying on by itself the moment the `
                  + `check clears; giving up in ${left}s.`
                : 'Nothing is being requested from the site.',
            });
            return;
          }
          if (h.reading) {
            S.liveStep = 2;
            head('Reading each record');
            $('hsub').innerHTML = gauge({
              hero: h.reading.at || 0, of: h.reading.of || 0, what: 'opened',
              catchN: h.reading.filled || 0, catchLabel: 'with details',
              at: h.reading.of ? (h.reading.at || 0) / h.reading.of : 0,
              scale: `${h.reading.of || 0} records on page ${h.pages || 1}`,
              secs,
              why: `${h.added || 0} rows so far · ${h.pages || 0} page${(h.pages || 0) === 1 ? '' : 's'}`,
            });
            return;
          }
          S.liveStep = 1;
          head();
          $('hsub').innerHTML = gauge({
            hero: h.added || 0, what: 'rows added',
            catchN: h.pages || 0, catchLabel: 'pages',
            ticks: h.pages || 0, secs,
            // A COUNTER, AND IT SAYS SO. There is no total to fill against — the next page exists
            // until it does not — so the track wraps every twenty and the legend names the count
            // rather than leaving twenty blocks to be read as twenty pages.
            scale: `counting · ${h.pages || 0} page${(h.pages || 0) === 1 ? '' : 's'} so far, no known end`,
            // ORDERED AS A SEQUENCE, NOT A PAIR — the two halves describe DIFFERENT moments and
            // used to sit side by side as if they were one. `link` is the URL the tab is ON
            // right now, mid-fetch; `trail`'s last entry is the LAST PAGE THAT FINISHED, one
            // step behind by the time the next page's URL has already landed. Shown together as
            // "…page=4… · page 3 · 22 rows on it" that reads as a single contradiction — on page
            // four, it says page three — when it is really two true facts about two different
            // pages, told out of order. Put the finished page first and name the live one as
            // what it is, and the same two facts stop looking like a miscount.
            why: [
              // The last page's own numbers. "0 rows added" over five opened pages is a
              // sentence with no information in it; "page 3 done — 0 rows on it" says whether
              // the pages were empty or the rows were repeats.
              h.trail?.length ? `page ${h.trail[h.trail.length - 1].n} done — ${
                h.trail[h.trail.length - 1].saw} rows on it` : '',
              link ? `now on ${link}` : 'fetching the next page',
            ].filter(Boolean).join(' · '),
          });
        } else {
          // Two different truths, one after the other. While the page is still being
          // walked, depth is real and moves — so the meter is depth. Once hopping starts
          // the walk has already reached the bottom and depth is pinned at one, which is
          // how this bar came to sit full for an entire phase; from there a block is a
          // hop. `uniq` is what the table will hold; `rows` is what the DOM happens to be
          // showing, and reporting the second promised thousands the export never had.
          const dupes = d.dupes || 0;
          const hops = d.hops || 0;
          head();
          $('hsub').innerHTML = gauge({
            hero: d.uniq ?? d.rows, what: 'rows',
            catchN: d.imgs || 0, catchLabel: 'images',
            ...(hops
              ? { ticks: hops,
                scale: `counting · ${hops} hop${hops === 1 ? '' : 's'} so far, no known end` }
              : { at: Math.min(1, (d.y + (d.vh || 0)) / Math.max(1, d.docH)),
                scale: 'how far down the page' }),
            secs,
            why: [hops ? `hop ${hops}` : 'reading the page',
              dupes ? `${dupes} repeats skipped` : '',
              wire ? `waiting on ${wire} from the page` : ''].filter(Boolean).join(' · '),
          });
          const now = parseInt($('count').textContent.replace(/\D/g, ''), 10) || 0;
          if ((d.imgs || 0) > now) $('count').textContent = String(d.imgs);
        }
      }
    } catch (_) {}
  };
  tick(); // first paint immediately, not half a second late
  setLiveTimer(setInterval(tick, 500));
  // Closing bumps the generation as well as clearing the timer, so a tick already waiting on the
  // page paints nothing when it comes back.
  return closeLive;
}
export { liveGrow };
