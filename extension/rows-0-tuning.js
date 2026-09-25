  // --- tuning: every number that is a DECISION, named ---------------------------------------
  // The engine used to carry these inline: `nap(70)`, `both >= 5`, `Math.min(8000, ...)`. Each one
  // was a judgement — a timeout, a threshold, a cap, a ratio — and finding out WHY it was that
  // number meant finding the line. They are declared here, first in the body, so every later part
  // sees them and a reader meets the reasons in one place. The VALUES are unchanged from when they
  // were inline; nothing here is a retune. Constants that a caller can override through `op`
  // (`PRIME_CLICKS`, `SCAN_HOPS`...) stay with the code that reads `op`, in rows-a-state.js, and
  // section-local constants that already had a name (`STILL_TRIES`, `NUDGE`, `STREAM_MS`) stay
  // where their block explains them. Formula weights, indices, `0/1/2` and the numbers inside
  // regexes are not decisions of this kind and were left alone.
  //
  // Grouped by the part that reads them; a constant read from two parts sits under the first.

  // — rows-a-state.js —
  // how much of a feed container's text `feedText` reads — the end-of-list sentinel is appended
  // after the last row, and reading the whole rail every 250ms poll would scan every card
  const FEED_TAIL_CHARS = 400;
  // how often an interruptible wait (`nap`) checks the clock and the stop flag — the grain at
  // which Stop takes effect inside a dwell
  const NAP_TICK_MS = 60;
  // `withinReach`: a control this many viewports down is close enough to press — where a
  // load-more sits while walking towards it
  const REACH_BELOW_SCREENS = 1.2;
  const REACH_ABOVE_PX = 100;  // `withinReach`: and one this far above the top edge still counts as on screen
  // `reach`: a control scrolled into view lands this far down the viewport — never scrolling
  // backwards
  const REACH_LAND_FRAC = 0.4;

  // — rows-b-detect.js —
  // `gridCells` looks at this many multi-child wrappers before deciding their children share no
  // class — the cheapest gate, so it sees few
  const GRID_GATE_WRAPS = 8;
  const LABEL_CLIP = 34;  // a tab label (`labelFor`) is clipped to this many characters
  // a heading must sit above the list it names, allowing this much overlap for fractional layout
  const HEADING_ABOVE_SLACK_PX = 4;
  // ...and no further above it than this — a heading pages above is not this list's
  const HEADING_MAX_ABOVE_PX = 400;
  // ...and overlap it horizontally by at least half the list's width, so the sidebar's heading
  // is not read as the grid's
  const HEADING_OVERLAP_FRAC = 0.5;
  const LABEL_HOPS = 5;  // ancestors walked upward looking for that heading

  // — rows-c-cells.js —
  const RUN_MAX_NODES = 40;  // `textRun`: more inline descendants than this is a structure, not a styled sentence
  // the least number of rows that count as evidence rather than coincidence — for a class to be
  // structure, a caption to agree, a shape to be believed, a column to be judged empty
  const MIN_AGREE_ROWS = 3;
  const LABEL_TEXT_MAX = 40;  // `labelsOf`: a link's own caption longer than this is prose, not a label
  // `tidyRows` drops banner rows only when at least this share of rows carry the record link —
  // otherwise the list is not a list of records
  const TIDY_KEEP_SHARE = 0.6;
  // `mergeTemplates` needs at least this many rows to tell a minority template from noise
  const TEMPLATE_MIN_ROWS = 4;
  // a column filled on more than this share of rows is not a minority template's overflow slot
  const TEMPLATE_MINORITY_SHARE = 0.4;
  const PROSE_MIN_LEN = 40;  // a column whose median value is at least this long is prose, and only prose joins prose
  // `deepStrings`: how deep into a record's subtree to gather strings for a field whose wording
  // differs from the card's
  const DEEP_STRINGS_DEPTH = 4;
  const DEEP_STRINGS_MAX = 400;  // ...and how many strings before it stops
  // descriptor defaults for naming a badge column from its own literal: rows it must appear on
  const BADGE_MIN_ROWS = 3;
  const BADGE_MAX_LEN = 24;  // ...the longest literal that is a badge rather than a sentence
  const BADGE_SHARE = 0.7;  // ...and the share of the column's values that must be that literal
  const LONG_MIN_LEN = 40;  // descriptor defaults for the "long prose" role (`Description`): median length
  const LONG_UNIQUE = 0.7;  // ...and the share of values that must be distinct — a description differs on every row
  // a caption lights up on the rows its link does: both present on this share of the rows either
  // is
  const CAPTION_COOCCUR = 0.8;
  // a SHAPE (Email, Phone, Price...) names a column when this share of its values match — one
  // row cannot decide
  const SHAPE_SHARE = 0.6;
  const OFFSITE_SHARE = 0.6;  // a link column is off-site when this share of its values leave the host
  // THE FLOOR IS 8 ROWS OF EVIDENCE EACH, and it is there because "they never co-occur" is
  // trivially true of two nearly-empty columns — two rows each and the rule would merge two
  // fields that have nothing to do with one another. Eight is the smallest count at which zero
  // overlap is a pattern rather than an accident, and it is well under the 35 the weaker Address
  // column carried. Also the floor for the same-field-copied-twice test (`both2`)
  const MERGE_FLOOR = 8;
  const CATEGORY_FILL_SHARE = 0.6;  // `Category` by distribution: filled on at least this share of rows
  // ...at least this many distinct values, so a column of nothing but `Delivery` stays out
  const CATEGORY_MIN_DISTINCT = 3;
  // ...and no more distinct than this share of its values — a name never repeats, a category
  // does
  const CATEGORY_DISTINCT_MAX = 0.6;
  const CATEGORY_MAX_LEN = 40;  // ...and no long strings, so an address column is not renamed
  // two columns are one column only when identical on at least this many rows — a rule loose
  // enough to drop a fragment is loose enough to drop a real column
  const TWIN_MIN_ROWS = 5;
  // on a map that names its own columns, unnamed leftovers are dropped only once at least this
  // many columns were named — proof that naming worked
  const NAMED_ENOUGH = 5;
  const PLACE_URL_MIN = 24;  // a cell shorter than this cannot hold a Maps place token, so `tokenOfCells` skips it

  // — rows-d-pager.js —
  // `pathOf` keeps at most this many segments plus the element itself — a chain that does not
  // start at the root, and is disambiguated with :nth-child when it must be
  const PATH_SEGMENTS = 8;
  // a run of numbered controls this long, sharing a parent, is a pager; fewer is a price, a
  // rating, a count
  const PAGER_MIN_BUTTONS = 4;
  const PAGER_NAME_MAX = 40;  // an accessible name longer than this is not a pager control's
  const PAGER_MANY_ADDRESSES = 3;  // a next-name carried by this many different addresses on one page is not a pager
  // near misses reported with a negative — five, because a reply is read by something paying for
  // every token
  const NEAR_MISSES = 5;
  const INPUT_MIN_W = 20;  // `signInWall`: an identity field must be visible — at least this wide
  const INPUT_MIN_H = 8;  // ...and this tall
  const CHALLENGE_TEXT_CHARS = 4000;  // how much of a page's text the challenge-word and flagged-word tests read
  // a page with challenge words, no list and less text than this is a puzzle page — the
  // short-page fallback
  const CHALLENGE_SHORT_CHARS = 600;
  // how often the hop frame is re-read while waiting for a client-built list to appear
  const FRAME_LIST_POLL_MS = 300;
  const PACE_BASE_MS = 1100;  // `pace`: the floor between page fetches
  // ...plus this much random jitter — a perfectly regular interval is the one thing a person
  // never produces
  const PACE_JITTER_MS = 900;
  const PACE_PAUSE_ODDS = 0.1;  // ...and this often, the pause where a person actually looked at the page
  const PACE_PAUSE_MS = 1200;  // ...of at least this long
  const PACE_PAUSE_JITTER_MS = 1400;  // ...plus this much jitter
  const PLATFORM_CAP_MIN = 50;  // `platformScan`: the fewest rows a caller's limit can ask for
  // ...the most it can — and the default: a runaway catalogue must not answer as gigabytes of
  // JSON
  const PLATFORM_CAP_MAX = 5000;
  const PLATFORM_MAX_PAGES = 20;  // ...and the most feed pages fetched
  const SHOPIFY_PAGE_SIZE = 250;  // rows per `/products.json` page — Shopify's own maximum
  const HOP_STOP_POLL_MS = 120;  // how often an in-flight hop fetch checks the stop flag so Stop can abort it
  // the most a page fetch may take — twenty seconds is longer than any list page needs and short
  // enough to say so
  const HOP_FETCH_MS = 20000;

  // — rows-e-details.js —
  // `detailPace`: the floor between opening records — faster than turning a page, still jittered
  const DETAIL_PACE_BASE_MS = 350;
  const DETAIL_PACE_JITTER_MS = 450;  // ...plus this much jitter
  const PANEL_MIN_WIDTH = 100;  // a `role="main"` narrower than this is not the record panel
  // how far a scroller probe nudges an element to learn whether it scrolls — moved and put back
  const SCROLL_PROBE_PX = 50;
  // a panel image narrower than this is an avatar or an icon, not a photograph — the size floor
  const PHOTO_MIN_PX = 200;
  const RECORD_POLL_MS = 120;  // how often `awaitRecord` re-checks that the right record has arrived
  // QUIET FOR FOUR STEPS, NOT TWO: with growth observed across naps this is ~280ms of a panel at
  // its bottom that has stopped changing; two steps was 140ms, shorter than the gap between one
  // section mounting and the next
  const WEB_WALK_STILL = 4;
  // 70 rather than 90: the two tests in the walk/web loop are cheap DOM reads, and the loop is
  // what decides how promptly a settled record is released. Over 124 records the difference is
  // real
  const WALK_WEB_TICK_MS = 70;

  // — rows-f-grow.js —
  const SETTLE_TICK_MS = 80;  // how often `settle` re-checks its three quiet signals
  const CONTROL_MIN_W = 24;  // a control narrower than this is not something a person presses
  const CONTROL_MIN_H = 12;  // ...nor one shorter than this
  // levels (the element and three above it) searched for `cursor: pointer` before a div is not a
  // control — past that the pointer belongs to a card or a whole row
  const POINTER_HOPS = 4;
  // a weakly-worded pointer-div shorter than this is a disclosure, not a list extender — fifteen
  // pixels is a disclosure whatever it calls itself
  const DISCLOSURE_MAX_H = 32;
  const TALL_BUTTON_H = 36;  // a control at least this tall earns a point in the load-more ranking — a proper target
  // a load-more scoring at least this needs no wider search — an explicit, strongly-worded
  // button
  const SURE_SCORE = 6;
  // a hop never scrolls past the list: the cap sits this many viewports short of the list's
  // bottom so its end stays in view
  const HOP_CAP_FRAC = 0.6;
  // a caller's `pause` is honoured but never below this — a shorter settle reads a fetching list
  // as finished
  const PAUSE_FLOOR_MS = 1200;
  // after a press, the list fingerprint is re-asked this many times before "nothing changed" is
  // believed — a pager that REPLACES the container lands slower than a background fetch
  const MARK_RECHECKS = 6;
  const MARK_RECHECK_MS = 400;  // ...this far apart
  const PREVIEW_KINDS = 3;  // the panel preview shows one value per kind, at most this many kinds
  const PRIME_STEP_MIN_PX = 400;  // the waking walk moves at least this far per screen
  const PRIME_STEP_FRAC = 0.9;  // ...or this much of the viewport, whichever is more
  const BOTTOM_SLACK_PX = 4;  // "at the bottom" of the document, allowing for fractional heights
  // `regrow` resumes this many viewports above the list's bottom — the frontier is the bottom of
  // the LIST, not of the document
  const FRONTIER_FRAC = 0.9;

  // — rows-g-listmark.js —
  const MARK_LINKS = 6;  // the list fingerprint is the first this many record-shaped hrefs in the container
  const MARK_ROWS = 4;  // ...or, when no href matches, the text of this many of its children
  const MARK_TEXT_CHARS = 60;  // ...each clipped to this

  // — rows-h-state-layer.js —
  const RANDOM_MIN_LEN = 40;  // `looksRandom`: a blob shorter than this is never a secret by shape alone
  const RANDOM_SAMPLE = 64;  // ...distinctness is measured over at most this many characters
  // ...and a ratio of distinct characters at or above this reads as random — `/a/bb/ccc/dddd`
  // fails it, a 40-character API key passes
  const RANDOM_DISTINCT = 0.45;
  const ROOT_SCAN_NODES = 40;  // elements near the top of the body inspected for a React root expando
  const ROOTS_MAX = 4;  // the most framework roots / store-shaped globals discovery reports
  const VUE_SCAN_NODES = 20;  // elements inspected for a Vue app handle
  const STORE_SCAN_GLOBALS = 400;  // the app's own globals inspected for a store shape — one level deep only
  const DISCOVER_SOURCES = 24;  // the most sources discovery lists — a menu, not the meal
  const DISCOVER_IDS = 40;  // webpack module ids shown in a discovery reply
  const DISCOVER_OTHER = 60;  // other globals named in a discovery reply
  const NO_PATH_KEYS = 20;  // keys shown beside a NO_PATH error, so the caller sees what was there

  // — rows-i-read.js —
  // `@html`: a data:/blob: attribute is cut to this many characters — the name is the
  // information
  const HTML_URI_STUB = 24;
  const HTML_ATTR_MAX = 300;  // ...and any other attribute value longer than this is cut there
  const HTML_SPAN_MIN = 1000;  // `@html`: the least markup one reply returns
  const HTML_SPAN = 20000;  // ...the default
  const HTML_SPAN_MAX = 60000;  // ...and the most
  const WAIT_MIN_MS = 400;  // the floor a caller's `waitMs` is clamped to for a press, a choice or a walk
  const WAIT_MAX_MS = 8000;  // ...and the ceiling
  const CHOOSE_WAIT_MS = 2000;  // default wait after choosing a <select> option, for the widget to re-render
  const WALK_CAP = 25;  // default controls pressed in one walk
  const WALK_CAP_MAX = 100;  // ...and the most
  const WALK_WAIT_MS = 1500;  // default wait after each press in a walk
  const BACK_WAIT_MIN_MS = 300;  // the trip back after a press waits at least this
  const BACK_WAIT_MAX_MS = 2000;  // ...and at most this (half the press wait, clamped)
  const COLLECT_HOPS = 20;  // `collectRows` default hops
  const COLLECT_HOPS_MAX = 400;  // ...and the most a caller may ask for
  const COLLECT_WAIT_MS = 900;  // default wait after each collect scroll step
  const COLLECT_WAIT_MIN_MS = 250;  // ...clamped to at least this
  const COLLECT_WAIT_MAX_MS = 6000;  // ...and at most this
  const COLLECT_CAP = 2000;  // default rows collected
  const COLLECT_CAP_MIN = 50;  // ...at least
  const COLLECT_CAP_MAX = 5000;  // ...at most
  const COLLECT_DRY = 3;  // consecutive dry, stuck steps that end a collect
  const COLLECT_DRY_MAX = 8;  // ...the most a caller may ask for
  const VIEW_FALLBACK_PX = 600;  // a scroller reporting no height is stepped as if this tall
  const STRIDE_MIN_PX = 120;  // a collect step is never shorter than this
  // ...and is this much of the pane by default, with an overlap so no row falls between two
  // reads
  const STRIDE_FRAC = 0.8;
  // a stuck step longer than this is halved and retried before "stuck" is believed — a managed
  // scroller refuses a big jump and accepts a small one
  const STRIDE_HALVE_ABOVE_PX = 140;
  const PER_HOP_KEEP = 40;  // per-hop diagnostics kept in a collect reply
  const MAP_ROUNDS = 8;  // `@map`: expansion rounds before it stops pressing disclosures
  const MAP_EXPAND_MAX = 40;  // ...collapsed sections pressed per round
  const MAP_SETTLE_MS = 500;  // ...and the wait for them to open
  const MAP_LINKS_MAX = 400;  // the most links a map reply carries
  const MAP_CONTROLS_MAX = 200;  // ...and the most hrefless controls
  const READ_LIMIT = 200;  // the `read` action's default row count
  const READ_LIMIT_MAX = 500;  // ...and the most

  // — rows-j-explore.js —
  const SCROLL_SLACK_PX = 40;  // a region scrolls when its content is at least this much taller than its box
  const EXPLORE_DWELL_MS = 320;  // wait after each explore scroll for rows to arrive
  const EXPLORE_STILL = 3;  // quiet rounds before a region is "stopped growing"
  const EXPLORE_ROUNDS = 8;  // default rounds a scrollable region is taken toward its end
  const EXPLORE_ROUNDS_MAX = 40;  // ...and the most
  const EXPLORE_SWEEP = 12000;  // elements the explore walk visits — the cap is on visits, not depth
  const EXPLORE_REGIONS = 12;  // regions reported by default
  const EXPLORE_REGIONS_MAX = 40;  // ...and the most
  const FILL_MAX_CHARS = 2000;  // the most text `fill` will type into a field
  const AWAIT_MIN_MS = 200;  // `@await`: the smallest budget honoured
  const AWAIT_DEFAULT_MS = 10000;  // ...and the default
  // after a miss, how long the page is watched for added nodes to answer "would waiting longer
  // help"
  const AWAIT_CHURN_MS = 400;
  const HTML_CHARS_PER_ROW = 400;  // `@html` on a path: a caller's `limit` means this many characters per unit
  const COLLECT_PATH_HOPS = 40;  // `@collect` on a path: default hops
  const COLLECT_ROWS_PER_LIMIT = 20;  // ...and a caller's `limit` means this many rows per unit
  const COLLECT_PATH_WAIT_MS = 700;  // ...with this wait per step

  // — rows-k-main.js —
  // elements a pin selector matches that get a detect sweep each — capped because each attempt
  // is a full sweep
  const PIN_TRIES = 8;
  const BELOW_LIST_MIN_PX = 400;  // a growth control is "just under the list" within this many px of its bottom
  const BELOW_LIST_FRAC = 0.25;  // ...or a quarter of the list's height, whichever is more
  const GROWTH_CANDIDATES = 5;  // growth candidates `study` reports by position
  const SCROLLSTEP_PX = 900;  // how far one `scrollstep` moves a pane
  const PRESS_WAIT_MS = 2500;  // `studypress` default wait after a press or a scroll
  const PRESS_WAIT_MIN_MS = 1200;  // ...clamped to at least this
  const PRESS_WAIT_MAX_MS = 8000;  // ...and at most this
  const PRESS_HOPS_MAX = 50;  // the most hops a container scroll in `studypress` may take
  const NUDGE_SETTLE_MS = 120;  // wait after stepping away from an edge, so the return is a real scroll event
  // how far apart the two matching scroll readings that mean "the pane has come to rest" are
  // taken
  const STILL_POLL_MS = 50;
  // a lane record (`dgrab`/`dwarm`) default: how long to wait for the right record to arrive
  const LANE_ARRIVE_MS = 12000;
  const LANE_WALK_MS = 2500;  // ...how long to walk its panel
  const LANE_WEB_MS = 1500;  // ...how long to wait for the web-results frame (0 is a request not to)
  const LANE_HUNT_MS = 8000;  // ...and how long a warm lane scrolls the rail hunting for the row
  const PROP_MIN_PX = '16px';  // a zero-area pager control is propped to this size for the length of a real press
  // ...and the prop undoes itself after this — a minute, well past the worker's wait for the
  // rows plus the press
  const PROP_TTL_MS = 60000;
  const HUNT_STEP_MS = 120;  // wait per rail scroll while a warm lane hunts for a row
