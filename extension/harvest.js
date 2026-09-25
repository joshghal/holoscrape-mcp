// ONE PAGE IN, A HEADER RECORD AND ANY NUMBER OF ROWS OUT.
//
// The detail pass this sits beside reads ONE record per page, because a map place has one name, one
// phone, one address. Almost nothing else on the web is one-to-one: a film page has a cast, a
// product has variants and reviews, a question has answers, a repo has files. Modelling that as
// "extra columns on the row you came from" is what confined the whole engine to maps.
//
// So the general shape is a header record (0..1) plus zero or more ROWS, and one-to-one becomes the
// degenerate case — a place is simply a page with a header and no rows. Nothing here knows what a
// place, a film or a product is.
//
// PURE, AND THAT IS THE POINT. It takes a document and returns data, so the identical function runs
// on a document parsed from a fetched body in the offscreen page AND on the live `document` of a
// tab. A fetch path that read differently from the tab path would be a second implementation to
// keep honest, and the fetch path is the one nobody watches.

// Cheapest general source first. Each tier is a STANDARD before it is a guess, and the tier that
// answered is reported, so a caller always knows how the value in front of them was obtained.
export const TIERS = ['selector', 'ldjson', 'state'];

const text = (el) => (el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '');

// "css" reads the text; "css@attr" reads an attribute. Two forms, because every field anyone has
// wanted so far is one or the other, and a third syntax is a third thing to explain.
function pick(root, sel) {
  if (!sel) return '';
  const at = String(sel).lastIndexOf('@');
  const css = at > 0 ? String(sel).slice(0, at) : String(sel);
  const attr = at > 0 ? String(sel).slice(at + 1) : '';
  let el = null;
  try { el = css === ':self' ? root : root.querySelector(css); } catch (_) { return ''; }
  if (!el) return '';
  if (!attr) return text(el);
  // `href` and `src` are read through the property, not the attribute, so a relative link comes back
  // absolute — the caller is going to navigate or key on it, and "/name/nm0000209/" is neither.
  if (attr === 'href' || attr === 'src') return String(el[attr] || el.getAttribute(attr) || '');
  return String(el.getAttribute(attr) || '');
}

// `net` is the scope for `$.` selectors: the captured bodies for a record, one row object for a row.
// Passing it as a second source rather than a second function keeps ONE field map, so a caller can
// mix — the title from the DOM and the description from the response — which is the common case on
// a page that renders some of what it fetched.
function fieldsFrom(root, map, net = null) {
  const out = {};
  for (const [name, sel] of Object.entries(map || {})) {
    const v = isNetSel(sel) ? netCell(fromNet(net, sel)) : pick(root, sel);
    if (v) out[name] = v;
  }
  return out;
}

// --- tier: captured network JSON ---------------------------------------------------------------
// A SELECTOR THAT STARTS WITH `$.` IS READ FROM THE API RESPONSES THE PAGE FETCHED, NOT THE DOM.
//
// The case this exists for: a storefront whose product description arrives as GraphQL and is then
// rendered by React. The DOM answer needs the app to have mounted, the right hashed classname, and
// an expanded "show more"; the JSON answer is the field, already named, before any of that. Both
// tiers stay available because neither is complete — plenty of pages put things in the markup that
// never appear in a response body, which is why this is a tier and not a replacement.
//
// Two forms, deliberately few:
//   $.a.b[0].c   walk from the root of the scope
//   $..key       first `key` found at any depth, then continue walking: `$..product.title`
// The scope is the response body for `record`, and the row object for `rows.fields` — so a field
// inside a row is written the same way and means "in this row".
const isNetSel = (s) => typeof s === 'string' && s.startsWith('$.');

// First match, breadth-first, so a shallow `title` wins over one buried in a nested layout blob.
// Depth-first would find whichever branch happened to be declared earliest, which is not a fact
// about the data.
function deepFind(root, key) {
  const q = [root];
  let seen = 0;
  while (q.length && seen < 20000) {
    const node = q.shift();
    seen++;
    if (!node || typeof node !== 'object') continue;
    if (!Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, key)) return node[key];
    for (const v of Array.isArray(node) ? node : Object.values(node)) {
      if (v && typeof v === 'object') q.push(v);
    }
  }
  return undefined;
}

export function walkPath(root, path) {
  // `$..key.rest` — find `key` anywhere, then continue from it.
  let cur = root;
  let rest = path.slice(2);            // drop the leading `$.`
  if (rest.startsWith('.')) {
    rest = rest.slice(1);
    const m = /^([^.[]+)/.exec(rest);
    if (!m) return undefined;
    cur = deepFind(root, m[1]);
    rest = rest.slice(m[1].length);
    if (rest.startsWith('.')) rest = rest.slice(1);
  }
  if (!rest) return cur;
  for (const tok of rest.split('.')) {
    if (!tok) continue;
    // `a[0][2]` — the name, then any number of indices.
    const nm = /^([^[]*)/.exec(tok)[1];
    if (nm) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[nm];
    }
    for (const ix of tok.slice(nm.length).matchAll(/\[(\d+)\]/g)) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(ix[1])];
    }
  }
  return cur;
}

// NOT EVERY CAPTURED RESPONSE IS THE ONE. A page load fetches config, telemetry and the payload, and
// the caller named a path, not a URL — so each body is tried in order and the first that resolves
// wins. A path that resolves nowhere returns '' exactly like a CSS selector that matched nothing.
export function fromNet(bodies, path) {
  for (const b of bodies || []) {
    const v = walkPath(b && typeof b === 'object' && 'body' in b ? b.body : b, path);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

// A field is text. An object or array reaching a cell is almost always the caller's path stopping a
// level too high, so it is stringified rather than dropped — a visibly wrong cell is debuggable and
// a missing one is not — but capped, because a whole GraphQL sub-tree in one cell helps nobody.
const NET_CELL_MAX = 4000;
export function netCell(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') { try { return JSON.stringify(v).slice(0, NET_CELL_MAX); } catch (_) { return ''; } }
  return String(v).slice(0, NET_CELL_MAX);
}

// --- tier: ld+json ------------------------------------------------------------------------------
// schema.org is a standard, not a fact about one site, which is why it is worth trying before any
// selector: Product/Offer/Review/Movie/Recipe carry price, sku, rating, cast and ingredients on
// sites that share no markup at all. It is also the layer least likely to move in a redesign.
export function ldjson(doc) {
  const out = [];
  let nodes = [];
  try { nodes = [...doc.querySelectorAll('script[type="application/ld+json"]')]; } catch (_) { return out; }
  for (const n of nodes) {
    let v = null;
    try { v = JSON.parse(String(n.textContent || '')); } catch (_) { continue; }
    // A page may ship one object, an array, or a @graph — all three are common and none is wrong.
    const flat = Array.isArray(v) ? v : (Array.isArray(v?.['@graph']) ? v['@graph'] : [v]);
    for (const one of flat) if (one && typeof one === 'object') out.push(one);
  }
  return out;
}

const typeOf = (o) => {
  const t = o?.['@type'];
  return Array.isArray(t) ? t.map(String) : (t ? [String(t)] : []);
};

// The arrays schema.org uses for "the many things on this page". Ordered by how specific they are,
// so a Product's reviews are not mistaken for its offers.
const LD_ROWS = ['actor', 'review', 'itemListElement', 'offers', 'recipeIngredient', 'performer'];

// A schema.org node is a bag of strings, objects and arrays. Flatten one level so a row is a row —
// `{name, url}` rather than `{name, url: {…}}` — and drop the bookkeeping keys nobody asked for.
function flatten(node, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(node || {})) {
    if (k.startsWith('@') && k !== '@type') continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (v == null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') { out[key] = String(v); continue; }
    if (Array.isArray(v)) {
      const flatKids = v.filter((x) => typeof x === 'string' || typeof x === 'number');
      if (flatKids.length) out[key] = flatKids.join(' | ');
      continue;
    }
    if (typeof v === 'object' && !prefix) Object.assign(out, flatten(v, key));
  }
  return out;
}

export function fromLd(doc, want = '') {
  const nodes = ldjson(doc);
  if (!nodes.length) return null;
  // The header is the biggest non-boilerplate node: a page's Product or Movie, not its
  // BreadcrumbList or its WebSite.
  const skip = /^(BreadcrumbList|WebSite|WebPage|Organization|SearchAction|ImageObject)$/;
  const main = nodes
    .filter((n) => !typeOf(n).some((t) => skip.test(t)))
    .sort((a, b) => Object.keys(b).length - Object.keys(a).length)[0] || nodes[0];
  const record = flatten(main);
  let rows = [];
  let via = '';
  // WHICH ARRAY BECAME THE ROWS, AND WHAT ELSE WAS THERE.
  //
  // First match in LD_ROWS wins, which is a defensible default and a silent one. Measured on a live
  // Allrecipes page: `review` is ahead of `recipeIngredient`, so a zero-selector harvest returned
  // thirteen reviews and never mentioned that the ingredients had been sitting in the same node. The
  // caller could not tell it had been given a choice, let alone make a different one.
  //
  // So the reply now names the array it used and lists the ones it passed over with their sizes, and
  // `want` lets the caller pick — by NAME, with no CSS and no reading of the page. That is the whole
  // point of the ld+json path: an agent that has to inspect markup to choose has already lost the
  // thing this was for.
  const also = LD_ROWS
    .filter((k) => Array.isArray(main?.[k]) && main[k].length)
    .map((k) => ({ from: k, count: main[k].length }));
  const order = want && LD_ROWS.includes(want) ? [want, ...LD_ROWS.filter((k) => k !== want)] : LD_ROWS;
  for (const key of order) {
    const v = main?.[key];
    if (!Array.isArray(v) || !v.length) continue;
    // NAMESPACED BY THE ARRAY THEY CAME FROM, and this is a data-loss fix rather than tidiness.
    //
    // Both halves of a schema.org page use the same obvious keys. A Movie has `name`, and so does
    // every Person in its `actor` array; the merge in the driver is `{...record, ...row}`, so the
    // row won and the FILM'S NAME WAS GONE. Measured on the first real run: a `name` column holding
    // "Tim Robbins" where "The Shawshank Redemption" belonged, and `url` holding the actor's page.
    // Silent, and worst in the zero-selector case that is otherwise the best thing here.
    //
    // `actor.name` collides with nothing and matches how `flatten` already writes `offers.price`.
    rows = v.map((one, i) => {
      const flat = typeof one === 'object' ? flatten(one) : { name: String(one) };
      const out = { billing: String(i + 1) };
      for (const [k, val] of Object.entries(flat)) out[`${key}.${k}`] = val;
      return out;
    });
    via = key;
    break;
  }
  // The row array is not part of the header — repeating a 79-name cast inside every row's parent
  // record is exactly the payload blow-up this whole exercise exists to remove.
  for (const key of LD_ROWS) delete record[key];
  return {
    record,
    rows,
    via: via ? `ldjson:${via}` : 'ldjson',
    rowsFrom: via,
    // Only the roads not taken. Listing the one in use as an alternative to itself is noise.
    alsoRows: also.filter((a) => a.from !== via),
  };
}

// --- the entry point ----------------------------------------------------------------------------
//
// `spec.rows` and `spec.record` are both optional, and that is what lets one function cover
// one-to-one, one-to-many, and both at once:
//
//   { record: {...} }              a product's price and sku          → 1 row
//   { rows: { at, fields } }       a film's cast                      → n rows
//   { record, rows }               a question and all of its answers  → n rows, shared header
//   { }                            whatever ld+json carries           → the standard, for free
export function readHarvest(doc, spec = {}) {
  const want = spec || {};
  // `rows.from` picks WHICH schema.org array becomes the rows, by name. It costs no CSS and no look
  // at the page, which is the only reason the zero-selector path is worth having.
  const ld = (want.tier === 'selector') ? null : fromLd(doc, String(want.rows?.from || ''));
  // Captured API responses for this page, if the caller asked for any. Shape: [{ url, body }].
  const net = Array.isArray(want.net) ? want.net : [];

  let record = {};
  let rows = [];
  let via = '';
  let capped = false;

  // A caller-supplied selector WINS over the standard, always. It was written by someone looking at
  // this page; ld+json is a good guess about pages in general. The order is not a preference, it is
  // the difference between "the cast with characters and billing" and "the cast's names".
  if (want.record && Object.keys(want.record).length) {
    record = fieldsFrom(doc, want.record, net);
    via = Object.values(want.record).some(isNetSel) ? 'selector+net' : 'selector';
  }
  // WHAT THE CALLER NAMED AND DID NOT GET. Kept because the ld+json fallback below is allowed to
  // fill an empty half, and when it does the reply otherwise looks like a success against the path
  // that was asked for. Measured on a Bazaarvoice widget: `rows.at: "$.Results"` matched nothing
  // (the body was JSONP, so it never parsed), ld+json supplied 24 rows of `offers` instead, and the
  // reply named neither fact. Every column was populated and none of them were what was requested —
  // the same failure as a mislabelled field, this time authored by the tool rather than the caller.
  const missed = [];
  if (want.rows?.at) {
    const cap = Math.max(1, Math.min(2000, Number(want.rows.limit) || 500));
    // A ROW GROUP CAN LIVE IN EITHER LAYER, AND THE `$.` PREFIX IS WHICH. `rows.at` naming a JSON
    // array makes each element a row scope; anything else is CSS over the document, unchanged.
    if (isNetSel(want.rows.at)) {
      const arr = fromNet(net, want.rows.at);
      const list = Array.isArray(arr) ? arr : [];
      if (!list.length) missed.push(want.rows.at);
      rows = list.slice(0, cap).map((one, i) => {
        const r = fieldsFrom(null, want.rows.fields || {}, [one]);
        if (!('billing' in r)) r.billing = String(i + 1);
        return r;
      }).filter((r) => Object.keys(r).length > 1);
      via = via ? `${via}+netrows` : 'net';
      if (list.length > cap) capped = true;
    } else {
      let at = [];
      try { at = [...doc.querySelectorAll(want.rows.at)]; } catch (_) { at = []; }
      if (!at.length) missed.push(want.rows.at);
      rows = at.slice(0, cap).map((el, i) => {
        const one = fieldsFrom(el, want.rows.fields || {}, net);
        // Billing/rank is the one field the caller cannot select for, because it is the position
        // itself. Supplied unless they named their own.
        if (!('billing' in one)) one.billing = String(i + 1);
        return one;
      }).filter((r) => Object.keys(r).length > 1);   // `billing` alone is not a row
      via = via ? `${via}+rows` : 'selector';
      // NEVER A SILENT CAP. A row group that was truncated says so all the way out to the caller;
      // "79 of 200" is a result, 79 presented as the whole cast is a bug report.
      if (at.length > cap) capped = true;
    }
  }

  // Did the caller get everything they named? Computed before the ld+json fallback fills gaps, so
  // it measures the selectors/paths that were actually asked for.
  const asked = Object.keys(want.record || {}).length;
  const gotAll = asked > 0 && Object.keys(record).length === asked;

  // Fall back to the standard for whichever half the caller did not ask for.
  let substituted = false;
  if (ld) {
    if (!Object.keys(record).length) {
      record = ld.record;
      via = via || ld.via;
      // A SUBSTITUTED RECORD IS AS WRONG AS SUBSTITUTED ROWS, AND ONLY THE ROWS WERE EVER FLAGGED.
      //
      // Measured on shopee.com.br: a harvest asked for `$.items` off the search API and every page
      // came back holding ONE row — the site's schema.org `WebSite` object, `@type` / `name` /
      // `potentialAction` / `sameAs`. That is this branch, not the rows branch below, so
      // `substituted` stayed false, `pathsWhy` never fired, and the run reported
      // `pages: 4, rows: 4, failedCount: 0`. The warning written for precisely this case sat
      // silent through the canonical example of it, and the caller was told it had succeeded.
      //
      // Same rule as the rows branch: a substitution only counts when something was ASKED for and
      // missed. A caller who named no record fields and got the standard's has been served.
      if (missed.length) substituted = true;
    }
    if (!rows.length && ld.rows.length) {
      rows = ld.rows;
      via = via ? `${via}+${ld.via}` : ld.via;
      // Only a substitution when something was ASKED for. A caller who named no rows and got the
      // standard's rows has been served, not surprised.
      if (missed.length) substituted = true;
    }
  }

  return {
    record,
    rows,
    capped,
    via: via || 'nothing',
    // Named separately from `via` because `via` says where the data came from and this says where it
    // did NOT come from — and the second is the one a caller is about to get wrong.
    ...(missed.length ? { missed } : {}),
    ...(substituted ? { substituted: true } : {}),
    // Carried out so the caller learns, from the reply, that a choice existed — and can name the
    // other one next time without reading any markup.
    ...(ld?.alsoRows?.length && rows === ld.rows ? { alsoRows: ld.alsoRows } : {}),
    // THIN IS AN ANSWER, NOT AN EMPTY RESULT. A fetched body that hit a challenge, or a page whose
    // content is drawn by script after load, produces exactly this — and the caller must re-read it
    // in a real tab rather than file it. `laneRecord`'s comment states the rule this protects: a
    // half-read record is the one failure this path must not introduce.
    // THIN MEANS "NOTHING WORTH HAVING", NOT "FEWER THAN TWO FIELDS".
    //
    // The `< 2` floor is a guess about DOM reads: a bot-challenge page reliably yields an incidental
    // title and nothing else, and one lone field is far more often that than a real record. It is
    // the wrong test when the caller named exactly one field and got it — which is the ordinary
    // shape once a field can be a `$.` path, because one named path into a response body IS the
    // whole answer. Asking for one and receiving one is a complete result; the floor only applies
    // where something asked for is missing.
    thin: !rows.length && Object.keys(record).length < 2 && !gotAll,
  };
}

// ROWS OUT OF A CAPTURED PAYLOAD, for callers that hold bodies but no document — the worker during a
// feed walk, where the page has already replaced the DOM by the time anything is read. Same `$.`
// grammar as `readHarvest`, so a path that works in one works in the other.
export function netRows(bodies, at, fields) {
  const arr = fromNet(bodies, String(at || ''));
  if (!Array.isArray(arr)) return [];
  const map = fields || {};
  return arr.map((one) => {
    const r = {};
    for (const [name, sel] of Object.entries(map)) {
      const v = isNetSel(sel) ? netCell(fromNet([one], sel)) : '';
      if (v) r[name] = v;
    }
    return r;
  }).filter((r) => Object.keys(r).length);
}

// ONE ROW'S IDENTITY, FOR ROWS THAT ARE OBJECTS RATHER THAN ELEMENTS.
//
// `identOf` in rows.js answers this for a DOM element — longest real link, normalised to
// origin+pathname, falling back to the row's text — and it is the right rule: a link is the app
// telling you what a row IS, and text is what is left when there is none. It cannot be reused
// directly because it reads `querySelectorAll` and `innerText` off an element, and a row lifted out
// of a JSON payload has neither. So the RULE lives here, once, rather than being invented a third
// time at each call site: this file is imported by the worker and injected into the page, which is
// the only place both halves of a feed walk can agree.
const LINKY = ['href', 'url', 'link', 'permalink', 'sourceUrl'];
export function rowIdent(row) {
  if (!row || typeof row !== 'object') return '';
  for (const k of LINKY) {
    const v = row[k];
    if (typeof v === 'string' && /^https?:/.test(v)) {
      try { const u = new URL(v); return `${u.origin}${u.pathname}`; } catch (_) { return v; }
    }
  }
  // The DOM half already carries the key `collect` gave it; honour it rather than re-deriving.
  if (typeof row.key === 'string' && row.key) return row.key;
  const text = Object.entries(row)
    .filter(([k, v]) => typeof v === 'string' && v && k !== 'img')
    .map(([, v]) => v).join(' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  return text;
}
