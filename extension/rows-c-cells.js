  // --- highlight ------------------------------------------------------------
  // Confirmation happens on the page, not in a preview pane: the user sees the
  // real thing outlined and knows in one glance whether the guess is right.
  // The outline is drawn in the panel's own signal colour. It used to be violet,
  // which meant the page and the panel were two unrelated colours describing the
  // same selection — the user had to be told they were connected instead of
  // seeing it.
  function ensureStyle() {
    if (document.getElementById(CSS_ID)) return;
    const s = document.createElement('style');
    s.id = CSS_ID;
    s.textContent =
      `.${C_TABLE}{outline:2px solid #ffb648!important;outline-offset:2px;` +
      `background:rgba(255,182,72,.045)!important}` +
      `.${C_ROW}{outline:1px dashed rgba(255,182,72,.55)!important;outline-offset:-1px}`;
    (document.head || document.documentElement).appendChild(s);
  }

  function unpaint() {
    for (const el of document.querySelectorAll('.' + C_TABLE)) el.classList.remove(C_TABLE);
    for (const el of document.querySelectorAll('.' + C_ROW)) el.classList.remove(C_ROW);
  }

  // Scrolling is opt-in, and almost nothing opts in. Detection now runs inside a
  // 2.5-second passive poll, so a paint that moved the viewport fought the user
  // for the scrollbar forever: scroll up, get dragged back down, every poll.
  // Bringing a container into view is only ever right when someone has just
  // asked to be shown that container.
  function paint(c, reveal = false) {
    ensureStyle();
    unpaint();
    if (!c) return;
    c.el.classList.add(C_TABLE);
    // Outline whole rows, which for a definition list means the <dt> and the
    // <dd>s that belong to it — otherwise half of every row looks excluded.
    for (const r of c.rows) for (const part of rowParts(r, c.pair)) part.classList.add(C_ROW);
    if (!reveal) return;
    try { c.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
  }

  // --- cell extraction ------------------------------------------------------
  // No field picker. Every row is walked into a flat {columnKey: value} map,
  // keyed by DOM path, and the user prunes columns afterwards. Capture-then-prune
  // beats select-then-hope: a field that varies per row (sizes, badges, a second
  // image) is present on some rows and absent on others, and picking by hand
  // silently loses it.
  const ownText = (el) => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t.trim().replace(/\s+/g, ' ');
  };

  // Elements a page uses to style a fragment of a sentence, and nothing else. `A` is deliberately
  // absent: a link inside a sentence is a cell in its own right, with an href somebody wants.
  const INLINE_TEXT = new Set(['SPAN', 'B', 'I', 'EM', 'STRONG', 'U', 'SMALL', 'FONT', 'MARK', 'WBR', 'BR']);
  // The longest run this will fold into one cell. A sentence is a cell; a card is not, and without
  // a ceiling a wrapper whose whole subtree happens to be spans would swallow the row.
  const RUN_MAX = 300;

  // Is this element just a styled sentence? Returns the whole text if so, '' otherwise.
  // See the note at the call site in `cellsOf` for the two live cases this exists for.
  //
  // MIXED CONTENT IS THE COMMONEST SENTENCE THERE IS. The first version refused an element with
  // its own text beside inline children, and a search-term highlight is exactly that:
  // alibaba.com, 2026-09-23, <span>VELL Modern … <strong>Led</strong> Bar <strong>Strip</strong>
  // <strong>Light</strong> Skirting …</span> came out as Name = "VELL Modern … Bar Skirting …",
  // Category = "Led", `strong 2` = "Strip" — 95 titles missing the three words the person had
  // searched for. The guards that matter are the ones below (no class, no href, no src, no
  // aria-hidden separator); own text beside such children is prose with emphasis, and the call
  // site returns after `put`, so nothing is counted twice. A single styled child beside own text
  // (`Open <b>now</b>`) is the same sentence and folds too.
  function textRun(el) {
    try {
      if (!el.children.length) return '';
      if (el.children.length < 2 && !ownText(el)) return '';
      const stack = [...el.children];
      let seen = 0;
      while (stack.length) {
        const n = stack.pop();
        if (++seen > RUN_MAX_NODES) return '';                    // too big to be a sentence
        if (!INLINE_TEXT.has(n.tagName)) return '';
        if (n.getAttribute('href') != null || n.getAttribute('src') != null) return '';
        // STYLED, NOT NAMED — the line between "one sentence the page made bold in the middle" and
        // "two different fields that happen to be spans". Both regressions the first version of
        // this caused were the second kind:
        //
        //   the rail's own phone   <span class="UsdlK">(512) 601-6173</span>   -> `Phone` vanished
        //   an arXiv <dd>          <span class="title">…</span><span class="authors">…</span>
        //                                                       -> title and authors became one cell
        //
        // A page that gave a fragment its own CLASS has named it, and a named thing is a field. The
        // Maps snippet spans carry no class at all — only `style="font-weight: 400|500"` — which is
        // the page saying "this is one sentence, part of it is bold". So: no classes anywhere in the
        // run.
        if ((n.getAttribute('class') || '').trim()) return '';
        // And a separator element is a page dividing a LIST of fields, never prose. Maps writes
        // `<span aria-hidden="true">·</span>` between a card's category, address and phone.
        if (n.getAttribute('aria-hidden') === 'true') return '';
        for (const k of n.children) stack.push(k);
      }
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
      return t && t.length <= RUN_MAX ? t : '';
    } catch (_) { return ''; }
  }

  // A row is usually one element. In a definition list it is a <dt> plus every
  // <dd> up to the next <dt>, so both halves have to be walked as one row.
  function rowParts(row, pair) {
    if (pair !== 'dl') return [row];
    const parts = [row];
    for (let n = row.nextElementSibling; n && n.tagName !== 'DT'; n = n.nextElementSibling) {
      if (n.tagName === 'DD') parts.push(n);
    }
    return parts;
  }

  // Which class names describe the STRUCTURE and which describe one card's variant.
  // A column key is a DOM path with every ancestor's classes in it, so a modifier on a
  // wrapper splits one column into several. Measured on mixkit: its cards carry
  // `--masonry-item` (12 rows), `--vertical --masonry-item` (3) and `--4k
  // --masonry-item` (9), which turned eight columns into twenty-four, each row empty in
  // the two families it did not belong to, and the CSV into a staircase.
  //
  // The test is presence across rows, not the shape of the name: a class on nearly every
  // row is part of how this list is built, a class on a third of them is what makes
  // those rows different from each other. Sampled, because learning this does not need
  // every row of two thousand.
  const CLS_SAMPLE = 60;
  const CLS_SHARE = 1;
  function stableClasses(rows) {
    const rs = rows.slice(0, CLS_SAMPLE);
    if (rs.length < MIN_AGREE_ROWS) return null;   // too few to tell a variant from a structure
    const count = new Map();
    for (const r of rs) {
      const here = new Set();
      for (const c of classesOf(r)) here.add(c);
      for (const el of r.querySelectorAll('*')) for (const c of classesOf(el)) here.add(c);
      for (const c of here) count.set(c, (count.get(c) || 0) + 1);
    }
    const need = Math.max(2, rs.length * CLS_SHARE);
    const keep = new Set();
    for (const [c, n] of count) if (n >= need) keep.add(c);
    return keep;
  }

  // What the MARKUP calls a link, gathered per column while the row is walked. This has to
  // happen here because it is the only place with the element in hand — naming columns from
  // the extracted strings alone produced "Website 1" and "Website 2" for a business's own
  // site and its booking vendor, which is the one distinction that matters on a lead list.
  //
  // Four candidates, strongest first. `data-value` is what Maps stamps on its Website
  // button; `aria-label` is what it gives the booking one; `textContent` rather than
  // `ownText` because a button's caption is usually inside a span next to an icon.
  function labelsOf(el) {
    const out = [];
    const push = (v) => {
      // ICON GLYPHS ARE NOT PART OF THE NAME. An icon font renders its symbols from the
      // Unicode PRIVATE USE AREA, and those characters are in `textContent` like any other —
      // so a button with an icon beside its caption produced a column literally headed
      // `Book online` (which is unreadable in a CSV, and mojibake in most spreadsheets).
      // Stripped rather than rejected: the caption beside the glyph is the right answer.
      const s = (v || '').replace(/[\uE000-\uF8FF\uFFFD]/g, '')
        .replace(/\s+/g, ' ').trim();
      if (s && s.length <= LABEL_TEXT_MAX) out.push(s);
    };
    try {
      push(el.getAttribute?.('data-value'));
      push(el.getAttribute?.('aria-label'));
      push(el.getAttribute?.('title'));
      push(el.textContent);
    } catch (_) {}
    return out;
  }

  function cellsOf(row, pair, keep, bag) {
    // A provider that names its own fields skips the structural walk below entirely — see
    // `providerFieldsOf`. Guessing at column names from shared structure is exactly what fails
    // on a list whose rows do not share one.
    const named = providerFieldsOf(row);
    if (named) return named;

    const out = {};
    const seen = new Map();
    let cols = 0;

    function walk(el, path, depth, steps) {
      if (cols >= MAX_COLS_PER_ROW || depth > MAX_DEPTH || (steps || 0) > MAX_STEPS) return;
      const cls = classesOf(el).filter((c) => !keep || keep.has(c)).map((c) => '.' + c).join('');
      const raw = path + '/' + el.tagName.toLowerCase() + cls;
      const n = (seen.get(raw) || 0) + 1;
      seen.set(raw, n);
      const key = n > 1 ? `${raw} ${n}` : raw;

      const put = (suffix, v) => {
        if (!v || cols >= MAX_COLS_PER_ROW) return;
        const k = suffix ? `${key} ${suffix}` : key;
        if (!(k in out)) cols++;
        out[k] = v;
      };

      // Held, because whether this element gave anything decides whether it costs a level. See
      // the descent at the bottom of this function.
      const gave0 = cols;
      put('', ownText(el));
      // currentSrc first: after a responsive <img> settles, it is the URL the
      // browser actually fetched, which is the one worth downloading.
      const src = el.currentSrc || el.getAttribute?.('src');
      if (src) put('src', abs(src));
      const href = el.getAttribute?.('href');
      if (href && !/^javascript:/i.test(href)) {
        put('href', abs(href));
        // Recorded against the column the href lands in, so the naming pass can ask what
        // this particular link calls itself rather than guessing from its host.
        if (bag) {
          const k = `${key} href`;
          if (!bag.has(k)) bag.set(k, []);
          bag.get(k).push(labelsOf(el));
        }
      }
      // Lazy images keep the real URL out of src until they scroll in.
      for (const a of ['data-src', 'data-original', 'data-lazy-src', 'srcset', 'data-srcset']) {
        const v = el.getAttribute?.(a);
        if (v) put(a, a.includes('srcset') ? v.split(',')[0].trim().split(/\s+/)[0] : abs(v));
      }

      // ONE SENTENCE IS ONE CELL, however many spans the page styled it with.
      //
      // Maps BOLDS THE SEARCH TERM inside a rail card's review snippet, which splits the sentence
      // across sibling spans. Captured live on `plumber in Missouri`:
      //
      //   <div class="ah5Ghc ">
      //     <span style="font-weight: 400;">"They did a great job and had are </span>
      //     <span style="font-weight: 500;">plumbing</span>          <- the query term
      //     <span style="font-weight: 400;"> problem fixed in no time."</span>
      //   </div>
      //
      // Walking to the leaves made that three cells, and the first one became `Review`. In the
      // Missouri export 16 of 91 `Review` cells were fragments for exactly this reason — `"Our`,
      // `"They came, fixed my`, and on a review that OPENED with the term, a cell holding nothing
      // but `"`. Only reviews containing the query split, which is why the other 75 looked fine.
      //
      // The same shape produces `Hours` / `Hours 2`: the status line is
      // `<span>Open</span><span> · Closes 6 PM</span>` inside one parent (see the note in
      // `nameCols`), so the card's own string arrived as two columns.
      //
      // So an element that is nothing but a run of inline text children is read WHOLE and not
      // descended into. Deliberately narrow: it must have no own text (or the run would be counted
      // twice), at least two children, and every descendant must be plain inline text — one link,
      // one image, one <div> and it is a structure again and the walk proceeds as before.
      const run = textRun(el);
      if (run) { put('', run); return; }

      // DEPTH IS FOR STRUCTURE, NOT FOR SCAFFOLDING.
      //
      // `MAX_DEPTH` is meant to bound how complicated a card may be. Charged per DOM level it
      // bounds how deeply the card is WRAPPED instead, and those are different things: a grid built
      // out of nested layout columns spends its whole budget on divs that hold nothing.
      //
      // Measured on `amazon.com/s?k=android`, from a card plainly showing a title, a price, a photo
      // and a review count. The engine returned FOUR cells — "5K+ bought in past month", "4.3", and
      // the two anchors' hrefs — and the export came out as three columns. The path of the cells it
      // did reach:
      //
      //   div.sg-col-20-of-24 / div.sg-col-inner / div.s-widget-container / span.a-declarative /
      //   div.puis-card-container / div.a-section / div.puisg-row / div.puisg-col /
      //   div.puisg-col-inner / div.a-section / div.a-section / div.a-row / span
      //
      // Thirteen levels, eleven of them pure wrappers. The title is `<a><h2><span>` and the photo is
      // `<a>…<img>`, both landing one level past the cap — so the walk recorded each anchor's href
      // and stopped exactly short of the thing anybody wanted. "Only 3 cols" is this line.
      //
      // A wrapper is an element that CONTRIBUTED NOTHING — no text of its own, no src, no href, no
      // lazy-image attribute, nothing that added a column — and that has exactly one element child.
      // It is a level of layout, not a level of meaning, so it costs nothing. `MAX_STEPS` still
      // bounds the real recursion, so a pathological DOM cannot run away.
      const kids = [];
      for (const c of el.children) if (!NOT_A_CELL.has(c.tagName)) kids.push(c);
      const wrapper = cols === gave0 && kids.length === 1;
      for (const c of kids) walk(c, key, wrapper ? depth : depth + 1, (steps || 0) + 1);
    }

    for (const part of rowParts(row, pair)) walk(part, '', 0, 0);
    return out;
  }

  // --- naming the columns ---------------------------------------------------
  // A DOM path is not a name, and on a site whose classes are per-build hashes it is not
  // even a hint: Google Maps' rail produced `link 1`, `link 2`, `link 3`, so there was no
  // way to tell the business's own website from its booking link from its directions.
  //
  // THE RULE, and it is one line long: a value that is the SAME on every row is a label;
  // a value that VARIES is data. Maps writes the answer into the markup and we were
  // throwing it away —
  //
  //     <a data-value="Website" href="…">Website</a>      "Website" on all 64 rows
  //     <a href="…">Book online</a>                       "Book online" on all of them
  //     <a href="/maps/place/…" aria-label="Joe's Plumbing">   varies → that is data
  //
  // `cellsOf` already emits an anchor's own text and its href under keys that differ only
  // by the ` href` suffix, so the label is sitting right next to the thing it names. No
  // DOM re-read is needed, which also means the CSV and the JSON get the same names as
  // the table rather than a second implementation of this.
  const NAME_SAMPLE = 40;     // enough rows to see whether a column repeats itself
  const LABEL_SAME = 0.8;     // this share identical, and the column is a caption
  const LABEL_MAX = 28;       // a caption is short; a paragraph that repeats is not
  const SHAPES = [
    // Ordered: the first that claims a clear majority of the column wins. Each test is
    // deliberately narrow — a wrong name is worse than `text 3`, because the user acts
    // on it — so anything ambiguous falls through and keeps the old path-derived label.
    // NO SLASH ON EITHER SIDE OF THE @: https://s.alicdn.com/@sc04/kf/H….jpg is not an address,
    // and on alibaba.com it named eighteen image columns `Email` (2026-09-23).
    ['Email', (v) => /^mailto:/i.test(v) || /^[^@\s/]+@[^@\s/]+\.[a-z]{2,}$/i.test(v)],
    ['Phone', (v) => /^tel:/i.test(v) || (/^[+(]?\d[\d\s().-]{7,}\d$/.test(v) && (v.match(/\d/g) || []).length >= 8)],
    ['Rating', (v) => /^[0-5][.,]\d$/.test(v)],
    ['Reviews', (v) => /^\(\s?[\d,.]{1,9}\s?\)$/.test(v)],
    ['Price', (v) => /^[^\d]{0,4}[\d.,]{2,}[^\d]{0,4}$/.test(v) && /[$€£¥₹]|rp|idr|usd/i.test(v)],
    // A LEADING BULLET IS STILL AN OPENING TIME. Maps writes the card's status as
    // `· Opens 7.30 am Fri`, and anchoring at the first letter meant 71 of 80 rows of real
    // opening times went out as `Text 2 2` on every Indonesian list measured.
    ['Hours', (v) => /^[·•]?\s*(open|closed|opens|closes|24 hours)\b/i.test(v)],
    // ADDRESSES ARE NOT ALL AMERICAN, and this test was: `123 Main St`, a house number then a
    // street type. It matches nothing in Indonesia, Brazil, Turkey or Mexico — the whole target
    // list — so `Jl. Pesantren No.78-76` was nameless on 53 of 80 rows while the rule that exists
    // to name it sat right here.
    //
    // Two forms now: a leading street word (`Jl.`, `Jalan`, `Gg.`, `Rua`, `Av.`, `Calle`,
    // `Sokak`), or the American one kept as it was. Still narrow — a bare number or a bare word
    // matches neither.
    ['Address', (v) => /^(jl\.?|jalan|gg\.?|komplek(s)?|blk\.?|kp\.?|dusun|desa|rua|av(enida)?\.?|r\.|calle|carrera|cra\.?|sokak|sk\.?|cad(desi)?\.?|mah(allesi)?\.?)\s/i.test(v)
      || /^\d+\s+\S+.*\b(st|street|rd|road|ave|avenue|blvd|ln|lane|dr|drive|hwy|way|ct|pkwy|suite|ste)\b/i.test(v)],
    // Google's open location code. Its alphabet excludes vowels and 0/1 so that it cannot be read
    // as a word, which makes it the least ambiguous thing on the card.
    ['Plus code', (v) => /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}(\s|$)/.test(v)],
    // THE CHIPS UNDER THE ADDRESS, and the last thing on a card still going out unnamed. Maps
    // draws one to three of `Delivery`, `Takeaway`, `In-store pick-up`, `Kerbside pickup` per
    // result, in whichever slots that card happens to use — so they land in several columns at
    // once, each holding a MIX. A mixed column is not a caption, which is why the caption rule
    // never claimed them, and no earlier shape describes them either: measured on a live rail
    // they were two columns filled 71 and 16 of 111, headed `Text 4` and `Text 5`.
    //
    // A CLOSED VOCABULARY IS SAFE TO MATCH WHOLE. These are Google's own attribute strings, not
    // free text, so the test is exact-match against the list rather than a pattern — nothing
    // else on a card can accidentally satisfy it. Where the record's own page also yielded
    // services, the two are separated by the source rule below as `Services` and `Services (list)`.
    ['Services', (v) => /^(delivery|takeaway|take ?out|take-out|dine[- ]in|in[- ]store (shopping|pick-?up)|(k|c)urbside pickup|drive[- ]?(through|thru)|same-day delivery|no-contact delivery|online estimates|onsite services|language assistance|pickup available|delivery available|wheelchair[- ]accessible[\w\s-]*)$/i.test(v)],
    // A quoted sentence, on most of the rows: that is a review pulled onto the card. Measured
    // 93 of 120 on a Maps rail, and it was arriving under a hashed class name. Quotes at both
    // ends are the whole test — a continuation fragment with only a closing quote is a second
    // column of the same review and deliberately does not match, because calling that "Review"
    // as well would put two columns under one name and lose them both to the collision rule.
    ['Review', (v) => /^["“].{12,}["”]$/.test(v)],
  ];

  // The candidate that this column's links AGREE on. A label is constant across rows by
  // definition — "Website", "Book online" — while anything carrying the record's own name
  // ("Visit Joe's Plumbing's website") varies and is therefore data, not a caption.
  //
  // Tried in strength order and the first agreeing one wins, so `data-value="Website"`
  // beats a button caption, which beats raw text.
  function agreedLabel(samples) {
    if (!samples || samples.length < MIN_AGREE_ROWS) return '';
    const depth = Math.max(...samples.map((s) => s.length));
    for (let i = 0; i < depth; i++) {
      const seen = new Map();
      let have = 0;
      for (const s of samples) {
        const v = s[i];
        if (!v) continue;
        have++;
        seen.set(v, (seen.get(v) || 0) + 1);
      }
      if (have < MIN_AGREE_ROWS) continue;
      let best = '';
      let n = 0;
      for (const [v, k] of seen) if (k > n) { n = k; best = v; }
      // A caption also has to look like a caption: a couple of words, no URL, no digits
      // doing the work. "Book online" qualifies; "8b0f7a2c-e37c" does not.
      if (n / have >= LABEL_SAME && best.length <= LABEL_MAX
        && /[a-z]/i.test(best) && !/^https?:/i.test(best) && best.split(' ').length <= 4) {
        return best;
      }
    }
    return '';
  }

  // NAME A MAP'S LIST COLUMNS FROM THE PAGE'S OWN TYPED RECORD.
  //
  // The generic namer downstream reads MARKUP, and a 2GIS card gives it nothing to read: measured
  // on a live card, not one `aria-label`, `title` or `data-` attribute on any text leaf, and the
  // class names are build hashes. So eleven columns came out `Text 1 … Text 11` with the street
  // address in `Text 2` and the category in `Text 4`.
  //
  // The page knows, though. `window.initialState` carries a typed record per firm id and the card
  // links to its own id, so a column can be named by MATCHING ITS VALUES against that record's
  // fields. By value, never by vocabulary — which is what makes one rule serve `.kz`, `.ru`, `.ae`
  // and `.cz` without a word list per language.
  //
  // ⚠ CALIBRATION, NOT EXTRACTION. `initialState` is the server-rendered bootstrap and it is FROZEN
  // AT PAGE ONE — measured: after clicking to `/page/2` it still answers with page one's twelve
  // records. Reading ROWS from it would re-emit page one forever behind correct-looking headers.
  // What is read here is which COLUMN holds which field, and that is a property of the card
  // TEMPLATE, which every page shares. One calibration names the whole walk.
  //
  // Scored across rows and assigned one-to-one, greedily, because two columns can look like one
  // field on a single row — a rating of 5 and a branch count of 5 are the same three characters.
  // Agreement across the whole list is what tells them apart, so nothing is named on the strength
  // of one row.
  const NAME_STATE_MIN = 3;      // rows that must agree before a name is believed
  const NAME_STATE_SHARE = 0.6;  // ...and the share of comparable rows they must be
  // A link filled on nearly every row tells a caption rule nothing — everything correlates with
  // it. Only a link that is sometimes absent can lend its name to the caption beside it.
  const DISCRIMINATES = 0.85;

  // WHAT A 2GIS EXPORT ACTUALLY LOOKED LIKE, and none of it was a naming fault.
  //
  //   row 4   every cell "-"                       a promo banner with no `/firm/` link
  //   Phone   "tel:+77775040715"                   the href, not the number
  //   Address "\u200bУлица Минусинская, 17"        a zero-width space glued to the front
  //   Website 4000 chars of link.2gis.com/<base64> a click tracker, not a website
  //   Page    /firm/700…?stat=<base64>             our own recorded link, plus telemetry
  //
  // Four are cell-level and one is row-level, and every one of them is a fact about the
  // PROVIDER — so they are declared in the descriptor (`tidy`) rather than assumed here, and
  // this runs BEFORE naming: a banner row must not vote on what a column is, and the value the
  // record gets matched against must be the tidied one.
  function tidyRows(cols, rows) {
    const spec = (PROVIDERS[mapKind()] || {}).tidy;
    if (!spec || !rows.length) return;

    // THE TRACKER CARRIES ITS OWN DESTINATION. `link.2gis.com/4.2/<hash>/<base64>` — the base64
    // is the click payload and its FIRST LINE is the real URL the button goes to. Decoded, four
    // thousand characters of telemetry become `http://www.instagram.com/realservicealmaty/`.
    // Verified against nine live cards: instagram, wa.me, and the firms' own domains.
    const unwrap = (v) => {
      if (!spec.unwrap || !v.includes(spec.unwrap.host)) return v;
      const tail = v.split('/').pop() || '';
      let b = tail.replace(/%3D/gi, '=');
      try { b = decodeURIComponent(b); } catch (_) {}
      try {
        const first = atob(b.replace(/-/g, '+').replace(/_/g, '/')).split('\n')[0].trim();
        if (/^https?:\/\//i.test(first)) return first;
      } catch (_) {}
      return v;
    };

    const clean = (v) => {
      if (typeof v !== 'string' || !v) return v;
      let out = v;
      // Zero-width characters are invisible and therefore worse than wrong: they defeat a
      // spreadsheet lookup, a dedupe and an eye, all silently.
      if (spec.zeroWidth) out = out.replace(/[\u200b-\u200f\u2060\ufeff]/g, '');
      // `tel:`/`mailto:` is how a browser is told what to DO with a value, not the value.
      for (const s2 of (spec.schemes || [])) {
        if (out.toLowerCase().startsWith(s2)) out = decodeURIComponent(out.slice(s2.length));
      }
      out = unwrap(out);
      // Query parameters that are ours or theirs, never the user's. `?stat=` is 2GIS telemetry
      // riding on the link we recorded; it changes per session, so it also breaks dedupe.
      if ((spec.dropQuery || []).length && /^https?:/i.test(out)) {
        for (const q of spec.dropQuery) {
          out = out.replace(new RegExp('([?&])' + q + '=[^&]*', 'gi'), '$1');
        }
        out = out.replace(/[?&]+$/, '').replace(/\?&/, '?');
      }
      return out.trim();
    };

    for (const r of rows) for (const k of Object.keys(r)) r[k] = clean(r[k]);

    // AND THE BANNER ROWS. Only where the list is genuinely a list of records — measured on the
    // rows themselves rather than assumed, so a page whose cards simply have no record link
    // keeps every one of them.
    const rx = spec.mustMatch && new RegExp(spec.mustMatch);
    if (!rx) return;
    const has = (r) => Object.values(r).some((v) => typeof v === 'string' && rx.test(v));
    const keep = rows.filter(has);
    if (keep.length >= rows.length * TIDY_KEEP_SHARE && keep.length < rows.length) {
      rows.length = 0;
      rows.push(...keep);
    }
  }

  // ONE CARD TEMPLATE'S COLUMN IS ANOTHER'S, and on 2GIS that is not a corner case — it is the
  // top result on every search.
  //
  // A 2GIS list mixes templates: the premium advert at position one is built differently from the
  // eleven below it, so its cells sit at different DOM paths and fork into their own columns. Read
  // off a live page-one table, every one of these filled on exactly ONE row:
  //
  //     (Text N)  1  "http://www.instagram.com/realservi"   row 1's Website
  //     (Text N)  1  "Мы делаем Mercedes-Benz и другие…"    row 1's Description
  //     (Text N)  1  "Реклама"                              row 1's Реклама
  //     (Text N)  1  "Наш инстаграм"                        row 1's Website label
  //
  // The table then reports `Description` filled 11 of 12 and `Реклама` 10 of 12 and the export
  // shows the top result with neither — its data present, in storage, under a header nobody can
  // read. `take: 2` already fixes exactly this for `Address`; it is just not only the address.
  //
  // TWO CONDITIONS, BOTH REQUIRED, because a wrong merge silently overwrites a column:
  //   disjoint — the named column must be EMPTY on every row the orphan fills. Two columns that
  //              are both present anywhere are two different facts, whatever they look like.
  //   alike    — and they must look like the same kind of thing. Disjointness alone would pour
  //              any minority-template cell into whichever column happened to have a gap.
  function mergeTemplates(cols, rows) {
    const spec = (PROVIDERS[mapKind()] || {}).listNames;
    if (!spec || rows.length < TEMPLATE_MIN_ROWS) return;
    const at = (c) => rows.map((r) => {
      const v = r[c.key];
      return v == null || String(v).trim() === '' ? '' : String(v).trim();
    });
    const med = (xs) => {
      const n = xs.map((x) => x.length).filter(Boolean).sort((a, b) => a - b);
      return n.length ? n[Math.floor(n.length / 2)] : 0;
    };
    const orphans = cols.filter((c) => !c.name && !c.key.startsWith('@'));
    for (const u of orphans) {
      const uv = at(u);
      const un = uv.filter(Boolean).length;
      // A minority template only. A column filled on half the list is not an overflow slot.
      if (!un || un > rows.length * TEMPLATE_MINORITY_SHARE) continue;
      let win = null;
      let score = 0;
      for (const n of cols) {
        if (!n.name || n === u || n.kind !== u.kind || n.key.startsWith('@')) continue;
        const nv = at(n);
        if (uv.some((v, i) => v && nv[i])) continue;          // disjoint, or not a candidate
        if (!nv.filter(Boolean).length) continue;
        let sc = 0;
        const one = [...new Set(uv.filter(Boolean))];
        const url = (xs) => xs.filter(Boolean).every((v) => /^https?:\/\//i.test(v));
        // A badge says its own name. `Реклама` under a column already called `Реклама` is the
        // same column, and nothing else can score this highly.
        if (one.length === 1 && one[0] === n.name) sc = 100;
        // A LINK MUST LOOK LIKE THE LINKS IT JOINS. Kind alone was not enough and produced a
        // genuinely wrong table: `Phone` is link-kind, but after tidying its values are bare
        // numbers — so the top card's `instagram.com/realservicealmaty` scored the same against
        // `Phone` as against `Website` and took whichever came first. The export then carried a
        // URL under `Phone` and «Наш инстаграм» under `Phone label`. Both sides must be URLs.
        else if (u.kind === 'link') sc = url(uv) === url(nv) ? 40 : 0;
        // PROSE JOINS PROSE, and nothing else joins anything. A length band alone let «Закроется
        // через 38 минут» — opening hours, which no column here is for — merge into `Website
        // label` because both were short text. A short unnamed column stays unnamed: a missing
        // value is recoverable, a value filed under the wrong heading is not.
        else if (med(uv) >= PROSE_MIN_LEN && med(nv) >= PROSE_MIN_LEN) sc = 60;
        if (sc > score) { score = sc; win = n; }
      }
      if (!win || !score) continue;
      for (let i = 0; i < rows.length; i++) if (uv[i]) rows[i][win.key] = rows[i][u.key];
      for (const r of rows) delete r[u.key];
      u.merged = true;
      win.filled = at(win).filter(Boolean).length;
    }
  }

  function nameFromState(cols, rows) {
    const spec = (PROVIDERS[mapKind()] || {}).listNames;
    if (!spec || !rows.length) return;
    let state;
    try { state = window[spec.global]; } catch (_) { return; }
    let node = state;
    for (const step of String(spec.path || '').split('.')) node = node && node[step];
    if (!node || typeof node !== 'object') return;
    const idRe = new RegExp(spec.id);

    const flat = (rec, at) => {
      let v = rec;
      for (const step of String(at).split('.')) v = v == null ? v : v[step];
      return v;
    };
    // Zero-width joiners and the ↗ glyph 2GIS prefixes its address with would defeat a plain
    // comparison, and they are exactly the sort of thing a card puts in front of a value.
    const norm = (s) => String(s == null ? '' : s)
      .replace(/[​-‏→-↙ ]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const digits = (s) => (String(s == null ? '' : s).match(/\d+/g) || []).join('');

    // The record behind each row, found through the row's own link.
    const recOf = rows.map((r) => {
      for (const v of Object.values(r)) {
        const m = typeof v === 'string' && idRe.exec(v);
        if (m) { const p = node[m[1]]; return (p && p.data) || null; }
      }
      return null;
    });
    if (!recOf.some(Boolean)) return;

    // Every string under a subtree, for a field whose wording differs from the card's. The award
    // chip reads «Номинант 2026» while the record files it under a group called «Премия 2ГИС» —
    // one fact, two spellings, so only a subtree match finds it.
    const deepStrings = (v, out = [], depth = 0) => {
      if (depth > DEEP_STRINGS_DEPTH || out.length > DEEP_STRINGS_MAX) return out;
      if (typeof v === 'string') { if (v.trim()) out.push(v); return out; }
      if (Array.isArray(v)) { for (const x of v) deepStrings(x, out, depth + 1); return out; }
      if (v && typeof v === 'object') for (const x of Object.values(v)) deepStrings(x, out, depth + 1);
      return out;
    };

    const scores = [];
    for (const f of (spec.fields || [])) {
      // `link: true` lets a field name a LINK column — the branch list is `/branches/<org.id>`,
      // and the id is in the record, so the href is evidence like any other cell.
      const open = cols.filter((c) => !c.key.startsWith('@')
        && (f.link ? c.kind === 'link' : c.kind === 'text'));
      for (const c of open) {
        let hit = 0, seen = 0;
        for (let i = 0; i < rows.length; i++) {
          const rec = recOf[i];
          if (!rec) continue;
          const cell = rows[i][c.key];
          if (cell == null || cell === '') continue;
          if (f.deep) {
            const pool = deepStrings(flat(rec, f.at)).map(norm).filter(Boolean);
            if (!pool.length) continue;
            seen++;
            const a = norm(cell);
            if (a && pool.some((b) => a.includes(b) || b.includes(a))) hit++;
            continue;
          }
          const want = flat(rec, f.at);
          if (want == null || want === '') continue;
          seen++;
          if (f.num) { const d = digits(cell); if (d && d === digits(want)) hit++; continue; }
          const a = norm(cell); const b = norm(want);
          if (b && a && (a.includes(b) || b.includes(a))) hit++;
        }
        if (seen && hit >= NAME_STATE_MIN && hit / seen >= NAME_STATE_SHARE) {
          scores.push({ col: c, field: f, name: f.name, hit, share: hit / seen });
        }
      }
    }
    // Best first, then greedy. One name per column always; a field may claim more than one column
    // only when it says so (`take`), because a 2GIS list mixes two card templates and the address
    // genuinely lives in a different slot on an ad card. The extras are numbered.
    scores.sort((x, y) => (y.share - x.share) || (y.hit - x.hit));
    const tookCol = new Set(); const used = new Map();
    for (const s of scores) {
      if (tookCol.has(s.col.key)) continue;
      const n = used.get(s.name) || 0;
      if (n >= (s.field.take || 1)) continue;
      tookCol.add(s.col.key); used.set(s.name, n + 1);
      s.col.name = n ? `${s.name} ${n + 1}` : s.name;
      s.col.fromState = true;   // so the generic namer below leaves it alone
    }

    // WHAT THE RECORD CANNOT NAME, named from the page's own word.
    //
    // Measured on twelve live records: `is_promoted` is false on every one while eleven cards say
    // «Реклама», and `flags` holds only `{photos:true}` so nothing backs «Подтверждён». Those are
    // card chrome with no typed counterpart, and matching cannot invent one.
    //
    // They need not stay `Text 6`. A column carrying one short literal on nearly every row IS that
    // literal — a badge — so it takes the badge's own text as its name. The page's word, not ours,
    // which is why this needs no vocabulary per language.
    const badge = spec.badges;
    if (badge) {
      for (const c of cols) {
        if (c.name || c.fromState || c.kind !== 'text' || c.key.startsWith('@')) continue;
        const vals = rows.map((r) => r[c.key]).filter((v) => v != null && String(v).trim() !== '');
        if (vals.length < (badge.minRows || BADGE_MIN_ROWS)) continue;
        const top = new Map();
        for (const v of vals) { const s = String(v).trim(); top.set(s, (top.get(s) || 0) + 1); }
        let best = '', n = 0;
        for (const [s, k] of top) if (k > n) { n = k; best = s; }
        if (!best || best.length > (badge.maxLen || BADGE_MAX_LEN)) continue;
        // A BADGE HAS TO BE READABLE. Measured: this named a column `​` — a zero-width space,
        // seven rows of it — producing a header that is blank on screen and unquotable in a bug
        // report. The engine already refuses columns whose content is only a middot or a
        // private-use glyph ("a column that holds no information is not a column"); naming one
        // walked around that rule instead of respecting it. A name needs a letter or a digit.
        if (!/[\p{L}\p{N}]/u.test(best)) continue;
        if (n / vals.length < (badge.share || BADGE_SHARE)) continue;
        // A BADGE IS A WORD, NOT A MEASUREMENT. Read off a real walked export: columns headed
        // `4.9`, `Легковой автосервис` and `Позвонить` — a rating, a category and a call-to-action
        // caption, each promoted to a header because on some page it happened to repeat.
        //
        // A rating that is 4.9 on most of a page is not a column called `4.9`; next week it is
        // 4.8 and the header changes. So a number can never be a badge. Neither can a literal the
        // table ALREADY holds under a name — `Легковой автосервис` is what `Category` says, and
        // two columns headed by the same fact is how the export stopped being readable.
        if (/^[\d.,\s()+-]+$/.test(best)) continue;
        if (cols.some((o) => o !== c && o.name && rows.some((r) => String(r[o.key] ?? '').trim() === best))) continue;
        c.name = best;
        c.fromState = true;
        // Marked as well as named, because the ordering pass cannot recognise a badge by its
        // name — the name is whatever word the page used, in whatever language. See `rankOf`.
        c.badge = true;
      }
    }

  }

  // Called AFTER `nameCols`, and that order is the point: these rules lean on OTHER columns
  // already having names. `nameFromState` runs first because record-matching is evidence and
  // beats guessing — but the caption rule below needs to know which link column is `Website`,
  // and that name is `nameCols`' work. Run too early it finds no named links and does nothing,
  // which is exactly what it did.
  function nameRoles(cols, rows) {
    const spec = (PROVIDERS[mapKind()] || {}).listNames;
    if (!spec || !rows.length) return;
    // THE LAST FEW, NAMED BY WHAT THEY DO RATHER THAN WHAT THEY SAY.
    //
    // The call-to-action captions («Наш инстаграм», «Позвонить», «Написать в WhatsApp») and the
    // advert's own sentence are neither a record field nor a fixed badge — their VALUES differ on
    // every row, so nothing above can reach them. Their PRESENCE still can.
    const roles = spec.roles;
    if (!roles) return;
    {
      const has = (c) => rows.map((r) => {
        const v = r[c.key]; return v != null && String(v).trim() !== '';
      });
      const left = () => cols.filter((c) => !c.name && !c.fromState
        && c.kind === 'text' && !c.key.startsWith('@'));

      // The advert's sentence: the one column of long, mostly-unique prose on the card. Only the
      // longest candidate takes the name — two "Description" headers would be no better than two
      // `Text N`.
      const lg = roles.long;
      if (lg) {
        let best = null, bestLen = 0;
        for (const c of left()) {
          const vals = rows.map((r) => r[c.key]).filter((v) => v != null && String(v).trim() !== '')
            .map((v) => String(v).trim());
          if (vals.length < NAME_STATE_MIN) continue;
          const lens = vals.map((v) => v.length).sort((x, y) => x - y);
          const mid = lens[Math.floor(lens.length / 2)];
          if (mid < (lg.minLen || LONG_MIN_LEN)) continue;
          if (new Set(vals).size / vals.length < (lg.unique || LONG_UNIQUE)) continue;
          if (mid > bestLen) { bestLen = mid; best = c; }
        }
        if (best) { best.name = lg.name || 'Description'; best.fromState = true; }
      }
      // A caption lights up on exactly the rows where the link it captions does: the CTA under a
      // website link is there when there is a website and absent when there is not. So a named
      // link column lends its name — `Website label`, `Phone label`. Structure, not vocabulary.
      //
      // TWO GUARDS, both paid for. A link present on nearly every row CARRIES NO INFORMATION —
      // everything correlates with it — so the first version named the advert's sentence AND the
      // rubric chip `Page label`, twice over, and stole `Description` in the process. A link must
      // therefore discriminate (`DISCRIMINATES`), and each link may lend its name once.
      // A LINK AND THE TEXT INSIDE IT NAME EACH OTHER, and this needs no threshold at all: the
      // rubric chip's own words appear URL-ENCODED in the href beside it, so the pairing is proved
      // rather than inferred. Runs before the correlation rule so a proved pair is never spent on
      // a guessed one.
      for (const h of (spec.hrefs || [])) {
        const L = cols.find((c) => c.kind === 'link' && !c.name
          && rows.some((r) => typeof r[c.key] === 'string' && r[c.key].includes(h.path)));
        if (!L) continue;
        L.name = `${h.name} link`; L.fromState = true;
        const enc = (v) => { try { return encodeURIComponent(String(v)); } catch (_) { return ''; } };
        for (const c of left()) {
          let hit = 0, seen = 0;
          for (const r of rows) {
            const cell = r[c.key]; const href = r[L.key];
            if (!cell || !href || typeof href !== 'string') continue;
            seen++;
            const e = enc(String(cell).trim());
            if (e && href.toLowerCase().includes(e.toLowerCase())) hit++;
          }
          if (seen && hit >= NAME_STATE_MIN && hit / seen >= NAME_STATE_SHARE) {
            c.name = h.name; c.fromState = true; break;
          }
        }
      }

      if (roles.label) {
        const links = cols.filter((c) => c.kind === 'link' && c.name
          && has(c).filter(Boolean).length / rows.length <= DISCRIMINATES);
        const lent = new Set();
        for (const c of left()) {
          const a = has(c);
          const n = a.filter(Boolean).length;
          if (n < NAME_STATE_MIN) continue;
          for (const L of links) {
            if (lent.has(L.key)) continue;
            const b = has(L);
            const both = a.filter((x, i) => x && b[i]).length;
            const either = a.filter((x, i) => x || b[i]).length;
            if (either && both / either >= CAPTION_COOCCUR) {
              c.name = `${L.name} label`; c.fromState = true; lent.add(L.key); break;
            }
          }
        }
      }

    }
  }

  function nameCols(cols, rows, bag) {
    const byKey = new Map(cols.map((c) => [c.key, c]));
    const vals = new Map();
    for (const col of cols) {
      const v = [];
      for (const r of rows) {
        const x = r[col.key];
        if (x != null && x !== '') v.push(String(x));
        if (v.length >= NAME_SAMPLE) break;
      }
      vals.set(col.key, v);
    }

    for (const col of cols) {
      // A field read off a record's own page arrives already named — it was read by asking
      // for a named thing, not by walking markup — so none of the guessing below applies to
      // it. The `@` is the marker and never reaches the user.
      // The `@` marks it as read off the record's page; a trailing ` src`/` href` is what
      // TYPES the column, not part of what it is called. Left in, the header read "Photo src".
      if (col.key.startsWith('@')) {
        col.name = col.key.slice(1).replace(/ (src|srcset|href)$/, '');
        continue;
      }
      // Already named by matching the page's own typed record — which is evidence, not a guess,
      // so the heuristics below must not overwrite it. See `nameFromState`.
      if (col.fromState) continue;

      const v = vals.get(col.key);
      if (v.length < MIN_AGREE_ROWS) continue;

      // 1. A caption column names its neighbour, and is itself worth hiding: a column
      //    reading "Website" sixty-four times carries no information at all.
      if (col.kind === 'text') {
        const top = v.reduce((m, x) => (m.set(x, (m.get(x) || 0) + 1), m), new Map());
        let best = '';
        let n = 0;
        for (const [x, k] of top) if (k > n) { n = k; best = x; }
        if (n / v.length >= LABEL_SAME && best.length <= LABEL_MAX && /[a-z]/i.test(best)) {
          const caption = best.replace(/\s+/g, ' ').trim();
          for (const suffix of ['href', 'src']) {
            const sib = byKey.get(`${col.key} ${suffix}`);
            if (sib && !sib.name) sib.name = caption;
          }
          col.label = true;
          // A CAPTION CAN NAME ITSELF — but only after the link it named has taken the name
          // first, which is why this is remembered rather than applied here. Applied now, the
          // caption column would claim "Website" and the collision rule would strip the actual
          // link of its name: the caption is emitted before the href it sits on.
          //
          // Worth naming because several of these are not captions for a link at all — they
          // are flags. `Sponsored`, `Delivery`, `Online estimates`, `No reviews` each mean
          // something about the row they appear on, and they were all arriving headed by a
          // build hash. They stay hidden by default; a hidden column still deserves a name for
          // when somebody shows it.
          col.caption = caption;
          continue;
        }
      }

      // 2. Otherwise the column's own values say what it is, by majority. One row cannot
      //    decide this: a blank phone or a missing rating is ordinary, and naming a
      //    column off row zero is how "Rating" ends up over the review count.
      for (const [name, test] of SHAPES) {
        let hits = 0;
        for (const x of v) if (test(x.trim())) hits++;
        if (hits / v.length >= SHAPE_SHARE) { if (!col.name) { col.name = name; col.shaped = 1; } break; }
      }

      // 3. What the MARKUP calls this link. Stronger than anything derivable from the URL,
      //    and the only thing that separates two off-site link columns.
      if (!col.name && col.kind === 'link') {
        const said = agreedLabel(bag?.get(col.key));
        if (said) col.name = said;
      }

      // 4. Last resort, and deliberately weak. "External host" is NOT a licence to call a
      //    column Website: on a Maps rail two columns are off-site — the business's own
      //    site and its booking vendor (servicetitan, recreateai) — and naming both of
      //    them the same thing produced "Website 1" and "Website 2", which is worse than
      //    no name at all because it asserts something false about one of them.
      //    So: only claim Website when it is the ONLY off-site link column.
      if (!col.name && col.kind === 'link') {
        let off = 0;
        for (const x of v) {
          try { if (new URL(x).host !== location.host) off++; } catch (_) { /* not a URL */ }
        }
        col.offsite = off / v.length >= OFFSITE_SHARE;
        if (!col.offsite) { col.name = 'Page'; col.record = true; }
      }
    }

    // 5. THE NAME OF THE THING. A record's own link wraps its own title — that is true of
    //    a Maps card (`<a href="/maps/place/…"><span>Beyond Wow Plumbing</span></a>`) and
    //    of every product grid, and it is the column a person looks at first. It was
    //    arriving unnamed and buried past the URLs, which is why a table of 64 businesses
    //    did not appear to have their names in it.
    //
    //    Nested INSIDE the record link, so the key is a prefix match — a title elsewhere
    //    in the card is a heading, and might be the price or the category.
    //
    //    A CARD CAN HAVE MORE THAN ONE ON-SITE LINK. Amazon wraps its thumbnail in its own
    //    `aria-hidden` anchor to the SAME product page, ahead of the title anchor in DOM
    //    order — both get `record: true` at step 4 above. Taking merely the first of them
    //    (the thumbnail) means its prefix search finds no text nested under it at all — an
    //    `<img>` has none — and "Name" never gets assigned, while the real title sits unread
    //    under the sibling link. So every on-site link column is tried, and the one whose own
    //    nested text is actually filled wins, not whichever came first.
    let best = null;
    for (const cand of cols) {
      if (!cand.record) continue;
      const prefix = cand.key.replace(/ href$/, '');
      for (const c of cols) {
        if (c.name || c.kind !== 'text' || !c.key.startsWith(prefix)) continue;
        if (!best || c.filled > best.filled) best = c;
      }
    }
    if (best && best.filled >= MIN_AGREE_ROWS) best.name = 'Name';

    // Applied after every column has spoken, because "the only one" cannot be decided
    // while looking at one column. Two unnamed off-site columns keep their path-derived
    // labels and the user renames them — a dull name is honest, a wrong one is not.
    const offsite = cols.filter((c) => c.offsite && !c.name);
    if (offsite.length === 1) offsite[0].name = 'Website';
    for (const c of cols) delete c.offsite;

    // A picture is a picture. Asset columns are already TYPED — that is what makes them
    // downloadable — so this is only about the header a person reads.
    for (const c of cols) if (!c.name && c.kind === 'asset') c.name = 'Photo';

    // And no two columns may claim the same name. A collision means the evidence was not
    // specific enough to tell them apart, so the weaker one gives its name back rather
    // than becoming "Website 2".
    //
    // WITH ONE EXCEPTION: THE SAME FIELD FROM TWO SOURCES. A record's own page and its list
    // card both carry hours, both carry a rating. Both are real, so neither should lose its
    // name — the header says WHICH SOURCE instead, `(page)` or `(list)`.
    //
    // THE FULLER COLUMN TAKES THE PLAIN NAME, and getting this backwards is worse than not
    // qualifying at all. The first version preferred the detail on the grounds that a record's
    // page says more than its card, which is true of the VALUE and false of the COLUMN: only
    // the rows somebody opened have a detail. Measured on a live rail, that rule produced
    // `Hours` filled 2 of 120 sitting beside `Hours (list)` filled 120 of 120 — the plain,
    // obvious name on the empty column and the qualifier on the one with the data in it.
    //
    // So it is decided by fill. Open every record and the page's copy wins the plain name on
    // its merits; open five and the card keeps it.
    const byFill = [...cols].sort((a, b) => (b.filled || 0) - (a.filled || 0));
    const source = (c) => (c.key.startsWith('@') ? 'page' : 'list');
    const taken = new Map();
    for (const c of byFill) {
      if (!c.name) continue;
      if (!taken.has(c.name)) { taken.set(c.name, c); continue; }
      const held = taken.get(c.name);
      if (source(held) !== source(c)) {
        // ...BUT A SECOND SOURCE THAT ONLY EVER REPEATS THE FIRST IS NOT A SECOND SOURCE.
        //
        // Qualifying by source assumes both sides can say something. `Phone (list)` could not.
        // Measured over 120 Missouri rows, digits compared with the country code off:
        //
        //   Phone / Phone (list)    only Phone 2   only list 0   both 116   identical 116
        //   Phone / Phone (intl)    only Phone 0   only intl 1   both 118   identical 107
        //
        // `Phone (list)` agreed on all 116 rows where both were filled and held a value on **zero**
        // rows `Phone` lacked — it cannot ever add information, so it is a column of pure repetition.
        // `Phone (intl)` differs on 11 rows because it appends numbers found on the business's own
        // site (`+1 816-763-8200 | 9137829669 (site)`), 12 rows carry such extras and 1 row has an
        // intl value where `Phone` is empty. It earns its place, and the same test keeps it.
        //
        // THIS IS A DIFFERENT TEST FROM THE NEVER-CO-OCCUR ONE BELOW, and both are needed: that one
        // catches one field split across two slots (never together), this one catches one field
        // copied into two columns (always together, always agreeing).
        //
        // COMPARED ON DIGITS FOR A PHONE, and that is not a nicety — the raw strings are identical
        // on **0 of 116** rows, because the two sources format differently (`(314) 200-3000` against
        // `+1 314-200-3000`). A plain string comparison would have found nothing and left the
        // duplicate column in place. Last nine digits, so a country code cannot make two writings of
        // one number look like two numbers, and nine is long enough that two real numbers colliding
        // is not a practical concern.
        const norm = /(^|\s)phone(\s|$)/i.test(c.name)
          ? (s) => s.replace(/\D/g, '').slice(-9)
          : (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
        let both2 = 0, agree = 0, weakOnly = 0;
        for (const r of rows) {
          const x = String(r[held.key] == null ? '' : r[held.key]).trim();
          const y = String(r[c.key] == null ? '' : r[c.key]).trim();
          if (x && y) { both2++; if (norm(x) && norm(x) === norm(y)) agree++; } else if (y) weakOnly++;
        }
        if (weakOnly === 0 && both2 >= MERGE_FLOOR && agree === both2) {
          for (const r of rows) delete r[c.key];
          c.merged = held.key;   // dropped from the column list by extractOne
          delete c.name;
          continue;
        }
        const alt = `${c.name} (${source(c)})`;
        if (!taken.has(alt)) { c.name = alt; taken.set(alt, c); continue; }
      }
      // TWO OF A KIND FROM ONE SOURCE ARE STILL BOTH REAL. Giving the name back is right when it
      // was a GUESS — a caption or a hostname is one column's opinion of itself, and two columns
      // holding the same opinion means neither is trustworthy. A SHAPE match is not an opinion:
      // it read the values and 60% of them looked like addresses. A card carrying two address
      // lines produces two address columns, and both of them are addresses.
      //
      // Measured on a live rail: five columns came back unnamed — a second address, a second
      // phone, and two more `Delivery` — every one of them shape-matched, every one of them
      // real, and all five presented to the user as `Text 4`, `Text 5`, junk to be scrolled past.
      if (c.shaped && held.shaped) {
        // ...UNLESS THEY ARE THE SAME FIELD IN TWO DIFFERENT SLOTS, and the rows say which.
        //
        // ASK WHETHER THEY EVER CO-OCCUR. Measured over the user's 106-row export, on four pairs:
        //
        //   pair                          only A   only B   BOTH   verdict
        //   Address / Address 2              68       35      0    one field, two slots
        //   Hours / Hours (page)             10        0     81    two real sources
        //   Services / Services (page)       14        6      1    two real sources
        //
        // `Address` and `Address 2` were never once both filled on the same row — because Maps
        // does not put two addresses on a card; it puts ONE, in whichever slot that card's layout
        // used. Numbering them shipped a table where the address a person wants is in column 4 for
        // 68 rows and column 5 for 35, and a spreadsheet cannot sort that. `Hours` and
        // `Hours (page)` co-occur 81 times, which is what a genuinely second source looks like,
        // and they must stay apart.
        //
        // So: never co-occur AND never disagree -> one column, filled from whichever side has the
        // value. Overlap of even one row means two fields. The floor is `MERGE_FLOOR` rows of
        // evidence EACH — see its note.
        let both = 0, disagree = 0, aOnly = 0, bOnly = 0;
        for (const r of rows) {
          const x = String(r[held.key] == null ? '' : r[held.key]).trim();
          const y = String(r[c.key] == null ? '' : r[c.key]).trim();
          if (x && y) { both++; if (x !== y) disagree++; } else if (x) aOnly++; else if (y) bOnly++;
        }
        if (both === 0 && disagree === 0 && aOnly >= MERGE_FLOOR && bOnly >= MERGE_FLOOR) {
          for (const r of rows) {
            const y = r[c.key];
            if (y != null && String(y).trim() !== '' && (r[held.key] == null || r[held.key] === '')) {
              r[held.key] = y;
            }
            delete r[c.key];
          }
          held.filled = (held.filled || 0) + bOnly;
          c.merged = held.key;   // read by extractOne, which drops it from the column list
          delete c.name;
          continue;
        }

        // A CONTINUATION IS NOT A SECOND FIELD. The other way one field becomes two columns, and
        // the opposite of the case above: these DO co-occur, on every row where the second is
        // filled, and they are never equal — because they are two HALVES of one line.
        //
        // Measured on the rail itself (`test/pages/maps-rail.html`, a real capture) — Maps writes
        // the status line as one parent holding two styled children:
        //
        //   <span><span>
        //     <span style="…color: rgba(43,127,63,1.00);">Open</span>
        //     <span style="font-weight: 400;"> · Closes 6 PM</span>
        //   </span></span>
        //
        // The extractor lands on both leaves, so `Open · Closes 6 PM` arrives as `Hours = "Open"`
        // and `Hours 2 = "· Closes 4.30 pm"`. Over 120 Missouri rows: 58 rows with only the first,
        // 59 with both, **0 with only the second, and 0 where they are equal**.
        //
        // THE TELL IS THE SEPARATOR, and it is what keeps this off `Address 2`. The second half
        // carries the divider Maps put between them — all 59 of 59 values begin with one, and an
        // address or a phone never does. So: every value separator-led, never present alone, and
        // never equal -> join, reconstructing the card's own string.
        const SEP_LED = /^\s*[·⋅•∙|–—]/;
        if (bOnly === 0 && both >= MERGE_FLOOR && disagree === both) {
          const vals = rows.map((r) => String(r[c.key] == null ? '' : r[c.key]).trim()).filter(Boolean);
          if (vals.length && vals.every((v) => SEP_LED.test(v))) {
            for (const r of rows) {
              const y = String(r[c.key] == null ? '' : r[c.key]).trim();
              const x = String(r[held.key] == null ? '' : r[held.key]).trim();
              if (y) r[held.key] = x ? `${x} ${y}` : y;
              delete r[c.key];
            }
            c.merged = held.key;
            delete c.name;
            continue;
          }
        }

        let n = 2;
        while (taken.has(`${c.name} ${n}`)) n++;
        const alt = `${c.name} ${n}`;
        c.name = alt; taken.set(alt, c); continue;
      }
      delete c.name;
    }

    // A CATEGORY REPEATS. A NAME DOES NOT. This is the one high-value card field with no shape
    // worth writing: categories are open vocabulary — `Steel distributor`, `Hardware shop`, and
    // `Handyman/Handywoman/Handyperson` share no pattern a regex can hold, which is why every
    // attempt to match them by content has instead matched something else.
    //
    // Their DISTRIBUTION is unmistakable though. Measured on a 104-row export: `Category` held
    // 103 values across 21 distinct strings, a ratio of 0.20, while `Name` held 104 across 103,
    // a ratio of 0.99. A list of businesses repeats its categories and never repeats its names.
    //
    // Bounded on both sides so it cannot swallow its neighbours: at least three distinct values,
    // so a column of nothing but `Delivery` stays out, and no long strings, so an address column
    // that got this far is not renamed. It claims the name only if nothing else has.
    if (!taken.has('Category')) {
      for (const c of cols) {
        if (c.name || c.kind !== 'text') continue;
        const vals = rows.map((r) => String(r[c.key] == null ? '' : r[c.key]).trim()).filter(Boolean);
        if (vals.length < rows.length * CATEGORY_FILL_SHARE) continue;
        const d = new Set(vals).size;
        if (d < CATEGORY_MIN_DISTINCT || d > vals.length * CATEGORY_DISTINCT_MAX) continue;
        if (vals.some((x) => x.length > CATEGORY_MAX_LEN)) continue;
        c.name = 'Category'; taken.set('Category', c); break;
      }
    }

    // Last, and only into names nobody else wanted: see `col.caption` above.
    // NUMBERED HERE TOO, AND FOR A STRONGER REASON THAN THE SHAPES ABOVE. A shape match is an
    // inference from 60% of the values; a caption is the value itself, on every row. When three
    // columns all hold nothing but `Delivery`, that the second and third are also `Delivery` is
    // not a competing claim to be resolved — it is the reading. Surrendering the name left them
    // headed `Text 4` and `Text 5` on a live rail, which is how a labelled flag becomes junk.
    for (const c of cols) {
      if (c.name || !c.caption) continue;
      let nm = c.caption;
      if (taken.has(nm)) {
        let n = 2;
        while (taken.has(`${c.caption} ${n}`)) n++;
        nm = `${c.caption} ${n}`;
      }
      c.name = nm;
      taken.set(nm, c);
    }
    for (const c of cols) delete c.caption;

    // TWO COLUMNS OF THE SAME THING ARE ONE COLUMN AND ONE NUISANCE.
    //
    // The collision rule above only fires when two columns want the same NAME. It cannot see two
    // columns holding the same VALUES under different names, and that is the common case: the page
    // read produces `Name`, the list produces a caption-named `Text 1`, and both survive because
    // nothing compared them. Measured on `toko besi in cimahi`, 90 rows, 25 columns:
    //
    //   Name    == Text 1        90/90 identical
    //   Category== Text 2        90/90 identical
    //   Phone   == Phone (list)  53/53 identical
    //
    // Three of twenty-five columns carrying nothing new.
    //
    // ONLY EXACT DUPLICATION, and only with enough evidence. A column that merely OVERLAPS another
    // — `Text 2 1` holding the street line out of `Full address` — is left alone: it is a
    // fragment, not a copy, and a rule loose enough to drop it is loose enough to drop a real
    // column on a list where two fields happen to agree. Five rows minimum, every one identical.
    const cmp = (s) => String(s == null ? '' : s).trim();
    const kept = [];
    // NAMED FIRST, THEN BY FILL — and every column is compared, including the nameless ones.
    //
    // The first version opened with `if (!c.name) { kept.push(c); continue; }`, which skipped the
    // comparison for exactly the population this exists to remove: a duplicate of `Name` has no
    // name of its own here, because the `Text 1` label is applied after this function returns. So
    // the run dropped nothing, while a replay over the finished export — where every column has a
    // header — dropped three and looked like proof. The test was measuring the wrong stage.
    //
    // Ordering named ahead of unnamed guarantees the named column is the one already kept, so it
    // is the nameless twin that goes and the header survives.
    const rank = (c) => (c.name ? 0 : 1);
    for (const c of [...cols].sort((a, b) => rank(a) - rank(b) || (b.filled || 0) - (a.filled || 0))) {
      // COMPARED ACROSS `rows`, NOT `vals`. `vals` holds only the NON-EMPTY values and stops at
      // `NAME_SAMPLE`, so its index is a different row in every column — comparing two of them
      // position by position lines up unrelated cells and can call two different columns identical.
      // The rows themselves are the only place where index `i` means the same record twice.
      const twin = kept.find((k) => {
        if (!k.name) return false;
        let both = 0;
        for (const r of rows) {
          const a = cmp(r[c.key]); const b = cmp(r[k.key]);
          if (!a || !b) continue;
          if (a !== b) return false;
          both++;
        }
        return both >= TWIN_MIN_ROWS;
      });
      // The survivor is the one already kept, which sorted higher on fill — and on a tie the page
      // read wins, because it was named by asking for a field rather than by guessing a caption.
      if (twin) { c.drop = twin.name; continue; }

      // AND A FRAGMENT OF A NAMED FIELD IS NOT A FIELD — but only when the column has no name of
      // its own to lose. `Text 2 1` and `Text 2 3` hold the street line out of `Full address`;
      // they arrive with a path-derived label because the caption rules found nothing to call
      // them, and they say nothing the address does not.
      //
      // Restricted to those path-derived labels on purpose. A column that earned a real name
      // earned it from evidence, and dropping it because its values happen to sit inside a longer
      // field is how a genuine column disappears — a district that is also part of the address, a
      // model number that is also part of a title.
      // The condition is HAVING NO NAME, not having a name that looks like `Text 2 1`. At this
      // point such a column has no name at all — the `Text N` label is applied downstream, after
      // this function has finished — so testing for it here matched nothing, ever.
      if (!c.name) {
        const inside = kept.find((k) => {
          if (!k.name) return false;
          let both = 0;
          for (const r of rows) {
            const a = cmp(r[c.key]); const b = cmp(r[k.key]);
            if (!a || !b) continue;
            if (a.length >= b.length || !b.includes(a)) return false;
            both++;
          }
          return both >= TWIN_MIN_ROWS;
        });
        if (inside) { c.drop = inside.name; continue; }
      }
      kept.push(c);
    }

    // AND THE COLUMN IS REMOVED, NOT JUST UN-NAMED — which is what the first version did, and it
    // is why the duplicates survived a build that was supposed to have dropped them.
    //
    // `delete c.name` does not delete a column. An unnamed column is still exported; it simply
    // loses its label and is given a positional one downstream. So `Name` and `Text 1` both went
    // out, identical on 93 of 93 rows, and the dedupe looked like it had done nothing because in
    // every way that mattered it had.
    //
    // Spliced out of the caller's own array, since `cols` is passed by reference and everything
    // after this — ordering, the table, the CSV, the JSON — reads that array.
    for (let i = cols.length - 1; i >= 0; i--) if (cols[i].drop) cols.splice(i, 1);
  }

  function extractOne(c, index) {
    const rows = [];
    // Rows hopped from later pages sit beside the live ones rather than inside them:
    // `recount` re-reads the container from the DOM on every extraction, and anything
    // merged into `c.rows` would be thrown away the next time it ran.
    // Learned once, from the live rows, and reused for the hopped ones — page two must
    // be keyed exactly like page one or its rows land in columns of their own.
    const extra = extraOf(c);
    const keep = stableClasses(c.rows.length >= MIN_AGREE_ROWS ? c.rows : extra);
    const bag = new Map();
    // What opening each record said about it, joined back on by the row's own identity.
    // Kept beside the cells rather than inside them because a detail is not on the page:
    // `cellsOf` walks the DOM, and re-walking it would throw these away every extraction.
    const det = detailsOf(c);
    for (const r of c.rows) {
      const cells = cellsOf(r, c.pair, keep, bag);
      const more = det.size ? det.get(identOf(r)) : null;
      if (more) Object.assign(cells, more);
      // A ROW THAT YIELDS NO CELLS STILL HAS A NAME.
      //
      // `cellsOf` reads shared DOM paths, which is the right way to key a table and the wrong way
      // to read a list of icons: Discord's server rail is 23 rows whose only name is an
      // `aria-label`, carried on a nested node whose classes change with unread state, so no path
      // is shared and 22 of the 23 produced zero keys and were dropped here. The list a person was
      // looking straight at came back as one row.
      //
      // `readOne` is the same accessible-name precedence `page_read` already uses and is already
      // tested (test/page-read.mjs) — aria-label, title, then a labelled descendant, plus href and
      // img. Reused rather than re-derived. It fires ONLY for a row that would otherwise
      // contribute nothing, so no table that reads today changes by a single cell: the rows it
      // adds are rows that are currently thrown away.
      // Fired on "no READABLE cell", not "no cell at all". An icon row often does yield one
      // column — the image's src — and a table of 23 image URLs is not the list of servers a
      // person was looking at. A row that already carries text is left exactly as it was, so no
      // table that reads today changes by a single cell.
      const readable = Object.values(cells)
        .some((v) => v != null && String(v).trim() !== '' && !/^(https?:|data:|blob:)/i.test(String(v)));
      if (!readable) {
        const named = readOne(r);
        if (named.label) cells.name = named.label;
        else if (named.text) cells.name = named.text;
        if (named.href && !cells.href) cells.href = named.href;
        if (named.img && !cells['img src']) cells['img src'] = named.img;
      }
      if (Object.keys(cells).length) rows.push(cells);
    }
    const bases = c.el ? hopStore().get(c.el)?.bases : null;
    for (const r of extra) {
      hopBase = bases?.get(r) || null;
      const cells = cellsOf(r, c.pair, keep);
      hopBase = null;
      if (Object.keys(cells).length) rows.push(cells);
    }

    // Rows read in another tab, already reduced to cells. Appended verbatim: they were
    // extracted by this same code against the same template, so their keys line up.
    for (const r of foreignOf(c)) if (Object.keys(r).length) rows.push(r);

    // Rows a recycling container has already SHED, parked by `snapshotRows` while they were
    // still mounted — otherwise a virtualized timeline's final read only ever sees whatever
    // happens to be in the DOM at that instant, which is a page-sized slice of everything the
    // walk actually scrolled past. Skipped for any identity `c.rows`/`extra` still cover, so a
    // row that never left the DOM is read live, once, same as it always was.
    const snaps = c.el ? hopStore().get(c.el)?.snaps : null;
    const covered = new Set();
    for (const r of c.rows) covered.add(identOf(r));
    for (const r of extra) covered.add(identOf(r));
    if (snaps) {
      for (const [k, cells] of snaps) {
        if (!covered.has(k) && Object.keys(cells).length) { rows.push(cells); covered.add(k); }
      }
    }
    // EVERY ROW THIS TAB HAS EVER SEEN, NOT JUST THIS CONTAINER'S — FOR THE APPS THAT NEED IT.
    // `snaps` above is scoped to ONE container element and is lost the instant that element gets
    // replaced (see `allSeen`'s own comment) — the exact thing that made a genuine 28-row walk
    // read back as 8 once X swapped its timeline root mid-scan. This is the same identities, kept
    // on `window[S]` instead, so a container swap costs nothing.
    //
    // GATED ON PROVIDER DATA, AND IT HAS TO BE. Ungated, this merge changes what an extraction
    // MEANS everywhere: a re-read answers "every row this tab has ever shown" rather than "every
    // row this list holds now". Those are the same sentence only where the container is swapped
    // from under us. On an ordinary page they diverge — `test/rows.mjs`'s `/buried` re-read
    // pressed the fixture's own button and got 1,104 rows back for a page holding 144, every
    // earlier press still counted. `keepSeen` is a field on the descriptor rather than a hostname
    // test here, same as every other per-app fact (see `provider-x.js`).
    if ((PROVIDERS[mapKind()] || {}).keepSeen) {
      for (const [k, cells] of allSeen()) {
        if (!covered.has(k) && Object.keys(cells).length) { rows.push(cells); covered.add(k); }
      }
    }
    // X ONLY: whatever the DOM/snapshot path missed, the Redux store still has, and never
    // loses — see `xReduxRows`'s own comment. `covered` here is keyed by `identOf`'s link-set,
    // not by tweet id, so this checks each already-collected row's OWN `@Link` for the id
    // instead of trying to match key schemes — cheap, and correct even if `identOf` ever
    // changes what it hashes.
    if (mapKind() === 'x') {
      const redux = xReduxRows();
      // READABLE FROM OUTSIDE, ON PURPOSE. `window.__holoscrapeRows` is what `page_state`
      // surfaces during discovery, so these three numbers answer "did the store read fire, did
      // it find anything, did anything survive the dedupe" without needing a log file or a
      // rebuild to find out. -1 means the read itself returned nothing at all.
      let added = 0;
      if (redux) {
        const haveIds = new Set();
        for (const r of rows) {
          const m = String(r['@Link'] || '').match(/status(?:es)?\/(\d+)/);
          if (m) haveIds.add(m[1]);
        }
        for (const [id, cells] of redux) if (!haveIds.has(id)) { rows.push(cells); added++; }
      }
      try {
        if (!window[S]) window[S] = {};
        window[S].reduxSeen = redux ? redux.size : -1;
        window[S].reduxAdded = added;
        window[S].reduxAt = Date.now();
      } catch (_) {}
    }

    // Column order = first-seen order across rows, so the table reads in DOM
    // order rather than alphabetically.
    const order = [];
    const fill = new Map();
    for (const r of rows) {
      for (const k of Object.keys(r)) {
        if (!fill.has(k)) { fill.set(k, 0); order.push(k); }
        // A KEY BEING PRESENT IS NOT A VALUE. This counted every key on the row, so a cell holding
        // `''` or `null` was indistinguishable from one holding data. `filled` is what the dedupe
        // sorts by and what the results window uses to hide sparse columns, so both were working
        // from a number that overstated every column — and `Text 7` shipped reading `1/104` while
        // holding an empty string.
        const v = r[k];
        if (v != null && String(v).trim() !== '') fill.set(k, fill.get(k) + 1);
      }
    }
    // A COLUMN THAT HOLDS NO INFORMATION IS NOT A COLUMN.
    //
    // Measured on a Maps rail: of 70 columns, ten held nothing but a middot — `·`, the
    // separator between a card's rating and its category — and four more held only an icon
    // font's private-use glyph, which is a character to the DOM and blank on screen. Fourteen
    // columns, 120 rows each, every cell meaningless. They were what "too many unnamed and
    // empty cells" was mostly made of, and hiding them in the results window would still leave
    // them in the CSV and the JSON.
    //
    // Dropped on CONTENT, not on sparseness: a column filled once in 120 rows can be the most
    // valuable thing in the table (`Claimed`), while one filled 120 times with `·` is noise at
    // full strength. Punctuation and private-use glyphs only — a column of "Website" repeated
    // is a caption, which is a different thing and handled by `nameCols`.
    // Escapes rather than characters: the private-use range cannot be typed, and a middot
    // pasted into a character class is indistinguishable from a stray keystroke when read back.
    const JUNK = new RegExp('^[\\s\\u00a0\\u00b7\\u2022\\u22c5\\u30fb|/,;:.\\-\\u2013\\u2014'
      + '_+=*~"\'`()\\[\\]{}<>\\uE000-\\uF8FF\\uFFFD]*$');
    const junk = new Set();
    for (const key of order) {
      let saw = 0;
      let dull = 0;
      for (const r of rows) {
        const v = r[key];
        if (v == null || v === '') continue;
        saw++;
        if (JUNK.test(String(v))) dull++;
        if (saw >= NAME_SAMPLE) break;
      }
      // NOTHING AT ALL IS ALSO NOTHING. This needed three values before it would judge a column,
      // so one holding NONE was never judged and survived by default — seven of them in a real
      // 104-row export: `Link`, `Text 8`, `Text 2 4`, `Text 9`, `Text 2 5`, `Text 3 2`, `Text 10`,
      // every cell empty. A column with no values needs no sample to condemn it.
      if (saw === 0) { junk.add(key); continue; }
      if (saw >= MIN_AGREE_ROWS && dull === saw) junk.add(key);
    }
    if (junk.size) {
      for (const r of rows) for (const k of junk) delete r[k];
      for (const k of junk) { fill.delete(k); order.splice(order.indexOf(k), 1); }
    }

    const cols = order.map((key) => ({
      key,
      // Which columns point at a file rather than at text. This is the join
      // between a row and its assets, and it is the whole reason to do row
      // extraction in a tool that already downloads files.
      kind: /\b(src|data-src|data-original|data-lazy-src|srcset|data-srcset)$/.test(key) ? 'asset'
        : /\bhref$/.test(key) ? 'link' : 'text',
      filled: fill.get(key),
    }));

    // PICTURES FIRST, then links, then text.
    //
    // First-seen DOM order sounds right and reads badly. A card puts its photo wherever its
    // markup happens to put it — behind three wrapper divs, after a badge, sometimes after the
    // title — so the column that matters most to someone looking at a table of products can
    // land anywhere, and on a wide table it lands off the right-hand edge. The competitor puts
    // every image column first and it is plainly easier to read.
    //
    // Order WITHIN each group is still first-seen, so a card's own photo still comes before its
    // badge and its flag, and the table still reads in the page's order inside each kind.
    // Nothing else depends on position: the results window and the CSV both take `cols` as
    // given, and `itemsFromTables` picks a title by kind rather than by index.
    // EVIDENCE BEFORE GUESSWORK. On a map that publishes a typed record for its own list, the
    // column layout can be READ rather than inferred — so that runs first and `nameCols` fills in
    // whatever is left. See `nameFromState`.
    // A ROW THAT IS NOT A RECORD IS NOT A ROW, and a cell is the value, not the plumbing.
    // Both are provider facts, so both run before naming — a dropped row must not be counted
    // when deciding what a column IS, and a tidied value must be the one that gets matched
    // against the record. See `tidyRows`.
    tidyRows(cols, rows);
    nameFromState(cols, rows);
    nameCols(cols, rows, bag);
    // Needs the link columns named, so it comes last. See `nameRoles`.
    nameRoles(cols, rows);
    // And last of all, because it needs everything above to have run. See `mergeTemplates`.
    mergeTemplates(cols, rows);

    // AND A COLUMN THAT NOW HOLDS NOTHING IS NOT A COLUMN — checked HERE, because "nothing" only
    // became true above. The engine drops empty columns when it derives them, but tidying strips
    // zero-width characters and arrow glyphs, and the template merge moves a minority template's
    // cells into the column that owns them: both can empty a column that was non-empty when it
    // was made. Measured on one page-one table, EIGHT columns survived holding not a single
    // value, `Photo` among them — reporting `filled: 1` for a cell containing one invisible
    // character, which is how it passed the first check.
    //
    // `filled` is recomputed at the same time, since the results window hides sparse columns by
    // it and a stale count hides the wrong ones.
    for (let i = cols.length - 1; i >= 0; i--) {
      const n = rows.filter((r) => {
        const v = r[cols[i].key];
        return v != null && String(v).trim() !== '';
      }).length;
      if (!n) { for (const r of rows) delete r[cols[i].key]; cols.splice(i, 1); continue; }
      cols[i].filled = n;
    }

    // AND ON A MAP THAT NAMES ITS OWN COLUMNS, an unnamed one that survived every rule above is a
    // reused DOM slot rather than a fact — «Наш инстаграм» on one row, an address on the next. See
    // `foldOrphans`, which does the same for a walked table. Gated twice for the same reasons: only
    // where a provider declares `listNames`, and only where naming plainly worked, so the side
    // tables on the same page keep everything they have.
    if ((PROVIDERS[mapKind()] || {}).listNames && cols.filter((c) => c.name).length >= NAMED_ENOUGH) {
      for (let i = cols.length - 1; i >= 0; i--) {
        if (cols[i].name) continue;
        for (const r of rows) delete r[cols[i].key];
        cols.splice(i, 1);
      }
    }
    // A column `nameCols` folded into another is gone, not merely unnamed — its values were moved
    // into the column that kept the name and deleted from every row, so leaving it in the list
    // would put an empty `Text N` beside the field it just filled.
    for (let i = cols.length - 1; i >= 0; i--) if (cols[i].merged) cols.splice(i, 1);

    // BY MEANING, NOT BY KIND. This reverses the previous order, which put every image
    // column first on the grounds that a photo is what a person looks at on a product
    // grid. That is true of a product grid and false of everything else: on a table of 64
    // businesses it put two thumbnails and three URLs ahead of the business name, and the
    // name — the one column anybody reads first — sat past the right-hand edge.
    //
    // Named columns lead, in the order a record is actually read: what it is, how good it
    // is, when it is open, where it is, how to reach it. Pictures follow that block rather
    // than opening the table. Captioned links come next, the record's own URL after them,
    // and everything the engine could not name goes last — an unnamed column is the least
    // useful thing in the table by definition.
    // The 2GIS columns are woven into the SAME sequence rather than appended, because the reading
    // order the comment above describes — what it is, how good it is, when it is open, where it
    // is, how to reach it — is not provider-specific. Left out of this list they were merely
    // "named", which ranks them all equal and scatters `Brand`, `District` and `Firm ID` between
    // the phone number and the pictures in whatever order the DOM happened to produce.
    const ORDER = ['Name', 'Brand', 'Category', 'Other categories',
      // `Rubric` is the search term the card was matched on and `Description` the advert's own
      // sentence — both say WHAT THIS IS, so they belong with the name, not adrift after the
      // contact block where first-seen DOM order had been leaving them.
      'Rubric', 'Description',
      'Rating', 'Reviews', 'Rating spread', 'Price', 'Hours',
      'Address', 'Street address', 'Full address', 'District', 'City / region', 'Country',
      'Postcode', 'Plus code', 'Latitude', 'Longitude',
      'Phone', 'Phone (intl)', 'Phone (other)',
      'Email', 'Email found', 'Emails', 'Emails (other)', 'Website',
      // Messaging channels sit with the contact block because that is what they are for. WhatsApp
      // leads: on 2GIS it fills 92% against email's 70%, so it is the likeliest way to reach a
      // business in these markets.
      'Whatsapp', 'Telegram', 'Instagram', 'Facebook', 'Youtube', 'Vkontakte', 'Other contacts',
      // What qualifies the lead rather than identifies it.
      'Features', 'Award', 'Has catalogue', 'Has discount', 'Advertiser', 'Branches',
      // `Photos` is a COUNT and belongs with the qualifiers; `Photo` is a URL and belongs with
      // the pictures. Both are named, so neither falls into the asset block on its own.
      'Photos', 'Photo',
      // When the listing was last touched — a stale entry is a dead lead.
      'Updated', 'Listed',
      'Claimed', 'Attributes', 'Menu',
      'Top review', 'Review topics', 'Web results', 'Web links',
      // Identifiers last of the named block: never read, always wanted for joining.
      'POI type', 'Firm ID', 'Org ID',
      // Read off the business's own site — see `driveSites`. After the reputation block because they
      // qualify a lead rather than identify it, and `Site` leads them because it says whether the
      // other three mean anything.
      'Site', 'Platform', 'Site year', 'Tracking'];
    // RANKED RELATIVE TO `ORDER`, NOT BY HAND-PICKED NUMBERS — because the hand-picked ones went
    // wrong the moment `ORDER` grew. Pictures were rank 10, chosen when `Phone` sat at index 10
    // and so came after it. Adding `Category`, `Rating spread` and the rest pushed `Phone` out to
    // 12, which put **seven asset columns between `Latitude` and `Longitude`** — six photos and a
    // street view wedged into the middle of the identity block, shoving the phone number seven
    // columns to the right, off the edge of a 60-column table. Reported as "I can't see phone
    // number here", and the number was there all along at 117 of 120 filled.
    //
    // Derived from the list's own length now, so the intent above survives the list changing:
    // named block, then pictures, then captioned links, then the record's own URL, then whatever
    // could not be named.
    const AFTER = ORDER.length;
    // A SATELLITE SITS WITH ITS PARENT. `Address 2`, `Branches link` and `Website label` are not
    // separate facts — they are the same fact's overflow slot, destination and caption. Ranked on
    // their own they landed in the catch-all bucket and first-seen DOM order strung them across
    // the table: `Address` at column 5 and `Address 2` at 17, `Phone` at 6 and `Phone label` at
    // 16, `Rubric` at 9 and `Rubric link` at 19. Reported as the order being inconsistent, and it
    // was — five pairs, every one of them split.
    //
    // So a satellite borrows its parent's rank plus a fraction, which keeps the pair adjacent
    // wherever the parent moves and orders the satellites among themselves: the overflow value
    // first, then where it goes, then what it says.
    const SAT = [[/ 2$/, 0.1], [/ link$/, 0.2], [/ label$/, 0.3]];
    const named = new Set(cols.map((c) => c.name).filter(Boolean));
    const base = (c) => {
      for (const [rx, d] of SAT) {
        if (c.name && rx.test(c.name)) {
          const parent = c.name.replace(rx, '');
          if (named.has(parent)) return [parent, d];
        }
      }
      return null;
    };
    const rankOf = (c) => {
      const sat = base(c);
      // A LINK SATELLITE KEEPS ITS PAIRING WITHOUT COSTING THE FRONT OF THE TABLE.
      //
      // Adjacency alone put `Rubric link` at column FOUR — a hundred-character URL wedged between
      // the category and the rating, where the columns a person actually reads live. Both things
      // were wanted and only one was delivered: pairs must not scatter, and the leading block must
      // stay readable.
      //
      // So a satellite that is a LINK ranks just past the named block instead, offset by its
      // parent's rank. They still sit together and still follow their parents' order — `Rubric
      // link` before `Branches link` because `Rubric` comes before `Branches` — they just do it
      // after the last thing worth reading rather than in the middle of it. A satellite that is
      // TEXT (`Address 2`, `Phone label`) is readable, so it stays beside its parent.
      if (sat && c.kind === 'link') {
        return AFTER + 0.5 + rankOf({ name: sat[0], kind: 'text' }) / 1000;
      }
      if (sat) return rankOf({ name: sat[0], kind: 'text' }) + sat[1];
      const i = ORDER.indexOf(c.name);
      if (i >= 0) return i;
      if (c.kind === 'asset') return AFTER;
      // A BADGE QUALIFIES THE LEAD. «Подтверждён», «Реклама» — named from their own text, so no
      // list can hold them, but structurally they are exactly what `Features` and `Advertiser`
      // are and they read as noise anywhere else.
      if (c.badge) return ORDER.indexOf('Features') + 0.5;
      if (c.record) return AFTER + 2;           // the record's own URL, after its captions
      if (c.name) return AFTER + 1;             // Website, Book online, Directions
      return c.kind === 'link' ? AFTER + 10 : AFTER + 20;   // unnamed, and last
    };
    // Stable, so first-seen DOM order still decides within a group: a card's own photo
    // still comes before its badge, and two unnamed text columns keep the page's order.
    cols.sort((a, b) => rankOf(a) - rankOf(b));

    return {
      rows, cols,
      index,
      label: c.label || '',
      selector: pathOf(c.el),
      mode: c.mode,
    };
  }

  function extract() {
    const st = window[S];
    const c = st?.cands?.[st.i];
    if (!c) return { error: 'NO_CANDIDATE' };
    recount(c); // the page may have grown since it was detected — see extractAll
    return { ...extractOne(c, st.i), candidates: st.cands.length };
  }

  // Every list on the page in one pass. The results window shows one tab per
  // table, so it needs them all up front rather than a round trip per tab.
  // Rows identical in EVERY column are one row. A feed whose pagination resets — the
  // scroll-restart bug, seen as 504 exported rows with only 241 unique, the whole
  // first stretch re-appended shuffled — re-serves the same batches into the DOM.
  // The restart is fixed upstream, but the export must never trust a feed not to
  // repeat itself. Only exact full-row matches collapse: two genuinely identical
  // products differing in any cell (price, position, badge) both survive.
  // THE RECORD'S OWN IDENTITY, read off whichever cell carries its link. `!19s<ChIJ…>` is the
  // place token Maps stamps on a record url, and it is the one thing about a row that survives
  // the row being re-rendered, re-read a second later, or served again as an advert.
  //
  // Scans the VALUES rather than looking for a column called `Page`: column names are decided
  // downstream of this by fill and by collision, so keying off one here would be keying off a
  // name that is not settled yet. Any cell holding a maps url will do.
  const PLACE_TOKEN = /!19s([A-Za-z0-9_-]{10,})/;
  function tokenOfCells(r) {
    for (const v of Object.values(r)) {
      if (typeof v !== 'string' || v.length < PLACE_URL_MIN) continue;
      const m = PLACE_TOKEN.exec(v);
      if (m) return m[1];
    }
    return '';
  }

  function dedupeRows(t) {
    if (!t.rows.length) return t;
    const seenRow = new Set();
    const rows = [];
    let dropped = 0;
    for (const r of t.rows) {
      // The row's OWN cells, every key it has. Projecting onto the table's column list
      // was catastrophic: column keys are per-row DOM paths, the table keeps the first
      // handful it sees, and any row whose keys fall outside that set projects to
      // all-empty — so thousands of different products shared one empty signature and
      // were collapsed as duplicates of each other. Measured: 2,004 rows in, 273 out,
      // 1,731 destroyed by this function.
      const parts = [];
      for (const k of Object.keys(r).sort()) {
        const v = r[k];
        if (v != null && v !== '') parts.push(k + '\u0001' + v);
      }
      // No content is no evidence. A row that yields nothing comparable is kept, never
      // treated as a copy of the last thing that also yielded nothing.
      if (!parts.length) { rows.push(r); continue; }
      const key = parts.join('\u0000');
      // A PLACE TOKEN OUTRANKS THE CELLS, because comparing cells cannot see through either of
      // the two ways one business appears twice on a Maps rail. Measured on `plumber in bandung`,
      // 116 rows exported against 113 distinct `!19s` tokens:
      //
      //   Bandung Rooter   3 rows  — one organic and TWO SPONSORED SLOTS. Same token; the ad
      //                              copies carry a stale review count (260 against 268), the
      //                              address written differently, and a `google.com/aclk?…`
      //                              redirect in the website column instead of the business.
      //   CV MITRA ABADI   2 rows  — BYTE-IDENTICAL `Page` url, differing only in `Hours`:
      //                              "Open" against "Closes soon". One row, read twice as the
      //                              walk passed it, with Maps' live open/closed string ticking
      //                              over in between.
      //
      // The cell signature is defeated by both — an advert is a different row, and a clock is a
      // different value. `!19s<ChIJ…>` is the record's own identity and holds across both; the
      // lane pass already relies on exactly that where it keys records by token, never position.
      //
      // ONLY WHEN A TOKEN IS ACTUALLY THERE. This function is generic and its own history is a
      // warning about over-collapsing (2,004 rows in, 273 out, 1,731 destroyed); a page carrying
      // no tokens never reaches this branch and behaves exactly as it did before.
      const tok = tokenOfCells(r);
      if (tok) {
        if (seenRow.has(tok)) { dropped++; continue; }
        seenRow.add(tok);
        rows.push(r);
        continue;
      }
      if (seenRow.has(key)) { dropped++; continue; }
      seenRow.add(key);
      rows.push(r);
    }
    if (dropped) t.collapsed = dropped;
    t.rows = rows;
    return t;
  }

  function extractAll() {
    const st = window[S];
    if (!st?.cands?.length) return { error: 'NOT_DETECTED' };
    const tables = [];
    // THE CHOSEN LIST LEADS, THEN THE REST IN THE ORDER THEY RANKED.
    //
    // Every list on the page is still extracted — a page with a grid and a sidebar has two and
    // both are worth keeping — but WHICH ONE COMES FIRST is the answer to "what did I ask for".
    // Everything downstream reads `tables[0]`: the panel's readout, the walk's `merged`, the
    // results window's first sheet. So picking a list in the panel moved the outline on the page
    // and changed nothing that anyone exported — measured by `test/chooser.mjs`, which chose the
    // filter panel, watched `st.i` become 1, and then read 14 product rows.
    //
    // The rest keep their ranking, which after `identSpread` is the best guess available: most
    // probable first, so a person who does not choose still gets the likeliest list, and a person
    // who does gets theirs.
    const order = [st.i, ...st.cands.map((_, n) => n).filter((n) => n !== st.i)];
    for (const i of order) {
      if (!st.cands[i]) continue;
      // Re-read the container before extracting. The row array was captured when
      // the page was detected, and a page does not hold still: press its own
      // load-more by hand and the list grows underneath a snapshot that never
      // changes. Extracting 58 rows from a page now showing 120, over and over,
      // read as "the list never updates" — because it never did.
      recount(st.cands[i]);
      const t = dedupeRows(extractOne(st.cands[i], i));
      // A PINNED LIST OWNS tables[0] EVEN WHEN IT READS EMPTY.
      //
      // `if (t.rows.length)` looks like tidiness and is a silent substitution. Measured on
      // Discord: a caller pinned the 23-row server rail, the rail extracted to nothing (icon
      // rows, no shared column paths), the empty table was dropped — and the CHANNEL list, next
      // in the ranking, took position 0. `run_status` then said done and handed back six channel
      // rows for a run that had asked for servers, with nothing anywhere saying the pinned list
      // had produced no cells. Handing someone a different list's data is worse than handing them
      // an empty table, because only one of the two can be noticed.
      //
      // So a HELD PIN is always pushed, empty or not: the caller named that container, and an
      // empty table for it is a true answer. Everything else keeps the old rule, because an empty
      // table nobody asked for is noise.
      if (t.rows.length || (st.pinHeld && i === st.i)) tables.push(t);
    }
    // Why the walk stopped, carried out with the rows. This return does NOT spread
    // `summary()`, so a field added there alone never reaches the caller — the panel's
    // sheet needs to tell "the page says it is finished" from "we ran out of patience".
    return { tables, url: location.href, endedBy: st.endedBy || '',
      // The walk that produced these rows, so the worker can write one line saying how the list
      // was left: how many hops, how many unique rows it had reached, and whether the tab was
      // hidden while it happened. Without this a rail that stopped at 31 of 120 looked exactly
      // like a rail that only had 31.
      walk: { hops: st.hops || 0, rows: st.walkRows || 0, hidden: !!st.walkHidden,
        // See the note by `walkFocus`: `hidden` cannot see a window you clicked away from, and
        // that is the case being chased. `lost` is the one that matters — it is true if focus went
        // at ANY point in the walk, not just when it ended.
        focus: st.walkFocus, lost: !!st.walkLostFocus,
        recycling: !!st.recycling, endedBy: st.walkEndedBy || '' } };
  }

