// SHOPEE — everything that is true of this storefront and of no other.
//
// Nothing here is imported by the injected engine. `rows.js` is serialised to source by
// `chrome.scripting.executeScript` and therefore cannot import anything at all, which is why the
// DESCRIPTOR below is plain serialisable data: patterns as strings, traits as scalars. It travels
// into the page through `args`, exactly as `provider-x.js` and `provider-gmaps.js` do.
//
// MEASURED LIVE on shopee.co.id, signed in, 2026-09-20. Full teardown in
// `research/SHOPEE-TEARDOWN.md`; the four facts that shaped this file:
//
//   1. ONE BUILD SERVES EVERY MARKET. All ten live Shopee domains ship the same bundle
//      (`shopee-pcmall-live-sg`) — eight on git sha 13cd56bce4bb and the two LatAm ones a single
//      deploy behind on fe83300cbf57. Even Indonesia loads the `-sg` bundle. This is not "similar
//      layouts", it is one deployed frontend behind ten domains, differing only in locale,
//      currency and image CDN host. That is why one host alternation is correct here rather than
//      optimistic, and it is the same reasoning `provider-amazon`'s twenty-TLD alternation rests
//      on. The reverse also holds: a Shopee deploy changes every market at once.
//
//   2. THE PAGE IS FULLY CLIENT-RENDERED. An anonymous fetch of a category URL returns 158,184
//      bytes — byte-identical to what a nonsense path returns — with ZERO product links in it.
//      The same URL in the signed-in browser renders 60 products. There is no SSR payload to
//      parse and no API shortcut that skips the browser. Shopee can only be read by driving a
//      real session, which is exactly what this extension does.
//
//   3. `page_study` PICKS THE RIGHT LIST AND HANDS BACK THE WRONG SELECTOR. Its chosen chain is
//      `div.t5pFIU>div.kr8eST>div.ZK0CJb>div.klSAcl>div.container.cKV3cM>div.u0v0QW>…` — six
//      hashed classes that rotate with every deploy. The semantic hooks sitting right there
//      (`shopee-search-item-result`, `data-sqe="item"`) are hand-written and stable. Everything
//      below keys on those, on ARIA, or on Shopee's own brand tokens; nothing keys on a hash.
//
//   4. `distinctness: 1`. The generic identity heuristic cannot tell one card from another —
//      every product card carries the same SHAPE of links, exactly as X's timeline does. That is
//      a property of the generic engine, not something this file can fix, and it is precisely why
//      the explicit `fields` below are required rather than nice to have.
export const descriptor = {
  id: 'shopee',

  // Strings, not RegExp — see the note above `provider-gmaps.js`'s descriptor for why.
  //
  // TEN LIVE MARKETS, NOT SIX. The first version of this line listed the six SEA domains because
  // those are the six the country research surfaced. Probing every plausible Shopee hostname
  // found four more that are live and on the same bundle — Shopee runs Latin America too, and
  // `shopee.com.br` is a large market that would simply have been missed:
  //
  //   13cd56bce4bb  co.id  sg  com.my  ph  vn  co.th  com.br  com.mx
  //   fe83300cbf57  cl  com.co                       (one deploy behind, same bundle root)
  //
  // The two shas differ only because a rollout is staggered, which if anything strengthens the
  // one-codebase finding: the LatAm pair is running the previous build of the same frontend, not
  // a different frontend. `tw` is kept although it did not resolve from here — Taiwan appears in
  // Similarweb's own rankings under that host, so this is most likely geo-restricted DNS rather
  // than a market that does not exist.
  //
  // Deliberately NOT listed: pl, es, fr, in and the bare shopee.com. All four answered 307/302 —
  // closed markets that now redirect. A descriptor claiming them would be claiming a storefront
  // that is not there.
  host: '(^|\\.)shopee\\.(co\\.id|sg|com\\.my|ph|vn|co\\.th|tw|com\\.br|com\\.mx|cl|com\\.co)$',

  // Deliberately the whole site rather than just the category path. The `list` selector below is
  // what actually gates this: it matches on a category or search page and matches nothing on a
  // product page, so a narrower `path` would buy nothing and would have to be kept in step with
  // every listing route Shopee adds.
  path: '^/',

  // A PRODUCT'S OWN PERMALINK: /{slug}-i.{shopid}.{itemid}. Two ids, both required — the first
  // is the shop and the second is the item. Anchored on the `-i.` marker so that neither the
  // `?extraParams={"display_model_id":…}` query every card appends nor the `/similar` sibling
  // (which robots.txt disallows anyway) can win by being longer, which is the rule that applies
  // when no `recordHref` is given.
  recordHref: '-i\\.\\d+\\.\\d+',

  // PAGES, NOT SCROLL, AND NOT 2GIS'S CLICK-WALK. The dial is `?page=N` in the query string and
  // `rel=next` is published, so the cheapest pagination path the engine has works unmodified.
  // Same value Amazon's search uses, for the same reason.
  //
  // THE DIAL IS ZERO-INDEXED: `?page=0` is the FIRST page, and the site's own numbered pager
  // draws that page as "1". Nothing in this descriptor declares that, because nothing needs to —
  // `pageDial` reads the number correctly and `rows.js` now reads it with `??` rather than `||`,
  // which is what it should always have done. Before that fix `0` was falsy, so the engine threw
  // the real page number away, asked for `pages + 1`, and stopped one page in. Measured here
  // first; the bug was general and belonged to every site that counts from zero.
  grows: 'pager',

  // The container. Its children are the rows — same contract as Amazon's `.s-main-slot`.
  // 60 products a page. Category depth is capped by Shopee at 5 pages (300 items); `page=5`
  // renders an empty grid rather than erroring, so a walk ends honestly by running dry.
  list: 'ul.shopee-search-item-result__items',

  // NAMED FIELDS, read off the card instead of guessed from its shape — required by fact 4.
  // Each value is "css" (read as text) or "css@attr" (read that attribute), relative to one row.
  fields: {
    // THE IMAGE'S `alt`, NOT THE VISIBLE TITLE. Three hooks carry the product name and only this
    // one is clean:
    //   - `.line-clamp-2` text is polluted by a leading `<picture>` flag badge, so the extracted
    //     string can begin with stray markup text on any promoted listing;
    //   - `[role="group"]@aria-label` reads `Product card: <name>` and would need the prefix
    //     stripped, which the `css@attr` grammar cannot do;
    //   - the product image's `alt` is the bare name.
    //
    // THREE DECORATIVE IMAGES ARE EXCLUDED BY NAME, not one. The first version excluded only
    // `flag-label` — measured on shopee.com.br, a card also carries `custom-overlay` (a promo
    // frame over the photo) and `promotion-label-icon` (the icon beside the badge). The product
    // image happens to come first in DOM order, so `querySelector` was picking it anyway; that is
    // luck, not a rule, and the rule is cheap to write down.
    Name: 'img:not([alt="flag-label"]):not([alt="custom-overlay"]):not([alt="promotion-label-icon"])@alt',

    // `a.contents` wraps the whole card. Tailwind's `contents` is a display value, not styling,
    // and has been on this element across every card measured.
    Link: 'a.contents@href',

    // THE BARE `src` IS THE FULL-RESOLUTION ORIGINAL. Shopee's CDN takes a size suffix —
    // `@resize_w320_nl`, `@resize_w640_nl`, optionally `.webp` — and `srcset` only ever offers
    // DOWNSCALES of the original. So the usual "take the largest srcset entry" heuristic is
    // exactly backwards here: the unsuffixed `src` already is the biggest. The CDN host is
    // per-market (`down-id`, `down-br`, …) and comes from `__ASSETS__.MMS_IMAGE_DOMAIN`.
    Image: 'img:not([alt="flag-label"]):not([alt="custom-overlay"]):not([alt="promotion-label-icon"])@src',

    // PRICE, BY POSITION INSIDE THE PRICE BLOCK, NOT BY ITS TAILWIND SIZE CLASS. The amount
    // carries `text-base/5`, whose `/` needs CSS escaping and whose value is a type scale that
    // changes with any design tweak. The block's structure does not: the currency, then the
    // amount, then an empty span. `text-shopee-primary` is a brand token, as stable as the brand.
    //
    // TWO CAVEATS, BOTH MEASURED ON BRAZIL:
    //   - a SECOND `.text-shopee-primary` sits in the same row carrying `after voucher`. The
    //     descendant combinator below still resolves to the price, because only the price wrapper
    //     has an `.items-baseline` child — but the row is no longer single-price by inspection.
    //   - when that qualifier is present the number IS the post-voucher price. Shopee says so on
    //     the card; a column headed `Price` does not. Worth surfacing before anyone averages it.
    Price: '.text-shopee-primary .items-baseline span:nth-child(2)',
    Currency: '.text-shopee-primary .items-baseline span:nth-child(1)',

    // The a11y span carries the discount as an attribute AND as text; the attribute is read so
    // the value survives however the badge is styled. `^="-"` keeps this off the "promotion
    // price" a11y span that sits in the same card with an empty label.
    Discount: '[data-testid="a11y-label"][aria-label^="-"]@aria-label',

    // LOCALE-ABBREVIATED, AND NOT A NUMBER: `10RB+ terjual` in Indonesian, `5mil+ sold` in
    // Brazil. Taken as the site renders it rather than parsed, because parsing it correctly is
    // a per-market rule and this file holds data, not logic.
    Sold: '.text-shopee-black87',

    // ONE SLOT, DIFFERENT CONTENT PER MARKET — and that is why it is called Badge rather than
    // anything more specific. Measured in the same position on both:
    //   shopee.co.id  `Garansi Harga Terbaik`  (a best-price guarantee, red text, no icon)
    //   shopee.com.br `4.8`                    (the RATING, with a promotion-label icon)
    // Naming it `Rating` would be wrong for Indonesia and naming it `Guarantee` wrong for Brazil.
    // A caller that wants a rating column on Brazil reads this one and should be told why.
    Badge: '[aria-hidden="true"] span.truncate',
  },

  // WHAT A PRODUCT PAGE HOLDS, so a details pass does not re-derive a measured site every time.
  //
  // THE COST THIS DELETES. A run over 120 products navigated one tab per product, waited four
  // seconds for hydration and read the rendered DOM: 15-20 seconds each, the better part of an
  // hour, and it finished 48 of them. The description it was waiting for is in `<head>`, in a
  // schema.org block, in the FIRST packet — server-rendered, no React, no scroll. The run paid for
  // a full page render 120 times to read a field that had already arrived.
  //
  // So `record` names the tier rather than a selector: `harvest`'s ld+json tier (see `fromLd`)
  // already picks the Product node out of the three this page ships — it skips BreadcrumbList,
  // WebSite and Organization and takes the biggest of what is left — and `flatten` gives it back
  // as `name`, `description`, `offers.price`, `aggregateRating.ratingValue`. Nothing site-specific
  // is being taught here; the site is being IDENTIFIED as one where the standard answers.
  record: {
    tier: 'ldjson',
    // Named so the caller sees them in the reply, and so a column that stops arriving is visible
    // rather than silently absent. These are ld+json field paths after flattening, not CSS.
    fields: {
      Name: 'name',
      Description: 'description',
      Price: 'offers.price',
      Currency: 'offers.priceCurrency',
      Rating: 'aggregateRating.ratingValue',
      RatingCount: 'aggregateRating.ratingCount',
      Seller: 'offers.seller.name',
      Brand: 'brand',
      ItemId: 'productID',
    },
  },

  // REVIEWS ARE THE ONE THING THAT IS NOT IN THE FIRST PACKET, and saying so is the point.
  //
  // They mount seconds after the document completes and only once scrolled to, which is why a
  // read taken on arrival returns NO_MATCH and why one run concluded "reviews are blocked in
  // background tabs" — they were not, it was reading too early. Recorded here so a caller knows
  // the difference between a field that is free and a field that costs a render, BEFORE planning
  // a pass over hundreds of pages.
  //
  // The API the page itself calls is `/api/v4/item/get_ratings?itemid=…&shopid=…&limit=…`, which a
  // bare navigation cannot reach (error 90309999 — Shopee signs its own requests) but `@fetch`
  // can, because that runs in the page. Cheaper than rendering, and it is the ONLY way to get more
  // than the handful the page shows: the PC review widget has no sort-by-newest control, so
  // "latest N" off the rendered DOM means latest-of-whatever-batch-was-drawn, not latest overall.
  reviews: {
    needsRender: true,
    dom: 'div.shopee-product-comment-list>div.q2b7Oq',
    api: '/api/v4/item/get_ratings?itemid={itemid}&shopid={shopid}&limit={limit}&offset=0&type=0&filter=0&flag=1',
    note: 'the rendered widget shows a fixed default-order batch and offers no sort-by-newest, so '
      + 'latest-N from the DOM is latest of that batch. The api gives the real ordering.',
  },
};
