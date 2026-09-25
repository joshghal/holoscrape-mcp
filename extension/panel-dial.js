// Learning the page dial from two or three pasted addresses, and showing what was learned.
import { esc } from './panel-util.js';
import { tab } from './panel-state.js';
import { send } from './panel-shell.js';
import { ask } from './panel-card.js';

// ASK FOR THE ADDRESSES, AND SAY WHAT WAS LEARNED FROM THEM.
//
// Two is enough and three is better: with three, the middle one is used to CONFIRM the dial by
// rebuilding it, which catches a plausible-but-wrong reading before a run is spent on it.
// TAKES THE ADDRESSES RATHER THAN ASKING FOR THEM. The asking moved onto the choice card, so
// that picking "read every page" and saying WHICH pages are one action instead of two.
async function learnDial(pasted) {
  const urls = String(pasted || '').split(/\s*\n\s*/).map((u) => u.trim()).filter(Boolean);
  if (urls.length < 2) {
    await ask({
      q: 'I need two addresses to work out the numbering.',
      sub: 'Open page 2 of this list in your browser, copy what is in the address bar, and '
        + 'paste it into the second box. Page 1 is the address you are on now.',
      actions: [{ label: 'Let me try again', value: true }],
    });
    return null;
  }
  const out = await send({ type: 'LEARN_DIAL', urls }).catch(() => null);
  if (!out || out.error) {
    await ask({ q: 'I could not read a page number out of those.',
      sub: out?.error || 'Are they the same list on different pages?',
      actions: [{ label: 'Alright', value: true }] });
    return null;
  }
  // SHOWN BEFORE IT IS USED. A derived dial is a claim about the person's site, and they are the
  // only one who can see at a glance that `page 2` is not in fact `sort order 2`.
  const d = out.dial;
  const go = await ask({
    // WRITTEN FOR THE PERSON WHO PASTED THE ADDRESSES, not for the engine that read them.
    //
    // This card used to print the dial's own vocabulary: "The page number is page." — a
    // sentence built by dropping `d.key` into a slot, which reads as a typo rather than a
    // finding. And the one line that mattered, that the rule failed its own check, arrived as
    // a clause at the end of a sentence about address parameters: "but it did NOT rebuild your
    // middle address — check it". Check WHAT, against what?
    //
    // So: the verdict leads. A rule that failed says so in the heading, before anything about
    // where numbers live. Everything else is said the way a person would say it — the number
    // "counts up" somewhere, the addresses are "the ones you pasted", and the samples are
    // shown as what will actually be opened.
    q: d.confirmed === false
      ? 'I worked out the numbering, but it may be wrong.'
      : 'I can see how the pages are numbered.',
    sub: `The number counts up in ${d.at === 'query'
      ? `the <b>${esc(d.key)}</b> setting of the address`
      : d.at === 'hash' ? `the part after the <b>#</b>`
        : `the address itself`}.`
      + `${d.confirmed === true
        ? ' I rebuilt your second address from it and got exactly what you pasted.' : ''}`
      + `${d.confirmed === false
        ? ' But when I rebuilt your second address from it, I got something different from '
          + 'what you pasted — so compare these two against the real pages before going ahead.'
        : ''}`
      + `<br><br>It will read <b>every</b> page in order from the first — these two just show `
      + `the pattern:`
      + `<br>Page 1 → <code>${esc(out.samples[0] || '')}</code>`
      + `<br>Page 2 → <code>${esc(out.samples[1] || '')}</code>`,
    note: d.alsoMoved ? 'Your addresses differed in other ways too '
      + `(${d.alsoMoved.join(', ')}) — those are left exactly as they are.` : '',
    actions: [
      { label: 'Read every page', value: true, kind: 'go' },
      { label: 'Cancel', value: false },
    ],
  });
  if (go !== true) return null;
  await send({ type: 'POINT_MEMORY', url: tab?.url || '', save: { dial: d } }).catch(() => {});
  // Page one's address rides along: the panel cannot compute it (`urlForPage` lives in the
  // worker) and the walk needs somewhere to start.
  return { ...d, first: out.samples?.[0] || '' };
}

export { learnDial };
