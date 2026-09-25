  // --- scrolling ------------------------------------------------------------
  // Find the scroller by TRYING to scroll it, not by reading overflow. Computed
  // style misses `overlay`, custom scroll containers, and anything we forgot to
  // enumerate; a probe cannot be wrong about whether an element moved. Anchored
  // at the detected rows, which is better information than the viewport centre.
  function probe(el) {
    if (!el || el === document.documentElement || el === document.body) return false;
    const before = el.scrollTop;
    el.scrollTop = before + SCROLL_PROBE_PX;
    let moved = el.scrollTop !== before;
    if (!moved && before > 0) { el.scrollTop = Math.max(0, before - SCROLL_PROBE_PX); moved = el.scrollTop !== before; }
    el.scrollTop = before;
    return moved;
  }

  function scrollerFor(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) if (probe(n)) return n;
    return null; // null means the document scrolls
  }

  // --- waiting for a list to settle -----------------------------------------
  // A fixed pause is the wrong instrument. Too short and a list that fetches over
  // the network looks finished; too long and every step drags. So wait on the
  // page's own signals and stop as soon as they go quiet.
  //
  // Three signals, in order of reliability:
  //   1. DOM mutations inside the container — content arriving IS mutation.
  //   2. Placeholders: aria-busy, role=progressbar, and the skeleton/shimmer
  //      class families. Counted INSIDE the container and compared against the
  //      count we started with, never absolutely — Unsplash keeps two permanent
  //      skeleton nodes on the page, and an absolute test waits for them forever.
  //   3. Resource-timing entries appearing, which is a fetch having landed.
  const BUSY_SEL = '[aria-busy="true"],[role="progressbar"],[class*="skeleton" i],'
    + '[class*="shimmer" i],[class*="placeholder" i],[class*="spinner" i],[class*="loader" i]';
  const QUIET_MS = 320;     // no mutations for this long = arrived
  const SETTLE_MAX = 4500;  // and never wait longer than this for one step
  const NET_WAIT_MAX = 9000; // unless the page is mid-request — then wait for it

  function busyIn(el) {
    try { return el.querySelectorAll(BUSY_SEL).length; } catch (_) { return 0; }
  }

  // --- what the page is still waiting for -----------------------------------
  // Resource-timing entries only appear when a request has LANDED, so the three
  // signals above share a blind spot: the gap between a scroll firing a fetch and
  // that fetch answering. Nothing mutates during it and no placeholder need appear,
  // so the DOM reads quiet after 320ms and the walk scrolls on — or worse, decides
  // the list is finished — while the page is still waiting on its own API.
  //
  // Counting requests in flight closes it. Both wrappers delegate unconditionally
  // and rethrow, so a page behaves identically whether we are watching or not, and
  // the counter is installed once per page and only on the paths that scroll — the
  // passive poll still touches nothing.
  const NET = '__holoscrapeNet';

  function netWatch() {
    if (window[NET]) return window[NET];
    // AGED, NOT MERELY COUNTED — the twin of the same fix in `scan.js`, and the reason is
    // one page: Google Maps holds a long-poll open for the life of the tab, so a bare
    // counter never returns to zero and every wait ran to its cap. The walk was slower
    // than scrolling the rail by hand, which is the plainest possible sign that it was
    // waiting on something it should have ignored.
    const STREAM_MS = 2500;
    const st = { inflight: 0, peak: 0, done: 0, streams: 0 };
    const live = new Map();
    let seq = 0;
    st.prune = () => {
      const now = Date.now();
      for (const [id, t] of live) {
        if (now - t <= STREAM_MS) continue;
        live.delete(id);
        st.inflight = Math.max(0, st.inflight - 1);
        st.streams++;
      }
    };
    const up = () => {
      const id = ++seq;
      live.set(id, Date.now());
      st.inflight++;
      if (st.inflight > st.peak) st.peak = st.inflight;
      return id;
    };
    const dn = (id) => {
      if (!live.delete(id)) return;   // aged out already; never decrement twice
      st.inflight = Math.max(0, st.inflight - 1);
      st.done++;
    };

    try {
      const orig = window.fetch;
      if (typeof orig === 'function') {
        window.fetch = function (...args) {
          const id = up();
          let p;
          try { p = orig.apply(this, args); } catch (e) { dn(id); throw e; }
          if (!p || typeof p.then !== 'function') { dn(id); return p; }
          return p.then((r) => { dn(id); return r; }, (e) => { dn(id); throw e; });
        };
      }
    } catch (_) {} // a frozen fetch just means we fall back to the other signals

    try {
      const X = window.XMLHttpRequest;
      if (X && X.prototype && typeof X.prototype.send === 'function') {
        const send = X.prototype.send;
        X.prototype.send = function (...args) {
          let settled = false;
          const id = up();
          const fin = () => { if (!settled) { settled = true; dn(id); } };
          try {
            this.addEventListener('loadend', fin);
            return send.apply(this, args);
          } catch (e) { fin(); throw e; }
        };
      }
    } catch (_) {}

    window[NET] = st;
    return st;
  }

  // Pruned on every read. A stream never settles, so nothing else would ever drop it —
  // and this value gates both `settle()` and the panel's "waiting on N requests" line.
  const inFlight = () => {
    const st = window[NET];
    if (!st) return 0;
    if (st.prune) st.prune();
    return st.inflight;
  };

  function settle(el, budget = SETTLE_MAX) {
    return new Promise((done) => {
      const t0 = performance.now();
      const res0 = performance.getEntriesByType('resource').length;
      const busy0 = busyIn(el);
      let last = performance.now();
      let mutations = 0;

      const obs = new MutationObserver((recs) => { mutations += recs.length; last = performance.now(); });
      try { obs.observe(el, { childList: true, subtree: true }); } catch (_) {}

      const tick = setInterval(() => {
        const now = performance.now();
        const quiet = now - last >= QUIET_MS;
        // Still showing more placeholders than when we started: the page is
        // telling us it is fetching. Keep waiting even if the DOM went quiet.
        const stillBusy = busyIn(el) > busy0;
        // And a request on the wire outranks a quiet DOM outright. The per-step
        // budget is deliberately short so a static page is not slow; a page that is
        // demonstrably mid-request gets the longer one instead, because "wait for
        // the answer" is the whole point of asking.
        const onWire = inFlight() > 0;
        const cap = onWire ? Math.max(budget, NET_WAIT_MAX) : budget;
        // A stop ends the wait, not just the loop that owns it. This is where "Stop
        // takes a very long time" came from: a media page keeps requests permanently
        // on the wire, so `onWire` stayed true, every step took the full nine seconds,
        // and the flag was only read between steps. Twenty-four screens of that is
        // three and a half minutes of "Finishing the current step".
        if (stopped() || (quiet && !stillBusy && !onWire) || now - t0 > cap) {
          clearInterval(tick);
          obs.disconnect();
          done({
            waited: Math.round(now - t0),
            mutations,
            fetched: performance.getEntriesByType('resource').length - res0,
            inflight: inFlight(),
            timedOut: now - t0 > cap,
          });
        }
      }, SETTLE_TICK_MS);
    });
  }

  // --- load-more button -----------------------------------------------------
  // Some lists never grow on scroll; they wait to be asked. The button is found
  // by what it says and where it sits, not by a per-site selector.
  //
  // Wording covers the languages this is aimed at first (Indonesian, Portuguese,
  // Spanish, Turkish) plus the usual English forms. A site whose button says
  // something else is why the control can still be driven by hand.
  // Three tiers, because "more" is not one idea. Tokopedia's search page offers
  // three matching controls: a 26px "Lihat selengkapnya" link near the top, the
  // real 328x48 "Muat Lebih Banyak" button at the bottom of the list, and a 16px
  // "Pelajari Selengkapnya" (learn more) link in the footer. Picking the lowest
  // match on the page picks the footer link.
  // Extended from a census of 102 list pages in 21 languages, click-verified: of the
  // load-mores confirmed to grow a list in place, this list caught two of five.
  // "Afficher plus (175)" on cdiscount.fr — a real <button> that took a list from 60
  // rows to 181 — matched nothing at all, and neither did Polish "POKAŻ WIĘCEJ".
  // A word list has no floor; it only has whatever has been measured.
  const MORE_STRONG = new RegExp([
    'load\\s*more', 'show\\s*more\\s*results', 'more\\s*results', 'load\\s*additional',
    'muat\\s*lebih', 'tampilkan\\s*lebih', 'muat\\s*lagi',
    'carregar\\s*mais', 'cargar\\s*m[áa]s', 'mais\\s*resultados', 'm[áa]s\\s*resultados',
    'daha\\s*fazla', 'mehr\\s*laden', 'mehr\\s*ergebnisse',
    'charger\\s*plus', 'afficher\\s*plus', 'plus\\s*de\\s*r[ée]sultats',
    'carica\\s*altro', 'meer\\s*laden',
    'poka[żz]\\s*wi[ęe]cej', 'wczytaj\\s*wi[ęe]cej',
    'visa\\s*fler', 'ladda\\s*fler', 'n[äa]yt[äa]\\s*lis[äa][äa]', 'vis\\s*mere',
    'загрузить\\s*ещ[ёе]', 'показать\\s*ещ[ёе]',
    'تحميل\\s*المزيد', 'عرض\\s*المزيد', 'טען\\s*עוד',
    'โหลดเพิ่ม', 'ดูเพิ่มเติม', 't[ải]i\\s*th[êe]m', 'xem\\s*th[êe]m', 'और\\s*देखें',
    'さらに表示', 'もっと見る', '加载更多', '展开更多', '더\\s*보기', '더\\s*불러오기',
  ].join('|'), 'i');
  // Might extend the list, might just expand a paragraph. Allowed only when it
  // also looks like a real control.
  const MORE_WEAK = new RegExp([
    'show\\s*more', 'see\\s*more', 'view\\s*more', 'browse\\s*more',
    'selengkapnya', 'lihat\\s*lebih', 'lebih\\s*banyak',
    'ver\\s*mais', 'mostrar\\s*mais', 'ver\\s*m[áa]s', 'mostrar\\s*m[áa]s',
    'devam', 'mehr\\s*anzeigen', 'weitere', 'voir\\s*plus',
    'mostra\\s*altro', 'vedi\\s*altro', 'toon\\s*meer', 'bekijk\\s*meer',
    'wi[ęe]cej', 'ещ[ёе]', 'المزيد', 'بیشتر', 'עוד', 'अधिक',
    '查看更多', '更多', 'もっと', '더보기',
  ].join('|'), 'i');
  // Never a list extender: these open an article or a help page. "Pelajari
  // selengkapnya" is Indonesian for "learn more" and sits in Tokopedia's footer.
  // Checked FIRST, so a "more information" form always loses to it however many
  // "more" words it contains. Every language added above brings its own learn-more
  // twin, and the census found one: Persian "اطلاعات بیشتر" is "more information about
  // the app", sitting on Digikala right where a load-more would be.
  //
  // AND "LESS" IS NOT "MORE", THOUGH IT SHARES ITS STEM IN MOST LANGUAGES. Indonesian builds the
  // pair as `Lihat Lebih Banyak` / `Lihat Lebih Sedikit` — see more / see less — so a rule written
  // for the first matches the second on the words they share, and the second is the COLLAPSE
  // control. Measured on lazada.co.id/tag/android: the finder chose "Lihat Lebih Sedikit", pressed
  // it, the list did not grow, and the walk quit at 40 rows with the real button still on screen.
  // English does the same with show more/show less, and so does every language below. This has to
  // be checked BEFORE the more-words, which is why it lives in `MORE_NEVER`.
  const MORE_NEVER = new RegExp([
    'lebih\\s*sedikit', 'lebih\\s*ringkas', 'sembunyikan',
    'show\\s*less', 'see\\s*less', 'view\\s*less', 'less\\s*results',
    'ver\\s*menos', 'mostrar\\s*menos', 'voir\\s*moins', 'afficher\\s*moins',
    'daha\\s*az', 'weniger\\s*anzeigen', 'mostra\\s*meno', 'minder\\s*tonen',
    'poka[\u017cz]\\s*mniej', 'свернуть', 'скрыть', 'إخفاء',
    '\u6536\u8d77', '\u6298\u308a\u305f\u305f\u3080', '\uc811\uae30', '\u0e0b\u0e48\u0e2d\u0e19',
    'pelajari', 'learn\\s*more', 'read\\s*more', 'baca\\s*selengkapnya',
    'saiba\\s*mais', 'm[áa]s\\s*informaci', 'en\\s*savoir\\s*plus',
    'weitere\\s*informationen', 'ulteriori\\s*informazioni', 'meer\\s*informatie',
    'wi[ęe]cej\\s*informacji', 'подробнее', 'узнать\\s*больше',
    'اطلاعات\\s*بیشتر', 'المزيد\\s*من\\s*المعلومات',
    '詳細', '자세히', 'อ่านต่อ',
    'next\\s*page', 'halaman\\s*berikutnya', 'pr[óo]xima\\s*p[áa]gina',
  ].join('|'), 'i');
  // Deliberately not matched anywhere: pagers. They replace the list instead of
  // extending it, so clicking one loses the rows already found.
  const MORE_ATTR = /load[-_]?more|show[-_]?more|infinite|pagination-more/i;

  function findLoadMore(el) {
    // A MAP THAT HAS SAID HOW ITS LIST GROWS IS NOT SEARCHED FOR A LOAD-MORE — not by the
    // finder below, and not by a remembered selector either. This is the whole of the
    // `?immersive=on` bug, and the guess was doing three separate kinds of damage at once.
    //
    // 2GIS has no load-more. What the finder matched was the map's own "иммерсивные дороги"
    // toggle — a SETTING — and `clickMore:true` duly pressed it. Measured on
    // `2gis.kz/almaty/кафе`: 13 rows before, 13 rows after, and the address bar rewritten to
    // `…/search/кафе?immersive=on`.
    //
    //   1. It never grew anything, so "Keep going" pressed a light switch forever.
    //   2. The sighting made `sawMore` truthy, which is what raises the "the feed is still
    //      going" card — so the card offering the pager was never reached.
    //   3. THE REWRITE SPLIT THE VISIT. `visitKey` changed, `sessionFor` minted a new sid, and
    //      `saveResult` filed the next page under a NEW table id. Measured: two records for one
    //      search in one page load — `…/кафе` at 30 rows and `…/кафе?immersive=on` at 30 rows.
    //      That is "the table stopped getting rows": they were still arriving, into a record the
    //      panel was no longer pointing at.
    //
    // Scoped to providers, deliberately, and derived from what they already declare rather than
    // from a new list to keep in step. `grows` says HOW a map's list gets longer — 'scroll' for
    // Maps, 'pager-click' for 2GIS — and a provider that has answered that question has no
    // load-more to find. A provider that grows by pressing one would say `grows: 'press'` and
    // keep everything below. Everything that is not a known map is untouched: this is the shape
    // of fix this project keeps paying for (see the load-more/pager note in `sidepanel.js`), so
    // it is not applied one inch wider than the providers that asked for it.
    //
    // IT REFUSES THE GUESS, NOT THE POINT — and the placement is the whole of the rule.
    //
    // I first put this ABOVE the pointed selector, reasoning that a remembered control on a map
    // we have measured must be a mis-point. That breaks the one path on this map that works.
    // `startPointing` tests a pointed control by PRESSING it through this function: point at
    // 2GIS's pager arrow — a `<div>` with no href, so `navigates` is false and the panel has
    // nothing to read — and the press is the only measurement available. Refuse it and the panel
    // reports "I found it, but could not press it" about a control that turns the page perfectly
    // well, and "That one turns the page → Follow the pages" is never reached.
    //
    // The residual it was guarding against does not occur: for `mem.selector` to hold the
    // immersive toggle, the press would have to have ADDED ROWS (`after > before`). It adds none
    // and moves the URL instead, so the panel takes the `movedTo` branch and saves it as
    // `nextSelector` — a different memory, read by `findNextPage`. So the gate goes here, below
    // the point and above the guess, which is also what it says in words: nobody pointed at the
    // immersive toggle. We found it ourselves, on a map that had already told us it does not
    // grow that way.
    if (op.moreSelector) {
      const pick = resolve(op.moreSelector);
      if (pick && pick.getClientRects()[0]) {
        const label = (ownTextDeep(pick) || pick.getAttribute('aria-label') || 'the control you picked')
          .slice(0, 40);
        return { el: pick, box: pick.getClientRects()[0], score: 9, near: 0, label, pointed: true };
      }
      // Falls through when it no longer resolves: a page that changed is not worth an
      // error, and the automatic finder is still there.
    }
    const grows = traitsOf(mapKind()).grows;
    if (grows && grows !== 'press') return null;
    // The button usually sits just after the list, but "just after" can be five
    // wrappers up — Unsplash's "Load more photos" is nowhere near the grid in the
    // tree. So widen ring by ring, then sweep the document but only accept a
    // control positioned BELOW the list: nothing that extends a list sits above it.
    const scopes = [el];
    for (let n = el.parentElement, i = 0; n && i < 5; n = n.parentElement, i++) scopes.push(n);
    scopes.push(document.body);
    const listBox = el.getClientRects()[0] || { top: 0, bottom: 0 };
    const seen = new Set();
    let best = null;

    for (const scope of scopes) {
      const wide = scope === document.body;
      let looked = 0;
      // A LOAD-MORE IS OFTEN NOT A CONTROL, IT IS A DIV THAT ACTS LIKE ONE.
      //
      // This used to ask only for `button, a, [role=button]`, and on lazada.co.id the button reads
      // `<div class="load-more-button">Memuat Lebih Banyak</div>` — 389x42, a click handler, no
      // role, no href. The wording had matched all along (`muat lebih` is inside `memuat lebih`,
      // and `load-more-button` matches `MORE_ATTR`); the element was never looked at. Measured
      // live: 309 anchors and buttons on that page, a sweep cap of 4000, and the one thing that
      // grows the list is in none of them. It reported "That is the whole list — 72 rows" over a
      // visible button, and pointing at it by hand did not help either, because the pointed
      // control is pressed through this same function.
      //
      // So `div, span, li` are in the sweep, with two things standing in for the tag:
      //
      //   DIRECT TEXT ONLY   a wrapper's `textContent` is its whole subtree, so every ancestor of
      //                      the label matches too and the outermost usually wins. Reading only
      //                      the element's own text nodes picks the label itself, and skips the
      //                      thousands of layout divs for the cost of one childNodes loop — which
      //                      is also why this is affordable at all.
      //   cursor: pointer    the honest signal that a div is a control. Computed style is only
      //                      read for the handful that already matched wording.
      const TAGS = 'button,a[role="button"],[role="button"],a,div,span,li';
      for (const b of scope.querySelectorAll(TAGS)) {
        if (++looked > MORE_SWEEP) break;
        if (seen.has(b)) continue;
        seen.add(b);
        if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
        // Pressed once, and the list got shorter. See `scrollStep`.
        if (window[S]?.noPress?.has(b)) continue;

        // Wording first, geometry second. This used to read getClientRects() for
        // every control before testing its text, under a cap of 600 examined — and
        // Tokopedia's homepage carries 714 controls, several hundred of them SEO
        // footer links, so the budget was spent long before the loop reached the
        // button. Cheap test first means the cap is never the reason a button is
        // missed, and forcing layout only for the few that match wording is also
        // the faster order.
        // Whether the tag alone says "control". Everything else has to earn it below.
        const real = b.tagName === 'BUTTON' || b.tagName === 'A' || b.getAttribute('role') === 'button';
        const attrs = `${b.className || ''} ${b.getAttribute('data-testid') || ''} ${b.id || ''}`;
        const said = real ? ownTextDeep(b) : directText(b);
        // The cheap exit that makes sweeping every div affordable: a layout wrapper holds no text
        // of its own and names itself nothing, and that is decided without touching the subtree.
        if (!real && !said && !MORE_ATTR.test(attrs)) continue;
        const label = `${said} ${b.getAttribute('aria-label') || ''} ${b.title || ''}`;
        if (MORE_NEVER.test(label)) continue;

        // MORE_ATTR is a class/id/testid coincidence, not a word a person read — a fallback for
        // when there is no real text to judge at all (an icon-only "+" styled `load-more-btn`).
        // It must never OVERRIDE real text that already failed every wording check: blibli's
        // filter sidebar carries its own, unrelated "Lihat semua" ("see all") div, three
        // ancestors up from the product list (well inside this sweep's own neighbourhood, not
        // just the document-wide fallback), that reveals more COLOR CHIPS, not more products —
        // and it only matched here because its class, `filter-chips-list__show-more`, happens to
        // contain the substring "show-more". Its own text says "Lihat semua", which is not "more"
        // in any language on the list, and that verdict has to stand: a class-name coincidence
        // does not get to overrule text that was actually read.
        const strong = MORE_STRONG.test(label) || (!said && MORE_ATTR.test(attrs));
        const weak = !strong && MORE_WEAK.test(label);
        if (!strong && !weak) continue;

        let box = b.getClientRects()[0];
        if (!box || box.width < CONTROL_MIN_W || box.height < CONTROL_MIN_H) continue;
        if (wide && box.top < listBox.top) continue;
        // A real list extender is a button, and it is a proper target. A 26px
        // inline link saying "see more" is a disclosure, not a control.
        //
        // AND A DIV EARNS THE SAME STANDING BY BEHAVING LIKE ONE. The label often is not the
        // clickable node — plenty of sites put the handler and the cursor on its parent and leave
        // the text in an inert child — so the pointer is looked for a few levels up and, when it
        // is found there, THAT is the thing to press. Bounded to three, because past that the
        // pointer belongs to a card or a whole row, not to this control.
        let act = b;
        if (!real) {
          let hop = null;
          for (let n = b, i = 0; n && i < POINTER_HOPS; n = n.parentElement, i++) {
            let cur = '';
            try { cur = getComputedStyle(n).cursor; } catch (_) {}
            if (cur === 'pointer') { hop = n; break; }
          }
          if (!hop) continue;                    // nothing here behaves like a control
          if (hop !== b) { act = hop; box = hop.getClientRects()[0] || box; }
        }
        const isButton = b.tagName === 'BUTTON' || b.getAttribute('role') === 'button' || !real;
        // AND THE SIZE GUARD TESTS THE TAG, NOT THE STANDING A DIV JUST EARNED.
        //
        // The rule above it is right and old: "a 26px inline link saying see more is a disclosure,
        // not a control". It was written as `!isButton`, and the moment a pointer-div counted as a
        // button that guard stopped applying to precisely the elements newly let in. Measured on
        // lazada.co.id/tag/android: a 190x15 `Lihat Lebih Banyak` — half of a see-more/see-less
        // toggle belonging to another widget — was chosen over nothing, pressed, and grew the list
        // from 40 to 40. A real list extender is a real target; fifteen pixels is a disclosure
        // whatever it calls itself.
        if (weak && !real && box.height < DISCLOSURE_MAX_H) continue;
        // A link that goes somewhere is pagination or a category, not a list
        // extender — clicking it navigates. On Pixabay that destroyed the page
        // mid-scan and the whole result came back empty. A real load-more is a
        // button, or an anchor with no destination.
        // Two holes this used to have, both of which move the tab the user is looking
        // at. role="button" on an anchor did NOT disqualify it — but the browser
        // follows an href regardless of what the element calls itself. And a <button>
        // wrapped in <a href> was never checked at all, because it matched as a button.
        // Blibli's next-page control is one of those two, and pressing it walked the
        // live tab to ?page=2&start=40 mid-scan.
        //
        // The identity guard cannot catch this afterwards: it compares origin+path, and
        // pagination that lives in the QUERY leaves both unchanged.
        const nav = b.tagName === 'A' ? b : b.closest('a[href]');
        if (nav) {
          const href = nav.getAttribute('href') || '';
          if (href && !/^#|^javascript:/i.test(href)) continue;
        }

        // Rank by what it is, then by how close it sits to the end of the list.
        const score = (strong ? 4 : 0) + (isButton ? 2 : 0) + (box.height >= TALL_BUTTON_H ? 1 : 0);
        const near = -Math.abs(box.top - listBox.bottom);
        // WHAT TO CALL IT, which is not what matched it. A wrapper is often found by its class
        // (`load-more-button` matches `MORE_ATTR`) while its own text nodes are empty, because the
        // words sit in an inert child — so the panel offered "Keep going" on a control with no
        // name at all. Matching still reads direct text only; the NAME may come from the subtree,
        // where a person would read it.
        const shown = (label.trim() || ownTextDeep(act) || ownTextDeep(b)).trim();
        if (!best || score > best.score || (score === best.score && near > best.near)) {
          best = { el: act, box, score, near, label: shown.slice(0, 40) };
        }
      }
      if (best && best.score >= SURE_SCORE) break; // an explicit button needs no wider search
    }
    return best;
  }

  const ownTextDeep = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  // The element's OWN words, not its subtree's. A wrapper repeats every label beneath it, so
  // `textContent` makes each ancestor of a load-more look like one too — and the outermost, being
  // the biggest, usually wins. This reads only direct text nodes, which picks the label itself and
  // costs one childNodes loop instead of a subtree walk. That difference is what makes sweeping
  // every div affordable at all.
  const directText = (el) => {
    let out = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) out += n.nodeValue;
      if (out.length > 90) break;
    }
    return out.trim().replace(/\s+/g, ' ').slice(0, 80);
  };

  // One batch of new rows per call, not one scroll per call. A single jump often
  // lands short of the trigger — the list appends a screenful, so the bottom
  // moves away faster than one viewport of scrolling closes on it — and a step
  // that reliably does nothing reads as a broken button. So: keep going until
  // rows actually arrive, the scroller stops moving, or the budget runs out.
  // Still a step and not a run: it returns the moment anything new appears, so
  // the caller stays in control and stopping is immediate.
  const MAX_HOPS = 10;
  // Raised alongside settle(): one hop can now legitimately spend four seconds
  // waiting for a fetch, and the old eight-second ceiling cut a click-and-load
  // cycle off before it finished.
  const HOP_BUDGET_MS = 16000;

  async function scrollStep() {
    netWatch();
    const st = window[S];
    const c = st?.cands?.[st.i];
    if (!c) return { error: 'NO_CANDIDATE' };
    const sc = scrollerFor(c.el);
    const before = c.rows.length;
    // A THIRD WAY THIS CAN SUCCEED, alongside rows growing and the URL moving. A pointed control
    // with no href that swaps the whole page in place — a JS-driven "next page" button, not a
    // load-more — never grows `c.rows` (it REPLACES them) and its own selector legitimately stops
    // resolving once the DOM it lived in is gone, which used to be read as "lost track of that
    // control" even when the press worked exactly as asked. `listMark()` is the same fingerprint
    // `hopHere`'s automated walk already trusts for exactly this distinction; capturing it here
    // gives the manual point-and-press flow the same three-way answer instead of only two.
    const markBefore = listMark();
    const top = () => (sc ? sc.scrollTop : (window.scrollY || document.documentElement.scrollTop));
    const started = performance.now();
    // Always on. It was briefly a setting, but a toggle nobody reads is worse
    // than no toggle, and pressing a button the page put there to extend its own
    // list is not a risky act. `clickMore:false` stays as an argument so the
    // tests can prove the click is what grows the list.
    const wantClick = op.clickMore !== false;

    let grew = false;
    let atEnd = false;
    // Why a feed ended, in the feed's own terms. The panel needs it: on a list that
    // ended because it SAID so, offering "point at the load more" is asking the user
    // for a control the page does not have.
    let endedBy = '';
    let clicked = 0;
    let clickedLabel = '';
    let more0 = null;          // the control pressed this hop, so a shrink can name it
    let waited = 0;
    let fetched = 0;

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      if (stopped()) break;
      const at = top();
      const by = sc ? sc.clientHeight : innerHeight;
      if (sc) sc.scrollTop = at + by;
      else {
        // A hop never scrolls past the list. Beyond its bottom lies the footer, and on
        // a virtualizing shop parking there unmounts both the fresh rows and the
        // load-more — a press from the footer fetches nothing. Capped so the list's end
        // stays in view; hitting the cap reads as `stuck`, which is exactly the state
        // that hunts for the button and presses it. The cap moves as the list grows.
        let cap = Infinity;
        try {
          const rb = c.el.getBoundingClientRect();
          cap = Math.max(0, rb.bottom + (window.scrollY || 0) - innerHeight * HOP_CAP_FRAC);
        } catch (_) {}
        window.scrollTo({ top: Math.min(at + by, cap), behavior: 'instant' });
      }
      // `behavior:'instant'` (above) overrides a page's `scroll-behavior:smooth`;
      // animated scrolling reads the OLD scrollY on the next line and concludes the
      // page would not move.

      // Judged after the scroll has actually taken effect, not on the same tick.
      const stuck = top() === at;
      if (wantClick) {
        // `stuck` — the page would not move — used to be the only trigger, which on a
        // page with a tall footer below the list means every hop is spent scrolling
        // furniture and the button is reached once, at the end. A control within
        // reach is a control to press.
        const more = findLoadMore(c.el);
        if (more && st && !st.sawMore) st.sawMore = { label: more.label, selector: pathOf(more.el) };
        if (more && (stuck || withinReach(more.el))) {
          reach(more.el);
          more.el.click();
          clicked++;
          clickedLabel = more.label;
          more0 = more.el;
        }
      }

      // Wait on the page's signals rather than a fixed pause.
      const s = await settle(c.el, op.pause ? Math.max(op.pause, PAUSE_FLOOR_MS) : SETTLE_MAX);
      waited += s.waited;
      fetched += s.fetched;

      recount(c);
      trackEviction(c);

      // A CONTROL THAT MADE THE LIST SMALLER IS NOT A LOAD-MORE, WHATEVER IT IS CALLED.
      //
      // The word list above catches the collapse buttons that are named in a language we know.
      // This catches the rest, and it is the version with a floor: pressing is a measurement, and
      // a press that REMOVED rows has answered the question. Remembered by element rather than by
      // selector so nothing has to be re-derived, and consulted by `findLoadMore`.
      if (clicked && c.rows.length < before && st) {
        st.noPress = st.noPress || new Set();
        if (more0) st.noPress.add(more0);
        if (st.sawMore && st.sawMore.label === clickedLabel) st.sawMore = null;
      }

      if (c.rows.length > before) { grew = true; break; }
      // "Nothing moved, nothing to click" is NOT the same as finished, and treating it as
      // finished is why an infinite feed with no button stopped at ninety rows. Between
      // batches, such a page is *supposed* to be at the bottom of its list with nothing
      // arriving — that is the moment its loader is waiting for, not the end of the list.
      //
      // And the scroll is pinned there by our own doing: a hop stops at the bottom of the
      // LIST, deliberately, so a virtualizer cannot unmount the load-more into a footer.
      // A page whose loader keys off the DOCUMENT end therefore never gets the signal it
      // wants. So when no button has been seen anywhere, go the rest of the way down —
      // there is no control to protect — wait properly, and only conclude after three
      // hops in a row that moved nothing and gained nothing.
      // Nothing moved, nothing to click, nothing arrived: the list is done.
      //
      // KNOWN INCOMPLETE. This is wrong for one shape — a feed with no button that
      // appends on scroll, where sitting at the bottom of the list with nothing arriving
      // is the ordinary gap between batches rather than the end. `/endless` in the row
      // suite reproduces it: ten rows of sixty.
      //
      // The obvious cure — retry a few times, and scroll past the list's bottom to the
      // document end since there is no load-more to protect — was tried and reverted. It
      // did not fix the fixture, and it cost every genuinely-finished list several extra
      // seconds, which pushed a real deep scan past the point where its rows were saved
      // at all. Two checks in the extension suite catch that regression; leave them
      // pointed at whatever comes next.
      //
      // WHAT COMES NEXT, for one shape only: a container that DECLARED itself a feed.
      // The reverted cure was applied to every list, which is why it cost every finished
      // list several seconds. `role="feed"` narrows it to pages that have said they append
      // as you scroll — and those pages also say when they stop. Google Maps writes
      // "You've reached the end of the list." into the rail itself, so the walk can wait
      // to be TOLD instead of inferring the end from a quiet moment. Measured: the rail
      // reads 72, 82, 82, 92 — a flat round in the MIDDLE of a run — and the walk stopped
      // at 41 of ~112 places, then asked the user to point at a load-more control that
      // does not exist on Maps at all.
      //
      // Ten seconds is the other exit, because a feed that has genuinely died must not
      // hold the walk forever. Maps' batches land in 1-2s, so ten is generous by 5x.
      // Ordinary lists keep the immediate `atEnd` below and pay nothing for any of this.
      if (stuck && !clicked && c.mode === 'feed') {
        // Already told, before we even waited. This case used to fall through to the
        // generic break below, which set `atEnd` with no reason attached — so the panel
        // could not tell "the page says it is finished" from "we gave up guessing", and
        // showed the point-at-a-button card either way.
        if (FEED_DONE.test(feedText(c.el))) {
          atEnd = true;
          endedBy = 'said so';
          if (st) st.endedBy = endedBy;
          break;
        }
        const had = c.rows.length;
        const until = performance.now() + FEED_WAIT_MS;
        let arrived = false;
        let told = false;
        while (performance.now() < until && !stopped()) {
          await nap(FEED_POLL_MS);
          recount(c);
          trackEviction(c);
          if (c.rows.length > had) { arrived = true; break; }
          if (FEED_DONE.test(feedText(c.el))) { told = true; break; }
        }
        waited += Math.round(performance.now() - (until - FEED_WAIT_MS));
        if (arrived) { grew = true; break; }
        atEnd = true;
        endedBy = told ? 'said so' : 'nothing arrived for 10s';
        // Kept on the walk's own state, not just in this return: the outer walk calls
        // scrollStep repeatedly and hands the panel a `summary()`, so a reason that lives
        // only in one hop's return value never reaches the sheet that needs it.
        if (st) st.endedBy = endedBy;
        break;
      }
      if (stuck && !clicked) { atEnd = true; break; }
      // The button was clicked but the list did not grow — one more hop gives a slow
      // fetch its chance; DEAD_PRESSES failures in a row means the button is spent.
      if (stuck && clicked >= DEAD_PRESSES) { atEnd = true; break; }
      if (performance.now() - started > HOP_BUDGET_MS) break;
    }

    if (op.mark || op.reveal) paint(c, !!op.reveal);
    // Did the control the user POINTED at actually get pressed? findLoadMore falls
    // through to the automatic finder when a pointed selector no longer resolves — and
    // the automatic finder deliberately never matches a pager, so the honest outcome is
    // "nothing was pressed". The panel reported that as "Pressed it, and nothing
    // arrived", which names the wrong problem: the control was never reached, and being
    // told to point at another one cannot help.
    const pointedStill = op.moreSelector ? !!resolve(op.moreSelector) : null;
    // POLLED, NOT CHECKED ONCE — the same reason `hopHere`'s own page-turn wait polls rather
    // than sleeping a fixed amount. `settle()` above is tuned for a load-more's shape: MORE rows
    // arriving into the SAME container, which is usually a background fetch that resolves in a
    // few hundred milliseconds. A pager that REPLACES the container — a real page-2 fetch and
    // render, not a background XHR — is a different, slower shape, and checking the fingerprint
    // exactly once right after `settle()` returns can run before that replacement has actually
    // landed. Measured live on blibli.com: a genuine page turn (confirmed by the URL moving)
    // still read as "lost track of that control", because the container swap had not finished by
    // the time this ran. So the same fingerprint is asked for again, a few times, before giving
    // up — cheap when the first check already caught it (the common, already-settled case), and
    // the only way to catch the slower one without guessing a fixed extra delay.
    let contentChanged = clicked > 0 && !!markBefore && markBefore !== listMark();
    if (clicked > 0 && !contentChanged && markBefore) {
      for (let i = 0; i < MARK_RECHECKS && !contentChanged && !stopped(); i++) {
        await nap(MARK_RECHECK_MS);
        contentChanged = markBefore !== listMark();
      }
    }
    return {
      ...summary(),
      grew,
      atEnd,
      endedBy,
      clicked,
      clickedLabel,
      waited,
      fetched,
      pointedStill,
      contentChanged,
      pressedPointed: !!op.moreSelector && clicked > 0 && pointedStill,
      scroller: sc ? pathOf(sc) : 'document',
    };
  }

  // --- summary crossing the boundary ---------------------------------------
  // Column keys are DOM paths — unambiguous, and unreadable. The CSV keeps them;
  // a human confirming a guess needs to know what KIND of thing each value is,
  // not where it sat in the tree.
  function labelOf(key) {
    if (/ (src|srcset|data-src|data-original|data-lazy-src|data-srcset)( \d+)?$/.test(key)) return 'image';
    if (/ href( \d+)?$/.test(key)) return 'link';
    const seg = key.split('/').pop() || '';
    const tag = seg.split('.')[0].split(' ')[0];
    return ({ h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading',
      time: 'date', img: 'image', a: 'link', b: 'text', strong: 'text' }[tag]) || 'text';
  }

  const SHAPE_MAX = 40;   // enough ticks to see whether the rows agree
  const PREVIEW_ROWS = 2; // two is enough to show a pattern; three crowds the panel

  const summary = () => {
    const st = window[S] || { cands: [], i: 0 };
    const c = st.cands[st.i];
    if (!c) {
      return { index: 0, candidates: 0, rows: 0, cols: 0, shape: [], preview: [],
        selector: '', swept: st.swept || 0, truncated: !!st.truncated, url: location.href };
    }

    // Field count per row, capped. A stack of even ticks means the rows agree,
    // which is what "the detection is right" looks like; a ragged stack is the
    // signal that a wrapper got picked instead of the list.
    const shape = [];
    const cells = [];
    for (let i = 0; i < Math.min(c.rows.length, SHAPE_MAX); i++) {
      const cl = cellsOf(c.rows[i], c.pair);
      shape.push(Object.keys(cl).length);
      if (i < PREVIEW_ROWS) cells.push(cl);
    }

    // Real values, each labelled by kind. The old readout joined four values with
    // a dot and dropped their labels, which on a feed page read as broken text
    // rather than as proof the right thing was caught.
    const preview = cells.map((cl) => {
      const seen = new Set();
      const out = [];
      for (const [k, v] of Object.entries(cl)) {
        const label = labelOf(k);
        if (seen.has(label)) continue;      // one example per kind, not five spans
        seen.add(label);
        out.push([label, v.length > 64 ? v.slice(0, 63) + '…' : v]);
        if (out.length >= PREVIEW_KINDS) break;
      }
      return out;
    });

    return {
      index: st.i,
      candidates: st.cands.length,
      rows: c.rows.length,
      cols: Object.keys(cells[0] || {}).length,
      shape,
      preview,
      selector: pathOf(c.el),
      // What the button on this page actually says, so the panel can name it
      // instead of guessing that every list is extended by scrolling.
      more: (findLoadMore(c.el) || {}).label || null,
      // Set only when a declared feed ended on its own terms. The panel uses it to stop
      // asking for a load-more control on a page that has none.
      endedBy: st.endedBy || '',
      // What the walk actually saw, and where. Survives the scroll being restored, so the
      // panel can ask about a control that is no longer mounted.
      sawMore: st.sawMore || null,
      // Every list found, not just the selected one — a page with a grid and two
      // sidebars has three, and reporting one of them hides the other two.
      // A SAMPLE OF THE FIRST ROW, because `labelFor` legitimately returns nothing on the pages
      // that need choosing most: hashed classes, no caption, no heading above the grid. "55 rows"
      // and "16 rows" is not a choice anyone can make, and "Filter option 0" against "Product 0"
      // is. One row's text per candidate, not one per row.
      tables: st.cands.map((k, i) => ({
        index: i, label: k.label || '', rows: k.rows.length,
        sample: ((k.rows[0]?.textContent) || '').trim().replace(/\s+/g, ' ').slice(0, 48),
      })),
      swept: st.swept || 0,
      truncated: !!st.truncated,
      primed: st.primed || 0,
      pressed: st.pressed || 0,
      hops: st.hops || 0,
      wasStopped: !!st.wasStopped,
      recycling: !!st.recycling,
      url: location.href,
    };
  };

  // --- priming a page that renders nothing until you scroll ------------------
  // Some pages ship an empty shell and fill each section only as it nears the
  // viewport. Tokopedia's homepage is the extreme case: at 11 seconds it held 464
  // characters of text, 21 images, and *no skeletons at all* — so neither a longer
  // timer nor the busy-element check can tell that it is unfinished. One pass of
  // scrolling turned that into 29,912 characters and 107 images.
  //
  // Reading such a page without walking it first does not yield a smaller list, it
  // yields the wrong thing entirely: the only container that repeats on an empty
  // shell is the shell.
  //
  // Priming moves the page, so it runs only when the user has asked for a scan and
  // expects movement — never on the passive poll. The scroll position is restored
  // afterwards, so the page is left where they had it.
  // Walks DOWN from wherever the page is, and leaves it there. It used to jump to
  // the top, walk, and spring back — and because a deep scan runs the asset walk
  // first, which does its own round trip, the page went down-up-down-up while the
  // user watched. Every jump also re-anchors lazy loaders that key off direction.
  // One descent per scan, one restore at the end of it, and the caller owns that.
  // `resume` means an asset walk has just covered this page and left us at the
  // bottom, so the descent continues rather than starting over. Without it the walk
  // begins at the top, because waking a page means every screen passing through the
  // viewport in order — resuming from mid-page skips whatever is above, and on
  // Tokopedia that is the feed itself: 18 rows instead of 491.
  async function walkDown(resume) {
    netWatch(); // only the scrolling paths watch; the passive poll stays passive
    const wantsPress = op.clickMore !== false;
    const step = Math.max(PRIME_STEP_MIN_PX, Math.round(innerHeight * PRIME_STEP_FRAC));
    if (!resume) window.scrollTo({ top: 0, behavior: 'instant' });
    const docH = () => document.documentElement.scrollHeight;
    const started = performance.now();
    let screens = 0;
    let pressed = 0;
    let sawMore = null;
    let dry = 0;
    let grewEver = false;
    // Patience, not distance, is what a page earns by growing. Every page is walked to
    // its end; a page that has stopped growing is walked FAST — bigger steps, a short
    // dwell instead of a settle. The walk used to break off mid-page instead, which
    // saved the same time and cost the rest of the page: on Pixabay's video search it
    // stopped at y=3240 of 12302, a quarter of the way down, and any list whose images
    // load lazily loses everything below that line. Growth anywhere puts the patience
    // back.
    let sweeping = false;
    let at = resume ? (window.scrollY || document.documentElement.scrollTop || 0) : 0;
    // Seeded with the page's CURRENT height, not zero. At zero the very first
    // screen of every page in existence counted as growth, so every static page
    // was treated as a lazy one and paid a lazy one's patience: Books to Scrape
    // went from 0.7s to 6.3s for the same 20 rows.
    let lastH = docH();

    // Bounded by time, not by a screen count. A screen count cannot bound this:
    // the pages that need waking are exactly the ones that grow while you walk
    // them, so an 8-screen cap on Tokopedia ran out several screens above the
    // bottom and the walk never reached the button at all. PRIME_SCREENS survives
    // only as a backstop against a page that grows forever without loading.
    while (screens < PRIME_SCREENS && performance.now() - started < PRIME_BUDGET_MS) {
      if (stopped()) break;
      // Sweeping takes two screens at a time, and more than that if the page is tall
      // enough that two would run out the screen budget before reaching the end. The
      // guarantee is arriving at the bottom, so the step is whatever that costs.
      let jump = step;
      if (sweeping) {
        const left = Math.max(1, PRIME_SCREENS - screens);
        jump = Math.max(step * 2, Math.ceil((docH() - innerHeight - at) / left));
      }
      at = Math.min(docH(), at + jump);
      window.scrollTo({ top: at, behavior: 'instant' });
      screens++;
      if (sweeping) await nap(SWEEP_DWELL_MS);
      else await settle(document.body, PRIME_SETTLE_MS);

      const h = docH();
      // Growth resumes: the page is loading again, so stop sweeping and wait properly.
      if (h > lastH) { grewEver = true; dry = 0; lastH = h; sweeping = false; continue; }
      dry++;

      // Reached the bottom of a page that has stopped growing. That is not the
      // same as finished: Tokopedia gates its feed behind "Muat Lebih Banyak",
      // and no amount of scrolling past it does anything. The walk used to reach
      // here, conclude the page was complete, and leave the button unpressed —
      // so clicking it by hand beat a deep scan, which is the one comparison a
      // deep scan must never lose. Pressing what the page put there to extend its
      // own list is the same act as scrolling it.
      const atBottom = at >= h - innerHeight - BOTTOM_SLACK_PX;

      // Press what is in front of us, wherever we are on the page. Waiting for the
      // bottom means walking past the very control that would have extended the list.
      //
      // Looked for whether or not we intend to press it. The sighting is the thing worth
      // keeping: the panel asks the user about this control AFTER the scan, by which time
      // the scroll has been put back at the top and the page has unmounted the button —
      // so a fresh look then reports nothing, and the question is never asked at all.
      // Recorded here, at the bottom, where the control actually exists.
      // Kept in a local and RETURNED: this runs before detect() has created the state
      // object, so writing to window[S] here silently vanished — the sighting was null
      // by the time the panel asked, and the question was never raised at all.
      const seen = findLoadMore(document.body);
      if (seen && !sawMore) sawMore = { label: seen.label, selector: pathOf(seen.el) };

      // `clickMore:false` declines the press and NOTHING else. The walk still covers
      // every screen, because scrolling is how the page mounts its content and how the
      // control becomes findable at all — a scan that stopped walking because it was
      // not going to press would also lose the button it might later be asked to press.
      // Scrolling is passive; clicking is an action taken on someone else's page, and
      // only the second one is a choice worth offering.
      if (wantsPress && pressed < PRIME_CLICKS) {
        const more = seen;
        if (more && (withinReach(more.el) || atBottom)) {
          pressed++;
          dry = 0;
          reach(more.el);
          more.el.click();
          await settle(document.body, PRIME_SETTLE_MS);
          continue; // never conclude while a press is still arriving
        }
      }

      if (!atBottom) {
        // Nothing is arriving and we are mid-page. Stop PAYING for patience — a settle
        // per screen is what made webscraper.io spend 6.3s proving its 117 rows were
        // already there — but keep walking. Where the walk stops has to be one rule for
        // every page, and it is the bottom: rows may all be present on a static page,
        // images below the fold are not, and only a scroll brings those in.
        if (dry >= PRIME_DRY) sweeping = true;
        continue;
      }

      // At the bottom, quiet, nothing to press — wait properly before believing
      // it. settle() returns on the first 320ms of DOM quiet, which at the foot of
      // a feed means about four-tenths of a second; Tokopedia needs several before
      // it mounts the section holding the rest of its feed AND the "Muat Lebih
      // Banyak" that extends it. The walk reached the bottom of a 3873px page,
      // found no button, and stopped — on a page that goes to 6709px and beyond.
      // Scrolling by hand beat it purely by being slower.
      // ...but only on a page that has shown itself to load late. A page that never
      // grew has nothing to wait for, and making it prove that four times over is
      // pure delay.
      if (dry < (grewEver ? BOTTOM_TRIES : 1)) {
        await nap(BOTTOM_DWELL_MS);
        await settle(document.body, PRIME_SETTLE_MS);
        continue;
      }
      // Enough is enough: the page has stopped growing twice over, we are at the
      // bottom, and there is nothing left to press.
      //
      // There used to be a second exit here — "stop once any list of six or more
      // rows exists" — meant to spare already-rendered pages. It stopped the walk
      // at the second screen of every page that has a category strip near the top,
      // which is most shops, and cost far more than it saved. Reaching the bottom
      // is the only honest way to know a page is done, and it costs about a second
      // and a half on a static page.
      break;
    }

    return { screens, pressed, sawMore };
  }

  // Every path that is allowed to move the page shares one entry: wake the page,
  // then decide what is on it.
  //
  // "Only prime when nothing was detected" was the first version of this, and it
  // was wrong in the case that matters. An unwoken page is not empty — it has a
  // banner carousel and a strip of category icons — so detection succeeded, found
  // 5 rows and 7 rows, and the product grid that was the entire point never got a
  // chance to exist. Having *a* list is not evidence the page has finished.
  //
  // Primed once per page: a second scan re-checks in about a screen and a half,
  // because a page that is already awake stops growing immediately.
  //
  // `always` is false for the scroll action. Growing a list is already a walk with
  // its own settle at every hop, so priming first only repeats that work — and it
  // repeats it invisibly, which made a single hop look like it had loaded two
  // screens' worth of rows.
  let home = null; // set by ensure(), applied once when the scan is over

  // ARMED ONCE PER PAGE, so a walk can report that focus went away at some point rather than only
  // where it happened to be standing at the end. `blur` on the window is the event that fires when
  // you click another application or another window — the case `document.hidden` cannot see.
  function watchFocus() {
    const st = window[S];
    if (!st || st.focusWatched) return;
    st.focusWatched = true;
    try {
      addEventListener('blur', () => { const s = window[S]; if (s) s.sawBlur = true; }, true);
    } catch (_) { /* nothing to do; `focus` in the summary still reports the end state */ }
  }

  async function ensure(always) {
    watchFocus();
    // NOT cleared here. A deep scan is two phases — the asset walk, then this — and
    // clearing the flag at the start of the second one erased a stop pressed during the
    // first: the walk halted, this phase wiped the flag and carried on, and the user had
    // to press Stop twice. The flag belongs to the whole scan, so only the panel clears
    // it, once, when a scan begins ('clearstop').
    const has = !!window[S]?.cands?.length;
    // The memo is a stopwatch, not a latch. It was a plain boolean, which meant the
    // FIRST scan of a page walked it and every scan after that skipped the walk and
    // the hop loop both — so pressing Deep Scan again returned the same number no
    // matter what had happened to the page in between. Its actual job is to stop one
    // user action from walking twice; eight seconds does that, and a deliberate
    // re-scan gets a real pass.
    // A walk that declined to press cannot stand in for one that is asked to press —
    // that is exactly the sequence the half-card produces: a scroll-only scan, the
    // question, and the "Press it" run arriving seconds later. The memo honoured the
    // scroll-only walk and the pressing run did nothing at all.
    // `regrow` continues a list already in hand: no walk from the top, no memo — just
    // more hops from wherever the page stands. It exists because an endless feed meets
    // ANY hop/time ceiling with the button still visible, and the only honest answers
    // are "keep going" or "that is enough" — restarting from the top is neither.
    if (op.regrow && window[S]?.cands?.length) {
      window[STOP] = false;
      const st0 = window[S];
      // CONTINUE, never restart. A stretch that begins at the top re-walks the whole
      // feed to reach the frontier, and the jump back re-anchors the virtualizer — the
      // page unmounts the very rows just gained, which read as "the scan stopped
      // because of the scroll restart".
      //
      // The frontier is the bottom of the LIST, not of the document. The first version
      // jumped to scrollHeight — on a shop that is the SEO footer, thousands of pixels
      // below the feed, where the virtualizer has unmounted the load-more entirely: the
      // scroll is already at its end, nothing is in reach, and the stretch dies at once.
      // The same trap this engine already documents at findLoadMore, reintroduced.
      const c0 = st0.cands[st0.i] || st0.cands[0];
      let frontier = Math.max(0, document.documentElement.scrollHeight - innerHeight);
      try {
        const rb = c0.el.getBoundingClientRect();
        frontier = Math.max(0, rb.bottom + (window.scrollY || 0) - innerHeight * FRONTIER_FRAC);
      } catch (_) {}
      window.scrollTo({ top: frontier, behavior: 'instant' });
      await settle(document.body, PRIME_SETTLE_MS); // let the virtualizer remount here
      let hops0 = 0;
      const began0 = performance.now();
      const base = st0.hops || 0;
      while (hops0 < SCAN_HOPS && performance.now() - began0 < SCAN_BUDGET_MS) {
        if (stopped()) break;
        const r = await scrollStep();
        hops0++;
        st0.hops = base + hops0; // written per hop, so the panel's readout is live
        if (r.error || r.atEnd) break;
      }
      st0.wasStopped = stopped();
      // A STRETCH IS A WALK AND MUST REPORT LIKE ONE. This path set none of the fields the
      // `rows.walk` line is built from, so every stretch logged the numbers of whatever walk ran
      // before it — the same class of defect as `revived`, a field printed on every run that never
      // existed. Written here, after the loop, exactly as the ordinary path does below.
      st0.walkRows = uniqueCount(st0.cands[st0.i] || c0);
      st0.walkHidden = trueHidden();
      st0.walkFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : null;
      st0.walkLostFocus = !!st0.sawBlur;
      st0.walkEndedBy = stopped() ? 'stopped' : 'stretch ended';
      home = null; // stay at the frontier — 'gohome' below is the one trip back
      return 0;
    }

    const wantsPress = op.clickMore !== false;
    // FRESH FROM A LIGHT TOUCH IS NOT FRESH FROM A WALK. `primedAt` is set by the PASSIVE
    // POLL's own `detect(prime:true)` — a bounded "wake the page" pass, explicitly NOT the
    // same thing as finishing the list (see `walkDown`'s own comments) — every ~2.5 seconds
    // the panel is open. `PRIME_MEMO_MS` is 8 seconds, so by the time a person actually
    // presses Deep Scan the poll has almost always refreshed `primedAt` within the last few
    // seconds, and this shortcut fired every time — `always` (this function's own name for
    // "run the real walk, no shortcuts") reached the `has` check below it but never this one,
    // so an explicit deep scan silently extracted whatever was on screen with ZERO hops,
    // however long the panel had been sitting open first. Reported live: `rows.walk hops=0
    // ... tables=6` on a page that scrolls and grows fine when walked directly. Gated on
    // `!always` for the same reason the `has` check already is.
    // ...BUT ONLY FOR A WALK THAT NAMED ITS OWN BOUNDS. `!always` alone was too wide. The two
    // things this gate has to serve are in tension only for one kind of caller:
    //
    //   a deliberate deep scan  — must NOT be short-circuited (the bug above), and always
    //                             names `hops`/`budget`; `openResults` sends both, every time.
    //   a bare `extractAll`     — names nothing, so `SCAN_HOPS`/`SCAN_BUDGET_MS` fall back to
    //                             MAX_SAFE_INTEGER (see their own note: unlimited is deliberate,
    //                             a ceiling on an endless feed reads as "stopped for no reason").
    //
    // Bypassing freshness for BOTH meant a caller that asked for nothing got an unbounded walk
    // that pressed the page's own load-more until the budget it never set ran out. Measured on
    // test/rows.mjs's /buried fixture, which appends 12 rows per press: a re-read that should
    // have reported 144 rows pressed 91 times and reported 1,104. Before `!always` that call
    // took the freshness short-circuit and never walked at all, which is the behaviour a
    // no-arguments re-read should keep having.
    const bounded = op.hops > 0 || op.budget > 0;
    const fresh = !(always && bounded) && window[S]?.primedAt
      && performance.now() - window[S].primedAt < PRIME_MEMO_MS
      && !(wantsPress && window[S].primedPress === false);
    if (op.prime === false || fresh || (has && !always)) {
      if (!has) detect();
      // WHY THE GATE FIRED, in the exact field the walk-summary line already prints.
      // `rows.walk hops=0 ... endedBy= walkEndedBy=` (blank) was reported live and, on its
      // own, is silent about WHICH of the three reasons this early-return exists for actually
      // applied — three separate hypotheses were chased on that silence alone before this was
      // added, one of them shipped and had to be reverted for want of exactly this. Stamped on
      // `window[S]` (not just returned) because `extractAll()` reads `st.walkEndedBy` off the
      // SAME object afterward, on the SAME call — no new plumbing, the log line just stops
      // being blank.
      if (window[S]) {
        window[S].walkEndedBy = `skipped: ${
          op.prime === false ? 'op.prime===false'
            : fresh ? `fresh (primedAt ${Math.round(performance.now() - (window[S].primedAt || 0))}ms ago)`
            : 'has && !always'}`;
      }
      return 0;
    }
    const y0 = window.scrollY || document.documentElement.scrollTop || 0;
    const walk = await walkDown(op.resume);
    let st = detect();
    // Rows hopped from later pages SURVIVE a re-scan. They were paid for — twenty-five
    // pages of fetching — and re-reading page one says nothing about whether page seven
    // is still true. Dropping them here was a decision made on the engine's behalf and
    // it was wrong: a second scan is "check this page again", not "forget what I have".
    // Only a different URL or a different install clears them, up at `stamp()`.
    st.primedAt = performance.now();

    // Waking the page is not the same as finishing the list. Rather than teach the
    // walk above to be patient in yet another way, reuse the hop loop that already
    // knows how to grow a list and press its button — it scopes the hunt to the
    // chosen container instead of the whole document, which is why it finds
    // controls the page-wide sweep does not.
    //
    // Without this, a scan returned 18 rows on Tokopedia's homepage and pressing
    // "Muat Lebih Banyak" by hand returned 154. A deep scan losing to a hand-click
    // is the one comparison it must never lose.
    let hops = 0;
    let lastUniq = 0;
    let dryUniq = 0;
    if (window[S]) window[S].recycling = false; // this scan's verdict, not the last one's
    const c = window[S]?.cands?.[window[S].i];
    const began = performance.now();
    // WHY THE WALK STOPPED. This loop has four exits and recorded none of them, so a rail that
    // came back with 31 rows of 120 was indistinguishable from one that genuinely ended at 31 —
    // and there was nothing in the log to tell them apart. `endedBy` already exists and is already
    // read by the panel; it was only ever filled in on the page-hop path.
    // The vocabulary is the one already in use — 'said so' is what the scroll machinery reports
    // and what the panel and the tests read. Inventing a second phrasing for the same fact broke
    // `rows.mjs` immediately, which was the correct response.
    let why = 'the budget ran out';
    while (hops < SCAN_HOPS && performance.now() - began < SCAN_BUDGET_MS) {
      if (stopped()) { why = 'stopped'; break; }
      const r = await scrollStep();
      hops++;
      if (window[S]) window[S].hops = hops; // live, for the panel's progress poll
      // Only a real ending ends the scan. Breaking on `!grew` looked reasonable and
      // was the whole bug: on Tokopedia the FIRST hop spends its time waiting on a
      // fetch and returns grew=false, atEnd=false — so the scan stopped at 58 rows,
      // one hop into a list that goes 58 → 78 → 98 → 118 → 138 → 157 if you simply
      // keep asking. A hop that did not grow means the page was slow, not finished;
      // atEnd is how the page says finished, and the budget above is what says
      // enough.
      // COUNTED BEFORE THE EXITS, AND THAT ORDER IS THE WHOLE POINT.
      //
      // `lastUniq` is what the log prints as `rows=`, and it used to be assigned BELOW the two
      // breaks — so a walk that ended on its first hop reported `rows=0` however full the rail
      // was, and the reader had no way to tell that from a rail that really was empty. A real
      // report read `rows=0 hops=1 … endedBy=nothing arrived for 10s tables=47`: 47 rows in the
      // DOM, 47 rows exported, and the walk's own line saying nought. It is a constant at
      // `hops=1`, not a measurement, and it sent an investigation after a stall that had not
      // happened. Anything the walk is going to report has to be read before the walk can leave.
      const u = uniqueCount(c);
      const gained = u > lastUniq;
      if (gained) lastUniq = u;

      // Only a real ending ends the scan. Breaking on `!grew` looked reasonable and
      // was the whole bug: on Tokopedia the FIRST hop spends its time waiting on a
      // fetch and returns grew=false, atEnd=false — so the scan stopped at 58 rows,
      // one hop into a list that goes 58 → 78 → 98 → 118 → 138 → 157 if you simply
      // keep asking. A hop that did not grow means the page was slow, not finished;
      // atEnd is how the page says finished, and the budget above is what says
      // enough.
      if (r.error) { why = `error: ${r.error}`; break; }
      if (r.atEnd) { why = 'said so'; break; }

      // A feed that only re-serves what it already gave is finished, whatever its
      // button says. Measured on Tokopedia: 2,026 DOM rows, 284 unique products —
      // pressing on past that point buys repeats, time and nothing else. Judged on
      // UNIQUE yield, so a slow batch still counts as progress.
      if (gained) dryUniq = 0;
      else if (++dryUniq >= RECYCLE_HOPS) {
        st.recycling = true;
        why = `only repeats for ${dryUniq} hops`;
        break;
      }
    }
    // AND ONCE MORE AFTER THE LOOP, for the exits that never reached a hop at all — a walk
    // stopped on its first line, or one whose budget was already spent. `lastUniq` is only ever
    // allowed to grow, so this can correct a zero and can never shrink a real count.
    {
      const u = uniqueCount(c);
      if (u > lastUniq) lastUniq = u;
    }
    // Where to put the page back, recorded but NOT applied here. Restoring at the
    // end of this function still left a jump in the middle of the scan — extraction
    // and the page's own loading came after it and moved the page again, so the user
    // got the bounce AND ended up at the bottom anyway. The move happens once, after
    // everything is finished, in the dispatch below.
    //
    // `restoreTo` is the position the user was actually at: with the descent handed
    // over from the asset walk, by the time this runs the page has already been
    // moved, so y0 is the handoff point rather than home.
    home = op.restoreTo != null ? op.restoreTo : y0;

    st = window[S] || st;
    st.homeY = home; // kept for 'gohome', after however many stretches follow
    st.primed = walk.screens;
    st.pressed = walk.pressed;
    st.hops = hops;
    // ON ITS OWN FIELD, AND IT MUST NOT OVERWRITE `endedBy`. The scroll machinery sets that one
    // with the more specific answer — 'said so' when the page declared the end, 'nothing arrived
    // for 10s' when it simply went quiet — and assigning over it here threw the better reason away
    // in favour of this loop's coarser view of the same event. Only fill it in if nobody has.
    st.walkEndedBy = why;
    if (!st.endedBy) st.endedBy = why;
    st.walkRows = lastUniq;
    st.walkHidden = trueHidden();
    // AND IT IS ASKED OF THE KEEPER, NOT OF THE DOCUMENT — see `trueHidden` above. Reading
    // `document.hidden` here read our own spoof back and printed `false` on every Maps walk.
    //
    // `hidden` IS NOT THE SAME QUESTION AS "were you looking at it", and the difference is the
    // whole of a bug that has now been reported twice.
    //
    // `document.hidden` is true only when the tab is not the active tab of its window, or the
    // window is minimised. A window you clicked AWAY from — another app in front, a second
    // monitor — is still `hidden === false`. So a walk that stalled because the window lost focus
    // logs `hidden=false`, which reads as "the tab was fine", and the run ends
    // `endedBy=nothing arrived for 10s` with no way to tell that from a list that genuinely ran
    // out. Measured on a real report: `rows=56 hops=1 hidden=false endedBy=nothing arrived for
    // 10s` on a list with far more than 56 rows.
    //
    // `hasFocus()` is the question that was missing. `lostFocus` is recorded across the WHOLE
    // walk rather than sampled at the end, because focus coming back before the walk finishes
    // would otherwise erase the evidence.
    st.walkFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : null;
    st.walkLostFocus = !!st.sawBlur;
    st.wasStopped = stopped();
    // A cancelled walk did not finish, so it must not count as "already walked" — it
    // did, and the eight-second memo then made the obvious retry (cancel, then press it
    // again) return the cancelled scan's numbers and do nothing at all.
    //
    // Zero, not a timestamp, and assigned LAST. There is a second `primedAt` stamp
    // above for the ordinary path, and setting this one before it simply got
    // overwritten — the reset was there, and had no effect, for exactly that reason.
    st.primedAt = st.wasStopped ? 0 : performance.now();
    st.primedPress = op.clickMore !== false;
    if (walk.sawMore) st.sawMore = walk.sawMore;
    return walk.screens;
  }

