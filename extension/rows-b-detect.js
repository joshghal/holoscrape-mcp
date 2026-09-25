  // --- row identification ---------------------------------------------------
  // Children that could be a row at all: markup that carries something. Factored out
  // because two paths need the same answer and a second copy is a second thing to
  // drift. The textless child matters more than it looks — Google Maps' rail
  // alternates one card with one empty `div.TFQHme` divider, 61 cards to 60
  // dividers, and counting those as rows halves every number the panel prints.
  function contentKids(el) {
    const kids = [];
    // ONLY WHERE LAYOUT IS POSSIBLE AT ALL. The fetch-fallback ladder (`X-Frame-Options: DENY`,
    // and any site refusing a frame) reads a page it never rendered — `new DOMParser().
    // parseFromString(...)` — and EVERY element in that tree reports empty `getClientRects()`
    // forever, display:none or not, because it was never laid out by anything. Gating the check
    // below on `defaultView` existing tells that document apart from the live one: a detached
    // parse has none, the page actually on screen always does.
    const rendered = !!(el.ownerDocument && el.ownerDocument.defaultView);
    for (const c of el.children) {
      if (NOT_A_ROW.has(c.tagName)) continue;
      // NOT RENDERED IS NOT A ROW, on a document that COULD render it. `display:none` still
      // carries text content and a full class list, so without this an inactive sibling counts
      // exactly like a visible one. Measured live on Gmail: the inbox is four ARIA tabpanels
      // (Primary/Social/Promotions/Updates), three of them `display:none` behind whichever
      // category is open — a real, 50-message table nested deep inside the one panel that IS
      // shown. The four tabpanels agree on tag, class and role, so they outscored the real list
      // as "a 4-row list" while the person's actual 50 rows sat unread several containers
      // further in.
      if (rendered && !c.getClientRects().length) continue;
      if (!c.textContent.trim() && !c.querySelector('img, video, audio, source, picture')) continue;
      kids.push(c);
    }
    return kids;
  }

  // THE ROW OF A LAYOUT GRID IS A WRAPPER, AND THE RECORD IS THE CELL INSIDE IT.
  //
  // Measured through the real MCP path on 2026-09-22: scrapethissite.com/pages/simple/ holds 250
  // countries on one page and `list_extract` returned 87 rows, "reached the limit", nothing else
  // said. Not a cap, not the viewport, not a lazy list — all 250 were in the DOM. The 87 were the
  // page's `div.row` elements. A twelve-column layout grid writes its cards three to a wrapper:
  //
  //   div.container > div.row x 87 > div.col-md-4.country x 3          (84 of them; 250 = 83x3 + 1)
  //                               > div.col-md-12 | div.col-md-6 x 2   (3 of them: the headings)
  //
  // so the container's CHILDREN agree on a class and everything below took them for rows. Each
  // came out as three countries side by side under `div`, `div 2`, `div 3` columns, and the page
  // heading came out as a record.
  //
  // `columnMerges` stitches wrappers too, and rightly refuses this page three times: 87 is far
  // past MASONRY_HARD_CAP, three wrappers hold no rows, and the 250th country sits alone in the
  // last one where `rowsOf` wants three. Every one of those guards exists because reading one
  // level too deep is what turned Alibaba's 48 cards into 144 fragments — so this does not loosen
  // them. It asks a different question, of the CELLS, and needs every answer to be yes:
  //
  //   one template   the wrappers' children share a class the page gave them (`col-md-4 country`).
  //                  A card's parts do not: `img-area`, `content`, `action` agree on nothing.
  //   nothing else   a grid row holds its cells and only its cells. A card holding a title, a
  //                  price AND three same-class buttons is not a row of three records.
  //   a grid's width most wrappers hold the same number of cells — the grid's width — and only a
  //                  few hold fewer (the last row; a heading row holds none and is dropped, the
  //                  same way `rowsOf` drops the child that does not carry the winning class).
  //   composite      a cell is a RECORD: RICH_TARGET elements or more, the measurement `scoreOf`
  //                  already uses (right answers ran 14-308 elements a row, furniture 0-6). The
  //                  cells of a table built from divs are values — a name, a number — and so are
  //                  a card's three same-class buttons.
  //   alike          the cells of ONE wrapper are built from the same elements. Across a table
  //                  row they are different kinds of thing — a picture, a spec list, a buy form —
  //                  however rich each is and whatever class they share.
  //   different      where the cells link anywhere, the cells of one wrapper link to different
  //                  places. Three look-alike panels that all point at one product are three
  //                  views of it — the test that catches Alibaba's fragments in `columnMerges`.
  //
  // NOTHING HERE IS GEOMETRY, on purpose. "Three boxes side by side" is what a grid row looks like
  // at 1366px; at 600px the same cells stack and the same 250 records are on the page.
  // `test/grid-row-is-not-the-record.mjs` reads the fixture at both widths, and holds one fixture
  // for each refusal above.
  const GRID_MAX_PER = 12;     // the widest a layout grid goes; past this it is not a row of cards
  const GRID_MOST = 0.8;       // "most": the share of wrappers, or of cells, a claim must hold for
  const GRID_ALIKE = 0.6;      // shared element kinds between two cells of one wrapper
  const GRID_SAMPLE = 24;      // wrappers measured for the costly tests; the cheap ones see all
  function gridCells(wraps) {
    if (!wraps || wraps.length < MIN_ROWS) return null;
    // CHEAPEST FIRST, because this runs on every repeating container the sweep finds: the
    // children of ONE wrapper must share a class before anything is measured. An ordinary
    // card — picture, title, price — has no such wrapper and leaves here after a few.
    //
    // OF ONE WRAPPER, NOT ACROSS WRAPPERS. Intersecting the class lists ACROSS the first three
    // wrappers bails on the measured page: its first three wrappers are the heading rows —
    // `col-md-12`, `col-md-12`, `col-md-6` x2 — whose intersection is empty, and the 250 cells
    // below are never looked at (that gate held test/grid-row-is-not-the-record.mjs at 87).
    // What a grid row shows is that ITS cells are alike; what rows show each other is measured
    // properly below, over all of them. Wrappers with one child say nothing either way (a
    // heading row) and are skipped, not counted against it.
    let alikeWraps = 0;
    let gated = 0;
    for (const w of wraps) {
      if (gated >= GRID_GATE_WRAPS || alikeWraps >= MIN_ROWS) break;
      if (w.children.length < 2) continue;
      gated++;
      if (w.children.length > GRID_MAX_PER) continue;
      let shared = null;
      for (const k of w.children) {
        const have = classesOf(k);
        shared = shared ? shared.filter((c) => have.includes(c)) : have;
        if (!shared.length) break;
      }
      if (shared && shared.length) alikeWraps++;
    }
    if (alikeWraps < MIN_ROWS) return null;
    const per = wraps.map((w) => contentKids(w));
    const count = new Map();
    let total = 0;
    for (const kids of per) {
      for (const k of kids) { total++; for (const c of classesOf(k)) count.set(c, (count.get(c) || 0) + 1); }
    }
    if (total <= wraps.length) return null;
    const sig = [...count].filter(([, n]) => n >= total * GRID_MOST).map(([c]) => c).sort();
    if (!sig.length) return null;
    const isCell = (k) => { const have = classesOf(k); return sig.every((c) => have.includes(c)); };
    // Cells and only cells. A wrapper holding anything else is not a grid row; enough of those
    // and this is not a grid.
    const rowsOfCells = per.filter((kids) => kids.length && kids.length <= GRID_MAX_PER && kids.every(isCell));
    if (rowsOfCells.length < Math.max(MIN_ROWS, wraps.length * GRID_MOST)) return null;
    const widths = new Map();
    for (const kids of rowsOfCells) widths.set(kids.length, (widths.get(kids.length) || 0) + 1);
    let width = 0;
    for (const [k, n] of widths) if (n > (widths.get(width) || 0) || (n === widths.get(width) && k > width)) width = k;
    if (width < 2 || widths.get(width) < rowsOfCells.length * GRID_MOST) return null;

    const step = Math.max(1, Math.floor(rowsOfCells.length / GRID_SAMPLE));
    const looked = rowsOfCells.filter((_, i) => i % step === 0).slice(0, GRID_SAMPLE);
    const kindsOf = (cell) => { const out = new Set(); for (const e of cell.getElementsByTagName('*')) out.add(e.tagName); return out; };
    const dense = [];
    let alikeRows = 0;
    let judged = 0;
    let linkedRows = 0;
    let oneRecord = 0;
    for (const kids of looked) {
      for (const k of kids) dense.push(k.getElementsByTagName('*').length);
      if (kids.length < 2) continue;
      judged++;
      const first = kindsOf(kids[0]);
      const same = kids.slice(1).every((k) => {
        const mine = kindsOf(k);
        let both = 0;
        for (const t of mine) if (first.has(t)) both++;
        const either = first.size + mine.size - both;
        return either === 0 || both / either >= GRID_ALIKE;
      });
      if (same) alikeRows++;
      const links = kids.map((k) => linkPathsOf(k).join(' ')).filter(Boolean);
      if (links.length >= 2) { linkedRows++; if (new Set(links).size === 1) oneRecord++; }
    }
    dense.sort((a, b) => a - b);
    if (!dense.length || dense[dense.length >> 1] < RICH_TARGET) return null;
    if (!judged || alikeRows < judged * GRID_MOST) return null;
    if (linkedRows && oneRecord >= linkedRows / 2) return null;

    const rows = [];
    for (const kids of rowsOfCells) for (const k of kids) rows.push(k);
    return { rows, sig: [sig.join(' ')] };
  }

  // The reading every caller gets: the plain one, and where the plain one's rows turn out to be a
  // layout grid's wrappers, the cells. Done HERE rather than in `detect` so that `recount`, a
  // pinned container, a restored selection and a page read off a fetched document all agree on
  // what this container's rows are — a candidate that is 250 rows when detected and 87 when
  // recounted one scroll later is the Unsplash collapse (22 to 3) that `mergeSig` exists for.
  function rowsOf(el) {
    const r = plainRowsOf(el);
    if (!r || r.pair || r.mode === 'feed') return r;
    const grid = gridCells(r.rows);
    return grid ? { rows: grid.rows, sig: grid.sig, mode: 'grid' } : r;
  }

  // Which of a container's direct children are rows? The ones that agree on
  // their class list. Real row sets are generated from one template, so they
  // share a signature; the stray "featured" card or trailing ad does not.
  function plainRowsOf(el) {
    // A definition list is a list whose rows span two elements. Treated as plain
    // children it produces one junk row per <dt> AND per <dd> plus any heading —
    // arXiv's 50 papers come back as 101 rows, none of them a paper. The <dt> is
    // the row; its trailing <dd>s are its columns.
    if (el.tagName === 'DL') {
      const dts = Array.from(el.children).filter((c) => c.tagName === 'DT');
      if (dts.length >= MIN_ROWS) return { rows: dts, sig: [], mode: 'dl', pair: 'dl' };
    }

    // `role="feed"` is the page stating, in a standard ARIA attribute, that this is a
    // list of dynamically loaded articles. Taking its word is the same move the <dl>
    // branch above makes, and `scan.js` already makes it for assets — so this is the
    // codebase being consistent with itself, not a new kind of knowledge.
    //
    // It is also the ONLY thing that reads Google Maps' result rail, and the reason is
    // worth writing down because it looks like an engine failure and is not. Measured on
    // a loaded rail: 61 cards on screen, `detect` reported 4 rows, and every `cycle`
    // returned that same one — the rail was never a candidate at all. The cards carry
    // **no classes whatsoever**. So `classesOf` returns [] for all 61, every `sig` is the
    // empty string, and the vote below reads `if (sig && n >= need)` — the empty
    // signature is skipped. The strongest agreement on the page is discarded precisely
    // because what those 61 children agree on is having nothing to agree with.
    //
    // Widening that guard would give full trust to every unclassed wrapper on the web,
    // which is what `alike()` and GUESS_TRUST exist to keep out. `role="feed"` is the
    // narrow version of the same fix: not "trust unclassed children" but "trust children
    // whose parent has declared itself a feed".
    if (el.getAttribute && el.getAttribute('role') === 'feed') {
      const fed = contentKids(el);
      // A feed carries furniture among its articles, and the sentinel is the one that
      // always does: Maps appends "You've reached the end of the list." INSIDE the rail,
      // so a 112-place run reported 113 rows, the last of them junk with no link in it.
      // Caught by the fixture arriving at 41 instead of 40.
      //
      // So when the articles agree that they hold a link, the ones that do not are not
      // articles — that is the same majority argument as the class vote below, in a
      // different currency, and it is the currency a classless feed still has. Applied
      // only when the majority actually holds: a feed of plain text posts has no links
      // to vote with, and every child stays a row.
      if (fed.length >= MIN_ROWS) {
        const linked = fed.filter((k) => k.querySelector('a[href]'));
        const rows = linked.length >= MIN_ROWS && linked.length >= fed.length / 2 ? linked : fed;
        return { rows, sig: [], mode: 'feed' };
      }
    }

    const kids = contentKids(el);
    if (kids.length < MIN_ROWS) return null;

    const bySig = new Map();
    const byCls = new Map();
    for (const k of kids) {
      const cls = classesOf(k).sort();
      const sig = cls.join(' ');
      bySig.set(sig, (bySig.get(sig) || 0) + 1);
      for (const c of cls) byCls.set(c, (byCls.get(c) || 0) + 1);
    }

    // Majority-ish, not strict majority: real lists carry a couple of odd rows
    // (sponsored slot, "see all" tile) and demanding unanimity loses the list.
    // Floored at 2 so a 3-child container still has to actually agree.
    const need = Math.max(2, kids.length / 2 - 2);

    let good = [];
    let mode = 'sig';
    for (const [sig, n] of bySig) if (sig && n >= need) good.push(sig);
    if (!good.length) {
      mode = 'class';
      for (const [c, n] of byCls) if (n >= need) good.push(c);
    }
    // Nothing agrees: either an unclassed list (<ul><li> with no classes, very
    // common) or not a list at all. Scoring alone cannot tell them apart, so the
    // children have to answer for themselves — see alike().
    if (!good.length) {
      const r = alike(kids);
      return r ? { rows: r, sig: [], mode: 'all' } : null;
    }

    // Containment, not equality. A row that carries the winning classes *plus* a
    // modifier — `card card--promoted`, `row featured` — is still a row, and
    // demanding an exact class list silently drops every sponsored or
    // highlighted entry in the list.
    let rows = kids.filter((k) => {
      const have = new Set(classesOf(k));
      if (mode === 'sig') return good.some((sig) => sig.split(' ').every((c) => have.has(c)));
      return good.some((c) => have.has(c));
    });
    // A CLASS EVERY ROW CARRIES OUTRANKS THE SIGNATURE MOST OF THEM CARRY. Rows from one template
    // often split into two states — read `zA yO` and unread `zA zE` in an inbox, in-stock and
    // sold-out in a grid — and when the split is uneven the winning signature is the majority
    // state and the minority is dropped as "odd rows". Measured on the Gmail fixture: 13 read and
    // 7 unread threads, `need` 8, so page one read as 13 of 20 while the pages after it, all one
    // state, read as 20. Containment above cannot rescue them: the minority lacks the majority's
    // state class, it does not add to it.
    //
    // So a class carried by MORE children than the signature covers is tried as the row class —
    // and taken only on two measurements, never on the name: every row the signature kept must
    // carry it (the same family, wider — not a different one that happens to be popular), and the
    // widened set must pass `alike()` whole (same tag, child counts in one band), which is what
    // keeps a grid's layout class from sweeping a promo tile in beside the cards.
    if (mode === 'sig') {
      let wide = null;
      for (const [c, n] of byCls) {
        if (n <= rows.length || n < need || (wide && n <= wide.n)) continue;
        if (!rows.every((k) => classesOf(k).includes(c))) continue;
        const cand = kids.filter((k) => classesOf(k).includes(c));
        if (cand.length !== n || alike(cand)?.length !== cand.length) continue;
        wide = { c, n, cand };
      }
      if (wide) { rows = wide.cand; good = [wide.c]; mode = 'class'; }
    }
    if (rows.length < MIN_ROWS) {
      const r = alike(kids);
      return r ? { rows: r, sig: [], mode: 'all' } : null;
    }
    return { rows, sig: good, mode };
  }

  // "No classes agree, so treat every child as a row" is what makes an unclassed
  // <ul><li> list work. It is also how a page *shell* becomes a table: a <main>
  // holding a hero, a product grid and a footer has three children sharing no
  // classes, and its page-sized area then wins scoring outright. Tokopedia's
  // homepage came back as <main> — 3 rows whose child counts were 20, 34 and 1,
  // with 55 columns — and because the winner was the whole page, revealing it
  // scrolled to the header.
  //
  // The rows of a list resemble one another. The sections of a shell do not. That
  // is the whole test, and it needs no site knowledge.
  function alike(kids) {
    const tally = new Map();
    for (const k of kids) tally.set(k.tagName, (tally.get(k.tagName) || 0) + 1);
    let tag = null;
    let best = 0;
    for (const [t, n] of tally) if (n > best) { best = n; tag = t; }
    const same = kids.filter((k) => k.tagName === tag);
    if (same.length < MIN_ROWS) return null;

    // A tolerant band, not equality: a card with a badge holds one more child than
    // a card without, and real rows vary. A section holding 1 child beside one
    // holding 34 is not variation, it is a different kind of thing.
    const counts = same.map((k) => k.children.length).sort((a, b) => a - b);
    const med = counts[counts.length >> 1];
    const lo = med / SHAPE_TOL - 1;
    const hi = med * SHAPE_TOL + 1;
    const rows = same.filter((k) => k.children.length >= lo && k.children.length <= hi);
    return rows.length >= MIN_ROWS ? rows : null;
  }

  // --- candidate scoring ----------------------------------------------------
  // Repetition alone ranks the wrong thing. Tokopedia's homepage carries an SEO
  // link farm in its footer — 303 <a>s, one word each — and at area x rows^2 that
  // outscored the 18-card product grid by three orders of magnitude. Both are
  // genuinely lists. Only one is a list of *records*.
  //
  // Two measurements separate them, and they came from looking at six sites
  // rather than from taste:
  //
  //   size     a record occupies real space. Across the right answers, area/rows
  //            ran 69k-137k px^2; across footers, breadcrumbs, tag clouds and the
  //            link farm it ran 1.3k-13.6k. A five-fold gap with nothing in it.
  //   evenness rows generated from one template are the same size as each other.
  //            The product grid measured cv 0; the marketing block that used to
  //            beat it measured 0.7, and <main> itself 0.57. This is what keeps a
  //            page shell from ever winning, whatever its area.
  //   trust    every other mode means the page's own class names agreed on what a
  //            row is — the markup itself says these were generated from one
  //            template. Mode 'all' is the opposite: nothing agreed, and we fell
  //            back to "assume every child is a row". That fallback earns real
  //            lists (an unclassed <ul><li>) and also earns Tokopedia's marketing
  //            band — 17 differently-classed promo blocks, big, dense and uniform
  //            enough to beat the product grid on every other measure. Halved, not
  //            discarded: when an unclassed list is the only list on the page it
  //            still wins by being the only one.
  //   richness a record is a composite — an image, a title and a price, each in
  //            its own element. A paragraph of prose and a bare <a> are not. Across
  //            the same six sites, elements-per-row came out 14-308 for every right
  //            answer and 0-6 for every footer, tag cloud and block of SEO prose.
  //            Size and evenness alone still ranked a 17-row prose section above
  //            Tokopedia's 17-card grid, because long paragraphs are large and
  //            uniform; this is what tells them apart.
  //
  // Both scale the row count rather than the score, so they read as "303 tiny
  // links are worth about 16 real rows" instead of as an arbitrary penalty. Row
  // count still dominates among equals, which is what stops a nav bar from
  // beating a grid.
  function scoreOf(el, rows, area, mode) {
    const vp = Math.max(1, innerWidth * innerHeight);

    // Measured on the rows that have a box. Rows laid out with display:contents
    // report none, and a metric we cannot take must not be scored as a failure —
    // Tokopedia's search grid is built exactly that way.
    const boxes = [];
    for (const r of rows) {
      const a = r.offsetWidth * r.offsetHeight;
      if (a > 0) boxes.push(a);
    }
    boxes.sort((a, b) => a - b);
    const med = boxes.length ? boxes[boxes.length >> 1] : 0;

    // How big is a row? Asked of THE ROW, not of the container divided by its row count.
    // Those two agree for an ordinary list and disagree completely for a list inside its
    // own scroller, because a scrolling container reports the box you can SEE: 62 Google
    // Maps places in a 791px-tall rail measured 5,205px² per row and scored as tag-cloud
    // trivia, when each row is really 408x110. Maps' own app shell — four same-class
    // panes, so full trust, and viewport-sized — then outscored the list inside it
    // 20.7M to 9.1M and EVICTED it in the nesting filter. The rail was never offered at
    // all: `detect` reported 4 rows off 61 cards and every `cycle` returned the same
    // wrong candidate.
    //
    // This is not a Maps quirk. Any list in its own scroller was being penalised by
    // roughly (visible height / content height), which is unbounded — the more the list
    // holds, the less it appears to be worth.
    //
    // Falls back to the old reading when no row has a box, for the display:contents case
    // above: a metric we cannot take must not become a penalty either.
    const perRow = med > 0 ? med : area / Math.max(1, rows.length);
    const size = Math.min(1, perRow / (ROW_FRAC * vp));

    let even = 1;
    if (boxes.length >= MIN_ROWS && med > 0) {
      const dev = boxes.map((a) => Math.abs(a - med)).sort((a, b) => a - b);
      even = Math.max(MIN_UNIFORM, 1 - dev[dev.length >> 1] / med);
    }

    // Counted on the container once rather than per row: a live collection's length
    // walks the subtree, and asking every row separately turned detection on a
    // 60-card grid from milliseconds into something the user would feel.
    const dense = el.getElementsByTagName('*').length / Math.max(1, rows.length);
    const rich = Math.max(MIN_RICH, Math.min(1, dense / RICH_TARGET));

    const trust = mode === 'all' ? GUESS_TRUST : 1;

    // AND DO THESE ROWS NAME DIFFERENT THINGS?
    //
    // Everything above measures how a candidate LOOKS — how big its rows are, how alike, how much
    // is in them. None of it can tell a product grid from a filter sidebar, and on amazon.com the
    // two are within a few percent of each other with the row count squared deciding it:
    //
    //   #s-refinements   242 x 8278   55 thin nav links   1.22e9   ← won on one load
    //   .s-main-slot    1002 x 6473   16 product cards    1.18e9   ← won on the next
    //
    // Measured twice on the same URL with opposite winners, so it is a coin flip, which is what
    // "sometimes it grabs the wrong table" actually is. Nothing was miscounted: `area x rows^2`
    // rewards many small rows, and a refinement panel is a tall narrow column of them.
    //
    // The question none of the other factors asks is whether the rows are DIFFERENT RECORDS. Fifty
    // -four rows that all resolve to `/s` are one record listed fifty-four times — and the walk
    // already knows it, because a hop ends when a page brings no new row identities. That is the
    // same judgement made twice: if dedupe would collapse this candidate to one row, detection
    // should not have picked it. Amazon's grid keeps 16 of 16 and is untouched.
    const ident = identSpread(rows);
    // A FORM IS NOT A LIST OF RECORDS. See `controlSpread` for the measurement and the live run
    // that forced it. Multiplied in beside `ident` rather than replacing it: the two catch
    // different sidebars — amazon's is links, shopee's is checkboxes — and a page can carry both.
    const ctrl = controlSpread(rows);

    const weighted = rows.length * size * even * rich * trust * ident * ctrl;
    return area * weighted * weighted;
  }

  // How many DISTINCT records a sample of rows names, as a fraction of the rows that name any.
  const IDENT_MIN_ROWS = 8;    // below this a repeat is coincidence, not a signature
  const IDENT_SAMPLE = 20;     // a navigation panel repeats from its first handful
  const IDENT_LINKED = 0.6;    // a list that mostly does not link is not judged on links
  // FLOORED, because this is a heuristic standing next to four others and it should lose an
  // argument it is wrong about. A quarter still costs a collapsing candidate 16x once the weight
  // is squared — decisive against amazon's sidebar, survivable by a real list this misreads.
  const IDENT_FLOOR = 0.25;

  // HOW MUCH OF THIS CANDIDATE IS A FORM RATHER THAN A LIST.
  //
  // `identSpread` above stops a refinement sidebar built of LINKS. It abstains on one built of
  // CHECKBOXES, because it judges by where rows point and those rows point nowhere — and the
  // abstention is right in principle: a metric we cannot take must not become a penalty.
  //
  // So this takes a metric we CAN. A row wrapping an input, a select or a textarea is a control
  // somebody operates; a record is a thing somebody reads. That is not an absence of evidence, it
  // is evidence, and it needs no links, no descriptor and no knowledge of the site.
  //
  // Measured live on shopee.co.id, a category page holding 60 products: `list_extract` with no
  // selector returned eight rows named `Lokasi`, `Tipe Penjual`, `Metode Pembayaran`, with columns
  // like `/fieldset.shopee-filter-group/legend`. Pinning the grid returned all 60 in six seconds,
  // so nothing was unpainted and nothing was throttled — the panel simply outscored the grid.
  const CTRL_SAMPLE = 20;      // same sample as identSpread; a form repeats from its first few
  const CTRL_FRAC = 0.6;       // below this it is a list that happens to contain a control
  const CTRL_FLOOR = 0.2;      // floored like ident, so a misread costs but does not erase

  // A row that holds a control AND links nowhere is a control. The link test is what keeps this
  // off real lists that carry a checkbox per row — an inbox, a file picker, a shopping cart — where
  // every row still points at the thing it is about.
  function controlSpread(rows) {
    if (!rows || !rows.length) return 1;
    let looked = 0;
    let controls = 0;
    for (const r of rows) {
      if (looked >= CTRL_SAMPLE) break;
      looked++;
      // A CONTROL INSIDE A LABEL OR A FIELDSET, NOT MERELY A CONTROL.
      //
      // The first version asked only whether the row held an input at all, and that is the shape of
      // an INBOX as much as a filter: a mail row, a file picker, a shopping cart all carry a
      // checkbox per row, and many of them link nowhere either because the click is handled in
      // JavaScript. Scored as forms they would have been demoted 25x once the weight is squared —
      // trading a filter-panel bug for a considerably worse one.
      //
      // `<label><input>` and `<fieldset>` are the difference, and they are not stylistic: a label
      // wrapping a control is the markup for "this control has a caption you operate it by", which
      // is a form field. A bare checkbox beside a subject line is a selection affordance on a row
      // that is about something else. Shopee's panel is <fieldset><legend> with <label><input>;
      // Gmail's rows are neither.
      let hasCtrl = false;
      let hasLink = false;
      try {
        hasCtrl = !!(r.querySelector && (r.querySelector('label input, label select, label textarea')
          || r.querySelector('fieldset input, fieldset select, fieldset textarea')
          || (r.tagName === 'FIELDSET' && r.querySelector('input, select, textarea'))));
        hasLink = !!(r.querySelector && r.querySelector('a[href]'));
      } catch (_) { hasCtrl = false; hasLink = false; }
      if (hasCtrl && !hasLink) controls++;
    }
    if (!looked) return 1;
    const frac = controls / looked;
    if (frac < CTRL_FRAC) return 1;
    // Scaled by how completely it is a form: all-controls is the clearest case and pays most.
    return Math.max(CTRL_FLOOR, 1 - frac);
  }
  function identSpread(rows) {
    if (!rows || !rows.length) return 1;
    const seen = new Set();
    let linked = 0;
    let looked = 0;
    for (const r of rows) {
      if (looked >= IDENT_SAMPLE) break;
      looked++;
      // THE WHOLE SET OF PATHS A ROW LINKS TO, not its longest one.
      //
      // `rowIdentity` takes the longest `origin+pathname`, and that is exactly the reading that
      // keys every 2GIS row by its category chip — a real list of firms would look like a collapse
      // and be penalised for it. A row's SET of link paths does not have that failure: 2GIS rows
      // share the rubric and differ by `/firm/<id>`, so their sets differ. Amazon's refinements
      // carry one link each, all `/s` with different queries, so their sets are identical.
      const paths = [];
      let as;
      try { as = r.querySelectorAll ? r.querySelectorAll('a[href]') : []; } catch (_) { as = []; }
      for (const a of as) {
        try {
          const u = new URL(a.href, location.href);
          if (!/^https?:$/.test(u.protocol)) continue;
          const k = u.origin + u.pathname;
          if (!paths.includes(k)) paths.push(k);
        } catch (_) {}
      }
      if (!paths.length) continue;
      linked++;
      seen.add(paths.sort().join(' '));
    }
    // BELOW IDENT_MIN_ROWS, A PARTIAL OVERLAP IS STILL LEFT ALONE — two rows sharing one link out
    // of several is easily coincidence, not a signature, which is what the floor below guarded
    // against by refusing to judge at all. TOTAL collapse is a different claim: every linked row,
    // down to the exact same complete set of paths, is not something a handful of unrelated rows
    // do by chance, at any sample size. Measured live on blibli.com/cari/android: a 4-"row"
    // candidate — page-chrome sections (filter aside, product section, pagination) mistaken for
    // list rows by `rowsOf` — never reached IDENT_MIN_ROWS, so it scored on raw area with NO
    // distinctness penalty at all, outscored the real product grid nested inside it, and the
    // nesting filter in `detect` EVICTED the real 40-item grid entirely because its only competitor
    // contained it. `page_study` reported the winner's own rows as "resolving to the same place";
    // nothing downstream had ever asked.
    if (rows.length < IDENT_MIN_ROWS) return (linked >= 2 && seen.size === 1) ? IDENT_FLOOR : 1;
    if (linked < looked * IDENT_LINKED) return 1;
    return Math.max(IDENT_FLOOR, seen.size / linked);
  }

  // --- masonry ---------------------------------------------------------------
  // A masonry grid has no element whose children are the items: the items are
  // dealt out into 2-4 sibling column wrappers first. Every candidate is then
  // one column, so no amount of cycling can offer the whole set — Unsplash comes
  // back as "8 photos" when 21 are on screen. Where sibling wrappers repeat the
  // same shape, stitch their rows back together under their shared parent.
  //
  // A HANDFUL of wrappers, each holding many items. That is not a detail of the shape, it is
  // the shape: masonry exists because a column cannot be the set, so there are two, three,
  // maybe four of them and the items are spread across them.
  //
  // Forty-eight wrappers holding three rows apiece is the opposite arrangement, and it is a
  // grid of forty-eight product cards being read one level too deep. Measured on Alibaba's
  // search results: each `fy26-product-card` yields three "rows" — `img-area-layout`,
  // `fy26-product-card-content`, `action-area-layout` — so the stitch produced 48 x 3 = 144,
  // and because a stitched reading REPLACES the plain one outright rather than racing it on
  // score, the correct 48-row reading of the grid was evicted.
  //
  // What that looks like to the person exporting: one product comes out as three rows, the
  // photo alone in the first, the title and price in the second, "Chat now" in the third. The
  // row anyone reads has an empty image column — on page one, before any hop is involved.
  const MASONRY_MAX_COLUMNS = 6;
  // A CEILING ON RAW COUNT ALONE, NOT ON SHAPE — see `allDistinct` below for the actual
  // classifier. Above `MASONRY_MAX_COLUMNS`, real distinctness is checked before refusing rather
  // than refusing outright: measured live on blibli.com/cari/android, an SPA re-render on page
  // two distributes a page's real, DISTINCT products round-robin across 7
  // `product-list__container__side` wrappers — one more than this cap — and with the merge
  // refused, the container's own naive reading took each wrapper as ONE row: several real
  // products crammed into a single record. `MASONRY_HARD_CAP` is what still stands in for
  // Alibaba's 48-wrapper case regardless of distinctness — nothing legitimate needs that many.
  const MASONRY_HARD_CAP = 16;
  // AND A COLUMN HOLDS MANY ITEMS. The count above is only half the rule, and the other half was
  // missing until a six-row fixture found it: six place cards, each holding three links, are
  // `6 <= MASONRY_MAX_COLUMNS` wrappers that every part of the count guard waves through — and
  // they came out as eighteen fragments, the record link, the website button and the directions
  // button of each card read as three separate rows.
  //
  // Rows per wrapper is what actually separates the two shapes, and it is the distinction the
  // comment above was already making without measuring it. Unsplash's masonry: 22 photos in 3
  // columns, 7.3 each. Alibaba's grid read one level too deep: 144 in 48, exactly 3. A Maps rail
  // of six cards: 18 in 6, exactly 3. A column is a container for a list; a card is a container
  // for the parts of one thing, and there are only ever a handful of those.
  const MASONRY_MIN_PER_COLUMN = 4;
  function columnMerges(cands) {
    const out = new Map(); // parent element -> synthesised candidate
    for (const c of cands) {
      const p = c.el.parentElement;
      if (!p || p === document.body || out.has(p)) continue;
      const mine = classesOf(c.el).sort().join(' ');
      if (!mine) continue; // without a class there is nothing to match siblings on
      const sibs = Array.from(p.children).filter((s) => classesOf(s).sort().join(' ') === mine);
      if (sibs.length < 2) continue;
      // An absolute ceiling regardless of distinctness — beyond this many wrappers the cost of
      // checking each one individually is not worth it, and nothing legitimate needs it.
      if (sibs.length > MASONRY_HARD_CAP) continue;

      const rows = [];
      let agree = 0;
      // Whether EVERY wrapper's own rows look like separate records rather than one item's own
      // parts — see the two floor bypasses below. Judged per wrapper, not on the assembled
      // total: a diluted overall ratio still reads as "distinct enough" even when every single
      // wrapper is one card's fragments repeated under a different product each time.
      let allDistinct = true;
      // AND WHETHER THE PAGE ITSELF SAYS THOSE ROWS ARE ROWS. `rowsOf` reports HOW it found a
      // wrapper's rows: every mode but 'all' means the page's own markup agreed on them — a class
      // list they share ('sig', 'class', 'grid'), a `<dl>`, a `role="feed"`. Mode 'all' is the
      // opposite: nothing agreed, and `alike()` GUESSED that every child is a row. The ranking
      // already halves a guess (`GUESS_TRUST`); a merge that bypasses its own floor on the claim
      // that "every wrapper proves it holds records" cannot rest on one.
      //
      // Measured on the six-card rail of test/site-mail.mjs — the exact shape the floor above was
      // written for — after `allDistinct` reopened it: each card is `<a> <span> <a> <a>`, no
      // classes anywhere, so `alike()` takes the three anchors for three rows, and because a
      // card's record link, website button and directions button point at three DIFFERENT places
      // `identSpread` calls them distinct. Six wrappers, eighteen "rows", all distinct, and the
      // rail came out as eighteen fragments again. Blibli's columns are the other side: their
      // rows are `.pcard` children the page's classes agree on, and they still merge.
      let allVouched = true;
      for (const s of sibs) {
        const r = rowsOf(s);
        if (!r || !r.rows.length) continue;
        agree++;
        if (identSpread(r.rows) <= IDENT_FLOOR) allDistinct = false;
        if (r.mode === 'all') allVouched = false;
        for (const x of r.rows) rows.push(x);
      }
      // Every wrapper must actually hold rows, or this is one list beside an
      // unrelated box that happens to share a class.
      if (agree < sibs.length || rows.length <= c.rows.length) continue;

      // TOO MANY WRAPPERS TO BE COLUMNS, UNLESS EVERY ONE OF THEM PROVES IT HOLDS REAL, DISTINCT
      // RECORDS rather than a card's own parts — see `MASONRY_HARD_CAP` above for why this is
      // safe: Alibaba's 48 wrappers never reach here on count alone, and would also fail
      // `allDistinct` (all three fragments of a card link to the same product).
      if (sibs.length > MASONRY_MAX_COLUMNS && !allDistinct) continue;
      // And hold enough of them to be a column rather than a card — see MASONRY_MIN_PER_COLUMN.
      //
      // BUT A LOW COUNT IS NOT THE SAME CLAIM AS A CARD'S OWN PARTS. Alibaba's 3-per-wrapper is
      // genuinely a card split into fragments — image, price, "Chat now" — and those fragments all
      // link to the SAME product, which `identSpread` on that one wrapper's own rows already
      // catches (a near-total collapse). Blibli's page-two columns average ~3.6 products each,
      // just under this floor, but every column is real, distinct products — so a merge that
      // fails the raw floor is still allowed through when nothing about it looks collapsed.
      //
      // DISTINCT AND VOUCHED FOR, both. Distinct alone let the six-card rail through (see
      // `allVouched` above): a card's parts point at different places too. What the bypass gives
      // up is exactly one shape — a handful of wrappers holding fewer than four UNCLASSED rows
      // each — and that shape merged only for the weeks between the bypass going in and this;
      // before the bypass the floor refused it outright. Above the floor nothing changes: an
      // unclassed masonry with four or more items a column still merges as it always did.
      if (rows.length < sibs.length * MASONRY_MIN_PER_COLUMN && !(allDistinct && allVouched)) continue;
      const area = p.offsetWidth * p.offsetHeight;
      out.set(p, {
        el: p, rows, sig: c.sig, mode: 'columns', area,
        // Remembered so the rows can be rebuilt the same way later. Without it a
        // later re-count asks the parent for its children and gets the three
        // COLUMNS back instead of the twenty-one photos — Unsplash collapsed
        // from 22 rows to 3 on the first scroll.
        mergeSig: mine,
        score: scoreOf(p, rows, area, 'columns'),
      });
    }
    return out.values();
  }

  // A name for a tab. Pages label their own lists — a heading above the grid, a
  // <caption>, an aria-label — and using the page's word beats "Table 2", which
  // tells you nothing about which one to open.
  function labelFor(el) {
    const clip = (s) => (s || '').trim().replace(/\s+/g, ' ').slice(0, LABEL_CLIP);

    const cap = el.querySelector?.(':scope > caption');
    if (cap) return clip(cap.textContent);

    const aria = el.getAttribute?.('aria-label');
    if (aria) return clip(aria);
    const by = el.getAttribute?.('aria-labelledby');
    if (by) { const t = document.getElementById(by); if (t) return clip(t.textContent); }

    // Nearest heading above — but only one actually above THIS list and in the
    // same column. Walking previous siblings blindly reads the sidebar:
    // Tokopedia's product grid came back labelled "Filter", which is the heading
    // of the filter panel beside it.
    const box = el.getClientRects()[0];
    if (!box) return '';
    const aligned = (h) => {
      const r = h.getClientRects()[0];
      if (!r) return false;
      if (r.bottom > box.top + HEADING_ABOVE_SLACK_PX) return false;      // must sit above the list
      if (box.top - r.bottom > HEADING_MAX_ABOVE_PX) return false;    // and not pages above it
      return r.left < box.left + box.width * HEADING_OVERLAP_FRAC     // and overlap it horizontally
        && r.right > box.left;
    };
    for (let n = el, hops = 0; n && hops < LABEL_HOPS; n = n.parentElement, hops++) {
      for (let sib = n.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (/^H[1-6]$/.test(sib.tagName) && aligned(sib)) return clip(sib.textContent);
        for (const h of sib.querySelectorAll?.('h1,h2,h3,h4,h5,h6') || []) {
          if (aligned(h)) return clip(h.textContent);
        }
      }
    }
    return '';
  }

  // Rebuild a candidate's rows the way that candidate was originally built. A
  // merged masonry candidate must be re-merged, not re-childrened.
  // A CONTAINER THAT WAS REPLACED IS STILL THE LIST.
  //
  // Turning a page in a single-page app does not always refill the container — plenty of them
  // build a new one and swap it in. The remembered node then goes detached, and a detached node
  // is not empty: it still holds the PREVIOUS page's rows, in full, and answers every question
  // about them perfectly well. So the engine reads 25 rows, all 25 dedupe against the 25 it
  // already has, and the walk concludes the list ran out. Measured on the blibli shape:
  // `saw=25 fresh=0` on page two, `connected:false` in the state probe, and a stall reported as
  // "page 2 held nothing new" — the one sentence that is true of both a finished list and this.
  //
  // Nothing here decides the list is gone. It re-finds it, and if it cannot, leaves the
  // candidate exactly as it was so the `LIST_GONE` checks that already exist can speak.
  //
  // The chain is trimmed FROM THE FRONT because the head of it is the part that goes stale: an
  // app that rebuilds its wrapper renames the ancestors while the container keeps its own id.
  // The tail describes what the thing IS; the head only describes where it used to sit. Same
  // move `harvest` makes for a remembered container.
  function reattach(c) {
    if (!c) return c;
    if (c.el && c.el.isConnected) {
      // TAKEN WHILE IT IS STILL VALID, because `pathOf` walks `parentElement`: once the app has
      // swapped the node out, its ancestors are gone and it can no longer say where it was.
      if (!c.selectorForHop) {
        try { c.selectorForHop = pathOf(c.el); } catch (_) { /* leave it empty */ }
      }
      return c;
    }
    let sel = c.selectorForHop || '';
    // AND IT STOPS WHILE THE SELECTOR STILL DESCRIBES SOMETHING. Trimming runs out at the last
    // segment, and a last segment can be a bare tag — at which point `querySelector('div')`
    // cheerfully returns the first div on the page and the candidate is silently rebound to the
    // masthead. An id or a class is the least that can be called evidence; without one the
    // container is treated as gone, which is a state the callers already handle (`LIST_GONE`).
    while (sel && /[#.]/.test(sel)) {
      try {
        const hit = document.querySelector(sel);
        if (hit) { c.el = hit; return c; }
      } catch (_) { /* an unusable fragment — keep trimming */ }
      const cut = sel.indexOf('>');
      if (cut < 0) break;
      sel = sel.slice(cut + 1);
    }
    return c;
  }

  function recount(c) {
    // Before anything is counted. `recount` exists because "the row array was captured when the
    // page was detected and a page does not hold still" — a container that was replaced outright
    // is the strongest form of that, and the one the row array cannot survive.
    reattach(c);
    if (c.mode === 'columns' && c.mergeSig != null) {
      const sibs = Array.from(c.el.children)
        .filter((s) => classesOf(s).sort().join(' ') === c.mergeSig);
      const rows = [];
      for (const s of sibs) {
        const r = rowsOf(s);
        if (r) for (const x of r.rows) rows.push(x);
      }
      if (rows.length) { c.rows = rows; return; }
    }
    const r = rowsOf(c.el);
    if (r && r.rows.length) { c.rows = r.rows; c.sig = r.sig; c.pair = r.pair; }
  }

  // Detection, scoped to ONE subtree — for a container a caller has NAMED. The page-wide
  // `detect` keeps the top five of the whole document, and a pane the ranking dislikes —
  // narrow, link-less, sitting beside something denser — is exactly the pane a caller has to
  // name, so "not in the kept set" is the expected case here rather than the odd one. Same
  // `rowsOf`, same `scoreOf`, same MIN_ROWS floor; the MIN_AREA_FRAC gate is dropped, because
  // a caller pointing at a small pane is the caller waiving the "big enough to matter"
  // heuristic. Column-merge stitching is skipped: it exists for masonry split across siblings,
  // and a caller with one of those points at the parent, which this reads directly.
  // A REFUSAL THAT CARRIES ITS OWN EVIDENCE.
  //
  // "matched an element, but no repeating rows were found inside it" is a true sentence that
  // leaves the caller with nowhere to go, and what they do next is the thing this tool exists to
  // stop: they go reading the engine's internals. Diagnosing the Discord rail took reading
  // `window.__holoscrapeRows` by raw state path and four passes over this file to find which of
  // MIN_ROWS, the area gate or the signature vote had said no — for a container the caller could
  // see 23 rows in. None of that is knowledge the caller should have to acquire.
  //
  // So the refusal answers it: which gate rejected this element, measured, in the words of the
  // thing that was measured. Read-only, and only built on the failure path, so it costs nothing
  // on the way through.
  function whyNoRows(el) {
    if (!el || !el.querySelectorAll) return { why: 'not an element' };
    const at = { at: pathOf(el), tag: el.tagName.toLowerCase(),
      size: `${el.offsetWidth}x${el.offsetHeight}` };
    if (!(el.offsetWidth * el.offsetHeight)) {
      return { ...at, why: 'it is on the page but has no size — hidden, collapsed, or not laid out' };
    }
    const kids = contentKids(el);
    if (kids.length < MIN_ROWS) {
      return { ...at, children: kids.length,
        why: `it holds ${kids.length} content children and a list needs at least ${MIN_ROWS}`,
        tell: 'the rows are probably one level further in' };
    }
    // The signature vote, reported rather than re-implemented: the same counting rowsOf does, so
    // what this says and what that decides cannot drift apart.
    const bySig = new Map();
    for (const k of kids) {
      const sig = classesOf(k).sort().join(' ');
      bySig.set(sig, (bySig.get(sig) || 0) + 1);
    }
    const need = Math.max(2, kids.length / 2 - 2);
    const top = [...bySig.entries()].sort((a, b) => b[1] - a[1])[0] || ['', 0];
    const r = rowsOf(el);
    if (r && r.rows.length >= MIN_ROWS) {
      return { ...at, rows: r.rows.length, mode: r.mode,
        why: 'this one DOES hold a list — it was not the element the selector reached first' };
    }
    return { ...at, children: kids.length,
      agree: `${top[1]} of ${kids.length} children share the commonest class signature`
        + `${top[0] ? ` (${top[0].slice(0, 80)})` : ' (they carry no classes at all)'}`,
      needed: Math.ceil(need),
      why: top[1] >= need
        ? 'its children agree but too few of them survived the row filter'
        : 'its children do not resemble each other enough to be rows of one list' };
  }

  function candidateWithin(root) {
    if (!root || !root.querySelectorAll) return null;
    let best = null;
    const consider = (el) => {
      const area = el.offsetWidth * el.offsetHeight;
      if (!area) return;
      const r = rowsOf(el);
      if (!r || r.rows.length < MIN_ROWS) return;
      const score = scoreOf(el, r.rows, area, r.mode);
      if (!best || score > best.score) {
        best = { el, rows: r.rows, sig: r.sig, mode: r.mode, pair: r.pair, area, score };
      }
    };
    consider(root);
    let swept = 0;
    for (const el of root.querySelectorAll('*')) {
      if (++swept > MAX_SWEEP) break;
      consider(el);
    }
    if (best) best.label = labelFor(best.el);
    return best;
  }

  // --- candidate scoring ----------------------------------------------------
  // area x rows^2. Row count is weighted quadratically on purpose: the nav bar
  // and the footer are often larger in pixels than the product grid, and only
  // the repeat count tells them apart.
  function detect(fresh) {
    const pageArea = Math.max(1, innerWidth * innerHeight);
    const all = document.body ? document.body.querySelectorAll('*') : [];
    const cands = [];
    let swept = 0;
    let truncated = false;

    for (const el of all) {
      if (++swept > MAX_SWEEP) { truncated = true; break; }
      // offsetWidth/Height are layout reads only — nothing in this loop writes
      // style, so the browser computes layout once rather than per element.
      const area = el.offsetWidth * el.offsetHeight;
      if (!area || area < MIN_AREA_FRAC * pageArea) continue;
      const r = rowsOf(el);
      if (!r || r.rows.length < MIN_ROWS) continue;
      cands.push({
        el, rows: r.rows, sig: r.sig, mode: r.mode, pair: r.pair, area,
        score: scoreOf(el, r.rows, area, r.mode),
      });
    }

    // A stitched masonry candidate and the plain reading of its parent are two
    // readings of ONE element, and Node.contains() reports true for itself — so
    // they do not merely compete, the winner *evicts* the loser in the nesting
    // filter below. The stitched reading is the complete set by construction
    // (columnMerges only emits it when it holds more rows), so it replaces the
    // plain one outright rather than racing it on score.
    const merges = Array.from(columnMerges(cands));
    if (merges.length) {
      const parents = new Set(merges.map((m) => m.el));
      for (let i = cands.length - 1; i >= 0; i--) if (parents.has(cands[i].el)) cands.splice(i, 1);
      for (const m of merges) cands.push(m);
    }
    // A CANDIDATE THAT LINKS NOWHERE DOES NOT WIN A COIN FLIP AGAINST ONE THAT DOES.
    //
    // `identSpread` catches a sidebar of links and `controlSpread` catches one of checkboxes.
    // Neither catches a panel that is plain text — a list of category names, a tag cloud, a
    // breadcrumb rail — competing with a grid of records. The score cannot separate those either:
    // `area x rows^2` rewards many small rows, which is precisely what such a panel is.
    //
    // The rule is deliberately NOT "linkless loses". A data table of numbers legitimately links
    // nowhere and must still beat a navigation strip that links everywhere, so a blanket rule
    // would trade this bug for a worse one. It applies only inside the COIN-FLIP BAND — where the
    // two scores are close enough that which one wins is already luck. The measurement in
    // `scoreOf` above names that band exactly: amazon's refinements and its product grid came in
    // at 1.22e9 and 1.18e9, three percent apart, with opposite winners on two loads of the same
    // url. Inside that band a row that points at the thing it is about is the better bet; outside
    // it, the score has actually said something and is left alone.
    // SCORE ORDER, AND NOTHING ELSE. A tiebreak was added here on 2026-09-21 and removed the same
    // hour, which is worth recording so nobody adds it again.
    //
    // The idea was that inside a narrow band where two scores are effectively tied — the amazon
    // measurement in `scoreOf` above, 1.22e9 against 1.18e9 with opposite winners on two loads —
    // a candidate whose rows LINK OUT is the better bet than one whose rows link nowhere.
    //
    // Two things killed it. It earned nothing: the filter-panel fixture it was written alongside
    // passes on `controlSpread` alone, so it never had a test of its own. And it is dangerous in a
    // way the fixture could not see: reordering candidates decides which one the NESTING FILTER
    // below keeps, and the loser there is not demoted, it is DISCARDED. On mail.google.com a
    // 3-row promo wrapper was the only candidate `page_study` offered while `@dom(tr.zA)` on the
    // same tab returned 50 message rows. A rule that can silently delete the answer needs better
    // evidence than a plausible argument, and it had none.
    //
    // If a coin-flip tiebreak is ever wanted again, it belongs AFTER the nesting filter, where
    // losing means ranking second rather than not existing.
    cands.sort((a, b) => b.score - a.score);

    // Pages routinely hold several lists — a product grid plus "recently viewed"
    // plus "related", or three tables in one article — so keep all of them, not
    // one. What gets dropped is nesting, not siblings: if a candidate sits inside
    // one we already kept it is a PART of that list (a masonry column, the div
    // wrapping the grid), and offering it as a separate table is a lie.
    const kept = [];
    for (const c of cands) {
      if (kept.some((k) => k.el.contains(c.el) || c.el.contains(k.el))) continue;
      kept.push(c);
      if (kept.length >= KEEP) break;
    }

    // Several lists is right; several *scraps* is not. Beside a real grid, a 3-row
    // breadcrumb strip is not a table anyone came for — it is a tab they have to
    // read and dismiss.
    //
    // This bar used to be a fraction of the biggest list, which fails whenever one
    // list is enormous: beside the 303-link farm, `top / 4` demanded 76 rows and
    // threw away the 18-card product grid that was the whole point. An absolute
    // floor does the job the fraction was actually doing — the 4-row filter strips
    // this was written for are still gone — without letting one outlier decide
    // what counts as a list.
    const worth = kept.filter((c, i) => i === 0 || c.rows.length >= MIN_TAB_ROWS);
    kept.length = 0;
    for (const c of worth) kept.push(c);
    for (const c of kept) c.label = labelFor(c.el);

    // A RE-DETECT MUST NOT UNDO A CHOICE.
    //
    // `i: 0` was harmless while nothing could choose but the score. The passive poll re-runs this
    // every 2.5 seconds, so the moment a person can pick a list by hand, their pick survives for
    // at most two and a half seconds and then silently becomes the highest-scoring one again —
    // and on a page where the wrong list wins by 3%, that is the whole feature undone.
    //
    // Carried by ELEMENT, not by index: the ranking is what re-detection is for, so the same list
    // routinely lands at a different position. If the chosen element is gone from the page or from
    // the kept set, the score decides again, which is the right answer for a page that changed.
    // `fresh` DISCARDS THE PREVIOUS CHOICE ON PURPOSE — see the note on preservation below and the
    // caller in `container`. Re-detecting during the wait after a page turn is worthless if it
    // keeps handing back the candidate chosen before the list existed.
    //
    // A PIN OUTRANKS ALL OF THAT, `fresh` INCLUDED — because a pin is not a choice this engine
    // made and may re-derive; it is an instruction. The bridge's `list_extract` sets one when a
    // caller names the container by CSS selector (the `pin` action below), and the caller names
    // it precisely because the score picks the OTHER pane: beside an open conversation, a chat
    // app's narrow sidebar list loses area x rows^2 every single time — denser, wider, more rows
    // is the right answer to the wrong question. So any rescan that falls back to the ranking,
    // including the `fresh` one `study` and the page-turn wait use, would re-create the exact
    // bug the selector was passed to prevent. Resolved by ELEMENT first and by selector when a
    // re-render replaced the node; only when neither answers — the container is truly gone —
    // does the ranking take over for this scan, and the pin stays set so the next poll of a
    // still-painting page can catch the container coming back. Cleared by a person picking in
    // the panel ('pick'), by an empty-selector 'pin', or by navigation (stamp() wipes the state).
    const pin = window[S]?.pin || null;
    let at = 0;
    let pinHeld = false;
    if (pin) {
      let want = pin.el && pin.el.isConnected ? pin.el : null;
      if (!want) { try { want = document.querySelector(pin.selector); } catch (_) { want = null; } }
      if (want) {
        // Matched loosely — contains either way — for the same reason the descriptor match below
        // is: a selector names the container a human would point at (the scrolling pane), and the
        // detector legitimately settles on the row list just inside it.
        let found = kept.findIndex((c) => c.el === want || want.contains(c.el) || c.el.contains(want));
        if (found < 0) {
          // NOT KEPT IS NOT THE SAME AS NOT A LIST. `kept` is the page-wide top five, and the
          // pinned pane losing that contest is the normal case — so detection re-runs scoped to
          // the pinned subtree and its winner is force-added, offered ALONGSIDE the ranking's
          // answers rather than displacing them.
          const forced = candidateWithin(want);
          if (forced) { kept.push(forced); found = kept.length - 1; }
        }
        if (found >= 0) {
          at = found;
          pin.el = kept[found].el; // re-anchor: the element survives re-renders better than the selector
          pinHeld = true;
        }
      }
    }
    const was = (fresh || pinHeld) ? null : (window[S]?.cands?.[window[S].i]?.el || null);
    if (was) { const found = kept.findIndex((c) => c.el === was); if (found >= 0) at = found; }
    else if (!pinHeld) {
      // A DESCRIPTOR MAY NAME THE LIST OUTRIGHT.
      //
      // The score ranks; a descriptor states. Where a site has actually been measured there is no
      // reason to re-derive the answer on every page load and get a different one — amazon's
      // `/s?k=…` was measured twice with opposite winners three percent apart.
      //
      // It sets the DEFAULT SELECTION and nothing else. Every list stays offered, the ranking is
      // untouched, and the branch above wins outright: a person who has picked a list keeps it,
      // because a descriptor is a better guess than the score and still only a guess about what
      // someone wants. Matched loosely — `contains` either way — since the selector names the
      // container a human would point at and the detector may legitimately have settled on the
      // element just inside or just outside it.
      const named = (PROVIDERS[mapKind()] || {}).list;
      if (named) {
        let want = null;
        // VISIBLE FIRST — see `visibleMatch`. The hidden twin is a real element with real rows.
        try { want = visibleMatch(named) || document.querySelector(named); } catch (_) { want = null; }
        if (want) {
          const found = kept.findIndex((c) => c.el === want
            || want.contains(c.el) || c.el.contains(want));
          if (found >= 0) at = found;
        }
      }
    }
    window[S] = { cands: kept, i: at, swept, truncated, epoch: op.epoch || 0, href: here(), pin, pinHeld };
    return window[S];
  }

