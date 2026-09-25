  switch (op.action) {
    // Why did detect not pick the thing you can plainly see? Reports the gates in the
    // order detect applies them, for one named element, plus every candidate it did
    // build. Read-only and off the panel's path — nothing calls it but a probe.
    case 'why': {
      const el = document.querySelector(op.selector);
      const st = detect();
      const r = el ? rowsOf(el) : null;
      const pageArea = Math.max(1, innerWidth * innerHeight);
      const area = el ? el.offsetWidth * el.offsetHeight : 0;
      return {
        found: !!el,
        area, needArea: Math.round(MIN_AREA_FRAC * pageArea),
        rowsOf: r ? { rows: r.rows.length, mode: r.mode, sig: r.sig } : null,
        scored: el && r ? scoreOf(el, r.rows, area, r.mode) : null,
        cands: st.cands.map((c) => ({
          tag: c.el.tagName, cls: (c.el.className || '').toString().slice(0, 40),
          role: c.el.getAttribute?.('role') || '', rows: c.rows.length, mode: c.mode,
          area: c.area, score: Math.round(c.score),
          holdsIt: el ? c.el.contains(el) : false,
          insideIt: el ? el.contains(c.el) : false,
        })),
      };
    }
    case 'detect': {
      // Priming is opt-in even here: the panel's 2.5-second poll uses this action
      // and must leave the scrollbar alone.
      if (op.prime) {
        const y0 = window.scrollY || document.documentElement.scrollTop || 0;
        const walk = await walkDown(op.resume);
        const st0 = detect();
        st0.primed = walk.screens;
        st0.pressed = walk.pressed;
        window.scrollTo({ top: y0, behavior: 'instant' });
      }
      const st = detect();
      // A passive read leaves no trace. Outlining on every poll meant an amber
      // box blinking onto the page every 2.5 seconds, unasked.
      if (op.mark || op.reveal) paint(st.cands[0], !!op.reveal);
      return summary();
    }
    case 'cycle': {
      const st = window[S];
      if (!st?.cands?.length) return { error: 'NOT_DETECTED' };
      const d = op.dir === -1 ? -1 : 1;
      st.i = (st.i + d + st.cands.length) % st.cands.length;
      paint(st.cands[st.i], true);
      return summary();
    }
    case 'pick': {
      const st = window[S];
      if (!st?.cands?.length) return { error: 'NOT_DETECTED' };
      const at = Math.max(0, Math.min(st.cands.length - 1, op.index | 0));
      // PEEK SHOWS, IT DOES NOT CHOOSE. Hovering an entry in the panel's list has to outline that
      // list and scroll to it, and then leave nothing behind — a pointer crossing four entries on
      // its way to a button must not change what gets read, and a panel that closes mid-hover must
      // not leave the selection somewhere the person never landed.
      if (!op.peek) {
        st.i = at;
        // A person picking in the panel outranks an agent's pin. The pin exists to carry a
        // caller's intent past re-detection — not past the person watching the page.
        st.pin = null;
        st.pinHeld = false;
      }
      paint(st.cands[at], op.reveal !== false);
      return summary();
    }
    // THE BRIDGE NAMES THE CONTAINER. `pick` chooses among what the ranking kept, which is enough
    // for a person looking at five outlined candidates — and useless to a caller whose problem is
    // that the ranking keeps choosing the wrong pane. This takes a CSS selector, finds the
    // candidate it names (it, the list inside it, or the pane around it), and PINS the choice so
    // no re-detection during the run can undo it — see the pin block in `detect`. Nothing here is
    // site-specific: any page with two scrollable regions has this problem, and a selector is how
    // a caller says which region the person actually means.
    //
    // FAILURE IS LOUD ON PURPOSE. A selector that matches nothing, or matches an element with no
    // repeating rows anywhere inside it, returns an error carrying the selector — never a silent
    // fall-through to the auto-pick, because extracting the wrong pane while claiming to honour
    // the selector is precisely the bug this action exists to fix.
    case 'pin': {
      if (!op.selector) {
        // An empty selector is "back to the ranking". Each run states its whole intent, so a
        // selector passed for one run cannot silently steer the next.
        if (window[S]) { window[S].pin = null; window[S].pinHeld = false; }
        return { pinned: false };
      }
      // EVERY ELEMENT THE SELECTOR MATCHES GETS A TURN, NOT JUST THE FIRST.
      //
      // `querySelector` takes the first hit in document order, and a caller's selector — or one
      // this engine printed before `pathOf` learned to disambiguate — can match several. Taking
      // the first and reporting NO_ROWS says "there is no list here" about an element the caller
      // never meant. The rows are the tie-breaker: the match that actually holds a list is the one
      // that was meant. Capped, because each attempt is a full detect sweep.
      let all = [];
      try { all = [...document.querySelectorAll(op.selector)]; } catch (_) { all = []; }
      if (!all.length) return { error: 'NO_MATCH', selector: String(op.selector).slice(0, 200) };
      if (!window[S]) detect();
      // THE RICHEST MATCH WINS, NOT THE EARLIEST.
      //
      // Taking the first match that holds a list is only right when at most one does. Discord's
      // server rail is several sibling `div.stack_dbd263` sections — favourites, folders, the
      // servers themselves — so an ambiguous selector matches all of them and the first to clear
      // MIN_ROWS is a three-item folder strip, not the 23-server list the caller is looking at.
      // Measured: the pin reported held, `run_status` said done, and the table had ONE row.
      //
      // Row count is the tie-break because it is the only evidence the caller has given us: they
      // pointed at something that names several containers, so the one holding the most rows is
      // the one they meant. An exact, unambiguous selector never reaches this loop's second turn.
      let stN = null;
      let best = -1;
      let bestEl = null;
      for (const cand of all.slice(0, PIN_TRIES)) {
        // Resolution still lives in ONE place — the pin block in detect(); this only says which
        // element to offer it.
        window[S].pin = { selector: String(op.selector), el: cand };
        const got = detect();
        if (!got.pinHeld) continue;
        const n = got.cands[got.i]?.rows?.length || 0;
        if (n > best) { best = n; bestEl = cand; }
      }
      if (bestEl) {
        window[S].pin = { selector: String(op.selector), el: bestEl };
        stN = detect();
      }
      if (!stN || !stN.pinHeld) {
        if (stN) stN.pin = null;
        // Everything the caller needs to pick a different selector, without reading this file:
        // what the selector actually reached, why each one was refused, and what the page does
        // offer instead — with selectors that round-trip.
        return { error: 'NO_ROWS', selector: String(op.selector).slice(0, 200),
          matched: all.length,
          tried: all.slice(0, PIN_TRIES).map((el) => whyNoRows(el)),
          offers: (stN?.cands || []).map((c) => ({
            label: c.label || '', rows: c.rows.length, selector: pathOf(c.el),
          })) };
      }
      const cN = stN.cands[stN.i];
      return { pinned: true, index: stN.i, rows: cN.rows.length, label: cN.label || '',
        selector: pathOf(cN.el) };
    }
    // Read-only and cheap enough to poll four times a second: it reports what the
    // running scan has done so far, so the panel can show a live count instead of an
    // animation that says nothing.
    // The table as it stands RIGHT NOW, mid-hop, so it can be written to storage before
    // the hop is finished.
    //
    // Everything the in-page hop gathered used to be committed once, at the end. Sixteen
    // pages were read, the site then asked for verification, and the answer to that is to
    // go and clear it — which means leaving. Nothing had been saved yet, so leaving threw
    // away every page of it. The tab passes already commit per page (`hop.commit` in the
    // worker's log) for exactly this reason; the in-page hop was the one that hoarded.
    //
    // A read, never a write: it does not touch `window[S]`, does not recount, and does not
    // claim the page — so it is safe to call while `pageHop` is between pages.
    case 'commit': {
      const stc = window[S];
      const cc = stc?.cands?.[stc.i];
      if (!cc) return { error: 'NOT_DETECTED' };
      return { tables: [dedupeRows(extractOne(cc, stc.i))], url: location.href, partial: true };
    }
    case 'progress': {
      const st = window[S];
      const c = st?.cands?.[st.i];
      // Unique image URLs across every kept list, so the panel's asset counter can tick
      // in step with the rows instead of freezing at the walk's number while the row
      // pass grows the page underneath it.
      // What the user will actually get, counted the way extraction counts it: unique
      // product links. The DOM row count is not that — Tokopedia re-serves the same ~284
      // products until the DOM holds 2,000 of them, and reporting 2,000 promised rows
      // that the table would never contain.
      const uniq = uniqueCount(c);
      let imgs = 0;
      if (st?.cands?.length) {
        const seenSrc = new Set();
        for (const k of st.cands) {
          for (const im of k.el.querySelectorAll('img')) {
            const u = im.currentSrc || im.src;
            if (u && /^https?:/.test(u)) seenSrc.add(u);
          }
        }
        imgs = seenSrc.size;
      }
      return {
        imgs,
        uniq,
        dupes: c ? Math.max(0, c.rows.length - uniq) : 0,
        rows: c ? c.rows.length : 0,
        tables: st?.cands?.length || 0,
        presses: st?.pressed || 0,
        hops: st?.hops || 0,
        sawMore: st?.sawMore || null,
        // How a declared feed ended, if it did. The panel asks `progress` for what the
        // WALK saw — the scroll is back at the top by then — so this has to ride along
        // here or the sheet can never know the page said it was finished.
        endedBy: st?.endedBy || '',
        recycling: !!st?.recycling,
        hop: st?.hop || null,
        // Which record is being opened, while `details` runs. Same shape and same reason as
        // `hop`: the pass takes minutes and the sheet has to show something true.
        detail: st?.detail || null,
        // Whether opening each row is even offerable here — see the gate in `openEach`. The
        // panel asks rather than guessing, so the offer appears exactly where it can work.
        // A FEED DECLARATION, *OR* A PROVIDER WE READ BY FETCH — and the difference is what the
        // gate was always protecting.
        //
        // `role="feed"` gates CLICKING: "harmless where a page swaps content in place,
        // catastrophic where it does not — a product grid would navigate away and take the list,
        // the rows already gathered and the trip home with it, on row one." That hazard is real
        // and unchanged.
        //
        // 2GIS never clicks a row. Its records are read by fetching `/firm/<id>`, so the tab
        // cannot be navigated away and there is nothing for the feed rule to protect. It also
        // declares no `role="feed"` at all — measured, zero occurrences — so gating on the
        // declaration alone means the record pass can never be offered there, on a provider where
        // it is both safe and the entire point.
        canDetail: c?.mode === 'feed' || FETCH_READ.has(mapKind()),
        // AND WHETHER THERE IS A READER FOR IT, which is a different question and used to be
        // nobody's until the pass had already started.
        //
        // `canDetail` says the list has the right SHAPE — a declared feed. `openEach` then
        // applies a second gate: is this a map we have measured, field for field (`MAPPINGS`).
        // While the panel merely OFFERED the pass, the difference cost a button press and a
        // card saying "no reader for this map yet". Now that the panel chains straight into it,
        // the difference would be a shop's feed running a Google-shaped pass on its own, so the
        // panel needs the same gate the pass uses rather than a weaker one that agrees on Maps
        // and nowhere else.
        detailMap: mapKind(),
        // The panel used to keep its own `STEP_COUNT` and `PAGED` lists, which is how a provider
        // fact ended up in three files. It reads them from here now.
        detailTraits: traitsOf(mapKind()),
        canRead: MAPPINGS.includes(mapKind()),
        // How many rows already carry what their own page said, so a second pass can say
        // "the remaining N" instead of starting the count again.
        detailed: c ? detailsOf(c).size : 0,
        inflight: inFlight(),
        stopped: stopped(),
        // The asset engine's live counters, left on the page for exactly this. The two
        // engines cannot import each other, but they do share a window.
        scan: window.__holoscrapeScan || null,
        y: Math.round(window.scrollY || 0),
        vh: innerHeight,
        docH: document.documentElement.scrollHeight,
        // Where the page thinks it is. Asked of the PAGE rather than of chrome.tabs,
        // because a router that moves with pushState updates location synchronously and
        // the tabs record a moment later — and the panel compares these either side of a
        // press to find out whether the control it just tried was a pager.
        href: location.href,
      };
    }
    // Forget what a hop gathered, so a heavier pass can read the same pages over the top of
    // it rather than beside it.
    //
    // The case: a pass brings every row and none of their pictures, so the ladder escalates.
    // Without this the second reading APPENDS — the pictureless copy of a row and the good
    // copy differ in exactly the cell that matters, so `dedupeRows` correctly keeps both, and
    // a list of thirty comes out as fifty with half of them blank. Dropping first means the
    // second pass replaces the first pass's answer, which is what escalating meant all along.
    //
    // `next` and `pages` go too: the point is to read those pages again, and a resume marker
    // pointing past them would skip the very ones being re-read.
    case 'drophopped': {
      const stD = window[S];
      const cD = stD?.cands?.[stD.i];
      const bagD = cD?.el ? hopFor(cD.el, false) : null;
      if (!bagD) return { dropped: 0 };
      const had = bagD.rows.length + (bagD.foreign?.length || 0);
      bagD.rows = [];
      bagD.foreign = [];
      bagD.bases = new Map();
      bagD.next = null;
      bagD.pages = 0;
      return { dropped: had };
    }
    // Follow the numbered pages. Nothing is navigated to and nothing is re-detected:
    // see pageHop.
    case 'nextpage': {
      if (!window[S]?.cands?.length) detect();
      const n = findNextPage(op.nextSelector);
      if (n) {
        return { href: n.href, label: n.label, page: n.page, from: n.from,
          pointed: !!n.pointed,
          // HOW it was found, when it was found by what it is called. `name-only` tells the caller
          // that no page number backed it, which is the case the walk's own "held nothing new"
          // check exists to catch.
          ...(n.byName ? { byName: true, confidence: n.confidence } : {}) };
      }
      // NO BARE NEGATIVE. "none" used to be the whole reply, and an agent holding it had one move:
      // believe it. Measured on books.toscrape.com: `{none:true}` over a link reading "next".
      // Every negative below now says what was measured (`saw`), what nearly qualified and why it
      // did not (`nearMisses`, five at most), and the exact argument that overrules the judgment
      // (`override`) — the four-part rule in research/IMPROVEMENT-STRATEGY.md, Stream 1.
      // `saw` holds only what was COUNTED. `findPagerButtons` answers null without a tally, so
      // the numbered-button pager is not in it — a zero there would be a claim, not a measurement.
      const verdict = (why = '') => {
        const v = pagerSurvey || { saw: {}, nearMisses: [], target: '', lastPage: false };
        const said = why || (v.lastPage ? 'the next-page control is disabled — this is the last page' : '');
        return { none: true, ...(said ? { why: said } : {}),
          saw: { ...v.saw },
          nearMisses: v.nearMisses,
          override: `list_extract {next: ${v.target ? JSON.stringify(v.target)
            : '"<css selector or href of the next-page control>"'}}` };
      };
      // A CONTROL THE DESCRIPTOR NAMED OUTRANKS EVERY GUESS BELOW. Gmail's pager is two icon
      // buttons with no address, no number and no text — nothing `findPagerButtons` can see — and
      // the page it stands on is written nowhere but the "101–150 of 8,614" counter. Both are
      // declared, so both are read rather than hunted for. Disabled is the last page; absent is
      // a page that has not painted its pager, which is not the same as a list that ended.
      const dn = declaredNext();
      if (dn) {
        // `declared` ON THE NEGATIVE TOO. The walk synthesises "press page N+1" for a click
        // provider whenever `nextpage` names no control — right when the pager is a sliding window
        // the detector cannot read, wrong when the DESCRIPTOR'S OWN control has just said no.
        // Measured on the Gmail fixture: page three's "Older" arrow was `aria-disabled`, this
        // answered "disabled — this is the last page", and the walk pressed "page 4" anyway and
        // ended on "page 4 is not in the pager" — a guess, on a site that had declared its end.
        if (!dn.el) return { ...verdict('the site\'s next-page control is not on this page'), declared: true };
        if (dn.dead) return { ...verdict('the next-page control is disabled — this is the last page'), declared: true };
        const from = counterPage()?.page || 1;
        return { click: dn.sel, page: from + 1, from, label: dn.label || 'next page', href: '',
          declared: true };
      }
      // LINKS FIRST, ALWAYS — a real href is fetchable, and a fetch costs one GET where a click
      // costs a whole render. So the button pager is asked only once there is no link to find, and
      // it answers with a control to PRESS rather than a URL to fetch.
      //
      // This is the case that used to end here in `{ none: true }`, which on blibli meant a
      // 36,501-product search stopping at 25 rows with `1 2 3 4 5 … 20` on screen: every one of
      // those is a `<button>` with no href, so there was never a link to find.
      const btn = findPagerButtons();
      if (btn) {
        return { click: pathOf(btn.el), page: btn.page, from: btn.from,
          label: `page ${btn.page}`, href: '', pager: btn.count };
      }
      return verdict();
    }
    // `list_extract {next}`: THE CALLER SAYING "THAT ONE". A CSS selector or an href, resolved here
    // against the live page into what the walk already knows how to use — a pointed link
    // (`findNextPage(sel)`) or a pointed control to press (`clicknext`). Tried as a selector
    // first: an href is almost never a valid selector (`/`, `?` and `.html` do not parse), and
    // one that happens to parse matches nothing, so the order costs nothing and needs no flag.
    //
    // An href is turned into the SELECTOR of the link that carries it, because an address names
    // page two only and a walk needs the control on every page. The path is written with
    // descendant spaces rather than `>`: `resolve()` trims a `>` chain from the front until
    // something matches, which on the last page — where the control is gone — ends at a bare `a`
    // and sends the tab to whatever link is last in the document.
    case 'pointnext': {
      const want = String(op.next || '').trim();
      if (!want) return { error: 'NO_MATCH' };
      const shape = (el, via) => {
        const raw = el.getAttribute('href');
        let href = '';
        if (raw && !/^(javascript:|#|mailto:)/i.test(raw.trim())) { try { href = new URL(raw, location.href).href; } catch (_) {} }
        return { via, href, label: pagerName(el).slice(0, 60), kind: href ? 'link' : 'control' };
      };
      let hits = [];
      try { hits = [...document.querySelectorAll(want)].filter((n) => n.getClientRects().length); } catch (_) { hits = []; }
      // The LAST visible match, as `resolve()` and `clicknext` both take it: a pager's controls run
      // [previous, next].
      if (hits.length) {
        // Same rewrite as the href form below, and for the same reason: a caller's `ul > li > a`
        // must mean that control or nothing, never "the last link on the page" once it is gone.
        const last = hits[hits.length - 1];
        let exact = want.replace(/\s*>\s*/g, ' ');
        try {
          const again = [...document.querySelectorAll(exact)].filter((n) => n.getClientRects().length);
          if (again[again.length - 1] !== last) exact = want;
        } catch (_) { exact = want; }
        return { selector: exact, matched: hits.length, ...shape(last, 'selector') };
      }
      let u = null;
      if (/^(https?:\/\/|\/|\.{1,2}\/|\?)/i.test(want) || /[/?=]|\.html?$/i.test(want)) { try { u = new URL(want, location.href); } catch (_) { u = null; } }
      if (!u) return { error: 'NO_MATCH' };
      if (u.origin !== location.origin) return { error: 'OTHER_ORIGIN' };
      const plain = (h) => h.replace(/#.*$/, '');
      const link = [...document.querySelectorAll('a[href]')].reverse()
        .find((a) => a.getClientRects().length && plain(a.href) === plain(u.href));
      if (!link) return { selector: '', href: u.href, via: 'href', kind: 'address', label: '' };
      let sel = pathOf(link).replace(/>/g, ' ');
      try { const again = document.querySelectorAll(sel); if (again[again.length - 1] !== link) sel = pathOf(link); } catch (_) { sel = pathOf(link); }
      return { selector: sel, ...shape(link, 'href') };
    }
    // IS THERE A LOAD-MORE SITTING ON THIS PAGE? Asked by the walk as it ends, so a finished run
    // can say `growable` instead of reporting 6 of 117 as the whole list. Measured 2026-09-22 on
    // webscraper.io's `/more/` catalogue: `<a class="btn … ecomerce-items-scroll-more">More</a>`,
    // 831px wide, directly under the grid — and `findLoadMore` is right not to press it: its whole
    // name is "More", which is in neither word list, and widening a PRESSING rule to a bare "more"
    // would press every "More ▾" menu on the web.
    //
    // REPORTING is a different act from pressing, so it gets a wider net and the same floor:
    //   1. whatever `findLoadMore` finds (if it is still here, eight hops of pressing did not
    //      exhaust it, which is worth saying too);
    //   2. failing that, a control with NO ADDRESS sitting just under the list, in its column,
    //      whose whole name is a "more" word or whose class says so. Position is the measurement
    //      `study` already uses for its growth candidates; the name keeps "Add to cart" out.
    // A map that has said how its list grows is not asked, exactly as in `findLoadMore`.
    case 'growable': {
      if (!window[S]?.cands?.length) detect();
      const stG = window[S];
      const cG = stG?.cands?.[stG.i];
      if (!cG?.el) return { none: true };
      const growsG = traitsOf(mapKind()).grows;
      if (growsG && growsG !== 'press') return { none: true, why: `this site's list grows by ${growsG}` };
      const lm = findLoadMore(cG.el);
      if (lm?.el) return { selector: pathOf(lm.el), label: String(lm.label || '').slice(0, 40), via: 'findLoadMore' };
      const box = cG.el.getBoundingClientRect();
      const MORE_WHOLE = /^(\+|more|more \+|\+ more|lainnya|lagi|más|mais|mehr|plus|altro|meer|ещё|еще|もっと|更多|더보기)$/i;
      for (const el of document.querySelectorAll('button, [role="button"], input[type="button"], a')) {
        if (cG.el.contains(el)) continue;
        const raw = el.getAttribute('href');
        if (raw && !/^(#|javascript:)/i.test(raw.trim())) continue;       // a real address is a navigation, not a load-more
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        const r = el.getBoundingClientRect();
        if (r.width < CONTROL_MIN_W || r.height < CONTROL_MIN_H) continue;
        if (r.top < box.bottom - r.height || r.top > box.bottom + Math.max(BELOW_LIST_MIN_PX, box.height * BELOW_LIST_FRAC)) continue;
        if (r.right < box.left || r.left > box.right) continue;
        const name = pagerName(el);
        if (!name || name.length > 40 || MORE_NEVER.test(name)) continue;
        const attrs = `${el.className?.toString?.() || ''} ${el.getAttribute('data-testid') || ''} ${el.id || ''}`;
        if (!MORE_WHOLE.test(name) && !MORE_STRONG.test(name) && !MORE_WEAK.test(name)
            && !/(^|[-_\s])more([-_\s]|$)/i.test(attrs)) continue;
        return { selector: pathOf(el), label: name.slice(0, 40), via: 'position' };
      }
      return { none: true };
    }
    // PRESS THE PAGER INSTEAD OF NAVIGATING TO IT — and on some sites this is the whole ballgame.
    //
    // 2GIS answers `/search/<q>/page/6` with a 302 back to page one. Measured on five different
    // exit IPs, identically, so it reads exactly like a hard sixty-record ceiling. It is not: the
    // guard is on the URL, and the in-app router is not bound by it. Clicking the pager's own
    // anchor reached page 20 and 236 records with no sign of stopping, and the offered page
    // numbers SLIDE from page 7 onward (`[2..7]` becomes `[6,8,9,10]`) — which is why a fetch,
    // which only ever sees pages 1-5, cannot even discover that pages beyond 7 exist.
    //
    // `interlark/parser-2gis` (365 stars) reaches the same conclusion in its own words: "starting
    // from page 6 and further 2GIS redirects user to the beginning automatically (anti-bot
    // protection)", and it clicks for exactly this reason.
    //
    // The click has to land on the anchor for the page we WANT, not on a chevron: 2GIS's next
    // arrow is a `<div>` with no href and no disabled state — it is still present, undimmed, on
    // the last page, so following it is how you walk off the end without noticing.
    // Which map this is, straight from the engine that already decides it. The worker needs it to
    // know whether the pager must be pressed, and asking the page beats parsing the URL — the same
    // reason `stamp()` checks `isConnected` rather than comparing hrefs.
    // EVERYTHING THE PAGE OFFERS, RANKED, WITH THE EVIDENCE — instead of one verdict.
    //
    // Every extraction failure worth the name in the 1000-site audit had one shape: the engine must
    // pick ONE winner, and it picked furniture. Apple's search page yielded its FOOTER SITE DIRECTORY
    // (5 rows, inside `nav > role=navigation > footer > role=contentinfo`); Adobe's yielded its
    // sidebar FILTER LIST (184 rows, one column). Both scored highest on area x rows^2. Both are the
    // right answer to the question the scorer asks and the wrong answer to the question the person
    // asked.
    //
    // A caller with judgement does not need a winner. `detect` already ranks candidates and already
    // keeps sibling lists, so this hands all of them over together with the numbers that produced the
    // ranking, and the caller decides. Deliberately NOT a new detector: a rival list-finder grading
    // the real one is what manufactured three retracted findings during that audit.
    //
    // MEASURED and GUESSED stay visibly apart, because conflating them is the other thing that went
    // wrong repeatedly. Growth affordances are reported here as candidates marked `verified: false`;
    // pressing them and counting the rows before and after is `studypress`, and only that answer is
    // evidence. "This loads more" must never rest on a word that appeared on a button.
    case 'study': {
      const st = detect(true);
      const pageArea = Math.max(1, innerWidth * innerHeight);

      // HTML and ARIA landmarks — standards, not a vocabulary of what sites tend to call things. A
      // <footer> is definitionally not the main content, which is how Apple's misread is
      // recognisable without knowing anything about Apple.
      const landmarksOf = (el) => {
        const chain = [];
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          const t = n.tagName.toLowerCase();
          const role = (n.getAttribute && n.getAttribute('role')) || '';
          if (['footer', 'nav', 'aside', 'header', 'main', 'form'].includes(t)) chain.push(t);
          if (['navigation', 'complementary', 'contentinfo', 'banner', 'main', 'search'].includes(role)) {
            chain.push('role=' + role);
          }
        }
        return chain;
      };

      const FURNITURE = ['footer', 'role=contentinfo', 'nav', 'role=navigation', 'aside', 'role=complementary'];

      // THE LANDMARK THE ACCESSIBILITY TREE WOULD PUT THIS LIST IN — one computed role, the
      // nearest one, as HTML-AAM maps it and Blink exposes it — beside the raw chain above.
      //
      // The chain is every tag and role on the way up; this is the page's own declaration of
      // what region the list sits in, which is what a screen reader, and Playwright's aria
      // snapshot, would say. The two differ exactly where the standard says they should:
      //
      //   explicit role wins   `<nav role="list">` is a list, not navigation
      //   scoped header/footer `<header>`/`<footer>` are banner/contentinfo only when no article,
      //                        aside, main, nav or section encloses them — a card's footer, a
      //                        results section's header, are generic
      //   forms need a name    `<form>` is a landmark only with aria-label/aria-labelledby/title
      //   nearest wins         a `<nav>` inside `<main>` is navigation; the list in it is furniture
      //
      // Values: main, navigation, contentinfo, complementary, banner, form, none. `search` (the
      // `<search>` element, role=search) is reported as `form`: it is a named form by
      // construction and the seven-word vocabulary is what callers switch on. `region` is
      // content, so it is `none` here.
      //
      // USED ONLY BY `looksLikeFurniture`, never by the ranking. `scoreOf` keeps its four inputs
      // on purpose (test/static-list-is-not-the-list.mjs): three sites' worth of weights pushed
      // into it each broke the site before, and a landmark is evidence for the caller, not a
      // thumb on the scale. The flag WIDENS by exactly one shape — a list in a body-scoped
      // banner (a mega-menu) — and gives nothing up: the chain rule above still fires on a
      // nested `<footer>` the standard calls generic, because a footer that says footer is not
      // content whatever it is scoped to. test/study-landmark-is-evidence.mjs holds one fixture
      // per line of the table above.
      const SECTIONING = ['article', 'aside', 'main', 'nav', 'section'];
      const SECTIONING_ROLES = ['article', 'complementary', 'main', 'navigation', 'region'];
      const LANDMARK_ROLES = { main: 'main', navigation: 'navigation', contentinfo: 'contentinfo',
        complementary: 'complementary', banner: 'banner', form: 'form', search: 'form' };
      const hasName = (n) => !!((n.getAttribute('aria-label') || '').trim()
        || (n.getAttribute('aria-labelledby') || '').trim() || (n.getAttribute('title') || '').trim());
      const scopedToBody = (n) => {
        for (let a = n.parentElement; a && a !== document.body; a = a.parentElement) {
          if (SECTIONING.includes(a.tagName.toLowerCase())) return false;
          const r = ((a.getAttribute('role') || '').trim().split(/\s+/)[0] || '').toLowerCase();
          if (SECTIONING_ROLES.includes(r)) return false;
        }
        return true;
      };
      const landmarkOf = (el) => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          const role = ((n.getAttribute && n.getAttribute('role')) || '').trim().split(/\s+/)[0].toLowerCase();
          if (role) { if (LANDMARK_ROLES[role]) return LANDMARK_ROLES[role]; continue; }
          const t = n.tagName.toLowerCase();
          if (t === 'main') return 'main';
          if (t === 'nav') return 'navigation';
          if (t === 'aside') return 'complementary';
          if (t === 'search') return 'form';
          if (t === 'form' && hasName(n)) return 'form';
          if (t === 'header' && scopedToBody(n)) return 'banner';
          if (t === 'footer' && scopedToBody(n)) return 'contentinfo';
        }
        return 'none';
      };
      const FURNITURE_LANDMARKS = ['navigation', 'contentinfo', 'complementary', 'banner'];

      const lists = (st.cands || []).map((c, i) => {
        const rows = c.rows || [];
        const land = landmarksOf(c.el);
        const landmark = landmarkOf(c.el);
        return {
          rank: i + 1,
          chosen: i === st.i,
          selector: pathOf(c.el),
          label: c.label || '',
          rows: rows.length,
          columns: c.sig ? String(c.sig).split('|').length : 0,
          areaPercentOfViewport: Math.round((c.area / pageArea) * 100),
          score: Math.round(c.score),
          mode: c.mode || '',
          // How many DIFFERENT things these rows name. 54 rows that all resolve to `/s` are one
          // record listed 54 times, which is how a refinement panel wins a contest decided by rows^2.
          distinctness: Math.round(identSpread(rows) * 100) / 100,
          landmarks: land,
          landmark,
          // Reported, not applied, so a caller can disagree with it.
          looksLikeFurniture: land.some((x) => FURNITURE.includes(x)) || FURNITURE_LANDMARKS.includes(landmark),
          sample: rows.slice(0, 2).map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140)),
        };
      });

      // --- how this page continues --------------------------------------------------------------
      const dial = pageDial(location.href);
      const link = findNextPage(op.nextSelector);
      const buttons = findPagerButtons();
      const rel = document.querySelector('link[rel="next"], a[rel="next"]');
      const relHref = rel ? rel.getAttribute('href') : '';

      const pagination = {
        currentPage: dial ? dial.n : 1,
        dialCarriedIn: dial ? dial.at : '',
        relNext: relHref ? abs(relHref) : '',
        nextLink: (link && link.href)
          ? { url: link.href, label: link.label || '', page: link.page || 0 } : null,
        numberedPager: buttons
          ? {
            pages: buttons.count || 0,
            standingOn: buttons.from || 0,
            next: buttons.page || 0,
            follow: 'controls, not links — use clicknext',
          } : null,
      };

      // --- and how it grows, if it does ---------------------------------------------------------
      // Only 14% of the real search pages in the audit carried a pager at all. Scroll and press are
      // not the exception on the modern web, they are the common case — and `grows: 'scroll'` in the
      // provider table only knows the handful of sites somebody wrote down by hand.
      const growth = { linksNow: countRecordLinks(), candidates: [], probed: false };

      // Candidate controls found by POSITION — clickable things sitting just after the list — rather
      // than by matching words on them. Position is a measurement; "load more" is one phrase in one
      // language.
      const chosen = (st.cands && st.cands[st.i]) ? st.cands[st.i].el : null;
      if (chosen) {
        const box = chosen.getBoundingClientRect();
        const clickables = document.querySelectorAll(
          'button, a[role=button], [role=button], input[type=button], input[type=submit]');
        for (const el of clickables) {
          if (chosen.contains(el)) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          if (r.top < box.bottom - r.height) continue;
          if (r.top > box.bottom + Math.max(BELOW_LIST_MIN_PX, box.height * BELOW_LIST_FRAC)) continue;
          if (r.right < box.left || r.left > box.right) continue;
          growth.candidates.push({
            selector: pathOf(el),
            text: (el.innerText || el.value || el.getAttribute('aria-label') || '')
              .replace(/\s+/g, ' ').trim().slice(0, 60),
            belowListBy: Math.round(r.top - box.bottom),
            verified: false,
          });
          if (growth.candidates.length >= GROWTH_CANDIDATES) break;
        }
      }

      // AND THE HARDENED SWEEP, because the one above only knows things shaped like controls.
      // `findLoadMore` reads direct text, accepts div/span/li behind a cursor:pointer check and
      // presses the pointer's OWNER (see LOADMORE-NOT-A-BUTTON.md, measured on lazada). Study
      // never asked it, so study reported `candidates: []` over a plainly visible control and the
      // caller believed there was nothing to press. Measured 2026-08-18 on tokopedia: a real
      // <button>Muat Lebih Banyak</button> that the position sweep misses because it sits 195
      // controls deep, behind 185 card-overflow buttons, and the sweep stops at 5.
      //
      // Added as a SOURCE rather than by widening the selector list above: the position sweep's
      // guards (inside the list, off to one side, far below) are what keep it cheap and quiet, and
      // widening its tags would repeal them for every site at once.
      try {
        const lm = findLoadMore(chosen || document.body);
        const lmEl = lm && !lm.error ? lm.el : null;
        if (lmEl) {
          const sel = pathOf(lmEl);
          const already = growth.candidates.some((k) => k.selector === sel);
          if (!already) {
            growth.candidates.unshift({
              selector: sel,
              text: (lm.label || lmEl.innerText || lmEl.textContent || '')
                .replace(/\s+/g, ' ').trim().slice(0, 60),
              via: 'findLoadMore',
              verified: false,
            });
          }
        }
      } catch (_) { /* a study that cannot find a control still reports its lists */ }

      // DOES A DESCRIPTOR NAME THIS SITE'S FIELDS? The hint downstream needs to know. (History:
      // the hint once fired at ANY distinctness, `<= 1`, and this flag was added to silence it on
      // shopee.com.br; the comparison is fixed in bridge-ops.js now — 2026-09-23 — and the flag
      // only softens the wording at genuinely LOW distinctness.)
      const prov = PROVIDERS[mapKind()] || {};
      const namedFields = Object.keys(prov.fields || {});
      // IS THE LIST THIS SITE IS KNOWN FOR ACTUALLY HERE, AND IS IT THE ONE THAT WON?
      //
      // Two different facts, and a live run needed both. On a shopee.co.id category page the grid
      // had not painted, so `chosen` was `div.shopee-filter-panel` — eight rows of filter options,
      // `looksLikeFurniture: false` because a filter panel sits in no landmark. The hint then read
      // the descriptor, saw named fields, and told the caller to trust `list_extract`. It did, and
      // got eight rows of filter labels. The descriptor knew the answer the whole time: its `list`
      // selector matched nothing, which is the page saying "not yet" in the one vocabulary that
      // cannot be mistaken for a judgement call.
      let namedList = '';
      let namedListRows = 0;
      let chosenIsNamed = false;
      if (prov.list) {
        namedList = prov.list;
        try {
          const box = visibleMatch(prov.list) || document.querySelector(prov.list);
          namedListRows = box ? box.children.length : 0;
          const top = st.cands?.[st.i]?.el || null;
          chosenIsNamed = !!(box && top && (top === box || box.contains(top) || top.contains(box)));
        } catch (_) { namedListRows = 0; }
      }

      return {
        url: location.href,
        title: document.title.slice(0, 140),
        swept: st.swept,
        truncated: !!st.truncated,
        ...(mapKind() ? { site: mapKind() } : {}),
        ...(namedFields.length ? { siteNamesFields: namedFields } : {}),
        ...(namedList ? { namedList, namedListRows, chosenIsNamedList: chosenIsNamed } : {}),
        lists,
        pagination,
        growth,
        note: lists.length
          ? 'ranked by the engine own scoring; `chosen` is what a run would use. Check '
            + '`looksLikeFurniture` and `distinctness` before trusting `chosen` on a search page.'
          : 'no repeated structure found — the page may not have painted yet, or may be a wall',
      };
    }

    // PRESS IT AND COUNT, which is the only honest answer to "does this load more".
    //
    // Separate from `study` on purpose: this one CHANGES THE PAGE. A tool that quietly clicked things
    // while claiming to describe them would be the same category of error as an audit that reported
    // a number without saying it came from one visit.
    // ONE SCROLL, AND NOTHING READ. For feed mode, whose rows come out of the response the scroll
    // causes rather than out of the page. It exists so that path does not need a row selector — the
    // DOM is not the source there, and demanding a selector for it would put the reply-size ceiling
    // back into a design whose whole point is not having one.
    case 'scrollstep': {
      let pane = null;
      try { pane = op.selector ? document.querySelector(op.selector) : null; } catch (_) { pane = null; }
      if (op.selector && !pane) {
        return { error: 'NO_MATCH', selector: String(op.selector).slice(0, 200),
          tell: 'nothing matches that container — omit selector to scroll the window' };
      }
      // SAME REASON AS `collect`: a background tab runs no animation frames, so a lazy list never
      // fetches no matter how far the pane moves. Armed per step and LEFT armed — a feed walk is
      // many of these calls in a row, and disarming between them puts the tab back to sleep exactly
      // while the fetch it just triggered is in flight.
      const framesNow = keepFrames(true);
      const target = pane || document.scrollingElement || document.body;
      const before = target.scrollTop || window.scrollY || 0;
      const dy = String(op.direction || 'down').toLowerCase() === 'up' ? -SCROLLSTEP_PX : SCROLLSTEP_PX;
      try { target.scrollTop = Math.max(0, before + dy); } catch (_) { /* gesture still fires */ }
      if (!pane) { try { window.scrollBy(0, dy); } catch (_) { /* same */ } }
      gesture(pane, dy);
      await nap(Math.min(COLLECT_WAIT_MAX_MS, Math.max(COLLECT_WAIT_MIN_MS, Number(op.waitMs) || COLLECT_WAIT_MS)));
      const after = (pane ? pane.scrollTop : (window.scrollY || 0));
      // MOVED OR NOT is the honest report. A pane that will not move is the end of the list, and
      // saying so lets the caller stop for a reason instead of running out of hops.
      return { moved: after !== before, from: before, to: after, frames: framesNow,
        atEnd: pane ? (pane.scrollHeight - after - pane.clientHeight) < 4
          : (document.documentElement.scrollHeight - after - window.innerHeight) < 4 };
    }

    case 'studypress': {
      const before = countRecordLinks();
      let el = null;
      try { el = op.selector ? document.querySelector(op.selector) : null; } catch (_) { el = null; }
      // A SELECTOR THAT MATCHES NOTHING IS AN ANSWER, and "I scrolled the window instead" is the
      // wrong one. The scroll branch used to ignore the selector entirely, so a caller who named
      // a pane and mistyped it got the window scrolled with nothing to say so — grew:false then
      // read as "the list is finished" when the truth was "the wrong thing moved". Silently
      // substituting the target is the same bug class the pin exists for; fail by name instead.
      // A LOAD-MORE CONTROL CANNOT BE ADDRESSED BY SELECTOR TWICE.
      //
      // Frameworks that hash their class names re-render the button after every press, so the
      // selector page_study just handed you matches once and then matches nothing. Measured on a
      // storefront: press one grew the list 200 -> 260, press two returned NO_MATCH on the SAME
      // selector, and both a fresh session and this one read that as "the list ended".
      //
      // So a selector that stops matching is re-derived by MEANING rather than failing: findLoadMore
      // looks for the control by what it says and where it sits, in any language, with no names in
      // it. The reply says `refound` so a caller can see the selector went stale rather than
      // wondering why the one they passed was ignored — silently substituting a target is the bug
      // class the pin exists for, and this is not silent.
      let refound = '';
      if (op.selector && !el) {
        const alt = findLoadMore(document.body);
        if (alt && alt.el) {
          el = alt.el;
          refound = pathOf(alt.el);
        }
      }
      if (op.selector && !el) {
        return { error: 'NO_MATCH', selector: String(op.selector).slice(0, 200),
          tell: 'nothing matches that selector — press a page_study growth.candidates control, '
            + 'or scroll a page_study lists[].selector container with scroll:true' };
      }
      // CONTROL OR CONTAINER? A growth candidate from `study` is a button-shaped thing to press;
      // a lists[].selector is a pane to scroll. Told apart by what the element IS rather than by
      // which field it came from: pressable-looking gets pressed, and anything else that scrolls
      // — or that the caller marked with scroll:true — gets ITS scroller taken to the bottom
      // instead of the window's. That distinction is what makes a page with two scrollable
      // regions answerable at all: window.scrollTo on such a page moves the pane the caller did
      // NOT mean, and this engine's own walk already knows it — `scrollStep` drives
      // `scrollerFor(c.el)`, never the window, for exactly this reason.
      // AN APP'S CONTROLS ARE ARIA ROLES, NOT BUTTONS.
      //
      // The old list is the HTML a document is built from, and it misses the entire vocabulary a
      // web APP is built from. Measured on Discord: the server rail is 23 `role="treeitem"` divs
      // with no anchor anywhere in the nav — `a[href*="/channels/"]` matched NOTHING — so pressing
      // one to navigate was impossible, and because the item sits inside a scroller, the fallback
      // scrolled the rail instead and reported success. A caller trying to walk 23 servers got a
      // pane nudged 0 pixels, twice, with `verified: true` on both.
      //
      // These five roles are the activatable ones in ARIA: each is defined as something a user
      // invokes. Rows, cells, headings and landmarks are deliberately NOT here — they are
      // structure, and pressing structure is how a walk starts clicking on nothing.
      //
      // The sibling guard is intact and is the line below: `op.scroll` is checked FIRST in
      // `asContainer`, so a caller who says scroll:true still gets a scroll even on a pressable
      // element. Widening this can therefore only change the case where the caller expressed no
      // preference — and there, pressing a treeitem is what they meant.
      let pressable = false;
      try {
        pressable = !!(el && el.matches(
          'button, a, [role=button], [onclick], input[type=button], input[type=submit], summary,'
          + '[role=link], [role=menuitem], [role=tab], [role=option], [role=treeitem]'));
      } catch (_) { pressable = false; }
      // `scrollerFor` starts its probe AT the element, so a pane that scrolls itself is its own
      // answer and a row list handed in by selector resolves to the pane around it.
      const scroller = el ? scrollerFor(el) : null;
      const asContainer = !!el && (!!op.scroll || (!pressable && !!scroller));

      if (asContainer) {
        // ROWS INSIDE THE TARGETED CONTAINER, before and after — because the page-wide link count
        // says nothing about a list whose rows carry no links. A chat sidebar is divs all the way
        // down: countRecordLinks reads 0 before and 0 after forever, and reporting only that
        // calls a growing list finished. Counted by the same rowsOf/scoreOf reading extraction
        // uses, so "containerRows grew" means rows a run would actually get.
        const cB = candidateWithin(el);
        const rowsBefore = cB ? cB.rows.length : 0;
        const from = scroller ? scroller.scrollTop
          : (window.scrollY || document.documentElement.scrollTop || 0);
        // UP IS A DIRECTION TOO, and for a conversation it is the ONLY one that loads anything.
        //
        // Every list this engine grew until now grew downward, so "scroll" meant "go to the bottom".
        // A chat is the opposite: the newest message is already at the bottom and HISTORY is above,
        // fetched a page at a time as you climb. Asked for ten hops back through a channel, the tool
        // could only drive the scroller to the end it was already at and report `grew: false` — a
        // true statement about the wrong direction.
        //
        // HOPS, because one jump is not a history. Each hop goes to the far end, waits for the app to
        // fetch, and counts again; the loop stops early when two hops in a row bring nothing, so a
        // short channel costs two waits instead of ten.
        const up = String(op.direction || '').toLowerCase() === 'up';
        const hops = Math.max(1, Math.min(PRESS_HOPS_MAX, Number(op.hops) || 1));
        const waitMs = Math.min(PRESS_WAIT_MAX_MS, Math.max(PRESS_WAIT_MIN_MS, Number(op.waitMs) || PRESS_WAIT_MS));
        const rowsNow = () => { const c = candidateWithin(el); return c ? c.rows.length : 0; };
        // Counted the way EXTRACTION counts, via the one definition of row identity (`identOf`),
        // so "new" here means the same thing it will mean in the exported table.
        const uniqNow = () => { const c = candidateWithin(el); return c ? uniqueCount(c) : 0; };
        const perHop = [];
        let dry = 0;
        let loop = 0;

        let seenRows = rowsBefore;
        const uniqBefore = uniqNow();
        let seenUniq = uniqBefore;
        for (let i = 0; i < hops; i++) {
          const wasTop = scroller ? scroller.scrollTop : (window.scrollY || 0);
          const wasH = scroller ? scroller.scrollHeight : document.body.scrollHeight;
          // ALREADY AT THE EDGE MEANS NO EVENT, AND NO EVENT MEANS NO FETCH.
          //
          // An infinite list loads more because it HEARS a scroll. Assigning `scrollTop = 0` when
          // scrollTop is already 0 changes nothing, so the browser fires nothing, so the app fetches
          // nothing — and the hop loop reads that as "there is no more history". Measured on a
          // Discord channel with years of backlog: `from: 0, from: 0`, both hops dry, `stoppedEarly`,
          // and the honest-looking conclusion that a busy channel held ten messages.
          //
          // So when the target end is already the current position, step AWAY first and come back.
          // That is a real movement in both directions, which is a real event, which is the thing
          // the app is listening for. One step is enough — this is about generating the event, not
          // about where the pane ends up, and it ends up exactly where it would have anyway.
          const NUDGE = 120;
          if (scroller) {
            const atEdge = up ? scroller.scrollTop <= 1
              : scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1;
            if (atEdge) {
              scroller.scrollTop = up ? NUDGE : Math.max(0, scroller.scrollTop - NUDGE);
              // eslint-disable-next-line no-await-in-loop
              await new Promise((r) => setTimeout(r, NUDGE_SETTLE_MS));
            }
            scroller.scrollTop = up ? 0 : scroller.scrollHeight;
          } else {
            const y = window.scrollY || document.documentElement.scrollTop || 0;
            const atEdge = up ? y <= 1
              : y >= document.body.scrollHeight - window.innerHeight - 1;
            if (atEdge) {
              window.scrollTo(0, up ? NUDGE : Math.max(0, y - NUDGE));
              // eslint-disable-next-line no-await-in-loop
              await new Promise((r) => setTimeout(r, NUDGE_SETTLE_MS));
            }
            window.scrollTo(0, up ? 0 : document.body.scrollHeight);
          }
          await new Promise((r) => setTimeout(r, waitMs));
          const nowRows = rowsNow();
          const nowUniq = uniqNow();
          const nowH = scroller ? scroller.scrollHeight : document.body.scrollHeight;
          // Growing UPWARD shows as the scrollable area getting taller while the rows above you are
          // prepended — the row count alone can stay flat on a recycler, so height counts as growth.
          const added = nowRows - seenRows;
          const addedUnique = nowUniq - seenUniq;
          const taller = nowH - wasH;
          perHop.push({
            hop: i + 1, rows: nowRows, unique: nowUniq, added, addedUnique, heightGain: taller, from: wasTop,
          });
          seenRows = nowRows;
          seenUniq = nowUniq;
          // THREE OUTCOMES, NOT TWO. A hop that brings nothing is a pause; a hop that brings rows
          // we already hold is the list repeating itself; only a hop that brings a new identity is
          // growth. Collapsing the first two is what made a slow feed look finished and a looping
          // feed look infinite — opposite bugs from one counter.
          if (addedUnique > 0) { dry = 0; loop = 0; }
          else if (added > 0 || taller > 0) { dry = 0; if (++loop >= LOOP_TRIES) break; }
          else if (++dry >= GROW_DRY) break;
        }
        // DO NOT RETURN WHILE THE PANE IS STILL MOVING.
        //
        // The loop above stops asking for more; it does not wait for the last request it made to
        // land. A smooth-scrolling or momentum-driven pane keeps travelling after that, so the op
        // replied "done" and the page then moved AGAIN — and whatever the caller did next read a
        // page in a different place than the one it was told about.
        //
        // Measured: a harvest run straight after this op began at the LAST window of a 400-record
        // list instead of the first, because the test had reset the pane to the top in between and
        // a late scroll from this op put it back at the bottom. Reproducible only under load, which
        // is exactly the signature of something unawaited.
        //
        // So wait for the position to stop changing: two identical readings a frame apart, capped
        // so a pane that never settles cannot hold the reply open.
        {
          // 24, not 100. This is a SETTLE wait, not a step count: it runs once, after the hop
          // loop has already broken, and exits the moment two readings match. Raising it cannot
          // make anything scroll or hop more — it only lets a pane that never comes to rest
          // (momentum scrolling, a looping animation, an auto-advancing feed) hold the reply open
          // for that much longer, once per op. 12 was enough for every settle measured; 24 doubles
          // the headroom at 1.2s. 100 would have been 5s per op, which on a multi-hop walk is
          // minutes of nothing.
          const STILL_TRIES = 24;
          let last = -1;
          for (let i = 0; i < STILL_TRIES; i++) {
            const at = scroller ? scroller.scrollTop
              : (window.scrollY || document.documentElement.scrollTop || 0);
            if (at === last) break;
            last = at;
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, STILL_POLL_MS));
          }
        }
        const after = countRecordLinks();
        const cA = candidateWithin(el);
        const rowsAfter = cA ? cA.rows.length : 0;
        const uniqAfter = cA ? uniqueCount(cA) : 0;
        const to = scroller ? scroller.scrollTop
          : (window.scrollY || document.documentElement.scrollTop || 0);
        return {
          did: `scrolled ${scroller ? 'the container' : 'the page'} ${up ? 'UP toward older content' : 'to the bottom'}`
            + ` at ${String(op.selector).slice(0, 60)}`,
          direction: up ? 'up' : 'down',
          hopsAsked: hops,
          hopsRun: perHop.length,
          ...(perHop.length > 1 ? { perHop } : {}),
          ...(perHop.length < hops ? {
            stoppedEarly: loop >= LOOP_TRIES
              ? `${LOOP_TRIES} hops in a row brought rows the list already held — it is repeating itself`
              : `${GROW_DRY} hops in a row brought nothing new`,
          } : {}),
          // Looped or distinct, as a COUNT rather than an impression. `unique` is what the export
          // will actually contain; `duplicates` is what the DOM is holding twice. A page whose
          // duplicates climb while unique stays flat has ended, however tall it keeps getting.
          duplicates: {
            domRows: rowsAfter,
            unique: uniqAfter,
            duplicates: Math.max(0, rowsAfter - uniqAfter),
            loopingPct: rowsAfter ? Math.round(((rowsAfter - uniqAfter) / rowsAfter) * 100) : 0,
            uniqueGained: uniqAfter - uniqBefore,
          },
          recordLinksBefore: before,
          recordLinksAfter: after,
          containerRowsBefore: rowsBefore,
          containerRowsAfter: rowsAfter,
          // Either count moving is growth. A virtualizer that RECYCLES its rows can grow while
          // both stay flat, which is what `scrolled` is for: the pane provably moved, so "nothing
          // happened" and "the DOM window slid along a longer list" stay distinguishable.
          grew: after > before || rowsAfter > rowsBefore,
          by: after - before,
          byRows: rowsAfter - rowsBefore,
          scrolled: { from, to, max: scroller ? scroller.scrollHeight : document.body.scrollHeight },
          verified: true,
        };
      }
      if (op.scroll) {
        window.scrollTo(0, document.body.scrollHeight);
      } else if (el && (el.tagName === 'SELECT' || el.querySelector?.('select'))) {
        // A CLICK ON A <select> DOES NOTHING, AND REPORTING IT AS A PRESS IS A LIE BY OMISSION.
        //
        // Measured on a live Bazaarvoice widget: a session aimed page_grow at the sort select, got
        // back `did: "pressed …select.bv-dropdown-select", grew: false`, saw the dates unchanged, and
        // concluded the control was "aria-hidden decoration" and the real one lay elsewhere. It was
        // not decoration — `choose` re-sorts that exact element on that exact store. The reply had
        // everything needed to prevent that wrong turn and said none of it.
        //
        // So the engine, which can see the tag, names the verb that works and the options on offer.
        const box = el.tagName === 'SELECT' ? el : el.querySelector('select');
        return {
          error: 'IS_A_SELECT',
          selector: String(op.selector || '').slice(0, 120),
          options: [...(box.options || [])].slice(0, 14).map((o) => String(o.textContent || '').trim()),
          tell: 'that is a <select>, and a click does nothing to one — it needs a selection event. '
            + 'Use page_grow mode:"walk" with choose:"<the option\'s words>" (no selector needed; the '
            + 'select is found by its option). NOTE a sort default is almost never date order, so '
            + '"the latest N" read off the page as it loads is usually wrong.',
        };
      } else if (el) {
        el.scrollIntoView({ block: 'center' });
        el.click();
      } else {
        return { error: 'NO_TARGET',
          tell: 'pass a selector from study.growth.candidates, or scroll:true — or, if what you want '
            + 'is behind a dropdown rather than a button, page_grow mode:"walk" with '
            + 'choose:"<option words>"' };
      }
      await new Promise((r) => setTimeout(r, Math.min(PRESS_WAIT_MAX_MS, Math.max(PRESS_WAIT_MIN_MS, Number(op.waitMs) || PRESS_WAIT_MS))));
      const after = countRecordLinks();
      return {
        did: op.scroll ? 'scrolled to the bottom' : 'pressed ' + String(op.selector).slice(0, 60),
        ...(refound ? { refound } : {}),
        recordLinksBefore: before,
        recordLinksAfter: after,
        grew: after > before,
        by: after - before,
        // The number, not a verdict: a caller can tell 2 more from 40 more, and 0 is an answer.
        verified: true,
      };
    }
    case 'mapkind': return traitsOf(mapKind());
    // THE LAYER UNDER THE DOM — `page_state` over the bridge. No path is DISCOVERY (what state
    // this app has and the prefix to read each part with); a path is a READ of that path, walked
    // as data. Read-only in the strongest sense available: it changes nothing, claims nothing,
    // and saves nothing, so it is not in `runRows`'s `walks` list and never collides with a walk.
    case 'state': return op.path ? stateReadPath(op) : stateDiscover(op);
    case 'read': return readSelector(op);
    case 'explore': return explorePage(op);
    case 'html': return htmlOf(op);
    case 'walk': return walkSite(op);
    case 'fill': return fillField(op);
    case 'collect': return collectRows(op);
    case 'clicknext': {
      // PRESSING WHAT THE PERSON POINTED AT, which is the only thing that works on a pager built
      // in JavaScript. Everything below this block hunts for 2GIS's shapes — a `/page/<n>` anchor,
      // then a rotated-chevron arrow — and a site whose pager is plain buttons has neither. The
      // panel used to answer that with "that control has no address … pagers built entirely in
      // JavaScript cannot be followed this way", which was true when it was written and stopped
      // being true the moment clicking existed: a click needs no address at all.
      //
      // Taken FIRST, because a pointed control outranks every guess — the person can see the pager.
      if (op.selector) {
        let el = null;
        let via = 'exact';
        // The first VISIBLE match: a hidden exact match cannot be pressed and would only end the
        // walk with "nothing changed". See `visibleMatch`.
        try { el = visibleMatch(op.selector); } catch (_) { el = null; }
        // A POINTED SELECTOR DOES NOT SURVIVE A RE-RENDER, and on the sites that need clicking it
        // never will: `pathOf` builds a six-segment chain of classes and `nth-of-type` indices, and
        // turning a page in a single-page app rebuilds the pager with different indices — sometimes
        // different class hashes. Measured on blibli: the first press worked, the second found
        // nothing, and the walk stopped at "the control that was pointed at is no longer on the
        // page" after one page of twenty.
        //
        // So the selector is trimmed from the FRONT until something matches — the same thing
        // `harvest` does to re-attach a remembered container, for the same reason. The tail of the
        // chain describes the control itself; the head describes where it happened to be sitting.
        //
        // The LAST visible match wins, because a pager's controls run [previous, next] and the one
        // we want is the far end. Hidden matches are skipped: clicking one does nothing and looks
        // exactly like a list that ended.
        // A DOM PATH IS NOT AN IDENTITY, and on a pager it is barely a hint. `pathOf` describes
        // button 2 as `nav#pg>button.pn` — and button 1 carries `.pn` too, so `querySelector`
        // returns the CURRENT page, the click is a no-op, and the walk correctly reports that
        // nothing changed. Measured: `clicked=true`, fingerprint identical before and after.
        //
        // The page NUMBER is the real identity. It is unique in the pager, it is what the person
        // means, and unlike an nth-child index it survives the re-render that follows every press.
        if (op.page) {
          const want = String(op.page);
          const inPager = el ? (el.parentElement || document) : document;
          const byText = [...inPager.querySelectorAll('button,[role="button"],a,li')]
            .filter((n) => (n.innerText || n.textContent || '').trim() === want
              && n.getClientRects().length);
          if (byText.length) { el = byText[0]; via = 'number'; }
        }
        if (!el) {
          let cut = op.selector;
          while (cut.indexOf('>') >= 0) {
            cut = cut.slice(cut.indexOf('>') + 1);
            let hits = [];
            try { hits = [...document.querySelectorAll(cut)]; } catch (_) { hits = []; }
            hits = hits.filter((n) => n.getClientRects().length);
            if (hits.length) { el = hits[hits.length - 1]; via = `trimmed:${cut.slice(0, 40)}`; break; }
          }
        }
        // LAST RUNG: WHAT THE CONTROL IS CALLED.
        //
        // A path describes where a control was sitting; a name describes what it IS. Gmail rebuilds
        // its pager on every turn, so the path is gone after one press and the trimming above finds
        // nothing — measured, the panel answered "I lost track of that control" and the walk stopped
        // after one page. The button is still there and still called the same thing:
        // `[aria-label="Older"]`, which survives every rebuild because it is what the site tells a
        // screen reader.
        //
        // NAME-MATCHING IS ONLY SAFE HERE, AND THE DISTINCTION IS THE WHOLE POINT. The same match
        // was tried as DISCOVERY earlier today — hunting the page for a forward-paging verb on any
        // site — and it was reverted within the hour: it flipped `morePages` true on a page whose
        // list is destroyed by the press, the panel changed its whole flow, and a 50-row inbox read
        // as 3 and then 0. As a RE-MATCH it carries none of that risk. It runs only inside
        // `op.selector`, which means the person looked at their own screen, pointed at a pager and
        // asked for it to be pressed. Nothing here can reach detection, `morePages`, or any card.
        //
        // Direction is still checked, because "Newer" sits beside "Older" and pressing the wrong
        // one walks backwards forever without ever looking broken.
        if (!el) {
          const FWD = /^(next|next page|older|forward|berikutnya|selanjutnya|siguiente|suivant|weiter|avanti)$/i;
          const BACK = /^(prev|previous|newer|back|earlier|sebelumnya|anterior|zur(ü|ue)ck)$/i;
          let named = [];
          try {
            named = [...document.querySelectorAll('button, [role="button"], a, [role="link"]')];
          } catch (_) { named = []; }
          for (const n of named) {
            if (!n.getClientRects || !n.getClientRects().length) continue;
            if (n.disabled || n.getAttribute('aria-disabled') === 'true') continue;
            const nm = (n.getAttribute('aria-label') || n.getAttribute('title') || '').trim();
            if (!nm || BACK.test(nm) || !FWD.test(nm)) continue;
            el = n; via = `named:${nm.slice(0, 24)}`;
            break;
          }
        }
        if (!el) return { none: true, why: 'the control that was pointed at is no longer on the page' };
        // A pager disables its own control at the last page far more reliably than it removes it,
        // and pressing a dead button looks identical to a list that ended.
        const dead = el.getAttribute('aria-disabled') === 'true' || el.disabled
          || /(^|\s)(disabled|is-disabled)(\s|$)/.test(el.className?.toString() || '');
        if (dead) return { none: true, why: 'the next-page control is disabled — this is the last page' };
        const before = location.href;
        const mark = listMark();
        el.scrollIntoView({ block: 'nearest' });
        // WHERE IT IS, for the press the worker makes if this one is ignored. A closure/jsaction
        // control (Gmail's pager) gates its handler on `event.isTrusted`, and `el.click()` below
        // is not trusted; the worker can dispatch a real one at these coordinates — see
        // `pressForReal`. Taken AFTER scrollIntoView so the box is where the control now sits.
        // A BOX WITH NO AREA IS NOT A TARGET: a press dispatched at it lands on whatever sits
        // behind — measured on a fixture whose arrow was 0px wide, `elementFromPoint` answered the
        // toolbar. Reported as not on screen so the worker does not press blind.
        // A CONTROL WITH NO AREA IS GIVEN ONE, FOR THE LENGTH OF THE PRESS. An icon-only button
        // whose image never painted — blocked, offline, or `alt=""` on a broken `src` — renders
        // 0×0, and as a flex item its bar shrinks the button around it: measured on the Gmail
        // fixture, the "Older" control is 0px wide and 14px tall, the scripted click above still
        // reaches its handler (the handler is on the document and finds it by `closest`), yet no
        // coordinate hits it, so `onScreen` said no, the worker rightly refused to press blind,
        // and a 60-thread inbox ended on page one as "this looks like the last page".
        //
        // So a zero-area control is propped to a pressable size with inline `min-width`/
        // `min-height` (and `inline-block` only for an inline element, where min sizes do not
        // apply), re-measured, and the box below is taken from what is now there. The prop is
        // undone on the next press of any control, or by its own timer — a minute, well past the
        // worker's eight-second wait for the rows plus the press itself — so nothing is left on the
        // page. It is a temporary size, never a visibility change: a hidden control has no rect
        // at all and never reaches this line. If even the prop yields no area the box still says
        // `onScreen: false`, and the blind-press guard stands.
        //
        // UNDONE BEFORE THE MEASUREMENT, NOT AFTER. Measured on page two of the same fixture: the
        // rect was read while the previous press's prop still held (16×16), the prop was then
        // undone, the control collapsed back to 0px wide, nothing re-propped it because the rect
        // already looked healthy — and the real press went to a point the page's hit-test answered
        // with the bar behind it (`hits:false, under: div.ar5`). The rect has to describe the
        // element as it will be when pressed.
        const PROP = '__holoscrapeProp';
        try { window[PROP]?.undo?.(); } catch (_) {}
        window[PROP] = null;
        let bb = el.getClientRects()[0];
        if (bb && (bb.width <= 0 || bb.height <= 0)) {
          const prev = el.getAttribute('style');
          const undo = () => {
            if (window[PROP]?.t) clearTimeout(window[PROP].t);
            window[PROP] = null;
            if (prev == null) el.removeAttribute('style'); else el.setAttribute('style', prev);
          };
          el.style.setProperty('min-width', PROP_MIN_PX, 'important');
          el.style.setProperty('min-height', PROP_MIN_PX, 'important');
          if (getComputedStyle(el).display === 'inline') el.style.setProperty('display', 'inline-block', 'important');
          window[PROP] = { undo, t: setTimeout(undo, PROP_TTL_MS) };
          bb = el.getClientRects()[0];
        }
        const box = bb ? { x: Math.round(bb.left + bb.width / 2), y: Math.round(bb.top + bb.height / 2),
          w: Math.round(bb.width), h: Math.round(bb.height),
          onScreen: bb.width > 0 && bb.height > 0
            && bb.top >= 0 && bb.left >= 0 && bb.bottom <= innerHeight && bb.right <= innerWidth }
          : null;
        // WHAT THE PAGE'S OWN HIT-TEST ANSWERS AT THAT POINT, so the worker's log can say where a
        // real press would land — a box can be on screen and still be covered by something else.
        if (box) {
          const under = document.elementFromPoint(box.x, box.y);
          box.hits = !!under && (under === el || el.contains(under));
          if (!box.hits && under) box.under = `${under.tagName.toLowerCase()}${under.className ? '.' + String(under.className).trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
        }
        el.click();
        return { clicked: true, before, mark, viaPointed: true, via, box };
      }
      const want = +op.page || 0;
      if (!want) return { none: true, why: 'no page asked for' };
      let el = null;
      for (const a of document.querySelectorAll('a[href]')) {
        const m = /\/page\/(\d+)/.exec(a.getAttribute('href') || '');
        if (m && +m[1] === want) { el = a; break; }
      }
      // NO NUMBERED LINK? PRESS THE ARROW. This was the user's first instinct and I argued against
      // it from the markup — correctly for deriving a URL (the chevron is a `<div>` with no href
      // and no disabled state) and WRONGLY for clicking, which is all we need here.
      //
      // 2GIS's pager is a sliding window with an ellipsis — `1 … 11 [12] 13 14 15 ‹ ›` — and the
      // number we want is not always one of the rendered anchors. When it is missing, the walk
      // reported "nothing on this page looked like a link to a next one" and stopped on a list
      // that was still going.
      //
      // The arrow is found by SHAPE, not by class: 2GIS's build-hash class names change, but the
      // control is the last clickable thing in the pager row carrying a rotated chevron. Taking
      // the LAST one matters — the pair is [previous, next].
      if (!el) {
        const near = document.querySelectorAll('a[href*="/page/"]');
        const bar = near.length ? near[near.length - 1].closest('div')?.parentElement : null;
        const arrows = [...(bar || document).querySelectorAll('div,button,a')]
          .filter((n) => n.querySelector && n.querySelector('svg[style*="rotate(-90deg)"]'));
        const arrow = arrows[arrows.length - 1];
        if (arrow) {
          const before = location.pathname;
          arrow.scrollIntoView({ block: 'nearest' });
          arrow.click();
          return { clicked: true, page: want, before, viaArrow: true, mark: listMark() };
        }
      }
      // LAST RESORT: A CONTROL WHOSE ONLY SIGNAL IS ITS OWN TEXT. Not a number, not 2GIS's
      // chevron — a plain "Next" or "»" with nothing else to go on. This is the one tier in the
      // whole file that presses something without a strong structural reason to trust it first,
      // so it stays narrow on purpose rather than growing the way the other tiers did:
      //
      //   - a CLOSED vocabulary, not a substring match. "next section", "next article" and
      //     "continue to next step" are real copy on real pages that are not pagination, and
      //     `.includes('next')` would press all three. The text must equal one of these exactly,
      //     not merely contain it.
      //   - SCOPED to the list itself, not the whole document. A carousel's own next-slide arrow,
      //     a breadcrumb's trailing `»`, or an unrelated "More like this" rail can carry this
      //     exact text elsewhere on the same page — scoping to the detected list's own container
      //     (or its immediate sibling row, where a pager conventionally sits) is what tells THIS
      //     next apart from every other one.
      //   - still verified the same way as every other click in this file: the caller polls the
      //     list's fingerprint after pressing, and a press that changed nothing is read as the
      //     list having ended, never as success.
      if (!el) {
        if (!window[S]?.cands?.length) detect();
        const container = window[S]?.cands?.[window[S].i]?.el;
        const scope = container?.parentElement;
        if (scope) {
          // ENGLISH IS NOT THE ONLY WORD FOR "NEXT". A closed list stays closed by staying a
          // list, not by staying English — 15 languages, one or two exact phrases each, covering
          // the languages that account for most real site content. Not exhaustive (no finite
          // list is), and deliberately not solved by translating or classifying at runtime: that
          // trades this tier's whole safety property (same cost, same determinism as every other
          // tier in this file) for the exact tradeoff Thunderbit accepts by calling an AI backend
          // per page. The pointed-selector path above stays the true universal fallback under
          // all of this — any language, any word, once someone can see the control and say
          // "that one." toLowerCase() is a safe no-op on CJK/Arabic text with no case to fold.
          const TEXT = new Set([
            'next', 'next page', '>', '»', '›', 'next »', 'next ›',           // English
            'siguiente', 'página siguiente',                                   // Spanish
            'suivant', 'page suivante',                                        // French
            'weiter', 'nächste', 'nächste seite',                              // German
            'próximo', 'próxima', 'próxima página',                            // Portuguese
            'successivo', 'successiva', 'pagina successiva',                   // Italian
            'berikutnya', 'selanjutnya',                                       // Indonesian
            '次へ',                                                             // Japanese
            '다음', '다음 페이지',                                                // Korean
            '下一页', '下一个', '下一頁',                                          // Chinese (simplified + traditional)
            'далее', 'следующая', 'следующая страница',                        // Russian
            'التالي',                                                          // Arabic
            'sonraki', 'sonraki sayfa',                                        // Turkish
            'volgende', 'volgende pagina',                                     // Dutch
            'następny', 'następna strona',                                     // Polish
            'tiếp theo', 'trang tiếp theo',                                    // Vietnamese
          ]);
          const cands = [...scope.querySelectorAll('button,[role="button"],a')]
            .filter((n) => scope.contains(n) && n.getClientRects().length);
          for (let i = cands.length - 1; i >= 0; i--) {
            const n = cands[i];
            const dead = n.getAttribute('aria-disabled') === 'true' || n.disabled
              || /(^|\s)(disabled|is-disabled)(\s|$)/.test(n.className?.toString() || '');
            if (dead) continue;
            const t = (n.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const label = (n.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!TEXT.has(t) && !TEXT.has(label)) continue;
            el = n;
            break;
          }
        }
        if (el) {
          const before = location.pathname;
          const mark = listMark();
          el.scrollIntoView({ block: 'nearest' });
          el.click();
          return { clicked: true, page: want, before, mark, viaText: true };
        }
      }
      // Neither a number, an arrow, nor a labelled text control is the END OF THE LIST, and it is
      // the only end signal this path has. The pager stops offering all three when there is
      // nothing further.
      if (!el) return { none: true, why: `page ${want} is not in the pager` };
      const before = location.pathname;
      const mark = listMark();
      el.scrollIntoView({ block: 'nearest' });
      el.click();
      return { clicked: true, page: want, before, mark };
    }
    // Where the in-app router actually put us, asked after a click has had time to land. A bounce
    // back to page one is 2GIS's anti-bot answering, and it must not be read as "the list ended".
    case 'atpage': {
      // WHERE THE PAGE NUMBER LIVES IS NOT ALWAYS THE PATH. This read `/page/<n>` from the
      // pathname only — 2GIS's shape — so on a site that pages by query string it answered 1 for
      // every page of the run. Measured on blibli: a press moved the tab to
      // `?page=2&start=40&sort=0&firstLoad=false` and this still reported page 1, so the walk had
      // the proof it needed in the address bar and could not read it.
      let n = 0;
      const m = /\/page\/(\d+)/.exec(location.pathname);
      if (m) n = +m[1];
      else {
        try {
          for (const [k, v] of new URL(location.href).searchParams) {
            if (/^(page|pagi|pg|p)$/i.test(k) && /^\d{1,6}$/.test(v)) { n = +v; break; }
          }
        } catch (_) {}
      }
      // AND WHERE THE ADDRESS SAYS NOTHING, THE PAGE'S OWN COUNTER. Gmail's url is `#inbox` on
      // every page; "101–150 of 8,614" is the only statement of where it stands. See `counterPage`.
      const counter = n ? null : counterPage();
      if (counter) n = counter.page;
      // AND A FINGERPRINT OF THE LIST, because the address bar moves first.
      //
      // The router commits the URL and re-renders the rows afterwards, and the gap between them is
      // real: waiting on the page number alone returned while page one's cards were still on
      // screen, so the walk extracted them a second time, saw nothing new, and stopped — "page 2
      // held nothing new" on a list of 7,684. This is the same trap the record reader hit, where
      // waiting for `location.href` to name a place returned the PREVIOUS place's panel.
      //
      // The first few record ids are enough: they change wholesale between pages.
      // `href`, not `path`: a query-string pager never touches the pathname, so comparing paths
      // says "nothing moved" about a tab that has plainly moved.
      return { page: n || 1, path: location.pathname, href: location.href, mark: listMark(),
        ...(counter ? { counter: counter.text } : {}) };
    }
    // What the worker needs to hop through real tabs: which container this page's list
    // is, and where the next page is. Asked as one call so the worker makes one trip.
    // Asked of a page loaded in a tab, where the worker cannot see the document itself.
    case 'challenge': {
      const st2 = window[S];
      const c2 = st2?.cands?.[st2.i];
      const text = (document.body?.innerText || '').slice(0, CHALLENGE_TEXT_CHARS);
      const hit = text.match(FLAGGED_WORDS) || text.match(CHALLENGE_WORDS);
      const kind = challenged(document, !!c2?.rows?.length, !!op.stale);
      return {
        challenge: kind,
        // 'puzzle' is solvable on the page; 'flagged' is the session being refused, and the
        // two want different words from the panel and a different next move.
        kind: kind || '',
        // WHICH signal, not just the verdict. Two false positives were spent guessing.
        word: hit ? hit[0].slice(0, 40) : '',
        marker: document.querySelector(CHALLENGE_SEL)?.className?.toString().slice(0, 40) || '',
        chars: text.replace(/\s+/g, ' ').trim().length,
        // WHAT THE PAGE SAID, when nothing matched. `word` names the signal that fired; on a page
        // where none did it is blank, and a blank tells you only that the list missed — not what
        // to add. eBay's interstitial was diagnosed as "194 characters, and no idea which 194".
        // Short, and only ever read off a page that already has no list on it.
        sample: text.replace(/\s+/g, ' ').trim().slice(0, 160),
        // WHERE it came from, which is what named eBay's page when nothing it said could.
        byUrl: CHALLENGE_URL.test(location.href),
        at: location.href.slice(0, 120),
        rows: c2?.rows?.length || 0,
      };
    }
    case 'container': {
      // DETECTION AFTER A PAGE TURN MUST RUN AGAINST A PAINTED PAGE.
      //
      // `!cands.length` was the whole condition, so the first poll after a navigation detected
      // against whatever existed at that instant — and every later poll reused it. Measured on
      // shopee.co.id, where the filters and the sort bar paint before the products: the walk
      // settled on `Urutkan` (3 rows) and on the location filter (9 rows), and read those. They
      // were the honest answer at that moment; they were the biggest repeating list on the page.
      //
      // Reproduced in `test/lateglist.mjs`, which is that page — a nine-row filter list and a
      // three-row sort bar in the initial HTML, the grid a second behind. `waited on: 3 → Urutkan`.
      //
      // So the wait asks for a re-detect on every poll. The order was inverted: it detected, then
      // waited on what it had detected. Now it waits, re-detecting, and the choice that survives is
      // the one made when the page had finished painting.
      if (op.fresh || !window[S]?.cands?.length) detect(!!op.fresh);
      const st0 = window[S];
      const c0 = st0?.cands?.[st0.i];
      // RECOUNTED, because this is what the page-turn wait polls.
      //
      // `c0.rows` is the array captured when the page was DETECTED, and returning its length
      // reports the list as it was at that instant for as long as the document lives. The walk's
      // wait after a page turn polls this asking "has the list arrived yet" — against a number
      // that cannot move. `extractAll` already recounts for exactly this reason ("a page does not
      // hold still"); this reader did not, so on a framework that mounts its cards after `complete`
      // it answered 9 on the first poll and 9 on every poll after it.
      if (c0) recount(c0);
      const n0 = findNextPage(op.nextSelector);
      // AND WHOSE LIST IT IS. `rows > 0` is true of the PREVIOUS page's list too — an in-app
      // router leaves it mounted until the new one is ready — so a count alone cannot tell "the
      // new page has arrived" from "the old page has not left". The first row's record link says
      // which, and costs one querySelector.
      const sig0 = (c) => {
        const r = c?.rows?.[0];
        if (!r) return '';
        try {
          const a = r.querySelector?.('a[href]');
          if (a) { const u = new URL(a.href, location.href); return u.origin + u.pathname; }
        } catch (_) {}
        return (r.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      };
      // STABILITY IS NOT CORRECTNESS, AND THAT IS THE WHOLE TRAP HERE.
      //
      // The wait above settles when two polls agree. That works when the wrong answer is
      // TRANSIENT — a sort bar that is replaced once the grid paints, which is the case the
      // comment at the top of this action and `test/lateglist.mjs` were written for.
      //
      // It cannot work when the wrong answer is STATIC. Measured on shopee.com.br: the footer's
      // recommendation strip renders immediately and never changes, so two polls agree inside a
      // second, the wait breaks, and the walk reads 36 rows of footer. Page two reads the same
      // footer, reports "0 new", and the walk stops — which is why a five-page category ended
      // after two pages with 36 rows. Indonesia paged fine only because its grid happened to win
      // the race; nothing about the pager differs between the two, and both say `pages: 5`.
      //
      // The descriptor already knows which list this is. So when it names one and that list is
      // not on the page, say NOT READY rather than handing back a stable, confident, wrong count.
      // The caller's wait loop treats rows:0 as "keep polling" and is already bounded by
      // HERE_LIST_MS, so the worst case is that it waits out its own budget and then reads
      // whatever is there — the behaviour it had before, minus the early lock-on.
      return c0
        ? { selector: pathOf(c0.el), rows: c0.rows.length, next: n0?.href || null,
            label: n0?.label || '', first: sig0(c0) }
        : { error: 'NOT_DETECTED' };
    }
    // Where the load-more is, in viewport coordinates — for a caller that intends to press
    // it from OUTSIDE the page.
    //
    // `el.click()` produces an event with `isTrusted: false`, and that flag is immutable,
    // unforgeable and read by every behavioural bot detector there is: a click no human
    // made is the clearest single statement a page can get. It is the right trade in the
    // user's own tab — they asked for it and they are watching — but the driven pass is
    // already attached to the debugger, and from there a press can be dispatched as real
    // input, which is what it actually is.
    case 'morebox': {
      if (!window[S]?.cands?.length) detect();
      const st2 = window[S];
      const c2 = st2?.cands?.[st2.i];
      if (!c2) return { error: 'NOT_DETECTED' };
      const more = findLoadMore(c2.el);
      if (!more) return { none: true };
      const b = more.el.getClientRects()[0];
      if (!b) return { none: true };
      // Only when it is genuinely on screen. Input events land at viewport coordinates, so
      // dispatching at a box that is off-screen presses whatever happens to be there.
      const on = b.top >= 0 && b.left >= 0 && b.bottom <= innerHeight && b.right <= innerWidth;
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
        w: Math.round(b.width), h: Math.round(b.height),
        onScreen: on, label: more.label };
    }
    // THE SAME ESCALATION, FOR `page_walk`'s NAMED CONTROL rather than a load-more. Resolves the
    // control the same way `walkSite` does (selector, or `text` by accessible name) and reports its
    // box — WITHOUT pressing it. Called only after a `walk` row comes back `changed: false`, so an
    // untrusted click is always tried first and this, and the debugger attach it implies, is paid
    // only on the sites that actually need it.
    case 'walkbox': {
      const sel = String(op.selector || '');
      const words = String(op.text || '');
      const read = String(op.read || '');
      const all = resolveWalkTargets(sel, words);
      if (all === null) return { error: 'BAD_SELECTOR' };
      const i = Math.max(0, Number(op.index) || 0);
      const el = all[i];
      if (!el) return { error: 'GONE', total: all.length };
      const named = readOne(el);
      const b = el.getClientRects()[0];
      if (!b) return { error: 'OFFSCREEN', total: all.length, label: (named.label || named.text || '').slice(0, 200) };
      const on = b.top >= 0 && b.left >= 0 && b.bottom <= innerHeight && b.right <= innerWidth;
      // Captured NOW, one call before the real press happens, so `walkAfter` has something honest
      // to compare against — the whole point of a two-step escalation is that the press itself
      // happens outside this call, via CDP.
      let readBefore = null;
      if (read) {
        try { readBefore = JSON.stringify([...document.querySelectorAll(read)].slice(0, 60).map(readOne)); }
        catch (_) { readBefore = null; }
      }
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
        onScreen: on, total: all.length, label: (named.label || named.text || '').slice(0, 200),
        readBefore };
    }
    // THE READ-AND-COME-BACK HALF OF `walkSite`, without the click — for a caller who just
    // pressed the control itself, for real, from outside the page (see `walkbox` above). Kept as
    // its own action rather than a flag on `walk` because the press and the read happen on
    // opposite sides of a CDP call the page cannot make for itself.
    case 'walkAfter': {
      const was = String(op.was || location.href);
      const read = String(op.read || '');
      const waitMs = Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, Number(op.waitMs) || WALK_WAIT_MS));
      const row = { url: location.href, title: document.title, moved: location.href !== was };
      if (read) {
        let hits = [];
        try { hits = [...document.querySelectorAll(read)]; } catch (_) { hits = []; }
        row.read = hits.slice(0, 60).map(readOne);
        row.readCount = hits.length;
      }
      const readAfter = read ? JSON.stringify(row.read) : null;
      // Same rule as `walkSite`'s own `row.changed` — see the note there. This action only ever
      // runs for a row `read` already proved unchanged, so it stays true to that same comparison
      // rather than inventing a second, weaker one out here.
      row.changed = row.moved || (read ? String(op.readBefore || '') !== readAfter : true);
      if (op.back !== false && row.changed) {
        if (location.href !== was) {
          try { history.back(); } catch (_) { /* reported below */ }
        } else {
          try {
            document.activeElement?.blur?.();
            document.dispatchEvent(new KeyboardEvent('keydown',
              { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
          } catch (_) { /* same */ }
        }
        await new Promise((r) => setTimeout(r, Math.min(BACK_WAIT_MAX_MS, Math.max(BACK_WAIT_MIN_MS, waitMs / 2))));
        row.returned = location.href === was;
      }
      return row;
    }
    // Rows read in another tab arrive as plain cells, not elements, so they cannot join
    // `c.extra` — that store holds live nodes. They are appended to the table on its way
    // out instead, which is the only place their shape matters.
    case 'pagerows': {
      const st1 = window[S];
      const c1 = st1?.cands?.[st1.i];
      if (!c1) return { error: 'NOT_DETECTED' };
      const bag1 = hopFor(c1.el, true);
      bag1.foreign.push(...(op.rows || []));
      const t1 = dedupeRows(extractOne(c1, st1.i));
      // The tab passes commit through here, one page at a time, so this is where they learn
      // whether the pages they are reading bring their pictures — without a second round
      // trip and without knowing anything about how a row is built.
      return { tables: [t1], url: location.href, added: (op.rows || []).length,
        pics: assetTally(c1) };
    }
    case 'pagehop': {
      if (window[S]) window[S].live = true;
      const out = await pageHop(op).finally(() => { if (window[S]) window[S].live = false; });
      if (out.error) return out;
      const c2 = window[S].cands[window[S].i];
      const t = dedupeRows(extractOne(c2, window[S].i));
      return { ...out, tables: [t], url: location.href, pics: assetTally(c2) };
    }
    // Open every row and read the page behind it.
    //
    // `live` for the whole pass, and this one needs it more than any other caller: opening a
    // record changes the URL's PATH, and `stamp()` reads a changed path as a different page
    // and deletes the state — which here would be the whole list, mid-pass, on the first
    // poll that landed. See the re-stamp at the end of `openEach`.
    case 'details': {
      if (!window[S]?.cands?.length) detect();
      if (window[S]) window[S].live = true;
      let out;
      try {
        out = await openEach(op);
      } finally { if (window[S]) window[S].live = false; }
      if (out.error) return out;
      // EVERY table, not just the one that was opened. `saveResult` unions items and
      // REPLACES tables, so handing back one table deletes the page's other lists from the
      // record — the same trap `hopHere` documents and works around. `extractAll` already
      // reads them all and does no walking of its own, so this is one call rather than a
      // second copy of that loop.
      return { ...out, ...extractAll() };
    }
    // --- the driven pass: one bounded piece of work each, no waiting in the page -----------
    // See `detailGate` and the paragraph above it. `live` is held while these run for the same
    // reason the in-page loop holds it: `stamp()` must not throw the state away between calls,
    // and there are now a couple of thousand calls in a pass instead of one.
    case 'dgate': {
      if (!window[S]?.cands?.length) detect();
      if (window[S]) window[S].live = true;
      const g = detailGate();
      // Only once the gate has said yes: a page we are not going to click is a page whose
      // scheduling we have no business touching.
      if (!g.error) g.frames = keepFrames(true);
      return g;
    }
    // EVERY RECORD'S OWN URL, so the worker can read them somewhere other than here.
    //
    // The sequential pass clicks row i and waits for the panel to mount beside the list. That costs
    // 4.8s a record — measured, 123 records in 9m51s — and most of it is waiting. Every row already
    // carries the link to its own page, so the same records can be read in their own tabs, several
    // at a time. This hands over the work list; `dput` takes the answers back.
    //
    // Bound to the same list and keyed the same way (`identOf`) as `dclick`, so a detail read in a
    // tab lands under the identity the table will look for. Rows that are not records are reported
    // rather than skipped silently — a suggestion card is a fact about the list, not an error.
    case 'dlinks': {
      const it = bagOf();
      if (!it) return { error: 'NOT_DETECTED' };
      if (!it.c.el || !it.c.el.isConnected) return { error: 'LIST_GONE' };
      recount(it.c);
      // The questions this path DOES need answered — deliberately not the window width, which is
      // `dgate`'s business and none of this one's. A map we have no reader for must refuse here
      // rather than hand back "the longest link in each row", which on an unknown layout is as
      // likely to be a search as a record.
      const map = mapKind();
      if (!MAPPINGS.includes(map)) return { error: 'NO_MAPPING', map, rows: it.c.rows.length };
      const want = RECORD_HREF[map] || null;
      if (!want) return { error: 'NO_MAPPING', map, rows: it.c.rows.length };
      const out = [];
      let skipped = 0;
      let already = 0;
      for (let i = 0; i < it.c.rows.length; i++) {
        const r = it.c.rows[i];
        if (!r || !document.contains(r)) continue;
        const key = identOf(r);
        if (it.bag.details.has(key)) { already++; continue; }
        const link = recordLinkOf(r, want);
        if (!link) { skipped++; continue; }
        const href = link.getAttribute('href') || '';
        // Absolute, because the worker will open it in a tab of its own.
        let abs = href;
        try { abs = new URL(href, location.href).href; } catch (_) {}
        // The NAME this row claims, so whoever reads it elsewhere can prove the page it is looking
        // at is this record and not the one the tab showed a moment ago. Without something to check
        // against, a lane reads its previous record's panel 124 times over.
        const name = (link.getAttribute('aria-label') || '').trim();
        out.push({ i, key, href: abs, name });
      }
      // Seeded here so the sheet has a total to count against from the first tick, rather than
      // showing "0 / 0" until the first record lands.
      it.st.detail = { at: 0, of: out.length, opened: 0, filled: 0 };
      return { rows: it.c.rows.length, links: out, skipped, already, map };
    }
    // EVERY ROW'S OWN WEBSITE — the work list for the third step, built the same way `dlinks`
    // builds the second one's.
    //
    // Grouped BY HOST, and that is the whole design of this list. Two branches of one chain share
    // one website, and a list of plumbers routinely holds three rows pointing at the same domain.
    // Visiting it three times is three times the pages loaded for one answer — and it is also
    // three times the requests at somebody's small business site, which is the part that matters.
    // So each entry carries every row key that shares that host, and one read fills all of them.
    //
    // A row whose email has already been read is skipped, exactly as `dlinks` skips a record
    // already opened: pressing again continues rather than starting over.
    case 'slinks': {
      const it = bagOf();
      if (!it) return { error: 'NOT_DETECTED' };
      if (!it.c.el || !it.c.el.isConnected) return { error: 'LIST_GONE' };
      recount(it.c);
      const byHost = new Map();
      let none = 0;
      let already = 0;
      for (let i = 0; i < it.c.rows.length; i++) {
        const r = it.c.rows[i];
        if (!r || !document.contains(r)) continue;
        const key = identOf(r);
        // `null` is "never asked"; an EMPTY string is "asked, and the site lists no address" —
        // see the note by `sput`. Both are answers, and neither is worth a second visit.
        const had = it.bag.details.get(key);
        if (had && had['@Email'] != null) { already++; continue; }
        // THE ROW IS NOT THE ONLY PLACE A WEBSITE LIVES, and this step was only looking there.
        //
        // `siteLinkOf` reads the LIST CARD's outbound anchor. `@Website` is read from the RECORD'S
        // PANEL, where Maps puts the Website button — a different source, and the one that
        // actually has it on most records. Measured on `toko besi in cimahi`, 90 rows: the export
        // carried ten real websites — megabajacimahi.com, rkm.co.id, langgengbaja.com,
        // bajasaktiutama.com — and this loop found none of them, so the pass ended after step two
        // and never offered to read a single site.
        //
        // `had` is the record's detail, already fetched on the line above to check `@Email`. It
        // had the answer the whole time.
        // THE PANEL'S ANSWER IS CHECKED TOO, and it was not. `siteLinkOf` refuses a Google host and
        // an ad redirect; `@Website` — read from the record's own panel — went through untested, so
        // a sponsored row's `google.com/aclk?…` became the URL the third step fetched. That wastes a
        // request and files whatever the ad leads to under this business's name.
        const panelSite = (u) => {
          if (!/^https?:/i.test(u) || AD_REDIRECT.test(u)) return '';
          let h = '';
          try { h = new URL(u).host.replace(/^www\./, '').toLowerCase(); } catch (_) { return ''; }
          // The map's own domains are the map, not a website — the same rule `siteLinkOf` applies
          // to the card's anchor, applied to the panel's.
          if (/(^|\.)google(\.[a-z]{2,3})+$/i.test(h) || /(^|\.)goo\.gl$/i.test(h)) return '';
          return u;
        };
        const url = siteLinkOf(r) || panelSite((had && had['@Website']) || '');
        if (!url) { none++; continue; }
        let host = '';
        try { host = new URL(url).host.replace(/^www\./, '').toLowerCase(); } catch (_) { none++; continue; }
        const at = byHost.get(host);
        if (at) { if (!at.keys.includes(key)) at.keys.push(key); continue; }
        const link = recordLinkOf(r, null);
        byHost.set(host, { i, host, url, keys: [key],
          name: (link?.getAttribute('aria-label') || '').trim() });
      }
      const links = [...byHost.values()];
      // Seeded so the sheet counts against a real total from its first tick, as `dlinks` does.
      it.st.detail = { at: 0, of: links.length, opened: 0, filled: 0 };
      return { rows: it.c.rows.length, links, none, already,
        places: links.reduce((n, l) => n + l.keys.length, 0) };
    }
    // A detail read ELSEWHERE, filed here. Same store `dread` writes to, so `extractAll` and
    // `dtables` merge it into the table without knowing where it came from.
    // MANY RECORDS, ONE INJECTION. See `dput` for what this stores and why.
    //
    // `runRows` serialises this entire engine for every call, so filing one record at a time cost 124
    // engine parses on the LIST tab — the one tab all five lanes have to queue behind. Batching turns
    // that into about fifteen. The live figures no longer ride along here; they are written by a
    // two-line injection instead (see `laneTick`), so progress stays per-record while the expensive
    // part happens in batches.
    case 'dputMany': {
      const it = bagOf();
      if (!it) return { error: 'NOT_DETECTED' };
      let got = 0;
      let added = 0;
      for (const one of (op.items || [])) {
        if (!one || !one.key || !one.got || !Object.keys(one.got).length) continue;
        // MERGED WHEN THE CALLER SAYS SO, and this flag is the difference between a third step
        // that adds a column and one that destroys two passes of work. The site pass files an
        // address onto a record the DETAILS pass already read; a plain `set` there would replace
        // the full address, the hours, the coordinates and the reviews with an email and nothing
        // else. The second step still replaces, because a re-read of a record is the newer truth
        // about it — see `dput`.
        if (op.merge) {
          const had = it.bag.details.get(one.key);
          it.bag.details.set(one.key, had ? { ...had, ...one.got } : one.got);
        } else {
          it.bag.details.set(one.key, one.got);
        }
        got++;
      }
      // APPENDED INTO THE COLUMN THAT ALREADY HOLDS THAT KIND OF FACT, rather than beside it.
      //
      // A phone number found on a business's own site is a phone number; a second column called
      // "Site phone" that repeats the one Maps gave on most rows is not new information, it is the
      // same information twice with a wider table. So the site pass appends, and the dedupe happens
      // HERE — in the page, where the value it has to compare against actually lives. Doing it in
      // the worker would mean shipping every existing value out and back on each batch.
      for (const one of (op.items || [])) {
        if (!one || !one.key || !one.add) continue;
        const had = it.bag.details.get(one.key);
        if (!had) continue;   // nothing to append to; the details pass has not read this row
        const next = { ...had };
        for (const [field, values] of Object.entries(one.add)) {
          if (!Array.isArray(values) || !values.length) continue;
          const cap = ADD_CAP[field] || 4;
          const keyOf = ADD_KEY[field] || ((v) => String(v).trim().toLowerCase());
          const parts = String(next[field] ?? '').split(ADD_JOIN)
            .map((s) => s.trim()).filter(Boolean);
          const seen = new Set(parts.map((p) => keyOf(unmark(p))));
          for (const v of values) {
            const s = String(v ?? '').trim();
            if (!s || parts.length >= cap) continue;
            const k = keyOf(s);
            if (!k || seen.has(k)) continue;
            seen.add(k);
            // MARKED, so a merged cell can still be read: the first value is the one Maps gave and
            // stays untouched, and only what the site added carries the note. `unmark` above strips
            // it before keying, or a second pass would append the same value again.
            parts.push(s + ADD_MARK);
            added++;
          }
          if (parts.length) next[field] = parts.join(ADD_JOIN);
        }
        it.bag.details.set(one.key, next);
      }
      // Same reason as in `dput`: say this is still the page these candidates describe, or `stamp()`
      // throws the state away on the next call.
      it.st.href = here();
      return { got, added, asked: (op.items || []).length, done: it.bag.details.size };
    }
    case 'dput': {
      const it = bagOf();
      if (!it) return { error: 'NOT_DETECTED' };
      // LIVE FIGURES, because the sheet reads them off THIS PAGE.
      //
      // `progress` hands the panel `st.detail`, and the sequential pass fills it in `detailClick`
      // as it goes. The lanes click nothing here — they work in the worker and in tabs of their own
      // — so nothing wrote it, and the half-card sat at "0 opened, 0 with details" for the whole
      // run while the table filled up behind it. Reported as "0 row added on the halfcard".
      //
      // Updated even when a record yielded nothing: a pass that stalls on record 40 should show 40,
      // not the last number that happened to succeed.
      if (op.at != null) {
        // `lost` is carried rather than inferred. The sheet used to derive it as opened-minus-filled,
        // which is the IN-FLIGHT count, not a failure count — with five lanes that is permanently
        // about four, and it was drawn on screen as "4 had no page to read" for the whole run while
        // the log said lost=0.
        it.st.detail = { at: op.at, of: op.of || 0, opened: op.opened || 0,
          filled: op.filled || 0, lost: op.lost || 0, lanes: op.lanes || 0 };
      }
      if (!op.key || !op.got || !Object.keys(op.got).length) return { got: false };
      it.bag.details.set(op.key, op.got);
      // The list's own URL may have moved under us; say this is still the page these candidates
      // describe, exactly as `dread` does, or `stamp()` throws the state away on the next call.
      it.st.href = here();
      return { got: true, fields: Object.keys(op.got).length, done: it.bag.details.size };
    }
    case 'dclick': return detailClick(op);
    // READ A RECORD ON ITS OWN PAGE, with no list in sight.
    //
    // `dread` files what it reads into the detected list's store, so it needs a list; a record
    // opened in its own tab has none. This is the same `readDetail` — the same handles, the same
    // `@`-prefixed names, the same coordinate rule — returning the fields instead of filing them.
    // Deliberately the same function and not a copy: a second reader would drift from this one
    // within a week, and then two passes over one list would disagree about what a record says.
    //
    // `href` still comes from the ROW'S link rather than this tab's URL, for the reason spelled out
    // in `readDetail`: the panel updates before the address bar, so reading the location here can
    // yield the previous record's coordinates.
    // ONE RECORD, ONE INJECTION. This is the whole cost of the tab pass.
    //
    // `runRows` serialises this entire engine — 231KB — and injects it on EVERY call. The first
    // version of the lane pass called `dsolo` to poll for arrival, then `dstep` every 140ms for up
    // to twelve seconds, then `dweb` up to twenty times: about 120 injections a record, some 28MB
    // of script parsed to read one place. Measured at ~11s a record, and none of it was waiting on
    // Google — it was waiting on us.
    //
    // So the whole record happens inside one call: prove the page is the right record, walk the
    // panel, wait for the website block, read. The waits use `nap`, which the keeper knows about,
    // so a hidden tab is no worse off than it was.
    case 'dgrab': {
      // This tab has just loaded one record's own page — nothing kept from a previous call in this
      // tab belongs to it. See `sipTake`.
      sipReset();
      const t0 = performance.now();
      const since = () => Math.round(performance.now() - t0);
      const capArrive = op.arrive > 0 ? op.arrive : LANE_ARRIVE_MS;
      const capWalk = op.walk > 0 ? op.walk : LANE_WALK_MS;
      // `>= 0`, NOT `> 0`. Zero is a REQUEST — do not wait for the web-results frame — and with
      // `> 0` it fell through to the 1500ms default instead, so setting `LANE_WEB_MS = 0` quietly
      // did nothing. Only an absent value should take the fallback.
      const capWeb = op.web >= 0 ? op.web : LANE_WEB_MS;

      // Arrival, then the walk and the web block together, then the read. All three now live beside
      // `detailStep` so `dwarm` can use exactly the same rules — see `awaitRecord` and `walkWeb`.
      const came = await awaitRecord(op, capArrive, since);
      if (!came.ok) return came;
      const { web, steps } = await walkWeb(capWalk, capWeb);
      const got = readDetail(op.href || '', web);
      return { ready: !!(got && Object.keys(got).length), got: got || null,
        fields: got ? Object.keys(got).length : 0, name: panelName(),
        web: !!web, steps, ms: since() };
    }
    // THE SAME RECORD, REACHED BY CLICKING IT IN AN APP THAT IS ALREADY RUNNING.
    //
    // `dgrab` navigates a tab to `/maps/place/…`, which means a whole Maps boot per record. Measured on
    // one live run of 124: that cost 3.4s at best, 8.8s median and 31.7s at worst, it degraded steadily
    // through the run, it drew a reCAPTCHA after about a hundred, and it returned the web-results block
    // on 3 records out of 98 because the panel was still mounting when the walk gave up.
    //
    // The same run's fallback pass, which CLICKS rows inside the already-loaded list, read its records
    // in 268-1312ms and got web results on 22 of 24. A click fetches over XHR and loads no document at
    // all, so it is both faster and quieter. This is that, in a lane tab: load the list once, then click.
    //
    // BY PLACE TOKEN, NEVER BY ROW POSITION. Each lane loads the search itself, and the same query has
    // been measured returning 112 places on one run and 62 an hour later — so row 40 in one tab is not
    // row 40 in another. The token (`!19s<ChIJ…>`) is the record's own identity and travels with it.
    case 'dwarm': {
      const t0 = performance.now();
      const since = () => Math.round(performance.now() - t0);
      const capArrive = op.arrive > 0 ? op.arrive : LANE_ARRIVE_MS;
      const capWalk = op.walk > 0 ? op.walk : LANE_WALK_MS;
      // `>= 0`, NOT `> 0`. Zero is a REQUEST — do not wait for the web-results frame — and with
      // `> 0` it fell through to the 1500ms default instead, so setting `LANE_WEB_MS = 0` quietly
      // did nothing. Only an absent value should take the fallback.
      const capWeb = op.web >= 0 ? op.web : LANE_WEB_MS;
      const capHunt = op.hunt > 0 ? op.hunt : LANE_HUNT_MS;
      if (!op.token) return { ready: false, noRow: true, why: 'no place token to look for' };
      const it = bagOf();
      if (!it) return { ready: false, noList: true, why: 'NOT_DETECTED' };
      if (!it.c.el || !it.c.el.isConnected) return { ready: false, noList: true, why: 'LIST_GONE' };

      // 1. FIND THE ROW, SCROLLING THE RAIL UNTIL IT MOUNTS. The feed is virtualised: a row far down
      //    the list is not in the document until the scroller has been near it. This is the one cost a
      //    warm lane pays that a navigating one does not, and it is paid once per record at most —
      //    the rail keeps what it has mounted, so later records in the same tab are usually already
      //    there.
      const hunt = () => {
        recount(it.c);
        for (const r of it.c.rows) {
          if (!r || !document.contains(r)) continue;
          const a = recordLinkOf(r, RECORD_HREF[mapKind()] || null);
          const h = a && (a.getAttribute('href') || '');
          if (h && h.indexOf(op.token) >= 0) return { row: r, link: a };
        }
        return null;
      };
      let found = hunt();
      if (!found) {
        // The rail's own scroller, by the same probe the walk uses — `null` means the document
        // scrolls, and on a Maps rail it never does.
        const sc = scrollerFor(it.c.el) || it.c.el;
        let last = -1;
        while (!found && since() < capHunt) {
          try { sc.scrollTop = sc.scrollTop + sc.clientHeight; } catch (_) { break; }
          if (sc.scrollTop === last) break;         // the rail will not go further
          last = sc.scrollTop;
          await nap(HUNT_STEP_MS);
          found = hunt();
        }
      }
      // NOT AN ERROR, A DIFFERENT ANSWER. This lane's copy of the search simply does not hold this
      // place, so the caller navigates to it instead rather than losing the record.
      if (!found) return { ready: false, noRow: true, ms: since(), why: 'this rail has no such row' };

      // 2. CLICK IT, remembering which panel was showing so arrival can prove the app moved on.
      const wasMark = panelMark();
      // AND THE ACCUMULATOR STARTS EMPTY. A warm lane reads record after record in ONE tab without
      // reloading, which makes this the one place where stale kept values could actually follow a
      // record onto the next one. See `sipTake`.
      sipReset();
      // WHY THE CLICK DID NOTHING — asked of the page, not guessed at from out here.
      //
      // A warm lane's click lands and the URL never moves: `why='the tab never reached this record'`
      // on fourteen records of one run, which is `!urlOk` — the app's router never ran. The rail pass
      // makes the IDENTICAL call (`link.click()`, `openRow`) on an active tab and routes in under a
      // second, so the only variable is that this tab has never been looked at.
      //
      // Two candidates, and no way to tell them apart from the outside: the click never reaches a
      // handler, or the handler runs and the routing it schedules never does. These four numbers
      // separate them, and every one is free:
      //
      //   saw        a capture listener on `document` — did the event traverse the DOM at all
      //   prevented  did something call preventDefault, which is what an SPA router does to an <a>
      //   pushes     `history.pushState` calls after the click — the router's actual output
      //   ticks      native animation frames delivered in the same window
      //
      // saw+prevented+pushes and no URL is impossible. saw+prevented and no pushes means the handler
      // ran and its work was scheduled onto something that never fired — read `ticks` next to it.
      // No `saw` at all means the event never dispatched and none of the rest matters.
      //
      // Everything here is removed in the `finally`, including on the paths that return early: this
      // is a probe, and a probe that outlives its measurement is a leak in the page under test.
      const probe = op.probe ? { saw: 0, prevented: 0, pushes: 0, ticks: 0 } : null;
      let undo = null;
      if (probe) {
        const onClick = (e) => { probe.saw++; setTimeout(() => { if (e.defaultPrevented) probe.prevented++; }, 0); };
        document.addEventListener('click', onClick, true);
        const push0 = history.pushState;
        history.pushState = function (...a) { probe.pushes++; return push0.apply(this, a); };
        // The NATIVE frame callback, taken before raf.js can hand back its backstop: the question is
        // whether the browser is drawing this tab, not whether our own keeper is covering for it.
        let live = true;
        const tick = () => { if (!live) return; probe.ticks++; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
        undo = () => {
          live = false;
          document.removeEventListener('click', onClick, true);
          history.pushState = push0;
        };
      }
      try {
      try { found.link.click(); } catch (_) {
        return { ready: false, noRow: true, ms: since(), why: 'the row would not take a click' };
      }
      const came = await awaitRecord({ ...op, wasMark }, capArrive, since);
      if (!came.ok) return { ...came, probe: probe ? { ...probe, hidden: trueHidden(),
        backstopped: window[RAF]?.backstopped || 0, on: !!window[RAF]?.on } : undefined };
      const { web, steps } = await walkWeb(capWalk, capWeb);
      // `href` comes from the ROW'S link, not this tab's URL — see the note in `readDetail`: the panel
      // updates before the address bar, so reading the location here can yield the previous record.
      const href = found.link.getAttribute('href') || op.href || '';
      let abs = href;
      try { abs = new URL(href, location.href).href; } catch (_) {}
      const got = readDetail(abs, web);
      return { ready: !!(got && Object.keys(got).length), got: got || null,
        fields: got ? Object.keys(got).length : 0, name: panelName(),
        web: !!web, steps, ms: since(), warm: true,
        probe: probe ? { ...probe, hidden: trueHidden() } : undefined };
      } finally { if (undo) undo(); }
    }
    case 'dsolo': {
      const panel = panelOf();
      if (!panel) return { ready: false, why: 'no panel yet' };
      const got = readDetail(op.href || '', op.web || '');
      if (!got || !Object.keys(got).length) return { ready: false, why: 'panel not filled yet' };
      return { ready: true, got, fields: Object.keys(got).length, name: panelName() };
    }
    case 'dmark': return detailMark(op);
    // `op` FORWARDED, and its absence was a silent bug. `detailStep` measures growth against
    // `op.height` — the height the CALLER saw last time — because a panel grows during the wait
    // between steps, not inside one synchronous call. Called with nothing it falls back to the
    // height it just read, compares it to itself, and reports `grew: false` forever.
    case 'dstep': return detailStep(op);
    case 'dweb': return detailWeb();
    case 'dread': return detailRead(op);
    case 'ddone': {
      const out = detailDone();
      if (window[S]) window[S].live = false;
      // Given back on every ending — finished, stopped, given up. See `keepFrames`.
      out.frames = keepFrames(false);
      return out;
    }
    // EVERY table, read where it stands and WITHOUT WALKING ANYTHING. The `extractAll` ACTION
    // calls `ensure(true)` first, which scrolls the list — at the end of a details pass that
    // would re-walk the whole rail for nothing. The in-page loop avoided this by calling the
    // `extractAll()` function directly, and so does this.
    //
    // All of them, not just the one that was opened: `saveResult` unions items and REPLACES
    // tables, so handing back a single table deletes the page's other lists from the record.
    case 'dtables': {
      // BOUND TO THE LIST THIS PASS WAS READING, and this guard is a data-loss fix.
      //
      // A real export came back holding a RECORD'S PANEL — "See photos", the Overview/Menu/Reviews
      // tabs, individual reviews, "People also search for" — as 22 image columns and 73 text
      // columns, and the 120-row rail was gone. The pass had lost the rail, this call re-read
      // "every list on the page", detection found the reviews list inside the panel, and
      // `saveResult` REPLACES tables. One re-read destroyed the work of two phases.
      //
      // So it refuses rather than reads: if the container this pass belongs to is not standing,
      // there is nothing here worth saving and the table already on disk is better than anything
      // this could produce.
      const it = bagOf();
      if (!it) return { error: 'NOT_DETECTED' };
      if (!it.c.el || !it.c.el.isConnected) return { error: 'LIST_GONE' };
      return extractAll();
    }
    // WHAT ROOM THERE ACTUALLY IS, asked before anything is zoomed. The page is the only place
    // that can answer this: the worker knows the window's bounds but not how many CSS pixels Maps
    // is laying out inside them, and the difference between those two numbers is the zoom, the
    // window frame and HoloScrape's own side panel put together.
    case 'dscreen': return {
      inner: innerWidth,                  // CSS px the page has to work with — what Maps reads
      outer: outerWidth,                  // the window, including its frame
      want: DETAIL_WANT_WIDTH,            // what the pass buys before clicking — see there
      screenW: screen.width,
      availW: screen.availWidth,          // the screen minus the dock and the menu bar
      availH: screen.availHeight,
      dpr: devicePixelRatio || 1,
      need: DETAIL_MIN_WIDTH,
      hidden: trueHidden(),
    };
    // Asked once per record by the driver, because the flag lives on the page.
    case 'stopped': return { stopped: stopped() };
    case 'stop': { window[STOP] = true; return { stopped: true }; }
    // One clear per scan, from the panel, before the first phase.
    case 'clearstop': { window[STOP] = false; return { cleared: true }; }
    // The one trip back, taken when the user says the growing is over.
    case 'gohome': {
      const y = window[S]?.homeY;
      if (y != null) window.scrollTo({ top: y, behavior: 'instant' });
      return { home: y ?? null };
    }
    // ASKED FOR BEFORE THE DOM ENGINE EVER RUNS — a caller who tries this first and gets
    // `available:false` has spent one fetch, not a render; falling through to `extractAll` costs
    // nothing extra it would not already have paid. Only Shopify today; `platform` in the name
    // rather than `shopify` because the guard/fetch/map shape here is meant to hold a second one
    // without a caller-facing rename.
    case 'platform': return platformScan(op);
    case 'extract': return extract();
    case 'extractAll': {
      if (window[S]) window[S].live = true;
      try {
        await ensure(true);
      } finally { if (window[S]) window[S].live = false; }
      const out = extractAll();
      // The single move back, after the last read. Anything earlier is a jump the
      // user sees for no reason.
      if (home != null) window.scrollTo({ top: home, behavior: 'instant' });
      return out;
    }
    case 'scroll': { await ensure(false); return scrollStep(); }
    case 'clear': unpaint(); return { cleared: true };
    // Re-attach to a container found on a previous visit, so a saved selection
    // survives a reload without asking the user to re-pick.
    case 'restore': {
      const el = resolve(op.selector || '');
      if (!el) return { error: 'NO_MATCH' };
      const r = rowsOf(el);
      if (!r || r.rows.length < MIN_ROWS) return { error: 'NO_ROWS' };
      window[S] = { cands: [{ el, rows: r.rows, sig: r.sig, mode: r.mode, area: el.offsetWidth * el.offsetHeight, score: 0 }], i: 0 };
      if (op.mark || op.reveal) paint(window[S].cands[0], !!op.reveal);
      return summary();
    }
    default: return { error: 'UNKNOWN_ACTION', action: op.action };
  }
