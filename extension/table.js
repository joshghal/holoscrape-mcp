const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');

// --- named values ---------------------------------------------------------------------------------
// This is a CLASSIC page script (see table.html), so it cannot import `tuning.js`; the values it
// shares with the rest of the extension are written here a second time and marked as such.
// Declared ABOVE `load()` on purpose — that call runs before the rest of this file is evaluated,
// and it reads the storage key synchronously.
//
// Where a result's tables and assets live: `table:<resultId>`. Mirrors `TABLE_KEY_PREFIX` in
// tuning.js, which the bridge ops and the panel read the same rows through.
const TABLE_KEY_PREFIX = 'table:';
// Below this width a picture tagged icon/logo/tiny is site furniture and filed under "chrome";
// at or above it, it is an asset someone may have come for — a 1178px "logo" is a picture.
const CHROME_MAX_W = 400;
// A blob this small, fetched whole from a video url, is the leading fragment the CDN answers a
// Range request with (measured live at under 1 KB), not the file — comfortably above that is
// presumed to be the real thing rather than another copy of the fragment.
const FRAGMENT_MAX_BYTES = 8192;
// The lightbox's progress readout is repainted at most this often while bytes stream in.
const LB_PROGRESS_PAINT_MS = 120;
// How long a "Copied" / "✓" acknowledgement replaces a button's label before it reverts.
const COPIED_LABEL_MS = 900;
// How long `flash()` shows a confirmation on an export button.
const FLASH_MS = 1200;
// How long a download's object URL is kept alive after the click — long enough for the browser
// to have opened it, short enough that a session of exports does not pin a hundred blobs.
const REVOKE_URL_MS = 2000;
// The search field is rebuilt once you stop typing, not once per key: at 800 rows a keystroke
// cost ~160ms, so the field fell behind the typist by several characters.
const SEARCH_DEBOUNCE_MS = 110;
// Cell edits are written to storage this long after the last blur, coalesced — a 245-row table
// is not something to rewrite per keystroke.
const SAVE_DEBOUNCE_MS = 400;
// Rows per page in both views when nobody has picked a size, and the point below which the pager
// bar is hidden (a table that fits one page needs no pager). Also the first entry of PAGE_SIZES.
const PAGE_SIZE_DEFAULT = 50;
// How much of a url segment or a sheet label goes into an export's file name.
const NAME_PART_MAX_CHARS = 40;

let all = [];
let sel = new Set();
let typeFilter = null;
let fmtFilter = null;
let showChrome = false;
let showTrackers = false;
// Rows whose preview failed to load. Held here rather than only in the DOM so a
// re-render cannot silently re-select something that will download nothing.
let broken = new Set();
let sortKey = null;
let sortDir = 1;
// Rows are created and destroyed constantly once the table is windowed, so every
// handler lives on this one element instead.
const rowsEl = document.getElementById('rows');

load();

async function load() {
  if (!id) return fail('No result id in the URL.');
  const store = await chrome.storage.local.get(TABLE_KEY_PREFIX + id);
  // AFTER THE FIRST AWAIT, NOT BEFORE IT. `load()` is invoked at the top of this file, before
  // the rest of it has been evaluated, so anything it touches synchronously must be hoisted —
  // `paintSizeLabels` and `PAGE_SIZES` are both `const` further down and are in the temporal
  // dead zone until then. Called here the await has already yielded, the whole script has run,
  // and both exist. Placing this one line above threw a ReferenceError that aborted `load`
  // entirely: `srcUrl` never got set and every export came out named for no page at all.
  paintSizeLabels();
  const data = store[TABLE_KEY_PREFIX + id];
  if (!data) return fail('These results have expired. Scan again.');

  all = (data.items || []).map((i) => ({ ...i, name: fileName(i.url), variants: i.variants || [{ url: i.url, label: '' }] }));
  // Everything the page owns is selected; site furniture and ad beacons are not.
  // They stay in the data and one chip brings them back — hiding them outright
  // would be the same dishonesty as reporting an empty page as a failure.
  // Host in the readable colour, path muted — the identity of the page first,
  // the route second, instead of one long grey truncation.
  const u = data.url || '';
  try {
    const x = new URL(u);
    $('src').innerHTML = `<b>${esc(x.hostname.replace(/^www\./, ''))}</b>${esc(x.pathname + x.search)}`;
  } catch { $('src').textContent = u; }
  $('src').href = u;
  $('src').title = u;
  $('when').textContent = data.scannedAt ? new Date(data.scannedAt).toLocaleString() : '';
  renderCoverage(data.coverage);
  document.title = `HoloScrape — ${all.length} files`;
  renderChips();
  selectVisible(); // same rule as every later filter change
  render();

  // Tables the page held, each becoming a tab beside Files.
  srcUrl = data.url || '';
  sheets = (data.tables || []).filter((t) => t.rows?.length);
  initSheets();
  // Land on whichever view actually has something in it: a page that yielded a
  // table and no files should not open on an empty file list.
  //
  // "No files" has to mean no files WORTH HAVING, not a count of zero. Google Maps
  // yields 36 entries and every one of them is an analytics beacon or an HTML endpoint —
  // `gen_204`, `adview`, all badged "not a file" — while the tab beside it holds 64
  // businesses with their phone numbers. Opening on Files there hid the only useful
  // thing behind a list of junk, and it read as "the scan found nothing".
  const keepers = all.filter((r) => r.type !== 'page' && !isNoise(r));
  goView(!keepers.length && sheets.length ? 0 : -1);

  watchStore();
}

// The panel goes on scanning while this window is open. Left alone, the two
// disagree — the panel counting 160 while the table still shows the 55 it opened
// with, which reads as data loss rather than as a stale view.
//
// This watched `items` and nothing else, which meant it was blind to exactly the
// case people hit: a second deep scan whose gain is ROWS. A row save carries
// `items: []`, so the file count went down rather than up, the guard returned, and
// the window sat there showing the first scan's table for as long as it stayed open.
// Scanning twice and seeing no change is indistinguishable from the scan not working.
const rowsIn = (tables) => (tables || []).reduce((a, t) => a + (t.rows?.length || 0), 0);
// And the third way a table can grow, which is neither of the above: WIDER. Opening each
// row adds what the record's own page said — a full address, coordinates, the international
// phone number — to rows that already existed. The row count does not move and neither does
// the file count, so a watcher that reads only those two sees nothing happen and the window
// sits there showing the table it opened with. Which is exactly the shape of the bug the
// comment above describes for rows; this is the same mistake one axis over.
const colsIn = (tables) => (tables || []).reduce((a, t) => a + (t.cols?.length || 0), 0);

function watchStore() {
  let pending = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const next = changes[TABLE_KEY_PREFIX + id]?.newValue;
    if (!next) return;

    const moreFiles = (next.items?.length || 0) - all.length;
    const moreRows = rowsIn(next.tables) - rowsIn(sheets);
    const moreCols = colsIn(next.tables) - colsIn(sheets);
    if (moreFiles <= 0 && moreRows <= 0 && moreCols <= 0) return;

    pending = next;
    const parts = [];
    if (moreFiles > 0) parts.push(`${moreFiles} more asset${moreFiles === 1 ? '' : 's'}`);
    if (moreRows > 0) parts.push(`${moreRows} more row${moreRows === 1 ? '' : 's'}`);
    if (moreCols > 0) parts.push(`${moreCols} more column${moreCols === 1 ? '' : 's'}`);
    // Additive and nothing in flight: just show it. The button is for changes that would move
    // something, and this is not one of them.
    if (additive(next) && !pointerDown) { apply(); return; }
    $('fresh').hidden = false;
    $('fresh').textContent = `${parts.join(' and ')} found since you opened this — show them`;
  });

  // APPEND WITHOUT ASKING WHEN APPENDING CANNOT MOVE ANYTHING.
  //
  // The button exists for a good reason and it is written above: a re-render must not shift rows
  // out from under a cursor that is mid-click. But that reasoning only covers a change that MOVES
  // what is already on screen. A scan that appends assets to the end of the grid moves nothing —
  // and making someone click "show them" for each batch turns a live scan into a clicking exercise,
  // which is what it had become: a deep walk now sweeps the DOM at every screen, so batches arrive
  // steadily and each one raised the button again.
  //
  // So the two cases are told apart instead of being treated as one:
  //
  //   PURELY ADDITIVE — every asset already on screen is still at the same index, and the new ones
  //   sit after them. Nothing the cursor is over can move. Applied immediately, no button.
  //
  //   ANYTHING ELSE — a re-ordered or replaced set, a table whose columns changed, rows rewritten
  //   wider by a details pass. Those move things. The button still asks, exactly as before.
  //
  // And even an additive change waits while a pointer is actually down, because a click in flight
  // is the one moment a grid must not grow under it.
  let pointerDown = false;
  addEventListener('pointerdown', () => { pointerDown = true; }, true);
  addEventListener('pointerup', () => {
    pointerDown = false;
    // A batch that arrived mid-click lands the moment the click finishes, rather than waiting for
    // the next one to trigger a re-check.
    if (pending && additive(pending)) apply();
  }, true);

  // Additive means: the assets on screen are a PREFIX of the incoming ones, url for url. Compared by
  // url rather than by count — a set that gained two and lost one has the same length and is not
  // additive, and treating it as such is how a grid silently swaps an item under a selection.
  const additive = (next) => {
    const incoming = next.items || [];
    if (incoming.length < all.length) return false;
    for (let i = 0; i < all.length; i++) if (incoming[i]?.url !== all[i].url) return false;
    // Tables are only additive if no sheet lost rows or columns; a details pass rewrites rows in
    // place and that is a move, not an append.
    const before = sheets, after = (next.tables || []).filter((t) => t.rows?.length);
    if (after.length < before.length) return false;
    for (let i = 0; i < before.length; i++) {
      if ((after[i]?.rows?.length || 0) < before[i].rows.length) return false;
      if ((after[i]?.cols?.length || 0) !== before[i].cols.length) return false;
    }
    return true;
  };

  const apply = () => {
    if (!pending) return;
    const data = pending;
    pending = null;
    $('fresh').hidden = true;

    if (data.items?.length) {
      all = data.items.map((i) => ({ ...i, name: fileName(i.url), variants: i.variants || [{ url: i.url, label: '' }] }));
      broken = new Set();   // indices moved; a stale set would blank the wrong rows
      filesPage = 0;
      invalidate();
      renderCoverage(data.coverage);
      renderChips();
      selectVisible();
    }

    // Column names and hidden columns are the user's edits, so only the data is
    // replaced.
    if (data.tables?.length) {
      sheets = data.tables.filter((t) => t.rows?.length);
      if (sheetAt >= sheets.length) sheetAt = sheets.length - 1;
      paintTabs();
    }

    if (sheetAt >= 0) paintSheet();
    else render();
  };

  $('fresh').addEventListener('click', apply);
}

// Never let the user wonder whether the page was empty or the tool failed.
function renderCoverage(cov) {
  const el = $('cov');
  if (!cov || !cov.deep) { el.textContent = ''; return; }
  const bits = [];
  if (cov.screens) bits.push(`<b>${cov.screens}</b> screens walked${cov.stopped ? ` (${esc(cov.stopped)})` : ''}`);
  if (cov.triggers) bits.push(`<b>${cov.triggers}</b> triggers found`);
  if (cov.clicked) bits.push(`<b>${cov.clicked}</b> opened`);
  if (cov.skipped) bits.push(`${cov.skipped} refused as unsafe`);
  if (cov.blockedDownloads) bits.push(`${cov.blockedDownloads} downloads blocked`);
  if (cov.dismissed) bits.push(`${cov.dismissed} popups dismissed`);
  if (cov.unmatched) bits.push(`${cov.unmatched} unmatched to a row`);
  el.innerHTML = bits.join(' &middot; ');
}

function fail(msg) {
  $('empty').textContent = msg;
  $('empty').style.display = 'block';
  ['csv', 'json', 'copy', 'dl'].forEach((b) => ($(b).disabled = true));
}

const fileName = (u) => {
  try { return decodeURIComponent(new URL(u).pathname.split('/').pop() || u); }
  catch { return u; }
};

// Two different things, so two different buckets. The site's own furniture
// (favicon, logo, sprites) comes from the same domain as its real content and
// is not "ads" — filing them together is what made the bucket look wrong.
const CHROME_TAGS = ['icon', 'logo', 'tiny'];
const isTracker = (r) => (r.tags || []).includes('tracker');
// Size overrules the name — see `CHROME_MAX_W` at the top of this file.
const isChrome = (r) =>
  !isTracker(r) && (r.w || 0) < CHROME_MAX_W && (r.tags || []).some((t) => CHROME_TAGS.includes(t));
const isNoise = (r) => isTracker(r) || isChrome(r);

// One pass, not five, and cached. view() is read by render, stat, selectVisible,
// the lightbox and the measure pass, so at 800 rows an uncached version cost
// ~6ms every time anyone asked a question about the table — including once per
// checkbox click. Anything that changes the answer calls invalidate().
let viewCache = null;
const invalidate = () => { viewCache = null; };

// A reused collator. String.localeCompare builds one per call, which is what made
// sorting 800 rows take 280ms.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function view() {
  if (viewCache) return viewCache;
  const q = $('q').value.trim().toLowerCase();
  const out = [];
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    if (!showChrome && isChrome(r)) continue;
    if (!showTrackers && isTracker(r)) continue;
    if (typeFilter && r.type !== typeFilter) continue;
    if (fmtFilter) {
      const ok = fmtFilter === 'hidden'
        ? (r.tags || []).includes('hidden')
        : (r.formats || []).includes(fmtFilter);
      if (!ok) continue;
    }
    if (q && !`${r.title} ${r.name} ${r.url}`.toLowerCase().includes(q)) continue;
    out.push({ r, i });
  }
  if (sortKey) {
    // Numbers compare as numbers. Sorting bytes as text put 9 KB after 10 MB.
    const numeric = sortKey === 'bytes' || sortKey === 'w' || sortKey === 'h';
    out.sort(numeric
      ? (a, b) => ((a.r[sortKey] || 0) - (b.r[sortKey] || 0)) * sortDir
      : (a, b) => collator.compare(String(a.r[sortKey] ?? ''), String(b.r[sortKey] ?? '')) * sortDir);
  }
  viewCache = out;
  return out;
}

// The ribbon under the toolbar. Segments are sized to the real bucket counts, so
// the shape of the page is readable before a single row is. Doubles as the
// filter: clicking a segment toggles that bucket.
function renderBand(assets, site, ads) {
  const total = assets + site + ads || 1;
  const seg = [
    ['assets', assets, true, `${assets} assets`],
    ['site', site, showChrome, `${site} site files — click to ${showChrome ? 'hide' : 'show'}`],
    ['ads', ads, showTrackers, `${ads} ads & analytics — click to ${showTrackers ? 'hide' : 'show'}`],
  ];
  $('band').innerHTML = seg
    .filter(([, n]) => n > 0)
    .map(([k, n, on, tip]) =>
      `<i class="${k}${on ? '' : ' off'}" style="flex:${n} 0 0" data-band="${k}" title="${esc(tip)}"></i>`)
    .join('');
  $('band').style.opacity = total ? 1 : 0;
  $('band').querySelectorAll('i[data-band]').forEach((el) =>
    el.addEventListener('click', () => {
      if (el.dataset.band === 'site') showChrome = !showChrome;
      else if (el.dataset.band === 'ads') showTrackers = !showTrackers;
      else return;
      filesPage = 0; // a new filter is a new set — page 4 of it means nothing
      invalidate();
      renderChips();
      selectVisible();
      render();
    }));
}

function renderChips() {
  const chromeCount = all.filter(isChrome).length;
  const trackerCount = all.filter(isTracker).length;
  renderBand(all.length - chromeCount - trackerCount, chromeCount, trackerCount);
  const pool = all.filter((r) => (showChrome || !isChrome(r)) && (showTrackers || !isTracker(r)));
  const byType = {}, byTag = {};
  pool.forEach((i) => {
    byType[i.type] = (byType[i.type] || 0) + 1;
    (i.tags || []).forEach((t) => (byTag[t] = (byTag[t] || 0) + 1));
  });

  const types = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  // With a single type, "all 99" and "image 99" said the same thing twice. Name
  // the type in the sentence instead and drop the row of toggles entirely.
  const noun = types.length === 1 ? plural(types[0][0], pool.length)
    : (showChrome && showTrackers ? 'files' : 'assets');

  $('chips').innerHTML =
    `<span class="lead"><b>${pool.length}</b>${esc(noun)}</span>` +
    (types.length > 1
      ? `<span class="tabs"><i class="ind" aria-hidden="true"></i>` +
        `<button class="tog${typeFilter === null ? ' on' : ''}" data-t="">all</button>` +
        types.map(([t, n]) =>
          `<button class="tog${typeFilter === t ? ' on' : ''}" data-t="${esc(t)}">${esc(t)} ${n}</button>`).join('') +
        '</span>'
      : '') +
    ((chromeCount || trackerCount) ? '<span class="held">' +
      (chromeCount ? `<button class="tog${showChrome ? ' on' : ''}" data-noise="chrome">${chromeCount} site files</button>` : '') +
      (trackerCount ? `<button class="tog${showTrackers ? ' on' : ''}" data-noise="tracker">${trackerCount} ads &amp; analytics</button>` : '') +
      '</span>' : '');

  $('chips').querySelectorAll('button').forEach((c) =>
    c.addEventListener('click', () => {
      if (c.dataset.noise === 'chrome') showChrome = !showChrome;
      else if (c.dataset.noise === 'tracker') showTrackers = !showTrackers;
      else typeFilter = c.dataset.t || null;
      filesPage = 0; // a new filter is a new set — page 4 of it means nothing
      invalidate();
      renderChips();
      selectVisible();
      render();
    }));
  slideTabs();

  // Formats: a fact off the URL, not a guess about the picture. Six of these as
  // equal-weight pills was six decisions offered at once for a choice most
  // people never make, so it collapses to one control that stays quiet until used.
  const byFmt = {};
  pool.forEach((i) => (i.formats || []).forEach((f) => (byFmt[f] = (byFmt[f] || 0) + 1)));
  const hidden = byTag.hidden || 0;
  const fmts = Object.entries(byFmt).sort((a, b) => b[1] - a[1]);
  const btn = $('tags');
  btn.hidden = fmts.length < 2 && !hidden;
  btn.textContent = fmtFilter === 'hidden' ? 'Only hidden' : (fmtFilter || 'Any format');
  btn.classList.toggle('on', !!fmtFilter);
  fmtOptions = [
    { value: '', label: 'Any format', hint: String(pool.length) },
    ...(hidden ? [{ value: 'hidden', label: 'Only hidden', hint: String(hidden) }] : []),
    ...fmts.map(([f, n]) => ({ value: f, label: f, hint: String(n) })),
  ];
}

let fmtOptions = [];

// Moves the marker to the active tab. Measured from the live element rather than
// derived from an index, because the labels carry their counts and so differ in
// width. Re-runs after a re-render, when the old geometry is gone.
function slideTabs() {
  const group = $('chips').querySelector('.tabs');
  if (!group) return;
  const ind = group.querySelector('.ind');
  const on = group.querySelector('.tog.on');
  if (!ind || !on || !on.offsetWidth) return;
  ind.style.width = `${on.offsetWidth}px`;
  ind.style.transform = `translateX(${on.offsetLeft}px)`;
}
addEventListener('resize', slideTabs);

const plural = (t, n) => ` ${t}${n === 1 ? '' : t.endsWith('s') ? 'es' : 's'}`;

// --- menu -------------------------------------------------------------------
// One popover for every menu in the window. A native <select> cannot be brought
// into this design — the browser owns its list, its arrow and its highlight —
// and it has to keep the keyboard behaviour people expect from one: arrows to
// move, Enter to take, Escape to leave, Tab or an outside click to dismiss.
let popAnchor = null, popPick = null, popCursor = 0;
// Declared here rather than beside the hover code below, because `closeMenu` clears them and
// a `let` read before its declaration is evaluated is a ReferenceError, not an undefined.
let hoverIn = 0, hoverOut = 0;

function openMenu(anchor, options, current, onPick) {
  if (popAnchor === anchor) return closeMenu();
  const el = $('pop');
  popAnchor = anchor;
  popPick = onPick;
  popCursor = Math.max(0, options.findIndex((o) => o.value === current));

  // A LIST OF CHOICES AND A LIST OF ACTIONS ARE NOT THE SAME CONTROL, and the anchor
  // already says which it is. "Any format" picks a value that stays picked, so it is a
  // listbox of options; "Export" fires something and is over, so it is a menu of
  // menuitems. Reading the role off `aria-haspopup` means the two agree by construction —
  // `#psize` used to claim `menu` in the markup and get `option` children here, which is a
  // screen reader being told two different things about one control.
  const asMenu = anchor.getAttribute('aria-haspopup') === 'menu';
  const role = asMenu ? (current == null ? 'menuitem' : 'menuitemradio') : 'option';
  const state = asMenu ? (current == null ? '' : 'aria-checked') : 'aria-selected';
  el.setAttribute('role', asMenu ? 'menu' : 'listbox');

  el.innerHTML = options.map((o, n) =>
    `<button class="popi${o.value === current ? ' on' : ''}${n === popCursor ? ' cursor' : ''}"
       role="${role}"${state ? ` ${state}="${o.value === current}"` : ''}
       data-v="${esc(o.value)}"><span>${esc(o.label)}</span>${o.hint ? `<i>${esc(o.hint)}</i>` : ''}</button>`
  ).join('');
  el.hidden = false;
  anchor.setAttribute('aria-expanded', 'true');

  // Placed after it has a size, and flipped when there is no room below.
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.top = `${r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  el.style.left = `${Math.min(Math.max(8, r.left), innerWidth - w - 8)}px`;

  el.querySelectorAll('.popi').forEach((b) =>
    b.addEventListener('click', () => { const v = b.dataset.v; closeMenu(); onPick(v); }));
  el.querySelector('.cursor')?.scrollIntoView({ block: 'nearest' });
}

function closeMenu() {
  clearTimeout(hoverIn);   // a pending hover-open must not resurrect what was just dismissed
  clearTimeout(hoverOut);
  $('pop').hidden = true;
  popAnchor?.setAttribute('aria-expanded', 'false');
  popAnchor = null;
  popPick = null;
}

// --- opening on hover -------------------------------------------------------
// HOVER IS THE FAST WAY IN, NEVER THE ONLY ONE. A menu that only opens on hover cannot be
// reached by a finger or by Tab, and this window is a normal page people will do both to.
// So click and keyboard focus open it as well, and the hover layer sits on top of those.
//
// The two delays are the whole design. Without the first, dragging the pointer across the
// toolbar on the way to something else pops the menu open in your face. Without the second,
// the diagonal path from the button to the item you want leaves the button's box for a few
// pixels and the menu vanishes from under the cursor.
const HOVER_IN = 130;
const HOVER_OUT = 260;
// A device that cannot hover must not have hover wiring at all: on touch, `pointerenter`
// fires on tap and would make one tap both open and toggle the menu.
const CAN_HOVER = matchMedia('(hover: hover) and (pointer: fine)').matches;
const hoverAnchors = new Set();

function hoverClose() {
  clearTimeout(hoverOut);
  hoverOut = setTimeout(() => { if (hoverAnchors.has(popAnchor)) closeMenu(); }, HOVER_OUT);
}

// `open` is passed in rather than being `openMenu` directly, because these menus are rebuilt
// from live state every time — how many images there are to download changes with the
// columns on screen.
function hoverMenu(anchor, open) {
  hoverAnchors.add(anchor);
  anchor.addEventListener('click', () => {
    clearTimeout(hoverIn);
    clearTimeout(hoverOut);
    // On a mouse the pointer is sitting on the button, so it is almost certainly open
    // already and toggling would close what the hover just opened. On touch there was no
    // hover, so a second tap is the only way to dismiss it.
    if (popAnchor === anchor) { if (!CAN_HOVER) closeMenu(); return; }
    open();
  });
  // Tab, not click. `:focus-visible` is the browser's own answer to which of the two this
  // is, so a click does not open the menu twice.
  anchor.addEventListener('focus', () => {
    if (popAnchor !== anchor && anchor.matches(':focus-visible')) open();
  });
  if (!CAN_HOVER) return;
  anchor.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(hoverOut);
    if (popAnchor === anchor) return;
    clearTimeout(hoverIn);
    hoverIn = setTimeout(open, HOVER_IN);
  });
  anchor.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(hoverIn);
    if (popAnchor === anchor) hoverClose();
  });
}

// The popover is shared, so it only grants the grace period to menus that asked for it —
// leaving it must not dismiss the click-driven "Any format" or page-size pickers.
$('pop').addEventListener('pointerenter', () => clearTimeout(hoverOut));
$('pop').addEventListener('pointerleave', (e) => {
  if (e.pointerType === 'mouse' && hoverAnchors.has(popAnchor)) hoverClose();
});

// One line per surface: the anchor, the options it should show right now, and what a pick
// does. Both toolbars go through this, so they cannot drift apart.
function exportMenu(id, options, onPick) {
  const el = $(id);
  // Never the toggle branch of `openMenu`: for these the pointer leaving is what closes it,
  // and a click that arrived while it was open would otherwise shut it.
  hoverMenu(el, () => { if (popAnchor !== el) openMenu(el, options(), null, onPick); });
}

// The four writers, as data. One list is why the two toolbars offer the same things in the
// same order, and a fifth format is a row here rather than a button, a handler and a rule
// in the stylesheet.
const EXPORTS = [
  { value: 'csv', label: 'CSV', hint: '.csv' },
  { value: 'json', label: 'JSON', hint: '.json' },
  { value: 'xlsx', label: 'Excel', hint: '.xlsx' },
  { value: 'pdf', label: 'PDF', hint: '.pdf' },
];

function moveCursor(d) {
  const items = [...$('pop').querySelectorAll('.popi')];
  if (!items.length) return;
  popCursor = (popCursor + d + items.length) % items.length;
  items.forEach((b, n) => b.classList.toggle('cursor', n === popCursor));
  items[popCursor].scrollIntoView({ block: 'nearest' });
}

addEventListener('keydown', (e) => {
  if ($('pop').hidden) return;
  if (e.key === 'Escape') { closeMenu(); popAnchor?.focus?.(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); moveCursor(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1); }
  else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    const b = $('pop').querySelectorAll('.popi')[popCursor];
    if (b) { const v = b.dataset.v, pick = popPick; closeMenu(); pick(v); }
  }
}, true);
addEventListener('pointerdown', (e) => {
  if (!$('pop').hidden && !e.target.closest('#pop') && e.target !== popAnchor) closeMenu();
});
addEventListener('resize', closeMenu);
// The popover is fixed to the viewport, so a scrolling table would leave it
// pointing at nothing.
document.addEventListener('scroll', () => { if (!$('pop').hidden) closeMenu(); }, true);

// --- lightbox ---------------------------------------------------------------
// Steps through the previewable rows that are CURRENTLY VISIBLE, not all of
// them, so arrowing never lands on a row the active filter has excluded.
// Images and video share one frame: same navigation, same download, same Esc.
// Streams are excluded — an .m3u8 in a <video> plays in Safari and nowhere else,
// and a permanently broken player is worse than no player.
let lbAt = -1;
// The object URL behind a fetched video blob (see `playVideo`), tracked so it can be revoked —
// `vid.removeAttribute('src')` detaches it from the element but does not free the memory, and a
// person stepping through ten video posts in a row would otherwise leak ten of these.
let lbBlobUrl = null;
function releaseLbBlob() {
  if (lbBlobUrl) URL.revokeObjectURL(lbBlobUrl);
  lbBlobUrl = null;
}
// A video preview is a whole-file download before a single frame shows (see `playVideo`),
// and these files reach hundreds of megabytes — one measured at 388MB, 2160x3840, 3:12.
// Two things follow. Leaving for another row must CANCEL that download rather than let it
// finish into an element nobody is looking at, and every resumption point after an `await`
// has to check it is still the row someone is on — otherwise a slow fetch for row 4 sets
// the source on row 7's frame. `lbTicket` is that check; `lbAbort` is the cancellation.
let lbTicket = 0;
let lbAbort = null;
function abortLbFetch() {
  if (lbAbort) lbAbort.abort();
  lbAbort = null;
  lbTicket++;
}
// A real 0-100% whenever a total is known, and a total is known nearly always: the CDN sends
// `content-length` on these files, and where it doesn't, the scan's own measured byte count
// stands in. Only when BOTH are missing does this fall back to a sweep — better than a
// percentage invented out of nothing, which would stall at a wrong number and read as frozen.
function showLbLoad(got, total) {
  const bar = $('lbLoad').querySelector('.lb-load-bar');
  // Clamped: an estimated total can be smaller than the file really is, and a bar that
  // reports 140% is worse than one that sits at 100 for the last moment.
  const pct = total ? Math.min(100, Math.floor((got / total) * 100)) : 0;
  bar.classList.toggle('indet', !total);
  $('lbLoadPct').hidden = !total;
  $('lbLoadPct').textContent = `${pct}%`;
  // scaleX, not width — see `.lb-load-bar span`. 0..1 of the track.
  $('lbLoadFill').style.transform = total ? `scaleX(${Math.min(1, got / total).toFixed(4)})` : '';
  // With no total there is no percentage to show, so the byte count carries the whole
  // message and has to say on its own that something is arriving.
  $('lbLoadTxt').textContent = total
    ? `${bytes(got)} of ${bytes(total)}`
    : `${got ? bytes(got) : '0 B'} so far — size unknown`;
  $('lbLoad').hidden = false;
}
function hideLbLoad() { $('lbLoad').hidden = true; }
// What the viewer can actually show, and how. Nothing here calls out to a
// third-party rendering service: sending someone's file URL to Google's or
// Microsoft's document viewer to get a picture of it is not a preview, it is a
// disclosure. Chrome renders PDFs itself, text is text, and everything else says
// so plainly rather than showing an empty frame.
const TEXTUAL = /\.(csv|txt|log|md|json|xml|vtt|srt|ttml|dfxp|ass|ssa|sbv|sub)(\?|$)/i;
const showsAs = (r) => {
  if (r.type === 'image') return 'image';
  if (r.type === 'video') return 'video';
  if (r.type === 'pdf') return 'pdf';
  if (r.type === 'subtitle' || TEXTUAL.test(r.url)) return 'text';
  if (r.type === 'doc' || r.type === 'file') return 'none';
  return null;   // stream, page, audio — audio has its own player in the row
};
const lbList = () => view().filter(({ r }) => showsAs(r)).map(({ i }) => i);
const MAX_TEXT = 400 * 1024;   // past this it is a data file, not something to read

function openLightbox(n) {
  const list = lbList();
  lbAt = list.indexOf(n);
  if (lbAt < 0) return;
  paintLightbox();
  $('lb').hidden = false;
  $('lbX').focus();
}

function paintLightbox() {
  const list = lbList();
  const r = all[list[lbAt]];
  if (!r) return closeLightbox();
  const img = $('lbImg'), vid = $('lbVid'), note = $('lbNote');
  const doc = $('lbDoc'), txt = $('lbText'), cant = $('lbCant');
  const how = showsAs(r);

  // Everything off first, then exactly one on. Leaving the last one showing is
  // how a PDF ended up behind an image.
  note.hidden = true;
  img.hidden = doc.hidden = txt.hidden = cant.hidden = true;
  vid.hidden = true;
  $('lbVwrap').hidden = true;
  hideLbLoad();
  abortLbFetch();
  vid.pause();
  vid.removeAttribute('src');
  releaseLbBlob();
  doc.removeAttribute('src');

  if (how === 'pdf') {
    doc.hidden = false;
    doc.src = r.url;
  } else if (how === 'text') {
    txt.hidden = false;
    txt.textContent = 'Loading…';
    loadText(r, txt);
  } else if (how === 'none') {
    cant.hidden = false;
    $('lbCantExt').textContent = (r.name.match(/\.([a-z0-9]{2,5})$/i) || [undefined, r.type])[1];
    $('lbCantWhy').textContent = 'No browser can render this without an application. '
      + 'Download it and open it where it belongs.';
  }

  const isVideo = how === 'video';
  img.hidden = how !== 'image';
  vid.hidden = !isVideo;
  $('lbVwrap').hidden = !isVideo;
  if (isVideo) {
    img.removeAttribute('src');
    playVideo(r, vid, note, list);
  } else {
    vid.load();
    if (how === 'image') img.src = r.url;
  }
  paintMeta(r, list);
}

// X's OWN INTERNAL VIDEO FILES ARE SESSION-BOUND; ITS PUBLIC SYNDICATION FILES ARE NOT.
//
// Reported live on x.com: a captured `video.twimg.com/amplify_video/…` url reached readyState
// 4 and then failed to play — `PipelineStatus::PIPELINE_ERROR_READ: FFmpegDemuxer: demuxer
// seek failed`. Measured live, twice, with a fresh url each time: a plain `fetch()` of that
// SAME url (no Range header, `credentials:'omit'`) came back with a ZERO-byte body — not a
// small fragment, nothing at all. That url is genuinely not meant to be fetched outside the
// authenticated x.com tab that requested it.
//
// What IS meant for exactly this: `cdn.syndication.twimg.com/tweet-result` — the same public,
// unauthenticated endpoint X's own oEmbed-style embeds use, keyed by the TWEET's id (not the
// video's own internal id) plus a token derived from it with a documented, widely-used
// formula. Its `mediaDetails[].video_info.variants[]` are plain `video/mp4` urls — measured
// live, one came back 17.4MB with `access-control-allow-origin: *`: a complete, ordinary,
// third-party-fetchable file, nothing session-bound about it at all.
//
// `r.statusId` is attached by `scan.js` at scan time, by cross-referencing the video's own
// internal id (present on both the captured file's url and the enclosing post's poster
// thumbnail) against that post's own permalink — no network call made until someone actually
// opens this one file's preview.
function syndicationToken(id) {
  // Split via BigInt before the float math — a tweet id is 19 digits now, past
  // Number.MAX_SAFE_INTEGER (16), so converting it to a Number directly first can silently
  // drop precision the token formula then bakes in wrong. High and low 15-digit halves added
  // back together keeps every digit through the conversion.
  const n = BigInt(id);
  const HALF = 1000000000000000n;
  return ((Number(n / HALF) + Number(n % HALF) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}
async function resolveSyndicatedVideo(r, signal) {
  if (!r.statusId) return null;
  // The internal id this specific FILE carries — a tweet can hold more than one video (a
  // quote-post's own clip alongside the quoted post's), and the syndication reply lists every
  // media item on the tweet, so the match has to be to isolate the one someone actually opened.
  const wantId = (r.url.match(/(?:amplify_video|ext_tw_video)\/(\d+)\//) || [])[1];
  const res = await fetch(
    `https://cdn.syndication.twimg.com/tweet-result?id=${r.statusId}&token=${syndicationToken(r.statusId)}`,
    { credentials: 'omit', signal },
  );
  if (!res.ok) return null;
  const data = await res.json();
  const variantSets = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.variants)) variantSets.push(node.variants);
    for (const v of Object.values(node)) walk(v);
  })(data);
  for (const variants of variantSets) {
    const mp4 = variants.filter((v) => v.content_type === 'video/mp4');
    if (!mp4.length) continue;
    const matched = wantId ? mp4.filter((v) => v.url.includes(`/${wantId}/`)) : [];
    const pool = matched.length ? matched : mp4;
    // Highest bitrate first — the point of asking at all is the real, full-quality file.
    pool.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    if (pool[0]) return pool[0].url;
  }
  return null;
}

// Reads the body a chunk at a time instead of `res.blob()`, purely so there is something
// to report while it runs — `blob()` is one opaque await with no way to ask how far along
// it is. `content-length` is what the bar is measured against; when a server omits it the
// caller falls back to a sweep. Repaints are capped at ~8/s: a 388MB file arrives in
// thousands of chunks and a DOM write per chunk costs more than the download.
async function readWithProgress(res, mine, sizeHint) {
  // A CROSS-ORIGIN RESPONSE HIDES ITS HEADERS UNLESS THE SERVER EXPOSES THEM, so a percentage
  // is not a given — `headers.get('content-length')` returns null on a CORS response that did
  // not list it in `access-control-expose-headers`, however plainly the header is on the wire.
  // Measured on video.twimg.com, 2026-09-19: it answers `access-control-expose-headers:
  // Content-Length` alongside `access-control-allow-origin: *`, so X's own video files do give
  // a real total here. A CDN that does not is the case `sizeHint` and the sweep exist for.
  // `content-length` is the truth when it is there. `sizeHint` is the size the scan measured
  // for this same file, used ONLY as a stand-in when the header is absent — an approximation
  // that keeps a percentage on screen is worth more here than an honest sweep that tells the
  // person nothing about how long they are waiting.
  const total = Number(res.headers.get('content-length')) || sizeHint || 0;
  const type = res.headers.get('content-type') || 'video/mp4';
  if (!res.body || typeof res.body.getReader !== 'function') return res.blob();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0, painted = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (!mine()) { reader.cancel().catch(() => {}); break; }
    const now = Date.now();
    if (now - painted > LB_PROGRESS_PAINT_MS) { painted = now; showLbLoad(got, total); }
  }
  return new Blob(chunks, { type });
}

async function playVideo(r, vid, note, list) {
  const ticket = ++lbTicket;          // `abortLbFetch` already bumped it; this is ours
  const mine = () => ticket === lbTicket;
  lbAbort = new AbortController();
  const signal = lbAbort.signal;
  const cell = () => $('rows').querySelector(`td[data-sz="${list[lbAt]}"]`);
  vid.onloadedmetadata = () => {
    r.w = vid.videoWidth || r.w;
    r.h = vid.videoHeight || r.h;
    paintMeta(r, list);
    const c = cell();
    if (c) c.innerHTML = sizeCell(r);
  };

  const direct = () => {
    hideLbLoad();   // the browser streams this one; its own controls show the buffering
    vid.onerror = () => {
      note.hidden = false;
      note.textContent = "This browser can't play this file. Download it and open it in a player.";
    };
    vid.src = r.url;
    vid.play().catch(() => {}); // autoplay refusals are fine — the controls are right there
  };

  const viaBlob = async (url) => {
    showLbLoad(0, 0);
    const res = await fetch(url, { credentials: 'omit', signal });
    if (!res.ok) return false;
    // `r.bytes` is only a stand-in for THIS file. When the url being fetched is not the one
    // the scan measured, the measurement describes a different file and would misreport.
    const blob = await readWithProgress(res, mine, url === r.url ? r.bytes : 0);
    if (!mine()) return true;   // someone moved on; the frame is not ours to touch
    // A leading fragment, not the file — see `FRAGMENT_MAX_BYTES` at the top of this file.
    if (blob.size <= FRAGMENT_MAX_BYTES) return false;
    hideLbLoad();
    releaseLbBlob();
    lbBlobUrl = URL.createObjectURL(blob);
    vid.onerror = direct; // a genuinely different decode problem, not this CDN's quirk
    vid.src = lbBlobUrl;
    vid.play().catch(() => {});
    return true;
  };

  // THE PAGE'S OWN STORE ANSWERED THIS ALREADY, AT SCAN TIME. `playUrl` is attached by
  // `scan.js` from X's Redux `video_info.variants` — the real mp4, looked up locally by the
  // same internal id the captured url carries. Tried FIRST because it costs nothing: no
  // network round trip, no token, and it does not depend on the `statusId` cross-reference
  // that the syndication path below needs and that misses on exactly the DASH fragments
  // this exists to rescue.
  try {
    if (r.playUrl && r.playUrl !== r.url && await viaBlob(r.playUrl)) return;
  } catch (_) { /* fall through to the endpoint that needs a round trip */ }
  if (!mine()) return;

  try {
    const synced = await resolveSyndicatedVideo(r, signal);
    if (synced && await viaBlob(synced)) return;
  } catch (_) { /* no statusId, the endpoint refused it, or no matching variant — fall through */ }
  if (!mine()) return;

  try {
    if (await viaBlob(r.url)) return;
  } catch (_) { /* a CORS refusal or a network error — the direct attempt is the only one left */ }
  if (!mine()) return;
  direct();
}

// Fetched here rather than in the worker: an extension page is not bound by CORS
// either, and keeping it local means the bytes never leave this window.
// Truncated on purpose — a 40MB CSV is a data file, not something you read.
async function loadText(r, el) {
  const url = r.url;
  try {
    const res = await fetch(url, { credentials: 'omit' });
    const buf = await res.arrayBuffer();
    const cut = buf.byteLength > MAX_TEXT;
    let s = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, MAX_TEXT));
    if (cut) s += `\n\n… truncated at ${bytes(MAX_TEXT)} of ${bytes(buf.byteLength)}. Download for the rest.`;
    if (all[lbList()[lbAt]]?.url === url) el.textContent = s || '(empty file)';
  } catch (_) {
    if (all[lbList()[lbAt]]?.url === url) {
      el.textContent = "Couldn't read this file. The server may require the page's own session.";
    }
  }
}

function paintMeta(r, list) {
  $('lbName').textContent = r.title || r.name;
  $('lbDim').textContent = [r.w && r.h ? `${r.w}×${r.h}` : '', r.bytes ? bytes(r.bytes) : '']
    .filter(Boolean).join('  ·  ') || '';
  $('lbPrev').style.visibility = list.length > 1 ? 'visible' : 'hidden';
  $('lbNext').style.visibility = list.length > 1 ? 'visible' : 'hidden';
}

function stepLightbox(d) {
  const list = lbList();
  if (!list.length) return;
  lbAt = (lbAt + d + list.length) % list.length;
  paintLightbox();
}

// Dropping the source matters more than hiding the frame: a hidden <video> keeps
// playing, and audio from an invisible element is the worst kind of bug.
function closeLightbox() {
  const vid = $('lbVid');
  // Before anything else: a 388MB fetch left running after the frame is gone is pure waste
  // of the person's bandwidth, and it would finish into an element nobody can see.
  abortLbFetch();
  hideLbLoad();
  vid.pause();
  vid.removeAttribute('src');
  releaseLbBlob();
  vid.load();
  // The PDF viewer keeps the document loaded — and holds the connection open —
  // for as long as the frame has a source, hidden or not.
  $('lbDoc').removeAttribute('src');
  $('lbText').textContent = '';
  $('lb').hidden = true;
  lbAt = -1;
}

$('lbX').addEventListener('click', closeLightbox);
$('lbPrev').addEventListener('click', () => stepLightbox(-1));
$('lbNext').addEventListener('click', () => stepLightbox(1));
$('lb').addEventListener('click', (e) => { if (e.target === $('lb')) closeLightbox(); });
$('lbGet').addEventListener('click', () => {
  const r = all[lbList()[lbAt]];
  if (r) chrome.runtime.sendMessage({ type: 'DOWNLOAD', items: [r] }).catch(() => {});
});
$('lbCopy').addEventListener('click', (e) => {
  const r = all[lbList()[lbAt]];
  if (!r) return;
  navigator.clipboard.writeText(r.url);
  e.currentTarget.textContent = 'Copied';
  setTimeout(() => (e.currentTarget.textContent = 'Copy URL'), COPIED_LABEL_MS);
});
addEventListener('keydown', (e) => {
  if ($('lb').hidden) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') stepLightbox(-1);
  else if (e.key === 'ArrowRight') stepLightbox(1);
});

// Attached once. Rebinding inside renderChips would stack a listener per render,
// because the button survives where the chips were replaced wholesale.
$('tags').addEventListener('click', () =>
  openMenu($('tags'), fmtOptions, fmtFilter || '', (v) => {
    fmtFilter = v || null;
    filesPage = 0;
    invalidate();
    // Picking a format also switches every row to it, so "give me the webp
    // versions" stays a single action.
    if (fmtFilter && fmtFilter !== 'hidden') {
      all.forEach((r) => {
        const x = (r.variants || []).find((y) => y.label.startsWith(fmtFilter));
        if (x) { r.url = x.url; r.name = fileName(x.url); r.bytes = 0; r.measured = false; }
      });
      invalidate();
    }
    renderChips();
    selectVisible();
    render();
  }));

// --- windowing ---------------------------------------------------------------
// Only the rows you can see exist in the DOM. Building all of them cost ~180ms
// at 800 assets — on every filter change, every sort, and every keystroke — and
// it also meant 800 thumbnails decoding and 800 HEAD requests for a table you
// had not scrolled yet. Two spacer rows hold the scrollbar at its true length,
// so the scroll position and the wheel still behave exactly as before.
const ROW_H = 64;      // pinned in CSS; see `tbody tr` there
const OVERSCAN = 8;    // rows kept beyond each edge, so a flick does not flash
let painted = -1;      // first row index currently in the DOM

function rowHtml({ r, i }) {
  const notFile = r.type === 'page';
  return `
    <tr class="${sel.has(i) ? 'sel' : ''}${notFile ? ' notfile' : ''}${broken.has(i) ? ' broken' : ''}" data-i="${i}">
      <td><input type="checkbox" data-c="${i}" ${sel.has(i) ? 'checked' : ''} ${notFile ? 'disabled' : ''} /></td>
      <td class="prev">${preview(r, i)}</td>
      <td class="ttl">
        <div class="nm" title="${esc(r.title)}">${esc(r.title) || '<span class="k">untitled</span>'}</div>
        <span class="fn" title="${esc(r.url)}">${esc(r.name)}${picker(r, i)}</span>
      </td>
      <td class="k">${esc(r.type)}${typeNote(r)}</td>
      <td class="k sz" data-sz="${i}">${sizeCell(r)}</td>
      <td class="act"><span class="ract">
        <button data-open="${i}" title="Open in a new tab">↗</button>
        <button data-copy="${i}" title="Copy URL">⧉</button>
        ${notFile ? '' : `<button data-get="${i}" title="Download this file">↓</button>`}
      </span></td>
    </tr>`;
}

function render() {
  const rows = view();
  $('empty').style.display = rows.length ? 'none' : 'block';
  painted = -1;                       // force a repaint even if the window is unchanged
  paintWindow();
  $('all').checked = rows.length > 0 && rows.every(({ i }) => sel.has(i));
  stat();
}

function paintWindow() {
  const shown = view();
  // Pages, same rule as the sheet: rendering only, never the export set — that stays
  // `view()` in full, per `selectVisible`'s own comment ("filtering IS the selection").
  // Scroll-virtualizing on top of a page rather than instead of one still matters at
  // the larger page sizes (500, All): a 900-row page is still 900 rows one scroll away.
  const pages = pageSize ? Math.max(1, Math.ceil(shown.length / pageSize)) : 1;
  if (filesPage >= pages) filesPage = pages - 1;
  const pageFrom = pageSize ? filesPage * pageSize : 0;
  const rows = pageSize ? shown.slice(pageFrom, pageFrom + pageSize) : shown;
  paintPager(FILES_PAGER_IDS, shown.length, pages, pageFrom, rows.length, filesPage, (p) => {
    filesPage = p;
    painted = -1;
    paintWindow();
    scrollFilesTop();
  });

  const wrap = $('wrap');
  const first = Math.max(0, Math.floor(wrap.scrollTop / ROW_H) - OVERSCAN);
  const fit = Math.ceil(wrap.clientHeight / ROW_H) + OVERSCAN * 2;
  const last = Math.min(rows.length, first + fit);
  if (first === painted && rowsEl.dataset.last === String(last)) return;
  painted = first;
  rowsEl.dataset.last = String(last);

  const slice = rows.slice(first, last);
  const before = first * ROW_H;
  const after = Math.max(0, (rows.length - last) * ROW_H);
  const pad = (h) => (h > 0 ? `<tr class="pad" style="height:${h}px"><td colspan="6"></td></tr>` : '');
  rowsEl.innerHTML = pad(before) + slice.map(rowHtml).join('') + pad(after);

  // Only what was actually painted gets measured, drawn, or fetched.
  measureRows(slice.map(({ i }) => i));
  armStills();
  for (const { r, i } of slice) {
    if (r.type !== 'audio') continue;
    const cv = rowsEl.querySelector(`tr[data-i="${i}"] [data-wave]`);
    if (cv) drawWave(cv, peaks.get(r.url) || null, playingIdx === i && deck ? deck.currentTime / (deck.duration || 1) : 0);
  }
}

// Repainting on the scroll event itself fires far more often than the screen
// updates, so the work is folded into the frame that will actually show it.
let scrollRaf = 0;
$('wrap').addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; paintWindow(); });
}, { passive: true });
addEventListener('resize', () => { painted = -1; paintWindow(); });

// Kept out of the click handler so the popover and any future caller share one
// path — the size, the preview and the broken flag all have to move together.
function applyVariant(n, url) {
  const r = all[n];
  const tr = $('rows').querySelector(`tr[data-i="${n}"]`);
  if (!tr) return;

  r.url = url;
  r.name = fileName(url);

  // A different variant is a different file, so everything measured about the
  // old one is now wrong. Showing 1.1 MB / 1620x841 next to the 810w version is
  // worse than showing nothing. Seed the width from the variant (the page
  // declared it), clear the rest, and measure again.
  const v = (r.variants || []).find((x) => x.url === url);
  r.bytes = 0;
  r.w = v?.width || 0;
  r.h = 0;
  r.measured = false;
  broken.delete(n); // the previous URL failing says nothing about this one

  tr.classList.remove('broken');
  tr.querySelector('td.prev').innerHTML = preview(r, n);
  const fn = tr.querySelector('.fn');
  if (fn) { fn.title = r.url; fn.innerHTML = esc(r.name) + picker(r, n); }
  const szCell = tr.querySelector('td[data-sz]');
  if (szCell) szCell.innerHTML = sizeCell(r);
  // No rebinding: the handlers live on the table body, so the replacement <img>
  // and the replacement .vpick are already covered.
  invalidate();         // name and bytes changed, so a search or sort sees a new row
  measureRows([n]);
}

// What the type cell knows beyond the type itself. "page" is the one that saves
// a download: the URL came from a player embed or an og:video tag and the server
// answers with HTML, so taking it would save the markup, not the film.
function typeNote(r) {
  const tags = r.tags || [];
  if (r.type === 'page') return '<span class="hid" title="The server returns HTML here, so there is no file to take.">not a file</span>';
  if (tags.includes('unconfirmed')) return '<span class="hid soft" title="The server did not say what this is. The type is the page\'s own claim.">unchecked</span>';
  if (tags.includes('hidden')) return '<span class="hid">hidden</span>';
  return '';
}

// Same asset in several formats or sizes is ONE row with a choice, not many rows.
function picker(r, i) {
  if (!r.variants || r.variants.length < 2) return '';
  const cur = r.variants.find((v) => v.url === r.url) || r.variants[0];
  return `<button class="vpick" data-f="${i}" aria-haspopup="listbox" aria-expanded="false"
    title="${r.variants.length} versions of this asset">${esc(cur.label || 'version')}</button>`;
}

// Two different facts, both called "size". Pixels answer "is this big enough to
// use"; bytes answer "what will this cost me". Show whichever we actually know
// and a dash where we don't — a guessed number here is worse than no number.
//
// Bytes come from Resource Timing, which reports 0 for cross-origin responses
// without Timing-Allow-Origin, so most third-party files legitimately have none.
function sizeCell(r) {
  const px = r.w && r.h ? `${r.w}&times;${r.h}` : r.w ? `${r.w}w` : '';
  const by = r.bytes ? bytes(r.bytes) : (r.bytes === 0 && r.measured ? '—' : '<span class="wait">·</span>');
  return `${by}${px ? `<span class="by">${px}</span>` : ''}`;
}

// Asks the worker for real Content-Length on whatever is on screen. Trackers are
// excluded on purpose — a HEAD to a beacon is the beacon firing, and measuring
// one would do the exact thing this tool sets aside.
async function measureRows(indices) {
  const rows = indices
    .map((i) => ({ r: all[i], i }))
    .filter(({ r }) => r && !r.measured && !isTracker(r) && /^https?:/.test(r.url));
  if (!rows.length) return;
  const urls = [...new Set(rows.map(({ r }) => r.url))];
  let sizes = {}, kinds = {};
  try { ({ sizes = {}, kinds = {} } = await chrome.runtime.sendMessage({ type: 'SIZES', urls })); }
  catch { return; }
  let touched = false, retyped = false;
  for (const { r, i } of rows) {
    r.measured = true;
    if (sizes[r.url]) r.bytes = sizes[r.url];
    // The same header that carries the size says what the thing IS. An extension
    // can lie — hotlink protection serves HTML from a .jpg URL — and this is the
    // only place that finds out before the user spends a download on it.
    if (kinds[r.url] === 'page' && r.type !== 'page') {
      r.type = 'page';
      sel.delete(i);
      retyped = true;
    }
    const cell = $('rows').querySelector(`td[data-sz="${i}"]`);
    if (cell) { cell.innerHTML = sizeCell(r); touched = true; }
  }
  if (retyped) { invalidate(); renderChips(); render(); return; }
  if (touched) stat();
}

// --- audio ------------------------------------------------------------------
// One <audio> for the whole table, so starting a track stops the last one. Peaks
// are decoded on first play and cached: decoding a list of tracks up front is the
// documented way to transfer 100MB and stall for 30 seconds, and there is no
// server here to pre-generate them.
const peaks = new Map();
let deck = null, playingIdx = -1, decodeChain = Promise.resolve(), actx = null;
const MAX_DECODE = 24 * 1024 * 1024; // past this the wait costs more than the picture

function drawWave(cv, data, progress) {
  const g = cv.getContext('2d');
  const { width: w, height: h } = cv;
  const mid = h / 2;
  g.clearRect(0, 0, w, h);

  // Before the peaks exist, a rail — not 50 tiny ticks pretending to be a
  // waveform. This tool never draws a shape it has not measured, and a row of
  // near-invisible dashes reads as a failure rather than as "not analysed yet".
  if (!data) {
    g.fillStyle = 'rgba(255,255,255,.16)';
    g.fillRect(0, mid - 2, w, 4);
    if (progress > 0) { g.fillStyle = '#ffb648'; g.fillRect(0, mid - 2, w * progress, 4); }
    return;
  }

  const bars = 44, gap = 3, bw = Math.max(2, w / bars - gap);
  for (let b = 0; b < bars; b++) {
    const amp = data[Math.floor((b / bars) * data.length)] || 0;
    const bh = Math.max(3, amp * (h - 4));
    g.fillStyle = (b / bars) < progress ? '#ffb648' : 'rgba(255,255,255,.34)';
    g.fillRect(b * (bw + gap), mid - bh / 2, bw, bh);
  }
}

function peaksFrom(buf, bars = 96) {
  const ch = buf.getChannelData(0);
  const step = Math.floor(ch.length / bars) || 1;
  const out = new Float32Array(bars);
  let max = 0;
  for (let i = 0; i < bars; i++) {
    let peak = 0;
    for (let j = 0; j < step; j += 16) { const v = Math.abs(ch[i * step + j] || 0); if (v > peak) peak = v; }
    out[i] = peak; if (peak > max) max = peak;
  }
  if (max > 0) for (let i = 0; i < bars; i++) out[i] /= max; // normalise, else quiet tracks look empty
  return out;
}

function decodePeaks(url, cv) {
  if (peaks.has(url)) return;
  peaks.set(url, null); // claim it, so a second play does not queue a second decode
  decodeChain = decodeChain.then(async () => {
    try {
      const head = await fetch(url, { method: 'HEAD', credentials: 'omit' }).catch(() => null);
      if (head && +head.headers.get('content-length') > MAX_DECODE) return;
      const buf = await (await fetch(url, { credentials: 'omit' })).arrayBuffer();
      actx = actx || new AudioContext();
      const audio = await actx.decodeAudioData(buf);
      peaks.set(url, peaksFrom(audio));
      if (cv.isConnected) drawWave(cv, peaks.get(url), 0);
    } catch (_) { /* cross-origin or unsupported codec — the flat bar stays */ }
  });
}

const mmss = (s) => (isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '–:––');

// One set of listeners on the table body, not six per row. At 800 rows the old
// per-row binding created roughly 4,400 listeners on every render, and it had to
// be redone after every filter change and every variant swap.
//
// The delegated handlers also survive re-rendering, which is what makes windowing
// possible at all: rows come and go as you scroll and never need binding.
const rowIndex = (e, sel) => {
  const hit = e.target.closest(sel);
  if (!hit) return null;
  const tr = hit.closest('tr[data-i]');
  return tr ? { n: Number(tr.dataset.i), tr, hit } : null;
};

rowsEl.addEventListener('change', (e) => {
  const h = rowIndex(e, 'input[data-c]');
  if (!h) return;
  h.hit.checked ? sel.add(h.n) : sel.delete(h.n);
  h.tr.classList.toggle('sel', h.hit.checked);
  stat();
});

rowsEl.addEventListener('click', (e) => {
  const h = rowIndex(e, '.vpick, [data-vid], [data-open], [data-copy], [data-get], [data-play], [data-wave], img[data-broken]');
  if (!h) return;
  const { n, hit } = h;
  const r = all[n];

  if (hit.matches('.vpick')) {
    return openMenu(hit, (r.variants || []).map((v) => ({
      value: v.url, label: v.label || 'version', hint: v.width ? `${v.width}px` : '',
    })), r.url, (url) => applyVariant(n, url));
  }
  if (hit.matches('[data-vid], img[data-broken]')) return openLightbox(n);
  if (hit.matches('[data-open]')) return window.open(r.url, '_blank', 'noreferrer');
  if (hit.matches('[data-copy]')) {
    navigator.clipboard.writeText(r.url);
    const was = hit.textContent;
    hit.textContent = '✓';
    setTimeout(() => (hit.textContent = was), COPIED_LABEL_MS);
    return;
  }
  // The whole row, not just its URL: the filename is built from the page it came
  // from and the title, and a stripped-down copy would name the file 'file.bin'.
  if (hit.matches('[data-get]')) return chrome.runtime.sendMessage({ type: 'DOWNLOAD', items: [r] }).catch(() => {});
  if (hit.matches('[data-play]')) return togglePlay(n, hit);
  // Scrub by clicking the wave — the reason to draw one at all.
  if (hit.matches('[data-wave]')) {
    if (playingIdx !== n || !deck || !deck.duration) return;
    const b = hit.getBoundingClientRect();
    deck.currentTime = ((e.clientX - b.left) / b.width) * deck.duration;
  }
});

// load and error do not bubble, but they do capture — so one listener at the
// container still reaches every thumbnail, including ones added later.
rowsEl.addEventListener('load', (e) => {
  const im = e.target;
  if (!im.matches?.('img[data-broken]') || !im.naturalWidth) return;
  const n = Number(im.dataset.broken);
  // The thumbnail already downloads the image, so its decoded size is free and
  // exact — better than anything the scan can infer for a file the page never
  // rendered itself.
  all[n].w = im.naturalWidth;
  all[n].h = im.naturalHeight;
  const cell = rowsEl.querySelector(`td[data-sz="${n}"]`);
  if (cell) cell.innerHTML = sizeCell(all[n]);
}, true);

// Posters arrive a screen ahead of the scroll and never all at once. One observer for
// the life of the window, re-armed after every paint — a per-render observer leaks one
// per keystroke on a table that rebuilds as you type.
// Built on first use, not at module load: paintWindow can run before this line does,
// and a `const` observer would be in its temporal dead zone when it did.
let stills = null;
function armStills() {
  if (!stills) {
    stills = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const im = e.target;
        stills.unobserve(im);
        im.src = im.dataset.src;
        im.removeAttribute('data-src');
      }
    }, { root: null, rootMargin: '600px 0px' });
  }
  rowsEl.querySelectorAll('img[data-still][data-src]').forEach((im) => stills.observe(im));
}

// A poster that will not load costs a picture, not the file. It must never mark the
// row broken the way a missing thumbnail does — the video behind it is still there.
rowsEl.addEventListener('error', (e) => {
  const im = e.target;
  if (im.matches?.('img[data-still]')) { im.closest('.vtile')?.classList.remove('shot'); im.remove(); }
}, true);

// A URL that will not render is not an asset you can take. Beacons, expired
// signed URLs and hotlink-protected files all land here. Say so and uncheck it,
// rather than showing a blank square that still exports.
rowsEl.addEventListener('error', (e) => {
  const im = e.target;
  if (!im.matches?.('img[data-broken]')) return;
  const n = Number(im.dataset.broken);
  const tr = im.closest('tr');
  broken.add(n);
  sel.delete(n);
  tr?.classList.remove('sel');
  tr?.classList.add('broken');
  const cb = tr?.querySelector('input[data-c]');
  if (cb) cb.checked = false;
  im.replaceWith(Object.assign(document.createElement('span'), {
    className: 'k dead', textContent: "won't load",
  }));
  stat();
}, true);

function togglePlay(n, btn) {
  const r = all[n];
  const cv = btn.closest('tr')?.querySelector('[data-wave]');
  const stop = () => { btn.textContent = '▶'; btn.classList.remove('playing'); };
  if (!deck) {
    deck = new Audio();
    deck.addEventListener('timeupdate', () => {
      const row = rowsEl.querySelector(`tr[data-i="${playingIdx}"]`);
      if (!row) return;
      const c = row.querySelector('[data-wave]'), t = row.querySelector('[data-time]');
      if (c) drawWave(c, peaks.get(all[playingIdx].url) || null, deck.currentTime / (deck.duration || 1));
      if (t) t.textContent = mmss(deck.duration - deck.currentTime);
    });
    deck.addEventListener('ended', () => rowsEl.querySelectorAll('.pbtn').forEach((b) => {
      b.textContent = '▶'; b.classList.remove('playing');
    }));
  }
  if (playingIdx === n && !deck.paused) { deck.pause(); stop(); return; }
  rowsEl.querySelectorAll('.pbtn').forEach((b) => { b.textContent = '▶'; b.classList.remove('playing'); });
  playingIdx = n;
  deck.src = r.url;
  deck.play().then(() => { btn.textContent = '❚❚'; btn.classList.add('playing'); }).catch(stop);
  if (cv) decodePeaks(r.url, cv);
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function preview(r, idx) {
  // data-broken carries the row index so the failure can deselect the row.
  // Hiding a broken thumbnail and leaving the row checked is the misleading
  // case: it looks like an asset, exports like an asset, and downloads nothing.
  if (r.type === 'image') return `<img loading="lazy" src="${esc(r.url)}" data-broken="${idx}" data-lb="${idx}" />`;
  if (r.type === 'page') return '<span class="k dead">web page</span>';
  if (r.type === 'video') {
    // With the page's own still behind it, the play mark becomes an affordance
    // instead of the whole cell. A thousand identical grey tiles told you nothing
    // about which video was which, which is the only question this column answers.
    // `data-broken` is deliberately absent: a poster that fails to load costs a
    // picture, not the file, and must never deselect a perfectly good video.
    // `data-src`, not `src`: a page of 200 videos would otherwise queue 200 poster
    // requests the moment the sheet paints, and `loading="lazy"` is a hint browsers
    // read generously. The observer below hydrates them a screen ahead of the
    // scroll, so what is fetched is what is about to be looked at.
    const still = r.poster
      ? `<img data-src="${esc(r.poster)}" data-still alt="" decoding="async" />`
      : '';
    return `<button class="vtile${still ? ' shot' : ''}" data-vid="${idx}"
      title="Play this video" aria-label="Play this video">${still}
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>
    </button>`;
  }
  // Documents get the same footprint as a thumbnail so the column stays even,
  // and carry their own extension — the one fact that says what will open it.
  if (showsAs(r) && r.type !== 'audio') {
    const ext = (r.name.match(/\.([a-z0-9]{2,5})$/i) || [undefined, r.type])[1];
    return `<button class="vtile doc" data-vid="${idx}" title="Preview this file" aria-label="Preview this file">
      <span>${esc(ext.slice(0, 4))}</span>
    </button>`;
  }
  if (r.type === 'audio') {
    return `<div class="pl">
      <button class="pbtn" data-play="${idx}" aria-label="Play">▶</button>
      <canvas class="wave" width="336" height="60" data-wave="${idx}"></canvas>
      <span class="ptime" data-time="${idx}">–:––</span>
    </div>`;
  }
  return `<span class="k">${esc(r.type)}</span>`;
}

// Filtering IS the selection. Narrowing to "webp" and then exporting all 21
// rows is the surprise this avoids: what you can see is what you get.
// Anything that will not load is left out however you filter, and so is anything
// that is not a file: a row that downloads a web page has no business being
// checked by default.
function selectVisible() {
  sel = new Set(view().map(({ i }) => i).filter((i) => !broken.has(i) && all[i].type !== 'page'));
}

function stat() {
  $('stat').textContent = `${view().length} shown · ${sel.size} selected · ${all.length} total`;
  $('dl').disabled = sel.size === 0;
  $('dl').textContent = `Download selected (${sel.size})`;
}

// --- interactions -----------------------------------------------------------
// Rebuilt once you stop typing, not once per key — see `SEARCH_DEBOUNCE_MS` at the top of this file.
let qTimer = 0;
$('q').addEventListener('input', () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { filesPage = 0; invalidate(); selectVisible(); render(); }, SEARCH_DEBOUNCE_MS);
});

$('all').addEventListener('change', () => {
  const rows = view();
  rows.forEach(({ i }) => ($('all').checked ? sel.add(i) : sel.delete(i)));
  render();
});

$('filesPprev').addEventListener('click', () => {
  if (filesPage <= 0) return;
  filesPage--; painted = -1; paintWindow(); scrollFilesTop();
});
$('filesPnext').addEventListener('click', () => {
  filesPage++; painted = -1; paintWindow(); scrollFilesTop();
});
$('filesPsize').addEventListener('click', () => openMenu($('filesPsize'), PAGE_SIZES,
  String(pageSize), (v) => {
    pageSize = +v || 0;
    sheetPage = 0;
    filesPage = 0;
    $('filesPsize').textContent = $('psize').textContent = PAGE_SIZES.find((o) => o.value === v).label;
    painted = -1;
    paintWindow();
    scrollFilesTop();
  }));

document.querySelectorAll('thead th[data-s]').forEach((th) =>
  th.addEventListener('click', () => {
    const k = th.dataset.s;
    sortDir = sortKey === k ? -sortDir : 1;
    sortKey = k;
    invalidate();
    document.querySelectorAll('thead th[data-s] span.ar').forEach((s) => s.remove());
    th.insertAdjacentHTML('beforeend', `<span class="ar">${sortDir > 0 ? '▲' : '▼'}</span>`);
    render();
  })
);

const chosen = () => [...sel].sort((a, b) => a - b).map((i) => all[i]);

// The four file-list exports, behind the one Export menu. Each does exactly what its own
// button did — same `chosen()` rows, same `fileMatrix`, same names. Only the way in changed.
exportMenu('exp', () => EXPORTS, (v) => {
  const list = chosen();
  if (v === 'csv') return save(toCSV(list), exportName('csv'), 'text/csv');
  if (v === 'json') return save(JSON.stringify(list.map(dashRow), null, 2), exportName('json'), 'application/json');
  if (v === 'xlsx') return paperSave('exp', 'workbook',
    () => Paper.xlsx({ ...fileMatrix(list), sheet: 'Files', empty: CELL_EMPTY }), exportName('xlsx'));
  if (v === 'pdf') return paperSave('exp', 'PDF',
    () => Paper.pdf({ ...fileMatrix(list), title: 'HoloScrape — files', subtitle: srcUrl || '' }),
    exportName('pdf'));
});
// NOT DASHED, and deliberately: this copies a list of URLs for pasting somewhere that will try to
// fetch them. A row with no URL should contribute nothing, not the line "-".
$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(chosen().map((r) => r.url).filter(Boolean).join('\n'));
  flash($('copy'), 'Copied URLs');
});
$('dl').addEventListener('click', async () => {
  const list = chosen();
  if (!confirm(`Download ${list.length} files?`)) return;
  $('dl').disabled = true;
  $('dl').textContent = 'Downloading…';
  const r = await chrome.runtime.sendMessage({ type: 'DOWNLOAD', items: list });
  if (r?.error) { stat(); return alert(r.error); }

  // A skipped row is a finding, not a footnote — retype it so the table shows
  // the same truth the next time, instead of offering the same dud again.
  const skipped = r.skipped || [];
  const pages = new Set(skipped.filter((s) => /web page/.test(s.reason)).map((s) => s.url));
  if (pages.size) {
    all.forEach((row, i) => { if (pages.has(row.url)) { row.type = 'page'; sel.delete(i); } });
    renderChips();
    render();
  } else {
    stat();
  }

  alert(skipped.length
    ? `Downloaded ${r.downloaded} of ${list.length}.\n\nSkipped ${skipped.length}:\n` +
      skipped.slice(0, 8).map((s) => `· ${s.name} — ${s.reason}`).join('\n') +
      (skipped.length > 8 ? `\n· and ${skipped.length - 8} more` : '')
    : `Downloaded ${r.downloaded} files.`);
});

// --- helpers ----------------------------------------------------------------
// --- an empty cell says so, in every export ---------------------------------------------
//
// THE FOURTH PLACE THIS HAD TO BE SAID, and that is the actual bug. Asked for twice, and each time it
// landed somewhere real that the user was not looking at:
//
//   1. `#sheetBody td:empty::before` in table.html   right for the screen, reaches no file
//   2. `CSV_EMPTY` in background.js `toCsv`          the CSV the SIDE PANEL asks for — and NOT the
//                                                    one this window's Export CSV writes, because
//                                                    that button has always built its own below
//   3. this window's sheet CSV                       its own writer, no dash
//   4. this window's sheet JSON                      raw values, no dash — the export in hand
//
// So the rule lives in one place now and every export boundary in this file goes through it. Its twin
// is `CSV_EMPTY` in background.js; a plain page script cannot import from the worker, so they are
// deliberate duplicates — the same arrangement HANDOVER records for the other shared rules. Edit both.
const CELL_EMPTY = '-';
// A ZERO IS A VALUE. So is a string of spaces INSIDE a value — trimming is not this function's job.
// Only nothing is nothing.
const orDash = (v) => {
  const s = v == null ? '' : String(v);
  return s.trim() ? v : CELL_EMPTY;
};
// A whole row, for the JSON exports. Keys are untouched: a missing NAME is not a missing VALUE.
const dashRow = (r) => {
  const out = {};
  for (const k of Object.keys(r || {})) out[k] = orDash(r[k]);
  return out;
};

// The ASSET view's own CSV — places five and six for this rule, and they were missed for the same
// reason as the first four: this button does not share a line of code with the sheet's Export CSV.
// A media row very often has no `title` and no `name`, so these are not rare blanks.
const FILE_COLS = ['title', 'type', 'name', 'url', 'formats', 'source', 'page'];
// ONE MATRIX, FOUR WRITERS. Excel and PDF arrived as places seven and eight for the empty-cell
// rule, and re-stating `orDash` in each of them is exactly how the first six drifted apart. So
// the asset view is flattened to plain strings ONCE, dashed here, and CSV, JSON, .xlsx and .pdf
// all read the same array — an export cannot now disagree with another export about a blank.
function fileMatrix(list) {
  return {
    columns: FILE_COLS,
    rows: list.map((r) => FILE_COLS.map((c) => String(orDash(
      c === 'formats' ? (r.variants || []).map((v) => v.label).join(' ') : r[c])))),
  };
}

function toCSV(list) {
  const { columns, rows } = fileMatrix(list);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  // The header is quoted, never dashed — a column with no name is not a value with no content.
  return [columns.join(','), ...rows.map((r) => r.map(q).join(','))].join('\n');
}

// CHARSET DECLARED ON EVERY EXPORT, not just the CSV — and what this does and does not fix.
//
// `new Blob([string])` always encodes UTF-8, so the BYTES were already right; this label is what
// tells anything reading the blob so, and `application/json` with no charset left that to the
// reader's default, which on a lot of software is still Latin-1.
//
// The prompt for this was an export of 120 Indonesian places arriving as `Thursday, 9.00 amâ5.30 pm`,
// `Kris Budiarto â`, `NÃRD` for `NØRD` — textbook UTF-8-read-as-Latin-1. That is NOT evidence the
// file was wrong: the same corruption happens anywhere between the file and the eye, and the copy
// examined had been through a paste. So this is hardening, not a diagnosis. If mojibake survives IN
// THE FILE ITSELF, the fix is a BOM as the sheet CSV uses — deliberately not done for JSON, where a
// BOM makes strict parsers reject the document.
// EVERY EXPORT GETS ITS OWN NAME, because Chrome's answer to a name it has already used is
// `holoscrape (1).json`, `holoscrape (2).json` — the counter says nothing about which scan a
// file came from, and two exports of DIFFERENT results off the same page were indistinguishable
// once they landed in Downloads. Shape: holoscrape-<domain>-<first path segment>-<stamp>.
//
// THE TIME IS `_22-44-10`, NOT `:22:44:10`, AND THAT IS NOT A STYLE CHOICE. A colon is illegal
// in a filename on Windows and is the legacy path separator on macOS, where Finder renders it
// as `/`. Chrome sanitises a download name it cannot use rather than refusing it, so asking for
// colons does not produce colons — it produces whatever the sanitiser picked, silently and
// differently per platform. Underscore between date and time, hyphens within both, is the
// nearest shape that survives intact everywhere.
const stampNow = () => {
  const d = new Date();                    // local time: "when I exported it" is a local fact
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`
    + `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};
function exportName(ext, label) {
  const parts = ['holoscrape'];
  try {
    const u = new URL(srcUrl);
    // x.com -> x_com. Every separator a hostname can carry becomes `_` so the hyphens in the
    // finished name only ever separate the FIELDS, never appear inside one.
    parts.push(u.hostname.replace(/^www\./, '').replace(/[^\w]+/g, '_'));
    // The first path segment only: /home -> home. A deep path would push the stamp off the end
    // of a Downloads row, and the segment that identifies the view is always the first one.
    const seg = u.pathname.split('/').filter(Boolean)[0];
    if (seg) parts.push(decodeURIComponent(seg).replace(/[^\w\d-]+/g, '_').slice(0, NAME_PART_MAX_CHARS));
  } catch (_) { /* no url, or not a parseable one — domain and path are simply left out */ }
  if (label) parts.push(label);
  parts.push(stampNow());
  return `${parts.join('-')}.${ext}`;
}

function save(text, name, mime) {
  const type = /charset=/i.test(mime) ? mime : `${mime};charset=utf-8`;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_URL_MS);
}

// The same download, for the two exports that are already bytes. `save` exists to put a
// charset on a string; an .xlsx is a zip and a .pdf is binary, and appending
// `;charset=utf-8` to either would be a label that is simply untrue.
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_URL_MS);
}

// Excel and PDF are the only exports that can take a visible moment — a hundred rows is
// instant, several thousand is not, and both are async because the compressor is. So the
// button says it is working, refuses a second click while it is (two clicks used to mean two
// downloads of the same file), and reports a failure instead of doing nothing at all.
//
// `note` is how paper.js says something happened that the file cannot show: today that is a
// PDF whose core font had no glyph for some of the text. It is an alert rather than a flash
// because "some of your data became ?" is not a thing to notice out of the corner of an eye.
async function paperSave(btn, kind, make, name) {
  const el = $(btn);
  if (!el || el.disabled) return;
  if (!globalThis.Paper) return alert(`The ${kind} writer did not load. Reload this window.`);
  const was = el.textContent;
  el.disabled = true;
  el.textContent = '…';
  try {
    const { blob, note } = await make();
    saveBlob(blob, name);
    if (note) alert(note);
  } catch (e) {
    alert(`Could not build the ${kind}: ${e?.message || e}`);
  } finally {
    el.disabled = false;
    el.textContent = was;
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function flash(btn, txt) {
  const o = btn.textContent;
  btn.textContent = txt;
  setTimeout(() => (btn.textContent = o), FLASH_MS);
}

// --- sheets ------------------------------------------------------------------
// The lists the page was already showing you. One tab each, and the actions that
// belong to a table live beside the table rather than back in the side panel.
//
// Two column operations. Renaming, because DOM-path column keys are unreadable
// and only the person looking at the values knows what they are. And hiding,
// which is reversible from one control in the bar. There is no Delete: deleting
// a column is hiding it with the way back removed, so it is a worse version of
// something already here, and every extra control on this screen has to justify
// itself twice over.
let sheets = [];        // [{rows, cols, label, selector}]
let srcUrl = '';        // the page these tables came from, for Load more rows
let sheetAt = -1;       // -1 = the Files view
const sheetState = [];  // per table: { hidden:Set, names:Map, noImages:bool }
let sheetQuery = '';    // the row filter, shared by every table tab
let sheetPage = 0;      // which page of the filtered set is on screen
let filesPage = 0;      // same idea, for the Files view — see paintWindow()
let pageSize = PAGE_SIZE_DEFAULT;      // shared by both views; 0 means all of it
// BOTH BUTTONS READ THEIR LABEL OFF `pageSize`, rather than carrying one in the markup.
// They each shipped a hardcoded number and only ever got rewritten when someone PICKED a size,
// so when the shared default moved to 50 the Files button was updated and the sheet's was not —
// it went on saying "Show 200" over pages of 50 for as long as nobody touched it. A control
// that misreports the setting it owns is worse than no control: every page count read off it
// was wrong, and the setting itself was right the whole time.
const paintSizeLabels = () => {
  const label = (PAGE_SIZES.find((o) => +o.value === pageSize) || {}).label || String(pageSize);
  for (const id of ['psize', 'filesPsize']) { const b = $(id); if (b) b.textContent = label; }
};
const PAGE_SIZES = [
  { value: '50', label: '50' },
  { value: '100', label: '100' },
  { value: '200', label: '200' },
  { value: '500', label: '500' },
  { value: '0', label: 'All' },
];

// Shopify's markup gives one Allbirds collection 181 distinct column paths. A
// table that wide is a wall, not data — and most of those columns are filled on a
// row or two. So sparse columns start hidden, once, and the "n hidden — show"
// control in the bar reveals every one of them. Nothing is discarded; the default
// view is just the part that has values in it.
const SPARSE = 0.2; // filled on fewer than a fifth of rows
function stateFor(n) {
  if (sheetState[n]) return sheetState[n];
  const st = { hidden: new Set(), names: new Map() };
  const s = sheets[n];
  if (s) {
    // A NAMED COLUMN IS NEVER HIDDEN FOR BEING SPARSE. This rule exists for the 181
    // DOM-path columns Shopify's markup produces, and those are unnamed by definition — the
    // engine only names a column when it can tell what the column IS. Applied to named ones
    // it hides the answer: open 5 records of 105 and "Full address", "Latitude" and
    // "Longitude" are filled on 4.8% of rows, so the very columns just fetched are the first
    // things swept out of sight.
    const prunable = (c) => !c.name && c.filled < s.rows.length * SPARSE;
    const dense = s.cols.filter((c) => c.name || c.filled >= s.rows.length * SPARSE);
    // Only prune when it leaves a table worth reading; a list where every column
    // is patchy keeps all of them rather than showing nothing.
    if (dense.length >= 2) for (const c of s.cols) if (prunable(c)) st.hidden.add(c.key);
    // A caption column is the same word on every row — "Website", "Book online",
    // "Directions" — and the engine has already spent it naming the column beside it.
    // Left in, it is one more column of nothing to scroll past. Hidden HERE rather than
    // filtered in visibleCols, so every existing control still applies to it: un-hide
    // brings it back, "show all columns" brings it back, and there is no second kind of
    // hidden for the next reader to discover.
    for (const c of s.cols) if (c.label) st.hidden.add(c.key);
  }
  sheetState[n] = st;
  return st;
}
const colName = (n, key) => {
  const st = stateFor(n);
  if (st.names.has(key)) return st.names.get(key);
  const col = sheets[n]?.cols.find((c) => c.key === key);
  // The engine names a column when it can tell what the column IS — from a caption that
  // repeats on every row, or from the shape of its own values. That beats anything
  // derivable here, because a DOM path on a site with hashed class names says nothing:
  // Maps' rail gave `link 1`, `link 2`, `link 3` for place, website and booking.
  // A name the user typed still wins over both.
  if (col?.name) return col.name;
  // A `@`-PREFIXED KEY IS ALREADY A NAME, and it must never fall through to `Text N`.
  //
  // `@Email`, `@Phone`, `@Latitude` are what a RECORD READER produced: they were read by asking
  // for a named thing, not by walking markup, so the `@` is a marker and the rest is the header.
  // `nameCols` strips it — but only for tables that go through `nameCols`. A table whose record
  // columns were merged in by the worker never does, so a real export shipped the email address
  // under `Text 48`, the phone under `Text 45` and the coordinates under `Text 43`/`Text 44` —
  // twenty-three columns of record data wearing DOM-path numbering.
  //
  // Fixed HERE, at the render layer, because that also repairs every table already in storage:
  // the label is computed on the way out rather than baked in at scan time.
  if (/^@/.test(key)) return key.slice(1).replace(/ (src|srcset|href)$/, '');
  // NUMBERED, AND CAPITALISED LIKE EVERY OTHER HEADER. Once build hashes stop being used as
  // names (see `labelKey`) several columns fall back to the same word, and three headers all
  // reading "text" is the same failure as three reading `lI9IFe` — nothing distinguishes them
  // and the column menu offers the user three identical choices. Numbered by position in the
  // table, so a header stays put across renders, and left unnumbered when it is the only one.
  const base = labelKey(key, col?.kind);
  const same = (sheets[n]?.cols || []).filter((c) =>
    !c.name && !st.names.has(c.key) && labelKey(c.key, c.kind) === base);
  const cap = base.charAt(0).toUpperCase() + base.slice(1);
  if (same.length <= 1) return cap;
  const i = same.findIndex((c) => c.key === key);
  return i < 0 ? cap : `${cap} ${i + 1}`;
};

// A DOM path makes a terrible column header. The last segment plus what kind of
// value it holds is what a person can actually act on.
function labelKey(key, kind) {
  const suffix = / (href|src|srcset|data-[a-z-]+)( \d+)?$/.exec(key);
  const dupe = / (\d+)$/.exec(key);
  const seg = key.replace(/ (href|src|srcset|data-[a-z-]+)( \d+)?$/, '').split('/').pop() || '';
  // A class name is something the site's author chose and usually means something
  // — "price", "title", "authors". A bare tag name is not a name: "a" and "span"
  // tell a reader nothing, so fall back to what the value IS instead.
  //
  // AND A BUILD HASH IS NOT A NAME EITHER. This is what "too many unnamed columns" looked
  // like: headers reading `lI9IFe`, `qty3Ue`, `bfdHYd`, `xxVWCe`, `THOPZb` — Google's
  // per-build class names, printed as though they described something. They are worse than
  // `text 3`, because they look like they mean something and they cannot even be relied on
  // to be the same tomorrow.
  //
  // A written word is all lower case, has a vowel in it, and has no digits doing the work.
  // `price`, `product-title`, `authors` pass; every hash above fails on case or on vowels.
  // Layout words are rejected too — a column headed "wrapper" is a name in form only.
  const HASHY = (s) => !/^[a-z][a-z-]{2,}$/.test(s) || !/[aeiou]/.test(s);
  const PLUMBING = /^(wrapper|container|inner|outer|content|holder|item|box|cell|row|col|flex|grid|left|right|top|bottom|main|body|text|list|block|group|section|el|ele|node)$/;
  const raw = (seg.match(/\.([a-zA-Z][\w-]{2,})/) || [])[1];
  const cls = raw && !HASHY(raw) && !PLUMBING.test(raw) ? raw : undefined;
  const byKind = { asset: 'image', link: 'link' }[kind] || 'text';
  const base = suffix ? ({ href: 'link', src: 'image', srcset: 'image' }[suffix[1]] || 'image')
    : (cls || byKind);
  return dupe && !suffix ? `${base} ${dupe[1]}` : base;
}

function paintTabs() {
  const nav = $('vtabs');
  // One tab is not a choice. Show the strip only when the page gave us more than
  // one thing to look at.
  if (!sheets.length) { nav.hidden = true; return; }
  nav.hidden = false;
  const tabs = [{ label: 'Files', n: all.length }]
    .concat(sheets.map((s, i) => ({ label: s.label || `Table ${i + 1}`, n: s.rows.length })));
  nav.innerHTML = tabs.map((t, i) =>
    `<button class="vtab${(i - 1) === sheetAt ? ' on' : ''}" data-v="${i - 1}">`
    + `${esc(t.label)} <i>${t.n}</i></button>`).join('');
  nav.querySelectorAll('.vtab').forEach((b) =>
    b.addEventListener('click', () => goView(+b.dataset.v)));
}

function goView(n) {
  sheetPage = 0;
  sheetAt = n;
  const onSheet = n >= 0;
  // The Files toolbar filters files. It has nothing to say about a table, so it
  // leaves rather than sitting there inert.
  $('sheet').hidden = !onSheet;
  $('wrap').hidden = onSheet;
  document.querySelector('.toolbar').hidden = onSheet;
  $('band').hidden = onSheet;
  $('chips').hidden = onSheet;
  $('dl').hidden = onSheet;
  // "0 shown · 0 selected · 13 total" counts files. On a table tab it describes
  // something that is not on screen.
  $('stat').hidden = onSheet;
  // #filesPager is a sibling of #wrap, not a descendant — see the note in table.html
  // — so it does not inherit #wrap's hidden state and has to be told directly.
  $('filesPager').hidden = onSheet;
  paintTabs();
  if (onSheet) paintSheet();
  // The shared page size, or the filter, may have changed while this view was away —
  // e.g. "Show 50" clicked from the sheet's own pager. Repaint rather than trust
  // whatever was on screen the last time Files was visible.
  else { painted = -1; paintWindow(); }
}

function visibleCols(n) {
  const st = stateFor(n);
  return sheets[n].cols.filter((c) =>
    !st.hidden.has(c.key) && !(st.noImages && c.kind === 'asset'));
}

// Which rows are on screen. A filter that only dimmed rows would still export them,
// and the count in the bar would still claim the full table — so the filter decides
// what the table IS, and CSV, JSON and the image download all follow it.
//
// Carries the row's ORIGINAL index, because an edit has to be written back to the row
// it came from and the filtered position is not that.
function shownRows(n) {
  const s = sheets[n];
  const q = sheetQuery.trim().toLowerCase();
  const out = [];
  const cols = visibleCols(n);
  s.rows.forEach((r, i) => {
    if (!q) { out.push({ r, i }); return; }
    for (const c of cols) {
      const v = r[c.key];
      if (v && String(v).toLowerCase().includes(q)) { out.push({ r, i }); return; }
    }
  });
  return out;
}

// Two columns both reading "text" is no better than two reading "/div/span".
// Names that collide get numbered in the order they appear.
function headerNames(n, cols) {
  const seen = new Map();
  const total = new Map();
  for (const c of cols) {
    const nm = colName(n, c.key);
    total.set(nm, (total.get(nm) || 0) + 1);
  }
  return cols.map((c) => {
    const nm = colName(n, c.key);
    if (total.get(nm) === 1) return nm;
    const k = (seen.get(nm) || 0) + 1;
    seen.set(nm, k);
    return `${nm} ${k}`;
  });
}

function paintSheet() {
  const n = sheetAt;
  const s = sheets[n];
  if (!s) return;
  const st = stateFor(n);
  const cols = visibleCols(n);
  const names = headerNames(n, cols);

  const shown = shownRows(n);
  $('ssum').innerHTML = (shown.length === s.rows.length
    ? `<b>${s.rows.length}</b> rows`
    : `<b>${shown.length}</b> of ${s.rows.length} rows`)
    + ` · <b>${cols.length}</b> columns`
    + (s.label ? ` · ${esc(s.label)}` : '');

  const hid = st.hidden.size;
  $('shid').hidden = !hid;
  $('shid').textContent = `${hid} hidden — show`;

  // Only offered when the table actually holds images, and it reads the RAW column list
  // rather than the visible one — hidden by its own switch, it must still be there to
  // switch back on. Its twin, the images download, is now an entry in the Export menu and
  // decides the same thing for itself at the moment the menu is built (`sheetImages`).
  $('sInc').hidden = !s.cols.some((c) => c.kind === 'asset');
  $('sInc').setAttribute('aria-pressed', String(!st.noImages));

  $('sheetHead').innerHTML = '<tr><th class="rn"></th>' + cols.map((c, ci) =>
    // THE TOOLTIP SAYS WHAT THE COLUMN HOLDS, not where it was scraped from. Hovering `Category`
    // showed `/div/div/div/a/span/span` — the DOM path the engine keys the column by, which is an
    // implementation detail with no meaning to anybody reading a table of businesses, and it
    // contradicted the header it was attached to. It only ever helped when the header itself was
    // a `Text N`, and it stops being needed the moment the column has a real name.
    `<th data-k="${esc(c.key)}" title="${esc(c.name ? `${c.name} — ${c.filled} of ${s.rows.length} rows` : c.key)}">${esc(names[ci])}`
    + (c.filled < s.rows.length ? `<span class="kind">${c.filled}/${s.rows.length}</span>` : '')
    + '</th>').join('') + '</tr>';

  $('sheetHead').querySelectorAll('th[data-k]').forEach((th) =>
    th.addEventListener('click', () => colMenu(th, th.dataset.k)));

  // Pagination is a rendering concern only: exports and the image download take the
  // whole filtered set, because "export" meaning "export this page" would be a trap.
  const pages = pageSize ? Math.max(1, Math.ceil(shown.length / pageSize)) : 1;
  if (sheetPage >= pages) sheetPage = pages - 1;
  const from = pageSize ? sheetPage * pageSize : 0;
  const page = pageSize ? shown.slice(from, from + pageSize) : shown;
  paintPager(SHEET_PAGER_IDS, shown.length, pages, from, page.length, sheetPage,
    (p) => { sheetPage = p; paintSheet(); scrollSheetTop(); });

  // Text is editable in place; images and links are not. An image cell is a picture
  // of a URL and a link cell is a destination — typing into either would produce a
  // row that no longer points at anything, which is worse than not being editable.
  // Correcting a mis-split title or a stray currency symbol is the actual need.
  $('sheetBody').innerHTML = page.map(({ r, i }) =>
    `<tr data-i="${i}"><td class="rn">${i + 1}</td>` + cols.map((c) => {
      // TRIMMED TO NOTHING SO THE SCREEN AGREES WITH THE FILE. `orDash` treats a whitespace-only
      // value as empty, but `td:empty` does not match a cell holding a space — so such a cell read
      // blank on screen and `-` in the export. Rendering it as genuinely empty puts the CSS
      // placeholder back in charge and the two agree again. Nothing is lost: a value that is only
      // whitespace is what every export boundary here already calls nothing.
      const v = String(r[c.key] ?? '').trim() ? r[c.key] : '';
      // An empty picture cell still holds a picture's WORTH OF SPACE. Without this the row
      // height follows whether that one cell has an image in it, so a list where most rows
      // have one and a few do not comes out visibly ragged — which is worse to look at than
      // the uniform-but-badly-aligned rows this replaced. The well is drawn faintly rather
      // than left blank because "this row has no picture" is worth seeing.
      if (c.kind === 'asset') {
        return v ? `<td><img src="${esc(v)}" alt="" loading="lazy" /></td>`
          : '<td><span class="noimg" aria-hidden="true"></span></td>';
      }
      if (c.kind === 'link') {
        return v ? `<td><a href="${esc(v)}" target="_blank" rel="noreferrer">${esc(v.replace(/^https?:\/\//, ''))}</a></td>` : '<td class="mt"></td>';
      }
      // MARKED EMPTY IN THE MARKUP, rather than left for `td:empty` to notice.
      //
      // These cells are `contenteditable`, and an empty contenteditable does not stay empty in
      // Chrome — it acquires a `<br>` — so `td:empty` stops matching and the placeholder silently
      // never renders. Reported repeatedly as "still no dash on the empty ones", and the CSS was
      // right the whole time; it was the selector that could not see them.
      //
      // A class instead of text, so nothing changes for copy, edit or export: the cell is still
      // genuinely empty as far as the DOM value is concerned, and the dash is drawn by CSS.
      const cls = [v && /^[\d.,$€£%\s+-]+$/.test(v) ? 'num' : '', edited(n, i, c.key) ? 'edited' : '',
        v ? '' : 'mt'].filter(Boolean).join(' ');
      return `<td class="${cls}" data-k="${esc(c.key)}" title="${esc(v)}"`
        + ` contenteditable="plaintext-only" spellcheck="false">${esc(v)}</td>`;
    }).join('') + '</tr>').join('');
}

// Row numbers stay the row's own, so page 2 starts at 201 rather than at 1 — the
// number identifies the row, it is not a count of what is visible.
//
// Shared by the sheet's pager AND the Files view's — same rule ("show 50 at a
// time"), same look, different element ids and a different notion of "go to page
// N", passed in rather than hardcoded so this one function drives both.
function paintPager(ids, total, pages, from, len, current, onGo) {
  const bar = $(ids.bar);
  bar.hidden = total <= PAGE_SIZE_DEFAULT && pageSize >= PAGE_SIZE_DEFAULT;
  if (bar.hidden) return;

  $(ids.prange).textContent = len
    ? `${from + 1}–${from + len} of ${total}`
    : `no rows of ${total}`;
  $(ids.pprev).disabled = current <= 0;
  $(ids.pnext).disabled = current >= pages - 1;

  // Every page number while there are few, first/current/last once there are many —
  // twenty numbered buttons is not navigation.
  // THE CONDENSED FORM STARTS AT SIX, NOT TEN. This used to run the full list up to nine
  // pages, and nine buttons plus Prev, Next, "Show" and the size button overflow the
  // results window at its ordinary width — reported live at eight pages, where the strip
  // already filled the bar edge to edge. Past the threshold the count is FIXED, never
  // proportional: at most five numbers (first, current-1, current, current+1, last) and
  // two gaps, so 15 pages and 3,000 pages draw the identical eight slots.
  const nums = [];
  if (pages <= 5) {
    for (let i = 0; i < pages; i++) nums.push(i);
  } else {
    const near = [0, current - 1, current, current + 1, pages - 1]
      .filter((i) => i >= 0 && i < pages);
    for (const i of [...new Set(near)].sort((a, b) => a - b)) nums.push(i);
  }
  let last = -1;
  $(ids.pnums).innerHTML = nums.map((i) => {
    // aria-hidden: the gap is a visual shorthand for the buttons that are not drawn, and
    // a screen reader announcing "ellipsis" between page numbers adds nothing to navigate by.
    const gap = i - last > 1 ? '<span class="pgap" aria-hidden="true">…</span>' : '';
    last = i;
    return `${gap}<button data-p="${i}"${i === current ? ' class="on"' : ''}>${i + 1}</button>`;
  }).join('');
  $(ids.pnums).querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => onGo(+b.dataset.p)));
}

const SHEET_PAGER_IDS = { bar: 'pager', prange: 'prange', pprev: 'pprev', pnext: 'pnext', pnums: 'pnums' };
const FILES_PAGER_IDS = { bar: 'filesPager', prange: 'filesPrange', pprev: 'filesPprev', pnext: 'filesPnext', pnums: 'filesPnums' };

const scrollSheetTop = () => { const w = $('sheetWrap'); if (w) w.scrollTop = 0; };
const scrollFilesTop = () => { const w = $('wrap'); if (w) w.scrollTop = 0; };

// --- editing ----------------------------------------------------------------
// Edits live on the row objects and are written to storage, so CSV, JSON and the
// window's own reload all see them. They do NOT survive the rows being replaced by a
// fresh read — "Load more rows" and a second scan bring new row objects, and silently
// re-applying old text to whatever now sits at that index would be worse than losing
// it. The marks in the margin are there so it is obvious which cells you touched.
const editKey = (n, i, k) => `${n}\u0000${i}\u0000${k}`;
const edits = new Set();
const edited = (n, i, k) => edits.has(editKey(n, i, k));

let saveTimer = null;
function persistEdits() {
  clearTimeout(saveTimer);
  // Coalesced — see `SAVE_DEBOUNCE_MS` at the top of this file.
  saveTimer = setTimeout(async () => {
    try {
      const key = TABLE_KEY_PREFIX + id;
      const cur = (await chrome.storage.local.get(key))[key];
      if (!cur) return;
      await chrome.storage.local.set({ [key]: { ...cur, tables: sheets } });
    } catch (_) { /* a full quota is not worth interrupting an edit for */ }
  }, SAVE_DEBOUNCE_MS);
}

function wireEditing() {
  const body = $('sheetBody');

  body.addEventListener('focusin', (e) => {
    const td = e.target.closest('td[contenteditable]');
    if (td) td.dataset.was = td.textContent;
  });

  body.addEventListener('focusout', (e) => {
    const td = e.target.closest('td[contenteditable]');
    if (!td) return;
    const tr = td.closest('tr');
    const i = +tr.dataset.i;
    const k = td.dataset.k;
    const next = td.textContent.replace(/\s+/g, ' ').trim();
    if (next === (td.dataset.was || '').replace(/\s+/g, ' ').trim()) return;
    sheets[sheetAt].rows[i][k] = next;
    edits.add(editKey(sheetAt, i, k));
    td.classList.add('edited');
    td.title = next;
    persistEdits();
  });

  body.addEventListener('keydown', (e) => {
    const td = e.target.closest('td[contenteditable]');
    if (!td) return;
    // Enter commits rather than inserting a line break — this is a cell, not a note.
    if (e.key === 'Enter') { e.preventDefault(); td.blur(); }
    // Escape puts back what was there, which is the only way to undo a mistyped cell.
    if (e.key === 'Escape') { e.preventDefault(); td.textContent = td.dataset.was || ''; td.blur(); }
  });
}

// --- column manager overlay --------------------------------------------------
// One screen for both column operations instead of one at a time through the
// per-header menu below: every column's name, a value pulled from whichever row
// actually has one, and the checkbox that shows or hides it in the sheet — plus
// one control that flips every checkbox together. Reads and writes the SAME
// `st.hidden` / `st.names` that `colMenu` does, so a rename or a hide made here
// and one made through a column header are the same edit, not two.
//
// The sample is not row zero's value: a column filled on 40 of 60 rows would
// show blank for a field that plainly has data, which reads as "this column is
// empty" right next to the checkbox that decides whether to keep it. Walking the
// rows for the first non-empty cell is what a person would do by eye.
function colSample(n, key) {
  const s = sheets[n];
  if (!s) return '';
  for (const r of s.rows) {
    const v = r[key];
    const t = v == null ? '' : String(v).trim();
    if (t) return t;
  }
  return '';
}

function paintColsOverlay() {
  const n = sheetAt;
  const s = sheets[n];
  const list = $('colsList');
  if (!s) { list.innerHTML = ''; $('colsAll').checked = false; return; }
  const st = stateFor(n);
  const cols = s.cols;
  // Asset columns can be excluded two ways: one at a time here, or all at once by
  // "Include images" (`st.noImages`) on the sheet toolbar — see `visibleCols`. This
  // overlay used to only look at `st.hidden`, so an asset column still showed
  // checked here while "Include images" was off and the sheet had already dropped
  // it: checked-but-actually-hidden, and ticking it did nothing because `noImages`
  // overrides `hidden` regardless. Reflecting the SAME rule `visibleCols` uses, and
  // disabling the row rather than leaving a dead click, keeps the two controls honest
  // with each other.
  const suppressed = (c) => st.noImages && c.kind === 'asset';
  list.innerHTML = cols.map((c) => {
    const off = suppressed(c);
    const on = !off && !st.hidden.has(c.key);
    const sample = colSample(n, c.key);
    return `<div class="cols-row${off ? ' suppressed' : ''}" data-k="${esc(c.key)}"`
      + (off ? ` title="Hidden by “Include images” being off, not by this list — `
        + `turn that back on to control it here"` : '') + '>'
      + `<input type="checkbox" class="colsOn"${on ? ' checked' : ''}${off ? ' disabled' : ''} aria-label="Include column" />`
      + `<input type="text" class="colsName" value="${esc(colName(n, c.key))}" spellcheck="false"${off ? ' disabled' : ''} aria-label="Column name" />`
      + (off ? '<span class="cv cols-none">hidden by “Include images”</span>'
             : `<span class="cv" title="${esc(sample)}">${sample ? esc(sample) : '<span class="cols-none">no values</span>'}</span>`)
      + '</div>';
  }).join('') || '<div class="cols-empty">No columns.</div>';

  $('colsAll').checked = cols.length > 0 && cols.every((c) => suppressed(c) || !st.hidden.has(c.key));
}

function openColsOverlay() {
  if (sheetAt < 0 || !sheets[sheetAt]) return;
  paintColsOverlay();
  $('colsLb').hidden = false;
}

// Applied live as each box is ticked or each name is typed, so closing the
// overlay has nothing left to commit — this only repaints the sheet behind it,
// the same as every other column edit already does.
function closeColsOverlay() {
  $('colsLb').hidden = true;
  paintSheet();
}

function initColsOverlay() {
  $('sCols').addEventListener('click', openColsOverlay);
  $('colsX').addEventListener('click', closeColsOverlay);
  $('colsLb').addEventListener('click', (e) => { if (e.target === $('colsLb')) closeColsOverlay(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('colsLb').hidden) closeColsOverlay();
  });

  // Include-all / exclude-all in one control, same pattern as the Files table's
  // own `#all` checkbox: checked means every column is currently shown, and
  // toggling it either clears `hidden` entirely or fills it with every key.
  $('colsAll').addEventListener('change', () => {
    const n = sheetAt;
    const s = sheets[n];
    if (!s) return;
    const st = stateFor(n);
    if ($('colsAll').checked) st.hidden.clear();
    else for (const c of s.cols) st.hidden.add(c.key);
    paintColsOverlay();
  });

  $('colsList').addEventListener('change', (e) => {
    if (!e.target.classList.contains('colsOn')) return;
    const row = e.target.closest('.cols-row');
    const n = sheetAt;
    const st = stateFor(n);
    const key = row.dataset.k;
    if (e.target.checked) st.hidden.delete(key); else st.hidden.add(key);
    $('colsAll').checked = sheets[n].cols.every((c) => !st.hidden.has(c.key));
  });

  // Committed on blur or Enter, same as a sheet cell: a half-typed name is not
  // applied mid-keystroke, and Escape is not special-cased here because leaving
  // the field with the old text still in it (nothing typed over it) is already
  // a no-op — there is nothing to revert.
  $('colsList').addEventListener('focusout', (e) => {
    if (!e.target.classList.contains('colsName')) return;
    const row = e.target.closest('.cols-row');
    const n = sheetAt;
    const st = stateFor(n);
    const key = row.dataset.k;
    const t = e.target.value.trim();
    if (t) st.names.set(key, t); else st.names.delete(key);
    e.target.value = colName(n, key);
  });
  $('colsList').addEventListener('keydown', (e) => {
    if (e.target.classList.contains('colsName') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });
}

function colMenu(th, key) {
  const n = sheetAt;
  openMenu(th, [
    { value: 'rename', label: 'Rename column', hint: colName(n, key) },
    { value: 'hide', label: 'Hide column' },
  ], null, (v) => {
    const st = stateFor(n);
    if (v === 'hide') { st.hidden.add(key); paintSheet(); return; }
    const next = prompt('Column name', colName(n, key));
    if (next === null) return;
    const t = next.trim();
    if (t) st.names.set(key, t); else st.names.delete(key);
    paintSheet();
  });
}

// Export reflects what is on screen: the visible columns, under the names you
// gave them. Exporting the raw capture after pruning would make the pruning a lie.
function sheetRows(n) {
  const cols = visibleCols(n);
  const names = headerNames(n, cols);
  return shownRows(n).map(({ r }) => {
    const o = {};
    cols.forEach((c, ci) => { o[names[ci]] = r[c.key] || ''; });
    return o;
  });
}

function initSheets() {
  wireEditing();
  initColsOverlay();

  // Filters what the table IS, so the count, CSV, JSON and the image download all
  // agree with what is on screen.
  $('sq').addEventListener('input', () => {
    sheetQuery = $('sq').value;
    sheetPage = 0; // a new filter is a new set; page 4 of it means nothing
    paintSheet();
  });

  $('pprev').addEventListener('click', () => { if (sheetPage > 0) { sheetPage--; paintSheet(); scrollSheetTop(); } });
  $('pnext').addEventListener('click', () => { sheetPage++; paintSheet(); scrollSheetTop(); });
  // "Show N" is one shared setting, not two — see `pageSize`'s own declaration. Changing
  // it from either pager resets BOTH page positions and mirrors the other button's label,
  // so the two views never disagree about what "50" currently means.
  $('psize').addEventListener('click', () => openMenu($('psize'), PAGE_SIZES,
    String(pageSize), (v) => {
      pageSize = +v || 0;
      sheetPage = 0;
      filesPage = 0;
      $('psize').textContent = $('filesPsize').textContent = PAGE_SIZES.find((o) => o.value === v).label;
      paintSheet();
      scrollSheetTop();
    }));

  // Images off is the compact reading of the same table: the columns go, the row
  // heights collapse, and the exports lose the URLs. Nothing is discarded — it is one
  // click back, and the button is offered whenever the table has images at all.
  $('sInc').addEventListener('click', () => {
    const st = stateFor(sheetAt);
    st.noImages = !st.noImages;
    paintSheet();
  });

  $('shid').addEventListener('click', () => {
    stateFor(sheetAt).hidden.clear();
    paintSheet();
  });
  // Five buttons, one menu. Every entry does exactly what its own button did: the same
  // `sheetMatrix`, so the same visible columns, the same row filter and the same dashes.
  // The list is rebuilt on every open because Images only belongs in it when there is
  // something to download, and that changes as columns are hidden and shown.
  exportMenu('sExp', () => {
    const items = sheetImages(sheetAt);
    return items.length
      ? EXPORTS.concat({ value: 'images', label: 'Images', hint: `${items.length} files` })
      : EXPORTS;
  }, (v) => {
    const n = sheetAt;
    if (v === 'csv') {
      const { columns, rows } = sheetMatrix(n);
      const cell = (x) => (/[",\n\r]/.test(x) ? '"' + String(x).replace(/"/g, '""') + '"' : x);
      // The header is never dashed — see the note by `CELL_EMPTY`. The values already are:
      // `sheetMatrix` applies the rule once for all four of this menu's exports.
      const csv = '﻿' + [columns.map((k) => cell(String(k ?? ''))).join(','),
        ...rows.map((r) => r.map(cell).join(','))].join('\r\n');
      return save(csv, sheetName('csv'), 'text/csv;charset=utf-8');
    }
    // The JSON gets the dash too, and this is the export that exposed the whole thing: a table of 124
    // businesses came out with `"Site": ""`, `"Email": ""`, `"Emails": ""` on row after row, which reads
    // as a column that failed rather than a business that publishes nothing.
    if (v === 'json') {
      return save(JSON.stringify(sheetRows(n).map(dashRow), null, 2),
        sheetName('json'), 'application/json');
    }
    if (v === 'xlsx') {
      return paperSave('sExp', 'workbook',
        () => Paper.xlsx({ ...sheetMatrix(n), sheet: sheetLabel(n), empty: CELL_EMPTY }),
        sheetName('xlsx'));
    }
    if (v === 'pdf') {
      return paperSave('sExp', 'PDF', () => {
        const m = sheetMatrix(n);
        return Paper.pdf({ ...m, title: sheetLabel(n), subtitle: sheetSub(m) });
      }, sheetName('pdf'));
    }
    if (v === 'images') return downloadImages(n);
  });
}

// The join. Every asset column in every row, named from the row's own first text value
// rather than from whatever the CDN called it.
//
// Split out from the click handler it used to live in because the menu has to know the
// COUNT before it is opened — an entry reading "Images" that turns out to do nothing is
// exactly the inert control this redesign removed. Zero items and the entry is not offered,
// which is what `#sImgs`'s `hidden` used to say.
function sheetImages(n) {
  const s = sheets[n];
  if (!s) return [];
  const cols = visibleCols(n);
  const assets = cols.filter((c) => c.kind === 'asset');
  const text = cols.find((c) => c.kind === 'text');
  const items = [];
  s.rows.forEach((r, i) => {
    const base = (text && r[text.key]) || `row-${i + 1}`;
    assets.forEach((c) => {
      if (r[c.key]) items.push({ url: r[c.key], title: base, page: s.selector });
    });
  });
  return items;
}

async function downloadImages(n) {
  const items = sheetImages(n);
  if (!items.length) return;
  flash($('sExp'), `${items.length}…`);
  await chrome.runtime.sendMessage({ type: 'DOWNLOAD', items });
  flash($('sExp'), 'Export');
}

// The table's own exports carry the SAME domain-path-stamp name the Files view's do (see
// `exportName`), so everything from one scan sorts together in Downloads. The table's label
// rides between the page and the stamp, because a page can hand over several tables and
// "which table is this" is the one thing the url cannot say.
const sheetName = (ext) => {
  const s = sheets[sheetAt];
  const base = (s?.label || `table-${sheetAt + 1}`).replace(/[^\w\d-]+/g, '_').slice(0, NAME_PART_MAX_CHARS);
  return exportName(ext, base);
};

// THE ONE READING OF THIS TABLE THAT EVERY EXPORT USES.
//
// `sheetRows` already answers "which columns, under which names, and which rows" — the
// hidden ones are gone, the renamed ones are renamed, and the row filter has been applied.
// What it does not do is settle the blanks, and each writer used to do that for itself; the
// bug that produced `CELL_EMPTY` was four writers disagreeing. So a matrix of finished
// strings is built once here and CSV, Excel and PDF all take it as it stands.
//
// Column order comes from the FIRST row's keys, which is safe because `sheetRows` gives
// every row the same keys in the same order — a shorter row would silently shift columns.
function sheetMatrix(n) {
  const rows = sheetRows(n);
  const columns = Object.keys(rows[0] || {});
  return { columns, rows: rows.map((r) => columns.map((k) => String(orDash(r[k])))) };
}

// What the table is called on a page of paper or a workbook tab, as opposed to in a filename.
const sheetLabel = (n) => sheets[n]?.label || `Table ${n + 1}`;
// The line under the title on every PDF page: how much is here, and where it came from.
// Both matter on a printout, which arrives with none of the window's context around it.
const sheetSub = (m) => {
  const size = `${m.rows.length} row${m.rows.length === 1 ? '' : 's'} · ${m.columns.length} column${m.columns.length === 1 ? '' : 's'}`;
  try { return `${size} · ${new URL(srcUrl).hostname.replace(/^www\./, '')}`; } catch { return size; }
};
