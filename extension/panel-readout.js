// The panel's readout: the count, the caption, the composition strip, the type chips, the
// coverage list and the untested-site banner. `show` is the one entry point; `paintChipFade` is
// wired to the chip row's own scroll.
import { $, esc, isLocalHost, ago } from './panel-util.js';
import { S, tab } from './panel-state.js';

let lastCount = 0;

// Site furniture and ad beacons. Kept out of the headline number so the panel
// and the results table tell the same story — a panel reading 22 over a table
// reading 5 makes the tool look broken even when both are right.
const CHROME_TAGS = ['icon', 'logo', 'tiny'];
const isTracker = (i) => (i.tags || []).includes('tracker');
// Same rule as the results table: size overrules the name.
const isChrome = (i) =>
  !isTracker(i) && (i.w || 0) < 400 && (i.tags || []).some((t) => CHROME_TAGS.includes(t));

// Counts up rather than snapping. The watcher polls every few seconds, so the
// number is the one thing on screen that moves on its own — rolling makes an
// arrival legible as an event. Skipped for big jumps and for the first paint,
// where it would just look slow.
let countRaf = 0;
function countTo(target) {
  const el = $('count');
  const from = Number(el.textContent) || 0;
  cancelAnimationFrame(countRaf);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || from === target || Math.abs(target - from) > 60) {
    el.textContent = target;
    return;
  }
  const t0 = performance.now();
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / 420);
    el.textContent = Math.round(from + (target - from) * (1 - Math.pow(1 - k, 3)));
    if (k < 1) countRaf = requestAnimationFrame(tick);
  };
  countRaf = requestAnimationFrame(tick);
}

function show(items, cov, wasDeep, savedAt) {
  const real = items.filter((i) => !isTracker(i) && !isChrome(i));
  const chrome = items.filter(isChrome).length;
  const ads = items.filter(isTracker).length;
  const n = real.length;
  countTo(n);
  $('count').classList.toggle('zero', n === 0);
  const base = n === 0
    ? (wasDeep ? 'Nothing here, even after opening things.' : 'Nothing loaded yet — try a deep scan.')
    : wasDeep ? 'assets, including hidden ones' : 'assets already on the page';
  const aside = [chrome && `${chrome} site`, ads && `${ads} ads`].filter(Boolean).join(', ');
  const tail = aside ? ` · ${aside} set aside` : '';
  $('caption').textContent = (savedAt ? `${base} · saved ${ago(savedAt)}` : base) + tail;
  // The count climbing on its own is the only signal that watching is working.
  // Flash it rather than adding a spinner that would never stop turning.
  if (n > lastCount && lastCount > 0) {
    $('count').classList.remove('bump');
    void $('count').offsetWidth; // restart the animation
    $('count').classList.add('bump');
  }
  lastCount = n;

  // Composition, at a glance, in the same colours the results window uses — the
  // two surfaces should read as one instrument rather than two products.
  const total = items.length || 1;
  // A bar that is 99.9% one colour is a solid block, and a solid block under a big
  // number reads as a progress meter that never moves. It earns its place only when a
  // real share of what was found is being set aside; otherwise the caption already says
  // so in words, and one line saying it is enough.
  const setAside = chrome + ads;
  const worthIt = items.length > 0 && setAside / items.length >= 0.03;
  $('strip').innerHTML = worthIt
    ? [['a', n], ['s', chrome], ['d', ads]]
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `<i class="${k}" style="flex:${v} 0 0"></i>`).join('')
    : '';
  $('strip').style.display = worthIt ? 'flex' : 'none';
  $('strip').title = worthIt
    ? `${n} kept · ${chrome} site furniture · ${ads} ad beacons` : '';

  const counts = {};
  real.forEach((i) => (counts[i.type] = (counts[i.type] || 0) + 1));
  $('chips').innerHTML = Object.entries(counts).sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `<span class="chip"><b>${c}</b> ${esc(t)}</span>`).join('');
  paintChipFade();

  // Openable even if all set aside — and when a walk filled a table with rows but found no files.
  $('open').hidden = !S.resultId || (!items.length && S.resultId !== S.tableId);
  renderCoverage(cov, n);

  // Unknown-ness alone IS the trigger, by request — not gated on what the scan found.
  // `siteBadge`'s "quiet by design" comment argued this would fire on nearly the whole
  // web and get tuned out; that tradeoff was raised and the answer was to show it anyway.
  //
  // Excludes loopback/local addresses on purpose: a dev server on your own machine is not a
  // "site" that belongs in a dictionary of the web, and nagging about one is the same mistake
  // the badge comment above warns against — noise nobody asked for. Not a test-detection hack;
  // this applies just as much to a real person running something on localhost.
  // Two different facts, one banner: never seen this host, or seen it on ONE route and not
  // this one. `partial` is the second (see the x.com entry in sites.js) and is the stronger
  // case for the agent — an unusual route or a custom field is what it is actually better at.
  const untested = (S.site.status === 'unknown' && !isLocalHost(tab?.url)) || S.site.status === 'partial';
  // A BANNER, NOT A HALFCARD. This used to `ask()`, which owns `#half` and blocks the panel until
  // it is answered — a modal question, with a Dismiss to earn, for a fact that asks nothing: the
  // site is untested, so the scan below is a guess. Because interrupting is expensive it also had
  // to be rationed (once per URL, and never while anything else was asking), which meant the
  // warning was frequently absent on exactly the pages it describes. A banner costs nothing to
  // leave on screen, so it needs none of that bookkeeping and is simply true whenever the fact is.
  // Repainted every poll tick on purpose: `bridgeLive` can flip mid-session, and the two readings
  // differ — telling someone to "set up an agent" beside their own open connection is the miss
  // `mcpHintText` exists to avoid.
  $('untested').hidden = !untested;
  if (untested) {
    const t = mcpHintText();
    $('untestedHead').textContent = t.head;
    $('untestedWhy').textContent = t.body;
    $('untestedGo').textContent = t.cta;
  }
}

// Two readings of the same fact, picked by `bridgeLive` — see its own comment for why that is
// asked fresh rather than trusted from whether a pairing merely exists. Telling someone who
// already has the connection window open to "set up an AI agent" is not a small wording miss:
// it reads as though nothing is connected when something plainly is, on their own screen.
// Cut to one sentence each. As a halfcard these had a heading and a paragraph because a card that
// takes over the panel has room to fill; in a banner beside the button, the heading was the same
// sentence twice ("isn't in our dictionary" under a bold "Untested site") and the paragraph
// explained a mechanism nobody is deciding about here. What is left is the only thing that changes
// what someone does next: the scan is a guess, and the better route, which differs by whether
// there is already an agent to ask.
function mcpHintText() {
  // PARTLY TESTED IS ITS OWN ANSWER. The host is known and one route on it is verified — X's
  // home timeline, worked over exhaustively — but this is not that route, and every other X
  // page renders from a different component. Saying "untested site" here would throw away what
  // IS known; saying "tested" would extend a promise nowhere near earned. It also has the
  // strongest case for the agent of the three: an unusual route or a field the columns do not
  // carry is precisely what a descriptor cannot be written for in advance.
  if (S.site.status === 'partial') {
    return {
      head: 'Partly tested.',
      body: S.bridgeLive
        ? `${S.site.elsewhere || ''} Ask your connected agent for this page, or for fields the `
          + 'columns here do not carry.'
        : `${S.site.elsewhere || ''} An AI agent reads any page of it directly, and takes custom `
          + 'fields you name — worth connecting for anything past the tested route.',
      cta: S.bridgeLive ? 'View connection' : 'Set up an AI agent',
    };
  }
  return {
    head: 'Untested site.',
    body: S.bridgeLive
      ? 'The scan is a best guess here — your connected agent reads this page directly.'
      : 'The scan is a best guess here — an AI agent reads network responses and app '
        + 'state directly, and does better on sites like this.',
    cta: S.bridgeLive ? 'View connection' : 'Set up an AI agent',
  };
}

// Say what was found AND what was skipped. The most common complaint in this
// category is not knowing whether the page was empty or the tool failed.
// The scan reports why it stopped as a machine-readable reason; these are the
// sentences for it. Interpolating the raw reason produced "Walk ended because it
// no new media in 4 screens".
const WHY = {
  'reached the end': 'Walked to the bottom of the page.',
  'no new media in 4 screens': 'Stopped after four screens with nothing new.',
  'hit the depth limit': 'Stopped at the depth limit.',
  'timed out': 'Stopped on the time limit.',
};

// A property list, so the figures form a column you can read without reading the
// labels. The old version was a paragraph of sentences with the numbers buried
// mid-line, which is the least scannable arrangement of exactly this data.
function renderCoverage(cov, found) {
  if (!cov || !cov.deep) { $('cov').hidden = true; return; }
  const row = (label, v, hi) => v ? `<dt>${label}</dt><dd class="${hi ? 'hi' : ''}">${v}</dd>` : '';
  $('cov').innerHTML =
    `<h3>Coverage</h3><dl>` +
    row('screens walked', cov.screens, true) +
    row('media triggers', cov.triggers, true) +
    row('opened', cov.clicked, true) +
    row('refused as unsafe', cov.skipped) +
    row('downloads blocked', cov.blockedDownloads) +
    row('popups dismissed', cov.dismissed) +
    row('unmatched to a row', cov.unmatched) +
    row('duplicates merged', cov.collapsed) +
    row('frames scanned', cov.frames > 1 ? cov.frames : 0) +
    `<dt>kept</dt><dd class="hi">${found}</dd></dl>` +
    // Never let a bounded walk read as a complete one.
    (cov.stopped ? `<div class="why">${esc(WHY[cov.stopped] || cov.stopped)}${
      cov.stopped === 'reached the end' ? '' : ' More may exist below — raise Thoroughness.'}</div>` : '');
  $('cov').hidden = false;
}

// Fades only the side that has more. A gradient over a start you have not left
// is a lie about there being something there.

// Edge fades on the chip row follow its scroll position.
function paintChipFade() {
  const el = $('chips');
  const max = el.scrollWidth - el.clientWidth;
  el.classList.toggle('fl', el.scrollLeft > 2);
  el.classList.toggle('fr', el.scrollLeft < max - 2);
}

export { show, paintChipFade };
