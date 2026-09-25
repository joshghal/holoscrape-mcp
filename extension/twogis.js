// READING A 2GIS RECORD. The second provider, and deliberately its own mapping.
//
// `place.js` reads Google. Not one of its hooks transfers — no `pb` grammar, no `!1s0x…:0x…`
// feature id, no `data-item-id="oloc"`, no shape-matching over an untyped tree. 2GIS ships a
// TYPED JSON record, so this reader is by KEY, not by shape, and that is a real difference in
// kind rather than a different set of selectors. See the `MAPS`/`MAPPINGS` note in `rows.js`:
// a reader that tries to serve two providers ends up serving neither, and fails silently as
// empty columns.
//
// --- what makes this cheap -----------------------------------------------------------------
//
// 1. THE FIRM PAGE IS SERVER-RENDERED. Verified 2026-08-07 against
//    `2gis.kz/almaty/firm/70000001053127916`: `200`, 743,392 bytes, the complete record inline.
//    No cookies, no API key, no JS execution, no rendering. So a record costs ONE fetch and
//    there is no tab fallback to build — the thing `laneRecord` needs tabs for on Google
//    (client-rendered panel, lazily-mounted below the fold) does not exist here.
//
//    ⚠ The earlier "2GIS is client-rendered, curl returns a ~4KB shell" finding was A BOT BLOCK,
//    not client rendering, and it is the reason this target was nearly skipped:
//
//        default curl UA  ->  403,     150 bytes
//        browser UA       ->  200, 962,000 bytes, full state, all 12 /firm/ hrefs
//
//    Anything here that fetches MUST send a browser User-Agent. A 403 from this host means the
//    request looked automated, never that the page is unavailable.
//
// 2. THE RECORD CARRIES ITS OWN EMAIL. This is the whole reason 2GIS is worth building. On
//    Google the address is not in the record at all, so the third step exists: fetch the
//    business's own website, then open the leftovers in tabs. 2GIS publishes it directly.
//    Measured fill, n=27 (`2GIS-TARGET-2026-08-07.md`):
//
//        2gis.ru moscow / автосервис   12 rows   phone 100%   website 100%   email 83%
//        2gis.kz almaty / кафе         12 rows   phone 100%   website  33%   email 25%
//
//    EMAIL FILL IS VERTICAL-DEPENDENT, NOT SITE-DEPENDENT. A B2B/service vertical runs ~83%; a
//    consumer-hospitality one ~25%. Do not put a single coverage number in front of a user.
//
// --- two traps, both measured ----------------------------------------------------------------
//
// A. `contact_groups` IS NOT ON THE SEARCH PAGE. Not "absent from these records" — absent from
//    the search-record schema entirely: present in 0 of 36 across three cities. An exhaustive
//    walk of 40,304 state nodes on a search page found 0 emails, 0 non-2GIS URLs and 0 phone
//    numbers. So the search page yields IDS AND METADATA ONLY, and contacts cost one firm fetch
//    each. `data.links` is no help either — it is purely geospatial (branches, entrances,
//    nearest_metro, nearest_parking) and holds no websites and no socials.
//
// B. `email_for_sending` IS NOT AN EMAIL. It is `{"allowed": true}` — a permission flag for
//    2GIS's own share-by-email feature. It sits right beside the real contacts, it is named
//    exactly like the field you want, and reading it yields `true` in an Email column. It is
//    explicitly never read below.
//
// ⛔ AND ONE ENDPOINT THAT MUST NEVER BE CALLED: `catalog.api.2gis.*`. It looks like a
//    one-request-for-all-twelve shortcut and the required per-result signature is sitting in the
//    page at `initialState.data.searchContext['<sid>_<firmId>'].hash`. But the site key
//    allow-lists the exact `fields` string server-side — replaying the site's own URL verbatim
//    returns 200, the same URL with `items.contact_groups` added returns `403 apiKeyIsBlocked` —
//    and A HANDFUL OF REJECTED CALLS BLOCKS THE KEY FOR THE WHOLE BROWSER SESSION, INCLUDING
//    2GIS'S OWN SITE. An extension that trips this does not merely lose its data; it breaks
//    2gis.ru in the user's browser and gets blamed for it. The HTML path needs no key at all.

// --- the request -------------------------------------------------------------------------------

// A 2GIS firm URL is `https://2gis.<tld>/<city>/firm/<id>` and may carry a tail (`/tab/reviews`,
// a `?m=` map camera) that we neither need nor want to fetch. The id is the only part that
// identifies the record — same role the feature id plays on Google.
//
// THE TLD IS ONE LABEL, AND THAT IS A SAFETY RULE RATHER THAN TIDINESS. Written as `([a-z.]+)`
// the TLD group swallows dotted labels, so `https://2gis.kz.evil.com/almaty/firm/1` parses as a
// valid record and `firmUrl` hands back a URL on a host the attacker owns — which this extension
// would then fetch. Caught by `test/twogis.mjs`; the host must END at a single short TLD, and
// subdomains are allowed only in front of it. Matches the anchored host test in `rows.js` MAPS.
const FIRM_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*2gis\.([a-z]{2,3})\/([^/?#]+)\/firm\/(\d+)/i;

export function firmId(href) {
  const m = FIRM_RE.exec(String(href || ''));
  return m ? m[3] : '';
}

// Normalised to the bare record. Dropping the tail matters: `/firm/<id>/tab/reviews` serves the
// reviews view, which is a heavier document for the same contacts.
export function firmUrl(href) {
  const m = FIRM_RE.exec(String(href || ''));
  return m ? `https://2gis.${m[1]}/${m[2]}/firm/${m[3]}` : '';
}

// THE HEADER IS NOT OPTIONAL — see the 403 above. `credentials: 'omit'` because none of this
// needs the user's session and sending it would put their identity on every record fetch.
export const FIRM_INIT = {
  credentials: 'omit',
  cache: 'no-store',
  headers: { 'Accept-Language': 'ru,en;q=0.9' },
};

// --- the response ------------------------------------------------------------------------------

// The state ships as `var initialState = JSON.parse('<literal>')` — a SINGLE-QUOTED JavaScript
// string holding JSON. Verified on the firm page: exactly one occurrence, 297,186 characters.
//
// The escaping decides whether this is safe, and MY FIRST READING OF IT WAS WRONG — taken from one
// Russian firm page, where the only escaped character is the backslash. A Dubai search page escapes
// the QUOTE as well:
//
//     2gis.kz/almaty/firm/<id>         escapes seen: { \\ }
//     2gis.ae/dubai/search/dental...   escapes seen: { \\ , \' }
//
// Unescaping only `\\` left every `\'` in place, `JSON.parse` threw `Invalid \escape`, `parseState`
// returned null — and a page holding twelve real records read as "no results". Silent, and it looked
// exactly like an empty search.
//
// So both are unescaped, in ONE left-to-right pass. Sequential replaces would be wrong: turning
// `\\` into `\` first can leave a `\'` that was never an escape. JSON's own escapes are untouched
// because they arrive doubled (`\\"`, `\\n`, `\\uXXXX`) and survive one unescape into the `\"`,
// `\n`, `\uXXXX` that `JSON.parse` expects.
//
// So the end of the literal is the first `'` preceded by an even number of backslashes, and
// unescaping is one replacement. A greedy or lazy `.*` between quotes would be wrong on any page
// whose data happens to contain a quote — this walks instead.
const OPEN = "initialState = JSON.parse('";

export function parseState(html) {
  const s = String(html || '');
  const i = s.indexOf(OPEN);
  if (i < 0) return null;
  const start = i + OPEN.length;
  let j = start;
  for (;;) {
    j = s.indexOf("'", j);
    if (j < 0) return null;
    let bs = 0;
    for (let k = j - 1; k >= start && s[k] === '\\'; k--) bs++;
    if (bs % 2 === 0) break;
    j++;
  }
  try {
    return JSON.parse(s.slice(start, j).replace(/\\(['\\\\])/g, '$1'));
  } catch { return null; }
}

// One record per firm page, but keyed by id rather than first — a page asked for one id should
// return THAT id's record and not whichever happens to be first, or a redirect quietly files one
// business's contacts under another's key. This is the same class of bug as the Google detail
// reader returning the previous record's panel.
export function firmData(state, id = '') {
  const prof = state && state.data && state.data.entity && state.data.entity.profile;
  if (!prof) return null;
  if (id && prof[id] && prof[id].data) return prof[id].data;
  if (id) return null;
  const k = Object.keys(prof)[0];
  return k && prof[k] ? prof[k].data || null : null;
}

// --- reading -----------------------------------------------------------------------------------

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// A contact's clean value depends on its type, and getting this backwards is silent.
//
//   website  ->  `.url` is the real address; `.value` is a `link.2gis.ru/1.2/…?<real url>`
//                click-tracker. A Website column full of link.2gis.ru is useless for outreach
//                and looks like it worked.
//   phone    ->  `.value` is E.164 (`+77073394049`); `.text` is the display form with figure
//                dashes (`+7‒707‒339‒40‒49`, U+2012). Both are wanted, in different columns —
//                same split `place.js` makes with `@Phone` / `@Phone (intl)`.
//   email    ->  `.value` is the address.
//   socials  ->  `.url`.
function cleanOf(c) {
  const t = c && c.type;
  if (t === 'website') return c.url || '';
  if (t === 'email' || t === 'phone') return c.value || '';
  return c.url || c.value || '';
}

// Types seen in the wild. Listed rather than inferred so an unrecognised one lands in a named
// column instead of being dropped or, worse, mistaken for a website.
const SOCIAL = ['instagram', 'whatsapp', 'telegram', 'vkontakte', 'odnoklassniki',
  'facebook', 'youtube', 'twitter', 'max'];

function contacts(d) {
  const out = [];
  for (const g of (d.contact_groups || [])) for (const c of (g.contacts || [])) out.push(c);
  return out;
}

function pick(cs, type) {
  for (const c of cs) if (c.type === type) { const v = cleanOf(c); if (v) return c; }
  return null;
}

function admOf(d, type) {
  for (const a of (d.adm_div || [])) if (a.type === type) return a.name || '';
  return '';
}

// The full week, one line, empty days named. 2GIS gives every day it knows — unlike the Google
// RPC's hours field, where a week's worth of slots came back with two populated.
function readHours(sch) {
  if (!sch || typeof sch !== 'object') return '';
  const parts = [];
  for (const day of DAYS) {
    const v = sch[day];
    if (!v) continue;
    const hrs = (v.working_hours || []).map((h) => `${h.from}–${h.to}`).join(', ');
    if (hrs) parts.push(`${day} ${hrs}`);
  }
  return parts.join('; ');
}

export function readFirm(d, { name = '' } = {}) {
  if (!d || typeof d !== 'object') return null;
  const out = {};
  const put = (k, v) => {
    if (v == null) return;
    const s = typeof v === 'number' ? String(v) : String(v).trim();
    if (s) out[k] = s;
  };

  put('@Name', d.name || (d.org && d.org.name) || name);

  const rubrics = (d.rubrics || []).map((r) => r && r.name).filter(Boolean);
  put('@Category', rubrics[0]);
  if (rubrics.length > 1) put('@Other categories', rubrics.slice(1).join(', '));

  put('@Full address', d.full_name);
  put('@Street address', d.address_name);
  put('@City / region', admOf(d, 'city') || admOf(d, 'region'));
  put('@Country', admOf(d, 'country'));
  put('@District', admOf(d, 'district'));
  put('@Postcode', d.address && d.address.postcode);

  if (d.point) { put('@Latitude', d.point.lat); put('@Longitude', d.point.lon); }

  const cs = contacts(d);
  const ph = pick(cs, 'phone');
  if (ph) { put('@Phone', ph.text || ph.value); put('@Phone (intl)', ph.value); }
  // Extra numbers are real — a delivery line, a second branch desk — and they carry a `comment`
  // saying which. Dropping them loses the one a caller actually wants often enough to matter.
  const more = cs.filter((c) => c.type === 'phone' && c !== ph)
    .map((c) => (c.comment ? `${c.value} (${c.comment})` : c.value)).filter(Boolean);
  if (more.length) put('@Phone (other)', more.join('; '));

  const site = pick(cs, 'website');
  if (site) put('@Website', cleanOf(site));

  // THE COLUMN THIS PROVIDER EXISTS FOR.
  const mail = pick(cs, 'email');
  if (mail) put('@Email', cleanOf(mail));
  const mails = cs.filter((c) => c.type === 'email' && c !== mail).map(cleanOf).filter(Boolean);
  if (mails.length) put('@Emails (other)', mails.join('; '));

  for (const t of SOCIAL) {
    const c = pick(cs, t);
    if (c) put(`@${t[0].toUpperCase()}${t.slice(1)}`, cleanOf(c));
  }
  // Anything typed but unlisted, kept rather than silently dropped — a new contact type should
  // show up as data, not as a gap.
  const known = new Set(['phone', 'website', 'email', ...SOCIAL]);
  const rest = cs.filter((c) => !known.has(c.type))
    .map((c) => `${c.type}: ${cleanOf(c)}`).filter((s) => !s.endsWith(': '));
  if (rest.length) put('@Other contacts', rest.join('; '));

  const rev = d.reviews || {};
  put('@Rating', rev.general_rating);
  put('@Reviews', rev.general_review_count);

  // Hours live in two places: a top-level `schedule`, and sometimes one hanging off a contact
  // group. Same shape, and the top-level one is the record's own.
  let sch = d.schedule;
  if (!sch) for (const g of (d.contact_groups || [])) if (g.schedule) { sch = g.schedule; break; }
  put('@Hours', readHours(sch));

  // --- what else the record already carries -----------------------------------------------------
  //
  // Everything below arrives in the SAME fetch and was measured at 100% fill over 24 records
  // (measured live, 2026-08; probe since retired). None of it costs a request. It is here because Google Maps
  // publishes no equivalent for any of it, which is most of why this provider is worth having.

  // WHEN THE LISTING WAS LAST TOUCHED — the lead-quality signal in the whole record. A business
  // whose entry has not moved in three years is a business that may be gone; one edited last month
  // is one that still cares. Date only: the time is 00:00 or an ingest artefact on most rows.
  const day = (v) => (typeof v === 'string' ? v.slice(0, 10) : '');
  if (d.dates) { put('@Updated', day(d.dates.updated_at)); put('@Listed', day(d.dates.created_at)); }

  // DOES THIS BUSINESS BUY ADVERTISING. A buying signal, and one nobody else exposes: it says the
  // firm already spends money on being found. Only emitted when true — a column of "false" on
  // every row is a dull column and `rows.js` would drop it anyway.
  if (d.is_promoted || d.has_ads_model) put('@Advertiser', 'yes');

  // THE PICTURE, WHICH IS THIS PRODUCT'S WHOLE POSITIONING — "rows carry the URLs of their own
  // files". A 2GIS record names its main photo and counts the rest, so both come free.
  for (const c of (d.external_content || [])) {
    if (c && c.main_photo_url) { put('@Photo', c.main_photo_url); put('@Photos', c.count); break; }
  }

  // The brand without the category glued to it: `name` is "Vilka, стейк-хаус", `name_ex.primary`
  // is "Vilka". Better for matching against a CRM than the display name.
  if (d.name_ex) put('@Brand', d.name_ex.primary);

  // A category that does not change with the interface language — `service_station` where
  // `@Category` reads "Автосервис" or "Car service" depending on the storefront.
  put('@POI type', d.poi_category);

  // THE FACETS. 41 per record on average across 24 groups — average bill, cuisine, services
  // offered, payment methods, brands serviced, awards. This is the qualifying data a list of
  // names and phones cannot give you, and it is already in the response.
  const facets = [];
  for (const g of (d.attribute_groups || [])) {
    const names = (g.attributes || []).map((a) => a && a.name).filter(Boolean);
    if (names.length) facets.push(g.name ? `${g.name}: ${names.join(', ')}` : names.join(', '));
  }
  if (facets.length) put('@Features', facets.join(' · '));

  // Capability flags, emitted only when set, for the same dull-column reason as `@Advertiser`.
  if (d.has_goods) put('@Has catalogue', 'yes');
  if (d.has_discount) put('@Has discount', 'yes');

  put('@Firm ID', d.id);
  if (d.org) {
    put('@Org ID', d.org.id);
    // Branch count is the tell that a name will repeat down the list at different addresses —
    // the same hazard as "Reliant Plumbing" beside "Reliant Plumbing - Austin" on Google.
    if (d.org.branch_count > 1) put('@Branches', d.org.branch_count);
  }

  return Object.keys(out).length ? out : null;
}

// One call, for the worker: HTML in, record out.
export function readFirmHtml(html, { id = '', name = '' } = {}) {
  const st = parseState(html);
  if (!st) return null;
  const d = firmData(st, id);
  return d ? readFirm(d, { name }) : null;
}

// --- the list, and the ceiling on it -------------------------------------------------------------
//
// THE ONE FACT THAT SHAPES EVERYTHING ELSE: A QUERY YIELDS 60 RECORDS, NOT `total`.
//
// 2GIS server-renders pages 1-5 and no more. Page 6 and beyond answer `302` back to page 1 —
// measured at N = 6,7,8,9,10,11,20,50,208,209,210,500, on `2gis.kz/almaty`, `2gis.ru/moscow` and
// `2gis.ae/dubai` alike, with a real cookie jar and a full Chrome header set. It is a route guard,
// not a session artifact. At 12 rows a page that is **60 records**, while the very same payload
// reports `total: 2508` across `pages: 209`.
//
// So `total` is NOT a promise the panel may repeat. Reporting "2,508 found" and stopping at 60 is
// the "no silent caps" failure in its purest form: the run looks broken, and the number that made
// it look broken came from us.
//
// TWO TRAPS, both of which return HTTP 200 and neither of which is detectable by body size:
//
//   `?page=2`  is SILENTLY IGNORED — 200, and byte-for-byte the same twelve ids as page 1. A
//              scraper written to the query-string form paginates forever over one page. The
//              working form is the PATH segment, `/page/2`.
//   the 302    must never be followed. With redirects on, page 6 quietly becomes page 1 and its
//              twelve already-seen ids arrive again as if fresh.
//
// And the two out-of-range behaviours are ordered, which is worth knowing when reading a failure:
// `N > 5` is a 302 whatever the real page count, but `N <= 5` past the true end is a 404 (measured
// on a 2-page query: page 3 and 4 gave 404, page 6 still gave 302). The guard runs before the data
// check. **404 bodies are full rendered error pages of 515KB-963KB**, so status code is the only
// safe signal here — never body size.
// A MEASUREMENT, NOT A STOP CONDITION — and the difference is the whole point.
//
// Five is what three cities answered on one day. Treat it as a rule and a region that serves ten
// pages silently yields sixty records forever, with nothing to say the other sixty were left
// behind. The cost of discovering the end instead of asserting it is ONE request in sixty-five.
//
// So nothing stops on this number. It is here to ESTIMATE before a run ("about 60 of 1,682") and
// to document what was seen. `lastPage()` below is what decides where to stop, and every signal
// it uses comes from the data.
export const PAGE_CAP_SEEN = 5;
export const PER_PAGE = 12;

// Where the list ends, decided from the page in hand rather than from a constant.
//
//   `pages` IS TRUTHFUL WITHIN THE SERVED RANGE. Measured: a 21-result query reports `pages: 2`
//   and really has 2; a 1-result query reports 1 and has 1. It only overstates once the answer
//   exceeds what the server will render (1,682 results reports 141, serves 5). So it is an upper
//   bound worth believing for short sets and worth ignoring for long ones — which is exactly what
//   `n >= pages` gives you for free.
//
//   A PARTIAL PAGE IS THE LAST PAGE, and this one needs no constant at all. Page 2 of the
//   crematoria search returned 9 of 12 and page 3 was a 404. Self-confirming, zero extra requests.
//
// Anything else — a 302 (the render cap), a 404 (past the true end), or a page bringing no new
// row identities (a clamping site re-serving page one) — is the caller's to notice on the next
// request. Those cost one fetch and are what make this self-correcting if 2GIS ever serves more.
export function lastPage(s, n) {
  if (!s) return true;
  if (s.ids.length < PER_PAGE) return true;      // partial page — free, and definitive
  if (s.pages && n >= s.pages) return true;      // exact for short sets, ignored for long ones
  return false;                                   // full page, more claimed — ask for the next one
}

// Page 1 has no `/page/1` suffix; adding one is not what the site links to.
export function searchUrl(base, n = 1) {
  const b = String(base || '').replace(/\/page\/\d+\/?$/, '').replace(/\/$/, '');
  if (!b) return '';
  return n > 1 ? `${b}/page/${n}` : b;
}

// What the list page actually knows. `have` is what we can reach; `total` is what 2GIS claims, and
// the gap between them is the sentence the panel owes the user.
export function readSearch(html) {
  const st = parseState(html);
  const sp = st && st.data && st.data.search;
  if (!sp || !sp.profile) return null;
  const sk = Object.keys(sp.profile)[0];
  const d = (sp.profile[sk] && sp.profile[sk].data) || {};
  const pages = Number(d.pages) || 0;
  const ids = [];
  const byPage = (sp.pagination && sp.pagination[sk]) || {};
  for (const n of Object.keys(byPage)) {
    for (const id of ((byPage[n] && byPage[n].data) || [])) if (id) ids.push(String(id));
  }
  // AN ESTIMATE, LABELLED AS ONE. `reachable`/`have` are what a run will PROBABLY return, for a
  // card that wants to say something before spending requests. They are not a limit: the walk
  // stops on `lastPage()` and on the next page's refusal, so a region serving more than five
  // pages will simply return more than this predicted.
  const reach = Math.min(pages || PAGE_CAP_SEEN, PAGE_CAP_SEEN);
  return {
    total: Number(d.total) || 0,   // what 2GIS claims — drifts run to run as ads rotate
    pages,                          // truthful within the served range, overstates beyond it
    reachable: reach,               // ESTIMATE of pages a run will get
    have: reach * PER_PAGE,         // ESTIMATE of records
    capped: pages > PAGE_CAP_SEEN,  // the panel owes the user a sentence when true
    ids: [...new Set(ids)],
  };
}
