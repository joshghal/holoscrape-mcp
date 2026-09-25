// What an agent is allowed to ask this browser to do.
//
// A CLOSED VOCABULARY, AND THAT IS THE SECURITY MODEL. Nothing here takes code — no script body, no
// selector to `eval`, no function from the socket. Every op is a verb we wrote, taking data we
// validate. That is not caution for its own sake: MV3 forbids remotely-hosted code, so a tool that
// ran agent-supplied JavaScript would be a Chrome Web Store rejection AND would hand arbitrary
// execution inside a logged-in browser to whatever a poisoned page talked the agent into. The
// policy and the safety requirement point the same way, so the rule is absolute rather than a
// habit: if a new op needs to accept code, the answer is a new op.
//
// EVERY OP THAT TOUCHES A PAGE ASKS `allows` FIRST. Pairing proves which program is talking and is
// the consent to read; `allows` only rules out a blank tab and non-web schemes, and the
// restricted-host list rules out the pages no click may open.

// Where a result's tables live in storage — shared with the panel and the results page, so named
// once in tuning.js.
import { TABLE_KEY_PREFIX } from './tuning.js';

// --- reply sizes and defaults ---------------------------------------------------------------------
// Everything below is a REPLY-SHAPE decision: how much of something travels back through the model.
// None of them changes what the browser does; each one changes what a caller has to page for.
//
// A tab's title, a result's title, a saved merge's name. Long enough to recognise a page by,
// short enough that forty tabs of it is still a list rather than a document.
const TITLE_MAX_CHARS = 120;
// A url quoted back in a reply (`was`, `heldAt`). Long enough to carry the path and the first
// parameters that identify a page; a tracking-laden url past that says nothing more.
const URL_MAX_CHARS = 200;
// A GLIMPSE of a url inside an error sentence — just enough to say which page the tab in front is on.
const URL_GLIMPSE_CHARS = 60;
// A file name derived from a url's last path segment, for the download card.
const FILE_NAME_MAX_CHARS = 140;
// Field paths accepted in one `page_state` projection or keyed join. A projection is what turns
// thirty calls into one; forty fields is more than any row this engine has produced.
const MAX_FIELDS = 40;
// `results.get`: rows per reply when the caller does not say, and the most it may ask for. The
// ceiling is what `mcp/tools.mjs`'s `SAVE_PAGE` pages a file write by — change them together.
const RESULTS_GET_DEFAULT_ROWS = 100;
const RESULTS_GET_MAX_ROWS = 1000;
// `results.merge` without `into`: how many merged rows are shown before the caller is told to save.
const MERGE_PREVIEW_ROWS = 100;
// `results.list`: how many past results are offered. The history is newest-first; forty covers a
// long session and keeps the reply a list.
const RESULTS_LIST_MAX = 40;
// `results.download`: files per batch when the caller does not say, and the most one call may ask
// a person to approve. The person sees the number on the Save card, so it has to be one they can
// weigh. Described to callers in `mcp/tools.mjs` ("Default 500, max 2000").
const DOWNLOAD_DEFAULT_MAX = 500;
const DOWNLOAD_HARD_MAX = 2000;
// Skipped files named in a download reply — named, not counted, because a skipped file is a file
// the person expected to have; capped so a bad batch does not become the whole reply.
const SKIPPED_SHOWN = 40;
// Hosts named on the Save card before "+N more". A list the caller assembled can span many sites,
// and the person pressing Save is entitled to see the first few by name.
const HOSTS_SHOWN = 6;
// `page.grow`: how long to wait for new rows after a press or a scroll when the caller does not
// say. Described to callers in `mcp/tools.mjs` ("Default 2500, max 8000").
const GROW_WAIT_DEFAULT_MS = 2500;
// `tab.here` with `network`: each captured body is trimmed to this, with the trim stated. The
// bodies travel through a model and a GraphQL response is the biggest thing in the system;
// truncating each body leaves every url visible and says what was cut, where truncating the array
// would drop whole responses without a word.
const NET_BODY_CAP_CHARS = 24000;

// --- judgement thresholds ------------------------------------------------------------------------
// LOW DISTINCTNESS, NOT ANY DISTINCTNESS. `distinctness` is identSpread: the share of rows whose
// SET of link paths is its own (rows.js). 1 means every row names a different thing; near 0 means
// one record listed many times (a refinement panel: 54 links to `/s`). The test here was `<= 1`,
// which is every list on every page, so the "all resolve to the same place" warning fired on
// Alibaba at distinctness 1 and on Amazon at 0.85 (2026-09-23) and steered both runs into reading
// the grid by hand before list_extract was tried and worked. At or below this a list is worth
// the softer word; above it the rows are distinguishable enough to extract.
const LOW_DISTINCTNESS = 0.34;
// And the warning only speaks about a list with more rows than this — three rows that resolve to
// one place is a header that repeats, not a list worth warning about.
const DISTINCTNESS_MIN_ROWS = 3;
// A DESCRIPTOR MAY HAVE DRIFTED when its named list holds this small a fraction of what the page's
// generic detector finds (ratio), by at least this many rows (gap) — the shape of a selector that
// now points at a sub-element or a different list. Flagged, never overruled: measured on shopee,
// the ranking chose an 8-row filter panel while the named list held 60 products.
const DRIFT_RATIO = 3;
const DRIFT_MIN_GAP = 10;
// Lanes a backgrounded harvest opens when the caller does not say. The same five this project
// measured as the point where lanes stop helping — past it a run is slower AND returns thinner
// pages — and so also the ceiling across all live runs (`LANE_CEILING`, in `page.harvest`).
const LANE_DEFAULT = 5;

// A run is a walk in progress. Started by `list.extract`, watched by `run.status`, and kept here
// because an MCP call that blocked for the four minutes a fifteen-page walk takes would time out
// and tell the agent nothing while it did.
const runs = new Map();
let runSeq = 0;

// Enough of a tab for an agent to choose between them, and nothing more. No page text, no HTML:
// a tab list is for picking, and forty tabs of content would be most of a context window.
const tabBrief = (t) => ({ tabId: t.id, title: (t.title || '').slice(0, TITLE_MAX_CHARS), url: t.url || '', active: !!t.active, windowId: t.windowId });

// WHICH KIND OF PAGE OF THIS SITE ARE WE STANDING ON.
//
// A descriptor is matched by HOST, and `siteFor` looked at nothing else. So every page of a site
// inherited that site's `list` selector — including the pages that selector was never about.
//
// Measured on a live run, 2026-09-20: an agent opened a shopee.co.id PRODUCT page and `page_study`
// told it "this site's known list (ul.shopee-search-item-result__items) IS NOT ON THE PAGE YET —
// it matched nothing ... Do not study or harvest off it. Wait for the real one." That selector is
// the SEARCH GRID. On a product page it will never match, no matter how long anyone waits. The
// description and the reviews were both already ranked in the same reply — `Deskripsi Produk` and
// `div.shopee-product-comment-list`, six review rows visible in its own sample — and the hint said
// to ignore all of it and wait. `settleForList` made the same mistake more quietly, spending its
// full hydrate budget awaiting a grid that was not coming and then reporting `hasList: false`.
//
// The descriptor already carries the answer and has since it was written: `recordHref` is the
// pattern of a RECORD url on this site — `-i.{shopid}.{itemid}` for Shopee, `/status/{id}` for X,
// `/firm/{id}` for 2GIS, `/maps/place/` for Maps. If the url matches it, this is a record page,
// the site's `list` describes its LISTING routes, and "not painted yet" is a lie.
//
// Exported because the decision is worth testing on its own: it is pure, it is the whole fix, and
// a test of it needs no browser and no live host.
export function pageKindFor(descriptor, url) {
  if (!descriptor || !url) return 'unknown';
  if (!descriptor.recordHref) return 'unknown';
  try {
    const u = new URL(url);
    // Matched against path + query, not the whole url: a host can contain the pattern by accident,
    // and every `recordHref` in the tree describes a PATH.
    return new RegExp(descriptor.recordHref).test(u.pathname + u.search) ? 'record' : 'listing';
  } catch (_) { return 'unknown'; }
}

// LEARN THE PAGE DIAL FROM TWO URLS THE PERSON ACTUALLY VISITED.
//
// Every other route to pagination in this codebase is a GUESS about one url: does a parameter
// look like a page number, does a path end in /page/N, is there an anchor carrying rel=next. Each
// guess has a documented failure — a language switcher carrying ?pagi=2, a filename whose id
// reads as a page, a pager built from buttons that carries no address at all, and a dial in the
// FRAGMENT (`#inbox/p3`) that no single-url parser here looks at.
//
// Two urls from the same list at different pages need no guessing. Whatever differs between them
// IS the dial, and everything that stays the same is the list's identity. The person can always
// produce them — they click the pager themselves and copy the address twice, which takes ten
// seconds and works on every site ever built, including the ones whose pager is JavaScript.
//
// The three sets this was written against, all real:
//
//   shopee   ?page=1              ->  ?page=3                       one clean parameter
//   lazada   ...&page=2&q=...     ->  ...&page=5&q=...              buried in noise, order shuffles
//   amazon   ?k=android&crid=...  ->  ?k=android&page=3&ref=sr_pg_3&qid=...&xpid=...
//
// Amazon is the case that proves the method: page one carries NO page parameter at all, so no
// single-url parser can ever find the dial there — and a diff finds it immediately. It also shows
// why the answer must be scored rather than taken: three things changed between those two urls
// (`page`, `ref`, `qid`) and only one of them is the dial.
// WHICH LIST ACTUALLY MOVED WHEN THE PAGE TURNED.
//
// The decision half of the prior/evidence split, kept here as a pure function for one reason:
// buried inside the walk it could only ever be tested by grepping the source, and a mechanism
// that cannot be tested on its own is a mechanism that quietly rots. Everything it needs is
// passed in — no DOM, no tabs, no chrome.
//
// `scoreOf` ranks candidates by geometry, with no page turn to learn from. That is a prior, and
// it is wrong on any page whose biggest repeating block is furniture: a filter sidebar, a promo
// wrapper, a rail of sponsored cards. Every previous answer to that was a weight pushed into the
// one global ranking every door reads, so each site's fix broke the site before it.
//
// This is the evidence instead, and it only speaks when it has some. Returns null — meaning
// "leave the prior alone" — in every case but one: the chosen list brought NOTHING new across a
// real page turn, and some other candidate brought rows nobody has seen. On a page where the
// prior was already right the chosen list changed, and the first loop returns null immediately.
// That asymmetry is the whole safety argument: it cannot touch a site that was working.
export function listThatMoved({ prevIds, chosenIds, rivals, seen, minNew = 2, turnsMoved = 0 }) {
  if (!prevIds || !prevIds.size || !chosenIds) return null;
  // A LIST THAT HAS ALREADY MOVED IS NOT FURNITURE. Furniture is identical on EVERY page — that
  // is the whole evidence this rule rests on. A chosen list that brought new rows across earlier
  // turns has disproved that once already; when it stops changing later, the list has RUN OUT,
  // and the rival full of unseen rows is the footer of a page past the end. Measured on a
  // shopee.co.id category walk: nine pages of sixty, then three pages past the end where the
  // grid was gone, the chosen table stalled on five junk rows, and this rule handed the walk to a
  // thirty-row footer — `here.repick ... dropped=439` — then walked again from page one and
  // ended on `pages=1 rows=8`. Nothing here may cost a walk what it has already read.
  if (turnsMoved > 0) return null;
  // It moved. Whatever else is on the page, the list we are reading is alive.
  for (const k of chosenIds) if (!prevIds.has(k)) return null;
  let pick = null;
  let fresh = 0;
  for (const r of (rivals || [])) {
    // Fewer than two rows is not a list; it is a header that happens to repeat.
    if (!r || !r.ids || r.ids.size < 2) continue;
    let n = 0;
    for (const k of r.ids) if (!seen.has(k)) n++;
    if (n > fresh) { fresh = n; pick = r; }
  }
  // One new identity is what a rotating ad slot looks like. A real list brings a page of them.
  return pick && fresh >= minNew ? { pick, fresh } : null;
}

// WHICH OF THIS PAGE'S TABLES IS THE LIST THE WALK LOCKED ONTO — OR NONE OF THEM.
//
// Pure, for the same reason `listThatMoved` is: a walk that turned a page and read the wrong
// table looks, from every log line it emits, like a walk that is going well. `fresh` is positive,
// the total climbs, the page turns again. The only way to argue with the choice is to be able to
// hand it a page and see what it says.
//
// THE FAILURE THIS EXISTS FOR: a page PAST THE END OF THE LIST. Shopee caps a category at a fixed
// depth and answers `?page=8` with the same chrome and an EMPTY grid. `extractAll` still returns
// every other repeating block on that page — a category rail, a footer, a "you may also like"
// strip — and the walk used to take `tables[0]` whenever nothing matched the list it had locked.
// Measured, from the person's own log, after seven full pages of sixty:
//
//   here.read n=8  saw=15 fresh=15      the real last page
//   here.list n=8  rows=14 first=…/Makanan-Minuman-cat.157      a CATEGORY LINK, not a product
//   here.read n=9  saw=14 fresh=14      the category rail, read as page nine
//   here.read n=10 saw=5  fresh=5       a five-row strip, read as page ten
//   here.repick … nowRows=30 dropped=439  the footer, and the whole walk thrown away
//
// Every one of those junk rows was "fresh", so `page N held nothing new` — the walk's one ending
// — could never fire, and the walk read past the end until the repick rule finished it off.
//
// The rule, in order:
//
//   1. Before the walk has locked anything (page one), the engine's own ranking stands: `tables[0]`.
//   2. The table wearing the SAME selector is the list — unless the list has proven that its
//      rows carry a record link and this table's rows carry none (see `recordsSeen`). A grid's
//      container refilled with "recommended for you" cards is the container, not the list.
//   3. Otherwise the table whose COLUMNS overlap the canonical set from page one — a redesign
//      renames ancestors and keeps the cells. Scored over every table on the page, one included:
//      a page whose only list is the real one under a new selector must not be read as "gone".
//   4. Nothing overlaps: the list is NOT ON THIS PAGE, and that is the answer — `null` — never the
//      biggest other block. The caller treats it exactly like an empty page, which is what it is.
//
// `recordsSeen` is the walk's own count of rows so far that carried a record link. The record
// test is only allowed to speak once the list has shown it has records: a descriptor whose
// `recordHref` is wrong for this page would otherwise end every walk on page two.
export function chooseWalkTable({ tables, selector, canonName, canonSlot, recordHref = '',
  recordsSeen = 0, read = 0 }) {
  const all = Array.isArray(tables) ? tables.filter(Boolean) : [];
  if (!all.length) return { t0: null, via: 'none' };
  if (!selector) return { t0: all[0], via: 'first' };
  const rx = recordHref ? new RegExp(recordHref) : null;
  const carriesRecord = (t) => !rx || !recordsSeen
    || (t.rows || []).some((r) => rowHasRecord(r, rx));
  const exact = all.find((t) => (t.selector || '') === selector);
  if (exact && carriesRecord(exact)) return { t0: exact, via: 'selector' };
  const known = (canonName?.size || 0) + (canonSlot?.size || 0);
  const slots = [...(canonSlot?.keys?.() || [])];
  let best = null, bestScore = -1;
  for (const t of all) {
    if (t === exact) continue;
    let score = 0;
    for (const c of (t.cols || [])) {
      if (!c || !c.key) continue;
      if (c.name) { if (canonName?.has(c.name)) score++; continue; }
      const kind = c.kind || 'text';
      if (slots.some((s) => s.startsWith(`${kind}#`))) score++;
    }
    if (score > bestScore) { bestScore = score; best = t; }
  }
  // A real match overlaps meaningfully; a rail of unrelated clusters must not win just because it
  // is the only other candidate on the page.
  if (best && bestScore >= Math.max(2, Math.ceil(known / 2)) && carriesRecord(best)) {
    return { t0: best, via: 'shape', score: bestScore };
  }
  // PAGE ONE IS NOT A TURN. After a repick the walk starts over with a selector already locked
  // and nothing read; the page it is standing on cannot be "past the end" of a list it has not
  // begun, so the engine's ranking stands there exactly as it does on any first page.
  if (!read) return { t0: all[0], via: 'first' };
  return { t0: null, via: exact ? 'no-records' : 'gone',
    saw: all.map((t) => (t.rows || []).length) };
}

// WHICH ROW THIS IS, ACROSS THE PAGES OF A WALK — and a link several rows share does not say.
//
// This lived in background.js as "the row's longest link, query removed, else the whole row", and
// the history written above it there is a list of what that rule was right about: a first-URL rule
// let a country flag delete products (384 read, 192 kept), and a whole-URL rule let Alibaba's
// per-load `priceId` make one product two. Both still hold here. What the longest link got wrong
// was measured through the real MCP path on 2026-09-22, on a page where NO link is about the row:
//
//   quotes.toscrape.com, 3 pages of 10      26 rows, nothing in the reply saying 4 were gone
//     page 1 rows 2, 4, 7   all keyed  /tag/inspirational/page/1/   (a quote card's longest link
//     page 2 rows 0, 6      the same key, already seen               is one of its TAGS)
//   the same site, all 10 pages             77 of 100
//
// A quote card links to its author and to its tags. Neither is the quote. So:
//
//   LINKS   the row's whole SET of bare link paths, not its longest. This is the rule `identOf` in
//           rows.js was already moved to, for the same fault seen on a live timeline, and the rule
//           `identSpread` started with; this was the third copy and the one that never got told.
//           Measured on those ten pages it recovers 98 of 100.
//   WORDS   and the last two are why links cannot be the whole answer: two J.K. Rowling quotes
//           both filed under `dumbledore` alone share EVERY link they have. A board of openings
//           that links each row to its company collapses to one row per company — 24 cards, 3
//           rows, in `test/shared-link-is-not-the-row.mjs`. What tells such rows apart is what
//           they say, so the row's MAIN TEXT — its longest text cell — is part of its name.
//
// WHY THIS CANNOT RE-ADMIT WHAT THE DE-DUPLICATION IS FOR. A key built from the link set and the
// main text REFINES the old key: equal link sets have equal longest links, so two rows this calls
// the same, the old rule called the same too, and nothing is newly merged. What is newly KEPT is
// exactly: rows that shared a longest link and differ in their link set or in their main text. A
// record served twice — page overlap, a pager that loops, an advert repeating an organic row —
// arrives with the same links and the same title, and still collapses; so does one whose link
// carries a new query token (bare paths, as before) and one whose SHORT cells changed between
// reads ("2 hours ago", a stock count, "Open"), because only the longest cell is in the key. The
// one shape given up is a record re-served with its longest text rewritten in between, and that
// costs a visible duplicate rather than an invisible loss — the trade `dedupeRows` in rows.js
// already makes ("two genuinely identical products differing in any cell both survive").
//
// A provider that says what a record link looks like is still believed outright, and a row with
// no links at all is still its whole self: neither branch changed.
const ASSET_CELL = /\b(src|data-src|data-original|data-lazy-src|srcset|data-srcset)$/;
function rowLinks(row, recordHref) {
  const rx = recordHref ? new RegExp(recordHref) : null;
  const bare = [];
  let rec = '';
  for (const [k, v] of Object.entries(row || {})) {
    if (!v || typeof v !== 'string' || !/^https?:/i.test(v)) continue;
    if (!/\bhref$/.test(k)) continue;          // links only: an <img> is not an identity
    try {
      const u = new URL(v);
      const b = u.origin + u.pathname;
      if (rx && rx.test(u.pathname) && (!rec || b.length < rec.length)) rec = b;
      if (!bare.includes(b)) bare.push(b);
    } catch (_) {}
  }
  return { rec, bare };
}
// The longest thing the row SAYS. Links and pictures are not words, and a cell holding a bare URL
// under a text key is a link that lost its anchor, not a sentence.
export function rowMainText(row) {
  let best = '';
  for (const [k, v] of Object.entries(row || {})) {
    if (typeof v !== 'string' || !v) continue;
    if (/\bhref$/.test(k) || ASSET_CELL.test(k) || /^https?:/i.test(v)) continue;
    const t = v.replace(/\s+/g, ' ').trim();
    if (t.length > best.length) best = t;
  }
  return best;
}
export function rowIdentity(row, recordHref) {
  const { rec, bare } = rowLinks(row, recordHref);
  if (rec) return rec;
  if (!bare.length) return JSON.stringify(row);
  return `${bare.sort().join(' ')}\u0000${rowMainText(row)}`;
}
// THE OLD RULE, KEPT FOR THE ONE READER THAT COMPARES TWO READS OF THE SAME PAGE. `here.kept`
// seeds a walk with the rows this visit's earlier scan stored, skipping any the walk's own first
// read already has. Those two reads are seconds apart on a page that may still have been filling
// in, so a finer name there would turn "the title arrived late" into every row of page one twice.
// Asking only whether the row's longest link is already present is what that loop always did.
export function rowLinkKey(row, recordHref) {
  const { rec, bare } = rowLinks(row, recordHref);
  if (rec) return rec;
  let best = '';
  for (const b of bare) if (b.length > best.length) best = b;
  return best || JSON.stringify(row);
}

// Does one row carry a link to a record of this list, as the provider describes one.
export function rowHasRecord(row, rx) {
  if (!rx) return false;
  for (const [k, v] of Object.entries(row || {})) {
    if (!v || typeof v !== 'string' || !/^https?:/i.test(v) || !/\bhref$/.test(k)) continue;
    try { if (rx.test(new URL(v).pathname)) return true; } catch (_) {}
  }
  return false;
}

export function dialFromPair(aUrl, bUrl, aPage, bPage) {
  let A; let B;
  try { A = new URL(aUrl); B = new URL(bUrl); } catch (_) { return null; }
  if (A.origin !== B.origin) return { error: 'those two urls are on different sites' };

  const pa = Number(aPage) || null;
  const pb = Number(bPage) || null;
  const NAMEY = /^(page|p|pg|pagina|pagi|halaman)$/i;
  const SOFT = /(page|pagi|halaman|start|offset|from)/i;

  // --- the dial in a QUERY PARAMETER -------------------------------------------------------
  // Collected from BOTH urls, because the winning case has the parameter missing on one side.
  const keys = new Set([...A.searchParams.keys(), ...B.searchParams.keys()]);
  const cands = [];
  for (const k of keys) {
    const va = A.searchParams.get(k);
    const vb = B.searchParams.get(k);
    if (va === vb) continue;                         // unchanged is not a dial
    // The LATER url must carry a small integer. `qid=1789971796` is a timestamp, not a page.
    if (vb == null || !/^\d{1,6}$/.test(vb)) continue;
    if (va != null && !/^\d{1,6}$/.test(va)) continue;
    let score = 0;
    if (NAMEY.test(k)) score += 100;                 // literally called page
    else if (SOFT.test(k)) score += 40;
    if (va == null) score += 10;                     // absent on page one is the classic shape
    // THE DECIDER WHEN THE PERSON TOLD US WHICH PAGES THESE ARE. A parameter whose values ARE
    // the page numbers is the dial; nothing else has to be weighed against it.
    if (pb != null && Number(vb) === pb) score += 200;
    if (pa != null && va != null && Number(va) === pa) score += 200;
    if (Number(vb) <= 1000) score += 5;              // page numbers are small
    cands.push({ at: 'query', key: k, from: va == null ? null : Number(va), to: Number(vb), score });
  }

  // --- the dial in the PATH, or in the FRAGMENT ----------------------------------------------
  // Same shape either way: a /page/3 or /p/3 segment. The fragment is included because Gmail's
  // dial lives there (`#inbox/p3`) and nothing else in this codebase reads it.
  // THE SLASH IS OPTIONAL, AND GMAIL IS WHY. `/page/3` and `/p/3` are the common shapes; Gmail
  // writes `#inbox/p3` with the number welded to the letter. Requiring the separator found the
  // first two and missed the one site that has no other route to its dial at all.
  //
  // `/mp3` cannot match: the character after the slash must be the whole key, so `m` fails first.
  const seg = /\/(page|p)\/?(\d{1,6})\/?$/i;
  for (const [at, x, y] of [['path', A.pathname, B.pathname], ['hash', A.hash, B.hash]]) {
    if (x === y) continue;
    const mb = seg.exec(y);
    if (!mb) continue;
    const ma = seg.exec(x);
    let score = 120;
    if (pb != null && Number(mb[2]) === pb) score += 200;
    if (ma && pa != null && Number(ma[2]) === pa) score += 200;
    cands.push({ at, key: mb[1], from: ma ? Number(ma[2]) : null, to: Number(mb[2]), score });
  }

  if (!cands.length) {
    return { error: 'nothing that looks like a page number differs between those two urls — '
      + 'are they really the same list on different pages?' };
  }
  cands.sort((x, y) => y.score - x.score);
  const win = cands[0];

  // THE DIAL IS NOT ALWAYS THE PAGE NUMBER, AND ASSUMING IT IS BREAKS EVERY OFFSET PAGER.
  //
  // `?page=3` means page three. `?start=50` means page three of a list that serves twenty-five at
  // a time, and writing `start=3` there asks for the fourth RECORD, not the third page — a silent
  // wrong answer that looks completely normal. Google, eBay and a great many search stacks count
  // in offsets, so this is not an exotic case.
  //
  // So the dial is stored as a LINE rather than a number: `value(n) = base + (n - atPage) * step`.
  // A page dial is the line with step 1; an offset dial is the same line with step 25. One
  // formula, and nothing downstream has to know which kind it got.
  //
  // The step needs two readings and the pages they came from. When the person has not said which
  // pages they pasted, they are taken as CONSECUTIVE and ascending — which is what the card asks
  // for, and what anyone does naturally: open page 2, copy, open page 3, copy.
  const pageOf = (v) => (v != null && v >= 1 && v <= 5000 ? v : null);
  let atPage = pa != null ? pa : (pageOf(win.from) != null ? win.from : 1);
  let toPage = pb != null ? pb : atPage + 1;
  let step = 1;
  let base = atPage;
  if (win.from != null && toPage !== atPage) {
    step = (win.to - win.from) / (toPage - atPage);
    base = win.from;
  } else if (win.from == null) {
    // ABSENT ON THE FIRST PAGE — amazon's shape. If the value IS the later page number the dial
    // counts pages; otherwise it counts records from a page one that carried no parameter, so
    // page one is zero.
    if (win.to === toPage) { step = 1; base = atPage; } else {
      step = win.to / Math.max(1, toPage - 1);
      base = 0;
      atPage = 1;
    }
  }
  // A FRACTIONAL STEP IS A MISREAD, NOT A PAGER. Refusing is better than generating addresses
  // that are almost right.
  if (!Number.isFinite(step) || step <= 0 || Math.abs(step - Math.round(step)) > 1e-9) {
    return { error: `the value of "${win.key}" moves by ${step} between those pages, which is not `
      + 'a page step — paste pages that are one apart, or check they are the same list' };
  }
  step = Math.round(step);
  // WHAT ELSE MOVED, SAID OUT LOUD — AND THAT MEANS EVERYTHING, NOT JUST THE RUNNERS-UP.
  //
  // A first version listed the other numeric candidates, which on amazon is nothing at all: `ref`
  // is text and `qid` is a ten-digit timestamp, so both are thrown out before they can be
  // mentioned. The filter was doing its job and the report was silent about three parameters that
  // genuinely changed between the two pages.
  //
  // That silence matters, because every one of them is FROZEN at the later page's value in every
  // address this builds: page seven goes out carrying `ref=sr_pg_3`. Harmless on amazon, not
  // necessarily harmless everywhere, and never something a person should have to discover.
  const alsoMoved = [];
  for (const k of keys) {
    if (k === win.key) continue;
    if (A.searchParams.get(k) !== B.searchParams.get(k)) alsoMoved.push(k);
  }
  return {
    at: win.at, key: win.key, from: win.from, to: win.to,
    // The line, and what it means in words, because "step 25" is the difference between a page
    // dial and an offset dial and a reader should never have to infer which they were handed.
    base, step, atPage,
    counts: step === 1 ? 'pages' : `records, ${step} at a time`,
    ...(alsoMoved.length ? { alsoMoved } : {}),
    // The LATER url is the template: it carries every parameter the site adds once paging starts.
    template: bUrl,
  };
}

// LEARN THE DIAL FROM HOWEVER MANY ADDRESSES, IN WHATEVER ORDER THEY WERE PASTED.
//
// `dialFromPair` takes exactly two urls and is told how many pages apart they are. The caller
// was passing the FIRST and the LAST box and claiming one page — so with three boxes filled,
// every step came out doubled. Measured on shopee: pages 0, 1, 2 pasted correctly produced
// "Page 1 -> ?page=0, Page 2 -> ?page=4", a step of 4 from a list that steps by 1.
//
// It also assumed box order was page order. Nobody promised that. The boxes are a way of
// collecting addresses, not a statement about sequence — this feature exists to STUDY the
// pattern, not to be handed the pages in the order they will be read.
//
// So the order is derived instead of trusted. `dialFromPair` already reports the value it found
// at each end (`from`, `to`), so probing url[0] against each of the others reads every url's own
// number without re-implementing the parsing. Sort by that number, and the two LOWEST adjacent
// addresses are a genuine one-page pair whatever order they arrived in.
export function dialFromUrls(urls) {
  const gcd2 = (a, b) => (b ? gcd2(b, a % b) : Math.abs(a));
  const list = (urls || []).map((u) => String(u || '').trim()).filter(Boolean);
  if (list.length < 2) return { error: 'two addresses are needed — one page apart is enough' };

  // ASKED IN BOTH DIRECTIONS, because `dialFromPair` refuses a pair that counts DOWN — quite
  // rightly, since a negative step is not a pager. But "which of these two is earlier" is
  // exactly what we do not know yet, so a refusal on one ordering is information, not a failure.
  const probe = (a, b) => {
    const f = dialFromPair(a, b, 1, 2);
    if (f && !f.error) return { key: f.key, va: f.from, vb: f.to };
    const r = dialFromPair(b, a, 1, 2);
    if (r && !r.error) return { key: r.key, va: r.to, vb: r.from };
    return { error: (f && f.error) ? f.error : 'could not read a page number out of those' };
  };

  // ANY PAIR THAT READS, NOT ONLY THE FIRST TWO. Two of three boxes can easily be the same page,
  // or differ in something that is not a number; that says nothing about the other pairings, and
  // bailing on it threw away addresses that between them held a perfectly readable dial.
  let anchor = -1;
  let first = null;
  for (let i = 0; i < list.length && !first; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const t = probe(list[i], list[j]);
      if (!t.error) { anchor = i; first = t; break; }
    }
  }
  if (!first) return { error: 'could not read a page number out of those' };

  const value = list.map(() => null);
  value[anchor] = first.va;
  for (let i = 0; i < list.length; i++) {
    if (i === anchor) continue;
    const p = probe(list[anchor], list[i]);
    if (p.error || p.key !== first.key) continue;   // not a page of this list — leave it out
    value[i] = p.vb;
  }
  // A MISSING PARAMETER IS A VALUE, NOT A GAP IN THE EVIDENCE.
  //
  // Page one of most sites carries no page number at all — shopee's is the bare category url,
  // and `?page=1`, `?page=2` follow it. Reading the absent key as "unreadable" threw that url
  // away and made `?page=1` look like page one, so the rebuilt page 1 WAS page 2 and the real
  // first page was never visited. Reported as "page 1 is basically has no page param, why it
  // skipped?".
  //
  // The address itself is the evidence: it is the page the site serves when nothing is asked
  // for, which sits immediately before the lowest number that IS asked for. One step below the
  // minimum, where the step comes from the numbered addresses.
  const numbered = list.map((u, i) => ({ u, v: value[i] })).filter((x) => x.v != null);
  if (!numbered.length) return { error: 'could not read a page number out of those' };
  const bare = list.map((u, i) => ({ u, v: value[i] })).filter((x) => x.v == null);
  const known = numbered.slice();
  if (bare.length === 1 && numbered.length >= 1) {
    const vs = numbered.map((x) => x.v).sort((a, b) => a - b);
    let st = 0;
    for (let i = 1; i < vs.length; i++) st = gcd2(st, vs[i] - vs[i - 1]);
    if (!st) st = 1;                       // one numbered address tells us nothing about stride
    known.push({ u: bare[0].u, v: vs[0] - st, bare: true });
  }
  if (known.length < 2) return { error: 'could not read a page number out of those' };

  const order = known.sort((a, b) => a.v - b.v).filter((x, i, xs) => i === 0 || x.v !== xs[i - 1].v);
  if (order.length < 2) return { error: 'those addresses are the same page' };

  // PAGES THAT SKIP ARE STILL PAGES. This used to refuse anything whose gaps disagreed —
  // "those addresses step by 2 then 5, so they are not consecutive pages" — which treated
  // perfectly good evidence as a mistake by the person who supplied it. It is not a mistake.
  // Someone studying a pager may well hand over page 1, page 3 and page 8.
  //
  // The step is the greatest common divisor of the gaps, which is the largest stride that can
  // land on every address given. Values 0, 2, 7 give gcd(2,5) = 1: a page dial, and the pasted
  // addresses are pages 1, 3 and 8 of it. Values 0, 40, 100 give gcd(40,60) = 20: an offset
  // dial of twenty records, and they are pages 1, 3 and 6. Equal gaps are simply the case where
  // the gcd is the gap.
  //
  // The one reading it cannot separate is every-other-page of a stride-1 pager (0, 2, 4), which
  // is indistinguishable from a stride-2 dial. Nothing in the addresses can tell those apart, so
  // the card shows the rebuilt page 1 and page 2 for exactly this reason.
  let step = 0;
  for (let i = 1; i < order.length; i++) step = gcd2(step, order[i].v - order[i - 1].v);
  if (!step) return { error: 'those addresses are the same page' };

  // FIT THE LINE THROUGH TWO NUMBERED ADDRESSES. The bare url has a position but no number in
  // it, so `dialFromPair` cannot read a value out of it — it is what the line is FOR, not what
  // the line is built from. Their true page positions come from the order, so the fit is the
  // same line either way.
  const pageOf = (x) => 1 + (x.v - order[0].v) / step;
  const fit = order.filter((x) => !x.bare);
  if (fit.length >= 2) return dialFromPair(fit[0].u, fit[1].u, pageOf(fit[0]), pageOf(fit[1]));
  const apart = (order[1].v - order[0].v) / step;
  return dialFromPair(order[0].u, order[1].u, 1, 1 + apart);
}

// Build the url for a given page, from a dial `dialFromPair` learned.
export function urlForPage(dial, n) {
  if (!dial || dial.error) return '';
  let u;
  try { u = new URL(dial.template); } catch (_) { return ''; }
  // THE LINE, NOT THE PAGE NUMBER. See the note in `dialFromPair`: an offset pager wants
  // `(n-1) * 25`, not `n`, and the two are indistinguishable from one url.
  const step = Number.isFinite(dial.step) ? dial.step : 1;
  const base = Number.isFinite(dial.base) ? dial.base : 1;
  const at = Number.isFinite(dial.atPage) ? dial.atPage : 1;
  const v = base + (Number(n) - at) * step;
  if (!Number.isFinite(v) || v < 0) return '';
  if (dial.at === 'query') { u.searchParams.set(dial.key, String(v)); return u.href; }
  // Rebuilt in the shape it was FOUND in — `/p/3` stays `/p/3`, `/p3` stays `/p3` — because a
  // site that writes one does not accept the other.
  const swap = (str) => str.replace(new RegExp(`/(${dial.key})(/?)(\\d{1,6})/?$`, 'i'),
    (_m, k, slash) => `/${k}${slash}${v}`);
  if (dial.at === 'path') { u.pathname = swap(u.pathname); return u.href; }
  if (dial.at === 'hash') { u.hash = swap(u.hash); return u.href; }
  return '';
}

export function bridgeOpTable({
  hopHere, hopProgress, runRows, stopScan, savedTablesFor, exportCsv, pinnedFor,
  restrictedHost, allows, waitForLoad, pinnedTab, descriptors, harvest, harvestLinks,
  netOpen, netTake, netClose, netCatalogue, growFeed, netWatch, lateKeeper, armFrames,
  withVisibleTab, downloadAll, askToSave, walkPressRealBatch,
  // settle.js — what state a page was in when it was read, and the one rule for "is it ready".
  settle, settleBrief, pageProbe, pageHeader, netTrack, armNav, sameDocument,
}) {
  // WAS THE DESTINATION REPLACED BY SOMETHING THAT INTENDS TO SEND US BACK?
  //
  // `arrived` used to mean only "the url changed", so a navigation that ended on a sign-in page
  // was reported as an arrival. Measured on a real run: a session asked for a product's review
  // list, landed on Amazon's sign-in, was told arrived:true, and worked out the truth from the
  // page TITLE. It should not have had to.
  //
  // The test is structural and carries no vocabulary at all: a site that bounces you somewhere
  // holds your destination in a query parameter so it can return you afterwards. Amazon uses
  // openid.return_to, Google uses continue, Microsoft uses redirect_uri, others use next or
  // ReturnUrl — and none of that needs to be listed, because what is being checked is that SOME
  // parameter value contains the PATH we asked for.
  //
  // Two guards against false positives, both learned from the same run: the landed path must
  // differ from the wanted one (a site adding ?th=1 to the url you asked for has not bounced you),
  // and a wanted path too short to be distinctive is not matched on at all.
  const heldForReturn = (landed, wanted) => {
    try {
      const L = new URL(landed);
      const W = new URL(wanted);
      if (L.pathname === W.pathname) return false;
      if (W.pathname.length < 4) return false;
      for (const v of L.searchParams.values()) {
        // DECODED UNTIL IT STOPS CHANGING, NOT ONCE.
        //
        // A single decode was enough for a sign-in bounce, and not for a challenge. Measured on
        // shopee.co.id: the anti-bot page is
        //   /verify/captcha?…&next=https%3A%2F%2Fshopee.co.id%2Fverify%2Ftraffic%3F%3Fnext%3D
        //   https%253A%252F%252Fshopee.co.id%252FCelana-Dalam-Pria-…
        // — the destination is nested TWO redirects deep, so one decode leaves the inner copy
        // still percent-encoded (`%252F`), the pathname match fails, and the reply says
        // `arrived: true` about a captcha. The run carried on loading pages against a session the
        // site had already challenged, which is how one captcha becomes a blocked session.
        //
        // Three passes, and it stops early when a pass changes nothing. Bounded because a
        // malformed value can decode forever, and `decodeURIComponent` throws on a stray `%`,
        // which is why each pass is guarded rather than the loop.
        let dec = v;
        for (let i = 0; i < 3; i++) {
          let next = dec;
          try { next = decodeURIComponent(dec); } catch (_) { break; }
          if (next === dec) break;
          dec = next;
        }
        if (dec.includes(W.pathname)) return true;
      }
      return false;
    } catch (_) { return false; }
  };

  // --- what the BROWSER can say that the server cannot -------------------------------------
  // The MCP server derives hints from the shape of a reply (see NEXT in mcp/tools.mjs). It works,
  // and it is blind to everything that was true on the page but did not survive into the JSON.
  // Only here do we know that the rail held 23 entries while the extractor returned one, that a
  // section rendered no children because it is COLLAPSED rather than virtualized, or that the
  // pane never moved. A hint built from those facts is better than any built downstream, so the
  // server keeps ours and never overwrites it.
  //
  // Silence is the default. A hint on every reply is noise, and noise in every reply is how a
  // useful field stops being read — these fire only where the next call is about to be wrong.
  // Nothing here may throw: a hint is never worth the result it would cost.
  const browserHint = function(kind, out, t) {
    // A missing or errored reply is not an empty result and must not be described as one —
    // that is the same mistake as reporting a truncated list as the whole list.
    if (!out || typeof out !== 'object' || out.error) return null;
    try {
      if (kind === 'read') {
        const rows = out?.rows || [];
        const hidden = Number(out?.hidden) || 0;
        if (!rows.length && hidden > 0) {
          return `nothing matched but the page is holding ${hidden} more — a COLLAPSED section `
            + 'renders no children at all, and no amount of scrolling reveals them. '
            + 'page_state path:"@map(<scope>)" expands disclosures first.';
        }
        if (!rows.length) {
          return 'the selector matched nothing. page_state path:"@html(<container css>)" shows the real markup '
            + '— icon rails carry their name in aria-label, not text.';
        }
        if (hidden > 0) {
          // GROWING IS NAMED FIRST BECAUSE IT IS THE COMMONEST CAUSE AND WAS NOT MENTIONED AT ALL.
          // Measured on a shopee.com.br search: a read matched 14 links and reported total:14 on a
          // page that held 54 once grown, and this hint sent the caller to `limit` and `offset` —
          // both of which page a reply, and neither of which makes the page render more. The
          // advice was about the wrong layer, so following it exactly could never work.
          return `${rows.length} returned and ${hidden} more matched but are not visible. On a feed `
            + 'or a grid that is usually because the page has more to mount: page_grow until it '
            + 'reports grew:false, then read again — the selector will match more than it does now. '
            + `Or wait for the number itself to settle: page_state path:"@await(<row css> :: still)". `
            + 'If growing changes nothing, the rest is genuinely hidden (a collapsed section: '
            + '@map(<scope>)) or simply beyond this reply (raise limit, or page with offset). '
            + 'Do not report this count as the total either way.';
        }
      }
      if (kind === 'study') {
        const lists = out?.lists || [];
        const best = lists[0];
        // FURNITURE IS TESTED FIRST, AND THE ORDER IS THE WHOLE POINT.
        //
        // On shopee.com.br the only candidate was the FOOTER — `looksLikeFurniture: true`,
        // `chosen: true`, `rows: 5`, `linksNow: 8` — and it also happened to satisfy the
        // distinctness test below (`rows > 3`, `distinctness <= 1`). So the caller was told "the
        // best candidate has 5 rows that all resolve to the same place, page_read on it returns
        // what is really there", which is advice about the WRONG LIST: it says try another tool,
        // when the truth was that the page had not rendered and the five rows were the footer's
        // help links. An agent that followed it faithfully still lost the run.
        //
        // `looksLikeFurniture` was being computed (see `rows.js`) and then mentioned only in the
        // static `note`, which is the line a caller skims past. A flag nothing acts on is a flag
        // nobody reads.
        if (best && best.looksLikeFurniture) {
          return `the best candidate is site furniture — a ${best.rows}-row `
            + `${(best.landmarks || []).join('/') || 'chrome'} block, not the page's content. `
            + (lists.length === 1
              ? 'It is also the ONLY list found, which usually means the real one has not rendered '
                + 'yet: re-read in a moment, or read what the page FETCHES instead of what it shows. '
              : 'Pick a different candidate from `lists`. ')
            + 'Do not harvest off this.';
        }
        // A DESCRIPTOR THAT NAMES THE FIELDS ANSWERS THE DISTINCTNESS WARNING BEFORE IT FIRES.
        //
        // `distinctness: 1` means the GENERIC namer cannot tell one row from another. That is true
        // of every product grid ever built — each card carries the same shape of links — so on a
        // measured site it says nothing about whether the list can be read. `provider-shopee`
        // exists partly for this: its `fields` name Name, Link, Price, Discount, Sold and Badge
        // outright, which is what makes the rows distinguishable.
        //
        // WHAT THE OLD WORDING COST. On a shopee.com.br category page this fired against the REAL
        // product grid and ended with "list_extract will not". The run believed it, abandoned the
        // one tool that walks pages inside the browser, and read the grid by hand instead — every
        // row through the model. The same person's side panel, driving the SAME engine through
        // `HOP_HERE`, did 240 rows across 4 pages in 49 seconds. `list_extract` calls that very
        // function. The warning did not slow the run down; it routed the run around the fast path.
        // THE DESCRIPTOR'S VERDICT OUTRANKS THE SCORE, AND IT HAS TO BE ASKED FIRST.
        //
        // The branch below endorses `list_extract` when the site names its fields. That is right
        // when the ranking found the right list and ACTIVELY HARMFUL when it did not — measured on
        // shopee.co.id, where the grid had not painted, `chosen` was the filter panel, and this
        // hint sent the caller into `list_extract` for eight rows of filter labels. The previous
        // wording ("list_extract will not") was wrong advice that accidentally protected; replacing
        // it removed a guard without replacing what it guarded.
        //
        // So: if the site NAMES a list and the chosen candidate is not it, nothing else about the
        // ranking matters. Either the page has not painted or this is not a list route, and both
        // answers are "do not harvest off this yet".
        if (out?.namedList && out.chosenIsNamedList === false) {
          // SAID PLAINLY, BECAUSE THE ALTERNATIVE WAS A LIE THAT COST A WHOLE RUN. On a record
          // page the site's list selector is not late, it is irrelevant, and telling a caller to
          // wait for it sends it to wait for something that is never coming while the sections it
          // actually wants sit ranked in this same reply.
          if (out.pageKind === 'record') {
            return `this is a RECORD page, not a listing page. ${out.namedList} is this site's `
              + 'SEARCH/CATEGORY grid and will never match here — that is not a page that failed '
              + 'to paint, and there is nothing to wait for. The lists above ARE this page\'s '
              + 'own sections: read the one you want with page_state path:"@dom(<css>)", or page_harvest these urls '
              + 'to collect the same fields from many records at once.';
          }
          return out.namedListRows > 0
            ? `the chosen candidate is NOT this site's known list. The descriptor names `
              + `${out.namedList} and it is on the page with ${out.namedListRows} rows, but the `
              + 'ranking picked something else — point at the right one with list_extract\'s '
              + '`selector`, which pins it for the whole run.'
            : `this site's known list (${out.namedList}) IS NOT ON THE PAGE YET — it matched `
              + 'nothing, so whatever `chosen` names is furniture that painted first. Do not study '
              + 'or harvest off it. Wait for the real one: page_state path:"@await('
              + `${out.namedList} > * :: still)", then study again.`;
        }
        // LOW DISTINCTNESS, NOT ANY DISTINCTNESS — see `LOW_DISTINCTNESS` at the top of this file
        // for the measurement. A descriptor branch had been bolted on to silence the old `<= 1`
        // test for one site; with the comparison right, a named-fields site at LOW distinctness is
        // still worth the softer word.
        if (best && Number(best.rows) > DISTINCTNESS_MIN_ROWS && Number(best.distinctness) <= LOW_DISTINCTNESS) {
          const named = out?.siteNamesFields || [];
          if (named.length) {
            return `distinctness is ${best.distinctness}: most rows link to the same place. This site `
              + `has a descriptor that names the fields (${named.slice(0, 6).join(', ')}${named.length > 6 ? ', …' : ''}), `
              + 'so list_extract can still tell the rows apart; check its first rows before trusting the count.';
          }
          return `the best candidate has ${best.rows} rows that all resolve to the same place `
            + `(distinctness ${best.distinctness}). page_state path:"@dom(<css>)" on it returns what is really there; `
            + 'list_extract will not.';
        }
        if (!lists.length && !out?.error) {
          return 'no repeating structure at all. This page is not a list — page_state path:"@html(body :: 2)" to '
            + 'read its shape, then page_state path:"@dom(<css>)" for the part you want.';
        }
      }
    } catch (_) { /* never cost a caller their result over a hint */ }
    return null;
  };

  // WHAT THIS PAGE IS, ANSWERED ONE WAY WHATEVER DOOR ASKED IT.
  //
  // There used to be two answers to "is this even a list, and how big". `tab.here` waited for the
  // list to stop changing; this counted once, the instant it was asked. Measured live on one
  // shopee.co.id category page in one hidden tab, seconds apart:
  //
  //   tab_here({newTab:true})  -> lookAt   rowsOnPage: 8,  pagination, steps, no namedList
  //   tab_here({tabId})        -> settle   rowsOnPage: 60, namedList,  no pagination, no steps
  //
  // Sixty was the truth. Eight was the grid caught mid-paint — and an agent that opens with a new
  // tab sizes its whole plan on the first number it is given, which is exactly the failure the
  // guidance warns about: a partial answer is worse than an empty one, because zero is obviously
  // wrong and eight is not. The two replies did not even carry the same FIELDS, so nothing
  // downstream could compare them or notice they disagreed.
  //
  // So the count is no longer computed here at all: `settleForList` owns it, and this adds only
  // what it alone knows — how the list grows, how a record is read, whether a wall is up. Three of
  // the four doors read the old number. A fourth door added later inherits the right one.
  //
  // AND EVERY DOOR NOW SAYS WHAT STATE THE PAGE WAS IN. `page: {hidden, frames, settled, settleMs}`
  // is built here because this is where the first read of a page happens, and the first read is
  // the one a whole plan gets sized on. `navd` is the navigation's own verdict when this look
  // follows one — a load that ran out its cap is `settled:false`, not an arrival.
  const lookAt = async (tabId, { navd = null } = {}) => withVisibleTab(tabId, async (held) => {
    const began = Date.now();
    // Borrowed from the hold this call already has; see `netTrack`.
    const track = held ? netTrack(tabId) : null;
    try {
      // FIRST, because it also starts the mutation and resource counters the settle reads.
      const probe = await pageProbe(tabId, { scope: null }).catch(() => null);
      const [kind, got] = await Promise.all([
        runRows(tabId, { action: 'mapkind' }).catch(() => null),
        settleForList(tabId, track).catch(() => null),
      ]);
      const { settleVerdict = null, ...ready } = got || {};
      const wall = (!got || !ready.hasList)
        ? await runRows(tabId, { action: 'challenge' }).catch(() => null)
        : null;
      const st = (navd && !navd.loaded)
        ? { settled: false, settleMs: Date.now() - began + (navd.ms || 0),
          why: `the document had not finished loading after ${navd.ms}ms — this is a read of a page still arriving` }
        : { ...(settleVerdict || {}), settled: settleVerdict ? settleVerdict.settled !== false : true,
          settleMs: Date.now() - began };
      return lookReply(kind, got ? ready : null, wall, pageHeader(probe, st));
    } finally { if (track) track.close(); }
  });
  const lookReply = (kind, ready, wall, page) => ({
      // `namedList`, `rising` and the settle's own `tell` ride along, because a caller planning a
      // fan-out should be told "still climbing" by every door, not only by the one that happened
      // to take the longer path.
      ...(ready || {}),
      hasList: !!ready?.hasList,
      rowsOnPage: ready?.rowsOnPage || 0,
      site: ready?.site || kind?.map || '',
      // How the list grows and how a record is read decide what a run will COST, which is the
      // thing worth telling an agent before it starts one.
      pagination: kind?.grows || 'unknown',
      records: kind?.reads || '',
      steps: kind?.steps || 0,
      challenge: wall?.challenge ? (wall.kind || 'puzzle') : '',
      page,
  });

  // THE DOCUMENT BEING READY IS NOT THE APP BEING READY.
  //
  // `tab_here` already waits for the load event, and the note above that wait says why: handing back
  // the previous page's DOM reads as a successful extraction of the wrong thing. On a client-rendered
  // storefront the SAME failure happens one layer up — the document is complete, the app has not
  // painted, and `arrived: true` is returned over an empty page.
  //
  // MEASURED, on shopee.com.br, by an agent asked for 240 products:
  //
  //   tab_here   → arrived: true
  //   page_study → linksNow: 8, ONE list candidate, looksLikeFurniture: true, rows: 5   (the footer)
  //   harvest    → 4 rows of schema.org WebSite boilerplate, `$.items matched nothing`
  //
  // Eight links on a page that carries sixty products. Every later reading was taken of a page that
  // did not exist yet, and nothing in the run was wrong except its first timestamp. The same race is
  // what makes a page walk read a footer on one market and the grid on another — it is decided by
  // which paints first, not by anything about the sites.
  //
  // So the wait is extended to the thing the caller actually asked about. It exits the instant a list
  // appears, so a page that is ready pays one probe; only a page with nothing on it spends the budget,
  // and a page with genuinely no list (a product page, a JSON endpoint) is a real answer worth the
  // couple of seconds it costs to be sure of.
  const HYDRATE_MS = 3000;
  const HYDRATE_STEP_MS = 400;
  // How long a document this tool navigated to is given to finish loading. Unchanged — it is the
  // figure `waitForLoad` was always called with here — and deliberately above settle.js's 10 s
  // (Playwright's cap inside a browser it owns): this is the person's own connection and their
  // own signed-in session, and a marketplace on a slow link really does take longer than that.
  const NAV_MS = 25000;
  // NON-ZERO IS NOT READY, AND NEITHER IS "IT HELD STILL FOR A MOMENT".
  //
  // This took three attempts and the first two are recorded because each looked sufficient.
  //
  //   1. Exit on the first count above zero. On the fixture this returns FIVE — the footer, at
  //      233ms — which is exactly what shopee.com.br handed a real agent, and it is how a run
  //      concludes a storefront has five products.
  //   2. Exit when two consecutive polls agree. Better, and still wrong: the fixture paints 13
  //      rows, holds them for 1.1s, then paints the remaining 47. Two polls 400ms apart both see
  //      13, so it settles on the slice and reports it with total confidence. That agent's words
  //      were "the search grid only ever exposed 13-20 anchors per read" — it collected 27 of 240
  //      and, to its credit, refused to fan out over a list it did not trust.
  //
  // Stability cannot tell a finished list from a paused one; nothing observable can, inside the
  // pause. So the rule is asymmetric, because the two cases deserve different treatment:
  //
  //   a page that arrived WHOLE   — count never moved — is believed after one confirming poll.
  //   a page that GREW even once  — has proven it paints in pieces — spends the whole budget.
  //
  // The cost lands only where it is earned. The ordinary already-rendered page exits in about a
  // step; only a page that has demonstrated it is still building pays, and paying three seconds
  // once beats multiplying a wrong count by a lane count.
  //
  // `test/tab-here-settles.mjs` holds the fixture and the control run for all of this.
  //
  // THE COUNT RULE IS NOW THE SEMANTIC HALF OF THE SHARED `settle()`, NOT A LOOP OF ITS OWN.
  //
  // Everything above still holds and is still what decides — the asymmetric rule is handed to
  // `settle` as `expect`, the final word. What `settle` adds is the evidence the count cannot
  // carry: a number that "arrived whole" is only believed once the page has ALSO gone quiet
  // (requests finished, no nodes arriving). That is the hole recorded below — a first reading of
  // THREE, stable, on a page still fetching its grid — closed without a descriptor. And running
  // out of budget on a page still changing is `settled:false` in the reply's `page` header,
  // where it used to be indistinguishable from a page that finished.
  const settleForList = async (tabId, track = null) => {
    // A MEASURED SITE HAS A PRECISE PAINT SIGNAL, AND COUNTING IS THE CRUDE FALLBACK.
    //
    // The count rule below has one hole and a live run found it: this settle exits early when the
    // number "arrived whole" — never moved — which is meant to spare an already-rendered page the
    // full budget. On a shopee.co.id category page the first reading was THREE, stable, so it
    // exited at once and reported `hasList: true`. Those three were the filter panel. page_study
    // ran next, also early, and ranked `div.shopee-filter-panel` first with the product grid not
    // among its candidates at all; `list_extract` then returned eight rows of filter options with
    // columns like `/fieldset.shopee-filter-group/legend`. One `page_grow` immediately afterwards
    // showed 145 links. The grid was seconds away the whole time.
    //
    // Stability cannot tell a finished page from a page whose furniture finished first — that has
    // been the shape of every failure here. But a descriptor NAMES the list, so on a site that has
    // been measured there is no need to infer anything: wait for that selector's children to
    // appear and stop changing. `@await` already does exactly this, so the wait is the same
    // primitive a caller would use, not a private reimplementation of it.
    const site = await siteFor(tabId);
    // A RECORD PAGE IS NOT A LISTING PAGE THAT FAILED TO PAINT. `list` describes this site's
    // listing routes; on a product/profile/place permalink it will never match, so awaiting it
    // burns the whole hydrate budget and then reports `hasList: false` about a page that is fine.
    // Fall through to the generic count settle, which asks the page what IS there.
    if (site?.list && !site.onRecord) {
      const r = await runRows(tabId, {
        action: 'state', path: `@await(${site.list} > * :: still :: ${HYDRATE_MS})`,
      }).catch(() => null);
      const rows = Number(r?.matched) || 0;
      // The named condition did the waiting; this only asks, briefly and inside that list,
      // whether the page agrees it has stopped. `still` running out its budget is not settled.
      const verdict = async () => {
        const q = await settleBrief(tabId, { scope: site.list, net: track }).catch(() => null);
        if (r && !r.error && rows > 0 && !r.ok) {
          return { settled: false, why: `${site.list} was still gaining rows when the ${HYDRATE_MS}ms wait ran out` };
        }
        return q || { settled: true };
      };
      if (r && !r.error) {
        const settleVerdict = await verdict();
        // WHAT THE PAGE ITSELF SAYS, ASKED EVERY TIME, SO THE DESCRIPTOR CAN BE CAUGHT BEING WRONG.
        //
        // A descriptor is a hand-written claim about a site, and sites change underneath it. The
        // two ways it goes wrong are not equally dangerous:
        //
        //   the selector stops matching   the descriptor is ignored, the ranking takes over   SAFE
        //   it matches something ELSE     the descriptor wins, confidently, with bad rows      NOT
        //
        // The first was still being reported as "the page has not painted — read it again", which
        // an agent obeys forever: a stale selector would have told every run to keep waiting, for
        // as long as nobody re-verified the file. The second has never been checked at all.
        //
        // One comparison catches both, and it is nearly free because the generic detector is what
        // `container` already runs. `detect` in rows.js has always treated the named list this way
        // — `if (want)`, prefer it when it matches, ignore it when it does not — which is why the
        // side panel degrades on a redesign while this door lied. This brings the agent's door up
        // to the panel's standard rather than inventing anything.
        const generic = await runRows(tabId, { action: 'container', fresh: true }).catch(() => null);
        const gRows = (generic && !generic.error) ? (Number(generic.rows) || 0) : 0;

        // STALE. The named selector found nothing while the page plainly holds a list. Hand back
        // the generic answer — which is what the run should use — and SAY the descriptor missed,
        // because "no list here" and "our selector expired" need different responses from a human.
        if (rows === 0 && gRows > 0) {
          return {
            settleVerdict,
            hasList: true, rowsOnPage: gRows, site: site.id,
            namedList: site.list, namedListRows: 0, descriptorStale: true,
            tell: `this site's descriptor names ${site.list} and that selector matched NOTHING, `
              + `while the page's own structure holds ${gRows} rows. That is not an unpainted `
              + 'page — the descriptor is out of date for this route, or the site changed. The '
              + `${gRows} rows above come from the generic detector and are what a run should use. `
              + 'Worth reporting so the descriptor can be re-verified.',
          };
        }

        // DRIFTED, MAYBE. The selector still matches, but it is holding a small fraction of what
        // the page has — see `DRIFT_RATIO` / `DRIFT_MIN_GAP` at the top of this file. The verdict
        // is NOT changed on this evidence: the descriptor is right far more often than the
        // ranking. It is flagged, not overruled.
        const drifted = rows > 0 && gRows >= rows * DRIFT_RATIO && (gRows - rows) >= DRIFT_MIN_GAP;

        return {
          settleVerdict,
          hasList: rows > 0, rowsOnPage: rows,
          ...(drifted ? { descriptorMaybeDrifted: true, genericRowsOnPage: gRows,
            tell: `the descriptor's list (${site.list}) matched ${rows} rows while the page's own `
              + `structure holds ${gRows}. The descriptor usually wins and it is being trusted `
              + 'here, but that gap is the shape of a selector that has drifted onto a smaller '
              + 'element. Check page_study\'s candidates before a long run.' } : {}),
          // Said out loud, because "we waited for the thing this site is known to use" is a
          // different quality of answer from "a number stopped moving", and a caller planning a
          // fan-out should be able to tell them apart.
          namedList: site.list, site: site.id,
          // REACHED ONLY WHEN BOTH LOOKED AND BOTH FOUND NOTHING. The stale branch above already
          // took the case where the descriptor missed but the page had rows, so this is no longer
          // "our selector might be old" — it is two independent readings agreeing the page holds
          // no list yet. That is much stronger evidence, and the wording should not keep hedging
          // as though only one thing had been checked.
          ...(rows > 0 ? {} : {
            tell: `the list this site is known for (${site.list}) never appeared within `
              + `${HYDRATE_MS}ms, AND the generic detector found no repeating structure either. `
              + 'Two readings agree there is nothing here YET. That is still not "no list here": '
              + 'on a client-rendered page it usually means nothing has painted, or this route '
              + 'does not carry the grid. Do not study or harvest off it; read it again, or watch '
              + 'what the page fetches with `network`.',
          }),
          ...(rows > 0 && !r.ok ? {
            rising: true,
            tell: `${rows} rows and still climbing when the wait ran out — a FLOOR, not the total.`,
          } : {}),
        };
      }
    }
    let boxSel = '';
    const probe = async () => {
      const box = await runRows(tabId, { action: 'container', fresh: true }).catch(() => null);
      boxSel = box && !box.error ? String(box.selector || '') : '';
      return box && !box.error ? (box.rows || 0) : 0;
    };
    // The rule, stated once, as the thing `settle` asks on every step:
    //   a count that has NEVER moved and has been read twice, a step apart,
    //     on a page whose DOM has been still for TWO steps                 -> believed
    //   a count that grew even once                                        -> never believed early;
    //                                                                         it spends the budget
    //
    // THE SECOND LINE OF THE FIRST RULE IS NOT DECORATION. A stable count is only evidence when
    // the page has had time to contradict it, and "two reads a step apart" used to get that time
    // by accident: `waitForLoad` polled every 120 ms, so the first read landed at least that long
    // after `complete` and the second fell past the moment a script-painted grid first mounts.
    // `armNav` resolves on the event itself, and with both reads before that moment
    // `test/tab-here-settles.mjs` — footer of 5 from the first byte, 13 cards at 500 ms, 60 at
    // 1,600 ms — answered `rowsOnPage: 5, settled` in 590 ms where the old code answered 60. The
    // footer is the confident wrong list that file exists for, so the accident is made a rule:
    // the region has to have been quiet (no nodes arriving) for HYDRATE_STEP_MS x 2 by the page's
    // own account before an unmoved count is taken as the total. A page that paints from a timer
    // breaks that quiet before the count can be believed, and the growth then forfeits the early
    // answer on its own. Cost: a page that really arrived whole answers at ~800 ms instead of
    // ~400 ms, once per navigation — not per poll and not per harvest page.
    let rows = 0;
    let startedWith = null;
    let grew = false;
    let lastGrowth = 0;
    let firstAt = 0;
    const rule = async ({ snap } = {}) => {
      const now = await probe();
      if (startedWith === null) { startedWith = now; rows = now; firstAt = Date.now(); return { ok: false }; }
      if (now > rows) { grew = true; lastGrowth = Date.now(); }
      if (now !== rows) rows = now;
      const stillFor = Number(snap?.domStillMs) || 0;
      return { ok: !grew && rows > 0 && rows === startedWith && Date.now() - firstAt >= HYDRATE_STEP_MS - 50
          && stillFor >= HYDRATE_STEP_MS * 2,
        scope: boxSel };
    };
    const settleVerdict = await settle(tabId, {
      scope: null, net: track, expect: rule, expectEveryMs: HYDRATE_STEP_MS,
      // A quiet page with no list is given the whole budget before "no list" is believed, exactly
      // as before — unless it cannot run script at all, in which case nothing is coming.
      patienceMs: HYDRATE_MS, ceilingMs: HYDRATE_MS,
      // Three steps of the count rule. Long enough that a grid mounting beside the first thing
      // detected has moved the count (and so forfeited the early answer by itself); short enough
      // that a page with a carousel on it does not pay the whole budget for having one.
      narrowAfterMs: HYDRATE_STEP_MS * 3,
    }).catch(() => ({ settled: true }));
    if (startedWith === null) rows = await probe();
    const rising = rows > 0 && lastGrowth && Date.now() - lastGrowth < HYDRATE_STEP_MS * 2;
    return {
      settleVerdict: rising
        ? { settled: false, why: `the list was still gaining rows when the ${HYDRATE_MS}ms wait ran out (${rows} so far)` }
        : settleVerdict,
      hasList: rows > 0,
      rowsOnPage: rows,
      // Growth in the last stretch of the budget means the page was very likely still going when
      // time ran out, so the number is a floor. Silence otherwise — a flag on every reply is a
      // flag nobody reads.
      ...(rising ? {
        rising: true,
        tell: `${rows} rows and still climbing when the wait ran out — a FLOOR, not the total. `
          + 'Read it again before sizing anything off it.',
      } : {}),
    };
  };

  // THE TAB EXISTS — NOTHING ABOUT WHERE IT CURRENTLY IS.
  //
  // `needTab` gates on the tab's CURRENT url because every READ has to: consent is per-origin and
  // the origin in question is the one being read. Navigating is the opposite case — the current
  // page is not being touched, it is being left — so gating on it refuses the one thing the tool
  // exists to do. Measured: a session's active tab was a new-tab page, `tab_here` answered "that is
  // not a URL we can open" (about the SOURCE, though it reads as if about the destination), and the
  // run abandoned the whole navigate-and-capture path on the case it was built for.
  //
  // The destination is still checked, by `allows(url)` in the op itself. That is the check that
  // matters: it is where the reading will happen.
  // A MISSING tabId MUST NOT LEAK CHROME'S OWN SIGNATURE ERROR.
  //
  // `chrome.tabs.get(undefined)` throws SYNCHRONOUSLY — an argument-validation error, not a rejected
  // promise — so the `.catch()` below never sees it and the caller got this, verbatim, from a real
  // run: "Error in invocation of tabs.get(integer tabId, optional function callback): No matching
  // signature." That names an internal API the caller cannot act on, instead of the one thing they
  // needed to hear: which argument was missing and where to get it.
  const wantTabId = (tabId) => {
    if (!Number.isInteger(tabId)) {
      throw new Error('this needs a tabId and none was given. current_page returns the tab the '
        + 'person is looking at; tabs_list names every open one. Pass that number back in.');
    }
    return tabId;
  };

  const haveTab = async (tabId) => {
    const t = await chrome.tabs.get(wantTabId(tabId)).catch(() => null);
    if (!t) throw new Error(`there is no tab ${tabId} — call tabs_list or current_page again`);
    return t;
  };

  // A TAB WITH NOTHING ON IT IS SOMEWHERE TO GO, AND REFUSING IT COSTS THE WHOLE OPENING.
  //
  // Measured 2026-09-22, a fresh agent's first three calls, on a browser whose active tab was a
  // new-tab page: `tab_here {url}` -> "this needs a tabId"; `current_page` -> that tab, with
  // `url: ""` and a hint reading "tab_here to point it at a URL"; `tab_here {url}` -> the same
  // refusal. Both replies were true and neither was usable — the hint named the tool without
  // saying to pass the number back, and `tab_here`'s own schema requires only `url`, so the call
  // was refused for omitting something optional.
  //
  // So: with no tabId, a blank tab is used (there is nothing on it to lose), and a tab holding a
  // real page is still never navigated behind the person's back — but that refusal now carries the
  // id, so the next call is right instead of being another guess. Our own connection window is
  // never offered: its socket is what every agent session is talking through.
  const isBlankTab = (u) => !u
    || /^(about:blank|about:newtab|chrome:\/\/(newtab|new-tab-page)\/?|edge:\/\/newtab\/?)$/i.test(u);

  const tabToPoint = async (tabId) => {
    if (Number.isInteger(tabId)) return haveTab(tabId);
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active && !isOurPage(active.url) && isBlankTab(active.url)) return active;
    const where = active && !isOurPage(active.url)
      ? `the tab in front (${active.id}) is on ${(active.url || '').slice(0, URL_GLIMPSE_CHARS)} and taking it `
        + 'would move the person off the page they are reading. '
        + `Either tab_here {tabId: ${active.id}, url} to use it anyway, or `
      : 'no blank tab is in front, so ';
    throw new Error(`${where}tab_here {url, newTab: true} to open one of your own `
      + '(nothing else will close it — close it yourself when the pass ends). '
      + 'tabs_list names every open tab if you meant a particular one.');
  };

  // OUR OWN PAGES ARE NOT SCRAPING TARGETS, AND ONE OF THEM IS THE CONNECTION ITSELF.
  //
  // The connection window is an ordinary Chrome window holding `bridge-window.html`, and the socket
  // to every MCP server lives INSIDE it (see the note at the top of that file — it is a window
  // precisely because a window is not evicted). Navigate that tab away and the page is destroyed
  // with its sockets: the agent that issued the call cuts its own line mid-sentence, every OTHER
  // live session loses the browser at the same moment, and what they all see afterwards is
  // "No browser connected" — the error whose documented fix is to reload the extension, which is
  // not what went wrong and does not explain it.
  //
  // It reaches an agent through `current_page`, not through `tabs_list`: that one already filters
  // to http(s), but the connection window is a real window, so the moment it is the last focused
  // one `query({active:true, lastFocusedWindow:true})` returns ITS tab. The agent then quite
  // reasonably points `tab_here` at the tab it was just handed.
  //
  // Guarded at BOTH ends on purpose — `current_page` stops offering it, and `tab.here` refuses it
  // even when the id arrives from somewhere else.
  // WHICH DESCRIPTOR GOVERNS A TAB. Shared by the readiness wait and the study hint, because both
  // are asking the same question — "does this site have a measured list, and is it here yet?"
  const siteFor = async (tabId) => {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    const url = t?.url || '';
    let host = '';
    try { host = new URL(url).hostname; } catch (_) { host = ''; }
    if (!host) return null;
    const found = (descriptors || []).find((x) => {
      try { return x.host && new RegExp(x.host).test(host); } catch (_) { return false; }
    }) || null;
    if (!found) return null;
    // Copied, never mutated — descriptors are module-level singletons shared by every tab.
    const pageKind = pageKindFor(found, url);
    return { ...found, pageKind, onRecord: pageKind === 'record' };
  };

  const OUR_PAGES = chrome.runtime.getURL('');
  const isOurPage = (u) => !!u && String(u).startsWith(OUR_PAGES);

  // WHAT THIS TAB HAS ALREADY HAD DONE TO IT.
  //
  // The engine has always KEPT this — `window[S]` holds the candidates, the chosen index and the
  // pin; `pinnedFor` holds the pinned selector; `runs` holds what is in flight — and has never
  // TOLD anyone. Every reply answered as though the tab had no history, so each caller rediscovered
  // it. Measured in one session: an agent read 14 links and planned against them because nothing
  // said the page had not been grown; `page_harvest` was called five times because nothing said a
  // run was already going; and four sibling agents each re-derived the same product-page facts,
  // which their coordinator then pasted into four prompts by hand.
  //
  // STAMPED AND INVALIDATED ON NAVIGATION, WHICH IS THE WHOLE DESIGN CONSTRAINT. This session was
  // one long lesson in tools stating things confidently that were no longer true — `arrived: true`
  // on an unpainted page, `total: 14` on a page holding 54, `failedCount: 0` over four junk rows,
  // `stopping: true` on a run that kept going. A remembered "you already grew this" that outlived
  // the page would be the same bug wearing a helpful face, and worse than saying nothing, because
  // it suppresses the re-check that would have caught it. So every entry records the URL it was
  // true of, and is dropped the moment the tab goes somewhere else.
  const seen = new Map();   // tabId -> { url, grownAt, grewTo, grewSettled, runId, netFilter }
  const markSeen = (tabId, url, patch) => {
    if (!tabId) return;
    const prev = seen.get(tabId);
    const base = prev && prev.url === url ? prev : { url };
    seen.set(tabId, { ...base, url, ...patch });
  };
  const forgetSeen = (tabId) => { if (tabId) seen.delete(tabId); };
  const knownFor = (tabId, url) => {
    const k = seen.get(tabId);
    const out = {};
    if (k && k.url === url) {
      if (k.grownAt) {
        out.grown = { rows: k.grewTo, settled: !!k.grewSettled,
          secondsAgo: Math.round((Date.now() - k.grownAt) / 1000) };
      }
      if (k.netFilter) out.watchingNetwork = k.netFilter;
    }
    const pin = pinnedFor.get(tabId);
    if (pin) out.pinnedList = pin;
    const live = [...runs.values()].find((r) => !r.done && r.tabId === tabId);
    if (live) out.runInFlight = live.id;
    return Object.keys(out).length ? { known: out } : {};
  };

  const needTab = async (tabId) => {
    const t = await chrome.tabs.get(wantTabId(tabId)).catch(() => null);
    if (!t) throw new Error(`there is no tab ${tabId} — call tabs_list or current_page again`);
    const ok = await allows(t.url || '');
    if (!ok.ok) throw new Error(ok.why);
    if (restrictedHost(t.url || '')) throw new Error('that page is off limits');
    return t;
  };

  // THE PAGE HEADER FOR AN OP THAT DID NOT NAVIGATE. `scope: null` keeps whatever region the
  // watcher is already bound to — re-binding would throw away the history that lets a second
  // look answer instantly. `st` is the op's own settle verdict when it took one.
  const headerFor = async (tabId, st) => {
    const probe = await pageProbe(tabId, { scope: null }).catch(() => null);
    return pageHeader(probe, st || (probe ? await settle(tabId, { scope: null, ceilingMs: 0 }).catch(() => null) : null));
  };

  const TABLE = {
    // --- reaching a page -------------------------------------------------------------------
    // THE ENTRY POINT, and it takes no arguments on purpose. "I have a page open — scrape it" is
    // how people actually say it, and making the agent list tabs and pick one first turns a
    // sentence into a negotiation.
    //
    // The pinned tab wins over the focused one, because focus is NOT a selection. A person typing
    // into their terminal has left Chrome entirely, and if they alt-tabbed on the way the focused
    // tab is wherever they happened to land. `lastFocusedWindow` narrows it to the last Chrome
    // window rather than the last window of any application; the pin makes it deliberate.
    'current.page': async () => {
      const pin = await pinnedTab();
      let t = pin || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      // Focus lands on the connection window whenever it opens or is clicked, and "the page the
      // person is looking at" is never that. Fall back to the newest real page instead of handing
      // back something that must not be navigated.
      if (t && isOurPage(t.url)) {
        const real = (await chrome.tabs.query({})).filter((x) => /^https?:/i.test(x.url || ''));
        t = real.find((x) => x.active) || real[real.length - 1] || null;
      }
      if (!t) throw new Error('no browser window is open');
      const ok = await allows(t.url || '');
      const brief = { ...tabBrief(t), pinned: !!pin };
      if (!ok.ok) return { ...brief, allowed: false, why: ok.why };
      return { ...brief, allowed: true, ...(await lookAt(t.id)), ...knownFor(t.id, t.url || '') };
    },

    'tabs.list': async () => {
      const tabs = await chrome.tabs.query({});
      const pin = await pinnedTab();
      return {
        pinned: pin ? pin.id : null,
        tabs: tabs.filter((t) => /^https?:/i.test(t.url || '')).map(tabBrief),
      };
    },

    'tab.open': async ({ url, active = false }) => {
      const ok = await allows(url);
      if (!ok.ok) throw new Error(ok.why);
      const t = await chrome.tabs.create({ url, active });
      const navd = await armNav(t.id).wait({ certain: true, created: true, capMs: NAV_MS });
      const now = await chrome.tabs.get(t.id).catch(() => t);
      return { ...tabBrief(now), ...(await lookAt(t.id, { navd })) };
    },

    // "SCRAPE GOOGLE MAPS FOR RESTAURANTS IN CIMAHI" — a goal, not a page. Built from the
    // provider's own `searchFor` template rather than from the agent's idea of a URL, because an
    // agent asked to construct one will guess, and guess differently every time.
    //
    // AND IT REFUSES RATHER THAN GUESSES when a provider needs more than a phrase. 2GIS puts the
    // city in the PATH and splits its data across country TLDs — `2gis.kz` has never heard of a
    // Czech city — so a missing `city` there is not a detail to default, it is a different
    // country's database. Maps needs neither: the whole phrase goes in the query.
    'search.open': async ({ source, query, active = false, ...rest }) => {
      const d = (descriptors || []).find((x) => x.id === source);
      if (!d) {
        const known = (descriptors || []).filter((x) => x.searchFor).map((x) => x.id).join(', ');
        throw new Error(`unknown source "${source}" — this browser can search: ${known}`);
      }
      if (!d.searchFor) throw new Error(`"${source}" cannot be searched from a phrase; open a URL with tab_here newTab:true`);
      const q = String(query || '').trim();
      if (!q) throw new Error('query is empty');
      const missing = (d.searchNeeds || []).filter((k) => !rest[k]);
      if (missing.length) {
        throw new Error(`"${source}" also needs ${missing.join(' and ')} — `
          + 'its city is part of the path and its data is split by country, so neither can be guessed. '
          + 'Ask the person which one they mean.');
      }
      let url = d.searchFor.replace('{query}', encodeURIComponent(q));
      for (const k of (d.searchNeeds || [])) {
        url = url.replace(`{${k}}`, encodeURIComponent(String(rest[k])));
      }
      const ok = await allows(url);
      if (!ok.ok) throw new Error(ok.why);
      const t = await chrome.tabs.create({ url, active });
      const navd = await armNav(t.id).wait({ certain: true, created: true, capMs: NAV_MS });
      const now = await chrome.tabs.get(t.id).catch(() => t);
      return { ...tabBrief(now), ...(await lookAt(t.id, { navd })) };
    },

    // EVERY CANDIDATE, WITH ITS EVIDENCE — the op behind `page_study`.
    //
    // `site.probe` answers 'is there a list' with one verdict, and one verdict is exactly what the
    // 1000-site audit showed to be the failure: Apple's search page yields its footer directory and
    // Adobe's yields its filter sidebar, both as confident single answers. A model on the other end of
    // this socket can weigh five candidates against each other; the engine, having to choose alone,
    // cannot. So this returns the ranking and the numbers behind it and lets the caller pick.
    'page.study': async ({ tabId }) => {
      const t = await needTab(tabId);
      // A STUDY TAKEN EARLY RANKS THE FURNITURE. The measured case is in the MCP doctrine: one
      // list, `looksLikeFurniture:true`, 5 rows — the footer, because the grid had not mounted.
      // So it looks (briefly, and for nothing at all when the page has been still since the last
      // look) before it reads, and the reply says which kind of page it read.
      const pre = await settleBrief(tabId, { scope: null }).catch(() => null);
      const out = await runRows(tabId, { action: 'study' });
      // WHICH KIND OF PAGE THIS IS, DECIDED HERE RATHER THAN GUESSED BY THE READER. The engine
      // reports whether the site's named list matched; only the bridge knows whether it was ever
      // supposed to. Merged in before the hint is written, because the hint's worst branch turns
      // on exactly this distinction.
      const site = await siteFor(tabId);
      const withKind = { ...out, ...(site?.pageKind ? { pageKind: site.pageKind } : {}) };
      const hint = browserHint('study', withKind, t);
      return { tabId, ...tabBrief(t), ...withKind, ...(hint ? { hint } : {}), page: await headerFor(tabId, pre) };
    },

    // A SEPARATE VERB BECAUSE IT CHANGES THE PAGE. Pressing a control or scrolling to the bottom is an
    // action, not an observation, and a tool that did it silently while claiming to describe the page
    // would be the same class of mistake as reporting a row count without saying it came from one
    // visit. The reply is a before/after count, so 'it loads more' is measured rather than inferred
    // from a word on a button.
    //
    // The selector may name a CONTROL to press or a scrollable CONTAINER to scroll — the engine
    // tells them apart (see `studypress` in rows.js), and a container-targeted grow reports row
    // counts inside that container beside the page-wide link count, because a list whose rows
    // carry no links reports zero record links forever and would otherwise read as never growing.
    'page.grow': async ({ tabId, selector = '', scroll = false, waitMs = GROW_WAIT_DEFAULT_MS, direction, hops,
      collect = '', network = '', rows = null, limit, dry }) => {
      await needTab(tabId);
      // FEED MODE — the same loop as `collect`, reading the API instead of the DOM. A scroll fires
      // one request, that request carries the items, and no-new-items is the site telling you the
      // list has ended. Better than reading the DOM per step for the two cases that break it: a
      // virtualized list holds only a screenful, and a reply budget caps what a read can return.
      if (network) {
        if (!rows?.at) throw new Error('feed mode needs rows.at — a $. path to the array of items '
          + 'inside the response. Run tab_here({network:"*"}) on this page first: it prints the '
          + 'paths, and the array is the one whose length matches a page of results.');
        // NO ROW SELECTOR IS THE NORMAL CASE HERE. `collect` names rows for the DOM half if the
        // caller wants one; `selector` alone is the pane to scroll. Without either, the window is
        // scrolled and every row comes from the responses.
        return growFeed({ tabId, network: String(network), rows,
          selector: String(collect || ''), pane: String(selector || ''),
          waitMs, hops, limit, dry, direction });
      }
      // HARVEST MODE. `collect` names the ROWS; `selector` stays the pane to move. A recycling list
      // has to be read at every step or the rows are gone by the end — see `collectRows` in rows.js
      // for the measurement that forced this. Deliberately a mode of grow rather than a new tool:
      // grow's job is "move this list and report what changed", and on a recycler the only honest
      // report of what changed IS the rows.
      if (collect) {
        return withVisibleTab(tabId, () => runRows(tabId, {
          action: 'collect', selector: String(collect), pane: String(selector || ''),
          direction, hops, waitMs, limit, dry,
        }));
      }
      if (!selector && !scroll) {
        // THE MOMENT OF NEED IS THE MOMENT TO NAME THE VERB.
        //
        // A session hit this exact error while trying to re-sort a review widget, and the message
        // listed press / scroll / scroll:true and did not contain the word `choose` even once. It
        // then pressed the <select>, got nothing, and concluded the control was decoration. The
        // caller asked the tool what it could do at precisely the right moment; the tool left out
        // the answer.
        throw new Error('pass a selector — a control from page_study growth.candidates to press, '
          + 'or a scrollable container from lists[].selector with scroll:true — or scroll:true '
          + 'alone for the window. If what you want is behind a DROPDOWN rather than a button, a '
          + 'press cannot reach it: use mode:"walk" with choose:"<the option\'s words>", which '
          + 'finds the <select> by its option and fires a real selection.');
      }
      // A LAZY LIST NEEDS THE TAB TO BELIEVE IT IS VISIBLE, or the observer that fetches the next
      // batch never runs and grew:false is an answer about Chrome, not about the site.
      return withVisibleTab(tabId, (visible) => runRows(tabId, {
        action: 'studypress', selector, scroll: !!scroll, waitMs, direction, hops,
      }).then(async (r) => {
        if (!r || typeof r !== 'object') return r;
        // RECORDED SO THE NEXT TOOL DOES NOT HAVE TO ASK. `grew:false` is the only signal that a
        // count has stopped moving, and until now it lived in one reply and then vanished — so a
        // later page_study or harvest could not tell a settled page from an unexplored one.
        const t = await chrome.tabs.get(tabId).catch(() => null);
        markSeen(tabId, t?.url || '', {
          grownAt: Date.now(),
          grewTo: Number(r.recordLinksAfter) || 0,
          grewSettled: r.grew === false,
        });
        return { ...r, visible };
      }));
    },
    // POINT AN EXISTING TAB SOMEWHERE ELSE. The missing primitive, and its absence shaped every
    // hard job today.
    //
    // Without it there were two ways to reach N pages and both were wrong. `tab_open` makes a tab
    // per destination, and nothing closes them — 250 films means 250 tabs the person clears by
    // hand. `page_walk` presses a link instead, which works beautifully on an SPA and CANNOT work
    // anywhere else: the walk loop runs INSIDE the page, so a real document navigation destroys the
    // frame mid-call and the op dies reporting `Frame with ID 0 was removed`. Measured twice today,
    // by two agents independently, on IMDb and on Stack Overflow. The tab lands correctly every
    // time; only the answer is lost.
    //
    // This runs in the service worker, which no navigation can tear down, so it survives exactly
    // what kills the walk. One tab, many destinations, nothing left behind.
    // FOLLOW A LIST INTO ITS RECORDS, AND KEEP THE ROWS HERE.
    //
    // Consent is checked PER ORIGIN, ONCE, BEFORE ANYTHING OPENS. A harvest can cross hosts — a
    // marketplace's listings sit on other people's domains — and asking after 40 pages are already
    // read is asking about something that has happened. The origins are collected from the resolved
    // queue, so a refusal costs one page load rather than the run.
    'page.harvest': async (args) => {
      // RETRY WHAT FAILED, NOT THE WHOLE QUEUE.
      //
      // A harvest reports `failedCount` and twenty example urls and then has no follow-up. The only
      // way to recover ten failures out of 625 was to run all 625 again and merge the two passes by
      // hand — which is what happened, and it is also the pattern that puts every row through the
      // model. `retryOf` takes the failures off the run record and harvests exactly those.
      //
      // A thin page is TRANSIENT far more often than it is a bad page: the same measured run read
      // 529 of 625 on the first pass and 563 on the second, with only 10 failing BOTH times. So a
      // retry is not an apology for a broken site, it is the cheap half of the work.
      if (args?.retryOf) {
        const prev = runs.get(String(args.retryOf));
        if (!prev) throw new Error(`no such run: ${args.retryOf}`);
        if (!prev.done) {
          throw new Error(`${args.retryOf} is still running — poll it with results action:"status" `
            + 'and retry once it has finished, or stop it first.');
        }
        const again = (prev.failedUrls || []).filter((u) => /^https?:/.test(String(u)));
        if (!again.length) {
          return { retryOf: String(args.retryOf), of: 0, nothingToRetry: true,
            tell: 'that run recorded no failed urls, so there is nothing to retry.' };
        }
        args = { ...args, urls: again, links: '', retryOf: undefined };
      }
      const { tabId, urls = [], links = '', limit = 0 } = args || {};
      // A SITE THAT HAS BEEN MEASURED SHOULD NOT BE RE-DERIVED ON EVERY DETAILS PASS.
      //
      // `page_harvest` held ZERO references to the descriptor table, so every run over a known
      // site started from nothing. Measured: a pass over 120 shopee.co.id products navigated a
      // tab per product and waited four seconds for hydration — 15-20s each, most of an hour,
      // finished 48 — to read a description that ships in `<head>` in the FIRST packet, in a
      // schema.org block the ld+json tier already knows how to find. Four sibling agents each
      // rediscovered that independently, and the coordinator had to paste the finding into four
      // prompts by hand. All of it was already written down in `provider-shopee`.
      //
      // The descriptor fills only what the CALLER DID NOT NAME. An explicit `record` or `rows`
      // always wins: a measurement is a better default than a guess and still only a default,
      // exactly as `detect`'s named-list rule works. `usedDescriptor` goes back in the reply so a
      // spec that arrived from a file rather than from the call is visible rather than magic.
      let fromSite = null;
      if (!args?.record && !args?.rows && tabId) {
        const t0 = await chrome.tabs.get(tabId).catch(() => null);
        const host = (() => { try { return new URL(t0?.url || '').hostname; } catch (_) { return ''; } })();
        const d = host && (descriptors || []).find((x) => {
          try { return x.host && new RegExp(x.host).test(host); } catch (_) { return false; }
        });
        if (d?.record?.fields) {
          fromSite = { id: d.id, tier: d.record.tier || '', fields: Object.keys(d.record.fields) };
          args = { ...args, record: { ...d.record.fields },
            ...(d.record.tier && !args.tier ? { tier: d.record.tier } : {}) };
        }
      }
      // Resolve first so the origins being consented to are the ones that will actually be visited.
      // RESOLVED HERE, NOT INSIDE THE HARVEST. Two things depend on knowing the addresses before
      // anything opens, and both were broken while `links` was left for the driver to expand:
      //   - CONSENT. The loop below asks per origin, over `queue`. With `links` the queue was empty
      //     at that point, so it asked about nothing and the harvest went ahead unconsented.
      //   - The page count. A run that cannot say how many pages it is about to do cannot report a
      //     percentage, which is the whole reason `background` exists.
      let queue = (urls || []).filter((u) => /^https?:/.test(String(u)));
      // NO SELECTOR? ASK THE ENGINE WHICH LIST THIS IS.
      //
      // Requiring a hand-written `links` selector is how a caller ends up pasting a BUILD-HASHED
      // class — `div.css-rjanld` — copied off another page of the same site. Measured, and it cost
      // an hour: that class named something else on the next search, matched ten elements, and the
      // run reported "this site caps at 10" when the page held 180. The ranked list is exactly what
      // page_study computes, on any site, with no names in it; use that when the caller has not
      // named one, and SAY which selector was used so a wrong guess is visible rather than silent.
      let via = '';
      if (!queue.length && !links) {
        const st = await runRows(tabId, { action: 'study' }).catch(() => null);
        const best = (st?.lists || []).find((l) => l.chosen) || (st?.lists || [])[0];
        if (best?.selector) {
          via = `${best.selector} a[href]`;
          queue = await harvestLinks(tabId, via).catch(() => []);
        }
      }
      if (!queue.length && links) {
        if (!tabId) throw new Error('links needs a tabId — the page whose links you mean');
        await needTab(tabId);
        queue = await harvestLinks(tabId, String(links)).catch(() => []);
        if (!queue.length) throw new Error(`no links matched "${links}" on that page`);
      }
      // NEVER A SILENT CAP — the rule this file already applies to row groups, applied to the QUEUE.
      // Measured on a live run: `links` matched 85 products, `limit: 40` was carried over from an
      // unrelated reply-size fix on a page_state read, and the harvest reported `of: 40` / `pages:
      // 40` with nothing anywhere saying 45 products had been skipped. The output read as a
      // complete answer about the search. `matched` travels into the harvest so both the blocking
      // and the background reply carry it.
      const matched = queue.length;
      // A CAP IS A FOLD, NOT AN ENDING. Reporting what a limit dropped was half the fix: the run
      // still stopped, and a caller who wanted the whole list had no way to ask for the rest
      // without re-resolving the links and hoping the page still held them in the same order.
      // `from` makes the queue resumable — same links, next slice — so 85 in folds of 40 is two
      // calls that between them cover everything, rather than 40 presented as the answer.
      const start = Math.max(0, Number(args?.from) || 0);
      if (start || limit > 0) queue = queue.slice(start, limit > 0 ? start + limit : undefined);
      for (const origin of new Set(queue.map((u) => { try { return new URL(u).origin; } catch (_) { return ''; } }).filter(Boolean))) {
        const ok = await allows(origin);
        if (!ok.ok) throw new Error(ok.why);
      }
      // BLOCKING IS FINE FOR TWENTY PAGES AND FRIGHTENING FOR TWO HUNDRED.
      //
      // A harvest is minutes by design, and for all of them the caller has nothing to say — no
      // count, no percentage, not even "it is still going". A person watching that cannot tell a
      // working run from a hung one, and neither can the agent: the same silence produced "is this
      // stuck?" three times in one afternoon. `list.extract` solved this already — it starts the
      // work, returns a handle, and answers through run.status. This is the same shape, offered
      // rather than imposed, so every existing caller keeps the reply it expects.
      if (!args?.background) {
        const out = await harvest({ ...args, urls: queue, matched, from: start });
        const named = fromSite ? { usedDescriptor: fromSite } : {};
        return via ? { ...out, ...named, linksVia: via } : { ...out, ...named };
      }
      // EVERY BACKGROUNDED HARVEST OPENS LANES, AND NOTHING USED TO COUNT THEM TOGETHER.
      //
      // Each call started a run and returned immediately, so a caller that did not realise its
      // first call had taken could simply call again. Measured, with five agents coordinating on
      // one browser: run_7 through run_11 were started within a couple of minutes, every one of
      // them a 24-page harvest with its own lanes, and the person watching counted 23 tabs when
      // they had asked for five. Worse, each agent then polled `results` and saw a DIFFERENT run's
      // progress — 4/24, then 3/24, then 8/24 — which reads as a run going backwards.
      //
      // The ceiling is on LANES ACROSS ALL LIVE RUNS rather than on the number of runs, because
      // lanes are what become tabs and because five parallel batches is a reasonable thing to ask
      // for. It is the same five this project already measured as the point where lanes stop
      // helping (see `LANES` in background.js, and the note in the tool description): past it, a
      // run is slower AND returns thinner pages, so the cap costs nothing that was worth having.
      //
      // The refusal names the live runs and their progress, because the useful next move is
      // almost always to poll or stop one of them rather than to start another.
      const LANE_CEILING = 5;
      const live = [...runs.values()].filter((r) => r.kind === 'harvest' && !r.done);
      const inFlight = live.reduce((n, r) => n + (r.lanes || 1), 0);
      const want = Math.max(1, Math.min(LANE_CEILING, Number(args?.lanes) > 0 ? Number(args.lanes) : LANE_DEFAULT));
      if (inFlight + want > LANE_CEILING) {
        const naming = live.map((r) => `${r.id} (${r.lanes || 1} lane(s), `
          + `${r.prog?.done || 0}/${r.prog?.of || '?'} pages)`).join(', ');
        throw new Error(`${inFlight} lane(s) are already open across ${live.length} running `
          + `harvest(s) — ${naming} — and this call asks for ${want} more, over the ceiling of `
          + `${LANE_CEILING}. Lanes become BROWSER TABS in the person's own window, and past five `
          + 'they stop making a run faster anyway. Poll one of those runs with results '
          + 'action:"status", or stop one with action:"stop", before starting another. If you '
          + 'meant to split work across agents, give each one FEWER lanes so the total stays '
          + 'within the ceiling.');
      }
      const id = `run_${++runSeq}`;
      const rec = { id, kind: 'harvest', tabId: tabId || 0, startedAt: Date.now(), lanes: want,
        done: false, out: null, error: '', prog: { done: 0, of: queue.length, rows: 0, failed: 0 } };
      runs.set(id, rec);
      harvest({ ...args, urls: queue, matched, from: start, onTick: (p) => { rec.prog = p; },
        shouldStop: () => !!rec.stopped })
        .then((out) => {
          if (out?.error) rec.error = out.error; else rec.out = out;
          // HELD FOR A RETRY, NOT RETURNED. `failedAll` can be hundreds of urls and a reply is the
          // wrong place for them; the run record is the right one, because that is what a retry
          // asks. Stripped from `out` so the caller still sees the capped twenty.
          if (out && Array.isArray(out.failedAll)) {
            rec.failedUrls = out.failedAll.slice();
            delete out.failedAll;
          }
          rec.done = true;
        })
        .catch((e) => { rec.error = String(e?.message || e); rec.done = true; });
      return { runId: id, of: queue.length, state: 'running', ...(via ? { linksVia: via } : {}),
        ...(fromSite ? { usedDescriptor: fromSite } : {}),
        watch: 'call run_status with this runId — it reports pagesDone, percent, rowsSoFar and an eta' };
    },

    'tab.here': async ({ tabId, url, network: netFilter = '', close = false }) => {
      // EVERY LINE BELOW USES `t.id`, NOT THE `tabId` ARGUMENT. They were the same thing until a
      // missing tabId became legal (see `tabToPoint`): the op then navigated the right tab and
      // re-read `chrome.tabs.get(undefined)`, which throws SYNCHRONOUSLY, so the caller got
      // "No matching signature" about a navigation that had actually just worked.
      // Closing still demands an explicit tab: a navigation can be undone by navigating back, and
      // a closed tab cannot be reopened with what was in it.
      const t = close ? await haveTab(tabId) : await tabToPoint(tabId);
      // CLOSING IS PART OF OWNING A TAB, AND NOTHING COULD DO IT.
      //
      // A run that opens lanes leaves them behind, and a stopped run leaves them behind too. There
      // was no op that closed anything, so an agent that had opened tabs could only apologise:
      // measured, one session left 23 tabs across a person's window and said, correctly, that the
      // toolset exposed no way to tidy up. `newTab: true` has always been available; its opposite
      // has not.
      //
      // It lives on `tab_here` because this tool already owns a tab's life — where it points, and
      // now whether it exists. The guards are the same two that matter everywhere else: never the
      // connection window (that is the socket every session talks through), and never a tab the
      // person pinned, because a pin is them saying "this one is mine".
      if (close) {
        if (isOurPage(t.url)) {
          throw new Error('that is HoloScrape\'s own connection window — closing it disconnects '
            + 'every agent session, including yours.');
        }
        const pin = await pinnedTab();
        if (pin && pin.id === t.id) {
          throw new Error('that tab is PINNED in the HoloScrape panel — the person marked it as '
            + 'the page they mean. Ask them to unpin it rather than closing it.');
        }
        forgetSeen(t.id);
        await chrome.tabs.remove(t.id);
        return { tabId: t.id, closed: true, was: (t.url || '').slice(0, URL_MAX_CHARS),
          tell: 'closed. Close the tabs you opened when a pass ends — lanes become tabs, and a '
            + 'person who lent you their browser should get it back the way it was.' };
      }
      if (isOurPage(t.url)) {
        throw new Error('that tab is HoloScrape\'s own connection window — the socket every agent '
          + 'session is talking through lives in it, and navigating it away disconnects all of '
          + 'them, including you. Open or pick a different tab: tabs_list shows the real ones.');
      }
      const ok = await allows(url);
      if (!ok.ok) throw new Error(ok.why);
      const from = t.url || '';

      // CAPTURE HERE IS RECONNAISSANCE, NOT THE WAY TO DO A SET.
      //
      // One page, so you can see what the site's API actually answers and write the `$.` paths
      // against something real. Doing a hundred pages this way is a hundred calls with a payload
      // in each — page_harvest takes the same `network` filter, maps it in the browser with the
      // same field spec, and returns rows. The bodies here are capped hard for that reason: this
      // reply travels through a model, and a GraphQL response is the biggest thing in the system.
      let st = null;
      if (netFilter) {
        st = await netOpen(t.id, String(netFilter));
        // ATTACH FAILURE MUST NOT SWALLOW THE NAVIGATION. Only one debugger may hold a tab, so an
        // open DevTools window or another extension makes this fail — and the first version of
        // this returned before `tabs.update` ever ran, so tab_here silently did not navigate at
        // all. Go on without capture and say why.
        if (st.why) { await netClose(st).catch(() => {}); }
      }
      // The tab is going somewhere else, so everything remembered about it stops being true.
      forgetSeen(t.id);
      try {
        // ARMED BEFORE THE NAVIGATION, so the `loading` it raises cannot be missed.
        const nav = armNav(t.id);
        await chrome.tabs.update(t.id, { url: String(url) });
        // Waiting is the whole value: returning before the document is ready hands the caller the
        // PREVIOUS page's DOM, which reads as a successful extraction of the wrong thing — the worst
        // failure shape this project has.
        //
        // `certain` whenever a different document was asked for: then only the cap applies, and
        // the old document is never read because the new one was slow to start. The short
        // expectation window is for an address that differs only after the `#`, where no
        // document load may be coming at all. And a cap that IS hit is reported — `waitForLoad`
        // resolved the same way on `complete` and on its timeout, so it never could be.
        const navd = await nav.wait({ certain: !sameDocument(from, String(url)), capMs: NAV_MS });
        const now = await chrome.tabs.get(t.id).catch(() => t);
        const landed = now.url || '';
        // ARRIVING SOMEWHERE AND ARRIVING WHERE YOU ASKED ARE DIFFERENT QUESTIONS.
        const bounced = heldForReturn(landed, String(url));
        let gate = '';
        if (bounced) {
          // Only now — one extra injection on the rare navigation that was redirected, never on the
          // ordinary one. The page names WHAT stopped us; the url only proved that something did.
          const w = await runRows(t.id, { action: 'challenge' }).catch(() => null);
          gate = w?.challenge || 'redirected';
        }
        // Skipped when bounced: a sign-in page has no list because it is a sign-in page, and the
        // `tell` below would then argue with the far more useful one the bounce branch writes.
        // THROUGH `lookAt`, NOT STRAIGHT TO THE SETTLE. Same count either way — `lookAt` is now the
        // settle plus the descriptor facts — but this reply used to omit `pagination`, `records`
        // and `steps` purely because it took the shorter path, so the richest entry point in the
        // tool was also the one that said least about what a run would cost.
        const ready = bounced ? null : await lookAt(t.id, { navd });
        const base = {
          ...tabBrief(now), from,
          arrived: landed !== from && !bounced,
          ...(ready || {}),
          ...knownFor(t.id, landed),
          ...(ready && !ready.hasList ? {
            tell: 'the document loaded and no list settled on it. Wait for it rather than '
              + 're-navigating — but WAIT FOR THE ROWS, NOT THE CONTAINER: '
              + 'page_state path:"@await(<list css> > * :: still)". `exists` on a container matches '
              + 'the container, which is one element and is there instantly; measured, a run asked '
              + '@await(ul.shopee-search-item-result__items) and got ok in 22ms while the grid held '
              + 'ten of its eventual sixty. `> *` counts the ROWS and `still` waits for that number '
              + 'to stop moving, which is the only thing that means ready. @await(<spinner> :: gone) '
              + 'is surer still where a spinner exists. Otherwise page_study to see what IS here, or '
              + 're-run with `network` to read what the page fetches. Do not harvest off this.',
          } : {}),
          ...(bounced ? {
            gate,
            wanted: String(url),
            heldAt: landed.slice(0, URL_MAX_CHARS),
            tell: gate === 'signin'
              ? 'that destination is behind a sign-in on this site, and the page holding it will '
                + 'return there once the person signs in. THE PERSON DOES THAT, IN THIS BROWSER — you '
                + 'cannot sign in for them, must not try, and must never ask them for a password. '
                + 'Relay this, and retry the same url afterwards. If they would rather not, say what '
                + 'is reachable without it rather than reporting the page as empty.'
              : 'the site redirected away from that url and is holding it to return to, so something '
                + 'is gated here — a consent screen, an age or region gate, an interstitial. Read '
                + 'this page to see what it wants; the destination is not lost, it is deferred.',
          } : {}),
        };
        if (!netFilter) return base;
        if (!st || st.why) {
          return { ...base, network: [], netWhy: st?.why || 'could not attach the debugger to this tab' };
        }
        const { bodies, all, why, kinds } = await netTake(st);
        // DISCOVERY: `*` means "I do not know what this page fetches — show me". EVERY response is
        // named, and the data-shaped ones additionally carry the `$.` paths inside them. It used to
        // name only the ones whose body had been read, which meant a page that fetched 290 things
        // answered with 12 and a number for the rest — the caller could see something was there and
        // had no way to say which. This is what you run FIRST on a site nobody has read before; the
        // filter and the `$.` paths for page_harvest come straight off its output.
        if (String(netFilter) === '*') {
          const shaped = netCatalogue(bodies);
          const shapedUrls = new Set(shaped.map((b) => b.url));
          const rest = (all || []).filter((r) => !shapedUrls.has(r.url));
          return { ...base,
            network: shaped,
            ...(rest.length ? { alsoFetched: rest } : {}),
            ...(kinds && Object.keys(kinds).length ? { kinds } : {}),
            ...(why ? { netWhy: why } : {}),
            next: shaped.length
              ? 'pick the response holding what you want, then page_harvest with network: '
                + '"<a distinctive part of its url>" and $. paths from its `paths` list'
              : (all || []).length
                ? 'nothing this page fetched was data-shaped — `alsoFetched` and `kinds` list what '
                  + 'it did fetch, so name one url with "@net(<substring>)" to read it'
                : 'this page fetched nothing at all on load — the data is probably in the markup '
                  + 'already, or arrives on an interaction rather than at load' };
        }
        // Trimmed by BODY, with the trim stated — see `NET_BODY_CAP_CHARS` at the top of this file.
        const CAP = NET_BODY_CAP_CHARS;
        const out = bodies.map((b) => {
          let v = b.body;
          let text = typeof v === 'string' ? v : JSON.stringify(v);
          if (text.length <= CAP) return b;
          return { url: b.url, truncated: `${text.length} chars, showing ${CAP}`,
            body: text.slice(0, CAP) };
        });
        return { ...base, network: out, ...(why ? { netWhy: why } : {}),
          ...(out.some((b) => b.truncated)
            ? { hint: 'a body was trimmed — name the field with a $. path in page_harvest '
              + 'instead of reading whole payloads through here' } : {}) };
      } finally {
        await netClose(st).catch(() => {});
      }
    },

    'site.probe': async ({ tabId }) => {
      const t = await needTab(tabId);
      return { ...tabBrief(t), ...(await lookAt(tabId)) };
    },

    // THE LAYER UNDER THE DOM — the op behind `page_state`.
    //
    // Every other op here reads the rendered page, which for a virtualized list is the worst
    // source it has: measured on web.whatsapp.com's chat list, a pinned `list.extract` returned 67
    // rows (the mounted window, not the list) and a phone number for unsaved contacts only —
    // because the chat-list DOM holds no number for a saved contact at all. The app's own store
    // holds both. This reads that store.
    //
    // TWO MODES AND NOT ONE LINE OF CODE BETWEEN THEM. No path is discovery: the ENGINE says what
    // state exists and hands back the prefix to read each part with. A path is a read of that
    // path, tokenized and walked as properties in `rows.js` — see the long note above `statePath`
    // for why an explicit tokenizer rather than the one-liner that would also be `eval`.
    //
    // SAME CONSENT AND NO SECOND DOOR. `needTab` is the whole gate, identical to every op above:
    // an origin the person has not allowed is refused with the same sentence, and page state sits
    // on the same side of the tier table as the DOM (DEEP-EXTRACTION.md) because it is what the
    // person is already looking at. What is NOT on that side — cookies, bearer tokens, session
    // secrets — is stripped in the engine on the way out, and reported as redacted rather than
    // silently dropped, so an agent can tell "nothing there" from "something you may not have".
    // READ WHAT THE PERSON POINTED AT. No ranking, no detection — the tools that rank refuse
    // anything they do not classify as a list, and a person looking straight at 23 servers does not
    // care what the engine classified.
    // EXPLORE THE WHOLE PAGE. Walks to the deepest child, takes every scrollable region to its
    // real end, and names the ones that have none. Slow by nature — it is the tool you call when
    // you do not yet know what the page is.
    'page.explore': async ({ tabId, scroll, rounds, limit }) => {
      const t = await needTab(tabId);
      const out = await runRows(tabId, { action: 'explore', scroll, rounds, limit });
      return { tabId, url: t.url, ...out };
    },

    'page.read': async ({ tabId, selector = '', limit, offset, children }) => {
      const t = await needTab(tabId);
      const out = await runRows(tabId, {
        action: 'read', selector: String(selector || ''), limit, offset, children,
      });
      const hint = browserHint('read', out, t);
      return { tabId, url: t.url, ...out, ...(hint ? { hint } : {}) };
    },

    // The markup, scoped and stripped. The one tool here that returns no judgement at all — see
    // `htmlOf` in rows.js for why that turned out to be the missing primitive rather than a
    // violation of "return data, never HTML".
    'page.html': async ({ tabId, selector = '', index, depth, limit, offset }) => {
      const t = await needTab(tabId);
      const out = await runRows(tabId, {
        action: 'html', selector: String(selector || ''), index, depth, limit, offset,
      });
      return { tabId, url: t.url, ...out };
    },

    // Press each of a set and report where each one led. The one op here that spans PAGES rather
    // than describing one — see `walkSite` in rows.js for why its absence made the tool slower
    // than doing the job by hand.
    // `text` IS PART OF THE SIGNATURE, because the description has always said it is. It was
    // advertised as the preferred input — "what the person would CLICK, in their words" — and this
    // destructure dropped it, so a caller who used it got NO_SELECTOR against a control they had
    // named correctly. The engine matches it against visible text, falling back to the accessible
    // name, which is how an icon-only control is labelled.
    'page.walk': async ({ tabId, selector = '', text = '', choose = '', read = '', fill = null, limit, offset, waitMs, back }) => {
      // FILLING IS A DIFFERENT VERB FROM PRESSING, AND IT SHORT-CIRCUITS HERE.
      //
      // It rides `page_walk` because that is where acting on a control already lives — press, and
      // choose from a <select>. Typing is the third, and it was the missing one: a list reachable
      // only through a filter or a date range could not be reached at all. The refusals live in
      // the engine (password, hidden, anything that looks like payment) so they apply however the
      // op is reached, and nothing here submits.
      if (fill !== null && fill !== undefined) {
        await needTab(tabId);
        return runRows(tabId, { action: 'fill', selector: String(selector || ''), fill: String(fill) });
      }
      const t = await needTab(tabId);
      const out = await runRows(tabId, {
        action: 'walk', selector: String(selector || ''), text: String(text || ''),
        choose: String(choose || ''), read: String(read || ''),
        limit, offset, waitMs, back,
      });
      // ESCALATE ONLY ON FAILURE — see the note by `walkPressRealBatch` in the worker. `choose`
      // sets a <select>'s value and fires real events, which a page never distinguishes from a
      // person's own change event, so there is nothing here for it to escalate; an error (NO_MATCH,
      // BAD_SELECTOR…) has no row to press either.
      if (!choose && Array.isArray(out?.rows)) {
        await walkPressRealBatch(tabId, out.rows, {
          selector: String(selector || ''), text: String(text || ''), read: String(read || ''), waitMs, back,
        });
        out.moved = out.rows.filter((r) => r.moved).length;
      }
      return { tabId, startedAt: t.url, ...out };
    },

    'page.state': async ({ tabId, path = '', limit, depth, offset, fields, resolve, reply }) => {
      // `@net(...)` IS HANDLED HERE, NOT IN THE PAGE. Every other page_state path is answered by the
      // row engine inside the document; this one is answered by the worker, because CDP is the only
      // place response bodies exist and the page cannot reach it. Same grammar on purpose — it is a
      // PATH so a client holding a stale tool list can still use it.
      // THE FRAME KEEPER HAS TO BE IN THE TAB BEFORE A WALK, NOT MERELY ARMED.
      //
      // `keepFrames` asks `window.__holoscrapeFrames` to revive the frame chains, and on any page
      // outside the Maps pass that object has never been injected — so it answers 'absent' and the
      // walk runs against a throttled tab anyway. This file's own history records the same trap:
      // eight rounds improving the keeper while it was simply not loaded. `raf.js` is a
      // document_start content script, so it cannot be added to an already-open tab the normal
      // way; `lateKeeper` injects it late, which recovers the visibility spoof, the event swallow
      // and the timer backstop — enough for a lazy list, which loads on an observer, not on rAF.
      const netArg = /^@net\((.*)\)$/.exec(String(path || '').trim());
      if (netArg) {
        await haveTab(tabId);
        return netWatch(tabId, netArg[1]);
      }
      const t = await needTab(tabId);
      // `NO_MATCH` ON A PAGE STILL ARRIVING IS NOT ABSENCE, and it is the costliest misreading this
      // tool has produced ("reviews are blocked in background tabs" — they mounted two seconds
      // later). Same brief look as `page.study`; the verdict rides back beside the answer.
      const pre = await settleBrief(tabId, { scope: null }).catch(() => null);
      const out = await runRows(tabId, {
        action: 'state', path: String(path || ''), limit, depth, offset, reply,
        // Both travel as plain data — an array of field paths and a {from, into, fields} object —
        // because everything handed to `executeScript` must be JSON-serialisable, and because a
        // path is the only thing this vocabulary will ever accept in place of code.
        fields: Array.isArray(fields) ? fields.map(String).slice(0, MAX_FIELDS) : undefined,
        resolve: (resolve && typeof resolve === 'object') ? {
          from: String(resolve.from || ''),
          into: String(resolve.into || ''),
          fields: Array.isArray(resolve.fields) ? resolve.fields.map(String).slice(0, MAX_FIELDS) : [],
        } : undefined,
      });
      return { tabId, url: t.url, ...out, ...(out && 'page' in out ? {} : { page: await headerFor(tabId, pre) }) };
    },

    // --- running a walk --------------------------------------------------------------------
    // STARTED AND LEFT RUNNING. The call returns a handle immediately; `run.status` is how the
    // agent finds out what happened. A fifteen-page walk is minutes, and a tool that blocked for
    // them would time out having said nothing — while the person watched a browser doing work the
    // agent could not describe.
    'list.extract': async ({ tabId, pages = 0, withRecords = false, selector = '', next = '' }) => {
      const t = await needTab(tabId);
      // `next`: THE NEXT-PAGE CONTROL, NAMED BY THE CALLER — a CSS selector or an href. It outranks
      // every guess (research/CONTRACT-2026-09-22.md). The panel has always been able to point at a
      // pager; an agent could only accept "no further pages". Resolved against the live page
      // BEFORE the run starts, and a `next` that matches nothing fails the call with the value in
      // the message — the same rule as `selector` below, for the same reason: falling back to the
      // guess in silence is exactly the bug the argument exists to prevent.
      const pointed = { nextSelector: '', nextClick: '', nextHref: '' };
      let nextVia = null;
      if (String(next || '').trim()) {
        const pn = await runRows(tabId, { action: 'pointnext', next: String(next).trim() }).catch((e) => ({ error: e.message }));
        if (pn?.error === 'OTHER_ORIGIN') {
          throw new Error(`next "${next}" leads to another site — a walk stays on the origin it started on`);
        }
        if (!pn || pn.error) {
          throw new Error(`nothing on the page matches next "${next}" — pass a CSS selector for the next-page `
            + 'control or the href it carries; a finished run\'s nearMisses list both');
        }
        // A link is FOLLOWED (its address is read off it on every page); a control with no address
        // is PRESSED; a bare address with no control carrying it is spent on the first turn.
        if (pn.kind === 'link') pointed.nextSelector = pn.selector;
        else if (pn.kind === 'control') pointed.nextClick = pn.selector;
        else pointed.nextHref = pn.href;
        nextVia = { kind: pn.kind, label: pn.label || '', ...(pn.href ? { href: pn.href } : {}) };
      }
      // THE CALLER MAY NAME THE CONTAINER, AND THE NAME EITHER TAKES HOLD OR THE CALL FAILS.
      //
      // The ranking is right on most pages and reliably wrong on one shape: two scrollable
      // regions, where the denser pane outscores the one the person means — a chat app's sidebar
      // list beside an open conversation, a filter rail beside results. `pin` marks the named
      // container on the page itself so the run's own re-detections keep it (see the pin block in
      // rows.js `detect`), and an empty selector CLEARS any earlier pin, so one run's intent
      // cannot silently steer the next. Every failure is thrown with the selector in it: falling
      // back to the auto-pick without saying so is the bug this parameter exists to prevent.
      // NO SELECTOR IS NOT THE SAME AS NO KNOWLEDGE.
      //
      // With an empty selector this cleared the pin and handed the choice to the ranking — on a
      // site whose descriptor NAMES the list, and whose name `tab_here` had already printed in the
      // reply immediately before. Measured live on shopee.co.id: `tab_here` reported 60 rows and
      // `namedList: ul.shopee-search-item-result__items`; `list_extract` with no selector then
      // returned EIGHT rows of filter labels off `div.shopee-filter-panel`. Pinning the named list
      // by hand returned all 60 in six seconds. The right answer was in the descriptor the whole
      // time and this call did not ask for it.
      //
      // So an absent selector falls back to the descriptor's list when that selector is actually
      // on the page. Not when it is missing — a stale or wrong-route descriptor must not pin
      // nothing and fail the run; the ranking is the correct fallback there, which is what
      // `detect` has always done with `if (want)`.
      //
      // An EXPLICIT selector still wins, and still clears any earlier pin, because the caller
      // saying which list they mean outranks both the descriptor and the score.
      let useSelector = String(selector || '');
      let viaDescriptor = '';
      if (!useSelector) {
        const site = await siteFor(tabId);
        if (site?.list && !site.onRecord) {
          const probe = await runRows(tabId, {
            action: 'state', path: `@dom(${site.list})`, limit: 1,
          }).catch(() => null);
          if (probe && !probe.error && Number(probe.total) > 0) {
            useSelector = site.list;
            viaDescriptor = site.id;
          }
        }
      }
      const pin = await runRows(tabId, { action: 'pin', selector: useSelector });
      // A DESCRIPTOR FALLBACK THAT DOES NOT TAKE IS NOT AN ERROR. Only a selector the CALLER gave
      // is worth failing over; if the descriptor's list will not pin, clear it and let the ranking
      // decide, exactly as though nothing had been tried.
      if (!selector && viaDescriptor && (pin?.error || !pin?.pinned)) {
        await runRows(tabId, { action: 'pin', selector: '' }).catch(() => {});
        viaDescriptor = '';
      }
      if (selector && pin?.error === 'NO_MATCH') {
        throw new Error(`nothing on the page matches "${selector}" — take a selector from `
          + 'page_study lists[].selector, or omit it to let the ranking choose');
      }
      if (selector && pin?.error === 'NO_ROWS') {
        // THE REFUSAL CARRIES ITS EVIDENCE, because the alternative is what actually happened:
        // the caller went and read the engine's internal state by raw path, then read the engine
        // source, to find out which gate had said no. `tried` says what each matched element is
        // and why it was refused; `offers` is what the page does have, with selectors that
        // round-trip. A caller should never have to open this repository to use the tool.
        // The original sentence is kept WORD FOR WORD — `test/pinned-pane.mjs` asserts on it, and
        // rewording a message a test pins is how a contract gets broken while the suite is made
        // to agree. The evidence is appended, not substituted.
        throw new Error(`"${selector}" matched ${pin.matched ?? 1} element(s), but no repeating `
          + 'rows were found inside any of them. '
          + JSON.stringify({ tried: pin.tried, offers: pin.offers }));
      }
      if (selector && (pin?.error || !pin?.pinned)) {
        throw new Error(`could not pin "${selector}": ${pin?.error || 'the page gave no answer'}`);
      }
      // What this run named, in the engine's canonical form, so `sessionFor` can tell two runs
      // that mean two different containers apart. Recorded AFTER the pin succeeded, because the
      // canonical selector is what the pin resolved to and not what the caller typed.
      if (selector) pinnedFor.set(tabId, String(pin.selector || selector));
      else pinnedFor.delete(tabId);
      const id = `run_${++runSeq}`;
      const rec = { id, tabId, startedAt: Date.now(), done: false, out: null, error: '' };
      runs.set(id, rec);
      // WHAT STATE THE TAB WAS IN WHEN THE WALK BEGAN, AND AGAIN WHEN IT ENDED. A walk is the one
      // read that outlives its call, so its header is taken at both ends and `run.status` carries
      // it: a walk through a tab that was not painting reads sixty empty rows a page and reports
      // every one of them.
      rec.page = await headerFor(tabId, null).catch(() => null);
      hopHere(tabId, { pages: Number(pages) || 0, withDetails: !!withRecords,
        ...(pointed.nextSelector ? { nextSelector: pointed.nextSelector } : {}),
        ...(pointed.nextClick ? { nextClick: pointed.nextClick } : {}),
        ...(pointed.nextHref ? { nextHref: pointed.nextHref } : {}) })
        .then(async (out) => {
          const end = await pageProbe(tabId, { scope: null }).catch(() => null);
          const caps = (out && out.unsettled) || [];
          rec.page = pageHeader(end || null, {
            settled: !caps.length, settleMs: (out && out.settleMs) || 0,
            why: caps.length ? `${caps.length} page(s) were read at the wait's ceiling, still changing — first: ${caps[0].why}` : '',
          });
          // Frames are judged over the WHOLE walk: painting at the end does not un-blind the start.
          if (rec.pageAtStart && rec.pageAtStart.frames === false && rec.page.frames) {
            rec.page.frames = false; rec.page.hidden = rec.pageAtStart.hidden;
            rec.page.why = [rec.pageAtStart.why, rec.page.why].filter(Boolean).join(' ');
          }
          rec.out = out; rec.done = true;
        })
        .catch((e) => { rec.error = String(e?.message || e); rec.done = true; });
      rec.pageAtStart = rec.page;
      return { runId: id, tabId, url: t.url,
        ...(rec.page ? { page: rec.page } : {}),
        // What the pin actually landed on — the engine's canonical selector for the row list it
        // will read — so the caller can see their selector took hold before the first poll.
        ...(selector ? { pinned: pin.selector } : {}),
        // SAID OUT LOUD, because "the descriptor chose this list" and "the ranking chose this
        // list" are different qualities of answer, and a caller comparing a short result against
        // what tab_here reported should be able to tell which one it got.
        ...(viaDescriptor ? { pinned: pin.selector, pinnedBy: `${viaDescriptor} descriptor` } : {}),
        // What `next` resolved to, so the caller sees their control took hold before the first poll.
        ...(nextVia ? { next: nextVia } : {}),
        watch: 'call run_status with this runId' };
    },

    'run.status': async ({ runId }) => {
      const rec = runs.get(runId);
      if (!rec) throw new Error(`no such run: ${runId}`);
      // A HARVEST KEEPS ITS OWN PROGRESS, because it is not walking one tab — it is driving several
      // lanes at once, and `hopProgress` is keyed per tab. Answered first so a harvest never falls
      // through to a hop's bookkeeping and reports zeros about a run that is going fine.
      if (rec.kind === 'harvest') {
        const secs = Math.round((Date.now() - rec.startedAt) / 1000);
        const p = rec.prog || {};
        if (!rec.done) {
          const of = p.of || 0;
          const done = p.done || 0;
          return {
            state: 'running',
            pagesDone: done,
            of,
            percent: of ? Math.round((done / of) * 100) : 0,
            rowsSoFar: p.rows || 0,
            failedSoFar: p.failed || 0,
            secs,
            // An estimate, plainly labelled. A caller with no number invents one, and the number it
            // invents is the one that makes a person think the tool has hung.
            etaSecs: done > 2 && of ? Math.round((secs / done) * (of - done)) : null,
            // Said WHILE it runs: lanes that are not painting will not start painting by page 200.
            ...(p.page ? { page: p.page } : {}),
            next: 'poll run_status again, or run_stop to end it',
          };
        }
        if (rec.error) return { state: 'failed', why: rec.error, secs };
        return { state: 'done', secs, ...(rec.out || {}) };
      }
      const live = hopProgress.get(rec.tabId);
      const secs = Math.round((Date.now() - rec.startedAt) / 1000);
      if (!rec.done) {
        // WAITING FOR A PERSON IS A STATUS, NOT A FAILURE — and this is the line that decides
        // whether an agent behaves well at a captcha. Told "waiting", it relays that and stops.
        // Told "error", it retries, and retrying is exactly what turns a slider into a block.
        if (live?.waiting) {
          return {
            state: 'waiting_for_user',
            what: live.waiting.kind === 'flagged' ? 'the site refused the session' : 'the site put up a check',
            secondsLeft: Math.max(0, Math.round(((live.waiting.until || 0) - Date.now()) / 1000)),
            rowsSoFar: live.added || 0, pagesSoFar: live.pages || 0, secs,
            tell: 'Ask the person to clear the check in their browser. It carries on by itself.',
          };
        }
        if (live?.reading) {
          return { state: 'reading_records', at: live.reading.at || 0, of: live.reading.of || 0,
            rowsSoFar: live.added || 0, pagesSoFar: live.pages || 0, secs };
        }
        return { state: 'running', rowsSoFar: live?.added || 0, pagesSoFar: live?.pages || 0, secs,
          ...(rec.page ? { page: rec.page } : {}) };
      }
      if (rec.error) return { state: 'failed', why: rec.error, secs };
      const o = rec.out || {};
      return {
        state: 'done', rows: o.added || 0, pages: o.pages || 0, detailed: o.detailed || 0,
        resultId: o.id || null, why: o.why || '', stoppedByCheck: o.wall || '', secs,
        ...(rec.page ? { page: rec.page } : {}),
        // ROWS READ AND NOT KEPT, WITH THE REASON — see `dropped` in the walk. Only when there
        // were some: `rows` beside a page count that does not multiply out is otherwise a number
        // the caller can neither trust nor check.
        ...(o.dropped ? { dropped: o.dropped } : {}),
        // THE PAGER'S NEGATIVE, SHOWN. Present only when the walk ended for want of a next page:
        // what it measured, the (at most five) controls that nearly qualified and why each lost,
        // and the argument that overrules it. `growable` is the other silent ending — a load-more
        // control still sitting under the list. Both were measured as bare sentences on
        // 2026-09-22: "no further pages" at 20 of 60, "reached the limit" at 6 of 117.
        ...(Array.isArray(o.nearMisses) ? { saw: o.saw || {}, nearMisses: o.nearMisses.slice(0, 5),
          override: o.override || '' } : {}),
        ...(o.growable ? { growable: o.growable } : {}),
        next: o.id ? 'call results action:"get" with this resultId' : '',
      };
    },

    'run.stop': async ({ runId }) => {
      const rec = runs.get(runId);
      if (!rec) throw new Error(`no such run: ${runId}`);
      // A HARVEST IS NOT A WALK, AND THIS USED TO TREAT THEM AS ONE. `stopScan` ends a page walk
      // on a list tab; a harvest owns no list tab (its `tabId` is routinely 0), so stopping one
      // did nothing while reporting `stopping: true`. See the note above `harvest` in
      // background.js for what that cost. The flag is what the lane loop reads.
      rec.stopped = true;
      await stopScan(rec.tabId).catch(() => {});
      if (rec.kind === 'harvest') {
        return { runId, stopping: true, lanes: rec.lanes || 1,
          tell: 'the lanes finish the page they are on and then stop, so give it a few seconds. '
            + 'Poll results action:"status" until state is no longer "running" before starting '
            + 'another harvest — the rows gathered so far are kept.' };
      }
      return { runId, stopping: true };
    },

    // --- getting the data ------------------------------------------------------------------
    'results.list': async () => {
      const { history = [] } = await chrome.storage.local.get('history');
      return {
        results: history.slice(0, RESULTS_LIST_MAX).map((h) => ({
          resultId: h.id, url: h.url || '', title: (h.title || '').slice(0, TITLE_MAX_CHARS), when: h.scannedAt || '',
        })),
      };
    },

    // ROWS AND COLUMN NAMES, NEVER HTML. The whole value is that the page has already been turned
    // into a table — handing back markup would burn the agent's context on the one thing we did
    // the work to remove, and is the thing Firecrawl does more cheaply anyway.
    // A WINDOW YOU CANNOT MOVE IS NOT A WINDOW. This took `limit` and sliced from zero, so a
    // 240-row result could be asked for 100 rows and the other 140 were unreachable through this
    // tool at any argument — the reply said `truncated: true` and `total: 240` and then offered
    // nothing to do about it. Combined with REPLY_TOO_BIG on the full set, that is a result you
    // can neither fetch whole nor page through, and the only way out was the CSV export.
    //
    // `offset` is the missing half, and `nextOffset` plus the literal next call are written out
    // for the same reason page_harvest writes `nextFrom`: a number the caller has to work out is
    // a number the caller gets wrong, and an off-by-one here silently skips or repeats rows.
    'results.get': async ({ resultId, limit = RESULTS_GET_DEFAULT_ROWS, offset = 0, columns = null }) => {
      const bag = await chrome.storage.local.get(TABLE_KEY_PREFIX + resultId);
      const held = bag[TABLE_KEY_PREFIX + resultId];
      if (!held) throw new Error(`no such result: ${resultId}`);
      const t = (held.tables || []).slice().sort((a, b) => (b.rows?.length || 0) - (a.rows?.length || 0))[0];
      if (!t) return { columns: [], rows: [], total: 0 };
      const keep = (t.cols || []).filter((c) => !c.drop && (!columns || columns.includes(c.name || c.key)));
      const n = Math.max(1, Math.min(RESULTS_GET_MAX_ROWS, Number(limit) || RESULTS_GET_DEFAULT_ROWS));
      const all = t.rows || [];
      const from = Math.max(0, Math.min(all.length, Math.floor(Number(offset) || 0)));
      const rows = all.slice(from, from + n).map((r) => {
        const o = {};
        for (const c of keep) o[c.name || c.key] = r[c.key] ?? '';
        return o;
      });
      const end = from + rows.length;
      return {
        columns: keep.map((c) => c.name || c.key),
        rows,
        returned: rows.length,
        offset: from,
        total: all.length,
        truncated: end < all.length,
        ...(end < all.length ? {
          nextOffset: end,
          more: all.length - end,
          tell: `${end} of ${all.length} rows so far. Call results again with action:"get", the `
            + `same resultId and offset: ${end} for the next ${Math.min(n, all.length - end)}, and `
            + 'repeat until `truncated` is false. DO NOT report this page as the whole table. '
            + 'If you want every row at once instead, action:"export" writes a CSV and returns a '
            + 'path — no reply size limit applies to a file.',
        } : {}),
      };
    },

    // THE PICTURES THEMSELVES, ON DISK — AND ONLY WHEN A PERSON PRESSES SAVE.
    //
    // Three ways an agent could be handed images, and two of them are wrong here. Sending the bytes
    // back as MCP image blocks costs tens of megabytes for one page's worth and buries the context
    // it was supposed to help; handing back urls for the agent to fetch itself drops the person's
    // cookies, so everything behind a login answers 403 or a login page. `chrome.downloads` sends
    // the cookies the person already has, which is the only way a signed-in page's media arrives
    // intact — and it puts the files where files go instead of in a conversation.
    //
    // WHAT THIS DOES NOT DO is decide. Origin consent covers reading, because reading a page the
    // person is looking at leaves nothing behind; writing files onto their machine does, so it gets
    // its own gate and that gate is a human pressing a button, per batch, with no way to pre-approve
    // it. See `askToSave`. An agent that wants files says so and waits.
    //
    // The assets come from whatever the panel's scan already put in this result. There is no way to
    // start a scan from here on purpose: the person runs the deep scan, sees what it found, and only
    // then is there something to ask about.
    // TWO PASSES OVER THE SAME LIST ARE ONE ANSWER, AND JOINING THEM WAS DONE BY HAND.
    //
    // A thin page is transient, so the cheapest way to finish a hard site is to run it twice and
    // keep the better of each row. Measured over 625 products: pass one read 529, pass two read
    // 563, only 10 failed both — and the union was 615 of 625, 98%. That union was assembled in
    // the model, row by row, which is the pattern this project exists to delete: the rows were in
    // the browser both times and never needed to leave it.
    //
    // LONGER WINS, PER FIELD, which is the rule that matters on a marketplace. The same run found
    // every column "100% filled" while 133 descriptions were under 80 characters and 97 were
    // literally "-". A row that is present but empty must not beat a row that has the text, so
    // this compares field by field rather than picking a whole row and hoping.
    'results.merge': async ({ resultIds = [], key = '', into = '' }) => {
      const ids = (resultIds || []).map(String).filter(Boolean);
      if (ids.length < 2) throw new Error('give two or more resultIds to merge');
      const bag = await chrome.storage.local.get(ids.map((i) => TABLE_KEY_PREFIX + i));
      const tables = [];
      for (const id of ids) {
        const held = bag[TABLE_KEY_PREFIX + id];
        if (!held) throw new Error(`no such result: ${id}`);
        const t = (held.tables || []).slice()
          .sort((a, b) => (b.rows?.length || 0) - (a.rows?.length || 0))[0];
        if (t) tables.push({ id, t });
      }
      if (!tables.length) throw new Error('none of those results holds a table');
      // The key names a COLUMN, and a row without one cannot be matched — kept rather than
      // dropped, because a row nobody can join is still a row somebody harvested.
      const colName = (c) => c.name || c.key;
      const keyOf = (row, cols) => {
        if (!key) return null;
        const c = cols.find((x) => colName(x) === key);
        if (!c) return null;
        const v = row[c.key];
        return v == null || v === '' ? null : String(v);
      };
      const merged = new Map();
      const loose = [];
      let cols = [];
      for (const { t } of tables) {
        const keep = (t.cols || []).filter((c) => !c.drop);
        for (const c of keep) if (!cols.some((x) => colName(x) === colName(c))) cols.push(c);
        for (const r of t.rows || []) {
          const flat = {};
          for (const c of keep) flat[colName(c)] = r[c.key] ?? '';
          const k = keyOf(r, keep);
          if (!k) { loose.push(flat); continue; }
          const had = merged.get(k);
          if (!had) { merged.set(k, flat); continue; }
          for (const [f, v] of Object.entries(flat)) {
            const old = had[f] == null ? '' : String(had[f]);
            const now = v == null ? '' : String(v);
            if (now.length > old.length) had[f] = v;   // longer wins, per field
          }
        }
      }
      const rows = [...merged.values(), ...loose];
      const names = cols.map(colName);
      const out = { merged: rows.length, from: tables.map((x) => ({ resultId: x.id, rows: (x.t.rows || []).length })),
        columns: names, key: key || null,
        ...(loose.length ? { unkeyed: loose.length } : {}) };
      if (!into) {
        return { ...out, rows: rows.slice(0, MERGE_PREVIEW_ROWS), returned: Math.min(MERGE_PREVIEW_ROWS, rows.length),
          tell: rows.length > MERGE_PREVIEW_ROWS
            ? `the first ${MERGE_PREVIEW_ROWS} are shown. Pass \`into\` with a name to SAVE the merge as a new result, `
              + 'then read it with results action:"get" and offset, or export it as a CSV.'
            : 'pass `into` with a name to save this as a new result you can export.' };
      }
      const id = `merge_${Date.now().toString(36)}`;
      const saveCols = names.map((n) => ({ key: n, name: n }));
      await chrome.storage.local.set({ [TABLE_KEY_PREFIX + id]: {
        tables: [{ cols: saveCols, rows }], title: String(into).slice(0, TITLE_MAX_CHARS), mergedFrom: ids,
      } });
      return { ...out, resultId: id, savedAs: String(into).slice(0, TITLE_MAX_CHARS),
        tell: `saved as ${id}. Read it with results action:"get" resultId:"${id}" (use offset to `
          + 'page through) or action:"export" for a CSV.' };
    },

    'results.download': async ({ resultId, urls = null, types = null, max = DOWNLOAD_DEFAULT_MAX }) => {
      // URLS FOUND ANYWHERE, NOT ONLY BY A PANEL SCAN.
      //
      // The restriction was arbitrary and it blocked the ordinary case three times over: 50 cover
      // images found by `page_harvest`, full-size pictures named in a search payload read through
      // `@net`, review photos sitting in an API response. All of them were URLs the caller already
      // held and none of them could be written, because the only door led through a result an asset
      // scan had filled.
      //
      // NOTE THE DIRECTION OF THIS FIX. The PANEL could already do it — `table.js` sends
      // `{type:'DOWNLOAD', items:[...]}` with arbitrary lists and `downloadAll` accepts them. So
      // this is not a second download path; it is the MCP surface catching up to the plain one,
      // through the same `downloadAll` and behind the same human gate.
      //
      // Why it must be the browser and not the agent's own fetch: `chrome.downloads` carries the
      // person's cookies, so anything behind a login arrives intact. An outside fetch of the same
      // url gets a login page and saves it as a jpeg.
      const named = Array.isArray(urls) ? urls.map((u) => String(u || '').trim()).filter(Boolean) : [];
      if (named.length) {
        const good = named.filter((u) => /^https?:\/\//i.test(u));
        const bad = named.length - good.length;
        if (!good.length) {
          return { downloaded: 0, why: 'none of those are http(s) urls. A data: or blob: url cannot '
            + 'be fetched by the browser on your behalf; name the address the page itself loads.' };
        }
        const picked = good.slice(0, Math.max(1, Math.min(DOWNLOAD_HARD_MAX, Number(max) || DOWNLOAD_DEFAULT_MAX)))
          .map((u) => {
            let name = '';
            try { name = decodeURIComponent(new URL(u).pathname.split('/').pop() || ''); } catch (_) {}
            return { url: u, type: 'file', name: name.slice(0, FILE_NAME_MAX_CHARS) };
          });
        // HOSTS, NOT ONE ORIGIN. A list the caller assembled can span many sites, and the person
        // pressing Save is entitled to know that before they do. A single origin is the special
        // case, not the shape.
        const hosts = [...new Set(picked.map((i) => { try { return new URL(i.url).host; } catch (_) { return '?'; } }))];
        const verdict = await askToSave({
          n: picked.length, total: named.length, origin: hosts.slice(0, HOSTS_SHOWN).join(', ')
            + (hosts.length > HOSTS_SHOWN ? ` +${hosts.length - HOSTS_SHOWN} more` : ''),
          byType: { file: picked.length }, hosts: hosts.length,
        });
        if (!verdict.ok) return { downloaded: 0, approved: false, ...verdict };
        const out = await downloadAll(picked);
        return {
          approved: true,
          downloaded: out.downloaded,
          requested: picked.length,
          ofNamed: named.length,
          hosts,
          ...(bad ? { skippedNotHttp: bad } : {}),
          ...(out.skipped?.length ? { skipped: out.skipped.slice(0, SKIPPED_SHOWN), skippedCount: out.skipped.length } : {}),
          // Named ONLY when it happened, same as `skipped` above — a caller who never sent an X
          // video should not see a `resolvedX: 0` they have to learn means nothing.
          ...(out.resolvedX ? { resolvedX: out.resolvedX } : {}),
          where: 'the browser\'s Downloads folder',
        };
      }
      if (!resultId) {
        return { downloaded: 0, why: 'name either a resultId (to save the assets a deep scan found) '
          + 'or urls (to save addresses you already hold). Either way a person presses Save.' };
      }
      const bag = await chrome.storage.local.get(TABLE_KEY_PREFIX + resultId);
      const held = bag[TABLE_KEY_PREFIX + resultId];
      if (!held) throw new Error(`no such result: ${resultId}`);
      const all = held.items || [];
      if (!all.length) {
        return { downloaded: 0, why: 'that result holds no assets — it is a row table. '
          + 'Assets come from a deep scan in the panel; `results action:"export"` writes the rows instead.' };
      }
      // A caller naming a type that is not there gets told so, rather than a silent zero that reads
      // like the page had no pictures.
      const want = Array.isArray(types) && types.length ? new Set(types) : null;
      const picked = (want ? all.filter((i) => want.has(i.type)) : all)
        .slice(0, Math.max(1, Math.min(DOWNLOAD_HARD_MAX, Number(max) || DOWNLOAD_DEFAULT_MAX)));
      if (!picked.length) {
        const have = [...new Set(all.map((i) => i.type))].sort();
        return { downloaded: 0, why: `no assets of type ${[...want].join(', ')} in that result — `
          + `it holds: ${have.join(', ')}` };
      }
      const byType = {};
      for (const i of picked) byType[i.type] = (byType[i.type] || 0) + 1;
      const verdict = await askToSave({
        n: picked.length,
        total: all.length,
        origin: (() => { try { return new URL(held.url || '').origin; } catch (_) { return held.url || ''; } })(),
        byType,
        resultId,
      });
      if (!verdict.ok) return { downloaded: 0, approved: false, ...verdict };
      const out = await downloadAll(picked);
      return {
        approved: true,
        downloaded: out.downloaded,
        requested: picked.length,
        ofTotal: all.length,
        byType,
        // Named, not counted. A skipped file is a file the person expected to have.
        ...(out.skipped?.length ? { skipped: out.skipped.slice(0, SKIPPED_SHOWN),
          skippedCount: out.skipped.length } : {}),
        ...(out.resolvedX ? { resolvedX: out.resolvedX } : {}),
        where: 'the browser\'s Downloads folder',
      };
    },

    // For a table too big to put in a context window at all. Writes it and hands back the path,
    // which is the only honest answer for six hundred rows of twenty columns.
    'results.export': async ({ resultId }) => {
      const bag = await chrome.storage.local.get(TABLE_KEY_PREFIX + resultId);
      const held = bag[TABLE_KEY_PREFIX + resultId];
      if (!held) throw new Error(`no such result: ${resultId}`);
      const t = (held.tables || []).slice().sort((a, b) => (b.rows?.length || 0) - (a.rows?.length || 0))[0];
      if (!t) throw new Error('that result has no table in it');
      const out = await exportCsv({ rows: t.rows || [], cols: t.cols || [], url: held.url || '' });
      return { file: out?.filename || out?.name || 'download', rows: (t.rows || []).length };
    },
  };

  // EVERY OP THAT NAMES A TAB HOLDS THAT TAB VISIBLE WHILE IT RUNS, AND THAT IS ONE PLACE ON
  // PURPOSE.
  //
  // Chrome does not run IntersectionObserver callbacks, rAF or the paint lifecycle for a tab that
  // is not the active tab of its window. A list that fills itself from an observer therefore stays
  // EMPTY there — and a read of it succeeds, because the elements exist. Measured live on
  // shopee.co.id, the same url in two tabs of one window, minutes apart:
  //
  //   ul.shopee-search-item-result__items > li   active:true    total 60, all 60 populated
  //   the same selector                          active:false   total 60, every row {}
  //
  // The COUNT is identical, which is why nothing we own could catch it: rowsOnPage, the DRY
  // counter, grew:false and `@await ... still` all measure how many elements there are, and there
  // are sixty either way. The person only sees it as the tool being randomly useless — fast and
  // complete when their Shopee tab happened to be in front, ten rows in fifteen minutes when it
  // was behind another one.
  //
  // `withVisibleTab` already existed for this and was wired into page.grow and nothing else, so
  // the panel (which asks for a prepared tab) and the agent (which did not) ran the same engine
  // against two different browsers. Wrapping eighteen more call sites by hand would have lasted
  // exactly until op nineteen; wrapping the dispatch means an op cannot be added without it.
  //
  // Ops with no tabId are untouched — a hold needs a tab, and tabs.list, results.* and run.status
  // have none. `list.extract` is excluded because it RETURNS a runId and keeps walking afterwards:
  // a hold released when the call returns would cover the setup and none of the work, so that one
  // holds inside `hopHere` for the length of the walk instead.
  const HELD_FOR_LONGER = new Set(['list.extract']);
  const held = {};
  for (const [name, fn] of Object.entries(TABLE)) {
    held[name] = HELD_FOR_LONGER.has(name) ? fn : async (args = {}) => {
      const tabId = Number(args?.tabId) || 0;
      if (!tabId) return fn(args);
      // Nested holds are free: `cdpHold` is refcounted, so page.grow keeping its own hold and
      // `lookAt` taking one inside tab.here both cost a single attach between them.
      //
      // AND EVERY REPLY THAT READ A PAGE SAYS WHAT STATE THAT PAGE WAS IN — same place, same
      // reason: `page: { hidden, frames, settled, settleMs, why? }` added here cannot be forgotten
      // by op nineteen. The hold above is CDP lifecycle emulation and measurably does NOT make a
      // background tab paint (0 of 20 record pages on shopee.co.id), so the header is taken
      // INSIDE it: it reports the page as this read actually met it. Ops that know more — a
      // navigation's verdict, a harvest's lanes — build their own and this leaves it alone. Only
      // after the op succeeded, so consent has already been checked by the op itself; and never
      // for a tab the op closed.
      return withVisibleTab(tabId, async () => {
        const out = await fn(args);
        if (!out || typeof out !== 'object' || Array.isArray(out) || 'page' in out || out.closed) return out;
        const page = await headerFor(tabId, null).catch(() => null);
        return page ? { ...out, page } : out;
      });
    };
  }
  return held;
}
