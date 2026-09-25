// The history screen: the timeline of scanned pages and the Clear button.
import { $, esc, pageLabel, shortAgo } from './panel-util.js';
import { S, tab } from './panel-state.js';
import { send, paintMenu } from './panel-shell.js';

// --- history ----------------------------------------------------------------
async function loadHistory() {
  const { history = [] } = await send({ type: 'GET_HISTORY' });
  const here = tab?.url;
  // The screen always exists now — a menu entry that vanishes when empty is
  // harder to find than one that says "none yet", so the empty state lives
  // inside the screen and on the menu row.
  S.lastHistoryCount = history.length;
  $('histEmpty').hidden = history.length > 0;
  if (!$('drawer').hidden) paintMenu();
  // WHAT THE LIST IS WORTH, before the list. History with no total answers half the question it
  // is opened to answer — "where have I been" without "what have I collected".
  const kept = history.reduce((n, h) => n + (h.count || 0), 0);
  $('histTotal').innerHTML = history.length
    ? `<b>${kept}</b><span>asset${kept === 1 ? '' : 's'} kept across `
      + `${history.length} page${history.length === 1 ? '' : 's'}</span>`
    : '';
  $('histTotal').hidden = !history.length;

  // A TIMELINE, and the time is read by POSITION rather than by a label repeated on every row.
  // The rows also lead with what the page WAS. `shortUrl` printed the tail of the URL — with
  // `direction:rtl` on top of it, four Maps runs all read `…om/krr-jrjj-vuz?authuser=0&hl=en`,
  // which names nothing, four times.
  $('histList').innerHTML = history.map((h) => {
    const p = pageLabel(h.url);
    return `
    <button class="hrow${h.url === here ? ' now' : ''}" data-id="${h.id}" title="${esc(h.url)}">
      <span class="ht">${shortAgo(h.scannedAt)}</span>
      <i class="hdot" aria-hidden="true"></i>
      <span class="hbody"><span class="hwhat">${esc(p.what)}</span>`
      + `<span class="hhost">${esc(p.host)}</span></span>
      <span class="hn">${h.count}</span>
    </button>`;
  }).join('');
  $('histList').querySelectorAll('.hrow').forEach((b) =>
    b.addEventListener('click', () => send({ type: 'OPEN_RESULTS', id: b.dataset.id }).catch(() => {}))
  );
}

function wireHistory() {
  $('histClear').addEventListener('click', async () => {
    await send({ type: 'CLEAR_HISTORY' });
    S.resultId = null;
    loadHistory();
  });
}

export { loadHistory, wireHistory };
