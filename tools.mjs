// The tool surface: the schema helpers, every tool description, and the name -> browser-op map.
//
// SPLIT OUT OF index.mjs BECAUSE THIS IS THE PART THAT GROWS. The plumbing beside it — pairing,
// RFC 6455 framing, the JSON-RPC loop — is finished and rarely touched; the descriptions are
// edited every time a capability lands, and they are the ONLY documentation that travels. A user
// who installs this package on another machine gets these strings and nothing else: no repo, no
// design notes, no memory of the session that learned the thing. So they are written long on
// purpose. Length here is not clutter, it is the whole manual.
//
// Keep both copies of this tree byte-identical (see the note at the top of index.mjs), and keep
// `files` in package.json listing every module — a missing entry ships a package that throws on
// import, and the first person to find out is a stranger running `npx`.

const T = (name, description, props = {}, required = []) => ({
  name, description,
  inputSchema: { type: 'object', properties: props, required, additionalProperties: false },
});
const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const N = (description) => ({ type: 'number', description });
const B = (description) => ({ type: 'boolean', description });
// An array of strings and a fixed-shape object, for the projection and the keyed join. Both are
// DATA-shaped on purpose: a field path and a lookup key are the only things this vocabulary accepts
// in place of code, and `additionalProperties: false` keeps the join from growing a surface nobody
// reviewed.
const A = (description) => ({ type: 'array', items: { type: 'string' }, description });
const O = (description) => ({
  type: 'object',
  description,
  properties: {
    from: { type: 'string', description: 'Field path on each row holding the key to look up.' },
    into: { type: 'string', description: 'Path of the collection to look the key up in.' },
    fields: { type: 'array', items: { type: 'string' }, description: 'Field paths to merge in from the record found.' },
  },
  required: ['from', 'into'],
  additionalProperties: false,
});

// EVERY VERB IS ONE WE WROTE, AND NOT ONE OF THEM TAKES CODE. See `bridge-ops.js` — a tool that
// accepted a script body would be an MV3 remote-code rejection and would also hand arbitrary
// execution inside a signed-in browser to whatever a poisoned page talked this agent into.
// (This line used to open "ELEVEN VERBS" and there were thirteen. A count in a comment is a fact
// with no test behind it; the property that matters has never changed.)
//
// The descriptions are written for a model deciding WHICH to call, so each says what it is for
// rather than what it does, and names the tool that comes next.
const TOOLS = [
  T('current_page',
    'The page the person is looking at right now, and what can be extracted from it. Takes no '
    + 'arguments — use this for "I have a page open, scrape it". Returns a tabId to pass to '
    + 'page_study or list_extract. Honours a page the person pinned in the HoloScrape panel; '
    + 'otherwise it is the active tab of their last-used Chrome window. '
    + 'IT MOVES WHEN THEY BROWSE. Unpinned, this is a live reading of wherever they are now, not a '
    + 'handle on the page you started from — a run that keeps calling it can silently change '
    + 'subject when the person opens something else. Capture the tabId ONCE and pass it explicitly '
    + 'for the rest of the run. '
    + 'If a tab that was working starts hanging on every call, the extension was probably reloaded '
    + 'underneath it: tabs open from before hold a dead engine and never answer. Open a fresh one.'),

  T('tabs_list',
    'Every http(s) tab open in the person\'s browser. Use only when current_page is not the one '
    + 'they meant and you need to ask which — for the ordinary case prefer current_page.'),

  T('page_harvest',
    'COST FIRST — THIS OPENS ONE PAGE PER RECORD, AND THAT IS MINUTES. Before calling it, ask what '
    + 'the LIST PAGE already shows. If the fields you need — name, price, rating, seller, link — are '
    + 'on the cards, list_extract or page_state "@dom(<row css>)" answers in SECONDS without opening '
    + 'anything, and cannot trip a per-page rate limit. Measured on one marketplace search: 95 '
    + 'products took 6m38s through here and would have been ~15s off the list. Use this only for '
    + 'what is NOT on the list — a full description, sku, stock, variants, specs, reviews.\n'
    + 'THEN THE SECOND QUESTION: how many pages. Cost is pages x per-page-load / lanes. Lanes divide '
    + 'it up to about 5 and then stop helping — measured, 8 lanes is SLOWER and loses rows, and on a '
    + 'site that checks for humans more lanes buys thin pages and challenges rather than speed. '
    + 'Default 5; drop to 2-3 on anything that has already shown a captcha.\n'
    + 'Follow a list into every one of its records and keep the rows HERE, in a result you export — '
    + 'THE TOOL FOR "open each of these and get me X". The extension does the iterating: it opens '
    + 'the pages in parallel lanes, extracts each one, accumulates the rows and hands back a '
    + 'resultId. You make ONE call and never see a row.\n'
    + 'USE IT INSTEAD OF LOOPING. Doing this by hand — tab_here, then page_state, then writing the '
    + 'rows out, per item — was measured on 250 film pages at 52 minutes and 733 calls, and the '
    + 'timing says the browser was 17% of that while ~80% was reading rows out of one call and '
    + 'typing them into the next. The same work here is minutes, because the rows never move '
    + 'through you.\n'
    + 'WHAT COMES BACK IS A COUNT AND A resultId, deliberately — then results action:"get" for a look '
    + 'at the first rows, or results action:"export" to write the whole table to a file. Asking for 12,000 rows in '
    + 'a reply is the thing this exists to stop.\n'
    + 'READ `fields` BEFORE YOU DOCUMENT A COLUMN. `filled` says a column has values; it does NOT '
    + 'say they are values OF THE ROW, and a column that is populated and misidentified is worse '
    + 'than an empty one because it reads as verified. `distinct` is the tell — 50 pages answering '
    + 'with 5 different values is a property of something COARSER than the row (the shop, the page, '
    + 'the site) wearing the name you gave it. Measured: a `rating` asked for per listing came back '
    + 'filled 66 of 70 and was reported as each item\'s rating; it was the SELLER\'s, disprovable '
    + 'from the same table where a row reading "4 out of 5 stars" carried three five-star reviews of '
    + 'its own. Cross-check one row against its own contents before naming what a field means. '
    + '`fieldsWhy` covers the opposite failure — filled but hollow, 1-2 characters per cell.\n'
    + 'ONE PAGE MAY YIELD MANY ROWS. A film has a cast, a product has variants and reviews, a '
    + 'question has answers. Give `rows` for those. Give `record` for the one-per-page fields '
    + '(title, price, sku); they are copied onto every row from that page, so a cast row carries '
    + 'its film. Give NEITHER and it reads schema.org (ld+json), which most commerce and most '
    + 'editorial already publish — often the whole answer with no selectors at all.\n'
    + 'A page that yields nothing is reported in failed[] with the reason, never as an empty '
    + 'success, and a truncated row group sets capped. If a site asks to verify a human, every lane '
    + 'stops and walled comes back true — relay that, do not retry.\n'
    + 'IT READS EVERY PAGE TWICE BEFORE CALLING IT EMPTY — once at load and again after a '
    + 'settle — because a storefront or any script-drawn page is complete before its fields '
    + 'exist, and one read cannot tell that apart from a block. `late` says how many only '
    + 'answered on the second look: high means client-rendered and slower, NOT blocked. So '
    + 'refused is a claim you can pass on, and rows missing while `read` is high is your '
    + 'SELECTOR — most often a hashed classname copied off the list page, which is '
    + 'per-component and differs on the record page.\n'
    + 'CLIENT-RENDERED SITE? NAME THE API INSTEAD OF THE MARKUP. Set `network` to a substring of \n'
    + 'the request url the page fetches its data from ("gql.tokopedia.com", "/api/products") and \n'
    + 'every matching JSON response is captured IN THE LANE. Then any field in `record` or \n'
    + '`rows` may be a $. path into that JSON instead of a CSS selector: `$.data.product.title`, \n'
    + 'or `$..description` to find a key at any depth. `rows.at` as a $. path makes a JSON array \n'
    + 'the rows, and fields inside it are paths into each element. Mix freely — the title from \n'
    + 'the DOM and the description from the response is the ordinary case. The payloads never \n'
    + 'leave the browser; only rows come back. Find the right filter and paths with ONE \n'
    + 'tab_here({network}) first, then harvest the set. Costs a debugging banner per lane, and \n'
    + 'a lane whose tab has DevTools open runs DOM-only and says so. `netMissed` counts pages \n'
    + 'where nothing matched — if it equals the page count, your filter is wrong, not the site.\n'
    + 'ZERO SELECTORS IS A REAL OPTION AND THE FASTEST ONE. Proven on a live recipe page: no '
    + '`record`, no `rows`, and it returned the full header (name, times, yield, rating) plus '
    + '13 review rows from ld+json alone. If a page publishes schema.org, try the empty call '
    + 'FIRST and read `columns` — reconnaissance you did not have to do is the whole margin.',
    { tabId: N('The list page, if you are using `links`. Not needed when you pass `urls`.'),
      urls: A('The pages to open. Either this or `links`.'),
      links: S('OPTIONAL — omit it and the engine picks the ranked list itself (page_study\'s '
        + 'chosen candidate) and follows its links, reporting the selector it used as linksVia. '
        + 'Name one only when you mean a DIFFERENT list than the main one. Writing it by hand is '
        + 'how a build-hashed class from another page of the same site ends up matching ten '
        + 'elements on a page that holds 180. CSS selector for the LINKS on the list page — every matching href is followed, '
        + 'de-duplicated. Prefer this over `urls`: typing 250 URLs into a call is ~12KB of exactly '
        + 'the output this tool exists to remove.'),
      record: { type: 'object', additionalProperties: { type: 'string' },
        description: 'The one-per-page fields, as {name: "css"} — e.g. {"film":"h1","year":".year"}. '
          + 'Use "css@attr" to read an attribute ("a@href" comes back absolute). Copied onto every '
          + 'row from that page.' },
      rows: { type: 'object',
        description: 'The repeating block on each page. {at: "css for one row", fields: {name: "css '
          + 'relative to that row"}, limit: n}. Each row is given `billing` (1-based position) '
          + 'unless you name your own.',
        properties: {
          at: { type: 'string', description: 'CSS for one repeating row on the record page.' },
          fields: { type: 'object', additionalProperties: { type: 'string' },
            description: 'Field name → CSS, relative to the row. "css@attr" reads an attribute. '
              + 'USE ":self" TO TAKE THE ROW\'S OWN TEXT, whole and unparsed. That is the answer '
              + 'when a site has moved its per-field hooks and your inner selectors come back empty: '
              + 'measured on a marketplace whose review markup no longer carried the title and body '
              + 'hooks, where two attempts returned those columns ABSENT while the row itself held '
              + 'every word. One {"review": ":self"} beats guessing at hooks, and the text can be '
              + 'split afterwards.' },
          limit: { type: 'number', description: 'Rows per page, default 500. Over it, capped is set.' },
          from: { type: 'string', description: 'WHICH schema.org array becomes the rows, by name — '
            + '"recipeIngredient", "review", "offers", "actor", "itemListElement", "performer". Use '
            + 'this INSTEAD of `at` when the page publishes ld+json: it costs no CSS and no look at '
            + 'the markup. A page often carries several; without this the documented order decides '
            + 'and the reply tells you what it passed over in `alsoRows`.' },
        },
        required: [] },
      lanes: N('Pages open at once. Default 5. More is not always faster and looks more like '
        + 'scraping from the person\'s own address.'),
      limit: N('Pages per run. Use it to pilot on 3 before committing to 250 — and NOTE it does '
        + 'not trim a reply, it DROPS PAGES. When it cuts the queue the reply carries matched, '
        + 'skipped and nextFrom; feed nextFrom back as `from` to take the next fold.'),
      from: N('Skip this many of the matched links before starting — the resume point for a run '
        + 'that was capped by `limit`. Take it from the previous reply\'s nextFrom. Same links, '
        + 'next slice, so a long list can be done in folds instead of abandoned at the cap.'),
      network: S('Substring of the request URL whose JSON responses should be captured for every '
        + 'page, e.g. "gql.tokopedia.com". Fields may then be $. paths into that JSON. Without '
        + 'this nothing is captured and no debugger is attached.'),
      background: B('SET THIS FOR ANYTHING OVER ~20 PAGES. Returns a runId immediately instead of '
        + 'blocking; results action:"status" then reports pagesDone, percent, rowsSoFar, failedSoFar and '
        + 'an eta, and results action:"stop" ends it. Without it a 250-page harvest is minutes of total silence, during '
        + 'which you cannot answer "how far along is it?" and neither you nor the person can tell a '
        + 'working run from a hung one. Poll every 20-30s and relay the percentage.') },
    []),

  T('tab_here',
    'Point a tab you already have at a different URL, and wait until it is actually loaded. THE '
    + 'WAY TO VISIT MANY PAGES. newTab:true makes a NEW tab every time and nothing closes them, so N '
    + 'destinations means N tabs the person clears by hand; page_grow mode:"walk" presses instead, which '
    + 'works on an app that changes route without reloading and CANNOT work anywhere else — a real '
    + 'page load destroys the frame the walk is running in, and the call dies reporting "Frame with '
    + 'ID 0 was removed" even though the tab arrived. This runs outside the page, so a navigation '
    + 'cannot kill it. One tab, many destinations, nothing left behind. '
    + 'FOR ONE DESTINATION, OR A FEW THAT DIFFER FROM EACH OTHER. If you have a LIST and you want '
    + 'the same thing off each page, that is page_harvest, not this in a loop — the extension '
    + 'iterates, the rows never pass through you, and it is the difference between a handful of '
    + 'calls and one per page. This tool REFUSES after a few navigate-then-read-rows cycles and '
    + 'says so; pass oneByOne:true if the pages really are unrelated. '
    + 'Returns arrived:false if the URL did not change, and the reply is '
    + 'only sent once the new document is ready, so what you read next is the page you asked for '
    + 'and not the previous one.',
    { tabId: N('The tab to move. It keeps its id — this is the same tab, somewhere else.'),
      url: S('http or https. Subject to the same per-origin consent as everything else.'),
      newTab: B('Open a NEW tab instead of moving this one. Leaves a tab behind for the person '
        + 'to close, so use it only when they asked for a new tab, or when there is no tab to move.'),
      search: S('Search a site instead of naming a URL: the words to search for. With this, `url` '
        + 'is the SITE (a hostname or its search page) and the search is run there — the same '
        + 'thing a person does by typing into the site\'s own box, which beats guessing a query '
        + 'string. Reports what the site actually returned.'),
            oneByOne: B('Only when a sweep is genuinely not a sweep. After a handful of navigate-then-read-rows '
        + 'cycles this tool REFUSES and points you at page_harvest, which does the rest in one call. '
        + 'Set this when the pages differ from one another and must be visited in turn — a login, a '
        + 'form, a set of one-off lookups.'),
      network: S('START WITH "*" ON ANY SITE YOU DO NOT ALREADY KNOW. That is DISCOVERY: it maps '
        + 'every response the page fetched on load — url, mime, size, and for JSON the list of '
        + 'paths inside it with types, array lengths and a sample of each string — and returns NO '
        + 'bodies. From that map you get both things page_harvest needs: which url substring to '
        + 'filter on, and the exact $. paths to name as fields. Without it you would be guessing '
        + 'the API host and the payload shape, which is why capture alone is not enough. '
        + 'Substring to match against request URLs during navigation — when set, the debugger '
        + 'is attached for the duration of the page load and EVERY matching response is '
        + 'returned in a `network` array alongside the normal arrived/url fields. Use this when the '
        + 'data you want lives in an API response the page fetches on load (GraphQL, REST) and is '
        + 'not yet in the DOM. Example: "gql.tokopedia.com" captures the product-detail GQL reply '
        + 'before React renders it — navigate + read in one call instead of two. Attaches and '
        + 'detaches the debugger automatically; shows a brief yellow bar on the tab.') },
    ['url']),

  T('page_study',
    'AN EMPTY growth.candidates MEANS "NOT THERE YET", NOT "NEVER". A lazy list often renders its '
    + 'load-more only AFTER the first batch fills, so a study run at first paint truthfully finds '
    + 'nothing. Measured on a live storefront: 13 buttons on the page and no load-more at 10 rows; '
    + 'the same control appeared once the list was deep. Grow the list, then study again — do not '
    + 'conclude from one empty read that the list cannot grow. (The matcher itself is wide: it '
    + 'reads "Muat Lebih Banyak" and its equivalents in a dozen languages.)\n'
    + 'Every repeating structure on a tab, RANKED, with the evidence behind the ranking — plus how the '
    + 'page continues (next link, rel=next, numbered pager) and what might load more. Use this when '
    + 'page_study gave a list you do not trust, or before writing a scrape you want to be right: it '
    + 'returns several candidates rather than one verdict, so YOU choose. Read two fields before '
    + 'trusting the one it marks chosen: looksLikeFurniture (the candidate sits inside a footer, nav '
    + 'or aside landmark — measured on real sites where the engine picked a footer site-directory and '
    + 'a filter sidebar over the actual results) and distinctness (rows that all point at the same '
    + 'place are one record repeated, which is how a filter panel outscores a product grid). Growth '
    + 'affordances come back verified:false — press one with page_grow to find out. They come from '
    + 'TWO sweeps and carry which one found them: position (a clickable sitting just under the '
    + 'list) and via:"findLoadMore", the hardened sweep that reads direct text and accepts a '
    + 'div or span behind a cursor:pointer check — because the load-more is often not a button, '
    + 'and is often not near the list either. An EMPTY candidates list now means both sweeps '
    + 'found nothing, not that nobody looked. '
    + 'IF WHAT YOU WANT IS NOT ONE OF THESE LISTS, STOP LOOKING FOR A LIST. This tool only sees '
    + 'repeating structure, and much of what people ask for is not repeating structure on THIS '
    + 'page: a name in a header is page_state "@dom(...)"; the markup itself, when a '
    + 'tool refuses something you can plainly see, is page_state "@html(...)"; and a value on each of '
    + 'many pages rather than in a list on this one is page_harvest. Measured: an agent spent a whole '
    + 'session trying to extract 23 server names from a rail that carries none, while pressing '
    + 'each server put its name in the title bar. Re-frame after the FIRST refusal, not the fifth.',
    { tabId: N('From current_page, tab_here or tabs_list.') },
    ['tabId']),

  T('page_grow',
    'A BACKGROUND TAB LOADS NOTHING. Chrome stops animation frames in a tab nobody is looking at, '
    + 'and a lazy list rides them — so grew:false on a background tab is not an answer about the '
    + 'site. Measured: scrollTop moved 572 -> 3136 across twelve hops with fresh:0 every time, and '
    + 'the same page loaded fine when the tab was focused.\n'
    + 'FEED MODE — pass `network` and `rows.at` and this stops reading the DOM at all: it scrolls one '
    + 'step, reads the request THAT SCROLL CAUSED, takes the items straight out of the JSON, and '
    + 'repeats until the site stops returning new ones. Use it for an infinite list, a VIRTUALIZED '
    + 'list (the DOM only ever holds a screenful, so a DOM read loses rows as they unmount), or any '
    + 'feed where a reply-size budget caps what one read can return. The site paginates itself — no '
    + 'cursor or offset to work out — and "no new items" is the list ENDING, said by the site '
    + 'itself. Rows accumulate in the browser. NOTE the first screenful is usually already in the '
    + 'document and NOT in the capture, so read that from the page and treat this as what follows.\n'
    + 'Press a load-more control, or scroll — the window, or ONE scrollable container — and report '
    + 'how the list changed. This is the only honest way to answer does-this-load-more: a button '
    + 'saying More may do nothing, and a page with no button at all may grow on scroll. The '
    + 'selector takes two kinds of target, told apart by what it points at: a control from '
    + 'page_study growth.candidates gets PRESSED; a scrollable container — one of page_study '
    + 'lists[].selector, or any CSS selector of the pane — passed with scroll:true gets scrolled '
    + 'to ITS OWN bottom instead of the window\'s. Use the container form whenever the page has '
    + 'more than one scrollable region (a sidebar list beside an open conversation, a rail beside '
    + 'results), because scrolling the window there moves the pane you did NOT mean. A '
    + 'container-targeted grow reports containerRows before/after beside the page-wide '
    + 'recordLinks count: rows that carry no links — a chat list is divs all the way down — read '
    + 'as 0 record links forever, so containerRows is the growth signal to trust there, and a '
    + 'scrolled {from,to,max} triple says whether the pane even moved. CHANGES THE PAGE, unlike '
    + 'page_study. IT REPORTS WHETHER THE LIST IS REPEATING ITSELF: `duplicates` gives domRows, '
    + 'unique (counted by the same row identity the export uses), duplicates, loopingPct and '
    + 'uniqueGained. A feed can grow forever without ever adding a row you do not already hold '
    + '— measured, one marketplace re-serves the same ~284 products until the DOM holds 2,000 — '
    + 'so uniqueGained, not domRows, is what the table will contain. Hops stop for two DIFFERENT '
    + 'reasons and stoppedEarly says which: nothing arriving at all, or rows arriving that are '
    + 'all rows the list already had. '
    + 'grew:false with by:0 is a real answer, not a failure — and a selector that '
    + 'matches nothing fails naming the selector rather than silently scrolling the window.',
    { tabId: N('The tab.'),
      mode: S('What kind of press. "grow" (default) makes a LIST longer and reports whether it '
        + 'actually grew. "walk" presses one thing and reports what CHANGED — for an app that '
        + 'swaps content without loading a document; it cannot follow an ordinary link, because a '
        + 'real navigation destroys the frame it runs in (use tab_here for that). "explore" opens '
        + 'what is collapsed and reports what appeared.',
        { enum: ['grow', 'walk', 'explore'] }),
      text: S('walk mode: what the person would CLICK, in their words. Prefer this over a '
        + 'selector — it survives a redesign that renames every class.'),
      choose: S('walk mode: CHOOSE AN OPTION IN A <select>, by the option\'s visible words — '
        + '"Most Recent", "Highest rated", "100 per page". A <select> does not answer a click, so '
        + 'this is the only way to reach content that exists only behind a chosen option: sort '
        + 'orders, filter selects, per-page counts, date ranges, locale and currency. THE DEFAULT '
        + 'ORDER OF A REVIEW OR RESULT LIST IS ALMOST NEVER DATE ORDER — it is relevance or '
        + '"most helpful" — so "the 3 latest" read off the page as it loads is usually wrong; choose '
        + 'the date option first. Finds the select BY the option, so no selector is needed unless the '
        + 'page carries several with overlapping names. Reads `changed`: false means the option was '
        + 'set and the page looked identical afterwards, which is either a slow re-render (raise '
        + 'waitMs) or a widget that ignores the event — do not report the rows as re-sorted until it '
        + 'is true. Pass `read` with the row selector and the reply carries the rows themselves, '
        + 'which is how you verify the order actually changed. Unlike a press this does NOT return '
        + 'to where it started: the point of choosing is that the next read sees the new order.'),
      back: B('walk mode: return to the page this walk started from when it is done.'),
            selector: S('A control from page_study growth.candidates to press, OR any CSS selector of '
        + 'a scrollable container to scroll (pass scroll:true with it). Omit to scroll the window.'),
      scroll: B('Scroll instead of pressing. Alone: the window, to the page bottom. With a '
        + 'selector: THAT container, to its own bottom — the right mode for a pane beside other panes.'),
      waitMs: N('How long to wait for new rows. Default 2500, max 8000.'),
      direction: S('Which way to scroll a container: "down" (default) for more of a list, or "up" for OLDER content. A conversation loads its history upward — the newest message is already at the bottom, so scrolling down there reports grew:false truthfully and uselessly.'),
      hops: N('How many times to scroll and wait, for content fetched a page at a time. Default 1, max 50. Ten hops up a channel is ten pages of history. Stops early when two hops in a row bring nothing, and reports perHop so you can see what each one added.'),
      network: S('Substring of the request URL the scroll triggers, e.g. "/api/search". Turns on '
        + 'FEED MODE: items come from the response, not the DOM. Needs rows.at. Find it with '
        + 'tab_here({network:"*"}) on this page.'),
      rows: { type: 'object',
        description: 'Feed mode only. {at: "$..items", fields: {name: "$.title"}} — `at` is a $. '
          + 'path to the ARRAY of items in the response; fields are paths inside ONE item.',
        properties: { at: S('$. path to the array of items in the captured response.'),
          fields: { type: 'object', additionalProperties: { type: 'string' },
            description: 'Field name -> $. path, relative to one item.' } } } },
    ['tabId']),

  T('page_state',
    'WATCH THE NETWORK: path "@net(<url substring>)" starts a watch on this tab that OUTLIVES the '
    + 'call, "@net(*)" watches EVERY response — images, fonts, stylesheets and documents as well as '
    + 'the data calls — "@net()" polls what has arrived SINCE THE LAST POLL, and "@net(stop)" ends '
    + 'it. A url substring is not a category filter either: ask for "cdn.example.com" and you get '
    + 'every response from it, pictures included. Use it when the data appears because of something '
    + 'you are about to do — a filter click, a drawer, a search box, a scroll — rather than on page '
    + 'load: start the watch FIRST, then do the thing with any tool, then poll. A watch cannot '
    + 'recover requests the page already made, so starting one after the fact returns nothing.\n'
    + 'WHAT A POLL RETURNS, and why it is three fields rather than one: `responses` are the ones '
    + 'whose body was read and shaped into $. paths — hand those to page_harvest({network}) or '
    + 'page_grow({network, rows}). `network` NAMES every response with url, mime, status, kind and '
    + 'bytes, so a page that fetched 290 things is not reported as the 12 that happened to be JSON. '
    + '`kinds` counts them by resource type, which is the same grouping the browser\'s own network '
    + 'panel puts on its filter buttons. Bodies are read only for the data-shaped ones because a '
    + 'decoded image is bytes you cannot use — to read a specific one, name its url with '
    + '"@net(<substring>)". Holds a debugger on the tab (yellow bar, and DevTools cannot be open on '
    + 'it) until stopped, so stop when done.\n'
    + 'Read the app\'s OWN in-memory state — the store it renders the page FROM — instead of the '
    + 'rendered page. DISCOVERY COMES FIRST, THEN A PATH: call with tabId alone and you get a map '
    + 'of what state this app has (bootstrap globals like __INITIAL_STATE__ or __NEXT_DATA__, '
    + 'store-shaped globals, React/Vue roots, the webpack module registry), each with a short '
    + 'shape summary and the exact path prefix to read it with; call again with path set to one of '
    + 'those to read that slice. There is no way to pass code — only a data path '
    + '("chats[0].id", "@mod[\\"WAWebContactCollection\\"].ContactCollection"), which is walked as '
    + 'properties and never evaluated. ONE PSEUDO-SOURCE READS THE RENDERED PAGE INSTEAD OF THE '
    + 'STORE: path "@dom(<css selector>)" returns the elements that selector matches, each with '
    + 'its text, label (aria-label or title — often the ONLY name an icon has), href and img. No '
    + 'ranking, no list detection, no re-detection — the three things that can each lose rows '
    + 'between what is on screen and what comes back. Use it whenever a list_extract run returns '
    + 'fewer rows than you can see, or to read a header, a title or any single element. '
    + 'Best for: virtualized and recycler lists, where the DOM '
    + 'holds the mounted window and can never hold the list — and for any record whose fields the '
    + 'DOM simply omits. The measured example is a chat list: a pinned list_extract returned 67 '
    + 'rows of a much longer list, and a phone number for UNSAVED contacts only, because the '
    + 'markup carries no number for a contact the app has a name for. Its store carries both. Not '
    + 'recommended for: anything the DOM already shows — list_extract is cheaper, follows pages by '
    + 'itself and hands back a saved table you can export, and page_study will tell you whether '
    + 'the DOM has the field at all. Reach for this when a run came back SHORT, or came back '
    + 'missing a field the app plainly knows. NEITHER LAYER IS COMPLETE ALONE, so never conclude '
    + 'a field is unavailable from one of them: measured on a chat app, the store held only '
    + 'privacy identifiers where a phone number belonged while the rendered page displayed the '
    + 'real numbers the app had resolved for display. If a state read lacks what the app plainly '
    + 'shows, re-read the DOM with page_study and list_extract before reporting it absent — and '
    + 'the reverse when the DOM gives a truncated or link-less list. '
    + 'Credential-shaped values come back masked by design '
    + '— cookies, bearer and session tokens, anything under a key like auth/secret/session_id, and '
    + 'any JWT- or API-key-shaped string. The reply counts them as redacted so you can see '
    + 'something was there; calling again will not unmask them, and nothing you pass can. '
    + 'THE MASK IS KEYED ON THE NAME, SO IT OVER-CATCHES: a field called "author" matches the '
    + 'auth prefix and comes back redacted although it holds no secret. The mask is shallow — '
    + 'name the leaf you want ("...author.username") and it returns. If a plainly harmless field '
    + 'reads as redacted, that is what happened; do not report the data as unavailable. '
    + 'STRINGS ARE TRUNCATED at a few hundred characters and neither limit nor offset raises it — '
    + 'they page collections, not text. For long text read a narrower path, or read the rendered '
    + 'element with @dom / @html instead. '
    + 'WHEN THE STORE IS UNREACHABLE, THE RENDERED TREE STILL CARRIES THE RECORDS. Frameworks hang '
    + 'their own data off the DOM nodes: in React every element has __reactFiber$<key> and '
    + '__reactProps$<key>, where <key> is a per-document random suffix that changes for every tab. '
    + 'Discover it by asking for a property that does not exist — the error lists the real ones — '
    + 'then read props directly, or walk .return upward to the component that owns the whole '
    + 'collection, which is usually two or three levels up and holds every row at once. '
    + 'ROWS FROM THE PSEUDO-PATHS COME BACK IN THE REPLY ONLY. They carry no resultId, so '
    + 'results action:"get" and action:"export" cannot reach them — if the person needs a file, that is '
    + 'list_extract\'s job, not this one.',
    { tabId: N('From current_page, tab_here or tabs_list.'),
      path: S('Omit for discovery. Otherwise EITHER a store path or a PSEUDO-PATH. '
        + 'Store path: taken from a discovery sources[].path, e.g. "__INITIAL_STATE__.chats[0]" '
        + 'or "@stores.0.getState". Dots, [0] for an index, ["any key"] for a key that is not a '
        + 'plain word. '
        + 'PSEUDO-PATHS READ THE RENDERED PAGE INSTEAD OF THE STORE, and THE PARENTHESES ARE PART '
        + 'OF THE SYNTAX — bare "@dom" is not a shorter way to say it, it is an error that reads '
        + 'like the feature is missing: '
        + '"@dom(<css>)" returns the matched elements as rows of text/label/href/img, with '
        + 'hidden:N when the page holds more — the fix for a list_extract that came back short, '
        + 'and for icon rails whose only name is an aria-label. '
        + '"@html(<css> :: <depth> :: <index>)" returns the markup itself, scoped and stripped, '
        + 'with the TRUE length beside what was returned — reach for it the moment another tool '
        + 'refuses something you can plainly see. '
        + '"@map(<scope>)" expands the disclosures inside scope and splits links (href) from '
        + 'controls (button-routed), which is how a collapsed tree stops under-reporting. '
        + '"@collect(<row css> :: <hops> :: <up|down>)" harvests a recycler that never grows — it '
        + 'reads at EVERY step, dedupes by row identity, and ends with dry (really finished), '
        + 'capped (ran out of hops, THERE IS MORE) or limit (hit the row cap). Direction defaults '
        + 'to down; pass "up" for older content, because a conversation loads its history upward. '
        + 'It drives the pane with wheel and PageDown gestures, since some apps load nothing at '
        + 'all from an assignment to scrollTop. '
        + 'For a whole history do NOT scroll up from the bottom — jump to the boundary first '
        + '(the app\'s own oldest-first URL, e.g. a trailing /0, or ?page=1 / sort=oldest) and '
        + 'then @collect downward. '
        + 'These four ride this tool rather than being tools of their own, so a client holding a '
        + 'stale tool list can still reach them.'),
      reply: N('@collect only: cap how many rows come BACK, without capping how far it WALKS. '
        + 'They used to be one number, so keeping a reply small also stopped the scrolling — and a '
        + 'second call then ended `limit` with hopsRun:0, which reads exactly like the site '
        + 'refusing to load more. Set `limit` for how far to go and `reply` for how much to see; '
        + 'the reply carries collected, shown and next. Omit it and you get every row, as before.'),
            fields: A('Reduce each row of a COLLECTION to just these field paths, e.g. '
        + '["__x_id.user","__x_name"]. Cuts the cost of a row enormously — a record with 46 fields '
        + 'costs ~120 of the reply\'s budget, five fields cost a fraction — which is what makes a '
        + 'long collection readable in one call instead of thirty. Ignored on a scalar or a single '
        + 'object, where it would mean nothing.'),
      resolve: O('A KEYED JOIN, for a collection whose rows only reference their records. Give '
        + '{from, into, fields}: `from` is the field path holding the key, `into` is the path of the '
        + 'collection to look it up in, `fields` are the paths to merge in from the record found. '
        + 'Best for: a list of opaque ids — a chat app\'s group members are privacy identifiers, and '
        + 'the phone number lives in the contact collection under that same key; a storefront\'s '
        + 'listing rows against its product or stock collection. Without this, an agent makes one '
        + 'call per row and assembles the table itself. A key that matches nothing sets '
        + '@resolved:false on that row and is COUNTED in joinMisses — never dropped, so a join that '
        + 'loses rows cannot look like a shorter list.'),
      offset: N('Where to start inside a collection, for reading past the first screenful. A reply that did not reach the end carries next — pass that back as offset to continue. Default 0.'),
      limit: N('Entries returned per array or object. Default 25, max 200 — the TRUE total is '
        + 'always reported beside what was returned.'),
      depth: N('How many levels down to serialize. Default 3, max 6. Deeper is not always better: '
        + 'a store is an application\'s whole memory, and a narrower path beats a deeper read.') },
    ['tabId']),

  T('list_extract',
    'THE FAST PATH, AND THE ONE TO TRY FIRST. Reads the rows already on this page — seconds, no page '
    + 'opens, no rate-limit surface. If everything you need is on the cards, stop here: page_harvest '
    + 'costs one page load PER ROW and is minutes for the same answer.\n'
    + 'Start reading the list on a tab into a table, following its pages. Returns a runId '
    + 'IMMEDIATELY — the work continues in the background and can take minutes. Poll results action:"status". '
    + 'Never assume it finished. When the page holds more than one scrollable region — a chat '
    + 'app\'s sidebar list beside an open conversation, a filter rail beside results — the '
    + 'automatic ranking can grow and read the wrong one: pass selector with the CSS selector of '
    + 'the container the person actually means (from page_study lists[].selector) and the run '
    + 'grows and reads THAT container, never the auto-pick. If the selector matches nothing the '
    + 'call fails naming it instead of silently falling back — a silent fallback to the wrong '
    + 'pane is the bug this parameter exists to prevent. '
    + 'IT MUST FIRST AGREE THAT SOMETHING IS A LIST, and when it disagrees it does not refuse — it '
    + 'returns a little. Measured: an icon rail of 23 entries, which page_study itself counted as '
    + '23 rows, came back as ONE row; a chat log came back as sentence fragments carrying no '
    + 'author and no timestamp. Neither is a broken page. Rows that are not uniform — icons, '
    + 'message groups, date dividers — are not what this tool is for. When the count coming back '
    + 'is far below what is on screen, stop growing it and read the container with @dom(<css>) '
    + 'via page_state instead. '
    + 'Use this when the rows ARE uniform, there are many, they page, and the person wants a file '
    + 'at the end — that last part is the case nothing else covers, since the pseudo-paths return '
    + 'rows into the reply with no resultId to export.',
    { tabId: N('The tab holding the list.'),
      pages: N('How many pages to follow. 0 or omitted means keep going until the list ends.'),
      withRecords: B('Also open each row\'s own record page and fill in the extra columns. '
        + 'Slower, and much richer — this is what turns a listing into contact details.'),
      selector: S('CSS selector of the container to extract, for when the ranking might choose '
        + 'the wrong pane. Take it from page_study lists[].selector, or point at the pane itself; '
        + 'the pinned choice survives the run\'s internal re-detections. Omit to accept the '
        + 'ranked choice.') },
    ['tabId']),

  T('results',
    'Saved tables and the runs that fill them, under one action. THE RUN IS NOT THE TABLE: '
    + 'list_extract and a backgrounded page_harvest return a runId that is still working, and only '
    + 'a finished run has a resultId. So: action:"status" while it runs, action:"get" or '
    + '"export" once it is done. '
    + 'status — running, reading_records, waiting_for_user, done, failed. waiting_for_user means '
    + 'the SITE asked the person to prove they are human: relay that and wait. Do NOT retry and do '
    + 'NOT start another run, because retrying is what turns a check into a block. '
    + 'stop — end a run early; what it already read is kept. '
    + 'list — tables already extracted and saved in this browser, newest first. Check here before '
    + 'scraping something again. '
    + 'get — rows and column names. Returns data, never HTML. Large tables are truncated and the '
    + 'reply gives the true total. '
    + 'export — write the whole table to a CSV in the person\'s Downloads and return the filename. '
    + 'Use this instead of get when the table is too big to be worth reading into the conversation. '
    + 'download — save the ASSETS a deep scan found (images, video, audio) as FILES in the person\'s '
    + 'Downloads. The pictures never travel through this conversation: bytes in a reply would cost '
    + 'tens of megabytes for one page, and handing you urls to fetch yourself drops the person\'s '
    + 'cookies so anything behind a login answers with a login page. The browser downloads them '
    + 'signed in, as them. '
    + 'THIS ONE NEEDS A HUMAN. Every call raises a card in the HoloScrape side panel naming the count '
    + 'and the site, and nothing is written until a person presses Save. There is no way to '
    + 'pre-authorise it and origin consent does not cover it. Two refusals to relay rather than '
    + 'retry: the panel is not open (nobody to ask — the person opens it), and declined (do NOT ask '
    + 'again straight away; a prompt asked twice is a prompt clicked without reading). '
    + 'Assets exist in a result only if the person ran a deep scan in the panel — there is no call '
    + 'that starts one. If a result holds rows but no assets the reply says so; use export for rows. '
    + 'OR pass `urls` and skip the result entirely: any addresses you already hold can be saved the '
    + 'same way, behind the same press.',
    { action: S('Which one: "status" or "stop" (need runId), "list", "get", "export" or "download" '
      + '(need resultId).',
      { enum: ['status', 'stop', 'list', 'get', 'export', 'download'] }),
      runId: S('From list_extract or a backgrounded page_harvest. For action status and stop.'),
      resultId: S('From a finished run, or from action:"list". For action get and export.'),
      limit: N('action get only: rows to return. Default 100, max 1000.'),
      columns: { type: 'array', items: { type: 'string' },
        description: 'action get only: only these columns. Omit for all of them.' },
      types: { type: 'array', items: { type: 'string' },
        description: 'action download only: save just these kinds — "image", "video", "audio". '
          + 'Omit for everything the scan found. A kind that is not in the result is named back to '
          + 'you with what is, rather than answered with a silent zero.' },
      urls: { type: 'array', items: { type: 'string' },
        description: 'action download only: save these addresses instead of a result\'s assets — for '
          + 'urls you already hold from anywhere: a harvested column, a `@net` payload, an API '
          + 'response. http(s) only; a data: or blob: url cannot be fetched on your behalf. The same '
          + 'human gate applies, and the card names the DISTINCT HOSTS as well as the count, because '
          + 'a list you assembled can span many sites. Use this rather than fetching the urls '
          + 'yourself: the browser downloads them signed in as the person, so anything behind a '
          + 'login arrives intact instead of as a saved login page.' },
      max: N('action download only: cap how many files. Default 500, max 2000. The person sees this '
        + 'number on the card they approve.') },
    ['action']),

];

// Tool name -> the browser op behind it. One line each, because the interesting decisions all live
// in `bridge-ops.js` where the browser is.
const OPS = {
  current_page: 'current.page', tabs_list: 'tabs.list', list_extract: 'list.extract',
  page_harvest: 'page.harvest',
  page_study: 'page.study', page_state: 'page.state',
  // MERGED NAMES BRANCH HERE, not in index.mjs — one dispatch, the same rule `results` follows.
  tab_here: (a) => (a?.search ? 'search.open' : a?.newTab ? 'tab.open' : 'tab.here'),
  page_grow: (a) => ({ walk: 'page.walk', explore: 'page.explore' }[String(a?.mode || '')] || 'page.grow'),
  run_status: 'run.status', run_stop: 'run.stop', results_list: 'results.list',
  results_get: 'results.get', results_export: 'results.export',

  // ONE NAME, FIVE OPS. A value may be a function of the arguments — the only place the tool
  // surface is allowed to branch, so that consolidating names does not push a second dispatch
  // into `index.mjs`. Everything else stays a plain string.
  results: (a) => ({
    status: 'run.status', stop: 'run.stop',
    list: 'results.list', get: 'results.get', export: 'results.export',
    download: 'results.download',
  }[String(a?.action || '')] || ''),
};

// A walk can take minutes; everything else is a page load at worst.

// --- annotations ---------------------------------------------------------------------------------
// WHAT THESE BUY: a client that can see a tool only reads is free to run it without stopping to ask.
// Eleven of these eighteen never touch the page, and a person approving `page_study` for the
// fortieth time is being asked to consent to nothing. The seven that DO change something keep the
// prompt, which is the whole point — the signal is worth having only because it is not uniform.
//
// DERIVED FROM A SET RATHER THAN PASSED AT EACH CALL SITE. Eighteen extra arguments is eighteen
// places to get it wrong, and the classification is the kind of fact that should be readable in one
// screen next to itself. Same shape as SLOW below it.
//
// THEY ARE HINTS AND NOT ENFORCEMENT. The spec is explicit that a client may ignore them, so
// nothing here is load-bearing for safety — the per-origin consent in the extension is. These
// change how often a person is interrupted, not what can happen to them.
const READ_ONLY = new Set([
  // Read the browser or a saved table. None of them navigate, press, scroll or open anything.
  'current_page', 'tabs_list', 'page_study', 'page_state',
  'run_status', 'results_list', 'results_get', 'results_export',
]);

// Repeating the call adds nothing. Only meaningful on the tools that DO change something: stopping
// an already-stopped run is a no-op, while every tab_open makes another tab and every page_grow
// moves the page again.
const IDEMPOTENT = new Set(['run_stop']);

// Reads our own stored results or run bookkeeping rather than the live web. Everything else can
// see whatever the internet decided to serve this second.
const CLOSED_WORLD = new Set(['run_status', 'results_list', 'results_get', 'results_export']);

// --- what a call costs -----------------------------------------------------------------------
// THE SERVER ALREADY KNOWS THIS AND USED TO KEEP IT TO ITSELF. `SLOW` below sets a 60s timeout
// instead of 30s for the calls that can take a while — a fact the model deciding whether to call
// them never saw. An agent that does not know `page_walk` runs for minutes will call it to answer
// a question it could have answered with one `page_read`, and an agent that does not know
// `page_study` is instant will avoid it and guess instead. Both are avoidable.
//
// Appended rather than written into each description, so the tier cannot drift from SLOW and reads
// in one screen. Three tiers, because a fourth would be a number nobody can act on differently.
const COST = {
  minutes: ['list_extract', 'page_walk', 'page_explore', 'page_harvest'],
  seconds: ['site_probe', 'page_grow', 'tab_open', 'search_open', 'results_export', 'tab_here'],
};
const COST_TEXT = {
  minutes: ' COST: minutes. It presses, scrolls or walks pages one after another, so budget for it '
    + 'and prefer a cheaper tool when one will answer.',
  seconds: ' COST: seconds — it loads or moves a page.',
  instant: ' COST: instant. Reads what is already there; cheap enough to call before guessing.',
};
const tierOf = (name) => (COST.minutes.includes(name) ? 'minutes'
  : COST.seconds.includes(name) ? 'seconds' : 'instant');

// HOW LONG TO WAIT IS NOT THE SAME QUESTION AS WHAT IT COSTS, and conflating them is a live bug:
// page_walk is advertised as taking minutes and was given the 30s default, so the first real walk
// — 23 presses at 2.2s apiece — was killed by its own client a minute in. A cost is what to tell
// the model; a timeout is a ceiling on the worst case.
//
// The two differ most where a tool is USUALLY instant and OCCASIONALLY long. page_state answers a
// property read in milliseconds, but the same tool runs a gesture-paced @collect harvest that
// pages a chat backlog; page_grow takes hops up to 50. Their descriptions should keep saying
// "instant"/"seconds", because that is what a caller will normally see — and their ceiling has to
// cover the other case or the tool cannot do the thing it exists for.
const LONG = new Set([
  'page_walk', 'page_explore',        // press or scroll many things, one after another
  'page_state', 'page_grow',          // @collect harvests and hops:50 both run for minutes
  'list_extract', 'results_export',   // a walk with records, and a large table written out
  'page_harvest',                     // N pages across a few lanes — the whole point is that it is long
]);
const MEDIUM = new Set(['tab_open', 'search_open', 'site_probe', 'tab_here']);

// 30s was never enough for a walk; 10 minutes covers page_walk at its documented maximum
// (100 presses x 8s) with room for the reads between them.
const timeoutFor = (name) => (LONG.has(name) ? 600000 : MEDIUM.has(name) ? 60000 : 30000);

// Superseded by timeoutFor() above, which gives three tiers instead of two — kept because it is
// what an older index.mjs reads, and a server that reloads this file while running is holding one.
// Derived from the same sets so the two can never disagree about which calls are long.
const SLOW = new Set([...LONG, ...MEDIUM]);

for (const t of TOOLS) {
  t.description += COST_TEXT[tierOf(t.name)];
  const readOnly = READ_ONLY.has(t.name);
  t.annotations = {
    readOnlyHint: readOnly,
    // NOTHING HERE DELETES ANYTHING. No tool removes a file, a row, a tab or a record — the worst
    // a mutating one does is scroll, press, or open a tab. Stated rather than omitted, because an
    // absent hint defaults to "assume destructive" and would earn a prompt none of these deserve.
    destructiveHint: false,
    idempotentHint: readOnly || IDEMPOTENT.has(t.name),
    openWorldHint: !CLOSED_WORLD.has(t.name),
  };
}

// --- the tool graph -----------------------------------------------------------------------------
// WHAT TO CALL NEXT, WRITTEN ONTO THE REPLY THAT PROVES IT.
//
// MCP has no way to link one tool to another: a tool is a name, a description and a schema, and
// nothing in the protocol says "after this, that". So eighteen tools arrive as eighteen unrelated
// options, described once at session start and chosen from long afterwards. Every failure worth
// naming this session was a COMPOSITION failure rather than a tool failure — page_study found a
// list that was not uniform and nobody moved to @dom; page_read returned hrefs and they were walked
// one at a time anyway; a collection was read without a projection four times running. Each
// individual fact was documented. The arrow between them was not, anywhere.
//
// A DESCRIPTION IS READ ONCE, BEFORE ANYTHING IS KNOWN. A reply arrives at the moment the next
// choice is being made, and — unlike a description — it can see what was actually found. That is
// the whole reason the edges live here.
//
// CONDITIONAL, NEVER UNCONDITIONAL. Each edge returns null when there is nothing worth saying, so
// page_grow is silent unless a harvest came back capped and list_extract is silent unless the row
// count collapsed. A hint on every reply is noise, and noise in every reply is how a useful field
// stops being read; a hint only where a decision is about to go wrong is the opposite.
//
// IT SUGGESTS AND NEVER DECIDES. The caller has context this does not, so every line says what the
// numbers imply and leaves the numbers beside it.
//
// THE EXTENSION OUTRANKS THIS TABLE. It measured the page — it knows the rail held 23 entries when
// the extractor returned 1, that a container was collapsed rather than virtualized, that scrollTop
// never moved. Those hints cannot be reconstructed from the reply alone, so when a reply already
// carries `next`, index.mjs keeps it and never overwrites it with anything derived here.
function nextForCurrentPage(page) {
  if (!page || typeof page !== 'object') return null;
  if (page.challenge) {
    return `the site is showing a check (${page.challenge}) — relay that to the person and let `
      + 'them clear it. Do NOT retry; retrying is what turns a check into a block.';
  }
  if (page.allowed === false) {
    // AN EMPTY TAB AND A REFUSED SITE ARE DIFFERENT PROBLEMS WITH DIFFERENT ANSWERS. Telling
    // someone to go and click approve for a new-tab page sends them to a panel with nothing on it,
    // and the honest reading of that is "the browser is not usable" — which is what happened.
    if (!page.url) {
      return 'that tab is empty — it is not on a page yet, so there is nothing to consent to. '
        + 'tab_here to point it at a URL, or tab_open to open one. Neither needs the panel.';
    }
    return 'this origin has not been consented to yet — the person approves it in the HoloScrape '
      + 'panel before anything can read it.';
  }
  const rows = Number(page.rowsOnPage) || 0;
  if (page.hasList && rows > 3) {
    return `page_study to see the ranked candidates and check looksLikeFurniture, then `
      + `list_extract for an exportable table — or page_state path:"@dom(<css>)" if you only need `
      + `to read the ${rows} rows once. If a run comes back with far fewer than ${rows}, the rows `
      + 'are not uniform and @dom is the answer, not a bigger pages number.';
  }
  if (page.hasList) {
    return `only ${rows} row${rows === 1 ? '' : 's'} detected, which usually means the rows are `
      + 'not uniform rather than that the page is empty. page_state path:"@html(<css> :: 2)" to '
      + 'look at the real markup, then page_state path:"@dom(<css>)" to read it.';
  }
  return 'no repeating list was detected. page_state path:"@html(body :: 2)" to read the shape of '
    + 'the page, then @dom(<css>) for the part you want. page_study only ranks lists, so it will '
    + 'have little to say here.';
}


// The edges. Keyed by tool name; each gets that tool's own reply and returns a line or null.
const NEXT = {
  current_page: nextForCurrentPage,

  // A ranked list is only worth extracting if the ranking can be trusted, and the two fields that
  // say whether it can are the two that get skipped. Furniture and repetition are the measured
  // ways this goes wrong: a footer site-directory and a filter sidebar have both outscored the
  // actual results.
  page_study: (o) => {
    const best = (o?.lists || [])[0];
    if (!best) {
      return 'no repeating structure was found, so list_extract has nothing to walk. '
        + 'page_html selector:"body" depth:2 to read the page\'s shape, then page_read the part '
        + 'you want.';
    }
    if (best.looksLikeFurniture) {
      return `the top candidate sits inside a ${(best.landmarks || []).join('/') || 'nav/footer'} `
        + 'landmark, which is what furniture looks like — check the lower-ranked candidates before '
        + 'trusting it.';
    }
    // WHAT distinctness:1 ACTUALLY MEANS, learned the expensive way — twice.
    //
    // First I wrote this edge to say "every row points at the same place", which is FALSE: IMDb's
    // 250 films, HN's 30 stories and Stack Overflow's 15 questions each resolve somewhere
    // different, and all three reported distinctness 1. So I tightened the condition to require
    // identical sample rows — and that would have silenced the hint on all three, removing a signal
    // that three independent agents followed and were right to follow.
    //
    // The field does not mean "duplicate rows". It means THE ENGINE CANNOT TELL THE ROWS APART,
    // which is the precise reason list_extract collapses fields on a layout like HN's paired
    // .athing/.subtext rows. The signal was always real; only my description of it was wrong.
    // Fixing the words, not the condition — a true statement about the measurement, and no claim
    // about the page that the measurement does not support.
    if (Number(best.distinctness) <= 1 && Number(best.rows) > 1) {
      return `distinctness is ${best.distinctness} across ${best.rows} rows: the engine cannot tell `
        + 'these rows apart, which is what makes list_extract collapse fields on layouts like this '
        + '(paired rows, rows whose links all look alike). It does NOT mean the rows are duplicates. '
        + 'page_read with a precise selector returns what is really there; reach for list_extract '
        + 'only if you have checked the rows are uniform.';
    }
    return `list_extract selector:"${best.selector}" for a table you can export, or page_read for `
      + `a single read of the ${best.rows} rows. If a run returns far fewer than ${best.rows}, the `
      + 'rows are not uniform — page_read or @dom, not a bigger pages number.';
  },

  // The single most expensive wrong turn available: pressing through a list whose rows already
  // carry the URL. Measured at 23 servers of somebody else's browser time.
  page_read: (o) => {
    const rows = o?.rows || [];
    if (!rows.length) return null;
    const linked = rows.filter((r) => r && r.href).length;
    if (linked >= Math.max(2, rows.length * 0.5)) {
      return `${linked} of ${rows.length} rows carry an href — this is a WORK LIST, not something `
        + 'to walk. Take the URLs and handle them directly; page_walk is for rows that can only be '
        + 'pressed.';
    }
    if (!linked) {
      return 'no row carries an href, so pressing is the only way in — page_walk with back:true, '
        + 'which returns the person\'s tab to where they left it.';
    }
    return null;
  },

  // grew:false is honest and useless on its own; what to do about it depends on WHY.
  page_grow: (o) => {
    if (o?.grew) return null;
    const moved = o?.scrolled && o.scrolled.from === o.scrolled.to && o.scrolled.max > 0;
    if (moved) {
      return 'the pane did not move at all (from === to) even though it can scroll. Some apps load '
        + 'nothing from an assignment to scrollTop — use page_state path:"@collect(<row css> :: '
        + '<hops>)", which drives the pane with real wheel and PageDown gestures.';
    }
    return 'nothing grew. If this is a conversation or a feed, history loads UPWARD — pass '
      + 'direction:"up", or jump to the boundary (a trailing /0, ?page=1, sort=oldest) and collect '
      + 'downward from there.';
  },

  // The failure that does not look like one: a run that "succeeded" with a fraction of the rows.
  list_extract: (o) => {
    if (o?.runId) return null;              // still starting; nothing measured yet
    const got = Number(o?.rows) || 0;
    const seen = Number(o?.rowsOnPage) || 0;
    if (seen > 3 && got > 0 && got < seen / 2) {
      return `${got} rows came back from a page showing about ${seen} — that gap means the rows are `
        + 'not uniform, not that the list is short. page_read on the container returns what is '
        + 'actually there; more pages will not help.';
    }
    return null;
  },

  // A walk that pressed the wrong thing reports it plainly, and the fix is always the selector.
  page_walk: (o) => {
    const rows = o?.rows || [];
    if (rows.length && Number(o?.moved) === 0) {
      return 'moved:false on every row — the selector matched a wrapper, not the control. '
        + 'page_html on one of them to find what actually carries the click (often a child with '
        + 'data-list-item-id, a role, or an href).';
    }
    // `next` here is page_walk's own PAGINATION CURSOR, not a hint — the two are deliberately
    // different fields now. See the attach site in index.mjs.
    if (o?.next != null && rows.length) {
      return `stopped at ${o.next} of ${o.total}; pass offset:${o.next} to continue.`;
    }
    return null;
  },

  // A harvest that ran out of budget looks exactly like one that finished.
  page_state: (o) => {
    if (o?.ended === 'capped') {
      return 'ended:capped means the hops ran out and THERE IS MORE — raise hops, or continue from '
        + 'where it stopped. Do not report this as the end of the list.';
    }
    if (o?.ended === 'limit') return 'ended:limit — the row cap was hit, not the end of the list.';
    if (typeof o?.hidden === 'number' && o.hidden > 0) {
      return `hidden:${o.hidden} — the page is holding more than the selector matched. A collapsed `
        + 'section renders no children at all, and scrolling cannot reveal what is not there: '
        + '@map(<scope>) expands disclosures first.';
    }
    return null;
  },
};

export { TOOLS, OPS, SLOW, READ_ONLY, NEXT, timeoutFor };
