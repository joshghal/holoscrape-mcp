  // HoloScrape row engine — turns a page's repeating structure into a table.
  //
  // Runs inside the page's own JS world and must stay fully self-contained:
  // chrome.scripting.executeScript serialises this function to source, so no
  // imports, no closures over module scope.
  //
  // Written from observed behaviour of the category's simplest tool, not from its
  // code. The shape worth keeping is the interaction, not the implementation:
  // guess, show the guess on the page, and make being wrong cost one click.
  //
  // Stateful across calls. `detect` builds the candidate list and parks it on
  // window; `cycle`, `extract`, `scroll` and `clear` all act on that list. The
  // element references stay live, which is why the candidate list cannot be
  // serialised back to the worker — only summaries cross the boundary.

  const S = '__holoscrapeRows';

  // --- rows fetched from other pages ------------------------------------------
  // Keyed by the container ELEMENT, not by the candidate object that happens to wrap it
  // this time round. `detect()` builds fresh candidates on every call and the passive
  // poll calls it every few seconds, so extras parked on a candidate were silently
  // dropped within seconds of a hop — the files they contributed stayed in the results
  // window while their rows vanished from the table. The element outlives every
  // detection; the candidate does not.
  const HOP = '__holoscrapeHopped';
  const hopStore = () => (window[HOP] = window[HOP] || new WeakMap());
  const hopFor = (el, make) => {
    const m = hopStore();
    if (!m.has(el) && make) m.set(el, { rows: [], bases: new Map(), foreign: [], details: new Map() });
    const bag = m.get(el);
    if (bag && !bag.foreign) bag.foreign = [];
    if (bag && !bag.details) bag.details = new Map();
    return bag || null;
  };
  const extraOf = (c) => (c && c.el ? (hopStore().get(c.el)?.rows || []) : []);
  // Rows read in ANOTHER tab, already reduced to cells. Same store, same reason: they were
  // parked on the candidate object, and `detect()` builds fresh candidates every time it
  // runs — which the passive poll does every couple of seconds. Six pages and 290 rows were
  // gathered correctly and then wiped within seconds of arriving, over and over, which is
  // why the table never grew. The element outlives every detection; the candidate does not.
  const foreignOf = (c) => (c && c.el ? (hopStore().get(c.el)?.foreign || []) : []);
  // What opening each row said about it, keyed by the row's own identity rather than by
  // its position: a feed re-orders and re-renders, and the fifth card an hour later is not
  // the fifth business. Same store, same reason as the two above.
  const detailsOf = (c) => (c && c.el ? (hopStore().get(c.el)?.details || new Map()) : new Map());

  // --- whose state is this? ---------------------------------------------------
  // This engine's state lives on the PAGE, and the page outlives everything else here:
  // removing the extension, updating it, reinstalling it — none of that touches
  // `window.__holoscrapeRows`. Only a navigation or a reload does. So a reinstalled
  // extension used to meet a page still holding the last install's candidates, hopped
  // rows and counters, and carry on from them: fresh panel, stale numbers, rows from
  // pages fetched before the extension was removed.
  //
  // The state therefore carries whose it is. The worker passes its install stamp, and
  // the URL is recorded when the state is made; either one changing means these
  // candidates describe a page that is no longer in front of us. An SPA that swaps its
  // list without a reload lands here too, which is the same bug wearing a hat.
  // Which page this is, judged by ORIGIN AND PATH only. Neither the hash nor the query is
  // part of the answer, because pages rewrite both about themselves: a gallery writes
  // `#photo-4` as you scroll and a marketplace appends its own tracking parameters the
  // moment you interact. Reading either as "a different page" wiped the state of the scan
  // that was running — every figure in the panel went to zero and stayed there while the
  // hop ground on invisibly, and before that a whole deep scan lost its rows and its trip
  // home. The penalty for guessing wrong here is destroying work, so the test is the one
  // that cannot be triggered by the page's own bookkeeping.
  const here = () => location.origin + location.pathname;
  const stamp = () => {
    const st = window[S];
    if (!st) return;
    // And never mid-flight, whatever the verdict. Something is walking, hopping or
    // extracting against this state right now; taking it away from them is not a reset,
    // it is a crash. The check runs again on the next call, when nothing is holding it.
    if (st.live) return;
    const otherInstall = !!(op.epoch && st.epoch && st.epoch !== op.epoch);
    const otherUrl = !!(st.href && st.href !== here());
    if (otherInstall || otherUrl) {
      // A DIFFERENT URL IS A GUESS. The direct evidence is whether the list this state
      // describes is still standing, and asking the DOM beats asking the address bar.
      //
      // Google Maps disproves the URL test outright: it rewrites its own PATH as the map
      // camera moves, so `/maps/search/plumber+in+Austin+TX/` becomes
      // `/maps/search/plumber+in+Austin+TX/@30.41,-97.70,10z/data=!3m1!4b1` while you are
      // simply scrolling the list. Measured: a walk gathered **119 rows and the page's own
      // end-of-list sentinel**, and the very next call — the panel asking what it had —
      // found the state deleted and reported zero. No card, no offer, nothing to press.
      // The hash and the query were already excluded here for the same class of reason;
      // the path turned out to need it too.
      //
      // A real navigation takes the container with it: frameworks replace the subtree on a
      // route change, so `isConnected` goes false and the state is discarded as before. An
      // install change still wipes unconditionally — nothing on the page is ours then.
      const alive = !otherInstall
        && (st.cands || []).some((c) => c && c.el && c.el.isConnected);
      if (!alive) {
        delete window[S];
        delete window[HOP];
        return;
      }
      st.href = here();   // same list, new address — the page rewrote it about itself
    }
    st.epoch = st.epoch || op.epoch || 0;
    st.href = st.href || here();
  };
  stamp();

  const CSS_ID = 'holoscrape-row-style';
  const C_TABLE = 'holoscrape-hit-table';
  const C_ROW = 'holoscrape-hit-row';

  // Children that never constitute a row on their own. Kept deliberately small:
  // a false negative here silently deletes a column, and layout wrappers are
  // already handled by the class-signature vote below.
  const NOT_A_ROW = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'BR', 'HR']);
  // For cell extraction we walk INTO almost everything — an <img> is not a row
  // but its src is very much a column.
  const NOT_A_CELL = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

  const MIN_ROWS = 3;          // fewer repeats than this is a layout accident
  const MIN_AREA_FRAC = 0.02;  // a row container the user cares about is visible
  const MAX_SWEEP = 20000;     // pathological DOMs get truncated, and say so
  const KEEP = 5;              // top-N candidates; bounded so cycling terminates
  const MAX_DEPTH = 12;
  // The same walk, counted in NODES rather than in structure — a backstop so a page built out of
  // a thousand nested single-child wrappers still terminates. `MAX_DEPTH` bounds how complicated a
  // card may be; this bounds how deeply it may be wrapped. See `walk` in `cellsOf`.
  const MAX_STEPS = 40;
  const MAX_COLS_PER_ROW = 80;
  const RECYCLE_HOPS = 3;      // hops adding no NEW row before a feed is called repeating
  const SHAPE_TOL = 3;         // how unlike each other unclassed rows may be
  const ROW_FRAC = 0.04;       // a row this share of the viewport is a record
  const MIN_TAB_ROWS = 5;      // fewer than this beside a real list is trivia
  const MIN_UNIFORM = 0.15;    // floor, so uneven rows are demoted not erased
  const RICH_TARGET = 8;       // elements per row above which a row is a record
  const MIN_RICH = 0.25;       // floor, so a list of plain text still counts
  const GUESS_TRUST = 0.5;     // weight of a list the page's own classes deny
  const PRIME_SCREENS = 24;    // hard cap on the walk that wakes a lazy page
  const PRIME_BUDGET_MS = 15000; // what actually bounds it — see walkDown()
  const PRIME_SETTLE_MS = 1200; // per screen; the walk is bounded, not patient
  // Overridable from the panel's SCAN block; the value here is the default for callers
  // that pass nothing — the results window's "More" button, and any agent calling
  // `extractAll` bare through the MCP server.
  //
  // THE DEFAULT IS DELIBERATELY SMALLER THAN THE PANEL'S. Raising the panel's waking budget
  // to 12 (see sidepanel.js's SCAN block, and the row counts that motivated it) does not
  // belong here, because the panel PASSES its number — `openResults` sends `wakePresses`
  // explicitly on every walk, so this constant is what happens to somebody who asked for
  // nothing. Raising it too meant a bare "read this list" quietly pressed a page's own
  // load-more twelve times and CHANGED the page it was asked to read: measured on
  // test/rows.mjs's /buried fixture, a re-read that should have reported 144 rows pressed
  // its way to 1,104. A call that names no budget gets a conservative one.
  const PRIME_CLICKS = op.wakePresses || 3;  // presses allowed while waking a page
  const DEAD_PRESSES = op.deadPresses || 2;  // fruitless presses before a button is spent
  const BOTTOM_TRIES = 4;      // how many times the foot of the page must stay quiet
  const PRIME_DRY = 4;         // quiet screens before a walk gives up mid-page
  // The walk learned that two quiet steps is not quiet — measured, a scroller that brought
  // nothing at steps 1-2 grew 4,777 -> 5,171 at step 3. `page_grow`'s hop loop never got that
  // lesson and still broke at 2, which reads to a person as "it stopped in the middle of a
  // scroll that was still doable". Same number as the walk, one definition apart.
  // QUIET HOPS BEFORE A GROW GIVES UP — AND DO NOT MAKE THIS CONDITIONAL ON REMAINING SCROLL.
//
// Tried, and reverted the same hour. On a shopee.co.id category page this fired at scrollTop 6097
// of 6997, leaving nine hundred pixels unread and ten of sixty rows populated, so the obvious fix
// was "never end a scroll with page still below". `test/recycler.mjs` went red immediately: its
// first surviving record was 385 of 392. On a TRUE recycler — rows removed from the DOM as they
// leave the viewport — scrolling further without capturing is not thoroughness, it is data loss,
// and the four-hop stop is what keeps the walk close enough to the capture to be safe.
//
// The two page shapes want opposite things from the same counter:
//   rows EVICTED on scroll (X)        stop early; `snapshotRows` captures before the next move
//   rows PRESENT, content lazy (Shopee)  keep going; nothing can be lost by scrolling
// Distinguishing them is the real fix, and it is not this constant.
const GROW_DRY = 4;
  // Rows arriving that are all rows we already have is a DIFFERENT end than no rows arriving.
  // Tokopedia re-serves the same ~284 products until the DOM holds 2,000 of them, so counting
  // DOM rows says "still growing" forever. Counting identities says the list ended.
  const LOOP_TRIES = 3;        // hops that add rows but no NEW identities before calling it a loop
  const PRIME_MEMO_MS = 8000;  // how long one walk covers for repeat calls
  const BOTTOM_DWELL_MS = 800; // real waiting there, not just DOM quiescence
  // A DECLARED feed says when it is finished, so wait to be told. Ten seconds of nothing
  // arriving is the other exit — measured against Maps, whose batches land in 1-2s.
  const FEED_WAIT_MS = 10000;
  const FEED_POLL_MS = 250;
  // What a feed says when it has run out. Matched on the container's own text, so a
  // footer elsewhere on the page saying something similar cannot end the walk.
  //
  // AND IT HAS TO SAY IT IN THE USER'S LANGUAGE. This list was English-only, and the locked geo
  // strategy is Brazil → Turkey → Argentina → Mexico → Indonesia — so the ordinary case was the
  // one it could not read. The same defect as the English-only furniture deny-list in `mail.js`
  // (`ROOT-CAUSES-2026-08-06.md` §E), in a different list.
  //
  // What it cost, measured: an Indonesian rail that had ALREADY declared itself finished was not
  // understood, so every walk spent the full ten-second `FEED_WAIT_MS` proving what the page had
  // said, and then recorded the reason it ended as "nothing arrived for 10s" — on a list that had
  // explicitly ended. That wrong reason is what a user's report was read through: a completed run
  // looked like a stall. Seven of seven live runs behaved that way.
  //
  // The control that proves it is the vocabulary and nothing else: the SAME query, same rail, only
  // `hl=` differing (`test/_focus7.mjs`), with the strings read off the live rail rather than
  // recalled —
  //
  //   hl=en     "You've reached the end of the list."      matched
  //   hl=id     "Anda telah mencapai akhir daftar."        NOT matched
  //   hl=pt-BR  "Você chegou ao final da lista."           NOT matched
  //   hl=es     "Has llegado al final de la lista."        NOT matched
  //   hl=tr     "Listenin sonuna ulaştınız."               NOT matched
  //
  // That is every language of the locked geo strategy except Argentina and Mexico, which share the
  // Spanish string. Anchored on the phrase's own content words rather than whole sentences, because
  // Google varies the wrapper ("final"/"fim", "chegou"/"chegaste") far more than it varies "end of
  // the list". The five above were read off a live rail; the rest are Google's wording for the same
  // string and are UNMEASURED — a language nobody has checked is a candidate for the next report,
  // not a claim. `test/rows.mjs` pins the five that were.
  const FEED_DONE = new RegExp([
    'reached the end of the list', 'no more results', 'end of results', "that's all",
    "you're all caught up",
    'akhir daftar', 'penghujung senarai',                      // Indonesian (measured) / Malay
    'fi(?:m|nal) da lista',                                    // Portuguese (measured)
    'final de la lista',                                       // Spanish (measured)
    'listenin sonuna', 'liste(?:nin)? sonu',                   // Turkish (measured)
    'fin de la liste', 'ende der liste', 'fine dell(?:a|.)elenco',
    'einde van de lijst', 'koniec listy', 'конец списка',
  ].join('|'), 'i');
  // Only the tail: the sentinel is appended after the last row, and reading the whole rail
  // means scanning every card's text on every poll — 250ms apart, for up to ten seconds.
  const feedText = (el) => {
    try { return (el.innerText || '').slice(-FEED_TAIL_CHARS); } catch (_) { return ''; }
  };
  // What a screen costs once the page has proven it is not loading anything: long
  // enough for a lazy loader to fire, short enough that the rest of a tall page is
  // seconds rather than a minute.
  const SWEEP_DWELL_MS = 160;
  const MORE_SWEEP = 4000;     // controls examined when hunting a load-more
  // How far a scan pushes the list. Driven by the Thoroughness setting, because
  // that setting already means exactly this for the asset walk and meant nothing
  // for rows.
  // Unlimited by default: a ceiling on an endless feed always lands with the button
  // visible and reads as "stopped for no reason". The real endings are the page's
  // (atEnd: nothing to press, nothing arriving) and the user's (Stop/Esc, kept work).
  // Tests pass explicit small numbers; 0 or absent means no limit. Not Infinity over
  // the wire — message serialization drops it.
  const SCAN_HOPS = op.hops > 0 ? op.hops : Number.MAX_SAFE_INTEGER;
  const SCAN_BUDGET_MS = op.budget > 0 ? op.budget : Number.MAX_SAFE_INTEGER;

  // Relative to the page a row came FROM. Rows fetched from page 2 are read long after
  // the fetch, so the base travels with them rather than being applied at fetch time.
  let hopBase = null;
  const abs = (u) => {
    try { return new URL(u, hopBase || location.href).href; } catch (_) { return u; }
  };
  // Sliced, not a single setTimeout. A stop pressed one millisecond into an 800ms
  // dwell used to wait out the whole thing, and the dwells add up: the walk's
  // bottom-of-page patience alone is four of them. Every wait in this file is
  // interruptible for the same reason — see `settle`.
  //
  // AND RESOLVABLE FROM OUTSIDE THE PAGE'S CLOCK. A hidden tab clamps these intervals to a
  // second and, five minutes in, to a minute — which is a walk that dies of thirst mid-page.
  // While the frame keeper is armed (see `raf.js`), the wait also registers with it, and the
  // service worker's pump — whose clock the tab's visibility cannot touch — resolves whatever
  // the page's own timer never got to. Whichever side fires first wins; both are cleaned up.
  const nap = (ms) => new Promise((r) => {
    const t0 = performance.now();
    let done = false;
    const fin = () => { if (done) return; done = true; clearInterval(tick); r(); };
    const tick = setInterval(() => {
      if (performance.now() - t0 >= ms || stopped()) fin();
    }, NAP_TICK_MS);
    const box = window['__holoscrapeFrames'];
    if (box?.on && typeof box.wait === 'function') box.wait(ms).then(fin);
  });

  // WHAT MAKES A ROW THAT ROW. There are two ways to get this wrong and this file had both.
  //
  // "The first link in the row" is what was here. On a real listing card the first link is
  // the supplier's country flag, or an Assessed-Supplier badge, or a wrapper — the same href
  // on every card on every page — so distinct products collapsed onto each other and the hop
  // concluded the site was repeating itself and stopped. The opposite failure is just as bad:
  // listing links carry a per-load token (Alibaba re-stamps `priceId` on every request), so
  // comparing whole URLs de-duplicates nothing at all.
  //
  // So: links only — an <img> is not an identity — and the WHOLE SET of them, bare (no query),
  // not just the longest one. Longest-only was measured live on x.com: every tweet card carries
  // several links sharing one `/status/<id>` prefix — the permalink, `+/analytics`, sometimes
  // `+/photo/N` — so which one is longest can vary hop to hop (a photo link only exists once
  // media has loaded), giving the SAME post two different identities across two reads and the
  // walk's own repeat-counter never crediting it as "seen" — reported live as a virtualized
  // timeline correctly detected as recycling (`recycling:true`) but stopping at 8 rows with
  // `endedBy=only repeats for 3 hops`, while the person scrolling the same feed by hand saw no
  // duplicates at all. `identSpread` (the distinctness diagnostic below) already used the full
  // set for exactly this reason — 2GIS rows share a rubric link and differ by `/firm/<id>`,
  // Amazon's refinement rows carry one bare `/s` each and are meant to collapse — this brings
  // `identOf` in line with it instead of the two quietly disagreeing on what a row IS. A row's
  // full set can only be a superset of its longest single link, so nothing that used to be told
  // apart stops being told apart; it only recovers rows that longest-alone was conflating.
  // Kept in one place because three copies of this rule is how they came to disagree.
  // The link half on its own, because `gridCells` asks the same question of a CELL — do these
  // point at different things? — and must never grow a second answer to it.
  const linkPathsOf = (r) => {
    const paths = [];
    try {
      for (const a of (r.querySelectorAll ? r.querySelectorAll('a[href]') : [])) {
        const h = a.getAttribute('href') || '';
        if (!h || /^(#|javascript:)/i.test(h)) continue;
        let bare = h;
        try { const u = new URL(h, location.href); bare = u.origin + u.pathname; } catch (_) { /* keep raw */ }
        if (!paths.includes(bare)) paths.push(bare);
      }
    } catch (_) { /* no links is an answer too */ }
    return paths.sort();
  };
  const identOf = (r) => {
    const paths = linkPathsOf(r);
    if (paths.length) return paths.join(' ');
    // A ROW WITH NO REPRESENTATIVE LINK AT ALL — Gmail's inbox rows are `jsaction`-driven, not
    // `<a href>`-driven, and every mail client shares that shape. TEXT ALONE, TRUNCATED, IS TOO
    // COARSE a fallback: capped at 120 characters, two genuinely distinct rows whose first 120
    // characters happen to agree — a templated "shared your Google Account data" notice, a daily
    // payment receipt, a recruiter's form-letter rejection — read as one repeat. Measured live: an
    // inbox scan reported dozens of "repeats skipped" on a folder where every single row was a
    // different email; one email is one row, full stop, and nothing here should ever call two of
    // them the same on the strength of a shared opening sentence.
    //
    // So the text is no longer truncated — a Set of 400-character strings costs the same as one
    // of 120-character strings, and the full string was already built before the old code cut it
    // — and every attribute a row uses to LABEL its own content is folded in too. This is what
    // recovers the one piece of real identity Gmail was throwing away: the visible cell reads
    // "7:32 PM", but the timestamp's own `title`/`aria-label` carries the exact
    // "Fri, Sep 18, 2026, 7:32 PM" underneath it — enough on its own to tell apart two rows whose
    // rendered text is otherwise identical.
    const labels = [];
    try {
      for (const el of r.querySelectorAll('[title],[aria-label]')) {
        const v = el.getAttribute('title') || el.getAttribute('aria-label') || '';
        if (v) labels.push(v);
      }
    } catch (_) { /* text alone is still an answer */ }
    const text = (r.innerText || r.textContent || '').replace(/\s+/g, ' ').trim();
    return labels.length ? `${text} | ${labels.join(' | ')}` : text;
  };

  // Rows counted the way extraction counts them: by identity, not by DOM presence.
  const uniqueCount = (c) => {
    if (!c) return 0;
    const keys = new Set();
    for (const r of [...c.rows, ...extraOf(c)]) keys.add(identOf(r));
    // A virtualized recycler's mounted-row count is a WINDOW, not a total: scrolling further
    // does not grow it, it slides it — so counting only what is currently in the DOM plateaus
    // the moment the window fills, and the walk below reads that plateau as "the list repeats"
    // after just `RECYCLE_HOPS` hops, however much fresh content is actually streaming past.
    // `snapshotRows` (called from the walk, once eviction is confirmed) parks every row's cells
    // here, keyed by identity, before a later scroll can recycle the element out from under it —
    // folding those idents in is what makes "unique so far" mean the whole walk, not this instant.
    const snaps = c.el ? hopStore().get(c.el)?.snaps : null;
    if (snaps) for (const k of snaps.keys()) keys.add(k);
    // Same reason `extractOne` reads `allSeen()` — a container swap must not read back as
    // "the list shrank" just because THIS container's own history was orphaned by it — and
    // gated the same way, for the same reason: on a page whose container is never swapped this
    // counts rows that are no longer in the list, and "unique so far" stops meaning the list.
    if ((PROVIDERS[mapKind()] || {}).keepSeen) {
      for (const k of allSeen().keys()) keys.add(k);
    }
    return keys.size;
  };

  // PARK EVERY CURRENTLY-MOUNTED ROW'S CELLS BEFORE THE NEXT SCROLL CAN RECYCLE IT AWAY.
  //
  // Only called once the walk has confirmed rows are actually being evicted (see `st.evicting`
  // at the call site) — an ordinary list that only ever grows never needs this, and skipping it
  // there avoids doubling the cost of `cellsOf` on every row of a large, honestly-paginating
  // site. `extraOf`'s existing consumers all expect live elements to walk; a recycled element
  // reflects whatever is mounted there NOW, not what it held when parked, so the snapshot has to
  // be the extracted CELLS, not the element — a separate map from `extraOf`'s, read by
  // `uniqueCount` and `extractOne` alongside it.
  // SURVIVES A CONTAINER CHANGE, NOT JUST A SCROLL. `bag.snaps` above is keyed to ONE
  // container element via the WeakMap-backed hop store — exactly right for a recycling list,
  // but useless the moment the container itself gets replaced. X's SPA occasionally swaps
  // its whole timeline root without a real navigation (logged as `session.new why=document
  // changed`), which mints a brand-new container element; the old one's `bag.snaps` becomes
  // unreachable garbage and every row it held vanishes from the next extraction, even though
  // nothing about the tab actually changed. Keyed on `window[S]` itself — not on any
  // container — so it is the one thing here that outlives that swap. Never cleared, only
  // ever added to, for as long as this tab lives.
  const allSeen = () => {
    if (!window[S]) window[S] = {};
    if (!window[S].allSeen) window[S].allSeen = new Map();
    return window[S].allSeen;
  };

  function snapshotRows(c) {
    if (!c || !c.el || !c.rows.length) return;
    const bag = hopFor(c.el, true);
    if (!bag.snaps) bag.snaps = new Map();
    // `cellsOf`'s fourth argument is its OWN href/label bookkeeping and must be a bare `Map` —
    // see `extractOne`'s `const bag = new Map()` — not the hop-store object this function itself
    // keys everything else on. Passing the hop-store object through unchanged throws the moment
    // a row carries an `<a href>` (`bag.has is not a function`), which a link-free fixture never
    // exercises but a real timeline full of links does on essentially every row.
    if (!bag.hrefBag) bag.hrefBag = new Map();
    const keep = stableClasses(c.rows);
    const seen = allSeen();
    for (const r of c.rows) {
      const k = identOf(r);
      if (!k || bag.snaps.has(k)) continue;
      const cells = cellsOf(r, c.pair, keep, bag.hrefBag);
      if (Object.keys(cells).length) { bag.snaps.set(k, cells); seen.set(k, cells); }
    }
  }

  // CALLED RIGHT AFTER EVERY `recount(c)` IN THE SCROLL LOOP — the only place rows actually get
  // evicted. Compares this instant's mounted idents against the last instant's; the first row
  // that WAS there and now is not means this container recycles, and from that hop on every
  // further recount snapshots first, before the NEXT scroll can take anything else. The one hop
  // that revealed it is the one loss this accepts — there is no live element left to snapshot
  // retroactively — everything after is covered. `bag.priorKeys` lives on the per-element hop
  // store, not on `window[S]`, because `scrollStep` is called many times across one walk and a
  // local variable would forget between calls.
  function trackEviction(c) {
    if (!c || !c.el) return;
    const bag = hopFor(c.el, true);
    const cur = new Set(c.rows.map((r) => identOf(r)).filter(Boolean));
    if (bag.priorKeys && !bag.evicting) {
      for (const k of bag.priorKeys) if (!cur.has(k)) { bag.evicting = true; break; }
    }
    bag.priorKeys = cur;
    if (bag.evicting) snapshotRows(c);
  }

  // --- stopping ---------------------------------------------------------------
  // A scan can now run for a minute and a half, press a page's button six times and
  // hold the page while it does. Until this existed there was no way to stop one, so
  // "Esc to cancel" would have been a lie. The flag lives on the page rather than in
  // the worker because that is where the loops are: the worker sets it with a one-line
  // injection and every loop reads it on its next turn, so stopping takes effect
  // within one step instead of at the end of the budget.
  const STOP = '__holoscrapeStop';
  const stopped = () => !!window[STOP];

  // --- was the tab REALLY hidden ------------------------------------------------
  // `document.hidden` is not a fact this file may read, and every diagnostic in it was reading
  // it. `raf.js` runs in this same world and, while armed, redefines the getter to return false
  // so that Maps keeps working when the tab goes behind something (see the note there). The
  // worker arms it for the whole of every walk, every page hop and every details pass
  // (`background.js`, `keepAwake` at the top of `runRows`) — so on Maps, `document.hidden` is
  // hard-wired to false for exactly the runs whose logs ask the question.
  //
  // Measured: sampling `window.__holoscrapeFrames.on` through a live `extractAll`, the keeper was
  // armed in 44 of 45 samples. Every `hidden=` this engine has ever printed on Maps was that
  // constant, and one of them — `hidden=false focus=false` on a run that ended
  // `nothing arrived for 10s` — was read as "the tab was fine" and sent an investigation after
  // a stall that had not happened.
  //
  // The keeper captured the real getter before replacing it and now hands it back. Off Maps
  // there is no keeper and `document.hidden` is already the truth.
  const trueHidden = () => {
    const box = window['__holoscrapeFrames'];
    if (box && typeof box.trueHidden === 'function') {
      const v = box.trueHidden();
      if (v !== null) return v;
    }
    return !!document.hidden;
  };

  // Bring a control into view without ever scrolling backwards. scrollIntoView with
  // block:'center' does whatever it takes to centre the element — including
  // scrolling UP, which during a descent reads as the page fighting the user and
  // re-triggers every lazy loader that keys off direction. A button already on
  // screen is clickable where it is; one below is reached by going further down,
  // which is the direction we were going anyway.
  // Is this control close enough to act on? On screen, or within a screen below —
  // which is where a load-more sits while you are walking towards it.
  //
  // This is the difference between pressing a button and scrolling past it. The press
  // used to be gated on reaching the bottom of the DOCUMENT, and Tokopedia puts its
  // "Muat Lebih Banyak" mid-page above about five thousand pixels of SEO footer: the
  // button was on screen for 11.5 seconds of a walk that scrolled from y=2160 to
  // y=8500 without touching it, then pressed once at the very bottom. One press per
  // walk, one batch of rows, every time.
  const withinReach = (el) => {
    try {
      const r = el.getClientRects()[0];
      return !!r && r.top < innerHeight * REACH_BELOW_SCREENS && r.bottom > -REACH_ABOVE_PX;
    } catch (_) { return false; }
  };

  const reach = (el) => {
    try {
      const r = el.getClientRects()[0];
      if (!r) return;
      if (r.top >= 0 && r.bottom <= innerHeight) return;   // already visible
      if (r.bottom < 0) return;                            // above us: leave it
      window.scrollTo({ top: (window.scrollY || 0) + r.top - innerHeight * REACH_LAND_FRAC,
        behavior: 'instant' });
    } catch (_) {}
  };

  // Our own highlight classes are on the page while we work, so every read of a
  // class list has to exclude them. Left in, they poison both halves of the
  // engine: every row appears to share `…-hit-row` so the signature vote becomes
  // meaningless, and a saved selector picks up `…-hit-table` and can never match
  // on a fresh load.
  const OURS = new Set([C_TABLE, C_ROW]);
  const classesOf = (el) => {
    const out = [];
    for (const c of el.classList || []) if (!OURS.has(c)) out.push(c);
    return out;
  };

