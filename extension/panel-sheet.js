// The live sheet's instruments: the gauge, the step ledger and its head, the chain traits the
// ledger paints from, and the two ways a sheet ends (`closeLive`, `stopScan`). `liveGrow` itself —
// the ticker that drives these — lives in sidepanel.js beside the scan it reports on.
import { $, esc, clock } from './panel-util.js';
import { S, tab, liveTimer, liveTab, setLiveTimer, setLiveTab } from './panel-state.js';
import { send } from './panel-shell.js';

// A repeat is cheap to produce and costs the user nothing, so a raw count of them says
// nothing on its own: 40 repeats against 4,000 rows is a healthy feed, 900 against 250 is
// a page serving the same tray back. The threshold is a ratio for that reason, with a
// floor so a page that has only shown a handful of rows cannot trip it on noise alone.
const DUPE_FLOOR = 60;    // below this many repeats, never flag — too little evidence
const DUPE_RATIO = 1.5;   // repeats worth more than 1.5x the rows kept = recycling
const dupeHot = (dupes, rows) => dupes >= Math.max(DUPE_FLOOR, (rows || 0) * DUPE_RATIO);

function gauge({ hero, of, what, catchN, catchLabel, at, notch, ticks, secs, why, flag, scale }) {
  const grew = catchN != null && catchN > S.lastCatch && S.lastCatch >= 0;
  S.lastCatch = catchN ?? S.lastCatch;
  // Twenty blocks, because a block has to be wide enough to read as a block in a 400px
  // panel. `at` is a fraction and rounds into them; `ticks` counts real units — one hop,
  // one page — and WRAPS rather than saturating.
  //
  // Wrapping because these phases have no end to measure against, and a meter that fills
  // and then stays full is worse than no meter: it reads as finished while the scan runs
  // on. Capping at twenty did exactly that — a feed on its fortieth hop showed the same
  // solid bar it showed on its twentieth. A lap of twenty blocks says "still counting,
  // and here is the count", which is the true statement available.
  const SEGS = 20;
  const lit = ticks != null
    ? (ticks > 0 && ticks % SEGS === 0 ? SEGS : ticks % SEGS)
    : Math.round(Math.min(1, at) * SEGS);
  const edge = notch ? Math.round(notch * SEGS) : -1;
  const line = Array.from({ length: SEGS }, (_, i) =>
    `<i class="g-seg${i < lit ? (i === lit - 1 ? ' on head' : ' on') : i === edge ? ' edge' : ''}"></i>`).join('');
  // THE METER SAYS WHAT IT MEASURES, in words, underneath itself.
  //
  // This is the fix for the complaint that "the bar contradicts the number": on the asset walk the
  // hero reads 99% and the track lights seven of twenty, and both are correct — the hero is how
  // much of the PAGE has been read, the track is how far through the WHOLE SCAN that is, notched
  // where reading the page becomes opening its media. Nothing said so, so it read as one device
  // disagreeing with itself. A legend costs one line and removes the misread entirely.
  //
  // And when the track is a LAP COUNTER it says that too, because that is the case where a filled
  // track is most misleading. See `.gline.lap`.
  return `<div class="gauge">
    <div class="g-read">
      <span class="g-fig">
        <span class="g-hero">${hero}${of > 0 ? `<i>/${of}</i>` : ''}</span>
        <span class="g-what">${what}</span>
      </span>
      ${catchN != null
        ? `<span class="g-catch${grew ? ' up' : ''}"><b>${catchN}</b><span>${catchLabel}</span></span>`
        : ''}
    </div>
    ${flag ? `<div class="g-flag"><b>${flag.n}</b> ${esc(flag.label)}<i>${esc(flag.note)}</i></div>` : ''}
    <div class="g-act">
      <div class="gline${ticks != null ? ' lap' : ''}${notch ? ' notched' : ''}"${
        notch ? ` style="--notch:${(notch * 100).toFixed(1)}%"` : ''}>${line}</div>
      <div class="g-legend">
        <span class="s">${scale ? esc(scale) : ''}</span>
        <span class="t"><i>elapsed</i>${clock(secs)}</span>
      </div>
    </div>
    ${why ? `<p class="g-why">${why}</p>` : ''}
  </div>`;
}

// --- which of the three steps is running -------------------------------------
// A map list is read in three passes and they take minutes: the rail, then each record, then
// each business's own site. The sheet used to name the PHASE and nothing else — "Opening each
// item detail", "Reading their websites" — three unrelated titles in sequence, with no way to
// tell from any one of them whether the run was a third of the way through or nearly done, or
// indeed whether anything was still coming after it.
//
// So the phase title keeps its job (it says what is happening right now) and gains a marker in
// front of it that says WHERE IN THE RUN that is. The number is derived from the phase rather
// than passed around, because a second source for "which step" is a second thing that can
// disagree with the first.

// PAINT MAY READ THE CACHE. DECISIONS MAY NOT.
//
// `chainTraits` is a copy of what the engine said, and it goes stale in a way that is invisible
// from the outside: `closeLive` resets it to the unknown-site defaults, and `ask` calls
// `closeLive`. So a card shown earlier in a run leaves every later question reading `grows: ''`
// and `steps: 3` for a map that pages and has two — which is exactly how the "Follow the pages"
// prompt kept appearing on 2GIS, and how a third step kept being drawn for a provider that has
// none. The log said so plainly for weeks: `chain.loadmore … grows= map=` on a 2GIS page.
//
// These two remain for the LEDGER, which repaints every 500ms from the poll and is corrected by
// the next tick if it is ever wrong. Anything that decides what the tool DOES asks `freshTraits`.
const stepsOf = () => S.chainTraits.steps || 3;
const pagesItself = () => S.chainTraits.grows === 'pager-click';

// THE ENGINE, ASKED NOW. One message, no memory. It also refreshes the cache the ledger paints
// from, so a correct answer here corrects the furniture too.
async function freshTraits() {
  if (!tab?.id) return S.chainTraits;
  const tr = await send({ type: 'ROWS', tabId: tab.id, op: { action: 'mapkind' } }).catch(() => null);
  if (tr && !tr.error) {
    S.chainTraits = tr;
    if (tr.map) S.chainMap = tr.map;
  }
  return tr && !tr.error ? tr : S.chainTraits;
}
const stepOf = (phase) => (phase === 'details' ? 2 : phase === 'sites' ? 3 : 1);

function chainStart(from = 1) {
  // A chain that begins at step one begins when the button was pressed. One started from a card
  // begins now, because that is when its work began.
  const t0 = from === 1 && S.deepT0 ? S.deepT0 : Date.now();
  S.chain = { t0, from, list: null, details: null, sites: null };
  return S.chain;
}

// --- the step rail -----------------------------------------------------------
// Adapted from React Bits' Stepper: a circle-and-connector rail where colour advances left to
// right, the step you are on is emphasised, and the ones behind it become checks.
//
// ADAPTED, not copied, and it could not have been copied anyway — this is a vanilla MV3 extension
// with no dependencies and a CSP that forbids anything external, so there is no React and no
// framer-motion here. What was taken is the DESIGN: the geometry (32px circles, a 2px connector
// with a 4px radius) and the one idea that makes it work, which is that colour advancing along a
// rail answers "how far through" without a number. The reference's brand purple is gone —
// everything wears this panel's amber, because a component still dressed in somebody else's colour
// reads as a component dropped in from another site.
//
// WHY IT BELONGS HERE. The sheet carried two devices that both looked like progress and disagreed:
// a 99% and a twenty-block bar showing seven. They disagreed because they answer different
// questions and the card never said which was which. The rail answers "which of the three am I
// on"; the meter below it answers "is this step still moving". Neither was deleted; they were
// told apart.
const STEP_TITLE = ['Reading the page', 'Reading each record', 'Reading their websites'];
// One glyph, drawn rather than typed: a tick character sits on a different baseline in every font
// and this one has to sit dead centre in a 32px circle.
const TICK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';

// THE LEDGER. Three rows, and only the one that is running is open.
//
// The rail this replaces drew all three steps at full weight for the whole run, so a card showing
// one step's work carried three steps' worth of furniture — which is what "over-crowded" was.
// A finished step is one grey line; a step that has not started is one grey line; the live step is
// the only thing with a surface, a figure and a meter. The card therefore SHRINKS as the run
// advances rather than staying at its worst height throughout.
//
// The open row is `#hq`'s last child and the gauge in `#hsub` is its body — they are two elements
// painted as one panel (see the `+` rule in the stylesheet), because the gauge is written by a
// different code path and moving it inside would have meant restructuring the sheet.
function ledgerRow(k, state) {
  return `<i class="lrow ${state}" data-at="${state}">`
    + `<i class="ldot">${state === 'done' ? TICK_SVG : k}</i>`
    + `<span>${esc(STEP_TITLE[k - 1] || '')}</span></i>`;
}

function ledgerHTML(n, t) {
  let out = '';
  for (let k = 1; k < n; k++) out += ledgerRow(k, 'done');
  out += `<i class="lrow open" data-at="open"><i class="ldot now">${n}</i>`
    + `<span class="hwhat">${esc(t)}</span></i>`;
  return out;
}

// What comes after the open row, and therefore after the gauge. Steps always run 1 -> 2 -> 3, so
// everything below the current one is pending by construction.
function restHTML(n) {
  let out = '';
  for (let k = n + 1; k <= stepsOf(); k++) out += ledgerRow(k, 'todo');
  return out;
}

// NOT REBUILT TWICE A SECOND. `head` runs on every tick, and replacing the rows each time would
// restart the arrival animation on the open one — the single gesture that means "the chain moved
// on" would then pulse continuously, which is what every fault indicator in the world looks like.
// `data-at` makes the no-op case free: a row whose state has not changed is not touched.
function ledgerSync(n, label, t) {
  const hq = $('hq');
  const host = hq.querySelector('.lrow.open');
  if (!host) return false;
  const before = hq.querySelectorAll('.lrow.done').length;
  if (before !== n - 1) return false;            // the step moved on — let `head` rebuild
  hq.setAttribute('aria-label', label);
  const dot = host.querySelector('.ldot');
  if (dot && dot.textContent !== String(n)) dot.textContent = String(n);
  const w = host.querySelector('.hwhat');
  if (w && w.textContent !== t) w.textContent = t;
  return true;
}

// The one place `#hq` is written while a pass is running. Everything that used to assign
// `$('hq').textContent = liveTitle` goes through here, or the marker vanishes on the next tick.
function head(title) {
  // STOPPING SURVIVES THE TICK. `stopScan` retitles the sheet and the ticker used to paint
  // `liveTitle` back over it half a second later — so a pressed Stop showed the sheet still
  // headed with the pass it had just cancelled, which reads as a press that did nothing.
  const t = S.livePhase === 'stopping' ? 'Stopping…' : (title == null ? S.liveTitle : title);
  const n = S.liveStep > 1 || S.sawChainable ? S.liveStep : 0;
  const hq = $('hq');
  const label = n ? `Step ${n} of ${stepsOf()}: ${t}` : t;
  const has = !!hq.querySelector('.lrow');

  // A page with no second step gets no rail. Three circles over a shop's product feed would be
  // promising two passes that are never coming. The full rebuild happens only when the sheet gains
  // or loses its rail — everything else is moved in place, see `railSync`.
  //
  // THE TIP, and it is a TIP — not a warning, and above all not a mechanism.
  //
  // The obvious sentence here would be "don't click away or the results will be wrong", and it
  // would be false. That was measured: an unfocused WINDOW makes no difference at all — 91 rows
  // gained in both arms, zero variance within either, identical hop and RPC counts. A run survives
  // being ignored, which is most of the point of it.
  //
  // A HIDDEN TAB is a different condition and not the same claim: Chrome clamps a background tab's
  // timers and stops giving it animation frames, which is why `raf.js` exists as a backstop at all.
  // So the honest form is a recommendation with no causal story attached — it says what to do for
  // the smoothest run and promises nothing about what happens otherwise.
  //
  // It sits directly under the rail, where somebody reads it BEFORE they walk away rather than
  // after, and it goes once Stop is pressed: there is nothing left to protect by then.
  if (n ? !ledgerSync(n, label, t) : has || !hq.querySelector('.hwhat')) {
    hq.classList.toggle('ledger', !!n);
    hq.innerHTML = n ? ledgerHTML(n, t) : `<span class="hwhat">${esc(t)}</span>`;
    if (n) hq.setAttribute('aria-label', label); else hq.removeAttribute('aria-label');
    // THE TIP GOES BELOW THE FIGURES, not inside the open row. Sitting between the step's name and
    // its numbers it split the one panel on the card in two, and a banner is the wrong thing to
    // put between a heading and the number it introduces. Read last, it is still read before
    // anybody walks away — which is the whole requirement.
    const rest = $('hrest');
    if (rest) {
      rest.innerHTML = (n ? restHTML(n) : '') + TIP_HTML;
    }
  }
  // ON EVERY STEP, NOT ONLY THE ONES WITH A STEP RAIL.
  //
  // The tip was gated on `n` — the ledger's step count — which only exists on a chainable map. So
  // the one advice that protects a run was shown on the pages least likely to need it and never on
  // an ordinary shop, where a nine-page walk takes a minute and a half and the person reasonably
  // wanders off. Asked for directly: "do not change tab on every processing half-card, on every
  // step."
  //
  // Written to match what was actually measured, which is narrower than the request. An unfocused
  // WINDOW made no difference — 91 rows in both arms, no variance — so telling somebody not to use
  // another window would be advice this project's own data contradicts. A HIDDEN TAB is the real
  // condition: Chrome clamps a background tab's timers and stops its animation frames.
  //
  // Added after the redraw branch rather than inside it, so it is present on every tick regardless
  // of whether the card's contents changed this time.
  const live = $('hrest');
  if (live && S.livePhase !== 'stopping' && !live.querySelector('.htip')) {
    live.insertAdjacentHTML('beforeend', TIP_HTML);
  }
  // The tip moved to `#hrest` when it went below the figures; removing it from `#hq` stopped
  // doing anything, so a pressed Stop kept advising the user to stay on a tab that is finishing.
  if (S.livePhase === 'stopping') $('hrest')?.querySelector('.htip')?.remove();
}

// One string, two places: the redraw path and the every-tick guarantee below it.
// THE WINDOW COUNTS TOO, and the two notes in this codebase disagreed about it.
//
// The comment above this block records an A/B in which an unfocused WINDOW made no difference —
// 91 rows in both arms. But `hopHere` records the opposite from a real run: "a walk that stalled
// because the window lost focus logs `hidden=false`, which reads as 'the tab was fine'. Measured:
// rows=56 hops=1 hidden=false endedBy=nothing arrived for 10s, on a list with far more than 56
// rows." That is why `walkLostFocus` is tracked across the whole walk rather than sampled at the
// end — somebody already suspected this and built the instrument for it.
//
// So the A/B was not the last word, and the user reports the same thing from their own runs. The
// risk is asymmetric: advice that is too cautious costs a person nothing, advice that is not
// cautious enough costs them the run. It says both.
const TIP_HTML = '<span class="htip">Keep this tab in front and this window active while it runs — '
  + 'switching tabs or windows can pause the page.</span>';

// THE SHEET IS NOW HELD OPEN ACROSS A STEP BOUNDARY, so closing it is its own named thing.
//
// Each step used to close the sheet on its way out and the next one opened a fresh one, which
// was fine when a card sat between them. With the cards gone that pattern leaves a gap — half a
// second with no numbers and, worse, no Stop — at exactly the moment the run hands minutes of
// work to the next pass. So the closer is only called where the run really is over, and every
// path that ends one owes it a call: a sheet left up with a Stop button over a finished run is
// the same lie in the other direction.
function closeLive() {
  S.liveGen++;
  clearInterval(liveTimer); setLiveTimer(null); setLiveTab(null); S.liveStep = 0; S.lastHop = null;
  // AND THE RAIL FORGETS. `sawChainable` is a claim about the run that is ending, not about the
  // page — and a page hop started from a card afterwards would inherit it and put "Step 1 of 3"
  // over a pass that is not one of the three. Caught by photographing the hop state, which came
  // back wearing a rail. Safe here precisely because the chain does NOT close the sheet between
  // its steps: the only calls are at the end of a run and from `ask`, and every hop is entered
  // from a card.
  S.sawChainable = false;
  S.chainMap = '';
  S.chainTraits = { steps: 3, grows: '', reads: '' };
  $('half').classList.remove('live'); $('half').hidden = true;
  // The rail is torn down with the sheet, so the next run builds one rather than inheriting a
  // set of circles already lit — and its first step gets its arrival gesture.
  $('hq').innerHTML = '';
}

async function stopScan() {
  // The tab being SCANNED, which is not necessarily the tab being looked at: a scan keeps
  // running while you browse elsewhere, and Stop pressed from over there was stopping
  // whatever page happened to be in front instead of the one that is working.
  const tid = liveTab ?? tab?.id;
  if (!tid) return; // a regrow stretch runs outside run(), so no busy gate here
  const b = $('hacts').querySelector('button');
  if (b) {
    const lbl = b.querySelector('span');
    if (lbl) lbl.textContent = 'Stopping…'; else b.textContent = 'Stopping…';
    b.disabled = true;
  }
  S.stopped = true;
  // ONE PRESS, NOT TWO. Stop now means "finish the step you're on, then stop" — the row phase
  // deliberately still runs after it (see `run`'s note where the old unconditional return was),
  // and that phase takes tens of seconds. Left clickable, the obvious thing to do while waiting
  // is press it again, which re-sends STOP and kills exactly the phase the first press was
  // letting finish. `paintDeep` re-enables it when the run actually ends.
  $('deep').disabled = true;
  S.livePhase = 'stopping';
  // Retitled, not just re-buttoned. The sheet is the surface being watched, and a
  // sheet still headed "Opening media…" after Stop says the press did nothing.
  head('Stopping…');
  $('hnote').textContent = 'Keeping everything found so far.';
  $('hnote').hidden = false;
  $('deep').querySelector('.lbl b').textContent = 'Stopping…';
  $('deep').querySelector('.lbl span').textContent = 'Finishing the current step.';
  try { await send({ type: 'STOP', tabId: tid }); } catch (_) {}
}

export { gauge, stepsOf, freshTraits, stepOf, chainStart, head, closeLive, stopScan };
