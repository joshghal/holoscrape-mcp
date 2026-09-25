  // --- read exactly what was pointed at -----------------------------------------------------------
  // THE MISSING PRIMITIVE, and its absence cost an evening.
  //
  // `page_study` RANKS lists and `list_extract` runs the whole detection engine — both must first
  // AGREE that something is a list before they will read it. So a person asking for the twenty-three
  // servers plainly visible in Discord's rail got nothing: `detect()` counted 23 rows there while the
  // pinned path found 1, and no tool existed that would simply read the elements.
  //
  // This one does no ranking, no scoring and no candidate search. It takes a selector, reads every
  // element that matches, and returns what each one carries. When someone can see the thing on their
  // screen, "the engine did not classify it as a list" is not an acceptable answer.
  //
  // Generic by construction: the fields below are what any element can carry, not what any site
  // calls them.
  function readOne(el) {
    const text = String(el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 500);
    const row = {};
    if (text) row.text = text;
    // A label a sighted person cannot see is often the only real name on an icon — Discord's server
    // rail is icons with `aria-label`, which is why text alone would have returned empty rows.
    const label = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'));
    if (label) row.label = String(label).slice(0, 300);
    const a = el.matches && el.matches('a[href]') ? el : (el.querySelector && el.querySelector('a[href]'));
    if (a && a.href) row.href = String(a.href).slice(0, 500);
    const img = el.matches && el.matches('img[src]') ? el : (el.querySelector && el.querySelector('img[src]'));
    if (img && img.src) row.img = String(img.src).slice(0, 500);
    const inner = el.querySelector && el.querySelector('[aria-label],[title]');
    if (!row.label && inner) {
      const l2 = inner.getAttribute('aria-label') || inner.getAttribute('title');
      if (l2) row.label = String(l2).slice(0, 300);
    }
    return row;
  }

  // THE MARKUP ITSELF, WHICH THIS TOOL REFUSED TO HAND OVER FOR TOO LONG.
  //
  // Every other tool here returns a judgement: ranked lists, chosen candidates, extracted cells.
  // That is right for output and wrong for diagnosis, and the difference cost a whole session.
  // When `list_extract` refused a container the caller could plainly see 23 rows in, there was no
  // way to LOOK — so the next move was reading the engine's internal state by raw path and then
  // reading the engine's source, to answer a question the page would have answered instantly.
  // "Returns data, never HTML" was a principle about results that had quietly become a rule about
  // everything.
  //
  // What makes it usable rather than a firehose:
  //   - SCOPED. A selector, or the document. Nobody needs six megabytes of Discord.
  //   - STRIPPED. Script, style and inline SVG geometry are removed from a CLONE — that is where
  //     the bulk lives and none of it is structure a person is reading for.
  //   - SHORTENED. data: and blob: URLs collapse to a marker; they are megabytes of base64 that
  //     say nothing the attribute name has not already said.
  //   - HONEST. The true length is always reported, with `next` to continue, so a truncated read
  //     never reads as a complete one.
  //   - depth: trims the tree below a level, so a page's SHAPE can be read without its contents.
  function htmlOf(op) {
    const sel = String(op.selector || '');
    let el = document.documentElement;
    if (sel) {
      let all = [];
      try { all = [...document.querySelectorAll(sel)]; } catch (e) {
        return { error: 'BAD_SELECTOR', selector: sel.slice(0, 200),
          why: String(e && e.message).slice(0, 160) };
      }
      if (!all.length) {
        return { error: 'NO_MATCH', selector: sel.slice(0, 200),
          tell: 'call page_study or page_explore to see what this page offers' };
      }
      el = all[Math.min(Number(op.index) || 0, all.length - 1)];
      if (all.length > 1) op = { ...op, matched: all.length };
    }
    const clone = el.cloneNode(true);
    const DROP = 'script,style,noscript,template,link,meta,path,defs,clipPath,mask,filter,symbol';
    let dropped = 0;
    for (const n of clone.querySelectorAll(DROP)) { n.remove(); dropped++; }
    // Long attribute values are almost always an encoded image; the name is the information.
    for (const n of clone.querySelectorAll('*')) {
      for (const a of [...n.attributes]) {
        if (/^(data|blob):/i.test(a.value)) n.setAttribute(a.name, a.value.slice(0, HTML_URI_STUB) + '…');
        else if (a.value.length > HTML_ATTR_MAX) n.setAttribute(a.name, a.value.slice(0, HTML_ATTR_MAX) + '…');
      }
    }
    // Depth trimming happens on the clone, so the page is never touched. Level 0 is the element
    // itself, so depth:1 is "this element and its children" — what a person means by one level.
    const depth = Number(op.depth) || 0;
    let trimmed = 0;
    if (depth > 0) {
      const walk = (n, at) => {
        if (at >= depth) {
          if (n.children.length) { trimmed += n.children.length; n.textContent = '…'; }
          return;
        }
        for (const k of [...n.children]) walk(k, at + 1);
      };
      walk(clone, 0);
    }
    const whole = clone.outerHTML.replace(/\n\s*\n+/g, '\n');
    const from = Math.max(0, Number(op.offset) || 0);
    const span = Math.min(Math.max(HTML_SPAN_MIN, Number(op.limit) || HTML_SPAN), HTML_SPAN_MAX);
    const cut = whole.slice(from, from + span);
    return {
      at: pathOf(el),
      tag: el.tagName.toLowerCase(),
      ...(op.matched ? { matched: op.matched, note: `${op.matched} elements match — this is index `
        + `${Number(op.index) || 0}; pass index to read another` } : {}),
      length: whole.length,
      from,
      shown: cut.length,
      ...(from + cut.length < whole.length ? { next: from + cut.length } : {}),
      ...(dropped ? { removed: `${dropped} script/style/svg-geometry nodes` } : {}),
      ...(trimmed ? { trimmed: `${trimmed} children below depth ${depth}` } : {}),
      html: cut,
    };
  }

  // WALK A SET OF THINGS AND READ WHERE EACH ONE LEADS.
  //
  // The gap this closes, in the user's words: *"press a server → the title bar gives me the name,
  // the URL gives the guild ID, and the channel list is right there."* That is one human gesture
  // repeated 23 times, and this engine had no way to express it. Every tool here answers a
  // question about ONE page — what lists are on it, what an element says, what the store holds —
  // so a walk across 23 pages had to be driven by an agent one call at a time, and watching that
  // happen is what made the tool look slower than doing it by hand. It WAS slower.
  //
  // It is deliberately not a scraper. It presses, waits, and reports where it landed: the URL, the
  // title, the name of the thing pressed, and — if `read` names one — what that selector says on
  // the page that appeared. Deciding what to do with each destination stays with the caller.
  //
  // Re-queried every turn, because navigating replaces the very nodes being walked: an SPA rebuilds
  // its rail on each route change, so a list captured once is a list of detached elements by the
  // third press. That is the same lesson `recount` records for rows, applied to a walk.
  // WORDS, NOT A SELECTOR — because the tool's own description promised them and the code did not
  // accept them. `text` was advertised as "what the person would CLICK, in their words. Prefer this
  // over a selector", the MCP layer passed it, and the op signature dropped it on the floor; the
  // walk then failed NO_SELECTOR against a control the caller had named correctly. A description
  // that promises an input the code rejects is worse than a missing feature: it costs a call and
  // teaches the reader to distrust the rest of the document.
  //
  // Matched on what a PERSON would read — the visible text, or the accessible name where there is no
  // text, which is how an icon button is labelled. Exact match first so "More" cannot select "More
  // like this"; then a contains pass, longest-first, because the shorter string is usually a
  // fragment of the wrong control. Only pressable things are considered, so the word "Sort by" in a
  // label never wins over the button beside it.
  function byWords(want) {
    const w = String(want || '').trim().toLowerCase();
    if (!w) return [];
    let cand = [];
    try {
      cand = [...document.querySelectorAll(
        'button, a, [role="button"], [role="menuitem"], [role="tab"], [role="option"], summary, input[type="submit"], input[type="button"], [onclick], [tabindex]:not([tabindex="-1"])',
      )];
    } catch (_) { return []; }
    const name = (el) => {
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t.toLowerCase();
      const a = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title')
        || el.getAttribute('value') || el.getAttribute('alt'));
      return String(a || '').replace(/\s+/g, ' ').trim().toLowerCase();
    };
    const seen = new Map();
    for (const el of cand) seen.set(el, name(el));
    const exact = cand.filter((el) => seen.get(el) === w);
    if (exact.length) return exact;
    return cand.filter((el) => seen.get(el).includes(w))
      .sort((a, b) => seen.get(a).length - seen.get(b).length);
  }

  // CONTENT THAT ONLY EXISTS BEHIND A CHOSEN OPTION.
  //
  // Until this existed the engine could read, navigate, press and scroll — and could not CHOOSE.
  // Anything a page puts behind a <select> was therefore unreachable: sort orders, filter selects,
  // per-page counts, date ranges, locale and currency switchers. Measured on a live Bazaarvoice
  // widget: 2,837 reviews rendered in RELEVANCE order with a `mostRecent` option sitting right
  // there, so "the 3 latest reviews" was impossible to answer honestly — the first review on screen
  // was two years old. A press cannot fix that; a <select> does not respond to a click.
  //
  // WHY IT IS A BRANCH OF `walk` AND NOT A NEW TOOL. Walk's contract is already exactly this:
  // press one thing and report what CHANGED, for an app that swaps content without loading a
  // document. Choosing an option IS that. A new tool name would also force every caller to
  // reconnect for a verb they already have.
  //
  // The gesture is `value` plus `input` and `change`, which is what a real selection fires and what
  // every framework listens for. Nothing is executed and nothing is typed.
  async function chooseOption(op) {
    const want = String(op.choose || '').trim();
    const wl = want.toLowerCase();
    const sel = String(op.selector || '');
    const norm = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().toLowerCase();
    let selects = [];
    try {
      const scope = sel ? [...document.querySelectorAll(sel)] : [document];
      for (const el of scope) {
        if (el.tagName === 'SELECT') selects.push(el);
        else selects.push(...el.querySelectorAll('select'));
      }
    } catch (e) {
      return { error: 'BAD_SELECTOR', selector: sel.slice(0, 200), why: String(e && e.message).slice(0, 160) };
    }
    // THE SELECT IS FOUND BY THE OPTION, not the other way round — because "Most Recent" is what a
    // person would say and they have no reason to know which of a page's selects holds it. A
    // selector is accepted for pages carrying several with overlapping options.
    let target = null; let opt = null;
    for (const pass of ['exact', 'contains']) {
      for (const s of selects) {
        const hit = [...(s.options || [])].find((o) => (pass === 'exact'
          ? (norm(o.textContent) === wl || norm(o.value) === wl)
          : norm(o.textContent).includes(wl)));
        if (hit) { target = s; opt = hit; break; }
      }
      if (target) break;
    }
    if (!target) {
      // NAME WHAT WAS ON OFFER. A refusal that lists the options turns one failed call into the
      // answer, instead of sending the caller back to read markup.
      return { error: 'NO_OPTION',
        choose: want.slice(0, 120),
        selects: selects.length,
        offered: selects.slice(0, 4).map((s) => ({
          at: readOne(s).label || '',
          options: [...(s.options || [])].slice(0, 14).map((o) => String(o.textContent || '').trim()),
        })),
        tell: 'no option reads that way. Pick one of the names above, or pass a selector if the '
          + 'page carries several selects' };
    }
    const waitMs = Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, Number(op.waitMs) || CHOOSE_WAIT_MS));
    const read = String(op.read || '');
    // A SIGNATURE, TAKEN BEFORE AND AFTER, so `changed` is measured rather than assumed. When the
    // caller names `read` that is the signature — the rows they came for. Otherwise fall back to the
    // page's own record-link count, the same coarse signal `page_grow` reports.
    const snap = () => {
      if (read) {
        let hits = [];
        try { hits = [...document.querySelectorAll(read)]; } catch (_) { hits = []; }
        return JSON.stringify(hits.slice(0, 8).map(readOne));
      }
      return String(countRecordLinks());
    };
    const was = { option: String(target.value), sig: snap() };
    try {
      target.value = opt.value;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      return { error: 'REFUSED', why: String(e && e.message).slice(0, 160) };
    }
    await new Promise((r) => setTimeout(r, waitMs));
    const sigAfter = snap();
    const out = {
      chose: String(opt.textContent || '').trim().slice(0, 120),
      value: String(opt.value).slice(0, 80),
      wasValue: was.option.slice(0, 80),
      // A CHOICE THAT CHANGED NOTHING IS NOT A CHOICE THAT WORKED. Reported honestly, because a
      // widget that re-renders asynchronously past the wait looks identical to one that ignored the
      // event, and the caller has to know which to suspect.
      changed: sigAfter !== was.sig,
      via: read ? 'read' : 'recordLinks',
    };
    if (read) {
      let hits = [];
      try { hits = [...document.querySelectorAll(read)]; } catch (_) { hits = []; }
      out.read = hits.slice(0, 60).map(readOne);
      out.readCount = hits.length;
    }
    if (!out.changed) {
      out.tell = 'the option was selected and the page looked the same afterwards. Either the widget '
        + 're-renders slower than waitMs — raise it — or it listens for something other than change. '
        + 'Read the region again before trusting this.';
    }
    return out;
  }

  // Shared by `walkSite` and the `walkbox`/`walkAfter` actions below, so a control found by
  // `text` resolves the SAME way whether it is about to be clicked in-page or measured for a
  // real press from outside. `null` distinguishes a bad selector from a selector that simply
  // matched nothing.
  function resolveWalkTargets(sel, words) {
    if (!sel) return words ? byWords(words) : [];
    try { return [...document.querySelectorAll(sel)]; } catch (_) { return null; }
  }

  async function walkSite(op) {
    // `choose` is a single deliberate act, not a survey, so it returns here rather than entering the
    // press loop — and it deliberately does NOT come back afterwards: the point of choosing a sort
    // is that the next read sees the new order.
    if (op.choose) return chooseOption(op);

    const sel = String(op.selector || '');
    const words = String(op.text || '');
    if (!sel && !words) {
      return { error: 'NO_SELECTOR',
        why: 'page_grow mode:"walk" needs either a selector or `text` naming what to press, in the words a '
          + 'person would read on the control' };
    }
    let all = resolveWalkTargets(sel, words);
    if (all === null) {
      return { error: 'BAD_SELECTOR', selector: sel.slice(0, 200) };
    }
    if (!all.length) {
      return sel
        ? { error: 'NO_MATCH', selector: sel.slice(0, 200),
          tell: 'call page_study or page_state @dom(...) to see what this page offers' }
        : { error: 'NO_MATCH', text: words.slice(0, 120),
          tell: 'nothing pressable reads that way. page_state "@dom(button, a, [role=button])" '
            + 'lists what this page offers, including icon controls whose only name is an aria-label' };
    }
    const read = String(op.read || '');
    const from = Math.max(0, Number(op.offset) || 0);
    const cap = Math.min(Math.max(1, Number(op.limit) || WALK_CAP), WALK_CAP_MAX);
    const waitMs = Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, Number(op.waitMs) || WALK_WAIT_MS));
    // Default ON: a walk is a survey, and a survey that moves the furniture is not repeatable.
    // Pass back:false to end on the last thing pressed — which is what you want when the walk is
    // how you GOT somewhere rather than what you came to learn.
    const back = op.back !== false;
    const rows = [];
    const stop = Math.min(all.length, from + cap);
    for (let i = from; i < stop; i++) {
      let live = all[i];
      if (!live || !live.isConnected) {
        const again = resolveWalkTargets(sel, words);
        all = again && again.length ? again : all;
        live = all[i] || null;
      }
      if (!live) { rows.push({ at: i, error: 'GONE', why: 'the page replaced it mid-walk' }); continue; }
      const was = location.href;
      let readBefore = null;
      if (read) {
        try { readBefore = JSON.stringify([...document.querySelectorAll(read)].slice(0, 60).map(readOne)); }
        catch (_) { readBefore = null; }
      }
      const named = readOne(live);
      // A plain click, on an element the caller named. Nothing is executed and nothing is typed —
      // this is the same gesture `studypress` already makes, repeated. It IS an untrusted click
      // (`isTrusted: false`) — see the note by `cdpClick` in the worker — which most sites never
      // notice and a few, closure-compiled ones (Gmail's pager among them) quietly ignore. `changed`
      // below is what lets a caller outside the page tell the difference and only pay for a real
      // press when this one genuinely did nothing.
      try { live.click(); } catch (_) { /* an element that refuses a click is a real answer */ }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, waitMs));
      const row = { at: i, url: location.href, title: document.title,
        moved: location.href !== was };
      const label = named.label || named.text || '';
      if (label) row.pressed = label.slice(0, 200);
      if (read) {
        let hits = [];
        try { hits = [...document.querySelectorAll(read)]; } catch (_) { hits = []; }
        row.read = hits.slice(0, 60).map(readOne);
        row.readCount = hits.length;
      }
      // A GENERAL "did the page change" signature sounds like the obvious second signal and is
      // not a safe one: measured on a live rail of 23 pressable rows, comparing the page's own
      // visible text before and after each press reported six real, successful presses as
      // "changed: false" — those controls recorded state with no visible text of their own — and
      // each one then got pressed a SECOND time for real, which is worse than the bug this exists
      // to fix. So `read` is the only source of truth here: named because the caller already knows
      // where this control's effect shows up, its comparison cannot be fooled by an unrelated part
      // of the page moving. Without `read`, the free click is trusted at face value — `moved` is
      // the only failure this can safely see, and a silent failure elsewhere goes unescalated
      // rather than risk a false one everywhere.
      const readAfter = read ? JSON.stringify(row.read) : null;
      row.changed = row.moved || (read ? readBefore !== readAfter : true);
      // AND COME BACK, because a walk that does not is a walk you can only run once.
      //
      // Pressing the fourth of twenty-three things leaves the page somewhere else, and every
      // remaining press is then aimed at a rail that may not exist. Worse for a person: the tool
      // silently relocated the tab they were reading. Returning makes the walk repeatable, makes
      // each destination independent of the last, and leaves them where they started.
      //
      // Two ways back, because there are two ways in: a route change is undone with history.back,
      // and a panel or modal — which changes nothing in the URL — is dismissed with Escape, the
      // gesture every such surface already listens for. Both are fixed gestures; nothing is
      // executed and nothing typed. `returned` reports honestly whether it worked, so a caller is
      // never told a walk was clean when it was not.
      //
      // SKIPPED WHEN NOTHING CHANGED. Coming back undoes a real navigation or dismisses a real
      // panel — on a press that had no effect there is nothing to undo, and running it anyway
      // would risk pressing Escape on a completely unrelated surface for no reason.
      if (back && row.changed) {
        if (location.href !== was) {
          try { history.back(); } catch (_) { /* reported by `returned` below */ }
        } else {
          try {
            document.activeElement?.blur?.();
            document.dispatchEvent(new KeyboardEvent('keydown',
              { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
          } catch (_) { /* same */ }
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, Math.min(BACK_WAIT_MAX_MS, Math.max(BACK_WAIT_MIN_MS, waitMs / 2))));
        row.returned = location.href === was;
      }
      rows.push(row);
    }
    return {
      selector: sel.slice(0, 200),
      ...(read ? { read: read.slice(0, 200) } : {}),
      total: all.length,
      from,
      shown: rows.length,
      ...(from + rows.length < all.length ? { next: from + rows.length } : {}),
      moved: rows.filter((r) => r.moved).length,
      rows,
    };
  }

  // HARVEST A LIST THAT RECYCLES — the tool for "give me the whole history".
  //
  // Everything else here assumes a list GROWS: read it, scroll, read again, and the second read is
  // a superset of the first. A virtualized list breaks that assumption completely. Measured on a
  // Discord channel that has been running since July 2019: the scroller was driven from the very
  // first message forward, and `containerRows` read 15, then 15, then 15 — so the hop loop
  // concluded "two hops in a row brought nothing new" and stopped, on a channel with seven years
  // of backlog. Nothing was wrong with the scrolling. The list had moved; it had simply not got
  // longer, because a recycler reuses the same handful of nodes.
  //
  // So this reads AT EVERY STEP and keeps what it sees, instead of scrolling first and reading at
  // the end — by which time the rows are gone. Three consequences worth stating:
  //
  //   - IDENTITY, NOT COUNT, decides whether progress was made. Rows are keyed by their own id
  //     attribute where they have one (Discord's `chat-messages-<channel>-<id>` is perfect), and
  //     by a hash of their text where they do not. Fresh keys mean progress; a step that yields
  //     none is a dry step, and `dry` consecutive dry steps end the harvest.
  //   - IT STEPS, IT DOES NOT JUMP. Driving straight to the far end skips everything in between,
  //     which is invisible when the list grows and fatal when it recycles. One viewport at a time,
  //     with an overlap, so no row can fall between two reads.
  //   - IT IS BOUNDED AND HONEST. `hops` caps the work, and the reply says whether it stopped
  //     because the list ended (`dry`) or because it ran out of hops (`capped`) — those are very
  //     different answers to "is this all of it?" and must never be reported as the same thing.
  // A SCROLL POSITION IS NOT A GESTURE, and this is the only thing in the engine that knows it.
  // Hoisted out of `collectRows` so a caller who is NOT reading the DOM can still move a list
  // properly: feed mode takes its rows from the responses a scroll causes, and needs the scroll to
  // be one an app will actually answer — assigning scrollTop moves the pane and fetches nothing.
  // Kept as one function rather than copied, so the wheel/PageDown/scroll trio stays in one place.
  const gesture = (el, dy) => {
    const target = el || document.scrollingElement || document.body;
    try {
      target.dispatchEvent(new WheelEvent('wheel', {
        deltaY: dy, deltaX: 0, deltaMode: 0, bubbles: true, cancelable: true, composed: true,
      }));
    } catch (_) { /* an element that refuses it is a real answer */ }
    try {
      const key = dy < 0 ? 'PageUp' : 'PageDown';
      const code = dy < 0 ? 33 : 34;
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true, composed: true,
      }));
    } catch (_) { /* same */ }
    try { target.dispatchEvent(new Event('scroll', { bubbles: false })); } catch (_) { /* same */ }
  };

  async function collectRows(op) {
    const sel = String(op.selector || '');
    if (!sel) return { error: 'NO_SELECTOR', why: 'page_state path:"@collect(<rows css>)" needs a selector for the rows' };
    const pane = String(op.pane || '');
    let scroller = null;
    if (pane) {
      try { scroller = document.querySelector(pane); } catch (_) { scroller = null; }
      if (!scroller) return { error: 'NO_MATCH', selector: pane.slice(0, 200), which: 'pane' };
    }
    let probe = [];
    try { probe = [...document.querySelectorAll(sel)]; } catch (e) {
      return { error: 'BAD_SELECTOR', selector: sel.slice(0, 200),
        why: String(e && e.message).slice(0, 160) };
    }
    if (!probe.length) return { error: 'NO_MATCH', selector: sel.slice(0, 200), which: 'rows' };
    if (!scroller) scroller = scrollerFor(probe[0]);
    const up = String(op.direction || 'down').toLowerCase() === 'up';
    const hops = Math.max(1, Math.min(COLLECT_HOPS_MAX, Number(op.hops) || COLLECT_HOPS));
    const waitMs = Math.min(COLLECT_WAIT_MAX_MS, Math.max(COLLECT_WAIT_MIN_MS, Number(op.waitMs) || COLLECT_WAIT_MS));
    const cap = Math.min(Math.max(COLLECT_CAP_MIN, Number(op.limit) || COLLECT_CAP), COLLECT_CAP_MAX);
    const DRY = Math.max(2, Math.min(COLLECT_DRY_MAX, Number(op.dry) || COLLECT_DRY));

    const seen = new Set();
    const rows = [];
    const want = Array.isArray(op.fields) ? op.fields.filter(Boolean).map(String) : [];
    // A BACKGROUND TAB RUNS NO ANIMATION FRAMES, AND AN INFINITE LIST LOADS ON ONE.
    //
    // Chrome stops `requestAnimationFrame` in a tab nobody is looking at, and IntersectionObserver
    // rides the same scheduling — which is how a lazy list is built. So the gesture fires, the pane
    // genuinely moves, the sentinel never reports intersecting, and NOTHING loads. Measured on a
    // live search page: scrollTop went 572 -> 1144 -> 1716 -> 2288 -> 2860 -> 3136 with `fresh: 0`
    // on every hop, while the same page scrolled by hand loaded fine. The tab was `active: false`
    // throughout, and that was the whole difference.
    //
    // `keepFrames` revives the frame chains without CDP — no debugger, no yellow banner, and no
    // stealing focus from whatever the person is actually doing. Only disarmed again if this call
    // is what armed it, so a pass that is already keeping frames alive is left alone.
    // ARMED ONLY IF THE KEEPER IS ALREADY IN THE PAGE. `raf.js` is not a passive observer: it
    // swallows events at capture phase on window and wraps setTimeout/setInterval. Injecting it
    // into a live page to "help" a lazy list can suppress the very events that list waits on —
    // which is what happened here: `frames: absent` grew a storefront to 155, and `frames: armed`
    // via late injection gave exactly 10 on every query. So this ASKS, and never installs.
    const framesBefore = window[RAF] && window[RAF].on;
    const framesNow = window[RAF] ? keepFrames(true) : 'absent';
    const releaseFrames = () => { if (!framesBefore && window[RAF]) keepFrames(false); };
    // A row's own identity. An id attribute is the app telling us what this row IS, which beats
    // any hash; text is the fallback for markup that carries none.
    const keyOf = (el) => {
      const id = el.getAttribute && (el.getAttribute('id') || el.getAttribute('data-item-id')
        || el.getAttribute('data-list-item-id'));
      if (id) return 'id:' + id;
      const t = String(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160);
      return 't:' + t;
    };
    const harvest = () => {
      let hit = [];
      try { hit = [...document.querySelectorAll(sel)]; } catch (_) { hit = []; }
      let fresh = 0;
      for (const el of hit) {
        if (rows.length >= cap) break;
        const k = keyOf(el);
        if (!k || k === 't:' || seen.has(k)) continue;
        seen.add(k);
        // `fields` APPLIES HERE TOO, AND THIS IS THE PATH THAT NEEDED IT MOST.
        //
        // @dom was taught to honour `fields` because REPLY_TOO_BIG advertises it; @collect was not,
        // and @collect is the one that actually overflows — it accumulates across every hop, so its
        // reply grows without bound while @dom's is one screenful. Measured on a live search page:
        // `fields:["href"]` still returned href, img, key and text on every row, and the reply that
        // broke the budget at 85 rows was this call. `key` is kept regardless: it is the row's
        // identity and dropping it would make the de-duplication invisible to the caller.
        const full = { ...readOne(el), key: k };
        if (!want.length) { rows.push(full); } else {
          const lean = { key: k };
          for (const f of want) lean[f] = Object.prototype.hasOwnProperty.call(full, f) ? full[f] : null;
          rows.push(lean);
        }
        fresh++;
      }
      return fresh;
    };

    // A SCROLL POSITION IS NOT A GESTURE, AND SOME APPS ONLY LISTEN FOR THE GESTURE.
    //
    // Assigning `scrollTop` moves the pane and fires a native `scroll` event, which is enough for
    // any list that loads on scroll. It is NOT enough for a list that loads on INPUT. Measured on a
    // Discord channel, driven forward from its first message: the pane went 939 -> 1408 -> 1877 ->
    // 2346 -> 2578 and the app fetched nothing — ten hops, `fresh: 0` every time. The pane went
    // where it was put and the application never noticed, because what it watches for is a person
    // moving a wheel.
    //
    // So when a step moves the pane and still yields nothing, the same distance is re-sent as real
    // input. Deliberately generic, and in this order because it is cheapest-first:
    //   - `wheel` — what a trackpad or mouse sends, and what custom scrollers overwhelmingly bind.
    //   - `keydown` PageUp/PageDown — what a keyboard user sends; some lists bind only this.
    //   - a manual `scroll` on the container, for handlers attached to the element rather than the
    //     document, which a programmatic assignment can miss when the app re-anchors first.
    // Untrusted events cannot scroll the page themselves — that is a browser rule and not something
    // to work around — so this is not a way to move a pane. It is a way to TELL an app the pane
    // moved, which is the part that was missing. No site knowledge, no selectors, no exceptions.

    harvest();
    const perHop = [];
    let dryRun = 0;
    let ran = 0;
    let ended = 'capped';
    // A MANAGED SCROLLER REFUSES A BIG JUMP AND ACCEPTS A SMALL ONE.
    //
    // Discord's list re-anchors scrollTop after every React commit: asked to go to 3299 it came
    // back to 2712 and stayed there, twice, which reads exactly like "the list has ended". It has
    // not — the assignment was overruled. So a step that produces no movement is halved and tried
    // again rather than counted as the end; only a step small enough to be uncontroversial that
    // STILL does not move is evidence of a real boundary.
    let view0 = (scroller ? scroller.clientHeight : window.innerHeight) || VIEW_FALLBACK_PX;
    let step = Math.max(STRIDE_MIN_PX, Math.floor(view0 * STRIDE_FRAC));
    for (let i = 0; i < hops && rows.length < cap; i++) {
      ran++;
      const at = scroller ? scroller.scrollTop
        : (window.scrollY || document.documentElement.scrollTop || 0);
      const want = up ? Math.max(0, at - step) : at + step;
      // scrollBy where it exists: it is a relative request, which a re-anchoring component fights
      // less than an absolute one, and it falls back cleanly.
      if (scroller && typeof scroller.scrollBy === 'function') scroller.scrollBy(0, want - at);
      else if (scroller) scroller.scrollTop = want;
      else window.scrollTo(0, want);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, waitMs));
      let fresh = harvest();
      let now = scroller ? scroller.scrollTop
        : (window.scrollY || document.documentElement.scrollTop || 0);
      // Moved but learned nothing: the app is listening for input, not for position. Say it again
      // in the language it speaks, then give it the same time to answer.
      let told = false;
      if (!fresh) {
        gesture(scroller, up ? -step : step);
        told = true;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, waitMs));
        fresh = harvest();
        now = scroller ? scroller.scrollTop
          : (window.scrollY || document.documentElement.scrollTop || 0);
      }
      const stuck = Math.abs(now - at) < 2;
      perHop.push({ hop: i + 1, fresh, total: rows.length, at: Math.round(now), step, stuck,
        ...(told ? { gestured: true } : {}) });
      if (fresh > 0) {
        dryRun = 0;
        step = Math.max(STRIDE_MIN_PX, Math.floor(view0 * STRIDE_FRAC));   // back to full stride once it is moving
        continue;
      }
      // Nothing new AND the pane could not move. Before believing that, try a smaller step — a
      // re-anchoring scroller overrules a big jump and lets a small one through.
      if (stuck && step > STRIDE_HALVE_ABOVE_PX) { step = Math.floor(step / 2); continue; }
      if (stuck && ++dryRun >= DRY) { ended = 'dry'; break; }
      if (!stuck) dryRun = 0;
    }
    if (rows.length >= cap) ended = 'limit';
    releaseFrames();
    // THE REPLY IS A WINDOW ON WHAT WAS COLLECTED, NOT THE COLLECTION ITSELF.
    //
    // These used to be one number: `limit` capped the walk, and every collected row went into
    // the reply. So a caller keeping the reply inside its budget also capped how far the list
    // could be scrolled — and once the DOM already held that many rows, the next call ended
    // `limit` with `hopsRun: 0`, having scrolled nothing at all. From outside, that is
    // indistinguishable from the site refusing to load more, and it got reported as exactly
    // that. Measured live: `collected: 50`, cap 50, `hopsRun: 0`, thousands of products behind.
    // DEFAULT IS EVERYTHING. `@collect`'s contract is that it hands back every record it gathered,
    // and a window that appeared without being asked for would be exactly the silent truncation
    // this file refuses everywhere else. `reply` is opt-in; without it nothing changes.
    const rTake = Math.max(1, Math.min(5000, Number(op.reply) || rows.length));
    const rFrom = Math.max(0, Math.min(rows.length, Number(op.offset) || 0));
    const shown = rows.slice(rFrom, rFrom + rTake);
    return {
      selector: sel.slice(0, 200),
      ...(pane ? { pane: pane.slice(0, 200) } : {}),
      direction: up ? 'up' : 'down',
      hopsAsked: hops,
      hopsRun: ran,
      collected: rows.length,
      ended,
      frames: framesNow,
      from: rFrom,
      shown: shown.length,
      ...(rFrom + shown.length < rows.length ? { next: rFrom + shown.length } : {}),
      why: ended === 'dry' ? 'the list stopped producing new rows and the pane stopped moving'
        : ended === 'limit' ? `reached limit ${cap} — raise limit or call again from here`
          : 'ran out of hops — there is very likely more; call again with more hops',
      perHop: perHop.slice(-PER_HOP_KEEP),
      rows: shown,
    };
  }

  // `@map(<scope css>)` — EVERYTHING NAVIGABLE ON THIS PAGE, IN ONE CALL.
  //
  // Written because the tools were answering the wrong question. Each one describes some aspect of
  // the page — what repeats, what an element says, what the store holds — and the caller has to
  // round-trip to assemble meaning from the pieces. Measured: one Discord server's channel list
  // cost roughly five calls (study, read, press, read, press), so twenty-three servers cost about
  // sixty. A person does it by looking at the sidebar.
  //
  // It answers "what can I go to from here?" and does the three things a caller would otherwise do
  // by hand first:
  //   1. EXPANDS. Collapsed categories and Show All / See more / Load more hide real destinations —
  //      pressing ONE disclosure took a Chainlink channel list from 19 to 22. Reading before
  //      expanding silently reports a subset, and nothing in the reply would say so.
  //   2. SEPARATES DECLARED FROM ROUTED. `href` finds only destinations the markup declares;
  //      Discord's Server Guide and Channels & Roles are BUTTONS with no href at all. Those come
  //      back under `controls`, named, so the caller knows to press rather than navigate.
  //   3. NAMES THINGS BY THEIR ACCESSIBLE NAME, since an icon's only name is its aria-label.
  const MAP_PATH = /^@map\((.*)\)$/;
  const HTML_PATH = /^@html\((.+)\)$/;
  const REVEAL = /^\s*(show|see|view|load|display)\s+(all|more)\b|^\s*(more|expand|show all)\s*$/i;
  const nameOf = (el) => {
    const a = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'));
    if (a) return String(a).slice(0, 160);
    const t = String(el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
    return t.slice(0, 160);
  };
  async function mapPage(op, scopeSel) {
    let scope = document.body;
    if (scopeSel) {
      try { scope = document.querySelector(scopeSel) || document.body; } catch (_) { scope = document.body; }
    }
    const linksNow = () => {
      try { return scope.querySelectorAll('a[href]').length; } catch (_) { return 0; }
    };
    // --- 1. expand, until it stops changing -----------------------------------------------------
    const opened = [];
    let rounds = 0;
    for (; rounds < MAP_ROUNDS; rounds++) {
      const before = linksNow();
      let pressedOne = false;
      let shut = [];
      try { shut = [...scope.querySelectorAll('[aria-expanded="false"]')]; } catch (_) { shut = []; }
      for (const el of shut.slice(0, MAP_EXPAND_MAX)) {
        try { el.click(); opened.push(nameOf(el)); pressedOne = true; } catch (_) { /* refused */ }
      }
      // Reveal controls are named by their WORDS, which no CSS selector can express — this is the
      // one place the engine matches on text, and it matches on the accessible name so an
      // icon-and-label button is found the same way a plain one is.
      let btns = [];
      try { btns = [...scope.querySelectorAll('button,[role=button]')]; } catch (_) { btns = []; }
      for (const el of btns) {
        if (!REVEAL.test(nameOf(el))) continue;
        try { el.click(); opened.push(nameOf(el)); pressedOne = true; } catch (_) { /* refused */ }
      }
      if (!pressedOne) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, MAP_SETTLE_MS));
      if (linksNow() === before && !shut.length) break;
    }
    // --- 2. collect ------------------------------------------------------------------------------
    const links = [];
    const seenHref = new Set();
    let anchors = [];
    try { anchors = [...scope.querySelectorAll('a[href]')]; } catch (_) { anchors = []; }
    for (const a of anchors) {
      const href = String(a.href || '');
      if (!href || seenHref.has(href)) continue;
      seenHref.add(href);
      links.push({ name: nameOf(a), href: href.slice(0, 400) });
      if (links.length >= MAP_LINKS_MAX) break;
    }
    // Destinations the markup does NOT declare: pressable things with no href. Named, never
    // guessed at — the caller presses them with page_grow or page_walk and observes where it lands.
    const controls = [];
    const seenName = new Set();
    let press = [];
    try {
      press = [...scope.querySelectorAll('button,[role=button],[role=treeitem],[role=tab],[role=menuitem],[role=option]')];
    } catch (_) { press = []; }
    for (const el of press) {
      if (el.closest && el.closest('a[href]')) continue;
      const n = nameOf(el);
      if (!n || seenName.has(n)) continue;
      seenName.add(n);
      controls.push({ name: n, role: el.getAttribute('role') || el.tagName.toLowerCase() });
      if (controls.length >= MAP_CONTROLS_MAX) break;
    }
    // The repeating structures, so one call also answers "what is extractable here".
    const st = detect(true);
    const lists = (st?.cands || []).map((c) => ({
      label: c.label || '', rows: c.rows.length, selector: pathOf(c.el),
    }));
    return {
      scope: scopeSel ? scopeSel.slice(0, 200) : 'the whole page',
      url: location.href,
      title: document.title,
      expanded: { rounds, pressed: opened.length, names: opened.slice(0, 20) },
      links,
      linkCount: links.length,
      controls,
      controlCount: controls.length,
      lists,
      tell: 'links are navigable directly; controls have NO href and must be pressed to reach '
        + '(page_grow with the selector, or page_grow mode:"walk" to press each and record where it lands)',
    };
  }

  function readSelector(op) {
    const sel = String(op.selector || '');
    if (!sel) return { error: 'NO_SELECTOR', why: 'page_state path:"@dom(<css>)" needs a selector' };
    let all = [];
    try { all = [...document.querySelectorAll(sel)]; } catch (e) {
      return { error: 'BAD_SELECTOR', selector: sel.slice(0, 200), why: String(e && e.message).slice(0, 160) };
    }
    if (!all.length) {
      return { error: 'NO_MATCH', selector: sel.slice(0, 200),
        why: 'nothing on the page matches that selector',
        tell: 'call page_study to see the containers this page offers' };
    }
    // A container was pointed at rather than the rows: one match holding many similar children is
    // the commonest mistake, and answering with one giant blob of text would be useless. Children
    // are read instead, and the reply says so.
    let via = 'the selector itself';
    let list = all;
    if (all.length === 1 && op.children !== false) {
      const kids = [...all[0].children].filter((k) => k.offsetWidth * k.offsetHeight > 0);
      if (kids.length >= 2) { list = kids; via = 'the children of the one element that matched'; }
    }
    const from = Math.max(0, Number(op.offset) || 0);
    const take = Math.max(1, Math.min(READ_LIMIT_MAX, Number(op.limit) || READ_LIMIT));
    const rows = [];
    for (let i = from; i < Math.min(list.length, from + take); i++) {
      const row = readOne(list[i]);
      if (Object.keys(row).length) rows.push(row);
    }
    const seen = from + Math.min(list.length - from, take);
    return {
      selector: sel.slice(0, 200),
      via,
      total: list.length,
      from,
      returned: rows.length,
      ...(seen < list.length ? { next: seen } : {}),
      rows,
    };
  }


