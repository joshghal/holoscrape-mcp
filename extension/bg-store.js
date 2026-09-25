// HoloScrape — service worker: the result store and the visits (sessions) results are filed under.
import { pinnedFor, hopProgress } from './bg-state.js';
import { note } from './bg-log.js';
import { kindFromUrl } from './bg-files.js';

// --- result store ----------------------------------------------------------
// One slot per page. Re-scanning a page REPLACES its slot; it never appends and
// never merges with another page's findings. Distinct pages accumulate as history.
export const HISTORY_MAX = 30;

// --- sessions ---------------------------------------------------------------
// A visit, not a URL. History used to hold one entry per page, unioned forever, so
// coming back to a page a week later added its findings to the old row and there was
// no way to see what THIS visit found — a feed that had rotated its contents read as
// one enormous page. A session is one visit: it survives the passive poll and a
// second press of Deep Scan, and it ends when the page navigates or reloads.
//
// Kept in storage rather than memory because the service worker is evicted whenever
// Chrome feels like it, and a worker restart mid-visit must not split the visit in
// two.
export const newId = () => Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

// The href is NOT the identity of a visit, and on a map it is barely related to one.
// Google Maps keeps the camera and the open place in its own path and rewrites it with
// history.replaceState on every pan, every zoom and every place click:
//
//   /maps/search/cafe/@-6.59,106.79,14z          the rail, zoomed out
//   /maps/search/cafe/@-6.59,106.79,15z          ... after one scroll of the wheel
//   /maps/place/Kopi+Foo/@-6.59,106.79,17z/data=!3m1!4b1   ... after clicking a row
//
// Keying a session on that href meant one visit produced a new session — and so a new
// result id — several times a second. `saveResult` unions only within a session, so the
// union never ran: a scan that found 121 files was replaced by the next poll tick's 47,
// and the 121 stayed orphaned under an id nothing pointed at. That is the whole of the
// "120 became 47, the results are completely gone" report, and our own zoom-out during
// `buyRoom` was one of the things triggering it.
//
// So a visit is pinned to two things that actually define one:
//
//   the document  — a token planted in the isolated world, which a new document cannot
//                   inherit. This is real identity, not a guess: reload and navigation
//                   both get a fresh one, and no same-document rewrite can fake it.
//   the intent    — the href with the volatile parts removed, so that typing a NEW
//                   search (a same-document pushState, same token) still starts a new
//                   visit rather than mixing cafes into the dentists.
//
// It has to be the document token and not `tabs.onUpdated`, because onUpdated cannot
// tell these apart — measured, all four report `{status:'loading', url}`:
//   replaceState · pushState · a real navigation · history.back()
// Filtering that event stream was the obvious fix and it cannot work. See test/session.mjs.
const VOLATILE = [
  [/\/@[-0-9.,]+z?/g, ''],          // the camera
  [/\/data=[^/?#]*/g, ''],          // Maps' opaque view-state blob
  [/\/place\/[^/?#]*/g, '/place'],  // opening a row from the rail is the same visit
  [/[?&]entry=[^&]*/g, ''],         // Maps stamps how you arrived
  // TURNING A PAGE IS THE SAME VISIT — same rule as `/place/` above, and it cost a table.
  //
  // A click-walk saves under the session it started with, on page one. Stop it on page thirteen
  // and the next save computes a visit key ending `/page/13`, finds no previous row for it, and
  // mints a NEW result — so the anti-shrink guard (which only runs when the session matches)
  // never gets a chance, and the panel points at twelve rows where a hundred and thirteen were.
  // Reported as "the first export was replaced when I stopped".
  //
  // The `?stat=` blob is the same class of thing: 2GIS hangs a fresh base64 tracking payload off
  // every result link, so a record reached from the list would otherwise key as its own visit.
  // ORDER MATTERS HERE: `/page/N` is anchored to the end of the string, so the tracking blob has
  // to go first or a `…/page/13?stat=…` keeps its page number and keys as its own visit.
  [/[?&]stat=[^&]*/g, ''],          // 2GIS's per-click tracking blob
  // A VIEW SETTING IS NOT A DIFFERENT VISIT. 2GIS hangs `?immersive=on` off the URL when its
  // immersive-roads toggle is flipped — same search, same list, same page, one letter of map
  // styling. The engine no longer presses that toggle itself (see `findLoadMore`), but the user
  // can, and the cost of the rewrite is out of all proportion to it: the visit key changes, a new
  // session is minted mid-run, and the next page saves into a NEW table while the panel goes on
  // pointing at the old one. The rows keep arriving and the table stops growing.
  [/[?&]immersive=[^&]*/g, ''],
  [/\/page\/\d+\/?$/g, ''],         // page 2..N of one search is one visit
];

export function visitKey(u) {
  let s = normUrl(u);
  for (const [re, to] of VOLATILE) s = s.replace(re, to);
  return s;
}

// TWO ADDRESSES ARE THE SAME PLACE WHEN ONE IS THE OTHER PLUS DETAIL.
//
// This replaces `RECORD_PATH` — a literal `/maps/place/` — which meant the rule held for exactly one
// site and every other self-rewriting page paid for it. What Maps was doing is not special: a list
// that rewrites its address to name the record you are looking at appends to the path and changes
// nothing else. Discourse does it per post (`/t/locations-plugin/69742` -> `…/69742/678`), Twitter,
// Maps, any infinite feed with a "current item". Scrolling back up walks it the other way, so both
// directions count.
//
// What must NOT collapse is two different things asked for. That is why the query string has to
// match exactly and why only whole path SEGMENTS count: `?q=chairs` -> `?q=tables` is two searches,
// and `/search/dentist/…` -> `/search/plumber/…` replaces a segment rather than extending the path.
// Both stay separate visits, which `test/session.mjs` and `test/icon-rail.mjs` assert directly.
//
// Measured cost of the old gate, on meta.discourse.org: a deep scan collected 120 files, the topic
// rewrote its own address as it was read, the next phase computed a different visit key and opened a
// SECOND table, and the panel and the export followed that one — 2 files, then 16. The 120 were on
// disk the whole time under an id nothing pointed at.
function samePlace(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    const x = new URL(a);
    const y = new URL(b);
    if (x.origin !== y.origin || x.search !== y.search) return false;
    const p = x.pathname.replace(/\/+$/, '');
    const q = y.pathname.replace(/\/+$/, '');
    if (p === q) return true;
    // THE ROOT IS NOT THE PARENT OF THE WHOLE SITE.
    //
    // Trimming the trailing slash turns "/" into "", and every path begins with "" + "/" — so a
    // visit that started at a site's front page counted every later page as the same place. Measured
    // by `test/extension.mjs`: an SPA moved from "/" to "/p/1" and the new route inherited all 260 of
    // the previous route's images. A prefix rule needs a prefix; an empty string is not one.
    if (!p || !q) return false;
    return q.startsWith(p + '/') || p.startsWith(q + '/');
  } catch (_) { return false; }
}

// Document identity. The isolated world's global is per-document, so it is gone after a
// reload or a real navigation and survives every same-document rewrite — which is exactly
// the distinction needed. Injected rather than tracked because the worker is evicted at
// Chrome's convenience and must be able to re-derive this from scratch.
export async function docToken(tabId) {
  if (tabId == null) return '';
  try {
    const [hit] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => {
        if (!window.__hsDoc) {
          window.__hsDoc = Math.random().toString(36).slice(2) + Date.now().toString(36);
        }
        return window.__hsDoc;
      },
    });
    return hit?.result || '';
  } catch (_) {
    // A restricted page, or the tab went away mid-flight. Falling back to the stripped
    // href keeps a visit coherent on ordinary sites; it is only Maps-class URL rewriting
    // that needs the token, and Maps is injectable.
    return '';
  }
}

export async function visitId(tabId, pageUrl) {
  const doc = await docToken(tabId);
  return (doc ? doc + '|' : '') + visitKey(pageUrl);
}

// A RECORD'S PAGE IS NOT A VISIT OF ITS OWN, and stripping the place NAME was not enough.
// `/maps/search/plumber+in+Austin` and `/maps/place/Foo` share no path at all, so once the
// details pass had a record open, the next save keyed on a different visit and minted a new id
// mid-run — measured, at 09:32:27 of a 124-record pass: `msfvtoxl2t8` became `msfw1yuix` and the
// finished table was filed under an id the panel was no longer pointing at.
//
// Which visit a record belongs to cannot be read off its own URL, so it is not guessed: the
// document token already proves this is the same document, and a record reached inside that
// document belongs to whatever visit is open in it.
const RECORD_PATH = /\/maps\/place\//;

// IS THE TAB STILL AT THE PLACE THE HELD VISIT WAS OPENED FOR?
//
// One predicate with two callers, and they used to disagree. `sessionFor` asked it properly; the
// passive poll in `scanSession` asked only "same document?" and joined whatever it found — which is
// right for a page that rewrites its own address as it is read, and wrong for a single-page app,
// where a route change IS a new page and never replaces the document. Measured by
// `test/extension.mjs`: an SPA moved from `/` to `/p/1`, the poll joined the visit it found, and all
// 260 of the previous route's images unioned into the new route's table.
//
// Three ways to still be in the same place, and none of them is "the document did not reload":
//   - the address extends or trims the held one, segment-wise (`samePlace` — a list naming the
//     record it is showing, a topic naming the post you scrolled to)
//   - a Maps record, whose normalised path replaces the list's rather than extending it
//   - the run itself claimed this address, because its own scrolling or a wall moved the page there
export function sameSpot(held, pageUrl) {
  const wantKey = visitKey(pageUrl);
  return RECORD_PATH.test(String(pageUrl || ''))
    || samePlace(held?.url, wantKey)
    || (held?.hold || []).some((h) => samePlace(h, wantKey));
}

export async function sessionFor(tabId, pageUrl) {
  const doc = await docToken(tabId);
  // A PIN IS PART OF WHAT WAS ASKED FOR, SO IT IS PART OF THE VISIT.
  //
  // The key was document + URL, which reads "one visit to one page" — right for a poll re-reading
  // what it read before, and wrong for two runs that named two different containers. Measured:
  // `list_extract` pinned the server rail, then pinned it again by another selector, and both runs
  // came back with the SAME resultId holding 46 rows — the two lists unioned into one table,
  // `run_status` reporting done over it. A caller who names a container is stating an intent, and
  // two different intents are two tables; the same container named twice is still one visit and
  // still unions, which is what every existing caller relies on.
  const pinned = pinnedFor.get(tabId) || '';
  const key = (doc ? doc + '|' : '') + visitKey(pageUrl) + (pinned ? '|pin:' + pinned : '');
  const { sessions = {} } = await chrome.storage.local.get('sessions');
  const held = sessions[tabId];
  if (held && held.key === key) return held.sid;
  // A WALK OWNS THE VISIT FOR AS LONG AS IT RUNS.
  //
  // Paging that really navigates — a plain `?page=2` link, which is most of the web — gives every
  // page a new document AND a new URL, so both halves of the key change and this mints a fresh
  // visit per page. Measured on a five-page etsy run: five ids, `msko0cnc6y7`, `msko0ij47a`,
  // `msko0pwb36w`, `msko0vyq60r`, each holding that one page's 60 rows, five junk history entries
  // beside them — and the panel's per-page commit ADOPTED the newest, so the screen showed one
  // page while the run accumulated somewhere the person could not see it.
  //
  // `holdSession` already makes this claim for a challenge ("a challenge replaces the document
  // and it is still the same run"). This is the same claim for the navigation the walk itself
  // caused, and it needs no URL bookkeeping because the walk announces itself: `hopProgress`
  // holds an entry for exactly the tabs a walk is running in, and its `finally` removes it. A
  // walk cannot outlive it — if the worker is evicted the walk dies with it.
  if (held?.sid && hopProgress.has(tabId)) return held.sid;
  // Same document, and the path only changed because the list opened one of its own records.
  // DELIBERATELY NARROW. Widening this to "any same-document url change is the same visit" was
  // tried and reverted the same hour: it made a SEARCH-driven SPA union two different searches
  // into one table (`test/session.mjs` "a different search starts a new visit", `test/icon-rail.mjs`
  // "a second run returns its OWN result id" — both went red, both correctly). "Same document" does
  // not mean "same intent". The thing that actually distinguishes a page rewriting its own address
  // while WE scroll it from a person asking for something else is WHO moved it, and that is what
  // the `hold` list below records — claimed by the run that caused the drift, never by anything else.
  // ADDITIVE, ON PURPOSE. `RECORD_PATH` stays: a Maps list normalises to `/maps/search/<term>` and
  // its record to `/maps/place`, so neither extends the other and `samePlace` correctly calls them
  // different — removing the older rule to make room for the newer one would have re-broken
  // `test/session.mjs` "opening a record stays inside the visit", which is how this line got its
  // second clause rather than a replacement.
  const wantKey = visitKey(pageUrl);
  if (held && doc && held.doc === doc && (held.pin || '') === pinned && sameSpot(held, pageUrl)) return held.sid;
  // A CHALLENGE REPLACES THE DOCUMENT, AND IT IS STILL THE SAME RUN.
  //
  // This is the whole of "when the user slid, the data table was reset". Alibaba answers the
  // walk's next-page request WITH its slider — a real navigation, so the token this key is built
  // from is gone — and then answers the slide with another one. Three documents, one visit, and
  // without this line three history rows: the run's rows stranded under the first, the panel
  // bound to the third, and "I have cleared it — carry on" appending to an empty table.
  //
  // Held for the pages of the run that hit the wall and nothing else (`holdSession` writes the
  // list's URL and the challenge's, both stripped by `visitKey`), so a person who gives up and
  // browses elsewhere in that tab still gets a clean visit. Measured by `test/wall-session.mjs`
  // in both directions.
  if (held && held.hold?.includes(visitKey(pageUrl))) return held.sid;
  // The token is a STRONGER signal than the URL, so losing it must never look like a new visit.
  // `docToken` returns '' for a restricted page or a tab that went away mid-flight, and treating
  // that as a change would split a visit for a reason that is not about the page at all.
  if (held && !doc && held.key.endsWith('|' + visitKey(pageUrl))) return held.sid;
  // WHY A VISIT WAS SPLIT, because "a new id appeared" is not a diagnosis.
  //
  // Every rows-stranded report so far — Alibaba's slider, the Maps record pass, eBay's unnamed
  // interstitial — arrives as the same sentence ("the list never got appended") and the same
  // evidence (several history rows for one run). The log records the ids and NOT ONE WORD about
  // which of the checks above declined, so every one of them has been diagnosed by reading this
  // function and guessing. eBay cost three fixture rewrites that way: each guess reproduced a
  // split, none of them reproduced THIS split, and all three went green against the bug.
  //
  // So the mint says what it saw. `held`/`want` are the two keys compared, truncated because a
  // document token is long and only its equality matters; `hold` is whether a wall or a blind
  // page had claimed the url; `walk` is whether a walk still owned the tab.
  const sid = newId();
  note('session.new', {
    sid,
    why: !held ? 'nothing held' : held.doc !== doc ? 'document changed' : 'url changed',
    held: held ? String(held.key).slice(-46) : '',
    want: String(key).slice(-46),
    hold: held?.hold ? held.hold.length : 0,
    walk: hopProgress.has(tabId),
  });
  sessions[tabId] = { key, doc, sid, url: wantKey, pin: pinned };
  await chrome.storage.local.set({ sessions });
  return sid;
}

// KEEP A VISIT ACROSS A NAVIGATION WE OURSELVES MADE.
//
// `sessionFor` is built to treat a new document as a new visit, and that is right for a person
// browsing. It is wrong for the one navigation this extension performs on its own behalf: the
// "put the tab back where you left it" at the end of a click-walk. Measured on a 12-page 2GIS
// run — `here.end pages=12 rows=115` under `msj88jzl245`, and twenty milliseconds later the
// passive poll saved `msj8a17f57t`, because the restore had replaced the document and minted a
// new sid. The record pass then asked `savedTablesFor`, the sid lookup SUCCEEDED against the new
// thirteen-row record, and 12 firm pages were fetched perfectly and filed against rows that were
// not there: `2gis.unmatched short=12`, `filled=0 lost=12`.
//
// Note what that means for the search-URL fallback below it — it never ran, and could not have.
// It is guarded on the sid lookup MISSING, and the lookup hit.
//
// So the walk carries its own session over the restore. The tab is where the person left it and
// the run is still the run.
export async function keepSession(tabId, pageUrl, sid) {
  if (!sid) return;
  const doc = await docToken(tabId);
  const { sessions = {} } = await chrome.storage.local.get('sessions');
  const held = sessions[tabId];
  // AND THE VISIT'S BASE ADDRESS SURVIVES THE RESTORE.
  //
  // `url` is the thing `samePlace` compares a drifted address AGAINST, and this wrote an entry
  // without one — so after any walk, a page that rewrites its own address as it is read had nothing
  // to be compared to. `samePlace(undefined, ...)` is false, so the next read minted a new visit and
  // the run's rows were stranded under the previous id. That is the 97->21 split again, and it
  // survived the fix to the drift rule itself because it is not a fault in that rule: the base was
  // being ERASED a moment before the rule was asked.
  //
  // Measured on meta.discourse.org through `list_extract`, which reaches here via `hopHere`: a read
  // at `/t/locations-plugin/69742` and a second read after the topic had rewritten itself to
  // `…/69742/502` came back as two tables. The session log named it exactly — `session.new
  // why="url changed" held=…/69742 want=…/69742/502` — over a held entry whose `url` was gone.
  //
  // Carried from the entry being replaced only when it is the SAME run, because what belongs here is
  // where the visit OPENED, not wherever the restore happened to land. `hold` is still dropped on
  // purpose: see the note below, where a clean walk ending a wall's hold is the intended behaviour.
  const url = (held && held.sid === sid && held.url) || visitKey(pageUrl);
  sessions[tabId] = { key: (doc ? doc + '|' : '') + visitKey(pageUrl), doc, sid, url };
  await chrome.storage.local.set({ sessions });
}

// KEEP A VISIT ACROSS A NAVIGATION THE SITE MADE *AT* US.
//
// `keepSession` pins one document, which is enough for our own restore because we know how many
// navigations there are: one. A challenge is different — it costs at least two, the site's and
// the person's, and the second happens minutes later while nothing of ours is running. Pinning
// the document the slider arrived in would survive the first and lose the second.
//
// So the visit is held by URL for the duration instead: the page the run was reading and the page
// the site put up. Both are `visitKey`ed, so the query juggling a challenge does on the way back
// does not break the match. It ends by itself — the next `keepSession` after a clean walk writes
// an entry with no `hold`, and anywhere else in that tab misses the list and mints a new visit.
// A WALK MOVES THE PAGE, AND SOME PAGES REWRITE THEIR URL WHEN THEY MOVE.
//
// A visit is keyed on the URL, so a page that replaceState's its own address as you scroll splits
// the run in two: the walk finishes, the save asks which visit this is, the URL no longer matches,
// and a NEW id is minted for the table that was just gathered. The panel goes on pointing at the
// old id, its next poll reads the tab fresh, and the person is handed an UNWALKED table over the
// walked one. Measured on a 733-post Discourse topic: 69 rows walked under `mt39gcmn3ob`, then 71
// rows with hops=0 under `mt39gd2i7g0`, and the export was the second one.
//
// This was already known and already fixed twice, both times for one site: `VOLATILE` strips
// 2GIS's `?stat=`/`?immersive=` and a trailing `/page/N`, and `RECORD_PATH` waives the URL check
// for `/maps/place/`. Neither could help a site nobody had met yet, and a list of patterns never
// will — Discourse appends the post number, and the next site will do something else.
//
// So the visit is anchored to where the run STARTED, which is the page the person actually asked
// about, and the address it drifted to is CLAIMED through the same `hold` mechanism a challenge
// already uses. Nothing about the URL's shape is consulted, so this holds on any site.
export async function walkSession(tabId, startedAt, walked) {
  const sid = await sessionFor(tabId, startedAt);
  if (!walked || !sid) return sid;
  const ended = (await chrome.tabs.get(tabId).catch(() => null))?.url || '';
  // Only when it actually moved, and only within one document — a real navigation is a new visit
  // and must stay one. `holdSession` re-reads the token itself; this is the cheap early exit.
  if (!ended || visitKey(ended) === visitKey(startedAt)) return sid;
  await holdSession(tabId, sid, [startedAt, ended]);
  note('walk.drifted', { from: visitKey(startedAt).slice(-46), to: visitKey(ended).slice(-46), sid });
  return sid;
}

export async function holdSession(tabId, sid, urls) {
  if (!sid) return;
  const doc = await docToken(tabId);
  const { sessions = {} } = await chrome.storage.local.get('sessions');
  const held = sessions[tabId];
  // THE CLAIM ACCUMULATES. It used to be replaced, and that lost the address the run STARTED at.
  //
  // Measured on meta.discourse.org: a deep scan opened its visit at `/t/locations-plugin/69742`,
  // its own scrolling rewrote the address to `…/542`, so the media phase claimed [69742, 542]. The
  // rows phase then drifted 542 -> 601 and claimed [542, 601] — dropping 69742 entirely. The run
  // finishes by scrolling back to the top (`gohome`), the address returns to 69742, and the very
  // next poll found it claimed by nothing, minted a NEW visit, and filed the one screenful it could
  // see there — 21 files — as the record the panel and the export then followed. The 97 the scan had
  // gathered were still on disk under the previous id, orphaned. Reported as "the list is broken",
  // and it was.
  //
  // Only within one document: a real navigation is a new visit and every url a previous document
  // claimed is irrelevant to it, so the list starts clean rather than carrying stale addresses that
  // would silently glue two visits together.
  const prior = held && held.sid === sid && doc && held.doc === doc ? (held.hold || []) : [];
  const hold = [...new Set([...prior, ...(urls || []).filter(Boolean).map(visitKey)])];
  const pin = held && held.sid === sid ? (held.pin || '') : '';
  sessions[tabId] = { key: (doc ? doc + '|' : '') + hold[0] + (pin ? '|pin:' + pin : ''), doc, sid, hold, url: hold[0], pin };
  await chrome.storage.local.set({ sessions });
}

// Only a closed tab ends a session now. A visit that ends because the page really did
// navigate ends by itself: the document token changes, the key stops matching, and
// `sessionFor` mints the next one. There is deliberately no `tabs.onUpdated` listener
// here — the one that used to live here fired on Maps' own URL rewrites and wiped the
// session mid-scan, which is the bug this section exists to prevent.
export async function endSession(tabId) {
  const { sessions = {} } = await chrome.storage.local.get('sessions');
  if (!sessions[tabId]) return;
  delete sessions[tabId];
  await chrome.storage.local.set({ sessions });
}

chrome.tabs.onRemoved.addListener((tabId) => endSession(tabId));

// ONE WRITER AT A TIME, because this is read-modify-write and there are several writers.
//
// `saveResultNow` reads `table:<id>`, merges the new rows into what it finds, and writes the
// result back. Nothing made that sequence exclusive, and during a walk there are at least two
// callers going at once: the walk saving the page it just read, and the panel's per-page commit
// (plus a passive scan every 2.5s). The commit reads the store, is correctly REFUSED by the
// shrink guard — and then writes its own stale copy back, over the page the walk had just added.
//
// Measured by `test/kept.mjs` the moment the walk's writes stopped being refused for other
// reasons: `here.read` reached 35 rows, the live counter agreed, and storage held 23. The lost
// update had been there all along, hidden behind a guard that was throwing the walk away anyway.
//
// A queue rather than a lock: every call still happens, in the order it was made, and each one
// reads what the one before it wrote. Failures do not stall the chain.
let saveGate = Promise.resolve();

export function saveResult(out, pageUrl, sid) {
  const mine = saveGate.then(() => saveResultNow(out, pageUrl, sid),
    () => saveResultNow(out, pageUrl, sid));
  saveGate = mine.catch(() => {});
  return mine;
}

async function saveResultNow(out, pageUrl, sid) {
  const { history = [] } = await chrome.storage.local.get('history');
  const key = normUrl(pageUrl);
  // Matched on the session, not the page. Two visits to one URL are two rows.
  const prev = sid ? history.find((h) => h.sid === sid) : null;
  const id = prev?.id || newId();
  const scannedAt = new Date().toISOString();

  // Within one visit a page only accumulates, so a later scan is nearly always a
  // superset — but not always. A passive poll cannot see what a deep scan opened,
  // and a carousel that has moved on no longer holds the image it showed a minute
  // ago. Union WITHIN THE SESSION keeps both: nothing found during this visit is
  // lost to a rescan, and nothing from a previous visit is smuggled into it.
  if (prev) {
    const old = (await chrome.storage.local.get('table:' + id))['table:' + id];
    if (old?.items?.length) {
      // ORDER IS PART OF THE ANSWER: WHAT WAS ALREADY THERE STAYS WHERE IT WAS.
      //
      // This used to be `[...fresh, ...old-not-in-fresh]`, which reads as "newest first" and is
      // wrong for a list that GROWS. Anything the fresh pass did not happen to re-see — a favicon
      // found through a <link>, a carousel image that has rotated away — was moved to the END, and
      // every row after its old position shifted. Measured on a page that went from 6 pictures to
      // 16: the favicon travelled from index 6 to index 16, so the results window correctly refused
      // to append silently (it would have moved rows under the cursor) and put up its button
      // instead. The person then had to click "show them" for every batch of a live scan.
      //
      // So: keep the previous order, let the fresh pass UPDATE the entries it re-measured, and
      // append only what is genuinely new. A growing list then grows at the bottom, which is what
      // makes appending safe without asking.
      const fresh = new Map(out.items.map((i) => [i.url, i]));
      const had = new Set(old.items.map((i) => i.url));
      out = {
        ...out,
        items: [
          // Fresh data wins on an item we already had — a later pass may have measured dimensions
          // or bytes the first one could not — but its POSITION is the one it already occupied.
          ...old.items.map((o) => (fresh.has(o.url) ? { ...o, ...fresh.get(o.url) } : o)),
          ...out.items.filter((i) => !had.has(i.url)),
        ],
        // Deep coverage is a property of what has ever been done to this page,
        // so a passive poll must not reset the flag to false.
        coverage: { ...old.coverage, ...out.coverage, deep: !!(out.coverage?.deep || old.coverage?.deep) },
      };
    }
    // Files and tables are two views of one page and share a history entry, so
    // each must survive the other being re-run. A media rescan that dropped the
    // saved tables would look like the extraction had failed.
    if (old?.tables?.length && !out.tables?.length) out = { ...out, tables: old.tables };
    // AND A RE-READ MUST NOT SHRINK ONE.
    //
    // Measured, 105 seconds after a 124-record details pass finished: pressing "Open results" ran
    // an `extractAll` whose walk was skipped by the eight-second memo, so it read only the rows
    // still MOUNTED in a virtualised rail — 25 of 124 — and `saveResult` replaced the table with
    // them. The rows were not gone from the list; they were gone from the DOM, which is not the
    // same thing and is not something to save.
    //
    // Within one visit a list only grows. A shorter read is the virtualizer, never the truth, so
    // the fuller table wins — the same rule the column namer uses for a collision.
    else if (old?.tables?.length && out.tables?.length) {
      const rowsIn = (t) => (t || []).reduce((a, x) => a + (x.rows?.length || 0), 0);
      // WIDEST IS NOT THE SAME AS THE ONE THAT MATTERS. `colsIn` takes the maximum across every
      // table on the page, and a 2GIS search page has two: the list, and a 53-column side table.
      // So when the record pass had merged the list up to 50 columns and the re-extract handed
      // back 24, the maximum was 53 either way — the guard saw no loss and let the replacement
      // through. `2gis.merged cols=50+53` in the log, then `save action=dtables rows=12`, and the
      // details were gone with no `save.keptWider` to say so.
      //
      // So the LIST is compared as well: the table with the most rows is the one the user is
      // looking at, and it losing columns is the loss worth refusing.
      const colsIn = (t) => (t || []).reduce((a, x) => Math.max(a, x.cols?.length || 0), 0);
      const listCols = (t) => (((t || []).slice()
        .sort((a, x) => (x.rows?.length || 0) - (a.rows?.length || 0))[0] || {}).cols || []).length;
      const had = rowsIn(old.tables);
      const now = rowsIn(out.tables);
      // A RECORD'S PANEL IS NOT THE LIST, and it extracts as a table too.
      //
      // Seen in a real export: a saved rail of 124 rows replaced by **29 rows and 124 columns** —
      // a place's review section, read off the panel the details pass had left open. Nearly every
      // column is empty for nearly every row, so the results window drew "29 rows · 0 columns ·
      // 124 hidden": a table of nothing where the list used to be.
      //
      // The row count alone does not catch it — a place with 200 reviews has more rows than a
      // 124-row list — so the KIND of page is checked as well. A re-read is `extractAll`, which
      // goes and reads whatever the tab is showing; the pass's own handover is `dtables`, which is
      // bound to the list it started on and is deliberately exempt, because that write is what
      // carries the gathered details into the table.
      const reread = out.from === 'extractAll' || out.from === 'pagehop';
      // A WALK IS NOT A RE-READ, AND BOTH GUARDS BELOW WERE CATCHING IT.
      //
      // Everything under this branch exists to stop a read of the LIVE PAGE replacing a fuller
      // stored table. A walk is the opposite motion: it carries every page it has read, and the
      // table it offers is the accumulation, not a snapshot of whatever the tab is showing.
      //
      // Measured on a five-page etsy run (`ETSY-TABLE-FREEZE.md`). Every write the walk offered
      // was refused, and `had=76` did not move once in ninety seconds while `here.read` climbed
      // to 295. Two different guards did it, for two reasons that both look like loss and are not:
      //
      //   ROWS — page one handed back 59 where the scan had 60, because the list repeats one
      //          entry across two ad slots and `rowIdentity` collapsed it. `keptFuller` refused,
      //          and from then on every later page was compared against the FROZEN scan instead
      //          of against the walk's own previous page.
      //   COLS — 18 became 16, because `foldOrphans` folds a card template's variants (a sale
      //          price and a plain price are one column, filled on disjoint rows) and it can only
      //          see them once several pages are combined. That narrowing is the whole point of
      //          calling it; `keptWider` read it as damage.
      //
      // So the walk is exempt, and it is safe to exempt because it no longer shrinks: it seeds
      // itself from this visit's stored rows before its first write (`here.kept`). Refused or
      // not, the comparison is still recorded — a walk that really does go backwards is a fault
      // worth seeing, and silence is how the last one lasted this long.
      const walked = out.from === 'walk';
      const thinner = now < had || colsIn(out.tables) < colsIn(old.tables)
        || listCols(out.tables) < listCols(old.tables);
      if (walked) {
        if (thinner) {
          note('save.walkKept', { had, now, cols: colsIn(old.tables), gave: colsIn(out.tables),
            list: listCols(old.tables), listGave: listCols(out.tables),
            why: 'the walk carries every page it has read, so a re-read guard does not apply' });
        }
      } else if (reread && RECORD_PATH.test(pageUrl || '')) {
        note('save.notTheList', { from: out.from || '', had, now, cols: colsIn(out.tables),
          why: 'a re-read on a record page cannot replace the list' });
        out = { ...out, tables: old.tables };
      } else if (now < had) {
        note('save.keptFuller', { from: out.from || '', had, now,
          why: 'a re-read returned fewer rows than are saved' });
        out = { ...out, tables: old.tables };
      } else if (colsIn(out.tables) < colsIn(old.tables)
                 || listCols(out.tables) < listCols(old.tables)) {
        // A RE-READ SHRINKS BY COLUMNS TOO, and only rows were being guarded.
        //
        // This is what "step 2 changed step 1's result" was, and why the contacts kept vanishing
        // from a single-page run. The 2GIS pass merges its records into the SAVED table and then
        // asks the page for `lastTables()` so the card can report on it — and `dtables` re-extracts
        // the LIVE page, which has thirteen rows and no `@` columns because the details were never
        // put in the page's bag. Thirteen is not fewer than thirteen, so the guard let it through
        // and the re-extraction replaced the merged table: measured, `opened=5 filled=5 lost=0`
        // and `cols 29 → 29`, with every contact written and then wiped a moment later.
        //
        // It also silently REORDERED what survived: a re-extract derives its column order afresh
        // (first-seen across rows, then by kind, then `nameCols`), so step 1's table came back with
        // its columns shuffled — the same event, reported as two symptoms.
        //
        // The rule was always "within one visit a list only grows"; it was just being measured on
        // one axis. A read that returns fewer columns has lost something.
        //
        // AND IT IS CHECKED WHATEVER THE ROW COUNT DID — which was the hole in the first version.
        // Guarded on `now === had`, a re-extract that happened to find one MORE row than is stored
        // (an ad card mounting late, a virtualiser handing back a different slice) sailed straight
        // past and replaced the merged table anyway: contacts gone, column order rebuilt from
        // scratch. Reported as "text dominant after step 2, also table completely reorder". More
        // rows is not a licence to drop columns.
        note('save.keptWider', { from: out.from || '', had, now, cols: colsIn(old.tables), gave: colsIn(out.tables),
          list: listCols(old.tables), listGave: listCols(out.tables),
          why: 'a re-read returned fewer columns than are saved' });
        out = { ...out, tables: old.tables };
      }
    }
  }

  await chrome.storage.local.set({
    ['table:' + id]: { ...out, id, url: pageUrl, key, scannedAt },
  });

  const entry = {
    id, sid, key, url: pageUrl, scannedAt,
    count: out.items.length,
    types: out.items.reduce((a, i) => ((a[i.type] = (a[i.type] || 0) + 1), a), {}),
    deep: !!out.coverage?.deep,
    // Counted separately: a page can have tables and no files, and a history row
    // reading "0" for 200 extracted rows is just wrong.
    tables: out.tables?.length || 0,
    rows: (out.tables || []).reduce((a, t) => a + t.rows.length, 0),
  };
  // Replaces this session's row, not every row for this page.
  const next = [entry, ...history.filter((h) => h.sid !== sid || !sid)].slice(0, HISTORY_MAX);
  const dropped = history.filter((h) => !next.some((n) => n.id === h.id));
  await chrome.storage.local.set({ history: next });
  if (dropped.length) await chrome.storage.local.remove(dropped.map((d) => 'table:' + d.id));
  // The merged result, not the caller's: a poll that returned only its own fresh
  // items would look to the panel like the deep scan's finds had vanished.
  return { id, result: out };
}

// THE NETWORK'S ANSWER, IN THE SHAPE THE RECORD ALREADY USES — the sibling of `itemsFromTables`.
//
// Why the page reader cannot answer this on its own: it reads `img`, `srcset` and `link` off the
// document as it stands, and on anything that recycles most of the document has never stood. A
// 733-post topic mounts about two posts, so walking it collected one post's pictures while the
// browser's own Img filter listed 42 requests for the same tab at the same moment. The files were
// fetched; they were just no longer in the DOM when anything looked.
//
// Merged BY URL, so a picture the page reader already described keeps the dimensions it measured
// and only what it never saw is added. `source: 'network'` so an export says where each row came
// from, and `measured: false` because nothing here decoded the file — inventing `w`/`h` would put a
// guess in a column the other path fills by measuring.
export function itemsFromNet(items, st, pageUrl) {
  if (!st || !st.hits?.size) return 0;
  // THE TWO LAYERS KNOW DIFFERENT THINGS, SO THEY COMPLETE EACH OTHER RATHER THAN COMPETE.
  //
  //   the DOM knows   what the picture IS — measured width and height, its alt, the row it belongs
  //                   to, and which urls are the SAME picture at other sizes (`variants`, already
  //                   grouped from srcset)
  //   the wire knows  that it was fetched AT ALL — which is the only way to see a picture the walk
  //                   scrolled past — plus its real transferred size, mime and status
  //
  // Matching on the primary url alone made them compete instead: a responsive image appears on the
  // wire as `…_2_690x355.jpeg` while the DOM item's url is `…_2_1380x584.jpeg` with the first sitting
  // in its `variants`. Same file, counted twice, and the second copy carried none of the dimensions
  // the first had measured. Measured against a hand-collected list: 79 of 114 matched by url, 100 of
  // 109 by picture.
  //
  // So every url the DOM already knows about — primary AND variant — is an index into the item that
  // owns it. A hit that lands on one ENRICHES that item; only a hit nothing knows about becomes a new
  // row. Nothing site-specific: `variants` is whatever the page's own srcset said.
  const owner = new Map();
  for (const it of items || []) {
    if (it.url) owner.set(it.url, it);
    for (const v of it.variants || []) if (v?.url) owner.set(v.url, it);
  }
  let added = 0;
  let enriched = 0;
  // DECIDED HERE, NOT AT CAPTURE. Three independent signals, because any one of them can be wrong
  // on its own: the resource type CDP assigned, the mime the server sent, and the extension on the
  // path. An svg served as text/xml fails the first two and passes the third; an extensionless CDN
  // upload passes the first two and fails the third. Requiring all three would drop both.
  const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?)(\?|#|$)/i;
  const looksImage = (hit) => hit.kind === 'Image'
    || /^image\//.test(hit.mime || '')
    || IMG_EXT.test(hit.url || '');
  for (const hit of st.hits.values()) {
    if (!hit.url || !looksImage(hit)) continue;
    const known = owner.get(hit.url);
    if (known) {
      // CONFIRMED ON THE WIRE, and told so. The DOM can list a url the browser never fetched — a
      // lazy `data-src`, a srcset candidate the viewport never chose — and that difference matters
      // to anyone about to download the list. `bytes` is filled only when the DOM had not measured
      // it, because a measured size came from the file itself and outranks a transfer count.
      if (!known.fetched) { known.fetched = true; enriched++; }
      if (!known.bytes && hit.bytes) known.bytes = hit.bytes;
      if (!known.mime && hit.mime) known.mime = hit.mime;
      if (hit.status && hit.status >= 400) known.httpStatus = hit.status;
      continue;
    }
    let name = '';
    try { name = decodeURIComponent(new URL(hit.url).pathname.split('/').pop() || ''); } catch (_) {}
    // THE INDEX MUST HOLD THE ITEM, NEVER A MARKER.
    //
    // This used to be `owner.set(hit.url, true)` — a flag meaning "already added". `st.hits` is keyed
    // by REQUEST id, so one url fetched twice is two hits, and the second one found `true` in the
    // index and ran `known.fetched = true` on a boolean: TypeError, in strict mode, which killed the
    // whole scan. Any page that requests one image twice — a re-used avatar, a re-mounted thumbnail,
    // a cache miss on a second pass — was enough. Storing the item makes the repeat hit do the same
    // useful thing as any other known url: enrich the row that is already there.
    const made = {
      url: hit.url,
      type: (hit.mime.split('/')[0] || 'image'),
      source: 'network',
      title: '',
      name: name.slice(0, 140),
      tags: ['fetched'],
      page: pageUrl || '',
      variants: [{ url: hit.url, label: hit.mime.split('/')[1] || '' }],
      ...(hit.bytes ? { bytes: hit.bytes } : {}),
      measured: false,
      fetched: true,
    };
    items.push(made);
    owner.set(hit.url, made);
    added++;
  }
  return { added, enriched };
}

export function itemsFromTables(tables, pageUrl) {
  const out = [];
  const seen = new Set();
  for (const t of tables || []) {
    const assetCols = (t.cols || []).filter((c) => c.kind === 'asset');
    if (!assetCols.length) continue;
    const textCols = (t.cols || []).filter((c) => c.kind !== 'asset' && c.kind !== 'link');
    for (const row of t.rows || []) {
      // The row's own name, and never a URL masquerading as one.
      let title = '';
      for (const c of textCols) {
        const v = row[c.key];
        if (v && !/^https?:|^data:/.test(v) && v.length > 2) { title = v.slice(0, 120); break; }
      }
      // A card that offers a video shows a picture of it. That picture is in THIS
      // row — the site's own poster frame, already downloaded and already the right
      // size — so a video never needs a grey play tile, and nothing extra is
      // fetched to prove it. Images are their own preview, so they are excluded.
      let poster = '';
      for (const c of assetCols) {
        const v = row[c.key];
        if (v && /^https?:/.test(v) && kindFromUrl(v) === 'image') { poster = v; break; }
      }
      for (const c of assetCols) {
        const url = row[c.key];
        if (!url || !/^https?:/.test(url) || seen.has(url)) continue;
        seen.add(url);
        const type = kindFromUrl(url);
        out.push({ url, type, title, source: 'row', page: pageUrl, tags: [],
          ...(type !== 'image' && poster ? { poster } : {}) });
      }
    }
  }
  return out;
}

// Same page, different scroll position or tracking params = same page.
export function normUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid']
      .forEach((p) => x.searchParams.delete(p));
    return x.href;
  } catch { return String(u || ''); }
}

// Only the CURRENT session's result. Without the session check, arriving at a page
// scanned last week repopulated the panel with those findings and the next scan
// merged into them — which is exactly the appended-history the session split exists
// to prevent.
export async function getResultFor(pageUrl, tabId) {
  const { history = [] } = await chrome.storage.local.get('history');
  const { sessions = {} } = await chrome.storage.local.get('sessions');
  const held = tabId != null ? sessions[tabId] : null;
  // The same visit identity the session was filed under. Comparing the raw href here
  // meant that after one pan of the map the panel could no longer find the result it
  // had just saved, and answered with nothing — the "results are completely gone" half
  // of the report, separate from the loss in `saveResult` but caused by the same mistake.
  const key = held ? await visitId(tabId, pageUrl) : '';
  const hit = held && held.key === key
    ? history.find((h) => h.sid === held.sid)
    : null;
  if (!hit) return null;
  const store = await chrome.storage.local.get('table:' + hit.id);
  return store['table:' + hit.id] || null;
}

export async function clearHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  await chrome.storage.local.remove([...history.map((h) => 'table:' + h.id), 'history']);
  return { ok: true };
}
