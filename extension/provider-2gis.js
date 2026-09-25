// 2GIS, as a provider — and the point of this file existing is that NOT ONE LINE of it is true of
// Google Maps.
//
// That was the lesson of adding it. Seven facts about a provider lived in seven places across
// three files, each added the moment something broke, so a second map had to be discovered by
// getting it wrong: Google's assumptions stayed hardcoded wherever nobody had looked yet, and
// every 2GIS fix applied globally cost regressions on Maps — eighteen in a single run.
//
// Same boundary rule as `provider-gmaps.js`: the DESCRIPTOR is serialisable data because the
// engine is injected as source and cannot import; the READER is a normal module because it runs
// in the worker.

// --- the descriptor -----------------------------------------------------------------------------
export const descriptor = {
  id: '2gis',
  // Eleven live TLDs, verified 2026-08-07: ru kz ae kg uz az ge by tj am cz. One label only —
  // written as `[a-z.]+` this matches `2gis.kz.evil.com`, and the extension would then fetch a
  // host the attacker owns. Caught by `test/twogis.mjs`.
  host: '(^|\\.)2gis\\.[a-z]{2,3}$',
  path: '^/[^/]+/(search|firm)(/|$)',

  // Category chips and "similar nearby" cards link to SEARCHES. Only `/firm/<id>` is a record.
  recordHref: '/firm/\\d+',

  // THE PAGER MUST BE PRESSED, NOT NAVIGATED TO — the single most expensive fact about this map.
  //
  // `/search/<q>/page/6` answers 302 back to page one. Measured at N = 6,7,8,9,10,11,20,50,208,
  // 209,210,500 on three cities and five separate exit IPs, which made a sixty-record ceiling look
  // architectural. It is not: the guard is on URL navigation, and clicking the pager walks on
  // indefinitely — page 20 and 236 records with no sign of an end, the offered page numbers
  // sliding from page 7 onward.
  grows: 'pager-click',

  // A FETCH SEES EVERYTHING A TAB WOULD. The firm page is server-rendered with the whole record in
  // `initialState`, so unlike Google there is no partial-fetch-then-open ladder — there is nothing
  // left for a tab to see. It also means the tab never leaves the list, which is why the
  // `role="feed"` gate (which protects CLICKING a row) does not apply here.
  //
  // And not tabs for safety, either: the Google lane pass draws a reCAPTCHA after about 100 page
  // loads from one address. 400 firm-page fetches came back clean.
  reads: 'fetch',

  // NAMING THE LIST'S OWN COLUMNS, WITHOUT FETCHING ANYTHING.
  //
  // A 2GIS card offers NOTHING to name a column by. Measured on a live card: not one `aria-label`,
  // `title` or `data-` attribute on any text leaf, and the class names are build hashes. So the
  // generic namer does the only thing it can and calls them `Text 1 … Text 11` — with the street
  // address sitting in `Text 2` and the category in `Text 4`, unnamed.
  //
  // The page does carry the answer, though: `window.initialState` holds a TYPED record per firm id,
  // and the card's own `/firm/<id>` link says which one it is. So the columns are named by matching
  // each cell against that record's known fields — by VALUE, not by vocabulary, which is what makes
  // this work identically on `.kz`, `.ru`, `.ae` and `.cz` without a word list per language.
  //
  // ⚠ AND IT IS CALIBRATION, NOT EXTRACTION — the distinction is the whole reason this is safe.
  // `initialState` is the server-rendered bootstrap and it is FROZEN AT PAGE ONE: measured, after
  // clicking to `/page/2` it still answers with page one's twelve records and page one's first name.
  // Reading ROWS from it would silently re-emit page one forever — the same failure as the `?page=2`
  // trap, wearing correct-looking names. Reading the COLUMN LAYOUT from it is fine: the layout is a
  // property of the card template, which every page shares, so one calibration names them all.
  listNames: {
    global: 'initialState',
    path: 'data.entity.profile',     // <firm id> → { data: <record> }
    id: '/firm/(\\d+)',              // which record a row is, taken from its own link
    // `at` is a dotted path into the record; `num` compares digits only, so "4 филиала" matches a
    // `branch_count` of 4 and "(362)" matches a review count, in any language.
    fields: [
      // `take: 2` because a 2GIS list mixes two card templates — an ad card puts its address in a
      // different slot from an organic one, so the address genuinely occupies two columns and
      // naming only the first leaves the other as `Text 11`. The second is named `Address 2`.
      { name: 'Address', at: 'address_name', take: 2 },
      { name: 'Category', at: 'rubrics.0.name' },
      { name: 'Branches', at: 'org.branch_count', num: true },
      { name: 'Rating', at: 'reviews.general_rating', num: true },
      { name: 'Reviews', at: 'reviews.general_review_count_with_stars', num: true },
      { name: 'Brand', at: 'name_ex.primary' },
      { name: 'POI type', at: 'poi_category' },
      // `deep` collects every string under the subtree and matches a cell against any of them.
      // The award chip reads «Номинант 2026» while the record files it under an attribute group
      // called «Премия 2ГИС» — same fact, different wording, so only a subtree match finds it.
      { name: 'Award', at: 'attribute_groups', deep: true },
      // `link: true` lets a field name a LINK column. The card's second link is the org's branch
      // list, `/branches/<org.id>`, and the id is in the record.
      { name: 'Branches link', at: 'org.id', link: true },
    ],
    // WHAT THE RECORD CANNOT NAME, named from the page's own word instead.
    //
    // Measured on 12 live records: `is_promoted` and `has_ads_model` are FALSE on every one of
    // them while eleven cards visibly say «Реклама», and `flags` is only `{photos:true}` so
    // nothing backs «Подтверждён». Those columns are card chrome with no typed counterpart, and
    // no amount of matching will invent one.
    //
    // They are still not `Text 6`. A column carrying one short literal on nearly every row IS
    // that literal — it is a badge — so it takes the badge's own text as its name. Language
    // independent because it uses the page's word rather than ours, and scoped to providers that
    // declare `listNames` so no ordinary site's table changes shape.
    badges: { share: 0.7, maxLen: 24, minRows: 3 },

    // AND THE LAST FEW, NAMED BY WHAT THEY DO ON THE CARD.
    //
    // Three columns survive everything above because they are neither a record field nor a fixed
    // badge: the call-to-action captions («Наш инстаграм», «Позвонить», «Написать в WhatsApp») and
    // the advert's own sentence. Their VALUES differ on every row, so value-matching cannot reach
    // them — but their PRESENCE does not.
    //
    //   label — a caption column lights up on exactly the rows where a named LINK column does.
    //           The CTA under a website link appears when there is a website and not otherwise, so
    //           the correlation names it: `Website label`, `Phone label`.
    //   long  — the advert's sentence is the one column of long, mostly-unique prose on the card.
    //
    // Both are structural facts about the card, not vocabulary, so neither needs a word list.
    roles: { label: true, long: { name: 'Description', minLen: 40, unique: 0.7 } },

    // THE CHIP AND ITS LINK. The card's rubric chip («Автосервис») and the `/search/<rubric>` link
    // under it are the last two columns with real content, and neither is a record field: the chip
    // is the SEARCH TERM the card was matched on, not the firm's own category (`rubrics.0.name` is
    // «Легковой автосервис», already named `Category`).
    //
    // They name each other. The chip's text appears URL-ENCODED inside its own href, so the pair is
    // provable rather than assumed — no correlation, no threshold, just a match. The link takes
    // `<name> link`, the text takes `<name>`.
    hrefs: [{ name: 'Rubric', path: '/search/' }],
  },

  // WHAT THE CARD PUTS IN A CELL THAT IS NOT THE VALUE.
  //
  // Read off a real export, every one measured rather than guessed:
  //
  //   `tel:+77775040715`   the href. A phone column that cannot be dialled from a spreadsheet.
  //   «​Улица …»      a zero-width space glued to the front of every organic address.
  //   link.2gis.com/…      four thousand characters of click tracker where a website belongs —
  //                        and the base64 tail's first line IS the destination, so it decodes to
  //                        `http://www.instagram.com/realservicealmaty/`.
  //   ?stat=<base64>       2GIS telemetry riding on the firm link we record. It changes per
  //                        session, so besides being noise it defeats dedupe across scans.
  //
  // `mustMatch` drops the promo banners: a 2GIS list mixes in cards with no `/firm/` link at all,
  // and they arrive as a row of empty cells. Applied only while most rows DO carry one, so this
  // cannot empty a list whose cards simply are not records.
  tidy: {
    zeroWidth: true,
    schemes: ['tel:', 'mailto:'],
    unwrap: { host: 'link.2gis.com' },
    dropQuery: ['stat'],
    mustMatch: '/firm/\\d+',
  },

  // 2GIS CANNOT BE SEARCHED FROM A PHRASE ALONE, and pretending otherwise is how an agent silently
  // searches the wrong country. The city is a PATH segment, not a query term, and the TLD is a
  // different country's database — `2gis.kz` and `2gis.cz` do not know about each other's cities.
  // So both are declared as required, and the tool refuses rather than guesses.
  searchFor: 'https://2gis.{tld}/{city}/search/{query}',
  searchNeeds: ['tld', 'city'],

  // TWO STEPS. The record carries its own email — 70% fill measured on 60 records — so nothing
  // ever visits the business's own website. Drawing a third step that cannot run is a lie the card
  // tells for the whole run, and then the run ends one row above the bottom of its own ledger.
  steps: 2,
};

// --- the reader ---------------------------------------------------------------------------------
export {
  firmId, firmUrl, readFirmHtml, readSearch, searchUrl, lastPage, parseState, firmData, readFirm,
  FIRM_INIT, PER_PAGE, PAGE_CAP_SEEN,
} from './twogis.js';
