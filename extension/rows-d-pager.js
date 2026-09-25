  // --- selector -------------------------------------------------------------
  // Ids containing digits are almost always generated (`item-4821`,
  // `radix-:r3:`) and differ on the next load, so they are worse than useless
  // as an anchor — classes survive where they do not.
  // A SELECTOR THIS ENGINE PRINTS MUST FIND THE ELEMENT IT DESCRIBES.
  //
  // It did not, and the failure was invisible because both halves looked right. The path is
  // capped at nine segments, so it does not start at the root and is free to match somewhere
  // else; `resolve()` reads such a path with `querySelectorAll` and takes the LAST hit, while the
  // `pin` action read it with `querySelector` and took the FIRST. Measured on Discord: page_study
  // printed a nine-segment path for the 23-row server rail, list_extract was handed that exact
  // string back and answered "matched an element, but no repeating rows were found inside it" —
  // because the element it matched was not the rail. The tool contradicted its own output, and a
  // person following the documented workflow could not get past step one.
  //
  // Fixed where it is created rather than at each reader: the path is checked against the page and
  // disambiguated with :nth-child from the deepest segment upward until it selects exactly the
  // element it was built from. Only ambiguous paths are touched, so every selector that already
  // round-tripped is byte-identical to before.
  function pathOf(el) {
    const parts = [];
    const nodes = [];
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      const id = (n.getAttribute?.('id') || '').trim();
      const cls = classesOf(n);
      // A DIGIT IS NOT THE ONLY SHAPE A GENERATED ID TAKES. Gmail and every other
      // Closure-built Google app (Drive, Calendar, Docs) number their elements `:0`,
      // `:1`... in base 36, so a fresh page just as often lands on `:kt`, `:kv`, `:kw` —
      // no digit in sight, and gone the moment the control re-renders. Measured live:
      // pointing at Gmail's "Older" button anchored on `#\:kw`, the very next page turn
      // replaced it with a different id, and every later press reported "I lost track of
      // that control" even though the same button, with the same classes, was sitting
      // right there. A leading colon is not a character a person hand-writes into an id;
      // treating it as a second generated-id signal is exactly as safe as the digit test
      // already there, and catches the whole family this Google-specific scheme covers.
      const genId = !id || /\d/.test(id) || id.startsWith(':');
      if (id && !genId) s += '#' + CSS.escape(id);
      else if (cls.length) s += cls.map((c) => '.' + CSS.escape(c)).join('');
      parts.unshift(s);
      nodes.unshift(n);
      if (parts.length > PATH_SEGMENTS) break;
    }
    // Does it round-trip? `querySelectorAll` rather than `querySelector`, because "matches one
    // other thing first" and "matches nothing" are different faults and only the first is fixable
    // here.
    const hits = (sel) => { try { return [...document.querySelectorAll(sel)]; } catch (_) { return []; } };
    let sel = parts.join('>');
    let found = hits(sel);
    if (found.length === 1 && found[0] === el) return sel;
    for (let i = parts.length - 1; i >= 0 && !(found.length === 1 && found[0] === el); i--) {
      const n = nodes[i];
      const at = n.parentElement ? [...n.parentElement.children].indexOf(n) + 1 : 0;
      if (at > 0) parts[i] += `:nth-child(${at})`;
      sel = parts.join('>');
      found = hits(sel);
    }
    return sel;
  }

  // A stored selector that no longer matches is usually still mostly right —
  // the page gained or lost an outer wrapper. Chop segments off the front until
  // something matches rather than failing outright.
  function resolve(sel, root) {
    const scope = root || document;
    let s = sel;
    while (s) {
      try { const hit = scope.querySelectorAll(s); if (hit.length) return hit[hit.length - 1]; } catch (_) {}
      const cut = s.indexOf('>');
      if (cut < 0) return null;
      s = s.slice(cut + 1);
    }
    return null;
  }

  // --- page hop ---------------------------------------------------------------
  // Some lists do not grow at all: they end, and offer page 2. Pixabay's video search
  // is 129 items and an <a href="?pagi=2">; Coverr's is a "Go to next page" link. There
  // is nothing to press and nothing to scroll — the rest of the list is on another URL.
  //
  // It is FETCHED, not navigated to. Navigating would throw away the list already in
  // hand, move the user's tab, and cost a full render per page; a fetch costs one GET
  // and leaves the page they are looking at exactly as it is. Measured on Pixabay:
  // page 3 came back in 1.09 MB and parsed to 130 links and 119 image sources.
  //
  // The fetched document has NO LAYOUT — every box is zero — so detection cannot run on
  // it and must not be asked to. It is read with page one's own selectors instead,
  // which is the right thing regardless: the same template rendered twice should be
  // read the same way, not scored afresh and possibly differently.

  // Which numeric part of a URL is its page. Returned as a setter so the same reasoning
  // covers ?page=2, ?pagi=2, ?start=60 and /page/2 without four code paths.
  function pageDial(u) {
    try {
      const x = new URL(u, location.href);
      for (const [k, v] of x.searchParams) {
        if (!/^\d{1,6}$/.test(v)) continue;
        if (!/page|pagi|start|offset|from|p$|pg/i.test(k)) continue;
        return { n: +v, at: 'query', key: k, url: x };
      }
      const m = x.pathname.match(/\/(page|p)\/(\d{1,6})\/?$/i);
      if (m) return { n: +m[2], at: 'path', key: m[1], url: x };
      // A page number living in the FILENAME. Alibaba's categories are
      // `contact-lenses_361210.html` for page one and `contact-lenses_361210_2.html` for
      // page two — so the URL the user is standing on was not even recognised as a page,
      // and no link could be one page further than it.
      //
      // Two numbers are required, not one: the first is the category and the last is the
      // page. `..._361210.html` carries only an id, which is page one and has no dial —
      // reading that id as a page number would ask the site for page 361,211.
      const f = x.pathname.match(/_(\d{1,9})_(\d{1,5})(\.html?)?$/i);
      if (f) return { n: +f[2], at: 'file', key: f[1], url: x };
      // THE PLAINEST FORM OF ALL, AND THE ONE THAT WAS MISSING: `page-2.html`, `page_2.html`,
      // `page2`, `index_2.html`. A static site has no query string and no router, so the page
      // number can only live in the file name. Measured on books.toscrape.com — the sandbox every
      // scraping tutorial points at — through the product's own path: `list_extract {pages: 2}`
      // came back `pages: 1, why: "no further pages"` with
      //   <li class="next"><a href="page-2.html">next</a></li>
      // sitting on the page. The one link whose whole text is "next" was discarded for not
      // carrying a number this function could read.
      //
      // Only the words `page` and `index`, and only ONE TO THREE digits. `p` is left out on
      // purpose: `/p-104433` is a product id on half the shops there are. Three digits is a
      // measurement rather than a word list — a list with a thousand pages is rare, and the
      // four-digit thing in a file name is a year (`index-2024.html`, `page-2024.html`), which
      // must never read as page 2,024. The caller's `d.n === want` check is the second guard:
      // even a number that slips through still has to be exactly one more than where we stand.
      const g = x.pathname.match(/\/(page|index)[-_]?(\d{1,3})(\.[a-z]{2,5})?$/i);
      if (g) return { n: +g[2], at: 'file', key: g[1], url: x };
      return null;
    } catch (_) { return null; }
  }

  // A next-page link, told apart from every other link that happens to carry a page
  // number. The trap this exists for: Pixabay's LANGUAGE SWITCHER carries `?pagi=2` on
  // every one of its thirty entries, so matching on the parameter alone follows a link
  // into Czech. A next link keeps the current pathname and only turns the dial.
  // A PAGER MADE OF BUTTONS, which no amount of link-hunting will ever find.
  //
  // Measured on blibli.com/cari/android: six controls reading `1 2 3 4 5 … 20`, every one a
  // `<button>` with `href: null`. `findNextPage` answers `{none:true}` and is right to — there is
  // no link, and `pageDial` never gets an href to read. The `?page=2&start=39` URL the site ends up
  // at is where its router goes AFTER the click; it is nowhere in the markup beforehand.
  //
  // So the pager is found by what it looks like instead: a run of clickable things whose entire
  // text is a small number, sharing a parent. That shape is a page list and almost nothing else is
  // — a price, a rating or a count sits alone, not in a numbered sequence of four or more.
  //
  // Which one is current is read from what pagers actually mark it with, in order of how much they
  // mean: `aria-current` is unambiguous, `disabled` on a number means you are standing on it, and a
  // class saying so is the common case. Failing all three, the URL is asked — and failing that,
  // page one, because that is where a list starts.
  //
  // Returns the NEXT number, not an arrow: arrows here are icon-only buttons with no text at all,
  // and picking one by position is how you press "previous".

  // Distinct record links on the page, by path AND query. Used to answer 'did the list grow' without
  // asking the extractor — the thing under test must not be its own measuring device. Query included
  // because YouTube's results are all '/watch?v=...': counting paths alone collapsed twenty videos
  // into one and reported the most famously infinite list on the web as static.
  function countRecordLinks() {
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const raw = a.getAttribute('href');
      if (!raw || /^(#|javascript:|mailto:|tel:)/i.test(raw)) continue;
      try {
        const u = new URL(raw, location.href);
        if (u.origin === location.origin) seen.add(u.pathname + u.search);
      } catch (_) { /* not a url */ }
    }
    return seen.size;
  }

  function findPagerButtons() {
    const num = (el) => {
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      return /^\d{1,4}$/.test(t) ? +t : null;
    };
    const hits = [];
    for (const el of document.querySelectorAll('button,[role="button"],a,li')) {
      const n = num(el);
      if (n === null || !el.getClientRects().length) continue;
      hits.push({ el, n, parent: el.parentElement });
    }
    if (hits.length < PAGER_MIN_BUTTONS) return null;
    // The biggest group of numbered siblings is the pager; anything smaller is a coincidence.
    const groups = new Map();
    for (const h of hits) {
      const k = h.parent;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(h);
    }
    let best = null;
    for (const g of groups.values()) if (!best || g.length > best.length) best = g;
    if (!best || best.length < PAGER_MIN_BUTTONS) return null;
    best.sort((a, b) => a.n - b.n);

    const marked = (el) => el.getAttribute('aria-current')
      || el.disabled || el.getAttribute('aria-disabled') === 'true'
      || /(^|[\s_-])(active|current|selected|is-active|is-current)([\s_-]|$)/i
        .test(el.className?.toString() || '');
    let cur = best.find((h) => marked(h.el) || marked(h.el.parentElement));
    let at = cur ? cur.n : null;
    if (at === null) {
      try {
        const q = new URL(location.href).searchParams;
        for (const [k, v] of q) if (/^page$/i.test(k) && /^\d{1,4}$/.test(v)) { at = +v; break; }
      } catch (_) {}
    }
    if (at === null) at = 1;
    // The exact next number if it is rendered; otherwise the smallest one beyond where we are,
    // which is what a sliding window with an ellipsis leaves us.
    const want = best.find((h) => h.n === at + 1) || best.find((h) => h.n > at);
    if (!want) return null;
    return { el: want.el, page: want.n, from: at, count: best.length };
  }

  // --- THE PAGER, BY WHAT A SCREEN READER WOULD CALL IT -------------------------------------------
  //
  // Every tier in `findNextPage` below was gated on `pageDial(href)`: a link had to carry a page
  // number this file could read, in a path this file judged to be the same list, before anything
  // else about it was looked at. Its accessible name — the one thing the SITE says about what the
  // control is for — was only ever an output label. Measured 2026-09-22 through the real MCP path
  // (probe/scoreboard.mjs, row `books-all`): https://books.toscrape.com/ answered 20 of 60 rows,
  // `pages: 1, why: "no further pages"`, with
  //   <li class="next"><a href="catalogue/page-2.html">next</a></li>
  // on the page. Page one is `/index.html` and page two is in ANOTHER DIRECTORY, so the same-list
  // path comparison threw it out a day after `page-N.html` had been taught to `pageDial` for the
  // category pages of the same site. The next site will have a sixth url shape. Playwright and
  // chrome-devtools-mcp target by role and name for this reason (PLAYWRIGHT-DEVTOOLS-MCP-STUDY.md
  // §D): what a control is CALLED survives every url scheme.
  //
  // So role + accessible name are evidence, and `pageDial` is demoted from gate to guard and
  // booster: a readable number that goes the wrong way REJECTS a named control, one that is
  // exactly the next page CONFIRMS it, and an unreadable address is no longer an objection.
  //
  // WIDENING THIS MATCHER REPEALS WHAT THE URL GATE WAS QUIETLY DOING, so every shape it newly
  // reaches has a guard here and a fixture in test/pager-by-name.mjs:
  //
  //   a carousel's next, a calendar's next-month,   a named control under an ancestor that is a
  //   a lightbox, a language switcher               different widget (role, roledescription, table
  //                                                 grid, or the widget families' class words)
  //   "Next" in a footer, header or sidebar         landmark ancestors the list is NOT inside —
  //                                                 the same region idea as `clicknext`'s text
  //                                                 rung, which scopes to the list's parent
  //   a control beside the list                     geometry: no horizontal overlap with the list
  //                                                 while level with it
  //   a control above the list                      only when something marks it as a pager
  //   "Next article", "Next: On paper"              a CLOSED vocabulary matched whole, never
  //                                                 `.includes('next')` — same rule, same reason,
  //                                                 as the text rung in `clicknext`
  //   a "›" on every card                           counted: a name carried by two or more ROWS,
  //                                                 or by three different addresses, is not a pager
  //   the last page's arrow wrapping to page 1      the dial guard
  //   another origin, "#", this same page           address checks
  //   disabled / aria-current                       how a pager says LAST PAGE — and it says so
  //                                                 far more reliably than by removing the control
  //
  // A BUTTON WITH NO ADDRESS IS SEEN, NAMED AND REPORTED — AND NOT PRESSED. Name-matching as
  // DISCOVERY of something to press was tried once and reverted within the hour (see the named
  // rung in `clicknext`): it flipped `morePages` on a page whose list the press destroys, and a
  // 50-row inbox read as 3 and then 0. A link is different in kind: it has an address, following
  // it is a navigation the walk already verifies ("page N held nothing new"), and nothing is
  // pressed on the person's page. So a named button comes back as the first near miss with its
  // selector, and `list_extract {next: <that selector>}` is the caller saying "that one" — which
  // is the only condition under which the press was ever safe.
  //
  // Kept short ON PURPOSE. A closed list stays closed by staying a list; the pointed control
  // (`next`) is the universal fallback for every word that is not here.
  const NEXT_NAMES = new Set([
    'next', 'next page', 'go to next page', 'older', 'older posts', 'older entries',   // English
    'berikutnya', 'selanjutnya', 'halaman berikutnya',                // Indonesian
    'siguiente', 'página siguiente',                                   // Spanish
    'próxima', 'próximo', 'próxima página',                            // Portuguese
    'suivant', 'suivante', 'page suivante',                            // French
    'weiter', 'nächste', 'nächste seite',                              // German
    '次へ', '次のページ', '下一页', '下一頁',                               // Japanese, Chinese
    '›', '»', '>', '→',
  ]);
  const PREV_NAMES = new Set([
    'prev', 'previous', 'previous page', 'go to previous page', 'newer', 'newer posts', 'newer entries', 'back',
    'sebelumnya', 'halaman sebelumnya', 'anterior', 'página anterior',
    'précédent', 'précédente', 'page précédente', 'zurück', 'vorherige', 'vorherige seite',
    '前へ', '前のページ', '上一页', '上一頁',
    '‹', '«', '<', '←',
  ]);
  // What the control is CALLED, in the ARIA order, as far as a pager needs it: labelledby,
  // aria-label, its own content (a child image's alt stands in for an icon), then title. Forty
  // lines rather than Playwright's thousand, because a pager's name is never computed from a
  // form label, a table caption or a CSS pseudo-element.
  const pagerName = (el) => {
    const clip = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = clip(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' '));
      if (t) return t;
    }
    const aria = clip(el.getAttribute('aria-label'));
    if (aria) return aria;
    const text = clip(el.textContent) || clip(el.value);
    if (text) return text;
    const pic = el.querySelector?.('img[alt], [aria-label], svg title');
    const alt = clip(pic?.getAttribute?.('alt') || pic?.getAttribute?.('aria-label') || pic?.textContent);
    return alt || clip(el.getAttribute('title'));
  };
  // "Next »", "» Next" and "Next" are one name; "»" alone is a name too. The arrows are stripped
  // only when words remain, and what remains must equal a vocabulary entry WHOLE.
  const pagerWord = (name) => {
    const t = name.toLowerCase().replace(/\s+/g, ' ').trim();
    const words = t.replace(/[›»>→⟶‹«<←⟵]+/g, ' ').replace(/\s+/g, ' ').trim();
    return words || t.replace(/\s+/g, '');
  };
  // The widget families a "next" lives in that are not pagers. Class words are a proxy and are
  // treated as one: they only ever REJECT, and the rejection is reported with the word in it.
  const NOT_A_PAGER = /(^|[^a-z])(sidebar|carousel|slider|slick|swiper|slideshow|splide|flickity|gallery|lightbox|calendar|datepicker|date-picker|breadcrumb|lang|language|locale|modal|popup|newsletter|testimonial)s?([^a-z]|$)/i;
  const PAGERISH = /pag(er|ination|inate|ing)|page-?nav|page-?numbers|pages/i;

  function nextByName({ here, nowN, want, container, rows }) {
    const misses = [];
    const counts = { nextNamed: 0, previousNamed: 0 };
    const listBox = container ? container.getBoundingClientRect() : null;
    const hrefNoHash = (h) => h.replace(/#.*$/, '');
    const herePlain = hrefNoHash(location.href);
    // `final`: the control is the pager and it has said no — nothing to hand back as an override.
    const miss = (rank, el, label, rejected, href, final = false) => misses.push({ rank, el, label, rejected, href, final });
    const ok = [];
    let lastPage = false;
    let looked = 0;
    for (const el of document.querySelectorAll('a[href], area[href], button, [role="button"], [role="link"], input[type="button"], input[type="submit"]')) {
      // The same ceiling `findLoadMore` sweeps under; a page with more controls than this is
      // read for its first four thousand, and says so through `saw`.
      if (++looked > MORE_SWEEP) break;
      const name = pagerName(el);
      if (!name || name.length > PAGER_NAME_MAX) continue;
      const word = pagerWord(name);
      const rel = (el.getAttribute('rel') || '').toLowerCase();
      if (PREV_NAMES.has(word) || /(^|\s)prev(ious)?(\s|$)/.test(rel)) { counts.previousNamed++; continue; }
      const relNext = /(^|\s)next(\s|$)/.test(rel);
      if (!NEXT_NAMES.has(word) && !relNext) continue;
      counts.nextNamed++;
      const label = name.slice(0, 60);
      const raw = el.getAttribute('href');
      let u = null;
      if (raw && !/^(javascript:|mailto:|tel:)/i.test(raw.trim())) { try { u = new URL(raw, location.href); } catch (_) { u = null; } }
      const href = u ? u.href : '';

      if (!el.getClientRects().length) { miss(5, el, label, 'not rendered — a hidden twin of a control, or a collapsed menu', href); continue; }
      // WHERE IT SITS, judged only against ancestors the list is NOT inside: a list that lives in
      // an <aside> has its pager there too, and that is its region, not furniture.
      let where = '';
      let pagerish = false;
      let depth = 0;
      for (let n = el; n && n !== document.body && !(container && n.contains(container)); n = n.parentElement, depth++) {
        const tag = n.tagName;
        const role = (n.getAttribute('role') || '').toLowerCase();
        const named = `${n.className?.toString?.() || ''} ${n.id || ''}`;
        if (tag === 'NAV' || role === 'navigation' || PAGERISH.test(`${named} ${n.getAttribute('aria-label') || ''}`)) pagerish = true;
        if (where) continue;
        if (tag === 'FOOTER' || role === 'contentinfo') where = 'in the page footer';
        else if (tag === 'HEADER' || role === 'banner') where = 'in the page header';
        else if (tag === 'ASIDE' || role === 'complementary') where = 'in a sidebar';
        else if (tag === 'TABLE' || role === 'grid') where = 'inside a table or calendar grid';
        else if (/^(dialog|menu|menubar|tablist|listbox|combobox)$/.test(role)) where = `inside a ${role}`;
        else if (/carousel|slide/i.test(n.getAttribute('aria-roledescription') || '')) where = 'inside a carousel';
        // `footer` as a class word is judged WHOLE: `card-footer` and `results-footer` are where a
        // pager conventionally sits, and only the site's own footer is furniture.
        else if (named.split(/\s+/).some((t) => /^((site|page|global|main)[-_]?)?footer$/i.test(t))) where = 'in the page footer';
        else {
          const m = NOT_A_PAGER.exec(named);
          if (m) where = `inside a "${m[2].toLowerCase()}" widget`;
        }
      }
      const dead = (n) => !!n && (n.disabled || n.getAttribute('aria-disabled') === 'true'
        || /(^|\s)(disabled|is-disabled)(\s|$)/.test(n.className?.toString() || ''));
      const current = (n) => { const v = n?.getAttribute?.('aria-current'); return !!v && v !== 'false'; };
      if (where) { miss(4, el, label, `outside the list's region — ${where}`, href); continue; }
      if (!container) { miss(4, el, label, 'no list was found on this page to place it against', href); continue; }
      const r = el.getBoundingClientRect();
      const inside = container.contains(el);
      if (!inside && listBox && (r.right <= listBox.left || r.left >= listBox.right)
          && r.top < listBox.bottom && r.bottom > listBox.top) {
        miss(4, el, label, 'outside the list\'s region — beside the list, not in its column', href); continue;
      }
      if (dead(el) || dead(el.parentElement)) {
        lastPage = true;
        miss(0, el, label, 'disabled — the pager is saying this is the last page', href, true); continue;
      }
      if (current(el) || current(el.parentElement)) { miss(0, el, label, 'marked aria-current — it is the page we are on', href, true); continue; }
      if (!u) {
        miss(0, el, label, raw
          ? 'its href is not an address (javascript:, mailto:)'
          : 'a control with no address — a name alone is not enough to PRESS something unasked; pass it as `next` to press it', '');
        continue;
      }
      if (u.origin !== location.origin) { miss(3, el, label, 'it leads to another site', href); continue; }
      if (hrefNoHash(u.href) === herePlain) { miss(1, el, label, 'it points at the page we are already on', href); continue; }
      // THE DIAL, AS A GUARD. Compared only where both ends are readable and mean the same thing:
      // an offset (`?start=20`) is not a page number, and page one of a zero-indexed site has no
      // dial at all, so `?page=1` from there is forwards, not "page 1 again".
      const d = pageDial(u.href);
      const pageLike = d && (d.at !== 'query' || !/start|offset|from/i.test(d.key));
      if (d && here && d.at === here.at && String(d.key).toLowerCase() === String(here.key).toLowerCase() && d.n <= here.n) {
        miss(1, el, label, `its page number (${d.n}) is not after the page we are on (${here.n})`, href); continue;
      }
      const sameDial = !here || (d && d.at === here.at);
      if (d && pageLike && sameDial && d.n > want) {
        miss(1, el, label, `its page number (${d.n}) skips past the next page (${want}) — a "last page" control`, href); continue;
      }
      const confirmed = relNext || (!!d && d.n === want);
      if (!inside && listBox && r.bottom <= listBox.top && !pagerish && !confirmed) {
        miss(2, el, label, 'above the list, and nothing marks it as a pager', href); continue;
      }
      const inRow = inside ? rows.find((row) => row.contains(el)) : null;
      ok.push({ el, href: u.href, label, d, confirmed, relNext, pagerish, depth, inRow,
        glyph: /^[›»>→]$/.test(word) ? (word === '›' || word === '→' ? 1 : 0) : 2 });
    }
    // COUNTED, because one "›" is a pager and a "›" on every card is a row's own link.
    const rowsWithOne = new Set(ok.filter((k) => k.inRow).map((k) => k.inRow)).size;
    const addresses = new Set(ok.filter((k) => !k.confirmed).map((k) => k.href)).size;
    const kept = ok.filter((k) => {
      if (k.inRow && rowsWithOne >= 2) { miss(2, k.el, k.label, `${rowsWithOne} of the list's rows each carry one — it is a row's own link, not a pager`, k.href); return false; }
      if (!k.confirmed && addresses >= PAGER_MANY_ADDRESSES) { miss(2, k.el, k.label, `${addresses} different addresses share this name here — not a pager`, k.href); return false; }
      return true;
    });
    // Confirmed by rel or by the dial first; then marked as a pager; then a word over an arrow
    // ("»" is as often LAST as it is next); then the one nearest the list.
    kept.sort((a, b) => (b.confirmed - a.confirmed) || (b.pagerish - a.pagerish) || (b.glyph - a.glyph) || (a.depth - b.depth));
    return { pick: kept[0] || null, misses, counts, lastPage };
  }
  // What the last look at the pager measured, for `nextpage` to put beside a negative. Module
  // state rather than a wider return type: `findNextPage` has six callers that want a link or null.
  let pagerSurvey = null;

  function findNextPage(sel) {
    // A selector the user pointed at outranks every guess below. The guessing is a
    // heuristic over link numbering, and on a search page carrying a dozen query
    // parameters it can pick a link that answers with no list at all — Alibaba's did.
    // Being able to say "that one, there" is the only complete answer, exactly as it is
    // for a load-more no word list can find.
    if (sel) {
      const el = resolve(sel);
      const h = el?.getAttribute?.('href');
      if (h) {
        try {
          const u = new URL(h, location.href);
          // `??` on `from` for the same reason as `want` above: on a zero-indexed dial the page
          // someone is standing on IS 0, and `|| 1` renamed it page 1 — which is what made the
          // panel offer "this is page 1" over a `?page=0` URL.
          return { el, href: u.href, label: (el.getAttribute('aria-label') || el.textContent || 'next').trim().slice(0, 60), pointed: true, page: (pageDial(u.href)?.n) || 2, from: pageDial(location.href)?.n ?? 1 };
        } catch (_) {}
      }
    }
    const here = pageDial(location.href);
    const nowN = here ? here.n : 1;
    const want = nowN + 1;
    const mine = location.pathname;
    const seen = [];
    const rel = document.querySelector('link[rel="next"], a[rel="next"]');
    if (rel) {
      const h = rel.getAttribute('href');
      if (h) seen.push({ el: rel, href: abs(h), label: 'next' });
    }
    // ROLE AND NAME FIRST — see `nextByName`. Asked before any address is judged, and used in two
    // strengths. A named control the dial CONFIRMS (or that says rel=next) is taken at once. A
    // named control whose address cannot be read is held until the address tiers below have had
    // their turn: a same-list link carrying exactly the next page number is what every site that
    // works today is followed by, and a name with nothing behind it does not get to outvote it.
    // `op.nameTier === false` switches the tier off, for the same reason `clickMore:false` stays
    // an argument: so a test can prove THIS is what finds the page (test/pager-by-name.mjs).
    let st0 = window[S];
    let c0 = st0?.cands?.[st0.i];
    if (c0?.el && !c0.el.isConnected) { try { detect(); } catch (_) {} st0 = window[S]; c0 = st0?.cands?.[st0.i]; }
    const named = op.nameTier === false ? null
      : nextByName({ here, nowN, want, container: c0?.el || null, rows: c0?.rows || [] });
    const asNext = (k, confidence) => ({ el: k.el, href: k.href, label: k.label, byName: true, confidence });
    if (named?.pick?.confirmed) seen.push(asNext(named.pick, named.pick.relNext ? 'name+rel' : 'name+number'));
    // What the address tiers measured, kept for the verdict. A link that IS the next page number
    // but of a different path is the near miss most worth naming: it is what this function used to
    // discard in silence, and on books.toscrape.com it was the right answer.
    const tally = { links: 0, sameOrigin: 0, withPageNumber: 0 };
    const otherList = [];
    // Same page, one turn of the dial. A different pathname is a different list —
    // another language, another category — however plausible its number looks. So the
    // paths are compared with the dial itself removed, whichever form it takes.
    // AND THE TRAILING SLASH IS PART OF THE COMPARISON, WHICH IS A SHIPPED BUG.
    // Stripping `/page/2` left `/almaty/search/кафе/` while the page the user stands on is
    // `/almaty/search/кафе` — no trailing slash, because page one does not carry the dial at
    // all. So `bare()` manufactured a difference that was never in the URLs, every candidate
    // was skipped, `seen` stayed empty and `findNextPage` returned null. Measured on 2GIS,
    // which links pages 2-7 in plain `<a href>`: the list stopped dead at twelve rows and the
    // engine reported no next page to follow.
    //
    // This was never 2GIS-specific — it broke EVERY site whose page one has no trailing slash
    // and whose later pages are `/page/N`, which is the commonest form of path pagination
    // there is. Normalise both sides instead of only one.
    // `page-2.html` and `index_2.html` are the same list as `index.html` and as the bare
    // directory, so all four have to reduce to one thing or page one never equals page two.
    // Same one-to-three-digit rule as `pageDial`, for the same reason.
    const bare = (path) => path
      .replace(/\/(page|p)\/\d+\/?$/i, '/')
      .replace(/_(\d{1,9})_(\d{1,5})(\.html?)?$/i, '_$1$3')
      .replace(/\/(page|index)[-_]?\d{1,3}(\.[a-z]{2,5})?$/i, '/')
      .replace(/\/index(\.[a-z]{2,5})?$/i, '/')
      .replace(/\/+$/, '') || '/';
    for (const a of document.querySelectorAll('a[href]')) {
      const raw = a.getAttribute('href');
      if (!raw || /^(javascript:|#|mailto:)/i.test(raw)) continue;
      let u;
      try { u = new URL(raw, location.href); } catch (_) { continue; }
      tally.links++;
      if (u.origin !== location.origin) continue;
      tally.sameOrigin++;
      const d = pageDial(u.href);
      if (d) tally.withPageNumber++;
      if (!d || d.n !== want) continue;
      if (d.at === 'query' ? u.pathname !== mine : bare(u.pathname) !== bare(mine)) {
        if (otherList.length < NEAR_MISSES) otherList.push(a);
        continue;
      }
      const label = (a.getAttribute('aria-label') || a.textContent || '').replace(/\s+/g, ' ').trim();
      seen.push({ el: a, href: u.href, label: label.slice(0, 60) || `page ${want}` });
    }
    // NO HREF AT ALL, BUT THE TARGET IS SITTING RIGHT THERE IN THE HANDLER. A control built as
    // `onclick="location.href='...'"` carries no href attribute — `pageDial` never gets a URL to
    // read from the markup — yet the exact navigation a click would trigger is already text on
    // the element. Cheaper than pressing and waiting for a render, same reasoning as trying a
    // link before a button everywhere else in this file. Tried only once the real links have come
    // up empty, and matched with the identical page-number and path rules as a real href, so it
    // can never pick a page a real link would have rejected.
    if (!seen.length) {
      // FOUR WAYS TO SET `location`, NOT THREE. `location.href=`, `.assign(` and `.replace(` are
      // method calls; `location = '...'` (bare, no `.href`) is the SAME navigation via the
      // Location object's own assignment operator — a real, distinct JS idiom, not a typo of the
      // others. `=(?!=)` excludes `==`/`===` comparisons, which read `location` but navigate
      // nowhere, and requiring `location` to be followed immediately by `.` or `=` (no property
      // name in between) excludes `location.search=`/`.pathname=`, which mutate one part of the
      // URL rather than navigate.
      const HANDLER_URL = /location(?:\s*\.\s*(?:href\s*=|assign\s*\(|replace\s*\()|\s*=(?!=))\s*['"`]([^'"`]+)['"`]/;
      for (const el of document.querySelectorAll('[onclick]')) {
        if (!el.getClientRects().length) continue;
        const m = HANDLER_URL.exec(el.getAttribute('onclick') || '');
        if (!m) continue;
        let u;
        try { u = new URL(m[1], location.href); } catch (_) { continue; }
        if (u.origin !== location.origin) continue;
        const d = pageDial(u.href);
        if (!d || d.n !== want) continue;
        if (d.at === 'query' ? u.pathname !== mine : bare(u.pathname) !== bare(mine)) continue;
        const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
        seen.push({ el, href: u.href, label: label.slice(0, 60) || `page ${want}` });
      }
    }
    // A URL SHAPED VALUE IN SOME OTHER ATTRIBUTE — `data-href`, `data-url`, a framework's own
    // `hx-get`/`:href`/router attribute — read by a click handler this file never sees, since it
    // lives in a script bundle rather than on the element. Denylisted attributes are excluded
    // because their values are URL-shaped for a reason that has nothing to do with navigation:
    // `src`/`srcset`/`poster` point at media, `formaction` at a form target, `cite`/`longdesc` at
    // a reference, `class`/`id`/`itemtype` are never URLs a click would follow even when they
    // happen to start with a slash. Same element universe `findPagerButtons` already trusts as
    // "things that look clickable," and the same page-number and path rules as every tier above —
    // an attribute that merely looks like a URL still has to be THIS list's next page to count.
    if (!seen.length) {
      const IGNORED_ATTRS = new Set(['href', 'onclick', 'action', 'alt', 'cite', 'class',
        'formaction', 'id', 'longdesc', 'placeholder', 'poster', 'src', 'srcset', 'itemtype',
        'data-src']);
      const URL_SHAPED = /^(https?:\/\/|\/)/;
      for (const el of document.querySelectorAll('button,[role="button"],a,li')) {
        if (!el.getClientRects().length) continue;
        let raw = null;
        for (const attr of el.attributes) {
          if (IGNORED_ATTRS.has(attr.name.toLowerCase())) continue;
          if (URL_SHAPED.test(attr.value)) { raw = attr.value; break; }
        }
        if (!raw) continue;
        let u;
        try { u = new URL(raw, location.href); } catch (_) { continue; }
        if (u.origin !== location.origin) continue;
        const d = pageDial(u.href);
        if (!d || d.n !== want) continue;
        if (d.at === 'query' ? u.pathname !== mine : bare(u.pathname) !== bare(mine)) continue;
        const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
        seen.push({ el, href: u.href, label: label.slice(0, 60) || `page ${want}` });
      }
    }
    // A NAME WITH NO READABLE ADDRESS BEHIND IT, once every address tier has come up empty. The
    // walk verifies it the way it verifies every page turn — a page that brings nothing new ends
    // the run — so `confidence: 'name-only'` is a statement about the evidence, not a hedge.
    if (!seen.length && named?.pick) seen.push(asNext(named.pick, 'name-only'));
    // WHAT WAS LOOKED AT, for a negative to show. Near misses in the order a person would want
    // them: a control in the list's own region first, then a right-numbered link of another list,
    // then the furniture. Five, because a reply is read by something paying for every token.
    const misses = (named?.misses || []).slice();
    for (const a of otherList) {
      misses.push({ rank: 3, el: a, label: pagerName(a).slice(0, 60) || `page ${want}`, href: a.href,
        rejected: `it is page ${want}, but of a different list — its path is not this page's` });
    }
    misses.sort((x, y) => x.rank - y.rank);
    const told = new Set();
    const nearMisses = [];
    let target = '';
    for (const m of misses) {
      const key = m.href || m.el;
      if (told.has(key)) continue;
      told.add(key);
      const one = m.href
        ? { label: m.label, href: m.href, rejected: m.rejected }
        : { label: m.label, selector: pathOf(m.el), rejected: m.rejected };
      nearMisses.push(one);
      if (!target && !m.final) target = one.href || one.selector;
      if (nearMisses.length >= NEAR_MISSES) break;
    }
    pagerSurvey = {
      target,
      saw: { ...tally, wantedPage: want, nextNamed: named?.counts.nextNamed || 0,
        previousNamed: named?.counts.previousNamed || 0, list: !!c0?.el },
      nearMisses, lastPage: !!named?.lastPage,
    };
    if (!seen.length) return null;
    return { ...seen[0], page: want, from: nowN };
  }

  // --- is this a challenge, or an empty page? ---------------------------------
  // A slider puzzle, a "confirm you are human", a rate-limit notice: they arrive as a
  // perfectly ordinary 200 with no list on it, which is indistinguishable from "this
  // approach does not work here" unless you look. Getting that wrong is expensive in both
  // directions — give up on a site that would have worked, or keep loading pages at a site
  // that has just asked you to slow down, which is how a session gets flagged.
  //
  // Two signals together, never either alone: something on the page that only a challenge
  // puts there, AND no list to be found. A shopping page that merely mentions "verify" in
  // its footer must not read as a wall.
  const CHALLENGE_SEL = [
    '[class*="captcha" i]', '[id*="captcha" i]', 'iframe[src*="captcha" i]',
    '[class*="nc_wrapper" i]', '[class*="nc-container" i]',   // Alibaba's slider
    '[class*="geetest" i]', '[class*="cf-turnstile" i]', '#challenge-form',
    '[class*="slider-verify" i]', '[class*="verify-wrap" i]',
  ].join(',');
  // WHAT A DEDICATED CHALLENGE PAGE SHIPS BEFORE IT HAS RENDERED ANYTHING.
  //
  // The two-signal rule below needs words, and Alibaba's has none when the walk arrives: the page
  // is `<punish-component />` and a bundle reference, and the slider, the sentence and every
  // `puzzle-captcha-*` class are built afterwards by scripts from g.alicdn.com. Measured on the
  // real page — as served `bodyChars=0` and `challenge=false`; once rendered `bodyChars=146` and
  // `challenge=puzzle word="drag the slider"`. Asking once and believing the answer therefore made
  // detection a race against a CDN, and losing it reported "no list on this page": no card, no
  // resume point, and a restore that navigated away from the check the person had to clear.
  //
  // These are NOT the collapsed scaffolding that made markup-alone unusable — a shop ships that on
  // every page, including the ones with a list on them. These are the entire body of a document
  // whose only purpose is the check, so they are trusted ONLY where there is no list and nothing
  // to read, which is the one place the words cannot arrive in time.
  // Kept to what is provably challenge-ONLY. Alibaba's page also loads `AWSC/CAPTCHA/awsc.js`,
  // which is a general captcha SDK a shop may ship anywhere it might need one — that is the
  // collapsed-scaffolding trap again, so it is not here. `punish-component` and `sufei-punish`
  // belong to the punish page and nothing else, and both are in the real document.
  const CHALLENGE_ONLY = [
    'punish-component',                  // Alibaba / Taobao "sufei-punish"
    '[src*="sufei-punish" i]', '[href*="sufei-punish" i]',
    '#cf-challenge-running',             // Cloudflare, before its widget paints
  ].join(',');

  // THE URL, WHICH IS THE ONE PART A SITE CANNOT WORD ITS WAY AROUND.
  //
  // eBay is the case this exists for, and it defeats every rule below it. Asked for page two, eBay
  // redirects to `/splashui/challenge?ap=1&appName=orch&ru=<the page you wanted>` — and what that
  // endpoint SAYS varies. Captured live three times it served `Error Page | eBay`, "SORRY /
  // Something went wrong on our end" plus a trace id: no "verify", no "robot", no "unusual
  // activity", no captcha markup, 189 characters, and a three-row table the walk cheerfully read
  // as data. A block wearing a server error. Reported from a real run as a walk that sat on it for
  // 31 seconds — "counting · 0 pages so far, no known end" — because nothing could name the page.
  //
  // No wording rule was ever going to catch that, and adding "something went wrong" to a word list
  // would catch every genuinely broken page on the web instead. The redirect target is the honest
  // signal: a document served FROM a challenge endpoint is a challenge whatever it says, and these
  // paths exist for nothing else.
  //
  // Deliberately narrow — full path segments, not substrings. `captcha` anywhere in a href would
  // match a shop selling captcha books; `/splashui/challenge` is an endpoint.
  const CHALLENGE_URL = new RegExp([
    '/splashui/challenge',               // eBay
    '/errors/validatecaptcha',           // Amazon
    '/cdn-cgi/challenge-platform',       // Cloudflare
    '/sorry/index',                      // Google
    '/_incapsula_resource',              // Imperva
    '/px/captcha', '/blocked\\.html',    // PerimeterX / Akamai
  ].join('|'), 'i');
  const CHALLENGE_WORDS = new RegExp([
    'verify (you|your identity)', 'are you a (human|robot)', 'unusual traffic',
    'security check', 'slide to (verify|complete)', 'drag the slider', 'press and hold',
    'verifikasi', 'geser untuk', 'verificaci[oó]n', 'verifica[çc][ãa]o',
    'v[ée]rification', 'sicherheitsüberprüfung', 'подтвердите', 'проверка',
    '请完成', '安全验证', '滑动验证', '確認してください', '보안 문자',
    'التحقق', 'doğrulama',
  ].join('|'), 'i');

  // A SESSION that has been flagged, which is not the same thing as a puzzle.
  //
  // Alibaba's is the case this exists for: "we detected an anomaly in your session" — no
  // slider, no captcha box, nothing to solve on the page, just a statement that the session
  // is under suspicion. The two-signal rule above cannot see it, because there is no marker
  // to find and the page is often long enough to clear the 600-character fallback.
  //
  // These phrasings need no second signal. No shop writes "we have detected unusual activity
  // from your session" in its footer — it is a thing a site says once, to your face, and the
  // only useful response is to stop and hand the tab back to the person. Getting this wrong in
  // the quiet direction is what "it kept loading pages while the site was shouting at us" is.
  const FLAGGED_WORDS = new RegExp([
    'anomal(y|ies|ous)', 'detected (unusual|suspicious|abnormal|automated)',
    'unusual (activity|behaviou?r)', 'suspicious (activity|behaviou?r|traffic)',
    'automated (traffic|requests|queries)', 'too many requests',
    'your (session|ip|network|account) (has been|was|is)? ?(flagged|restricted|blocked|limited)',
    'rate limit', 'access (temporarily )?(denied|restricted)',
    'aktivitas (tidak biasa|mencurigakan)', 'actividad (inusual|sospechosa)',
    'atividade (incomum|suspeita)', 'activit[ée] (inhabituelle|suspecte)',
    'ungewöhnliche aktivität', 'подозрительн', 'необычн',
    '异常', '检测到异常', '访问频繁', '異常な', '비정상',
    'نشاط غير معتاد', 'olağan dışı',
  ].join('|'), 'i');

  // BOTH signals, not either. The first version took markup alone and called Alibaba's
  // search results a wall — twice — because large sites ship their slider's scaffolding on
  // every page and leave it collapsed until they need it. Requiring the box to be laid out
  // did not help: `visibility:hidden` and `opacity:0` still have client rects.
  //
  // The asymmetry decides it. A false positive halts every pass and the feature does
  // nothing at all; a false negative means we politely read one more page and stop anyway
  // when it yields nothing. So a wall must both LOOK like one and SAY so, and the words are
  // the part a real challenge cannot omit — it is asking a person to do something.
  // Returns WHAT it is, not merely whether: 'puzzle' is something on the page to solve,
  // 'flagged' is the session itself being refused. They are answered differently — a puzzle is
  // cleared by doing it, a flagged session by leaving the site alone for a while — so the panel
  // has to be able to say which one happened.
  // `stale` says the list on this page is NOT proof of anything: it was read and held nothing
  // that was not already had. That is the shape of a soft block — the site keeps answering,
  // keeps serving a list, and puts its check over the top or simply re-serves the page you
  // already have. Asked only when a list is present, so it stays strict: an unmistakable
  // phrase, or the words AND an actual challenge element on the page. Never the
  // short-page guess, which a real list disproves by existing.
  // A SIGN-IN WALL IS A THIRD KIND OF WALL, and until this existed it was reported as neither.
  //
  // `challenged` knew two shapes — a puzzle (captcha, Cloudflare, a vendor bootstrap) and a flag
  // (told outright you look automated). A login page is neither, and the difference matters to the
  // caller more than the similarity: a puzzle means wait or slow down, a flag means stop, and a
  // sign-in wall means A PERSON CAN FIX THIS IN FIVE SECONDS. Reporting it as "thin, nothing
  // extractable" — which is what happened — sends the caller looking for a selector that was never
  // the problem.
  //
  // MEASURED, NOT MATCHED. No vendor names and no vocabulary: a visible password field is the one
  // structural feature every login page on the web has and nothing else does. A captcha has no
  // password field; a cookie banner has none; a paywall has none. The no-list guard is what keeps it
  // from firing on the sign-in dropdown that sits in the header of half the shops on the internet —
  // there, the products ARE on the page, so we were let through and the header is furniture.
  // A RENDERED PASSWORD FIELD IS THE WRONG TEST, AND A REAL RUN PROVED IT.
  //
  // The first version required the password input to be VISIBLE — a guard against the hidden
  // autofill decoys that sit in a shop's header. That guard is what made it miss an actual login
  // page: every large sign-in flow is now TWO STEPS, email first and password second, so on step one
  // the field exists in the markup and is deliberately hidden. Measured on Amazon's own wall:
  // passwordInputs 1, visiblePassword 0, visible types [email, password, submit]. Google and
  // Microsoft are built the same way. The detector reported a generic redirect and the caller was
  // told to look for "a consent screen, an age or region gate" when the answer was "sign in".
  //
  // So: a password field must EXIST, and something you can actually type an identity into must be
  // visible beside it. That is the shape of step one of a two-step login and of a one-step login
  // alike. The decoy case is still covered, by the caller's no-list guard rather than by geometry —
  // a page whose products are on screen let us through, and its header is furniture.
  function signInWall(doc) {
    try {
      if (!doc.querySelector('input[type="password"]')) return false;
      const shown = [...doc.querySelectorAll('input')].some((el) => {
        const t = String(el.type || '').toLowerCase();
        if (!['text', 'email', 'tel', 'password'].includes(t)) return false;
        const r = el.getBoundingClientRect();
        return r.width > INPUT_MIN_W && r.height > INPUT_MIN_H;
      });
      return shown;
    } catch (_) { return false; }
  }

  function challenged(doc, hasList, stale) {
    // FIRST, and ahead of the list check on purpose. eBay's challenge page carries a readable
    // three-row table ("Something went wrong on our end"), so `hasList` is true on it and every
    // rule below would have returned false — the walk read the apology as data. Where the document
    // came from outranks what it happens to contain.
    try {
      if (CHALLENGE_URL.test(String(doc?.location?.href || ''))) return 'puzzle';
    } catch (_) { /* cross-origin or detached; fall through to the content rules */ }
    if (hasList && !stale) return false;   // a list is proof enough that we were let through
    if (hasList) {
      try {
        const text = (doc.body?.innerText || doc.body?.textContent || '').slice(0, CHALLENGE_TEXT_CHARS);
        if (FLAGGED_WORDS.test(text)) return 'flagged';
        if (CHALLENGE_WORDS.test(text) && doc.querySelector(CHALLENGE_SEL)) return 'puzzle';
      } catch (_) { /* fall through to false */ }
      return false;
    }
    // Before the puzzle rules, because a login page is also short and would otherwise be guessed at
    // as a puzzle — and the two need different things from the caller.
    if (signInWall(doc)) return 'signin';
    try {
      const raw = (doc.body?.innerText || doc.body?.textContent || '');
      const text = raw.slice(0, CHALLENGE_TEXT_CHARS);
      // No second signal wanted: this phrasing is unambiguous and there is nothing to look for.
      if (FLAGGED_WORDS.test(text)) return 'flagged';
      // Nor here: a document with no list that ships a challenge vendor's own bootstrap is that
      // vendor's challenge, whether or not it has finished drawing itself yet.
      if (doc.querySelector(CHALLENGE_ONLY)) return 'puzzle';
      if (!CHALLENGE_WORDS.test(text)) return false;
      // Said AND shown. A page that merely mentions verification in its footer is not a
      // wall; a page that mentions it and has nothing else on it is.
      if (doc.querySelector(CHALLENGE_SEL)) return 'puzzle';
      return text.replace(/\s+/g, ' ').trim().length < CHALLENGE_SHORT_CHARS ? 'puzzle' : false;
    } catch (_) { return false; }
  }

  // Read one fetched page with the selectors that read this one.
  //
  // The RICHEST match, not the last. `resolve` chops segments off the front until
  // something matches and then takes the final hit — right for re-attaching to a
  // remembered container on the same page, wrong here: a chopped selector matches every
  // "related" and "popular" strip on the page too, and the last of those is a handful of
  // rows where the real grid has a hundred. On the live page the container is chosen by
  // score; here the only honest stand-in is the one holding the most rows.
  function harvest(doc, c) {
    const sel = c.selectorForHop || pathOf(c.el);
    let s = sel, hits = [];
    while (s) {
      try { hits = [...doc.querySelectorAll(s)]; } catch (_) { hits = []; }
      if (hits.length) break;
      const cut = s.indexOf('>');
      if (cut < 0) return [];
      s = s.slice(cut + 1);
    }
    let best = [];
    for (const el of hits) {
      const r = rowsOf(el);
      if (r && r.rows.length > best.length) best = r.rows;
    }
    return best;
  }

  // The same identity `uniqueCount` uses — one definition, `identOf` — so "new" means the
  // same thing to the hop as it does to the panel's counter. It used to mean "the first link
  // in the row" in both, which is what made a page of distinct products read as a repeat.
  const rowKey = identOf;

  // --- did the rows bring their pictures? -------------------------------------
  //
  // "Rows carry the URLs of their own files" is the whole positioning of this tool, and a
  // hop can satisfy every check ever written about it and still return nothing worth
  // having: 434 rows off seven pages of Alibaba, every image column empty. The rows are in
  // the served HTML, so any pass finds them; the pictures mount as a page is scrolled, and
  // a pass that never scrolls never gets one.
  //
  // Counted so the pass ladder can SEE that. Rows are what it has always measured, and rows
  // are the half of the job that is easy — so "twenty rows added" ended the ladder before
  // the one pass that could have brought the other half was ever offered.
  const ASSET_ATTRS = ['src', 'data-src', 'data-original', 'data-lazy-src', 'srcset', 'data-srcset'];
  // Every image URL a row holds, so they can be COUNTED across the table — see `assetTally`.
  // A boolean per row cannot tell a product photo from a country flag; a frequency can.
  function rowAssets(row) {
    const out = [];
    if (!row || !row.querySelectorAll) return out;
    const take = (el) => {
      // `currentSrc` first, as `cellsOf` does: on a settled responsive image it is the URL
      // the browser actually fetched.
      if (el.currentSrc) out.push(abs(el.currentSrc));
      for (const a of ASSET_ATTRS) {
        const v = el.getAttribute?.(a);
        // A `data:` URI is not a picture we can hand anyone — it is the grey placeholder an
        // unmounted image holds, which is exactly the state being measured.
        if (!v || /^(data:|javascript:|about:)/i.test(v)) continue;
        out.push(abs(a.includes('srcset') ? v.split(',')[0].trim().split(/\s+/)[0] : v));
      }
    };
    take(row);
    for (const el of row.querySelectorAll('*')) take(el);
    return out;
  }
  // Rows read in another tab arrive already reduced to cells, so they are asked the same
  // question in the same terms `extractOne` uses to label a column an asset.
  function cellAssets(cells) {
    const out = [];
    for (const k of Object.keys(cells || {})) {
      if (!/\b(src|data-src|data-original|data-lazy-src|srcset|data-srcset)$/.test(k)) continue;
      if (/^https?:/i.test(cells[k] || '')) out.push(cells[k]);
    }
    return out;
  }

  // WHICH IMAGES ARE FURNITURE?
  //
  // "This row has an image" is not the question. A real export off Alibaba settled that: every
  // row carrying a title and a price also carried
  //
  //   …O1CN01lUQbI41ymTPgE2qXM_!!6000000006621-55-tps-12-10.svg   a 12x10 promo icon
  //   …/flags/1.0.0/assets/cn.png                                 the supplier's country flag
  //
  // and not one product photo. Counted as "rows with an image", that table is fully pictured.
  // The pass ladder would have read the site it was built for as working perfectly.
  //
  // Nothing about a flag marks it out on its own — same CDN, plausible size, ordinary
  // extension. What marks it out is that it is THE SAME URL on row after row. A product's own
  // photo belongs to one row. So an image shared across more than a fifth of the table is
  // furniture, and a row is only pictured if it holds something that is not.
  const FURNITURE_SHARE = 0.2;
  // Both sides of the join, because the COMPARISON is the only honest test. An absolute
  // count says nothing — a list of job postings has no pictures and never did, and demanding
  // some would send that hop up a ladder for ever. "The live page's rows have their pictures
  // and the hopped ones do not" is a statement about this site, made against this site.
  function assetTally(c) {
    if (!c) return { liveRows: 0, live: 0, hoppedRows: 0, hopped: 0 };
    const extra = extraOf(c);
    const foreign = foreignOf(c);
    const live = c.rows.map(rowAssets);
    const hopped = extra.map(rowAssets).concat(foreign.map(cellAssets));
    // Counted over the WHOLE table, live and hopped together. Separately, a badge on twenty
    // hopped rows and none of page one's would read as content on both sides.
    const seen = new Map();
    for (const list of live) for (const u of list) seen.set(u, (seen.get(u) || 0) + 1);
    for (const list of hopped) for (const u of list) seen.set(u, (seen.get(u) || 0) + 1);
    const total = live.length + hopped.length;
    // Two at minimum, so a three-row table does not call its only picture furniture.
    const cap = Math.max(2, Math.floor(total * FURNITURE_SHARE));
    const own = (list) => list.some((u) => (seen.get(u) || 0) <= cap);
    return {
      liveRows: live.length,
      live: live.filter(own).length,
      hoppedRows: hopped.length,
      hopped: hopped.filter(own).length,
    };
  }

  // --- how a page after this one is ASKED for ---------------------------------
  //
  // It used to be a bare `fetch`, and a fetch is not what a person clicking "next"
  // produces. Measured against a real click on a real same-origin link, our request
  // matched 2 of the 7 headers a browser sends, and missed the three that say most:
  //
  //   Sec-Fetch-Dest   we sent `empty`      a person's browser sends `document`
  //   Sec-Fetch-Mode   we sent `cors`       a person's browser sends `navigate`
  //   Accept           we sent `*/*`        a person's browser asks for text/html
  //
  // Nobody requests a category page as a CORS call for anything. And it cannot be patched
  // header by header: Sec-Fetch-* comes out of the browser's own navigation stack and is a
  // FORBIDDEN header for fetch, so setting it silently does nothing. Only `Accept` and
  // `referrer` are ours to set, which is why hardening the fetch still measured 2 of 7.
  //
  // An IFRAME is a real navigation, so the browser writes all of them itself: 6 of 7 on the
  // same measurement, and the one that differs is `Sec-Fetch-Dest: iframe` — a value every
  // page carrying an embed produces all day. Same tab, same session, same cookies, nothing
  // on screen. It also arrives with two things the fetch never had:
  //
  //   LAYOUT    a fetched document has no boxes, which is the whole reason hopped pages
  //             must be read with page one's selectors. A framed one has real geometry.
  //   SCRIPTS   the page's own JS runs, so a list the site builds in the browser builds
  //             itself — the exact case the hidden-tab and driven passes exist for.
  //
  // Sandboxed WITHOUT allow-top-navigation, so a page that frame-busts cannot move the tab
  // the user is looking at. `allow-same-origin` and `allow-scripts` are both required — to
  // read it, and to let it build itself — and together they grant nothing the page does not
  // already have as the top document of this same tab.
  const FRAME_LOAD_MS = 15000;
  const FRAME_LIST_MS = 6000;
  const FRAME_WALK_MS = 5000;    // total, per page — the images, not the rows
  const FRAME_STEPS = 12;

  // Scroll a framed page to its end so its lazy images mount.
  //
  // Bounded by time as well as steps, because this is the one part of a hop that pays per
  // page and buys something invisible: nobody watching sees why page seven took an extra
  // two seconds, and the answer is that page seven now has its pictures.
  //
  // WHERE IT STOPS IS THE BOTTOM — the same rule the live walk follows, and for the same
  // reason. It used to break off after three steps that mounted nothing, which is not a
  // finished page: a grid loads its pictures in batches with an observer margin, so three
  // quiet steps in a row is the ordinary gap between two batches. On a twelve-step walk that
  // shortcut could end the page a quarter of the way down and report the images below it as
  // absent. Dryness buys SPEED here, never distance: once nothing is arriving the dwell
  // drops, and the walk keeps going.
  //
  // A src appearing is the right test, not a load completing — an <img> whose src was just
  // set is in the DOM long before the picture arrives, and the URL is all we collect.
  //
  // Yielding between steps is not optional. `for (…) w.scrollTo(0, y)` inside one turn of
  // the event loop never lets the frame render, so its observers only ever see the final
  // position and nothing mounts at all — measured: thirty images, two mounted, and the loop
  // had visited every one of them.
  const FRAME_DWELL = 180;
  const FRAME_DRY_DWELL = 60;    // still walking, just not waiting around
  async function wakeFrame(f, doc) {
    const w = f.contentWindow;
    if (!w) return;
    const de = doc.documentElement;
    const srcs = () => {
      let n = 0;
      for (const im of doc.images) if (im.getAttribute('src') || im.getAttribute('srcset')) n++;
      return n;
    };
    let last = srcs();
    let dry = 0;
    const t0 = performance.now();
    for (let i = 0; i < FRAME_STEPS && performance.now() - t0 < FRAME_WALK_MS; i++) {
      if (stopped()) return;
      const h = de.scrollHeight || 0;
      const step = Math.max(1, Math.ceil(h / FRAME_STEPS));
      try { w.scrollTo(0, step * (i + 1)); } catch (_) { return; }
      await nap(dry >= 2 ? FRAME_DRY_DWELL : FRAME_DWELL);
      const now = srcs();
      if (now > last) { last = now; dry = 0; } else dry++;
    }
    // A last dwell at the bottom. The final step's images are requested as it lands, and
    // returning immediately reads the page one batch short of itself.
    if (!stopped()) await nap(FRAME_DWELL);
    // Back to the top, so nothing about the next navigation inherits a scroll position.
    try { w.scrollTo(0, 0); } catch (_) {}
  }

  // ONE frame for the whole hop, navigated page to page and taken down at the end —
  // the way the tab pass reuses one tab, and for a second reason here: the document has
  // to stay alive after its rows are read, because the next-page link is read out of it
  // too. It also makes the referrer chain honest, page 3 arriving with page 2 behind it,
  // which is what a person turning pages produces.
  function frameReader() {
    let f = null;
    const make = () => {
      const el = document.createElement('iframe');
      el.setAttribute('sandbox', 'allow-same-origin allow-scripts');
      // A same-origin frame INHERITS autoplay, and an invisible frame that starts playing
      // is the worst bug this could have: sound from nowhere, on a page the user is
      // reading, out of a tool whose first promise is that nothing is audible. Denied
      // explicitly, along with the three permissions nothing here could ever want.
      el.setAttribute('allow', "autoplay 'none'; camera 'none'; microphone 'none'; "
        + "geolocation 'none'; fullscreen 'none'");
      // No referrer policy of our own: the site's own is what a real navigation would use,
      // and overriding it is another way to look unlike one.
      // Invisible, but RENDERED. `display:none` gives a frame no layout and no rAF, which
      // throws away both of the reasons to use one. Zero opacity, behind everything, deaf
      // to the pointer — the same trick the highlight overlay uses.
      el.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;opacity:0;'
        + 'pointer-events:none;z-index:-2147483647;border:0';
      document.body.appendChild(el);
      return el;
    };
    return {
      async go(url, c) {
        if (!document.body) return { blocked: 'no-body' };
        if (!f) f = make();
        const loaded = new Promise((res) => {
          f.addEventListener('load', () => res('load'), { once: true });
          f.addEventListener('error', () => res('error'), { once: true });
        });
        f.src = url;
        const how = await Promise.race([loaded, nap(FRAME_LOAD_MS).then(() => 'timeout')]);
        if (stopped()) return { stopped: true };
        if (how !== 'load') return { blocked: how };
        // X-Frame-Options and CSP frame-ancestors both answer with a `load` event on a
        // document we are not allowed to touch, so a refusal is indistinguishable from a
        // success until you reach for it. Hence a try, not a check.
        let doc = null;
        try { doc = f.contentDocument; } catch (_) { doc = null; }
        if (!doc || !doc.body) return { blocked: 'refused' };
        // The LIST, not the load. A site that builds its list in the browser answers
        // `load` with an empty shell — the same reason the tab pass polls rather than
        // trusting `complete`.
        const until = performance.now() + FRAME_LIST_MS;
        let rows = harvest(doc, c);
        while (!rows.length && performance.now() < until && !stopped()) {
          await nap(FRAME_LIST_POLL_MS);
          rows = harvest(doc, c);
        }
        // WALK IT. The rows are there; their pictures are not.
        //
        // A list page mounts its images on IntersectionObserver, so only the first screen
        // of a freshly-loaded page has any. Every row below the fold arrives with an empty
        // or placeholder `src` and no `data-src` either, because the URL never left the
        // framework's own state. Twenty-three pages of products came back with two
        // thousand rows and not one new picture, which is exactly what that looks like.
        //
        // This is the thing a frame can do and a fetch cannot: it has layout and a
        // viewport, so scrolling it fires the observers for real. Cheap, because the
        // document is already parsed and the images are the only thing still to come —
        // and bounded, because a page that keeps growing is not what this is for.
        if (rows.length) {
          await wakeFrame(f, doc);
          // READ AGAIN, after the walk. The nodes harvested above were the ones standing
          // before anything scrolled, and a page that renders its list from a framework
          // replaces them as it goes — so what we would be holding is a detached copy of the
          // page as it was, placeholders and all, while the mounted pictures sit in nodes we
          // let go of. Kept only if the second read is no smaller, because a re-render caught
          // mid-flight is the one case where re-reading loses rows.
          const after = harvest(doc, c);
          if (after.length >= rows.length) rows = after;
        }
        // Copied into OUR document as they are read. The rows outlive this frame by a long
        // way — they sit in the hop store until extraction, several navigations later — and
        // a node belonging to a document that has since been replaced is not something to
        // be holding. `importNode` makes them ours; `cellsOf` reads attributes and text,
        // which survive the move intact, exactly as they do for the DOMParser path.
        return { rows: rows.map((r) => document.importNode(r, true)), doc };
      },
      dispose() { if (f) { try { f.remove(); } catch (_) {} } f = null; },
    };
  }

  // --- whose `fetch` is it? ---------------------------------------------------
  //
  // Not ours. These engines run in the MAIN world on purpose — they read the page's own
  // objects, which is the only place those objects exist — and a site is free to replace
  // anything in that world before we arrive. Alibaba does: its anti-bot client wraps both
  // `window.fetch` and `XMLHttpRequest.prototype.open/send`, so every request the hop made
  // went through their code first. Measured, on their own page:
  //
  //   window.fetch   function(){var o,c=arguments;try{o=a(c,this,n)}catch(u){o=c,k.B(u)}…
  //   XHR open/send  wrapped, both
  //
  // And it does not merely observe. One run failed inside the wrapper before any request
  // was made — `TypeError: Failed to fetch` thrown from `baxiaCommon.js`, at
  // `HookBX$1.window.fetch` — which the hop could only report as "the site refused the
  // request". It had not; we had never asked it.
  //
  // A NEW same-origin frame is a new realm with untouched built-ins, and being same-origin
  // it carries the same cookies and the same base URL. Its `fetch` is the browser's own.
  // The frame must outlive the request — removing it aborts anything in flight — so it is
  // torn down with the rest of the hop.
  function pristineFetch() {
    let box = null;
    try {
      box = document.createElement('iframe');
      // Not `display:none`: a frame with no layout is a frame Chrome may treat as inert.
      // Off-screen and zero-sized is enough, and nothing in it is ever rendered anyway.
      box.setAttribute('aria-hidden', 'true');
      box.setAttribute('tabindex', '-1');
      box.style.cssText = 'position:fixed;left:-9999px;top:0;width:0;height:0;opacity:0;'
        + 'pointer-events:none;border:0';
      (document.body || document.documentElement).appendChild(box);
      const w = box.contentWindow;
      // Only if it really is native. A page that wraps `HTMLIFrameElement` itself, or one
      // whose frame we cannot reach, must fall back rather than throw — the wrapped fetch
      // does usually work, and a hop that refuses to run is worse than one that is watched.
      if (w && /\{\s*\[native code\]\s*\}/.test(String(w.fetch))) {
        return { call: (u, o) => w.fetch.call(w, u, o), native: true,
          dispose() { try { box.remove(); } catch (_) {} } };
      }
    } catch (_) {}
    if (box) { try { box.remove(); } catch (_) {} }
    return { call: (u, o) => fetch(u, o), native: false, dispose() {} };
  }

  // Paced like reading, not like a loop.
  //
  // 700ms between every page is not a delay, it is a SIGNATURE. Behavioural scoring reads
  // the variance as much as the mean, and a perfectly regular interval is the one thing a
  // person never produces — no human turns twenty-five pages at exactly 0.70s apiece. This
  // is a judgement rather than a measurement, but the two costs are not symmetric: being
  // too fast earns a slider that ends the run, being too slow costs seconds.
  // Sized by measurement — see the copy of this in `background.js`, which carries the numbers.
  // Mean ~1.7s, was ~5.3s, which was 62% of an entire walk.
  const pace = () => PACE_BASE_MS + Math.floor(Math.random() * PACE_JITTER_MS)
    // And every so often, the pause where a person actually looked at the page.
    + (Math.random() < PACE_PAUSE_ODDS ? PACE_PAUSE_MS + Math.floor(Math.random() * PACE_PAUSE_JITTER_MS) : 0);

  // SKIP THE PAGER ENTIRELY — some platforms hand out their own catalogue as data, and asking
  // for it beats detecting a next-page control that was never going to exist the same way twice.
  // Shopify first: every storefront, on every theme, answers `/products.json` with the exact
  // same schema regardless of how its pager is built — verified live against a real store
  // (allbirds.com) before writing the field mapping below, not assumed from documentation.
  //
  // `window.Shopify.shop` is the cheap, reliable signal when the theme has not been torn down by
  // the time this runs. `cdn.shopify.com` in a loaded asset is the fallback for a theme that
  // never sets the global, or a page read after Shopify's own script tags were removed.
  function shopifyPlatform() {
    const shop = (window.Shopify && window.Shopify.shop) || '';
    if (shop) return { is: true, shop };
    const asset = document.querySelector(
      'script[src*="cdn.shopify.com"],link[href*="cdn.shopify.com"],img[src*="cdn.shopify.com"]');
    return { is: !!asset, shop: '' };
  }

  // THE ENDPOINT DEPENDS ON WHERE THE PERSON IS STANDING, not just on the platform being
  // Shopify. `/products.json` is the WHOLE catalogue; a person looking at one collection wants
  // that collection, and handing back every product in the store when they asked for "Shoes"
  // is a wrong answer dressed as a complete one.
  //
  // And `/products.json` is only ever the UNFILTERED, UNSORTED, UNSEARCHED list — Shopify does
  // not take `sort_by` or `q` on this endpoint, so a person looking at a search result or a
  // filtered/sorted view would silently get the wrong products back if this engaged anyway. The
  // guard below is the whole reason this stays a bypass for the plain case and not a rewrite of
  // what "the list on screen" means.
  function shopifyEndpoint() {
    const params = new URLSearchParams(location.search);
    for (const k of params.keys()) {
      if (k === 'q' || k === 'sort_by' || k.startsWith('filter.')) return null;
    }
    const m = location.pathname.match(/^\/collections\/([^/]+)\/?$/);
    if (m && m[1] !== 'all') return `/collections/${m[1]}/products.json`;
    if (m && m[1] === 'all') return '/products.json';
    if (/^\/?$/.test(location.pathname)) return null;   // the homepage is not a product list
    return null;
  }

  // ONE MAPPING, VERIFIED AGAINST A REAL STORE'S ACTUAL RESPONSE — see the class comment above.
  // Named fields, not the generic {text,label,href,img} a DOM row gets: the JSON already carries
  // price, availability and SKU as data, and flattening them back into unlabelled text would
  // throw away the entire reason to prefer the API over the page.
  function shopifyRow(p) {
    const v = (p.variants && p.variants[0]) || {};
    const img = (p.images && p.images[0] && p.images[0].src) || '';
    return {
      id: p.id, title: p.title || '', vendor: p.vendor || '', productType: p.product_type || '',
      price: v.price || '', compareAtPrice: v.compare_at_price || null,
      available: !!v.available, sku: v.sku || '',
      href: p.handle ? `${location.origin}/products/${p.handle}` : '', img,
    };
  }

  // ONE CALL, THE WHOLE LIST — the reason to prefer this path at all. A DOM walk pages through
  // a render per turn; this pages through a 250-row JSON fetch per turn, so there is no reason to
  // hand control back to a per-page caller the way `pageHop` does. Still paced like a person
  // reading (`pace()`, unchanged), still stoppable between pages, and still capped for the same
  // reason `@collect` is: a runaway catalogue must not answer as gigabytes of JSON.
  async function platformScan(op) {
    const plat = shopifyPlatform();
    if (!plat.is) return { available: false, why: 'not a recognised platform' };
    const endpoint = shopifyEndpoint();
    if (!endpoint) {
      return { available: false, platform: 'shopify',
        why: 'this page is not a plain, unfiltered product listing — falling back to reading the page' };
    }
    const net = pristineFetch();
    const rows = [];
    const cap = Math.min(Math.max(PLATFORM_CAP_MIN, Number(op.limit) || PLATFORM_CAP_MAX), PLATFORM_CAP_MAX);
    let page = 1, ended = 'capped';
    try {
      for (; page <= PLATFORM_MAX_PAGES && rows.length < cap; page++) {
        if (stopped()) { ended = 'stopped'; break; }
        let r;
        try {
          r = await net.call(`${location.origin}${endpoint}?limit=${SHOPIFY_PAGE_SIZE}&page=${page}`,
            { credentials: 'omit' });
        } catch (_) { ended = page === 1 ? 'unavailable' : 'capped'; break; }
        if (!r || !r.ok) {
          // A store that has disabled or password-protected the endpoint answers here, not with
          // a network error — this is the graceful-fallback path, not a bug to retry through.
          if (page === 1) return { available: false, platform: 'shopify',
            why: `the store's product feed answered ${r ? r.status : 'nothing'} — falling back to reading the page` };
          ended = 'capped'; break;
        }
        let j;
        try { j = await r.json(); } catch (_) { ended = 'capped'; break; }
        const batch = Array.isArray(j?.products) ? j.products : [];
        if (!batch.length) { ended = 'end'; break; }
        for (const p of batch) rows.push(shopifyRow(p));
        if (page < PLATFORM_MAX_PAGES && rows.length < cap) await new Promise((res) => setTimeout(res, pace()));
      }
    } finally { net.dispose(); }
    return { available: true, platform: 'shopify', shop: plat.shop, endpoint,
      tables: [{ selector: '', rows: rows.slice(0, cap) }], pages: page - 1, ended };
  }

  async function pageHop(op) {
    const st = window[S];
    const c = st?.cands?.[st.i];
    if (!c) return { error: 'NOT_DETECTED' };
    c.selectorForHop = c.selectorForHop || pathOf(c.el);
    const bag = hopFor(c.el, true);
    // No ceiling, for the same reason hops have none: a number picked here is a number
    // that cuts someone's list off. The list ends when the site stops offering a next
    // page, when a page will not answer, or when the user says stop — all of which are
    // real endings. Tests pass a small number; 0 or absent means all of them.
    const max = op.pages > 0 ? op.pages : Number.MAX_SAFE_INTEGER;
    // Resume, not restart. After twenty-five pages the next "Follow the pages" must
    // begin at twenty-six: starting at page two again re-fetches everything already in
    // hand, and the freshness check below would then stop it on the first page — so the
    // user pressed a button and got nothing, having already waited for the fetch.
    let url = op.from || bag.next || findNextPage(op.nextSelector)?.href;
    // A RESUME POINT THE GUESS MADE DOES NOT OUTRANK A POINTER. `bag.next` is wherever the last
    // stretch said the list continues, and when nobody had pointed at a control that is the
    // numbering guess's word — which is exactly the word the person is now overruling. Measured
    // on the /trap/ fixture (Alibaba's shape): the guess read page two, then took the "Related
    // searches" decoy for page three and stopped on "that page held no list we could read". The
    // person pointed at the real pager, and every press after that re-fetched the decoy: the
    // pointer was never resolved anywhere, because the resume point was believed first.
    //
    // Resuming from the LIVE page instead would re-read page two, find every row in hand and
    // stop on "repeated" — so the pointer is resolved in the page the guess was made FROM: one
    // fetch of a page already read, its rows not counted, and its pointed control is where the
    // stretch actually begins. A resume point the pointer itself produced is kept as it is.
    let reresolve = false;
    if (!op.from && op.nextSelector && bag.next && bag.nextBy !== 'pointed' && bag.nextFrom) {
      url = bag.nextFrom;
      reresolve = true;
    }
    if (!url) return { error: 'NO_NEXT', added: 0, pages: 0 };

    let pages = 0, added = 0, last = '';
    // Which way the pages were actually read, so the panel can say so rather than guess.
    // A frame refused once is a frame refused for the whole site — X-Frame-Options and
    // frame-ancestors are policy, not a property of page seven.
    let frameOk = true;
    // 'puzzle' or 'flagged', when a page turned out to be one. Carried out so the panel can
    // say which happened rather than offering one answer to two different problems.
    let wall = '';
    let via = 'frame';
    // Did this way of asking WORK, as distinct from whether it found anything new?
    //
    // The two are not the same and the panel was treating them as one. A hop that reads
    // three pages perfectly well and finds every row already in hand returns `added: 0` —
    // and so does a hop whose very first page came back as an empty shell. The pass ladder
    // read the bare zero, concluded that fetching had failed, and offered to open windows
    // and attach a debugger for a list that had simply ENDED.
    //
    // Any page yielding rows settles it: the method reaches this site. A previous stretch
    // having done so settles it too, which is the case that actually bit — press "Follow
    // the pages" a second time on a finished list and it resumes, reads a page, finds
    // nothing new, and used to be escalated as a failure.
    let sawRows = (bag.pages || 0) > 0;
    const frame = frameReader();
    // Asked for once and kept for the whole hop, because the frame it borrows must outlive
    // every request made through it.
    const net = pristineFetch();
    const visited = new Set([location.href]);
    // What is already in hand, so "new" is measured and not assumed. Sites CLAMP an
    // out-of-range page: ?page=99 answers with the last page's content and still offers
    // a next link. Stopping only on a new URL or an empty page meant reading the same
    // page over and over — twenty-five fetches collapsing back to one page of rows.
    const seenKeys = new Set();
    for (const r of [...c.rows, ...bag.rows]) seenKeys.add(rowKey(r));
    try {
    while (url && pages < max && !stopped()) {
      if (visited.has(url)) break;   // a "next" that points at itself is the end
      visited.add(url);
      st.hop = { url, pages, added };  // live, for the panel's poll
      let doc;
      let rows = null;
      // The frame first, every page, until the site refuses one. A refusal is
      // X-Frame-Options or a CSP, and both are site-wide policy rather than a property of
      // page seven — so it is asked once and believed.
      if (frameOk) {
        const got = await frame.go(url, c);
        if (got.stopped || stopped()) { last = 'stopped'; break; }
        if (got.blocked) {
          frameOk = false;
          via = 'fetch';
          frame.dispose();
        } else {
          doc = got.doc;
          rows = got.rows;
        }
      }
      if (!rows) {
        try {
          // Bounded, and abortable. A bare `fetch` here had neither: a request the site
          // never answers froze the hop with nothing on screen moving and Stop unable to
          // reach it, because the flag is only read between pages and this never finished
          // one. Twenty seconds is longer than any list page needs and short enough to say
          // so; the stop flag cancels it outright.
          const ac = new AbortController();
          let why = 'timeout';
          const watch = setInterval(() => { if (stopped()) { why = 'stopped'; ac.abort(); } }, HOP_STOP_POLL_MS);
          const cap = setTimeout(() => ac.abort(), HOP_FETCH_MS);
          let res;
          try {
            // The two headers a page context is actually allowed to set. They do not make
            // this look like a navigation — measured, it is still 2 of 7 — but `Accept: */*`
            // on an HTML page is the loudest half of what is left, and a request with no
            // referrer is worse than one with the page it came from.
            //
            // Through `net`, not `fetch`: the site owns the one in this realm. See
            // `pristineFetch`.
            res = await net.call(url, {
              credentials: 'include',
              signal: ac.signal,
              referrer: location.href,
              headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,'
                + 'image/avif,image/webp,image/apng,*/*;q=0.8' },
            });
          } finally { clearInterval(watch); clearTimeout(cap); }
          if (!res.ok) {
            // 403 and 429 are the site saying so in its own words. Naming them as such stops
            // the next pass from trying the same thing harder.
            last = res.status === 403 || res.status === 429
              ? 'the site asked for verification'
              : `page ${pages + 1} answered ${res.status}`;
            break;
          }
          doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        } catch (e) {
          last = e?.name === 'AbortError'
            ? (stopped() ? 'stopped' : `page ${pages + 1} did not answer in time`)
            : 'the site refused the request';
          break;
        }
        rows = harvest(doc, c);
      }
      // THE PAGE THE GUESS WAS MADE FROM, fetched again only to resolve the pointer in it (see
      // `reresolve` above). Not a page of this stretch: its rows are already in hand and are not
      // counted, and it does not spend one of `max`. Where the pointer leads is where the stretch
      // begins; a pointer that resolves to nothing there means the list ended on that page.
      if (reresolve) {
        reresolve = false;
        if (rows.length) {
          let nx = null;
          const el = resolve(op.nextSelector, doc);
          const raw = el?.getAttribute?.('href');
          if (raw) { try { nx = new URL(raw, url).href; } catch (_) {} }
          bag.next = nx;
          bag.nextBy = 'pointed';
          bag.nextFrom = url;
          url = nx;
          if (nx) await nap(pace());
          continue;
        }
        // No list on a page that held one moments ago: a wall put up since, or a site that
        // changed under us. The branch below names which, rather than resolving a pointer in
        // a challenge page and calling the result "no further pages".
      }
      pages++;
      if (!rows.length) {
        const kind = challenged(doc, false);
        // Named apart, because they are answered differently and the panel says so.
        last = kind === 'flagged' ? 'the site flagged this session'
          : kind ? 'the site asked for verification'
          : 'that page held no list we could read';
        if (kind) wall = kind;
        break;
      }
      sawRows = true;   // this way of asking reaches this site, whatever the rows turn out to be
      let fresh = 0;
      for (const r of rows) {
        const k = rowKey(r);
        if (seenKeys.has(k)) continue;   // the same item again, from a clamped page
        seenKeys.add(k);
        bag.rows.push(r);
        bag.bases.set(r, url);
        fresh++;
      }
      if (!fresh) { last = `page ${pages} repeated the one before it`; break; }
      added += fresh;
      st.hop = { url, pages, added };
      // The next link comes from the page we just read, not from a guess about how
      // its numbering works — a list that ends at page 9 simply stops offering one.
      const base = new URL(url);
      let nxt = null;
      // The pointed control first, resolved in the page just fetched — it is the same
      // template, so the same selector finds its next link. Only when nothing was
      // pointed at does the numbering guess apply.
      if (op.nextSelector) {
        const el = resolve(op.nextSelector, doc);
        const raw = el?.getAttribute?.('href');
        if (raw) { try { nxt = new URL(raw, base).href; } catch (_) {} }
      }
      // The guess is a fallback for pages nobody has pointed at — never a second chance
      // after a pointed control has run out. On the last page the pointer resolves to
      // nothing, and falling through to the numbering here fetched the very decoy the
      // pointing existed to avoid: two good pages, then one useless one, and a closing
      // message about a page holding no list. An absent pointer means the list has ended.
      if (!nxt && !op.nextSelector) {
        // `??`, NOT `||` — A ZERO-INDEXED DIAL IS A REAL PAGE NUMBER AND `0` IS FALSY.
        // Measured on shopee.co.id, whose categories are `?page=0` for the FIRST page: `pageDial`
        // read 0 correctly, `0 || pages` then threw it away and asked for `pages + 1`, so the hop
        // requested a page past the end and the walk stopped one page in. Any site counting from
        // zero hit this; the dial was never the problem, the falsy check was.
        const here = pageDial(url)?.n;
        const want = (here ?? pages) + 1;
        // Compared with the dial REMOVED, exactly as `findNextPage` does — and this used to
        // be a strict `pathname !== pathname`, which can only ever be true for a dial that
        // lives in the query. When the page number is in the FILENAME (Alibaba's
        // `cat_361210_2.html`) page 3 has a different pathname from page 2 by definition, so
        // the guess rejected every link and the hop stopped one page in, every time.
        //
        // It was invisible until now: on such a site the fetch found no list at all, so the
        // hop died before it could reach this line. Reading page 2 in a frame is what
        // uncovered it.
        // TRAILING SLASH, same as `findNextPage`'s copy — and these two must be edited together.
        // It does not bite on the common path because both sides usually carry a dial and so
        // both gain the slash. It bites the moment the CURRENT url has no dial — a hop handed
        // `op.from` pointing at a bare page one — where `/pathpaged` never equals `/pathpaged/`
        // and the very first hop finds nothing.
        const bare = (path) => path
          .replace(/\/(page|p)\/\d+\/?$/i, '/')
          .replace(/_(\d{1,9})_(\d{1,5})(\.html?)?$/i, '_$1$3')
          .replace(/\/(page|index)[-_]?\d{1,3}(\.[a-z]{2,5})?$/i, '/')
          .replace(/\/index(\.[a-z]{2,5})?$/i, '/')
          .replace(/\/+$/, '') || '/';
        for (const a of doc.querySelectorAll('a[href]')) {
          const raw = a.getAttribute('href');
          if (!raw) continue;
          let u; try { u = new URL(raw, base); } catch (_) { continue; }
          if (u.origin !== base.origin) continue;
          const d = pageDial(u.href);
          if (!d || d.n !== want) continue;
          if (d.at === 'query' ? u.pathname !== base.pathname : bare(u.pathname) !== bare(base.pathname)) continue;
          nxt = u.href; break;
        }
      }
      url = nxt;
      // Paced, for the same reason a person would be: a burst of requests is what earns a
      // slider, and this loop can otherwise ask for twenty-five pages in a few seconds.
      // Jittered rather than fixed — see `pace()`. A constant interval is itself the tell.
      if (nxt) await nap(pace());
        bag.next = nxt;          // where a later stretch picks up
        // AND WHOSE WORD THAT IS, with the page it was read from. A later stretch that arrives
        // with a pointer trusts a resume point the pointer made and overrules one the guess
        // made — by resolving the pointer in `nextFrom`. See the top of this function.
        bag.nextBy = op.nextSelector ? 'pointed' : 'guess';
        bag.nextFrom = base.href;   // `url` is already the next page by this line
        bag.pages = (bag.pages || 0) + 1;
      }
    } finally {
      // Always, on every path out — a stop, a wall, a throw. An invisible frame left
      // behind on someone's page is exactly the kind of thing this tool must never do.
      frame.dispose();
      net.dispose();
    }
    st.hop = null;
    return { added, pages, via, sawRows, total: bag.pages || pages, stopped: stopped(),
      wall,
      why: last || (url ? 'reached the limit' : 'no further pages') };
  }

