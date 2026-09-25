// X / TWITTER, as a provider — everything that is true of this timeline and of no other.
//
// Nothing here is imported by the injected engine. `rows.js` is serialised to source by
// `chrome.scripting.executeScript` and therefore cannot import anything at all, which is why the
// DESCRIPTOR below is plain serialisable data: patterns as strings, traits as scalars. It travels
// into the page through `args`, exactly as `tld.js` hands the TLD list to the mail reader.
//
// MEASURED LIVE on x.com/home, 2026-09-18:
//
//   - The timeline is a react-window-style recycler: every post sits in a
//     `div[data-testid="cellInnerDiv"]` positioned with `transform: translateY(...)`, not in
//     normal document flow. Cells get REUSED as you scroll — the DOM never grows to hold the
//     whole timeline, it only ever holds what's near the viewport. That is a `@collect` case
//     (`page_state`'s recycler harvester), not a plain `list_extract` — a virtualized list can
//     never hold more rows than are currently mounted, so reading it once is reading a window,
//     not the timeline.
//   - Confirmed by `page_study`: `distinctness` on the timeline candidate reports 1 despite the
//     rows being genuinely different posts. Per the tool's own documented meaning of that field
//     (see `mcp/tools.mjs`), that does NOT mean the rows are duplicates — it means the engine's
//     generic identity heuristic (`identOf`/`identSpread` in rows.js, the same one every site
//     uses) cannot tell them apart, because every tweet card carries the SAME SHAPE of links —
//     profile, permalink, permalink+"/analytics", sometimes permalink+"/photo/N" — differing
//     only in the embedded username/id, which the heuristic isn't built to weigh. That is a
//     property of the generic engine, not something this descriptor's fields can fix — `identOf`
//     and `identSpread` take no provider input today. The correct read path stays `page_state`'s
//     `@dom`/`@collect`, exactly as `page_study`'s own hint already says for this case.
//   - What THIS descriptor fixes: which link is a post's own permalink, for the two things a
//     descriptor's `recordHref` actually controls — `recordLinkOf` (deciding what to CLICK to
//     open a record) and the record-open passes at rows.js:5008/9885/10160. Confirmed by reading
//     `article[data-testid="tweet"] a[href]` on a live timeline: every card carries several links
//     of the SAME `/status/<id>` prefix — the bare permalink, `/status/<id>/analytics`, and on a
//     media post `/status/<id>/photo/N` — so "the longest href in the row" (the rule with no
//     `recordHref`) picks whichever suffix happens to be longest, not the post itself. Anchoring
//     the pattern to END right after the numeric id excludes those suffixed variants.
//   - Cross-checked against published DOM-based X scrapers (godkingjay/selenium-twitter-scraper,
//     and the community consensus several others converge on): `article[data-testid="tweet"]`
//     and `div[data-testid="tweetText"]` are the two selectors that hold up across projects;
//     the permalink is universally taken from the anchor wrapping the post's own `<time>`
//     element, never from "longest href in the card" — the same failure mode fixed here.
//     Nobody found an embedded JSON/`__NEXT_DATA__` shortcut; every DOM-based tool reads the
//     rendered page directly, matching the approach here.
//   - No separate reader FILE, unlike Maps/2GIS — everything a post needs is already IN the
//     feed row, so there is no per-record page to fetch. But a reader was still needed: the
//     generic column-namer (`nameCols`) works by finding one attribute shared structurally
//     across every row, and a timeline interleaves plain tweets, quote-tweets, and promoted
//     ads that each nest their content at a DIFFERENT depth — there is no shared structural
//     anchor, so `nameCols` fell back to printing the raw CSS path AS the column name.
//     Reported live: a saved table's own column headers were 300+ character selector strings,
//     not "Author"/"Text" — which is what "no post data at all" actually was.
//   - FIX: `fields` below, read by `providerFieldsOf` in rows.js — named selectors relative to
//     the row, in the SAME "css@attr" shorthand `page_harvest` already uses. `cellsOf` checks
//     this before falling back to the generic structural walk, and produces `@`-prefixed keys
//     — the SAME convention a Maps/2GIS detail-page read already uses to tell `nameCols` "this
//     came from asking for a named thing, do not guess" (see `nameCols`'s `col.key.startsWith
//     ('@')` branch). No change needed to the naming step at all; this just gives it named
//     fields to skip guessing on.
//   - Selectors verified live against real rows, including a promoted/ad card, 2026-09-18:
//     the engagement counts all live in ONE element's `aria-label`
//     ("69 replies, 21 reposts, 202 likes, 8 bookmarks, 211668 views") rather than one button
//     each, and the avatar wrapper's `data-testid="UserAvatar-Container-<handle>"` plus its own
//     `href` name the author reliably even on an ad, where `[data-testid="User-Name"]"`'s own
//     text can be sparser.
export const descriptor = {
  id: 'x',
  // Strings, not RegExp — see the note above `provider-gmaps.js`'s descriptor for why.
  host: '(^|\\.)(x|twitter)\\.com$',
  path: '^/',

  // A post's own permalink, and ONLY that — not its "/analytics" or "/photo/N" siblings, which
  // share the same `/status/<id>` prefix and would otherwise win on length. Anchored at the end
  // so a suffixed variant fails to match rather than winning by being longer.
  recordHref: '/status/\\d+$',

  // THE TIMELINE HAS NO PAGER AND NO "LOAD MORE" BUTTON — it lengthens in place as you scroll,
  // same mechanism as Google Maps' rail (see `provider-gmaps.js`).
  grows: 'scroll',

  // THIS APP REPLACES ITS OWN LIST CONTAINER WITHOUT NAVIGATING, so rows already captured must
  // survive the swap. Measured live: X mints a brand-new timeline root mid-scan (logged as
  // `session.new why=document changed`), which strands the per-container snapshot store and made
  // a genuine 28-row walk read back as 8. `rows.js` keeps a window-level accumulator for exactly
  // this (`allSeen`) — this flag is what says to MERGE it into an extraction.
  //
  // IT IS A FLAG AND NOT THE DEFAULT BECAUSE IT CHANGES WHAT AN EXTRACTION MEANS: with it, a read
  // answers "every row this tab has ever shown" instead of "every row this list holds now". On a
  // recycler whose container is swapped from under us those are the same sentence. On an ordinary
  // page they are not, and merging there over-reports — caught by `test/rows.mjs`'s `/buried`
  // re-read, which pressed a fixture's own button and got back every row of every earlier press
  // (1,104) where the page held 144. Sites that do not do X's swap must not pay for it.
  keepSeen: true,

  // NAMED FIELDS, read directly off the row instead of guessed from its shape. Each value is
  // "css" (read as text) or "css@attr" (read that attribute) — relative to `article[data-testid
  // ="tweet"]`. `Link` reuses the SAME analytics-link-minus-suffix the `recordHref` pattern
  // targets, so both agree about what a post's permalink is.
  fields: {
    Author: '[data-testid="User-Name"]',
    // The container itself carries no href — it wraps an <a> around the avatar image — so the
    // selector has to reach the anchor specifically, not just the testid'd wrapper.
    Handle: '[data-testid^="UserAvatar-Container-"] a@href',
    Text: '[data-testid="tweetText"]',
    Time: 'time@datetime',
    Engagement: '[role="group"][aria-label]@aria-label',
    // Same shape: the engagement group is a container, and the permalink's <a> is its child.
    Link: '[role="group"][aria-label] a@href',
    // A post's own media, not just its text — reported live as "post has no image or video":
    // every field above describes the WORDS of a post, and a photo/video post's actual picture
    // never had a column at all. `tweetPhoto` is the one wrapper testid X uses for BOTH — a
    // plain photo is an <img> directly inside it (verified live: a real, directly-loadable
    // `pbs.twimg.com/media/...` url, no blob involved), while a video nests its own
    // `videoPlayer` block inside the SAME wrapper and carries its thumbnail on the <video>'s
    // `poster` attribute, never on an <img> — the two never both match, so a post gets whichever
    // one of these two columns actually applies to it, never both empty.
    Image: '[data-testid="tweetPhoto"] img@src',
    VideoThumb: '[data-testid="tweetPhoto"] video@poster',
  },
};
