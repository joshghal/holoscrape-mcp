// The half-card: one sheet, up only when there is something to answer.
import { $, esc } from './panel-util.js';
import { S, liveTimer } from './panel-state.js';
import { logIt } from './panel-shell.js';
import { closeLive } from './panel-sheet.js';

// --- the half-card ----------------------------------------------------------
// One sheet, up only when there is something to answer. It never pauses the walk: by
// the time it appears the scrolling pass has already run, so the page is not frozen and
// the only thing waiting on an answer is whether to press.
//
// It replaced a permanent status card, a settings switch and keyboard chips on every
// button. Three additions to a 400px panel is how you make a scan harder to run.
let halfKeys = null;

function ask({ q, sub, note, actions, field }) {
  // A CARD RETIRES THE TICKER, because the two write to the same three nodes.
  //
  // This was already a real fault before the steps were chained: `followPages` raises its "drive
  // the pages?" card while the progress sheet's own timer is still running, so the question was
  // being painted over with a gauge twice a second. It becomes load-bearing now — every ending of
  // every step raises a card, and each one has a live sheet behind it that would otherwise
  // overwrite the report a moment after it appeared. `liveGen` is bumped, so a tick already in
  // flight lands on nothing. See the note by `liveGen`.
  if (liveTimer) closeLive();
  // Both halves of every card: what it asked, and what came back. The answer line is where a run's
  // story usually turns, and it was the one thing never written down.
  logIt('card', { q: String(q).replace(/<[^>]+>/g, '').slice(0, 120),
    actions: actions.map((a) => a.label).join('/') });
  $('hq').innerHTML = q;
  // THE LIVE SHEET'S OWN ROWS DO NOT SURVIVE INTO A CARD. `#hrest` holds the ledger's pending steps
  // and the stay-on-this-tab tip, and nothing was clearing it — so a card announcing the run had
  // FINISHED still carried "leave this tab open and in front while it finishes" underneath it.
  $('hq').classList.remove('ledger');
  const rest = $('hrest');
  if (rest) rest.innerHTML = '';
  $('hsub').innerHTML = sub || '';
  $('hsub').hidden = !sub;
  $('hnote').textContent = note || '';
  $('hnote').hidden = !note;
  // A CARD THAT CAN TAKE TYPING, because some answers are not a choice between buttons.
  //
  // Every sheet until now asked a question with two or three answers on it. Learning a page dial
  // needs the addresses themselves, and there is no way to guess those — the whole point is that
  // the person can see a pager the tool cannot. Rendered into `#hrest`, which the card already
  // clears, so no new node and no new lifecycle.
  if (field && rest) {
    // ONE BOX PER ADDRESS, not one box holding three lines. A textarea asks the person to know
    // that lines are the separator, gives no hint how many are wanted, and shows a paste that
    // wrapped as if it were two entries. Separate labelled boxes say "three of these, the third
    // optional" without a sentence of instruction, and a url that wraps still reads as one.
    const slots = field.slots || [];
    rest.innerHTML = slots.map((sl, i) =>
      `<label class="hslot"><span class="hchip${sl.optional ? ' opt' : ''}">`
      + `${esc(sl.label || '')}</span>`
      + `<input class="hfield" type="text" spellcheck="false" autocomplete="off"`
      + ` data-slot="${i}" value="${esc(sl.value || '')}"`
      + ` placeholder="${esc(sl.placeholder || '')}"></label>`).join('');
    setTimeout(() => rest.querySelector('input.hfield')?.focus(), 30);
  }
  $('hacts').innerHTML = actions.map((a, i) =>
    `<button class="${a.kind || ''}" data-i="${i}">${a.label}</button>`).join('');

  return new Promise((resolve) => {
    const done = (v) => {
      // A CARD WITH A FIELD ANSWERS WITH AN OBJECT, and `String({})` is `[object Object]` —
      // which is what every dial run wrote into the log, losing the one thing worth recording.
      logIt('answer', {
        was: v === undefined ? '(retracted)'
          : (v && typeof v === 'object') ? String(v.value) : String(v),
      });
      $('half').hidden = true;
      removeEventListener('keydown', halfKeys, true);
      halfKeys = null;
      S.pendingAsk = null;
      resolve(v);
    };
    // Held so leaving the page can retract the question. `undefined` is the answer
    // nobody gave, and every caller treats it as "do nothing and save nothing" — the
    // alternative is a sheet about one page hanging over another, and worse, an answer
    // being recorded against a page the user never saw it on.
    S.pendingAsk = () => done(undefined);
    // WITH A FIELD, THE ANSWER IS BOTH HALVES. Callers without a field see exactly what they
    // always saw, so nothing existing has to know this option is here.
    const answer = (v) => {
      if (!field) return done(v);
      // Joined with newlines because that is what every caller already parses; the boxes are a
      // way of ASKING, not a change to the answer. Blank boxes drop out, so "page 3 optional"
      // needs no flag anywhere downstream.
      const ins = [...($('hrest')?.querySelectorAll('input.hfield') || [])];
      // `text` drops the blanks because that is what a reader of addresses wants. `values`
      // keeps every box in its own position, because putting the card back up means putting
      // each answer back in the box it came from — joining first loses which was which.
      const values = ins.map((el) => el.value.trim());
      return done({ value: v, text: values.filter(Boolean).join('\n'), values });
    };
    $('hacts').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => answer(actions[+b.dataset.i].value)));
    // Enter takes the first action, Escape the last. A sheet you cannot answer from the
    // keyboard is a sheet that traps someone.
    halfKeys = (e) => {
      // ENTER WALKS THE BOXES BEFORE IT ANSWERS THE CARD. With one address per box, Enter on
      // the first box meaning "go" would submit a one-url answer the moment someone pasted page
      // one — so it moves to the next box instead, and only answers from the last one.
      if (e.key === 'Enter' && field && e.target?.classList?.contains('hfield')) {
        e.preventDefault();
        const ins = [...($('hrest')?.querySelectorAll('input.hfield') || [])];
        const at = ins.indexOf(e.target);
        if (at > -1 && at < ins.length - 1) { ins[at + 1].focus(); return; }
        return answer(actions[0].value);
      }
      if (e.key === 'Enter') { e.preventDefault(); done(actions[0].value); }
      if (e.key === 'Escape') { e.preventDefault(); done(actions[actions.length - 1].value); }
    };
    addEventListener('keydown', halfKeys, true);
    $('half').classList.remove('live');
    $('half').hidden = false;
    $('hacts').querySelector('button')?.focus();
  });
}

// Retracts the question rather than merely hiding it, so nothing is left awaiting an
// answer that can no longer be given.
const closeHalf = () => { if (S.pendingAsk) S.pendingAsk(); else $('half').hidden = true; };

export { ask, closeHalf };
