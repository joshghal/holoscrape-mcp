  // --- explore the whole page, all the way down ---------------------------------------------------
  // WHAT WAS ACTUALLY ASKED FOR, several times, before it existed.
  //
  // `page_study` RANKS a handful of candidates and `page_read` reads what you already point at.
  // Neither answers "what IS this page" — every region, however deep, every scrollable area taken to
  // its end, and an honest word about the ones that never end. A person looking at a chat app with a
  // sidebar, a conversation, a member rail and three modals got a top-five list and had to guess.
  //
  // Three jobs, and the second is the one nobody else does:
  //   1. WALK to the deepest child, recording every region on the way — not a fixed depth cap.
  //   2. SCROLL each scrollable region to its real end, and NAME the ones that do not have one.
  //      A feed that keeps growing is not a failure to reach the bottom, it is a fact about the feed,
  //      and saying "infinite" is more use than a number that was really "wherever I gave up".
  //   3. REPORT structure, not a verdict: depth, size, how many rows, whether it scrolls, what it
  //      holds. The caller decides; this describes.
  //
  // Nothing here knows any site. A region is "scrollable" by its own measurements and "rowish" by
  // having repeated similar children — both are arithmetic on any DOM.
  function exploreSig(el) {
    const kids = [...el.children].filter((k) => k.offsetWidth * k.offsetHeight > 0);
    if (kids.length < 3) return { rows: 0, sig: '' };
    const sigOf = (k) => `${k.tagName}.${[...k.classList].slice(0, 2).sort().join('.')}`;
    const tally = {};
    for (const k of kids) { const g = sigOf(k); tally[g] = (tally[g] || 0) + 1; }
    let top = ''; let n = 0;
    for (const g of Object.keys(tally)) if (tally[g] > n) { n = tally[g]; top = g; }
    return { rows: n >= 3 ? n : 0, sig: top };
  }

  function exploreScrolls(el) {
    let sh = 0; let ch = 0; let ov = '';
    try {
      sh = el.scrollHeight; ch = el.clientHeight;
      ov = getComputedStyle(el).overflowY;
    } catch (_) { return false; }
    return sh > ch + SCROLL_SLACK_PX && /auto|scroll|overlay/.test(ov);
  }

  // Take one region to its end, and be honest about which kind of end it was.
  async function exploreGrow(el, rounds) {
    const count = () => exploreSig(el).rows || [...el.children].length;
    const before = count();
    let last = before;
    let still = 0;
    let moved = 0;
    for (let i = 0; i < rounds; i++) {
      const top0 = el.scrollTop;
      try { el.scrollTop = el.scrollHeight; } catch (_) { break; }
      await nap(EXPLORE_DWELL_MS);
      if (el.scrollTop > top0) moved++;
      const now = count();
      if (now > last) { last = now; still = 0; continue; }
      // Nothing new AND the scroller did not move: this is the bottom, for real.
      if (el.scrollTop <= top0 + 2 && ++still >= 2) {
        return { rows: last, grew: last - before, ended: 'reached the bottom', rounds: i + 1, moved };
      }
      if (++still >= EXPLORE_STILL) return { rows: last, grew: last - before, ended: 'stopped growing', rounds: i + 1, moved };
    }
    // Still producing rows when the budget ran out — that is an endless feed, and saying so beats
    // reporting whatever number happened to be on screen when we gave up.
    return { rows: last, grew: last - before, ended: 'still growing — endless', rounds, moved };
  }

  async function explorePage(op) {
    const deep = op.scroll !== false;
    const rounds = Math.max(1, Math.min(EXPLORE_ROUNDS_MAX, Number(op.rounds) || EXPLORE_ROUNDS));
    const seen = [];
    let deepest = 0;
    let swept = 0;
    // The walk itself: every element, with its true depth. No cap on how deep it looks — the cap is
    // on how many elements it visits, which is what actually costs time.
    const walk = (el, depth) => {
      if (++swept > EXPLORE_SWEEP) return;
      if (depth > deepest) deepest = depth;
      const w = el.offsetWidth; const h = el.offsetHeight;
      if (w * h > 0) {
        const scrolls = exploreScrolls(el);
        const { rows, sig } = exploreSig(el);
        if (scrolls || rows >= 3) {
          seen.push({ el, depth, w, h, scrolls, rows, sig,
            area: w * h,
            path: pathOf ? pathOf(el) : '',
            label: (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '' });
        }
      }
      for (const k of el.children) walk(k, depth + 1);
    };
    walk(document.body, 0);

    // Biggest first: on a real page this is the reading order a person would use anyway.
    seen.sort((a, b) => (b.rows * b.rows * b.area) - (a.rows * a.rows * a.area));
    const keep = seen.slice(0, Math.max(1, Math.min(EXPLORE_REGIONS_MAX, Number(op.limit) || EXPLORE_REGIONS)));

    const regions = [];
    for (const r of keep) {
      const one = {
        selector: r.path,
        depth: r.depth,
        size: `${r.w}x${r.h}`,
        rows: r.rows,
        rowKind: r.sig,
        scrollable: r.scrolls,
        ...(r.label ? { label: r.label.slice(0, 120) } : {}),
        sample: [...r.el.children].slice(0, 2)
          .map((k) => String(k.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 90))
          .filter(Boolean),
      };
      if (deep && r.scrolls) {
        const g = await exploreGrow(r.el, rounds);
        one.grown = { from: r.rows, to: g.rows, added: g.grew, ended: g.ended, rounds: g.rounds };
      }
      regions.push(one);
    }
    return {
      url: location.href,
      title: document.title,
      deepestChild: deepest,
      elementsWalked: swept,
      regionsFound: seen.length,
      returned: regions.length,
      scrolled: deep,
      regions,
    };
  }

  // `@dom(<css>)` — THE RENDERED PAGE, AS A STATE SOURCE.
  //
  // `page_state` already speaks in pseudo-sources: `@react.0` is not a global, `@mod["id"]` is not
  // a property, `@stores` is synthesised. The rendered DOM is the one source it could not name,
  // and that gap turned out to matter more than any of them — an agent whose tool list is stale,
  // or whose ranking refuses a container, had NO way to read what a person is looking straight at,
  // and went spelunking in engine internals instead.
  //
  // It reads with `readOne`, the same accessible-name precedence `page_read` uses and the same one
  // `extractOne` falls back to, so all three agree about what an element's name is. No ranking, no
  // candidate scoring, no re-detection, no `recount` — the three things that can each lose rows
  // between "23 are on screen" and "1 came back".
  //
  // Still no code: the argument is a CSS selector, matched with querySelectorAll and never
  // evaluated. The credential filter runs on the way out exactly as it does for every other path.
  const DOM_PATH = /^@dom\((.+)\)$/;
  function stateReadDom(op, sel) {
    let all = [];
    try { all = [...document.querySelectorAll(sel)]; } catch (e) {
      return { error: 'BAD_SELECTOR', selector: sel.slice(0, 200),
        why: String(e && e.message).slice(0, 160) };
    }
    if (!all.length) {
      // NOT HERE YET AND NOT HERE ARE DIFFERENT ANSWERS, AND THIS USED TO GIVE ONLY THE SECOND.
      //
      // Measured on a shopee.com.br product page: `.shopee-product-rating` returned NO_MATCH
      // twice, minutes apart, and the caller concluded the reviews were withheld from background
      // tabs. They were not withheld from anything — that section mounts a second or two after the
      // document is done, and both reads landed before it. The same selector then returned six
      // reviews on the same tab. A whole wrong theory about tab focus was built on this sentence,
      // because the sentence only offered "see what this page offers", which invites you to
      // conclude the thing is absent.
      //
      // `readyState` is what separates them, and it is free. A page still loading has an obvious
      // excuse; a complete one on a JavaScript-rendered site has the less obvious excuse that
      // complete describes the document, not the app.
      //
      // AND `complete` IS THE BRANCH ALMOST EVERY CALLER SEES. It fires as soon as the document
      // and its subresources are done, which on a client-rendered page is long before anything has
      // painted — so the first version of this wrote the complete branch as though it were the
      // unlikely one and left "read it again" out of it entirely. Measured twice on the same day:
      // a live shopee.co.id product page answered NO_MATCH for its reviews with the document
      // already complete, and test/no-match-is-not-absence read the same branch and found no
      // advice to re-read in it. Both branches must say to read again, because on this kind of
      // page neither state means the thing is absent.
      const settling = document.readyState !== 'complete';
      return { error: 'NO_MATCH', selector: sel.slice(0, 200),
        ...(settling ? { stillLoading: true } : {}),
        tell: settling
          ? 'nothing matches YET — this document has not finished loading. Wait for it instead of '
            + `guessing: page_state path:"@await(${sel.slice(0, 80)})".`
          : 'nothing matches, and the document is complete — which on a JavaScript-rendered page '
            + 'means almost nothing, because `complete` describes the DOCUMENT and the app paints '
            + 'after it. THIS IS THE COMMON CASE, NOT THE EXCEPTION. Read it again in a second or '
            + 'two before you believe it; a section can mount seconds late. Better than a re-read, '
            + `wait for it: page_state path:"@await(${sel.slice(0, 80)} :: exists :: 10000)". IF THAT SELECTOR `
            + 'NAMES A CONTAINER rather than the rows inside it, add "> *" and use `still` instead '
            + 'of `exists` — a container matches instantly while it is still filling, which is how '
            + 'a grid of sixty gets read as ten. If the page shows a spinner, '
            + '@await(<spinner css> :: gone) is surer than either.' };
    }
    // WHAT NOBODY CAN SEE IS NOT ON THE PAGE.
    //
    // `querySelectorAll` happily returns `display:none` nodes, so a read of a sidebar came back
    // holding collapsed rows mixed in with visible ones, indistinguishable. That is the wrong
    // answer to "what is on this page" in both directions: it hides the fact that something is
    // collapsed (a caller would never think to expand), and it pads the count with rows a person
    // is not looking at. Counted rather than dropped silently — `hidden` says how many were left
    // out, which is the signal that a page has more to reveal.
    const shown = all.filter((el) => el.offsetWidth * el.offsetHeight > 0
      || (el.getClientRects && el.getClientRects().length > 0));
    const hidden = all.length - shown.length;
    if (shown.length) all = shown;
    let via = 'the selector itself';
    let list = all;
    if (all.length === 1) {
      const kids = [...all[0].children].filter((k) => k.offsetWidth * k.offsetHeight > 0);
      if (kids.length >= 2) { list = kids; via = 'the children of the one element that matched'; }
    }
    const ctx = stateCtx(op);
    const from = Math.max(0, Math.min(list.length, ctx.from || 0));
    const take = Math.min(list.length - from, ctx.wide);
    const rows = [];
    // `fields` HAS TO WORK HERE, BECAUSE THIS IS WHERE IT IS ADVERTISED.
    //
    // REPLY_TOO_BIG tells the caller `fields:["a.b","c"] to keep only the columns you need — the
    // biggest win by far`. That was true of the state paths and silently false here: this branch
    // built every row with `readOne` and never looked at `fields`, so a caller trimming columns saw
    // `img` come back on all 85 rows anyway and concluded the advice did not work. What they reach
    // for next is `limit`, which does not trim the reply — it DROPS ROWS. Measured: a live run cut
    // an 85-product list to 40 that way and reported 40 as the answer.
    //
    // Flat keys, not paths: a `@dom` row is {href, img, key, text}, so this filters rather than
    // walking. An unknown name is kept as null so a typo shows up as an empty column instead of
    // vanishing into "that field isn't on the page".
    const want = (ctx.fields || []).map(String).filter(Boolean);
    const trim = (r) => {
      if (!want.length) return r;
      const o = {};
      for (const f of want) o[f] = Object.prototype.hasOwnProperty.call(r, f) ? r[f] : null;
      return o;
    };
    for (let i = from; i < from + take; i++) rows.push(trim(readOne(list[i])));
    return {
      path: `@dom(${sel.slice(0, 160)})`,
      kind: 'dom',
      via,
      selector: sel.slice(0, 200),
      rows,
      total: list.length,
      from,
      ...(from + rows.length < list.length ? { next: from + rows.length } : {}),
      ...(hidden ? { hidden,
        tell: `${hidden} more match the selector but are not visible — the page is hiding them. `
          + 'Use page_state "@map(...)" to expand collapsed sections and reveal controls first' } : {}),
      redacted: 0,
    };
  }

  // `@collect(<row css> :: <hops>)` — HARVEST, REACHABLE WITHOUT A RELOAD.
  //
  // Same reasoning that put `@dom` here, one step further. The extension's service worker script is
  // cached until the extension is reloaded, so a new OP is gated on a human; the injected engine is
  // not. A capability that lives behind a PATH therefore ships the moment the file is rebuilt,
  // which is the difference between "the user can have their data now" and "after you reload".
  // Measured twice tonight: `page_read`/`page_html`/`page_walk` were all built and all unreachable,
  // while `@dom` worked immediately and unblocked the entire Discord case.
  //
  // The pane is inferred with `scrollerFor` from the first row, which is what a caller means by
  // "the list scrolls in something". `limit` caps the rows; hops after `::` bounds the work.
  // `@fetch(<url>)` — ASK THE PAGE TO MAKE THE REQUEST, INSTEAD OF OPENING A TAB PER RECORD.
  //
  // THE COST THIS EXISTS TO DELETE. A details pass navigates one tab per record and waits for a
  // whole client-rendered page: measured on shopee.com.br, about 15-20 seconds per product with a
  // single lane, so 120 products took the better part of an hour and finished 48 of them. The data
  // wanted was never in that page to begin with — the page fetched it from
  // `/api/v4/pdp/get_pc?item_id=...`, one JSON with the title, price, attributes and the whole
  // description, and then spent the other nineteen seconds rendering images and trackers around it.
  //
  // WHY NOT JUST NAVIGATE TO THE API URL. Because that answers `error: 90309999`. Shopee ships an
  // anti-crawler SDK that HOOKS the page's own fetch and XHR — `__sap_hook_fetch`,
  // `__sap_hook_xhr`, both plainly visible in the page globals — and signs requests as they go out.
  // An address bar has no hook, so it is refused. The page has one.
  //
  // AND THIS ENGINE RUNS IN THE PAGE'S MAIN WORLD (see `world: 'MAIN'` at every injection site),
  // so `fetch` here IS the hooked fetch. The request is signed by the site's own code, carries the
  // person's cookies because it is their session, and comes back as data. Nothing is evaluated:
  // this takes a URL, not code, which is the same closed-vocabulary rule every other op follows.
  //
  // SAME ORIGIN ONLY, AND GET ONLY. Per-origin consent was granted for the page in front of the
  // person; it is not a licence to reach anywhere else from inside their browser. A cross-origin
  // request would also arrive unsigned and unauthenticated, so the restriction costs nothing real.
  // No agent-supplied headers, no body, no other method — an endpoint that changes state is not
  // reachable by asking nicely for a URL.
  // `@await(<css> :: <mode> :: <ms>)` — WAIT FOR A CONDITION INSTEAD OF GUESSING A DURATION.
  //
  // Every wait in this system was a fixed number: waitMs 4000, HARVEST_SETTLE_MS 1500, HYDRATE_MS
  // 3000, NET_WAIT_MS 6000. A fixed wait is a bet that the page is slower than X and faster than
  // the budget, and it loses in both directions — too short and the read is early, too long and
  // every page pays for the worst page. Measured in one session: four agents ran the SAME code
  // against the SAME review selector; two got five reviews on every product and two got none on
  // four of five. Nothing differed but luck. That is not flakiness to be tuned away, it is a race
  // with no finish line, and the fix is to name the finish line.
  //
  // FOUR MODES, WHICH IS WHAT MAKES IT GENERAL RATHER THAN A SELECTOR-EXISTS HELPER. Each one is a
  // real page behaviour that a fixed timeout handles badly:
  //
  //   exists  (default)  the thing mounted                  reviews, specs, a late grid
  //   gone               the thing went away                 a SPINNER, a skeleton, an overlay
  //   still              the count stopped changing          a grid painting in pieces, a feed
  //   <number>           at least this many matched          "60 a page, wait for 60"
  //
  // `gone` matters more than it looks: waiting for content to appear cannot tell a slow page from
  // an empty one, but a spinner disappearing is unambiguous, and almost every app has one.
  // `still` is the honest version of what `settleForList` does by hand — two agreeing polls — and
  // it belongs here where any caller can ask for it rather than only the navigation path.
  //
  // IT NEVER THROWS ON TIMEOUT. A wait that ran out is a FACT about the page — how many matched,
  // for how long, which way the number was moving — and an error would throw that away and invite
  // a retry of the same guess. `ok:false` with the evidence is what lets a caller decide between
  // waiting longer, reading what did arrive, or concluding the thing is genuinely absent.
  // TYPING INTO A FIELD — THE FIRST OP IN THIS VOCABULARY THAT WRITES.
  //
  // Everything else here READS. A read leaves nothing behind; typing into a page the person is
  // signed into does, which is the line between "read what is on my screen" and "act as me". So
  // this is deliberately the narrowest thing that unblocks the use case it exists for: a scrape
  // behind a filter, a date range, or a search box the site does not expose as a URL. Without it,
  // any list that can only be reached by typing is simply unreachable — `tab_here({search})` works
  // only on sites with a declared `searchFor`, which today is two of them.
  //
  // WHAT IT WILL NOT DO, and each refusal is the point rather than caution for its own sake:
  //   - no PASSWORD field, ever. Filling one is indistinguishable from an attempt to sign in as
  //     the person, and the credential tier is explicitly not this tier.
  //   - no HIDDEN field. A hidden input is the page's own bookkeeping — a token, a nonce, a state
  //     blob — and writing to one is tampering with the site's machinery rather than its form.
  //   - nothing that looks like PAYMENT. Card number, cvv, expiry, and anything the page itself
  //     marks `autocomplete="cc-*"`. Read from the page's own declaration first, because a field
  //     named `q` that is autocompleted as `cc-number` is a payment field whatever it is called.
  //   - it does NOT submit. No Enter, no form.submit(), no clicking a neighbouring button. Filling
  //     and sending are separate decisions, and a caller that wants the second asks for it with
  //     page_grow mode:"walk" and can be seen doing so.
  //
  // THE VALUE IS SET THROUGH THE NATIVE SETTER, not by assigning `el.value`. React tracks the last
  // value it wrote and skips its own handler when a plain assignment matches, so the field shows
  // the text and the app never learns of it — the classic symptom being a search box that visibly
  // contains the query and returns results for the empty string.
  function fillField(op) {
    const sel = String(op.selector || '').trim();
    const text = String(op.fill == null ? '' : op.fill);
    if (!sel) return { error: 'NO_SELECTOR', tell: 'name the field to fill with a css selector.' };
    if (text.length > FILL_MAX_CHARS) {
      return { error: 'TOO_LONG', bytes: text.length, tell: 'fields take up to 2000 characters.' };
    }
    let el = null;
    try { el = document.querySelector(sel); } catch (e) {
      return { error: 'BAD_SELECTOR', selector: sel.slice(0, 200), why: String(e && e.message).slice(0, 160) };
    }
    if (!el) {
      return { error: 'NO_MATCH', selector: sel.slice(0, 200),
        tell: 'nothing matches. If the form mounts late, wait for it first: '
          + `page_state path:"@await(${sel.slice(0, 60)})".` };
    }
    const tag = (el.tagName || '').toLowerCase();
    const type = String(el.getAttribute('type') || '').toLowerCase();
    const editable = el.isContentEditable;
    if (!editable && tag !== 'input' && tag !== 'textarea') {
      return { error: 'NOT_A_FIELD', tag, selector: sel.slice(0, 200),
        tell: 'that is not an input, a textarea or a contenteditable. To PRESS something, use '
          + 'page_grow mode:"walk"; to pick from a <select>, use its `choose`.' };
    }
    if (type === 'password') {
      return { error: 'REFUSED', why: 'password field',
        tell: 'a password is the person\'s identity, not page data, and nothing here may type one. '
          + 'If a sign-in is in the way, say so and let THEM do it in this browser.' };
    }
    if (type === 'hidden') {
      return { error: 'REFUSED', why: 'hidden field',
        tell: 'a hidden input is the page\'s own bookkeeping — a token or a state blob — not a '
          + 'form field a person fills.' };
    }
    const auto = String(el.getAttribute('autocomplete') || '').toLowerCase();
    const idish = `${el.name || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
    if (/^cc-/.test(auto) || /\b(card|cardnum|cvv|cvc|securitycode|expiry|exp-date)\b/.test(idish)) {
      return { error: 'REFUSED', why: 'looks like a payment field', autocomplete: auto || undefined,
        tell: 'payment details are never entered by a tool. Nothing about a scrape needs them.' };
    }
    try { el.focus(); } catch (_) { /* a field that cannot focus can still take a value */ }
    if (editable) {
      el.textContent = text;
    } else {
      // The native setter, so frameworks that memoise the last value they wrote still fire.
      const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, text); else el.value = text;
    }
    for (const kind of ['input', 'change']) {
      try { el.dispatchEvent(new Event(kind, { bubbles: true })); } catch (_) { /* older page */ }
    }
    const now = editable ? String(el.textContent || '') : String(el.value || '');
    return {
      filled: now === text, selector: sel.slice(0, 200), tag, chars: text.length,
      // READ BACK, because a field can silently reject or reformat what it was given — a masked
      // date, a maxlength, a numeric filter. Reporting what was ASKED FOR would be a guess.
      value: now.slice(0, 200),
      ...(now === text ? {} : { why: 'the field holds something other than what was sent — it may '
        + 'be masked, length-capped or filtered' }),
      tell: 'nothing was submitted. To send the form, press its control with page_grow '
        + 'mode:"walk" — filling and sending are separate on purpose.',
    };
  }

  const AWAIT_PATH = /^@await\((.+)\)$/;
  const AWAIT_STEP_MS = 150;
  const AWAIT_MAX_MS = 30000;
  const AWAIT_STILL_MS = 400;     // a count must hold this long before "stopped" is believed
  async function pageAwait(spec) {
    const parts = String(spec).split('::').map((x) => x.trim());
    const css = parts[0].replace(/^["']|["']$/g, '');
    const rawMode = (parts[1] || 'exists').toLowerCase();
    const budget = Math.max(AWAIT_MIN_MS, Math.min(AWAIT_MAX_MS, Number(parts[2]) || AWAIT_DEFAULT_MS));
    const atLeast = Number(rawMode) > 0 ? Number(rawMode) : 0;
    const mode = atLeast ? 'atleast' : (['exists', 'gone', 'still'].includes(rawMode) ? rawMode : 'exists');
    if (!css) {
      return { error: 'BAD_PATH', path: `@await(${spec})`.slice(0, 200),
        why: 'name a css selector first',
        tell: 'syntax is @await(<css> :: <mode> :: <ms>); mode is exists (default), gone, still, '
          + 'or a number meaning at least that many.' };
    }
    const count = () => {
      try { return document.querySelectorAll(css).length; } catch (_) { return -1; }
    };
    const t0 = Date.now();
    let n = count();
    if (n < 0) {
      return { error: 'BAD_SELECTOR', selector: css.slice(0, 200),
        why: 'that is not a selector this page can match' };
    }
    let polls = 1;
    let held = -1;
    let heldSince = 0;
    let peak = n;
    const met = () => {
      if (mode === 'gone') return n === 0;
      if (mode === 'atleast') return n >= atLeast;
      if (mode === 'still') return n > 0 && n === held && Date.now() - heldSince >= AWAIT_STILL_MS;
      return n > 0;
    };
    while (!met() && Date.now() - t0 < budget) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, AWAIT_STEP_MS));
      const now = count();
      if (now !== held) { held = now; heldSince = Date.now(); }
      n = now;
      if (n > peak) peak = n;
      polls++;
    }
    const ok = met();
    const waitedMs = Date.now() - t0;
    // WOULD WAITING LONGER HELP? THE PAGE CAN ANSWER THAT, AND A NUMBER CANNOT.
    //
    // A budget that runs out says nothing about whether it was too short. Raising it is the wrong
    // answer in general: every page that genuinely has no such element then pays the longer wait
    // for nothing, and on a details pass that is the whole run. What separates the two cases is
    // whether the page is STILL BUILDING ITSELF — a document that is adding nodes has not
    // finished, and one that has gone quiet without producing the thing is not about to.
    //
    // `readyState` is not that signal. It reaches `complete` on the load event while a React app
    // is still mounting, which is the misread this entire file exists to prevent. Mutations are
    // the honest one: they are the app actually doing work, whatever framework is doing it.
    let churn = 0;
    if (!ok) {
      churn = await new Promise((done) => {
        let hits = 0;
        let mo = null;
        try {
          mo = new MutationObserver((recs) => { for (const r of recs) hits += r.addedNodes.length; });
          mo.observe(document.documentElement, { childList: true, subtree: true });
        } catch (_) { done(0); return; }
        setTimeout(() => { try { mo.disconnect(); } catch (_) {} done(hits); }, AWAIT_CHURN_MS);
      });
    }
    return {
      ok, mode: atLeast ? `atleast:${atLeast}` : mode, selector: css.slice(0, 200),
      matched: n, peak, waitedMs, polls,
      // Only on a miss, and only as a FACT: how many nodes the page added while we watched. A
      // caller deciding whether to spend more time has the one input that decides it.
      ...(!ok ? { stillBuilding: churn > 0, nodesAddedWhileWatching: churn } : {}),
      ...(ok ? {} : {
        // WHICH WAY IT WAS MOVING is the difference between "wait longer" and "it is not coming".
        why: mode === 'gone'
          ? `${n} still matched when the budget ran out — whatever this is did not go away`
          : `${n} matched when the budget ran out` + (peak > n ? `, after peaking at ${peak}` : ''),
        tell: churn > 0
          ? `the page added ${churn} nodes while this was giving up, so it is STILL BUILDING — `
            + 'waiting longer is likely to work. Call this again with a bigger budget rather than '
            + 'concluding anything.'
          : (n > 0 && mode !== 'gone'
            ? 'something matched but the condition was not met, and the page has gone QUIET — more '
              + 'time is unlikely to help. Read what is there, or check the condition.'
            : 'nothing matched and the page has gone QUIET — it is not about to arrive. Check the '
              + 'selector against page_state path:"@html(<css>)", or the section may need scrolling to before it '
              + 'mounts (some only mount when scrolled into view).'),
      }),
    };
  }

  const FETCH_PATH = /^@fetch\((.+)\)$/;
  const FETCH_CAP = 400000;
  async function pageFetch(raw) {
    let u = null;
    try { u = new URL(raw, location.href); } catch (_) { u = null; }
    if (!u || !/^https?:$/.test(u.protocol)) {
      return { error: 'BAD_URL', url: String(raw).slice(0, 200),
        tell: 'give an http(s) url, absolute or relative to this page.' };
    }
    if (u.origin !== location.origin) {
      return { error: 'CROSS_ORIGIN', url: u.href.slice(0, 200), origin: location.origin,
        tell: 'this reads the SAME SITE the tab is already on, because that is the origin the '
          + 'person consented to and the only one this page can sign for. Point a tab at the other '
          + 'site with tab_here first, then fetch from there.' };
    }
    const t0 = Date.now();
    let res = null;
    try { res = await fetch(u.href, { method: 'GET', credentials: 'include' }); } catch (e) {
      return { error: 'FETCH_FAILED', url: u.href.slice(0, 200),
        why: String((e && e.message) || e).slice(0, 200) };
    }
    let text = '';
    try { text = await res.text(); } catch (_) { text = ''; }
    const mime = res.headers.get('content-type') || '';
    let body = null;
    if (/json/i.test(mime) || /^[[{]/.test(text.trim())) {
      try { body = JSON.parse(text); } catch (_) { body = null; }
    }
    return {
      url: u.href, status: res.status, mime, ms: Date.now() - t0, bytes: text.length,
      ...(body !== null ? { body } : { text: text.slice(0, FETCH_CAP) }),
      ...(body === null && text.length > FETCH_CAP ? { truncated: text.length } : {}),
    };
  }

  const COLLECT_PATH = /^@collect\((.+)\)$/;
  function stateReadPath(op) {
    const dom = DOM_PATH.exec(String(op.path || '').trim());
    if (dom) return stateReadDom(op, dom[1].trim().replace(/^["']|["']$/g, ''));
    // `@html(<css> :: <depth>)` — THE MARKUP, ON A PATH.
    //
    // `page_html` was built as a TOOL, and a new tool name needs an `/mcp` reconnect, so it sat
    // unreachable for an entire session while the caller guessed at markup they could have simply
    // read. That is not a smaller version of shipping it — it is not shipping it. Every capability
    // that actually reached the browser tonight went on a path; this one belongs there too.
    const html = HTML_PATH.exec(String(op.path || '').trim());
    if (html) {
      const bits = String(html[1]).split('::');
      return htmlOf({
        selector: bits[0].trim().replace(/^["']|["']$/g, ''),
        depth: Number(bits[1]) || 0,
        index: Number(bits[2]) || 0,
        limit: Number(op.limit) > 0 ? Number(op.limit) * HTML_CHARS_PER_ROW : HTML_SPAN,
        offset: op.offset,
      });
    }
    const mp = MAP_PATH.exec(String(op.path || '').trim());
    if (mp) return mapPage(op, mp[1].trim().replace(/^["']|["']$/g, ''));
    const ap = AWAIT_PATH.exec(String(op.path || '').trim());
    if (ap) return pageAwait(ap[1].trim());
    const fp = FETCH_PATH.exec(String(op.path || '').trim());
    if (fp) return pageFetch(fp[1].trim().replace(/^["']|["']$/g, ''));
    const col = COLLECT_PATH.exec(String(op.path || '').trim());
    if (col) {
      const parts = String(col[1]).split('::');
      const sel = parts[0].trim().replace(/^["']|["']$/g, '');
      const hops = Number(parts[1]) || COLLECT_PATH_HOPS;
      const dir = (parts[2] || '').trim().toLowerCase() === 'up' ? 'up' : 'down';
      // `fields` CARRIED THROUGH. Without it the parameter is accepted by the tool, ignored by the
      // reader, and the caller who trimmed columns to fit the budget gets the full row anyway —
      // then reaches for `limit`, which does not trim a reply, it DROPS ROWS.
      return collectRows({ selector: sel, hops, direction: dir, fields: op.fields,
        limit: Number(op.limit) > 0 ? Number(op.limit) * COLLECT_ROWS_PER_LIMIT : COLLECT_CAP,
        reply: Number(op.reply) > 0 ? Number(op.reply) : 0,
        offset: Number(op.offset) > 0 ? Number(op.offset) : 0, waitMs: COLLECT_PATH_WAIT_MS });
    }
    const parsed = statePath(op.path);
    if (parsed.error) {
      return { error: 'BAD_PATH', path: String(op.path).slice(0, 200), why: parsed.error,
        tell: 'call page_state with no path to see the paths this page offers' };
    }
    const ctx = stateCtx(op);
    // The frame trick costs a DOM insertion, and only two roots need it. A read of
    // `__NEXT_DATA__.props` has no business paying for it.
    const head = parsed.steps[0];
    const own = (head === '@stores' || head === '@mod')
      ? stateAppGlobals() : { names: [], via: 'not needed for this path' };
    const got = stateWalk(parsed.steps, own.names);
    if (got.error) return { ...got, path: String(op.path).slice(0, 200) };
    // THE LAST STEP IS PASSED AS THE KEY, and leaving it out was a hole: the credential filter
    // fires on the KEY a value sits under, so reading `state.authToken` directly — rather than
    // reading `state` and finding it inside — would have handed the token straight over. A
    // targeted read is exactly how someone would ask for one.
    const leaf = parsed.steps[parsed.steps.length - 1];
    // PROJECTION AND JOIN APPLY TO A COLLECTION OF ROWS, and only there. Asked for on a scalar or a
    // plain object they would be meaningless, so they are ignored rather than half-honoured.
    const fields = Array.isArray(op.fields) ? op.fields.filter(Boolean).map(String) : [];
    const wantsJoin = op.resolve && typeof op.resolve === 'object';
    if (Array.isArray(got.node) && (fields.length || wantsJoin)) {
      const from = Math.max(0, Math.min(got.node.length, ctx.from || 0));
      const take = Math.min(got.node.length - from, ctx.wide);
      const nodes = [];
      const rows = [];
      for (let i = from; i < from + take; i++) {
        let cell = null;
        try { cell = got.node[i]; } catch (_) { cell = null; }
        nodes.push(cell);
        rows.push(fields.length ? stateProject(cell, fields, ctx) : {});
      }
      const joined = wantsJoin ? stateResolveRows(rows, nodes, op.resolve, ctx) : null;
      const seen = from + rows.length;
      return {
        path: String(op.path).slice(0, 200),
        resolved: got.walked,
        kind: 'array',
        depth: ctx.depth,
        limit: ctx.wide,
        rows,
        total: got.node.length,
        from,
        ...(seen < got.node.length ? { next: seen } : {}),
        ...(fields.length ? { fields } : {}),
        ...(joined ? { joinedBy: op.resolve.from, joinMisses: joined.missed || 0, ...(joined.why ? { joinFailed: joined.why } : {}) } : {}),
        redacted: ctx.redacted,
      };
    }
    const value = stateValue(got.node, ctx, ctx.depth, ctx.wide, leaf);
    return {
      path: String(op.path).slice(0, 200),
      resolved: got.walked,
      kind: got.node === null ? 'null' : (Array.isArray(got.node) ? 'array' : typeof got.node),
      depth: ctx.depth,
      limit: ctx.wide,
      ...(got.called.length ? { called: got.called } : {}),
      value,
      redacted: ctx.redacted,
      ...(ctx.cut ? { truncated: true, tell: 'narrow the path or lower depth — the reply hit its budget' } : {}),
    };
  }

