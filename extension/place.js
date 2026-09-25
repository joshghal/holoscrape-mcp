// READING A RECORD WITHOUT BOOTING MAPS.
//
// The panel is a rendering of a response Maps already fetched. This builds that request and reads
// the response, so a record costs one fetch instead of a document load, five background tabs, a
// debugger attach, a forced viewport, an animation-frame keeper and a walk down a lazily-mounted
// panel.
//
// WHY, in one measurement. The DOM path does not merely cost more per record — it DEGRADES, and
// the degradation is over half the wall clock (`ROOT-CAUSES-2026-08-06.md`):
//
//   records   0- 19   mean  9.0s          minute 0   0.52 records/s
//   records  40- 59   mean 13.4s          minute 3   0.27
//   records 100-119   mean 27.2s          minute 6   0.05
//
// Throughput falls 26x, and not from our own lanes contending — arrival grows inside every lane
// independently, x1.4 to x1.9. The same list over this path: 120 records in 47.7s, bands of
// 352/450/326/461ms, flat, zero non-200s.
//
// --- the two things that make this parseable -------------------------------------------------
//
// 1. THE REQUEST IS BUILT, NOT HARVESTED. `pb` is a grammar, not a session token — see
//    `RESEARCH-OSS-MAPS-2026-08-06.md`. The only record-specific part is the feature id, which
//    every row link already carries. Measured against a harvested template on 8 records: 8/8 at
//    200, parity on content, 387 chars against 1783, and no donor page load at all.
//
// 2. THE PAYLOAD HOLDS EXACTLY ONE PLACE. This is the finding the parser is built on, and it was
//    not assumed — `test/_rpc-shape.mjs`, three records:
//
//        place tokens in payload: 2 occurrences, 1 distinct
//        OUR token appears 2x     0 OTHER places are also in this body
//
//    Public write-ups warn that a pattern for "an address" can match a neighbour's — "people also
//    search for", the shop next door. With these field selectors there are no neighbours in the
//    body to match, so shape-matching is unambiguous.
//
// That is why this reads by SHAPE rather than by position. Index paths are the published approach
// and every write-up that uses them says the same thing: Google moves them. A Plus code still
// looks like a Plus code after a reorder. Positions are kept only as a HINT — checked first
// because it is cheap, then validated by the same shape test that would have found it anyway, so
// a moved field costs a search rather than a wrong value.

// --- the request -------------------------------------------------------------------------------

// Field selectors, ours to choose now that the blob is built rather than copied. `!4e2` asks for
// review metadata, `!17b1` for opening hours, `!1i1024!2i768` sets the viewport that decides what
// size photos come back.
// `!72m0` IS THE REVIEW HISTOGRAM, AND IT IS THE EMPTY MESSAGE THAT ASKS FOR IT.
//
// The per-star counts were written off as "absent even from Maps' own request". They are not: they
// arrive at `[6][175][3]`, ordered 1★→5★, the moment field 72 is present AND EMPTY. Measured
// against the DOM histogram — the same `[role="img"][aria-label]` rows `readDetail` reads — on four
// places in four countries, twice each:
//
//   Happy Camper Pizza, Chicago   DOM 5:3643 4:315 3:70 2:25 1:90  ->  [90,25,70,315,3643]
//   Fundació Joan Miró, Barcelona DOM 5:10256 4:3109 3:904 2:252 1:294 -> [294,252,904,3109,10256]
//   911 Coffee, Cimahi            DOM 5:46 4:3 3:2 2:1 1:0        ->  [0,1,2,3,46]
//   Jikasei MENSHO, Tokyo         DOM 5:4049 4:358 3:101 2:51 1:60 -> [60,51,101,358,4049]
//
// Four of four, element-wise. Cost: +5 characters of request, +213 bytes of response, no measurable
// latency, and every other field `readPlace` returns is byte-identical with and without it — so the
// spread comes for free on the fetch path and NOTHING has to open a panel for it. That is the whole
// point: opening records to read a histogram would have put a 4-minute pass back where a ~55s one is.
//
// THE TRAP, reproduced three times: Maps' OWN request sends `!72m22` — field 72 with 22 children —
// and that returns NO histogram. The empty message is the request; filling it suppresses the answer.
// Copying Maps' blob wholesale is what made this look impossible.
//
// The counts are self-checking and should be read that way rather than by trusting the index 175:
// they sum to the review count at `[6][4][8]` (4143 / 14815 / 52 / 4619 on the four above).
const PB = (fid) => `!1m14!1s${fid}!3m9!1m3!1d5000!2d0!3d0!2m0!3m2!1i1024!2i768!4f13.1`
  + `!4m2!3d0!4d0!13m1!2m0!15m48!1m8!4e2!18m5!3b0!6b0!14b1!17b1!20b1`
  + `!20e2!4b1!10m1!8e3!11m1!3e1!17b1!20m2!1e3!1e6!24b1!25b1!26b1!29b1`
  + `!30m1!2b1!36b1!43b1!52b1!55b1!56m1!1b1!65m5!3m4!1m3!1m2!1i224!2i298`
  + `!22m1!1e81!29m0!30m6!3b1!6m1!2b1!7m1!2b1!9b1!32b1!72m0!37i771`;

// THE FEATURE ID IS ON THE ROW, so nothing here needs the record to have been opened. `!1s0x…:0x…`
// is the same handle `idOfLink` already reads in rows.js.
export function featureId(href) {
  return (/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i.exec(String(href || '')) || [])[1] || '';
}

export function placeUrl(href, { hl = 'en', gl = '', authuser = 0 } = {}) {
  const fid = featureId(href);
  if (!fid) return '';
  const q = [`authuser=${encodeURIComponent(authuser)}`, `hl=${encodeURIComponent(hl)}`];
  if (gl) q.push(`gl=${encodeURIComponent(gl)}`);
  q.push(`pb=${encodeURIComponent(PB(fid))}`);
  return `https://www.google.com/maps/preview/place?${q.join('&')}`;
}

// --- the response -------------------------------------------------------------------------------

// `)]}'` is Google's anti-XSSI prefix. Everything after it is ordinary JSON.
export function parseBody(text) {
  const s = String(text || '').replace(/^\)\]\}'\s*/, '');
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { return null; }
}

const str = (v) => (typeof v === 'string' ? v : '');
const tidy = (v) => str(v).replace(/\s+/g, ' ').trim();

// GOOGLE'S PLACEHOLDERS ARE NOT DATA, and on this path they arrive as ordinary strings rather than
// as an image with a suspicious filename. Measured on the fetch path directly: a record with no
// phone returns the literal call-to-action `Add phone number` at exactly the position a phone
// lives, and `test/_rpc-rows.mjs` flagged it with `!` on record 3 of 8. A cell reading "Add phone
// number" is worse than an empty one — it is a string that looks like an answer.
const CTA = /^(add |claim |suggest |edit |report |know this place|are you the)/i;

// WHAT EACH FIELD LOOKS LIKE — and, just as important, WHETHER IT MAY BE SEARCHED FOR.
//
// THE PARSER REFUSES RATHER THAN GUESSES, and that is the correction for three bugs that were the
// same bug:
//
//   @Phone         returned `116417823808872267552` — a Google account id from the review block
//   @Category      returned `v3Z0aqzWIaqK4-EP28z28Qw` — a `kEI` handle out of the page's own JS
//   @Full address  returned `Tripleks, multripleks, papan semen (GRC board…)` — a product blurb
//
// Each time the position hint failed, the search ran over the whole payload and took the first
// string that passed a shape test. In 200kB of JSON something always passes. The test describes
// what a value MIGHT look like; it cannot establish that a string IS this record's phone.
//
// So `search` is opt-in, and only for fields whose shape is genuinely self-identifying — a Plus
// code cannot be mistaken for anything else, a url is a url. For everything else the hint either
// validates or the field is EMPTY.
//
// This is safe here in a way it would not be elsewhere, and the reason is the design of the pass
// rather than of the parser: a record that comes back with too few fields is OPENED PROPERLY (see
// `FETCH_MIN_FIELDS` in background.js). So refusing degrades to "slower, and right"; guessing
// degrades to "fast, and wrong in a cell nobody will check". When Google moves a field, this goes
// quiet and the records route through the panel until the path is fixed — which is the failure
// mode worth having.
const FIELDS = {
  // Plus code: Google's open location code. The alphabet deliberately excludes vowels and the
  // digits 0/1, which is what makes this unmistakable in a body full of other short strings.
  '@Plus code': {
    at: [183, 2, 2, 0],
    // The open-location-code alphabet excludes vowels and 0/1 precisely so it cannot be confused
    // with words or ids. Safe to look for.
    search: true,
    ok: (s) => /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}(\s|$)/.test(s),
  },
  // A postal address, in any locale: several parts separated by commas, long enough not to be a
  // category, and not one of Google's prompts.
  //
  // RANKED, NOT FIRST-FOUND, and this was measured wrong before it was measured right. Taking the
  // first match returned `Cimahi City, West Java 40523` — a real fragment of the address, and the
  // locality tail rather than the address. The payload carries the components separately as well
  // as whole, so validity alone cannot choose; the fullest candidate is the address.
  '@Full address': {
    // `[39]`, MEASURED ACROSS LISTS. The first hint was `[2,0]`, taken from one search, and it
    // held on three of eight records drawn from two different searches — so on a list where it
    // missed, the search ran and returned a product blurb as the address. `[39]` carries the full
    // address on all eight. A path derived from one sample is a coincidence with a good record.
    at: [39],
    // NOT SEARCHABLE. "Several parts separated by commas" is true of any prose, which is how a
    // list of products became a business address. If `[2,0]` does not hold an address, this
    // record has no address from the fetch and goes to the panel instead.
    search: false,
    ok: (s) => s.length > 15 && s.length < 200 && (s.match(/,/g) || []).length >= 1 && !CTA.test(s)
      && !/^https?:/i.test(s),
    better: (a, b) => ((a.match(/,/g) || []).length - (b.match(/,/g) || []).length) || (a.length - b.length),
  },
  // What Maps calls this business. Short, no punctuation of its own, and never a sentence.
  // What Maps calls this business. Two corrections, both measured against the DOM path:
  //
  //   `/` IS PART OF CATEGORIES. `Handyman/Handywoman/Handyperson` is a real Maps category and the
  //   first version banned the slash, so it rejected the true value on every such record.
  //
  //   AND THEN IT ACCEPTED A SESSION TOKEN. With the real category refused, the search ran on and
  //   returned `v3Z0aqzWIaqK4-EP28z28Qw` — a `kEI` handle out of the page's own JavaScript — on
  //   three of eight records. It passed every test: short enough, no banned punctuation, starts
  //   with a letter.
  //
  // Digits are the separator. Maps categories are words: `Plumber`, `Building materials store`,
  // `Handyman/Handywoman/Handyperson`. None contain a digit; every token does.
  '@Category': {
    at: [13, 0],
    // NOT SEARCHABLE. "A few letters, no digits" fits half the strings in the body.
    search: false,
    ok: (s) => s.length >= 3 && s.length <= 42 && !/[\d,;:!?]/.test(s) && !CTA.test(s)
      && /^\p{L}/u.test(s) && /^[\p{L}\s/&'.-]+$/u.test(s),
  },
  // THE BUSINESS'S OWN WEBSITE — the field whose absence started this whole thread, and the one
  // the DOM reader had to be taught to stop discarding. Here it is a plain url at a stable path,
  // exact on every probe record: `[6,7,0]`.
  //
  // Google's own links are excluded because the payload carries several — the place's Maps url,
  // photo hosts, `google.com/search` links — and any of them would satisfy "looks like a url".
  '@Website': {
    at: [7, 0],
    // A url with Google's own hosts excluded is self-identifying.
    search: true,
    ok: (s) => /^https?:\/\/[^\s"']+$/i.test(s) && s.length < 300
      && !/(^|\.)(google|gstatic|googleusercontent|ggpht|googleapis)\.[a-z.]+\//i.test(s)
      && !/\/maps\/|\/search\?|\/aclk\?/i.test(s),
  },
  // THE PHONE NODE, which is not where this used to read. `[96]` is the panel's ACTION-ROW list —
  // "Call", "Edit name", "Suggest hours" — so it was reading a rendering of the phone rather than
  // the phone, and what a UI row holds when there is no phone is the CTA `Add phone number`.
  // Measured over 31 records on 4 lists: `[96,10,1,0,4,2,1]` was non-empty on 31 of 31 and THREE of
  // those were that CTA, which this parser then had to refuse. Nothing was gained by the extra fill.
  //
  // `[178]` is the record's own phone, and it carries every format at once:
  //
  //   [178,0,0]      `(022) 4241449`   national, as the panel prints it
  //   [178,0,1,1,0]  `+62 22 4241449`  E.164 — `[178,0,1]` is [[text,1],[text,2]], 1 national 2 intl
  //   [178,0,3]      `0224241449`      digits only
  //   [178,0,5,0]    `tel:0224241449`  the dial link
  //
  // The two forms go to the two columns the DOM path already fills, and they mean there exactly
  // what they mean here: `@Phone` is the local form, `@Phone (intl)` promises the country code is
  // in the digits (see the note beside `phone:tel:` in `rows.js`). A column that means one thing on
  // one path and another on the other is worse than either.
  '@Phone': {
    at: [178, 0, 0],
    // SEARCHED WITHIN `[178]`, NOT THE WHOLE BODY, and this narrowing is a fix rather than a
    // tidy-up. The digit bound rejects account ids, but it cannot reject everything shaped like a
    // number: on Jikasei MENSHO the payload carries `150-8377` (a Japanese postcode, at `[183,1,4]`)
    // and `2022.10.7` (a photo's date, at `[51,0,57,3]`), and both pass "7-15 digits with phone
    // punctuation" exactly. With the hint at `[178]` the search only ever has to find a phone that
    // MOVED INSIDE THE PHONE NODE, so the whole body is scope it never needed.
    within: [178],
    search: true,
    ok: (s) => okPhone(s) && !/^\+/.test(s),
  },
  // The same number with the country in it. `[178,0,1]` is a list of [text, kind] pairs, so the
  // position is a hint and the `+` is the proof: if Google ever reorders that list, the hint fails
  // validation and the search finds the entry that starts with `+` — inside `[178]`, where the only
  // candidates are this record's own numbers.
  '@Phone (intl)': {
    at: [178, 0, 1, 1, 0],
    within: [178],
    search: true,
    ok: (s) => okPhone(s) && /^\+/.test(s),
  },
  // WHERE THE PLACE IS, in the words a lead list sorts by. `Cimahi City, West Java`, `Chicago, IL`,
  // `London`, `Twickenham` — the shape differs by country, so it is NOT split into city and region:
  // the last comma separates them in the US and Indonesia and there is no comma at all in the UK,
  // and a column that is a region on some rows and nothing on others is the kind of half-answer
  // this parser exists to avoid. One honest column, whole.
  '@City / region': {
    at: [166],
    // NOT SEARCHABLE. "A short string with a comma in it" is most of the payload.
    search: false,
    ok: (s) => s.length >= 2 && s.length <= 80 && !CTA.test(s) && !/^https?:/i.test(s)
      && /\p{L}/u.test(s),
  },
  // THE STREET LINE, taken from the address Maps has already split for us. `[2]` is the address in
  // parts, and the first part is the street on every shape measured:
  //
  //   ID  ["Jl. Jend. H. Amir Machmud No.306", "Cibabat", "Kec. Cimahi Utara", "Kota Cimahi, …"]
  //   US  ["1745 N Harlem Ave", "Chicago, IL 60707"]
  //   GB  ["74 Richmond Rd", "Twickenham", "TW1 3BE"]
  //
  // The MIDDLE parts are not emitted, and that is deliberate: their count runs 2-4 and their
  // meaning rotates with the country — part 1 is a neighbourhood in Indonesia and the city in the
  // United States. Numbered columns over that would be four columns of locale noise.
  '@Street address': {
    at: [2, 0],
    // NOT SEARCHABLE. A street line is prose with a number in it, which describes far too much.
    search: false,
    ok: (s) => s.length >= 3 && s.length <= 160 && !CTA.test(s) && !/^https?:/i.test(s),
  },
  // THE RECORD'S OWN FEATURE ID, `0x<hex>:0x<hex>` — the handle every row link already carries as
  // `!1s`, and the one `placeUrl` builds its request from.
  '@Feature ID': {
    at: [10],
    // NOT SEARCHABLE, and this is the distinction the whole `search` flag turns on. Two hex words
    // joined by a colon is unmistakable as a KIND and says nothing about OWNERSHIP, and the payload
    // carries other places' feature ids: every photo in `[51,0]` carries one at `[…,15,0,0,0]`, and
    // `[204]` — when the response includes it — is several complete neighbouring records. A search
    // here would not return "something that is not a feature id", it would return SOMEBODY ELSE'S,
    // which is the worst cell this parser can produce. `[10]` held on 149 of 149 and agreed with the
    // row's own `!1s` on 149 of 149; if it moves, this goes blank and the record is opened properly.
    search: false,
    ok: (s) => /^0x[0-9a-f]{6,20}:0x[0-9a-f]{6,20}$/i.test(s),
  },
  // THE PLACE ID — `ChIJw4_vkzTkaC4RKqzboNguTPQ`, the stable join key a CRM can re-scrape against.
  // The same token the row link carries as `!19s`, which is also what `rows.js` dedupes rows by, so
  // a visible column here lets that dedupe be audited from the export.
  '@Place ID': {
    at: [78],
    // NOT SEARCHABLE, and the prefix is why. `ChI`-prefixed base64url is distinctive to a human
    // and not to a matcher: the body is full of `CIHM0ogKEICAgID…` photo ids and `0ahUKEwj…`
    // request handles in the same alphabet and the same length class. The hint held on every
    // record measured; if it moves, this goes blank and the record is opened properly.
    search: false,
    ok: (s) => /^[A-Za-z0-9_-]{20,120}$/.test(s) && /^(ChI|GhI|EiQ|EhI)/.test(s),
  },
};

// A telephone number as Maps displays it, which differs by country — `(022) 4241449`,
// `0856-2432-8605`, `+1 512-960-0044`. Digits with the punctuation phone numbers use, and enough of
// them to be a subscriber line.
//
// THE DIGIT COUNT IS THE WHOLE TEST, and leaving it open returned Google account ids. Measured
// against the DOM path, this field came back as `116417823808872267552` and `112255503421965560537`
// on records whose real numbers were `0851-7327-4411` — contributor ids from the review block, pure
// digits, which sail through any pattern that only asks for "digits and phone punctuation".
//
// E.164 caps an international subscriber number at 15 digits. Nothing longer is a phone, and that
// single bound separates the two populations completely: numbers here run 9-13 digits, the ids
// 19-21.
function okPhone(s) {
  if (CTA.test(s) || !/^[+(]?\d/.test(s) || /[^\d\s+().-]/.test(s)) return false;
  const d = s.replace(/\D/g, '').length;
  return d >= 7 && d <= 15;
}

// A depth-first walk over every string in the body. Bounded, because a 200kB body has a lot of
// nodes and a field that is genuinely absent must not cost a full traversal every time.
//
// `better` decides between candidates when more than one is valid, and a field that supplies one
// is saying "validity does not identify me". Without it the walk returns whatever it reaches
// first, which for an address meant the locality tail rather than the address — a correct-looking
// fragment of the right field, which is the hardest kind of wrong to notice.
function findByShape(root, ok, better = null, cap = 60000) {
  let seen = 0;
  let best = '';
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n == null) continue;
    if (++seen > cap) break;
    if (typeof n === 'string') {
      const s = tidy(n);
      if (s && ok(s)) {
        if (!better) return s;
        if (!best || better(s, best) > 0) best = s;
      }
      continue;
    }
    if (Array.isArray(n)) { for (let i = n.length - 1; i >= 0; i--) stack.push(n[i]); }
  }
  return best;
}

const at = (root, path) => {
  let n = root;
  for (const i of path) { if (n == null) return undefined; n = n[i]; }
  return n;
};

// THE RECORD'S OWN SUBTREE. Measured at index 6 on every record probed — name at `[6,11]`, token
// at `[6,78]`, address at `[6,2,0]`. Taken as a hint like everything else: if index 6 does not
// look like a place, the whole tree is searched instead, which is safe precisely because there is
// only one place in it.
function placeNode(tree) {
  const six = at(tree, [6]);
  if (Array.isArray(six) && (tidy(at(six, [11])) || tidy(at(six, [2, 0])))) return six;
  return tree;
}

// Reads one record out of a parsed body. `name` is what the row said it was called, used only to
// keep the record's own name out of fields it is not.
export function readPlace(tree, { name = '' } = {}) {
  if (!Array.isArray(tree)) return null;
  const node = placeNode(tree);
  const out = {};

  // THE NAME COMES OUT OF THE PAYLOAD, not from the caller, and this was a real failure rather
  // than a preference. Both guards below need to know what the record is called; the first version
  // took it as an argument, the harness passed `c.name` from `dclick` — which returns
  // `{ ok, key, href, id, wasMark }` and no name at all — so `mine` was empty, both guards were
  // dead, and the address kept its name prefix through a fix that unit-tested correctly.
  //
  // A parser that needs the caller to already know the answer is a parser with a hole in it. The
  // name is at `[11]` of the place node on every record probed, and the caller's value is kept
  // only as a fallback.
  const own = tidy(at(node, [11]));
  const named = own && own.length <= 120 ? own : tidy(name);
  if (named) out['@Name'] = named;
  const mine = named.toLowerCase();

  for (const [key, spec] of Object.entries(FIELDS)) {
    let v = '';
    if (spec.at) {
      const hint = tidy(at(node, spec.at));
      if (hint && spec.ok(hint)) v = hint;
    }
    // THE HINT WINS WHEN IT IS VALID, and when it is not, only a field that declares itself
    // searchable may go looking. See the note above `FIELDS`: a shape test cannot prove a string
    // is this record's address, and a record with a missing field is opened properly anyway.
    //
    // `within` NARROWS WHERE LOOKING IS ALLOWED, and a field that declares one is saying its shape
    // test is not strong enough for the whole payload — only strong enough to tell its own
    // neighbours apart. If that subtree is absent, the search does NOT widen back out to the body:
    // widening is precisely what the narrowing is for.
    if (!v && spec.search) {
      const scope = spec.within ? at(node, spec.within) : node;
      const found = scope == null ? '' : findByShape(scope, spec.ok, spec.better);
      if (found) v = found;
    }
    // The business's own name is not its category, and on records whose name IS their category
    // ("Plumbing&Sanitary Wasser") the two are genuinely indistinguishable by shape alone.
    if (v && key === '@Category' && v.toLowerCase() === mine) v = '';
    // NOR IS IT PART OF ITS ADDRESS. Maps stores the address twice — plain, and prefixed with the
    // business name — and ranking by completeness picks the prefixed one, because it genuinely has
    // more of everything. Measured against the DOM path on three records:
    //
    //   DOM    Jl. Gatot Subroto No.14, Karangmekar, Kec. Cimahi Tengah, …
    //   fetch  Kopi Boutique Cimahi, Jl. Gatot Subroto No.14, Karangmekar, …
    //
    // That was the only field of six that disagreed at all, and this is the whole of it.
    if (v && key === '@Full address' && mine) {
      const cut = new RegExp('^' + mine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*,\\s*', 'i');
      const trimmed = v.replace(cut, '');
      if (trimmed && trimmed.length > 10) v = trimmed;
    }
    // THE SAME CUT, ON THE PLUS CODE, AND ONLY WHEN THE BUSINESS'S OWN NAME IS IN IT.
    //
    // `CODE Locality, Region` is Google's NORMAL format and 20 rows of the user's 106 use it
    // correctly — `4GWP+7H Tanimulya, West Bandung Regency, West Java` is not a defect and must not
    // be "fixed". Exactly one row was wrong, and what makes it wrong is visible without any
    // guessing about shape:
    //
    //   3HVX+R4J Toko Besi Rahayu, Halte Paskal, Jl. Pasir Kaliki, Pasirkaliki, …
    //            ^^^^^^^^^^^^^^^^ the record's own name, followed by its street address
    //
    // So the test is the same one `@Full address` already uses — does the tail start with THIS
    // record's name — rather than a pattern for "too long" or "too many commas", either of which
    // would also match the twenty correct rows. Falls back to the bare code if what is left is not
    // a locality, because a code alone is right and a code plus somebody's street address is not.
    if (v && key === '@Plus code' && mine) {
      const m = /^([23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3})\s*(.*)$/i.exec(v);
      const nameFirst = new RegExp('^' + mine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      // KEEP THE CODE, DROP THE REST. Once the record's own name is in there, what follows it is
      // this place's street address rather than the locality Google normally writes — on the one
      // observed row, `Halte Paskal, Jl. Pasir Kaliki, Pasirkaliki, Kec. Cicendo`. Trying to keep
      // "the locality part" means guessing which comma is the boundary, and the bare code is
      // complete and correct on its own, so there is nothing to gain by guessing.
      if (m && m[2] && nameFirst.test(m[2])) v = m[1];
    }
    if (v) out[key] = v;
  }

  // THE POSTCODE, TAKEN FROM THE SPLIT RATHER THAN CUT OUT OF THE ADDRESS. `[2]` is the address
  // Maps has already divided into parts, and the LAST part is the one that carries it:
  //
  //   ID  `Kota Cimahi, Jawa Barat 40513`   →  40513
  //   US  `Chicago, IL 60707`               →  60707
  //   AU  `Freshwater NSW 2096`             →  2096
  //   GB  `TW1 3BE`                         →  TW1 3BE
  //   CA  `ON M5A 2Z1`                      →  M5A 2Z1
  //   IE  `D03 HY59`                        →  D03 HY59
  //   FR  `75003 Paris`                     →  75003     ← LEADING, not trailing
  //   ES  `28936 Móstoles`, `Madrid`        →  28936     ← one part BEFORE the last
  //
  // Regexing this out of `@Full address` would be the same job done blind: the address is one
  // string there and the trailing number could be a house number as easily as a postcode. Here the
  // structure says which part is the locality line, and only that line is examined.
  //
  // ONE STRUCTURAL RULE, NOT A LIST OF NATIONAL FORMATS, and the list is how this was written first.
  // Each format added was a country that had been reading BLANK while the pooled number looked fine:
  //
  //   trailing digits only          30/37 — all 7 misses were Paris, because French leads
  //   + leading digits              29/36 — 6 of 7 misses were Toronto: `M5A 2Z1` is
  //                                        letter-digit-letter and the UK rule ends `\d[A-Z]{2}`
  //   + the Canadian form            the last miss was Madrid, where `28936 Móstoles` sits one part
  //                                        before the province
  //   + the part before the last    29/36 — 6 of 7 misses were Dublin: an Eircode is a letter and
  //                                        two digits then FOUR characters
  //   + the Irish form              26/36 — and now Warsaw, 0 of 6, because Poland writes `00-001`
  //
  // Five formats in and the next country was still blank. The formats were never the pattern; the
  // pattern is WHERE THE DIGITS SIT. A postcode is the run of digit-bearing tokens at one END of the
  // locality line, and the locality words never contain digits:
  //
  //   `Kota Cimahi, Jawa Barat 40513`  →  40513      `Chicago, IL 60707`   →  60707
  //   `Freshwater NSW 2096`            →  2096       `TW1 3BE`             →  TW1 3BE
  //   `ON M5A 2Z1`                     →  M5A 2Z1    `D03 HY59`            →  D03 HY59
  //   `75003 Paris`                    →  75003      `00-001 Warszawa`     →  00-001
  //
  // It also REFUSES on the shapes that are not postcodes: `Dublin 8` yields the single character
  // `8`, and `Metro Manila` yields nothing at all. Four characters and two digits is the floor, so a
  // postal district and a house number both fall short of it rather than arriving in the column.
  //
  // Two parts minimum, because with one part the "last" part is the street line and a street line
  // ending in a long number is a house number, not a postcode. The second-to-last part is only
  // consulted when there are THREE, for the same reason: with two, the part before the last IS the
  // street line.
  const parts = at(node, [2]);
  if (Array.isArray(parts) && parts.length >= 2) {
    const post = (s) => {
      const toks = tidy(s).split(/[\s,]+/).filter(Boolean);
      const dig = toks.map((t) => /\d/.test(t));
      // The tail run, then the head run. Tail first: where a line has digits at both ends the
      // trailing group is the postcode and the leading one is a house or unit number.
      let a = toks.length; while (a > 0 && dig[a - 1]) a--;
      let b = 0; while (b < toks.length && dig[b]) b++;
      for (const run of [toks.slice(a), toks.slice(0, b)]) {
        // Two tokens is the ceiling: every postcode measured is one token or two (`TW1 3BE`), and
        // allowing three lets a whole numeric address line in.
        const v = run.slice(-2).join(' ').replace(/[.,;]+$/, '');
        if (v.length >= 4 && (v.match(/\d/g) || []).length >= 2) return v;
      }
      return '';
    };
    const found = post(parts[parts.length - 1])
      || (parts.length >= 3 ? post(parts[parts.length - 2]) : '');
    if (found) out['@Postcode'] = found;
  }

  // THE CATEGORIES `@Category` LEAVES BEHIND. `[13]` is an ARRAY — `["Building materials store",
  // "Supermarket"]` — and `[13,0]` is one of them. `@Category` keeps meaning exactly what it means
  // today, the FIRST one, because downstream naming and dedupe are built on that; the rest become
  // their own column rather than being crammed into it.
  //
  // Measured: 80 of 169 records across 29 lists carried a second category, and one carried ten. So
  // this column is genuinely sparse rather than broken — most places have exactly one category —
  // and a fill threshold would drop it for being what it is. Each entry is validated by the same
  // test `@Category` uses, so a junk entry in the list cannot ride in on the back of a good first
  // one, and the first is never repeated here (measured, 0 of 80).
  const cats = at(node, [13]);
  if (Array.isArray(cats) && cats.length > 1) {
    const rest = cats.slice(1).map(tidy)
      .filter((s) => s && FIELDS['@Category'].ok(s) && s.toLowerCase() !== mine);
    if (rest.length) out['@Other categories'] = [...new Set(rest)].join(', ');
  }

  // COORDINATES ARE NUMBERS, so no shape test applies — they are recognised by being a plausible
  // pair sitting together. The row href already carries them (`!3d…!4d…`) and that is the reading
  // the DOM path uses, so this is a fallback rather than the source.
  const geo = findGeo(node);
  if (geo) { out['@Latitude'] = String(geo[0]); out['@Longitude'] = String(geo[1]); }

  // RATING IS A NUMBER, so the string matchers above cannot see it at all. Measured at `[4][7]` on
  // every record probed — `[null,null,null,null,null,null,null,4.7]`. The range test is the whole
  // validation available: any number 1-5 with one decimal in that slot is a star rating, and
  // nothing else in the payload is shaped like that AND sitting there.
  // ONE DECIMAL, because that is how Maps writes it and how the DOM column already reads. The
  // payload stores 5 where the panel shows `5.0`, and a column that says `5` on half its rows and
  // `4.7` on the other half is two formats in one field — five of ten records scored "contained"
  // rather than "same" purely on this.
  const rating = at(node, [4, 7]);
  if (typeof rating === 'number' && rating >= 1 && rating <= 5) out['@Rating'] = rating.toFixed(1);

  const hours = readHours(node);
  if (hours) out['@Hours'] = hours;

  // THE REVIEW COUNT was already in this payload and was never read — the export got it only off
  // the list card, in parentheses. `[4][8]` on every record probed, sitting one slot along from the
  // rating this function already reads at `[4][7]`.
  const reviews = at(node, [4, 8]);
  if (typeof reviews === 'number' && reviews >= 0) out['@Reviews'] = String(reviews);

  const spread = readSpread(node, reviews);
  if (spread) out['@Rating spread'] = spread;

  return Object.keys(out).length ? out : null;
}

// THE STAR HISTOGRAM, IN THE SAME FETCH — no panel, no second request.
//
// It filled 1 row of 106 before this, and the reason was not that the field is hard: it was read
// only from an OPEN PANEL, and the fetch path answers ~119 of 120 records without opening one. The
// naive cure — open every record — would have put a four-minute pass back where a ~55s one is.
//
// `!72m0` in the request is what makes it arrive (see `PB`). It lands at `[175][3]` of the place
// node, five counts ordered 1★→5★, verified element-wise against the DOM histogram on four places
// in four countries.
//
// READ BY SHAPE, NOT BY INDEX, for the reason this whole file is written that way: `175` is where
// it sits today. Five non-negative integers whose sum equals the review count at `[4][8]` is a
// description no other node in the payload satisfies by accident — and it is a genuine check, not
// a formality, because the count arrives independently of the histogram.
//
// Emitted in the DOM path's own format, `5:49 4:5 3:0 2:0 1:5`, highest star first — so a row read
// by fetch and a row read by panel produce the same column rather than two.
function readSpread(node, reviews) {
  const fmt = (a) => [5, 4, 3, 2, 1].map((s) => `${s}:${a[s - 1]}`).join(' ');
  const ok = (a) => Array.isArray(a) && a.length === 5
    && a.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
  // The hint first, because it is free.
  const hint = at(node, [175, 3]);
  if (ok(hint) && (typeof reviews !== 'number' || hint.reduce((x, y) => x + y, 0) === reviews)) {
    return fmt(hint);
  }
  // Moved: find any five-number node that sums to the review count. Without a count to check
  // against there is nothing to distinguish a histogram from any other five numbers, so refuse —
  // an unverifiable spread is worse than a blank one.
  if (typeof reviews !== 'number' || reviews <= 0) return '';
  const stack = [node];
  let seen = 0;
  while (stack.length) {
    const n = stack.pop();
    if (!Array.isArray(n)) continue;
    if (++seen > 60000) return '';
    if (ok(n) && n.reduce((x, y) => x + y, 0) === reviews) return fmt(n);
    for (let i = n.length - 1; i >= 0; i--) if (n[i] && typeof n[i] === 'object') stack.push(n[i]);
  }
  return '';
}

// A latitude/longitude pair as Maps stores it: `[null, null, lat, lng]`. Checked as a pair, since
// either number alone is unremarkable.
function findGeo(root) {
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    const n = stack.pop();
    if (!Array.isArray(n)) continue;
    if (++seen > 60000) return null;
    if (n.length >= 4 && n[0] == null && n[1] == null
      && typeof n[2] === 'number' && typeof n[3] === 'number'
      && Math.abs(n[2]) <= 90 && Math.abs(n[3]) <= 180
      && (n[2] !== 0 || n[3] !== 0)) return [n[2], n[3]];
    for (let i = n.length - 1; i >= 0; i--) if (n[i] && typeof n[i] === 'object') stack.push(n[i]);
  }
  return null;
}

// TODAY'S OPENING HOURS, which are structured rather than written out — so no shape matcher could
// have found them, and the discovery harness that looked for a string beginning "Monday," reported
// them missing. Measured shape at `[203]` of the place node:
//
//   [[["Thursday", 4, [2026,8,6], [["7.30 am–4.30 pm", [[7,30],[16,30]]]], 0, 1]], …]
//      ^ day                        ^ the range as displayed
//
// Assembled into the same cell the DOM reader produces — `Thursday, 7.30 am–4.30 pm` — because a
// column that means one thing on the tab path and another on this one is worse than either.
//
// A place open around the clock has no `[203]` at all (measured: one record whose panel said
// "Thursday, Open 24 hours" carried nothing there), so the structure is tried first and the text
// is looked for second. Both, or neither, rather than a guess.
function readHours(node) {
  const day = at(node, [203, 0, 0]);
  if (Array.isArray(day)) {
    const name = tidy(day[0]);
    const range = tidy(at(day, [3, 0, 0]));
    if (name && range) return `${name}, ${range}`;
    if (name) return name;
  }
  // WHEN THE TABLE IS NOT THERE. Three records of ten had hours on the panel and nothing at
  // `[203]` — `Thursday, 8.00 am-8.00 pm`, `Thursday, 7.00 am-10.00 pm` — so the structure is not
  // the only place Maps keeps them. Two more shapes, in order of how specific they are:
  //
  //   a range as displayed   `7.00 am-10.00 pm`, `07:00-22:00`
  //   a word                 `Open 24 hours`, `Closed`
  //
  // Bounded to this record's subtree, which is safe here in a way it would not be on a page: the
  // payload holds exactly one place, so there are no neighbouring hours to pick up by mistake.
  const range = findByShape(node, (s) => s.length <= 40
    && /\d{1,2}[.:]\d{2}\s*(am|pm)?\s*[-\u2013\u2014]\s*\d{1,2}[.:]\d{2}\s*(am|pm)?$/i.test(s));
  const said = range || findByShape(node, (s) => /^(open 24 hours|closed|open)$/i.test(s));
  if (said) {
    const d = findByShape(node, (s) => /^(mon|tues|wednes|thurs|fri|satur|sun)day$/i.test(s));
    return d ? `${d}, ${said}` : said;
  }
  return '';
}
