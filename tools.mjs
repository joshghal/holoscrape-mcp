// The tool surface: the schema helpers, every tool description, the name -> browser-op map, the
// conditional reply hints, and the three things the server answers without asking the browser.
//
// SPLIT OUT OF index.mjs BECAUSE THIS IS THE PART THAT GROWS. The plumbing beside it — pairing,
// RFC 6455 framing, the JSON-RPC loop — is finished and rarely touched; this file is edited every
// time a capability lands.
//
// THE DESCRIPTIONS ARE SHORT ON PURPOSE, AND THEY USED TO BE LONG ON PURPOSE. The argument for long
// was sound as far as it went: a stranger running `npx` gets these strings and nothing else, so the
// strings were the whole manual. What it cost, measured over a real tools/list on 2026-09-22: 59,659
// schema chars plus 27,561 of `instructions`, about 21,800 tokens, paid by every session before its
// first call and whether or not a tool was ever used — against about 5,000 for Playwright MCP's 25
// tools. Median description 2,954 chars against 42. And a warning in a description is read ONCE, at
// session start, long before the moment it is true.
//
// So every lesson kept its words and changed its address. Three homes, the same three both reference
// servers use (research/PLAYWRIGHT-DEVTOOLS-MCP-STUDY.md, section A):
//   - HERE: what is needed to CHOOSE a tool. <= 400 chars a tool, <= 160 a parameter.
//   - THE REPLY: anything conditional — `NEXT` below writes a `hint` only when the reply itself
//     shows the condition holds (a hidden tab, a rising count, a column with five distinct values).
//     Paid only when true, read at the moment it matters.
//   - THE GUIDE: procedure and history. `INSTRUCTIONS` in guidance.mjs, served a section at a time
//     by results action:"guide", whole as the MCP resource holoscrape://guide, and shipped as
//     skill/SKILL.md. It travels in the same tarball, which is what answers the stranger-with-npx
//     argument above.
// research/GUIDANCE-RELOCATION.md is the ledger: every passage that left this file, and where it went.
// test/mcp-surface-budget.mjs holds the budgets so the text cannot creep back.
//
// Keep both copies of this tree byte-identical (see the note at the top of index.mjs), and keep
// `files` in package.json listing every module — a missing entry ships a package that throws on
// import, and the first person to find out is a stranger running `npx`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guide } from './guidance.mjs';

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
const M = (description) => ({ type: 'object', additionalProperties: { type: 'string' }, description });
// ONE `where` FOR THE SIX TOOLS A SWITCH MAY MOVE (research/COMPANION-DESIGN.md). Defined once so
// the six copies cannot drift, and kept under the 160-char parameter budget. `results` and the
// status calls take no `where` on purpose: a runId or resultId already says which browser holds it.
const WHERE = () => S('"person" (default) or "companion": a private headless Chromium, no login. Pick it when their '
  + 'tabs must stay untouched or no tab is open; public pages only.', { enum: ['person', 'companion'] });
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
    'The page the person is looking at now, and what can be extracted from it. Takes no arguments; '
    + 'returns a tabId for the other tools. Honours a page pinned in the HoloScrape panel; otherwise '
    + 'it follows the active tab and MOVES when they browse, so capture the tabId once and pass it '
    + 'explicitly for the rest of the run.'),

  T('tabs_list',
    'Every http(s) tab open in the person\'s browser. Use only when current_page is not the page '
    + 'they meant and you need to ask which.'),

  T('page_harvest',
    'Open every record linked from a list and extract fields from each, in parallel lanes inside the '
    + 'browser. Returns counts and a resultId, never rows; read them with results get or export. Give '
    + '`record` for one-per-page fields, `rows` for many-per-page, neither to read schema.org. Slow: '
    + 'one page load per record. If the list cards already show the fields, use list_extract instead.',
    { tabId: N('The list page, when using `links` or letting the engine pick. Not needed with `urls`.'),
      urls: A('The pages to open. Either this or `links`. One url with `rows` re-reads that page\'s own rows.'),
      links: S('CSS for the links to follow on the list page. Omit and the engine follows the ranked '
        + 'list itself, reporting the selector it used as linksVia.'),
      record: M('One-per-page fields as {name: "css"}; "css@attr" reads an attribute, "$.path" reads '
        + 'captured JSON (needs `network`). Copied onto every row from that page.'),
      rows: { type: 'object',
        description: 'The repeating block on each page: {at, fields, limit} or {from}. Each row also '
          + 'gets `billing`, its 1-based position.',
        properties: {
          at: S('CSS for one repeating row on the record page, or a $. path to a JSON array (needs `network`).'),
          fields: M('Field name -> CSS relative to the row. "css@attr" reads an attribute; ":self" '
            + 'takes the row\'s own text whole, for when inner hooks come back empty.'),
          limit: N('Rows per page, default 500. Over it, capped is set.'),
          from: S('Instead of `at`: the schema.org array to use as rows, by name ("review", "offers", '
            + '"recipeIngredient"). Others found are listed in alsoRows.'),
        },
        required: [] },
      retryOf: S('A finished runId: re-run only its FAILED pages. A thin page is usually transient. '
        + 'Combine the passes with results action:"merge".'),
      awaitFor: S('Wait for this on every page before reading: "<css> :: <mode> :: <ms>", mode exists '
        + '| gone | still | a number. "<spinner css> :: gone" is the surest.'),
      lanes: N('Pages open at once. Default 5; more is slower and loses rows. Use 2-3 on a site that '
        + 'has shown a captcha.'),
      limit: N('Pages per run, for a pilot. It DROPS pages rather than trimming a reply; the reply '
        + 'then carries matched, skipped and nextFrom.'),
      from: N('Skip this many matched links first. Pass the previous reply\'s nextFrom to take the next fold.'),
      network: S('Substring of the request URL whose JSON to capture on every page, e.g. '
        + '"/api/products". Fields may then be $. paths. Attaches a debugger per lane.'),
      background: B('Return a runId at once instead of blocking; poll results action:"status". Set it '
        + 'for anything over about 20 pages.'),
      where: WHERE() },
    []),

  T('tab_here',
    'Point a tab you already hold at a URL and wait until the page has actually loaded: one tab, many '
    + 'destinations, nothing left behind. Reports arrived, hasList, rowsOnPage and rising (the count '
    + 'was still climbing, so it is a floor). `network` also captures what the page fetched. For the '
    + 'same fields off many pages use page_harvest, not this in a loop; it refuses after a few cycles.',
    { tabId: N('The tab to move. It keeps its id: the same tab, somewhere else.'),
      url: S('http or https.'),
      close: B('Close this tab instead of navigating it; do it when a pass ends. Refused for the '
        + 'connection window and for a tab the person pinned.'),
      newTab: B('Open a NEW tab instead of moving this one. Nothing closes it, so use it only when '
        + 'they asked for a new tab or there is no tab to move.'),
      search: S('Words to search for. With this, `url` names the SITE and the search runs in the '
        + 'site\'s own box; reports what the site returned.'),
      oneByOne: B('Stand the sweep refusal aside: set it only when the pages differ from one another '
        + 'and must be visited in turn (a login, a form, one-off lookups).'),
      network: S('Substring of request URLs to capture during the load. "*" maps every response '
        + '(url, mime, size, JSON paths) with no bodies: start there on an unknown site.'),
      where: WHERE() },
    ['url']),

  T('page_study',
    'Every repeating structure on a tab, ranked, with the evidence behind the ranking, plus how the '
    + 'page continues (next link, numbered pager) and what might load more. Returns several '
    + 'candidates so you choose: check looksLikeFurniture and distinctness before trusting the one '
    + 'marked chosen. It sees only repeating structure: read a single element with page_state '
    + '"@dom(<css>)". Read-only.',
    { tabId: N('From current_page, tab_here or tabs_list.'),
      where: WHERE() },
    ['tabId']),

  T('page_grow',
    'Make a list load more and report what changed: presses a load-more control, or scrolls the '
    + 'window or one container (`selector` + scroll:true). Returns rows before and after, unique '
    + 'rows gained, and whether the list repeats itself. With `network` and `rows.at` it reads the '
    + 'JSON each scroll fetched (infinite or virtual lists). mode walk or explore presses '
    + 'instead. Changes the page.',
    { tabId: N('The tab.'),
      mode: S('"grow" (default) lengthens a list. "walk" presses, fills or chooses; it cannot follow '
        + 'a real link (use tab_here). "explore" opens what is collapsed.',
        { enum: ['grow', 'walk', 'explore'] }),
      text: S('walk: what the person would CLICK, in their words. Prefer it to a selector; it '
        + 'survives a redesign that renames every class.'),
      fill: S('walk: type this into the field named by `selector`. Never submits; the value is read '
        + 'back. Refused for password, hidden and payment fields.'),
      choose: S('walk: pick a <select> option by its visible words ("Most recent"). Finds the select '
        + 'by the option. changed:false means the page looked identical afterwards.'),
      read: S('walk: CSS of the rows to read back after the press or choice, so the reply carries '
        + 'them and you can verify the order really changed.'),
      limit: N('walk: how many matched controls to press in this call.'),
      offset: N('walk: start from this matched control. A walk that stopped early says where; pass '
        + 'that back to continue rather than start over.'),
      back: B('walk: return to the page this walk started from when it is done.'),
      oneByOne: B('walk: stand the sweep refusal aside, for pages that genuinely must be pressed '
        + 'through one at a time.'),
      selector: S('A control from page_study growth.candidates to press, OR the CSS of a scrollable '
        + 'container to scroll (with scroll:true). Omit to scroll the window.'),
      scroll: B('Scroll instead of pressing. Alone: the window. With `selector`: THAT container, to '
        + 'its own bottom, which is right for a pane beside other panes.'),
      waitMs: N('How long to wait for new rows. Default 2500, max 8000.'),
      direction: S('"down" (default) for more of a list, "up" for OLDER content: a conversation loads '
        + 'its history upward.'),
      hops: N('How many times to scroll and wait. Default 1, max 50. Stops early after two empty '
        + 'hops; perHop shows what each one added.'),
      rounds: N('explore: scroll rounds per region, default 8, max 40.'),
      network: S('Feed mode: substring of the request URL each scroll triggers, e.g. "/api/search". '
        + 'Needs rows.at. Find it with tab_here network:"*".'),
      rows: { type: 'object',
        description: 'Feed mode only: {at: "$..items", fields: {name: "$.title"}}.',
        properties: { at: S('$. path to the array of items in the captured response.'),
          fields: M('Field name -> $. path, relative to one item.') } },
      where: WHERE() },
    ['tabId']),

  T('page_state',
    'Read the app\'s own in-memory state (the store the page renders from), or a DOM, markup or '
    + 'network slice, by data path; it never takes code. tabId alone maps what state exists and the '
    + 'path to each; `path` reads one slice. Best for: virtualized lists and fields the DOM omits. '
    + 'Not recommended for: what the page already shows (list_extract is cheaper). Credentials come '
    + 'back masked.',
    { tabId: N('From current_page, tab_here or tabs_list.'),
      path: S('Omit to discover. A store path ("__NEXT_DATA__.props", [0], ["k"]) or a '
        + 'pseudo-path, parens required: @dom() @html() @map() @collect() @await() @fetch() @net()'),
      reply: N('@collect only: cap how many rows come BACK without capping how far it walks (`limit` '
        + 'does that). The reply carries collected, shown and next.'),
      fields: A('Keep only these field paths on each row of a collection, e.g. ["id","name"]. The '
        + 'biggest saving on a long collection.'),
      resolve: O('A keyed join {from, into, fields}, for rows that only reference their records by '
        + 'id. Misses set @resolved:false and count in joinMisses; none is dropped.'),
      offset: N('Where to start inside a collection. A reply that did not reach the end carries '
        + 'next; pass it back here. Default 0.'),
      limit: N('Entries returned per array or object. Default 25, max 200; the true total is always '
        + 'reported.'),
      depth: N('Levels to serialize. Default 3, max 6. A narrower path beats a deeper read.'),
      where: WHERE() },
    ['tabId']),

  T('list_extract',
    'Read the repeating rows on a tab into a saved table, following its pagination. Starts a '
    + 'background run and returns a runId at once; poll results action:"status", then get or export. '
    + 'Pass `selector` (from page_study lists[].selector) when the page holds more than one list. '
    + 'Reads list pages only and never opens records, so it is the fast path when the cards already '
    + 'show the fields.',
    { tabId: N('The tab holding the list.'),
      pages: N('How many pages to follow. 0 or omitted means keep going until the list ends.'),
      withRecords: B('Also open each row\'s own record page and fill in the extra columns. Slower, '
        + 'and much richer.'),
      selector: S('CSS of the container to extract, from page_study lists[].selector. Matches '
        + 'nothing: the call fails naming it. Omit to accept the ranked choice.'),
      // THE ENGINE COULD ALWAYS BE POINTED AT A PAGER AND NO AGENT COULD DO THE POINTING.
      // `findNextPage(sel)` lets a named control outrank every guess, and the panel reaches it; this
      // schema exposed only tabId, pages, withRecords and selector, so a walk that ended "no further
      // pages" with a link called "next" in plain view had no override to reach for. The argument
      // rides straight through OPS to `list.extract` — nothing here interprets it.
      next: S('The next-page control, as a CSS selector or an href. Outranks every guess; use it when '
        + 'a walk stopped early and the reply lists nearMisses.'),
      where: WHERE() },
    ['tabId']),

  T('results',
    'Runs and saved tables. status and stop take a runId. list shows saved tables. get returns rows, '
    + 'paged by limit, offset and columns; with `saveTo` the server writes the whole table to a file '
    + 'instead. export writes a CSV to Downloads. merge combines passes. download saves assets or '
    + '`urls`. guide is the manual. No resultId until a '
    + 'run is done.',
    { action: S('status | stop (runId); list; get | export | download (resultId); merge (resultIds); '
      + 'guide (optional topic).',
      { enum: ['status', 'stop', 'list', 'get', 'export', 'download', 'merge', 'guide'] }),
      runId: S('From list_extract or a backgrounded page_harvest. For status and stop.'),
      resultId: S('From a finished run, or from action:"list". For get, export and download.'),
      resultIds: A('merge: two or more resultIds. Two passes over one list are one answer; the merge '
        + 'runs in the browser.'),
      key: S('merge: the column that identifies a row across passes, usually the source url. The '
        + 'longer value wins per field; rows without it count as unkeyed.'),
      into: S('merge: save as a NEW result under this name and return its resultId. Use it for '
        + 'anything you will export.'),
      limit: N('get: rows in this reply. Default 100, max 1000. Ignored with saveTo.'),
      offset: N('get: where to start. The reply carries nextOffset and more while rows remain; '
        + 'repeat until truncated is false.'),
      columns: A('get: only these columns. Omit for all of them.'),
      saveTo: S('get or export: ABSOLUTE path ending .csv or .json, under home or tmp. The server '
        + 'writes every row there and replies {path, rows, bytes}. Never overwrites.'),
      topic: S('guide: a word from a section title. Omit for the list of sections.'),
      types: A('download: only these kinds: "image", "video", "audio". Omit for everything the scan found.'),
      urls: A('download: save these http(s) addresses instead of a result\'s assets. Same human '
        + 'approval; the browser fetches them signed in as the person.'),
      max: N('download: cap on files. Default 500, max 2000. The person sees this number on the card.') },
    ['action']),

  // X (TWITTER)-SPECIFIC, AND SAYS SO IN ITS OWN NAME — this is not the hostname-branching bug a
  // generic tool would have. `page_harvest` or `results` secretly special-casing x.com would be
  // exactly that bug: a caller reading their description would have no way to know a single site
  // gets different treatment underneath. This tool IS the special case, out in the open, the same
  // as `provider-x.js` is an openly X-specific data file beside the generic engine that reads it.
  //
  // WHY THIS EXISTS AT ALL: X's own captured video urls are frequently not a working file two
  // different ways — `amplify_video/...` is session-bound (answers 0 bytes to a fetch made outside
  // the person's own signed-in browser), and X's CMAF/DASH delivery hands out small timed fragments,
  // so a captured asset can be a `.m4s` segment that plays a second and stops rather than the whole
  // clip. `results action:"download"` already resolves this automatically when a scan learned the
  // post's id — this tool is for the OTHER cases: you have a post url or id from somewhere that was
  // never scanned (a search result, a harvested column, a link someone pasted) and want the real
  // mp4 url directly, or you want to hand it to something other than the browser's own downloader.
  T('resolve_x_video',
    'Turn an X (Twitter) post into a plain, fetchable mp4 url through X\'s public syndication '
    + 'API. Runs on this machine: no tab, no pairing, no consent. Give `url` or `statusId`; returns '
    + '{url, statusId}, or {url:null, why} when there is no video: an answer, not a retry. '
    + 'The url needs no cookies, so fetch it yourself. With an X tab open, page_state reads these '
    + 'urls from its store.',
    { url: S('An x.com or twitter.com post url. Either this or statusId.'),
      statusId: S('The bare numeric tweet/post id. Either this or url.'),
      videoId: S('Only for a post carrying more than one video: the id in a captured url\'s '
        + 'amplify_video/<id>/ segment. Omitted, the highest bitrate wins.') },
    []),

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
  //
  // `merge` WAS IN THE SCHEMA'S ENUM, IMPLEMENTED IN THE EXTENSION, AND MISSING HERE — so the
  // advertised call answered "results needs a valid action — got \"merge\"" and the 625-product
  // two-pass recovery its description promised could not be run by an agent at all. Found by the
  // check in test/mcp-surface-budget.mjs that every enum value resolves to something.
  // `guide` has no browser op on purpose: see LOCAL_ACTIONS.
  results: (a) => ({
    status: 'run.status', stop: 'run.stop',
    list: 'results.list', get: 'results.get', export: 'results.export',
    download: 'results.download', merge: 'results.merge',
  }[String(a?.action || '')] || ''),
};

// Actions answered by this process without asking the browser anything — see `PRE` at the bottom.
const LOCAL_ACTIONS = ['guide'];

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
// nothing here is load-bearing for safety — pairing and the restricted-host list in the extension are. These
// change how often a person is interrupted, not what can happen to them.
const READ_ONLY = new Set([
  // Read the browser or a saved table. None of them navigate, press, scroll or open anything.
  'current_page', 'tabs_list', 'page_study', 'page_state',
  'run_status', 'results_list', 'results_get', 'results_export',
  // Reads a public third-party API. Does not touch the browser at all.
  'resolve_x_video',
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
// THE TIER STAYS ON THE DESCRIPTION, THE SENTENCE EXPLAINING IT MOVED. Three words a tool is what
// fits inside a 400-char budget; "it presses, scrolls or walks pages one after another, so budget
// for it and prefer a cheaper tool when one will answer" is in the guide under choosing a route.
const COST_TEXT = {
  minutes: ' Cost: minutes.',
  seconds: ' Cost: seconds.',
  instant: ' Cost: instant.',
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

// THE THREE CEILINGS. 30 s was never enough for a walk; 10 minutes covers page_walk at its
// documented maximum (100 presses x 8 s) with room for the reads between them; a minute covers a
// document load on the person's own connection, which a marketplace on a slow link really does
// take. The default is what an ordinary read is given.
const TIMEOUT_LONG_MS = 600000;
const TIMEOUT_MEDIUM_MS = 60000;
const TIMEOUT_DEFAULT_MS = 30000;
const timeoutFor = (name) => (LONG.has(name) ? TIMEOUT_LONG_MS : MEDIUM.has(name) ? TIMEOUT_MEDIUM_MS : TIMEOUT_DEFAULT_MS);

// --- the thresholds the reply hints turn on ------------------------------------------------------
// Each `NEXT` hint below fires only when the reply itself shows a condition holds; these are the
// lines it draws. None changes what the browser did — only whether a sentence is added.
//
// A blocking harvest past this many pages should have been `background:true`, so it could be
// polled, reported on and stopped. Same number the page_harvest description quotes ("over about
// 20 pages").
const BLOCKING_PAGES_MAX = 20;
// A column is COARSE — a category, a currency, or a seller's rating copied onto every listing —
// when it is filled on at least this many rows and holds at most this share of distinct values.
// The measured case: `rating` filled 66 of 70 and documented as each item's rating; it was the
// SELLER's, provable from a row reading "4 out of 5 stars" over three five-star reviews.
const COARSE_MIN_FILLED = 20;
const COARSE_DISTINCT_SHARE = 0.2;
// A feed is LOOPING when at least this percentage of the rows a grow returned were rows it had
// already given. Measured: one marketplace re-serves the same ~284 products until the DOM holds 2,000.
const LOOPING_PCT_MIN = 50;
// A pseudo-path read that returned at least this many rows is a table someone may want as a file,
// and pseudo-path rows carry no resultId — so the hint names list_extract as the route.
const PSEUDO_ROWS_FILE_HINT = 25;
// `results get`: when more rows than this remain past the page returned, paging them through the
// conversation is the expensive route and saveTo is offered. One SAVE_PAGE's worth.
const MORE_ROWS_SAVE_HINT = 1000;
// How long a `results.get` page is given when writing a file — a thousand rows serialised out of
// the extension's storage, per page, on a table that may be tens of thousands.
const SAVE_ASK_MS = 120000;

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
// nothing in the protocol says "after this, that". So ten tools arrive as ten unrelated options,
// described once at session start and chosen from long afterwards. Every failure worth naming was a
// COMPOSITION failure rather than a tool failure — page_study found a list that was not uniform and
// nobody moved to @dom; a read returned hrefs and they were walked one at a time anyway; a
// collection was read without a projection four times running. Each individual fact was
// documented. The arrow between them was not, anywhere.
//
// A DESCRIPTION IS READ ONCE, BEFORE ANYTHING IS KNOWN. A reply arrives at the moment the next
// choice is being made, and — unlike a description — it can see what was actually found. That is
// the whole reason the edges live here, and since 2026-09-22 it is also where the WARNINGS live:
// "a background tab loads nothing" cost 300 chars in every session's page_grow description and was
// read an hour before it mattered; as a line that fires when `page.hidden` is true it costs nothing
// until the moment it is the explanation.
//
// CONDITIONAL, NEVER UNCONDITIONAL. Each edge returns null when there is nothing worth saying. A
// hint on every reply is noise, and noise in every reply is how a useful field stops being read; a
// hint only where a decision is about to go wrong is the opposite. The rule for adding one: it must
// test a field of THIS reply (or an argument of this call), and a healthy reply must stay silent —
// test/mcp-next-hints.mjs feeds each edge a clean reply for exactly that reason.
//
// IT SUGGESTS AND NEVER DECIDES. The caller has context this does not, so every line says what the
// numbers imply and leaves the numbers beside it.
//
// THE EXTENSION OUTRANKS THIS TABLE. It measured the page — it knows the rail held 23 entries when
// the extractor returned 1, that a container was collapsed rather than virtualized, that scrollTop
// never moved. Those hints cannot be reconstructed from the reply alone, so when a reply already
// carries `hint`, index.mjs keeps it and never overwrites it with anything derived here.
//
// SOME EDGES ARE KEYED ON FIELDS THAT OTHER WORK PRODUCES (research/CONTRACT-2026-09-22.md): the
// `page` header {hidden, frames, settled, settleMs, why}, a pager's `nearMisses`, a finished walk's
// `growable`. They are read defensively and are silent until those fields arrive.

// --- the environment, said on every tool that read a page ------------------------------------------
// The costliest bug class here is a read that SUCCEEDS on a page that was not ready. It is only
// catchable where the read happens, which is why the engine reports the state and this turns it
// into a sentence. Measured on a hidden tab: scrollTop moved 572 -> 3136 across twelve hops with
// fresh:0 every time, and the same page loaded fine when the tab was focused; the same selector
// returned 60 populated rows in the active tab and 60 empty ones in a background tab.
function pageLines(o) {
  const pg = o?.page;
  if (!pg || typeof pg !== 'object') return [];
  const lines = [];
  if (pg.hidden === true || pg.frames === false) {
    lines.push(`page.${pg.frames === false ? 'frames:false' : 'hidden:true'} — this tab was not painting when it was read. `
      + 'Chrome stops animation frames in a tab nobody is looking at, and lazy lists, scroll-loaded '
      + 'sections and observers ride them: an empty read, a low count or grew:false here says nothing '
      + 'about the site. Read what the page FETCHES instead (tab_here network, which needs no paint), '
      + 'or read again once the tab is in front. Do not report this as the site blocking.');
  }
  if (pg.settled === false) {
    lines.push(`page.settled:false — the wait hit its cap${pg.settleMs ? ` (${pg.settleMs} ms)` : ''}`
      + `${pg.why ? `: ${pg.why}` : ''} while the page was still changing, so every count in this reply `
      + 'is a FLOOR and an absence is not proven. Read again, or wait on a condition with page_state '
      + 'path:"@await(<css> :: still)" before sizing anything on it.');
  }
  return lines;
}

// A pager verdict or a finished walk may sit on the reply itself or one object down (`pagination`,
// `pager`, `out`), depending on which op answered — look in both rather than hard-code a nesting
// another workstream owns.
function findKey(o, key) {
  if (!o || typeof o !== 'object') return undefined;
  if (o[key] !== undefined && o[key] !== null) return o[key];
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && v[key] !== undefined && v[key] !== null) return v[key];
  }
  return undefined;
}

function pagerLines(o) {
  const lines = [];
  const near = findKey(o, 'nearMisses');
  if (Array.isArray(near) && near.length) {
    const shown = near.slice(0, 3).map((m) => `"${String(m?.label ?? '').slice(0, 40)}"`
      + `${m?.rejected ? ` (rejected: ${String(m.rejected).slice(0, 80)})` : ''}`).join('; ');
    const first = near.find((m) => m?.selector || m?.href) || {};
    const override = findKey(o, 'override');
    lines.push(`no next page was accepted, but ${near.length} control${near.length === 1 ? '' : 's'} came close: ${shown}. `
      + 'The pager is a judgment and it can be overruled: if one of these IS the next page, run it again with '
      + `${typeof override === 'string' && override ? override : `list_extract {next: "${first.selector || first.href || '<selector or href>'}"}`}. `
      + 'Do not report the list as ended until you have looked at them.');
  }
  const grow = findKey(o, 'growable');
  if (grow && typeof grow === 'object' && (grow.selector || grow.label)) {
    lines.push(`a load-more control${grow.label ? ` ("${String(grow.label).slice(0, 40)}")` : ''} is on the page and was NOT `
      + 'pressed, so the list is longer than what was read. page_grow '
      + `{selector: "${grow.selector || '<its selector>'}"} until grew:false, then extract again.`);
  }
  return lines;
}

// tab_here and current_page answer the same question — what state is this page in — so they share
// the lines about it. `rising` and `hasList` are the two fields a plan gets sized on.
function readinessLines(o) {
  const lines = [];
  if (o?.rising === true) {
    lines.push(`rising:true — rowsOnPage (${o.rowsOnPage ?? '?'}) was still climbing when the wait ran out, so it `
      + 'is a FLOOR, not a total. Sizing tabs, pages or a fan-out on it is how a run reports 27 of 240. '
      + 'page_grow until grew:false, or page_state path:"@await(<row css> :: still)", then count.');
  }
  return lines;
}

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
        + 'tab_here to point it at a URL, or tab_here newTab:true to open one. Neither needs the panel.';
    }
    return 'that page cannot be read: only http and https pages can be — point the tab at a web '
      + 'page with tab_here.';
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

// What a harvest's numbers imply. Shared, because a backgrounded harvest hands the same object back
// through results action:"status" once it is done, and the lesson is about the numbers, not the door.
function harvestLines(o) {
  const lines = [];
  if (o?.walled) {
    lines.push('walled:true — the site asked to verify a human and every lane stopped. Relay that to the '
      + 'person and wait; do NOT retry, because retrying is what turns a check into a block. When it has '
      + 'cleared, page_harvest {retryOf:"<this runId>", lanes:2} finishes only what is left.');
    return lines;
  }
  const pages = Number(o?.pages) || 0;
  const read = Number(o?.read) || 0;
  const failed = Number(o?.failedCount) || 0;
  if (o?.nextFrom !== undefined && o?.nextFrom !== null) {
    lines.push(`limit DROPPED pages, it did not trim this reply: ${o.matched ?? '?'} links matched and `
      + `${o.skipped ?? '?'} were not opened. Pass from:${o.nextFrom} for the next fold.`);
  }
  if (o?.capped) {
    lines.push('capped — a page held more repeating rows than rows.limit (default 500), so the table is '
      + 'short of what the pages hold. Raise rows.limit and re-run those pages.');
  }
  if (pages && Number(o?.netMissed) >= pages) {
    lines.push(`netMissed:${o.netMissed} of ${pages} — no response matched \`network\` on ANY page, which means `
      + 'the filter is wrong, not the site. tab_here {network:"*"} on one record page lists the urls it '
      + 'really fetches.');
  }
  if (failed > 0) {
    lines.push(`${failed} page${failed === 1 ? '' : 's'} gave nothing (failed[] says why). A thin page is `
      + 'usually transient, not a bad page: page_harvest {retryOf:"<this runId>"} re-runs only those, and '
      + 'results action:"merge" keeps the better of each row. Add awaitFor if the misses look like timing.');
  }
  if (read > 0 && Number(o?.rows) === 0) {
    lines.push(`${read} pages were read and none gave a row: that is the SELECTOR, not the site. The commonest `
      + 'cause is a hashed classname copied off the list page, which differs on the record page. Confirm '
      + 'with page_state path:"@dom(<css>)" on ONE record page, or use ":self" for the row\'s own text.');
  }
  if (Number(o?.late) > 0 && !o?.tryNetwork) {
    lines.push(`late:${o.late} — that many pages answered only on the second look. It means client-rendered `
      + 'and slower, NOT blocked.');
  }
  // `distinct` is reported by the engine as a fact and deliberately not interpreted there, because a
  // threshold tight enough to catch a shop's rating on every listing also fires on every honest
  // currency column. So this line names the columns and the check, and claims nothing about them.
  // The line it draws is `COARSE_MIN_FILLED` / `COARSE_DISTINCT_SHARE`, with the measured case.
  const coarse = Object.entries(o?.fields || {})
    .filter(([, f]) => f && Number(f.filled) >= COARSE_MIN_FILLED && Number(f.distinct) > 0 && f.distinct <= f.filled * COARSE_DISTINCT_SHARE)
    .map(([k, f]) => `${k} (${f.distinct} distinct over ${f.filled})`);
  if (coarse.length) {
    lines.push(`few distinct values: ${coarse.slice(0, 4).join(', ')}. Expected for a category or a currency. `
      + 'For a value you asked for PER RECORD it usually means the field belongs to something coarser — the '
      + 'shop, the page, the site. Check one row against its own contents before naming what it means.');
  }
  if (Array.isArray(o?.alsoRows) && o.alsoRows.length) {
    lines.push(`this page\'s ld+json also carried ${o.alsoRows.slice(0, 5).join(', ')}; name one with rows.from `
      + 'to make IT the rows.');
  }
  return lines;
}

// The edges. Keyed by tool name; each gets that tool's own reply AND the arguments that produced
// it, and returns a line or null. The arguments arrived with the consolidation: `results` is seven
// actions and page_grow is three modes, and which one was asked for is not always in the reply.
const EDGES = {
  current_page: (o) => [...readinessLines(o), nextForCurrentPage(o)],

  tab_here: (o, a) => {
    if (a?.close) return null;
    const lines = [];
    if (o?.challenge) {
      lines.push(`the site is showing a check (${o.challenge}) — relay that to the person and let them `
        + 'clear it. Do NOT retry; retrying is what turns a check into a block.');
      return lines;
    }
    if (o?.arrived === false) {
      lines.push('arrived:false — the tab\'s URL did not change, so whatever you read next is the page it '
        + 'was ALREADY on. A redirect back, a refused navigation and a same-page route all look like this.');
    }
    lines.push(...readinessLines(o));
    if (o?.hasList === false && !a?.network && o?.arrived !== false) {
      lines.push('hasList:false on a page you believe is a list means you are early, or the rows are FETCHED '
        + 'rather than rendered. Do not plan on it: call tab_here again with network:"*" to map what the '
        + 'page fetches, which is complete long before the DOM is.');
    }
    if (a?.network && o?.network && (Array.isArray(o.network) ? o.network.length : true)) {
      lines.push(a.network === '*'
        ? 'this is a MAP, not the data: pick the response holding your fields, then hand a substring of its '
          + 'url to page_harvest {network} (or page_grow {network, rows}) with the $. paths printed here as '
          + 'fields. Choose a fragment only a data call can have — a filter matches stylesheets and images too.'
        : 'the captured bodies are here once; to read the same response on every record, give this filter '
          + 'to page_harvest {network} with $. paths as fields rather than navigating page by page.');
    }
    if (a?.newTab && !a?.close && o?.tabId != null) {
      lines.push(`tab ${o.tabId} is NEW and nothing will close it: tab_here {tabId:${o.tabId}, url, close:true} `
        + 'when you are done, or the person clears it by hand.');
    }
    return lines;
  },

  // A ranked list is only worth extracting if the ranking can be trusted, and the two fields that
  // say whether it can are the two that get skipped. Furniture and repetition are the measured
  // ways this goes wrong: a footer site-directory and a filter sidebar have both outscored the
  // actual results.
  page_study: (o) => {
    const lists = o?.lists || [];
    const best = lists[0];
    if (!best) {
      return 'no repeating structure was found, so list_extract has nothing to walk — and if what you want '
        + 'is not a list, stop looking for one. A name in a header is page_state path:"@dom(<css>)"; the '
        + 'markup itself is path:"@html(body :: 2)"; a value on each of many pages is page_harvest. '
        + 'Re-frame after the FIRST refusal, not the fifth.';
    }
    const lines = [];
    if (best.looksLikeFurniture && lists.length === 1) {
      // Measured on shopee.com.br: one candidate, the footer, 5 rows, on a page holding 60 products.
      lines.push('the ONLY candidate is furniture (a footer, nav or aside). That is not a page without a '
        + 'list, it is a page read before its list rendered. Study it again in a moment, or read what the '
        + 'page FETCHES with tab_here network:"*" instead of what it shows.');
    } else if (best.looksLikeFurniture) {
      lines.push(`the top candidate sits inside a ${(best.landmarks || []).join('/') || 'nav/footer'} `
        + 'landmark, which is what furniture looks like — check the lower-ranked candidates before '
        + 'trusting it.');
    } else if (Number(best.distinctness) <= 1 && Number(best.rows) > 1) {
      // WHAT distinctness:1 ACTUALLY MEANS, learned the expensive way — twice.
      //
      // First this edge said "every row points at the same place", which is FALSE: IMDb's 250 films,
      // HN's 30 stories and Stack Overflow's 15 questions each resolve somewhere different, and all
      // three reported distinctness 1. Then the condition was tightened to require identical sample
      // rows — which would have silenced the hint on all three, removing a signal that three
      // independent agents followed and were right to follow.
      //
      // The field does not mean "duplicate rows". It means THE ENGINE CANNOT TELL THE ROWS APART,
      // which is the precise reason list_extract collapses fields on a layout like HN's paired
      // .athing/.subtext rows. The signal was always real; only the description of it was wrong.
      lines.push(`distinctness is ${best.distinctness} across ${best.rows} rows: the engine cannot tell `
        + 'these rows apart, which is what makes list_extract collapse fields on layouts like this '
        + '(paired rows, rows whose links all look alike). It does NOT mean the rows are duplicates. '
        + 'page_state path:"@dom(<row css>)" returns what is really there; reach for list_extract only '
        + 'if you have checked the rows are uniform.');
    } else {
      lines.push(`list_extract selector:"${best.selector}" for a table you can export, or page_state `
        + `path:"@dom(<row css>)" for a single read of the ${best.rows} rows. If a run returns far fewer than `
        + `${best.rows}, the rows are not uniform — @dom, not a bigger pages number.`);
    }
    // Measured on a live storefront: 13 buttons and no load-more at 10 rows; the same control
    // appeared once the list was deep. A lazy list often renders its control only after the first
    // batch fills, so an empty sweep at first paint is truthful and not final.
    const cands = o?.growth?.candidates;
    if (Array.isArray(cands) && !cands.length) {
      lines.push('growth.candidates is empty: no load-more is on the page YET, which is not the same as '
        + 'never. page_grow scroll:true, then study again, before concluding this list cannot grow.');
    } else if (Array.isArray(cands) && cands.some((c) => c && c.verified === false)) {
      lines.push('the growth candidates are guesses (verified:false): press one with page_grow {selector} to '
        + 'find out whether it loads anything.');
    }
    return lines;
  },

  // grew:false is honest and useless on its own; what to do about it depends on WHY.
  page_grow: (o, a) => {
    const mode = String(a?.mode || 'grow');
    const lines = [];
    if (mode === 'walk') {
      const rows = o?.rows || [];
      if (a?.fill !== undefined && a?.fill !== null) {
        if (o?.value !== undefined && String(o.value) !== String(a.fill)) {
          lines.push('the field now holds something OTHER than what was sent — a masked or length-capped '
            + 'input does that. Read `value` before relying on it.');
        }
        if (!o?.error) lines.push('filling does not submit: press the form\'s own control next, with mode:"walk" and `text`.');
        return lines;
      }
      if (a?.choose && o?.changed === false) {
        lines.push('changed:false — the option was set and the page looked identical afterwards: a slow '
          + 're-render (raise waitMs) or a widget that ignores the event. Do not report the rows as '
          + 're-sorted; pass `read` with the row selector and compare the rows themselves.');
      }
      // A walk that pressed the wrong thing reports it plainly, and the fix is always the selector.
      if (rows.length && Number(o?.moved) === 0 && !a?.choose) {
        lines.push('moved:0 on every row — the selector matched a wrapper, not the control. page_state '
          + 'path:"@html(<css> :: 2)" on one of them shows what actually carries the click (often a child '
          + 'with a role, an href or a data-* id).');
      }
      // `next` here is the walk's own PAGINATION CURSOR, not a hint — the two are deliberately
      // different fields. See the attach site in index.mjs.
      if (o?.next != null && rows.length) {
        lines.push(`stopped at ${o.next} of ${o.total}; pass offset:${o.next} to continue rather than start over.`);
      }
      return lines;
    }
    if (mode !== 'grow') return lines;
    if (a?.network && !o?.error) {
      lines.push('feed mode holds what each scroll FETCHED. The first screenful is usually already in the '
        + 'document and NOT in this capture: read that from the page and treat these rows as what follows.');
    }
    const dup = o?.duplicates;
    if (dup && Number(dup.loopingPct) >= LOOPING_PCT_MIN) {
      lines.push(`loopingPct:${dup.loopingPct} — the list is re-serving rows it already gave. uniqueGained `
        + `(${dup.uniqueGained ?? '?'}), not domRows, is what a table will contain; a feed can grow forever `
        + 'without adding a row you do not already hold. This is the end of the useful list.');
    }
    if (o?.grew) return lines;
    const stuck = o?.scrolled && o.scrolled.from === o.scrolled.to && o.scrolled.max > 0;
    if (stuck) {
      lines.push('the pane did not move at all (from === to) even though it can scroll. Some apps load '
        + 'nothing from an assignment to scrollTop — use page_state path:"@collect(<row css> :: '
        + '<hops>)", which drives the pane with real wheel and PageDown gestures.');
    } else if (!pageLines(o).length) {
      lines.push('nothing grew. If this is a conversation or a feed, history loads UPWARD — pass '
        + 'direction:"up", or jump to the boundary (a trailing /0, ?page=1, sort=oldest) and collect '
        + 'downward from there. On a page with several panes, name the container with `selector` and '
        + 'scroll:true: scrolling the window moves the pane you did not mean.');
    }
    if (o?.containerRows && Number(o?.recordLinks?.after ?? o?.recordLinks) === 0) {
      lines.push('these rows carry no links, so recordLinks reads 0 forever: containerRows is the growth '
        + 'signal to trust here.');
    }
    return lines;
  },

  page_state: (o, a) => {
    const p = String(a?.path || '').trim();
    const lines = [];
    // A harvest that ran out of budget looks exactly like one that finished.
    if (o?.ended === 'capped') {
      lines.push('ended:capped means the hops ran out and THERE IS MORE — raise hops, or continue from '
        + 'where it stopped. Do not report this as the end of the list.');
    }
    if (o?.ended === 'limit') lines.push('ended:limit — the row cap was hit, not the end of the list. `limit` sets how far to go; `reply` only caps what comes back.');
    if (typeof o?.hidden === 'number' && o.hidden > 0) {
      lines.push(`hidden:${o.hidden} — the page is holding more than the selector matched. A collapsed `
        + 'section renders no children at all, and scrolling cannot reveal what is not there: '
        + '@map(<scope>) expands disclosures first.');
    }
    if (Number(o?.redacted) > 0) {
      lines.push(`${o.redacted} value${o.redacted === 1 ? '' : 's'} came back masked. The mask is keyed on the NAME, `
        + 'so it over-catches: a field called "author" matches the auth prefix. If a plainly harmless field '
        + 'reads as redacted, name the leaf ("...author.username") and it returns — do not report the data '
        + 'as unavailable. Real credentials stay masked whatever you pass.');
    }
    if (/^@net\(/i.test(p)) {
      const arg = p.slice(5, -1).trim();
      if (arg && arg.toLowerCase() !== 'stop' && !o?.error) {
        lines.push('the watch is running and OUTLIVES this call, but it cannot see requests the page already '
          + 'made. Now do the thing that causes the request (any tool), then poll with path:"@net()"; end '
          + 'with "@net(stop)" — until then a debugger bar stays on the tab and DevTools cannot open on it.'
          + (arg === '*' ? ' "*" keeps EVERY response, images and fonts included; on a heavy app name a filter instead.' : ''));
      } else if (!arg) {
        const named = Array.isArray(o?.network) ? o.network.length : 0;
        const shaped = Array.isArray(o?.responses) ? o.responses.length : 0;
        if (named > shaped) {
          lines.push(`${named} responses arrived since the last poll and ${shaped} had a body worth shaping. `
            + '`responses` carry the $. paths to hand to page_harvest {network} or page_grow {network, rows}; '
            + '`network` names the rest; `kinds` counts them by type. To read one specific body, name its url: '
            + '"@net(<substring>)". A poll CONSUMES what it reports.');
        }
      }
    }
    // The single most expensive wrong turn available: pressing through a list whose rows already
    // carry the URL. Measured at 23 servers of somebody else's browser time.
    if (/^@dom\(/i.test(p) && Array.isArray(o?.rows) && o.rows.length) {
      const linked = o.rows.filter((r) => r && r.href).length;
      if (linked >= Math.max(2, o.rows.length * 0.5)) {
        lines.push(`${linked} of ${o.rows.length} rows carry an href — this is a WORK LIST, not something to `
          + 'press through. For the same fields off each, that is ONE page_harvest {urls} or {links} call.');
      } else if (!linked && o.rows.length > 3) {
        lines.push('no row carries an href, so pressing is the only way in — page_grow mode:"walk" with '
          + 'back:true, which returns the person\'s tab to where they left it.');
      }
      if (o.rows.length >= PSEUDO_ROWS_FILE_HINT) {
        lines.push('rows from a pseudo-path exist in this reply only: they carry no resultId, so results get '
          + 'and export cannot reach them. If the person needs a file, list_extract {selector} is the route.');
      }
    }
    return lines;
  },

  // The failure that does not look like one: a run that "succeeded" with a fraction of the rows.
  list_extract: (o) => {
    if (o?.runId) return null;              // still starting; nothing measured yet
    return shortRunLines(o);
  },

  page_harvest: (o, a) => {
    if (o?.runId && !o?.resultId) {
      return 'running in the background. Poll results {action:"status", runId} every 20-30 s and relay the '
        + 'percent — silence is indistinguishable from a hang. results {action:"stop", runId} ends it and '
        + 'keeps what was read.';
    }
    const lines = harvestLines(o);
    if (!a?.background && Number(o?.pages) > BLOCKING_PAGES_MAX) {
      lines.push(`that was ${o.pages} pages in one blocking call. Over about ${BLOCKING_PAGES_MAX}, pass background:true so the `
        + 'run can be polled, reported on and stopped.');
    }
    return lines;
  },

  results: (o, a) => {
    const action = String(a?.action || '');
    if (action === 'status') {
      if (o?.state === 'waiting_for_user') {
        return 'waiting_for_user — the SITE asked the person to prove they are human. Tell them and wait; '
          + 'the run carries on by itself once it clears. Do NOT retry and do NOT start another run: '
          + 'retrying is what turns a check into a block.';
      }
      if (o?.state === 'done') return [...shortRunLines(o), ...(o?.fields ? harvestLines(o) : [])];
      return null;
    }
    if (action === 'get' && o?.truncated && Number(o?.more) > MORE_ROWS_SAVE_HINT) {
      return `${o.more} rows remain. Paging them through this conversation is the expensive route: results `
        + '{action:"get", resultId, saveTo:"/absolute/path.csv"} writes every row to a file the server '
        + 'creates, and you read it with your own tools.';
    }
    if (action === 'download' && Number(o?.resolvedX) > 0) {
      return `resolvedX:${o.resolvedX} — that many X videos were re-resolved through X\'s syndication API before `
        + 'saving, because a captured X url is often session-bound or one small fragment. The file that '
        + 'landed is not necessarily the url the scan reported.';
    }
    if (action === 'merge' && Number(o?.unkeyed) > 0) {
      return `unkeyed:${o.unkeyed} — those rows had no value in the key column, so they were kept as they `
        + 'were and could not be matched across passes. A key that is often empty is the wrong key.';
    }
    return null;
  },
};

// A walk that ended with far fewer rows than the page showed. Measured: an icon rail of 23 entries,
// which page_study itself counted as 23 rows, came back as ONE row; a chat log came back as
// sentence fragments with no author and no timestamp. Neither is a broken page — list_extract must
// first agree that something is a list, and when it disagrees it does not refuse, it returns a little.
function shortRunLines(o) {
  const got = Number(o?.rows) || 0;
  const seen = Number(o?.rowsOnPage) || 0;
  if (seen > 3 && got > 0 && got < seen / 2) {
    return [`${got} rows came back from a page showing about ${seen} — that gap means the rows are `
      + 'not uniform (icons, message groups, date dividers), not that the list is short. page_state '
      + 'path:"@dom(<container css>)" returns what is actually there; more pages will not help.'];
  }
  return [];
}

// EVERY EDGE SEES THE ENVIRONMENT FIRST. The page header and the pager's near misses can arrive on
// any reply that read a page, so they are added around the table rather than repeated in each entry
// — an op added later gets them without anyone remembering to ask. One string out, lines joined,
// because `hint` is one field; null when every source was silent.
const flat = (v) => (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' && x);

// WHICH BROWSER ANSWERED, WHEN IT WAS NOT THE ONE ASKED. index.mjs re-runs an op in the other browser
// when the reply says this one could not (a lane that did not paint, a page that wanted the person's
// login) and marks the reply `switched: {from, to, why, tabId?}`. The one fact a caller must not miss
// is that the ids in that reply belong to the browser that answered — a companion tabId means nothing
// in the person's Chrome — so this line says so, first, and only when it is true.
function switchedLines(o) {
  const s = o?.switched;
  if (!s || typeof s !== 'object' || !s.to) return [];
  const who = s.to === 'companion' ? 'the headless companion (no login, no banner)' : 'the person\'s own Chrome';
  return [`switched: this reply came from ${who}, not the ${s.from || 'browser'} asked, because ${s.why || 'it could not answer there'}. `
    + `Every tabId, runId or resultId in it${s.tabId != null ? ` (tab ${s.tabId})` : ''} belongs to the ${s.to} and routes there on its own.`];
}

const NEXT = Object.fromEntries(TOOLS.map((t) => [t.name, (out, args) => {
  // A switched reply that already carries the extension's hint keeps it, under the switch line —
  // the extension measured the page and outranks this table; index.mjs only calls in here over an
  // existing hint when `switched` is set.
  if (out?.switched && typeof out?.hint === 'string' && out.hint) return [...switchedLines(out), out.hint].join('\n');
  const lines = [...switchedLines(out), ...pageLines(out), ...flat(EDGES[t.name]?.(out, args || {})), ...pagerLines(out)];
  return lines.length ? lines.join('\n') : null;
}]));

// --- answered here, without asking the browser -----------------------------------------------------
// `PRE` runs before anything else in index.mjs `call()`. It returns null (carry on), {refuse} (an
// error the model can read) or {reply} (the whole answer). Three things live behind it, and they
// share a door so index.mjs — mirrored byte-for-byte into the public package — grew one call site
// instead of three.

// 1. A PARAMETER THE TOOL DOES NOT HAVE. Every schema above says additionalProperties:false and
//    nothing enforced it: arguments went straight to the browser, the op destructured the names it
//    knew, and the rest fell on the floor. `list_extract {page: 3}` — one letter short — ran an
//    UNBOUNDED walk and reported success. The message is chrome-devtools-mcp's shape
//    (ToolHandler.ts:78-92): the fact, the accepted names, one imperative.
const near = (bad, names) => {
  const b = bad.toLowerCase();
  return names.find((n) => n.toLowerCase() === b)
    || names.find((n) => n.toLowerCase().startsWith(b) || b.startsWith(n.toLowerCase()))
    || names.find((n) => n.length > 3 && (n.toLowerCase().includes(b) || b.includes(n.toLowerCase())))
    || null;
};
function unknownArgs(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) return null;
  const names = Object.keys(tool.inputSchema.properties || {});
  const bad = Object.keys(args).filter((k) => !names.includes(k));
  if (!bad.length) return null;
  const guess = bad.map((k) => [k, near(k, names)]).filter(([, n]) => n);
  return `Unknown argument${bad.length === 1 ? '' : 's'} for tool "${name}": ${bad.map((k) => `"${k}"`).join(', ')}. `
    + (names.length ? `Expected arguments: ${names.map((n) => `"${n}"`).join(', ')}. ` : 'It takes no arguments. ')
    + (guess.length ? `${guess.map(([k, n]) => `Did you mean "${n}" for "${k}"?`).join(' ')} ` : '')
    + 'Nothing was sent to the browser. Fix the name and retry.';
}

// 2. `results {saveTo}` — THE SERVER WRITES THE TABLE.
//
// `get` pages rows THROUGH the model (the 80%-of-the-run cost measured on the 250-film scrape) and
// `export` writes into Downloads under a name the browser picks, a directory an agent's file tools
// often cannot open. Both reference servers take an explicit path on their big readers instead. The
// rows are pulled from the extension's own `results.get` a page at a time and appended as they
// arrive, so a 60,000-row table is never held whole here and never enters one reply.
//
// WHERE IT MAY WRITE is a convenience guard, not a security boundary — the same honesty Playwright
// puts on its own file roots. Absolute only, because this process's cwd is not the agent's. Under
// the person's home or a temp directory only, judged on the REAL path of the deepest directory that
// exists, so neither `..` nor a symlink climbs out. Not under a dot-directory in home (~/.ssh,
// ~/.config, an agent's own settings), because what gets written is page content and a page can be
// hostile. Never over an existing file: `wx` makes the check and the create one step.
const SAVE_PAGE = 1000;                       // the extension's own ceiling for one results.get
const inside = (dir, p) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };
function saveTarget(saveTo) {
  const raw = String(saveTo || '');
  if (!path.isAbsolute(raw)) {
    return { refuse: `saveTo must be an ABSOLUTE path — got "${raw.slice(0, 120)}". This server's working `
      + 'directory is not yours, so a relative path would land somewhere you cannot find.' };
  }
  const want = path.normalize(raw);
  const ext = path.extname(want).toLowerCase();
  if (ext !== '.csv' && ext !== '.json') {
    return { refuse: `saveTo must end in .csv or .json — got "${ext || 'no extension'}". The extension picks the format.` };
  }
  // The deepest ancestor that exists decides where this really is; the rest is ours to create.
  let at = path.dirname(want);
  while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  const resolved = path.join(real(at) || at, path.relative(at, want));
  const home = real(os.homedir()) || os.homedir();
  const temps = [...new Set([os.tmpdir(), '/tmp', '/private/tmp'].map((d) => real(d)).filter(Boolean))];
  const inHome = inside(home, resolved);
  if (!inHome && !temps.some((d) => inside(d, resolved))) {
    return { refuse: `saveTo must be under the person's home (${home}) or a temp directory (${temps.join(', ')}). `
      + `"${resolved}" is neither.` };
  }
  if (inHome) {
    const dot = path.relative(home, resolved).split(path.sep).slice(0, -1).find((seg) => seg.startsWith('.') && seg !== '.holoscrape');
    if (dot) {
      return { refuse: `saveTo will not write inside "${dot}" under home — dot-directories hold credentials and `
        + 'tool configuration, and what is written here is page content. Choose an ordinary folder.' };
    }
  }
  if (fs.existsSync(resolved)) {
    return { refuse: `${resolved} already exists and saveTo never overwrites. Choose a new name.` };
  }
  // Written at the resolved path, REPORTED under the name the caller gave. On macOS /var and /tmp are
  // themselves symlinks, so the two differ on almost every temp path; both open the same file, and an
  // agent that gets back a string it never sent has to work out whether it is the same one.
  return { file: resolved, shown: want, ext };
}

// Same file the extension's own export writes (background.js `toCsv`): BOM so Excel reads UTF-8,
// CRLF records, a dash for an empty cell so "this business publishes no email" cannot be mistaken
// for "the email pass never ran". JSON keeps the empty string — a program reads that one.
const csvQuote = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return csvQuote(s.trim() ? s : '-'); };

async function saveRows(args, ask) {
  const target = saveTarget(args.saveTo);
  if (target.refuse) return target;
  if (!args.resultId) return { refuse: 'saveTo needs a resultId — the table to write.' };
  const { file, shown, ext } = target;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd = null;
  try {
    fd = fs.openSync(file, 'wx');
    let offset = 0; let rows = 0; let columns = null;
    for (;;) {
      const page = await ask('results.get', { resultId: args.resultId, limit: SAVE_PAGE, offset,
        ...(Array.isArray(args.columns) && args.columns.length ? { columns: args.columns } : {}) }, SAVE_ASK_MS);
      const got = Array.isArray(page?.rows) ? page.rows : [];
      if (!columns) {
        columns = Array.isArray(page?.columns) && page.columns.length ? page.columns : Object.keys(got[0] || {});
        fs.writeSync(fd, ext === '.csv' ? `\uFEFF${columns.map((c) => csvQuote(String(c ?? ''))).join(',')}\r\n` : '[');
      }
      let chunk = '';
      for (const r of got) {
        chunk += ext === '.csv'
          ? `${columns.map((c) => csvCell(r?.[c])).join(',')}\r\n`
          : `${rows ? ',' : ''}\n${JSON.stringify(r)}`;
        rows++;
      }
      if (chunk) fs.writeSync(fd, chunk);
      // The extension says when it is finished; a page that came back empty is the backstop, so a
      // `truncated` that never turns false cannot spin here forever.
      if (!page?.truncated || !got.length) break;
      offset = Number.isFinite(page.nextOffset) ? page.nextOffset : offset + got.length;
    }
    if (ext === '.json') fs.writeSync(fd, rows ? '\n]\n' : ']\n');
    fs.closeSync(fd); fd = null;
    return { reply: { path: shown, rows, bytes: fs.statSync(file).size, columns, format: ext.slice(1) } };
  } catch (e) {
    // HALF A TABLE UNDER THE WHOLE TABLE'S NAME IS WORSE THAN NO FILE. A short answer that looks
    // complete is the failure this project keeps paying for, so a run that dies part-way removes
    // what it wrote and says so.
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} try { fs.unlinkSync(file); } catch (_) {} }
    if (e?.code === 'EEXIST') return { refuse: `${file} already exists and saveTo never overwrites. Choose a new name.` };
    return { refuse: `${e?.message || e}\n\nNothing was saved: ${file} was removed rather than left holding part of the table.` };
  }
}

async function PRE(name, args, ask) {
  const bad = unknownArgs(name, args);
  if (bad) return { refuse: bad };
  if (name !== 'results') return null;
  const action = String(args?.action || '');
  // 3. THE GUIDE. No browser op exists for it and none is needed: it must answer with Chrome closed,
  //    because "nothing is connected" is one of the things it explains.
  if (action === 'guide') return { reply: guide(args?.topic) };
  if (args?.saveTo !== undefined && args?.saveTo !== null) {
    if (action !== 'get' && action !== 'export') {
      return { refuse: `saveTo writes a table's rows, so it goes with action "get" or "export" — not "${action}".` };
    }
    return saveRows(args, ask);
  }
  return null;
}

export { TOOLS, OPS, SLOW, READ_ONLY, NEXT, LOCAL_ACTIONS, PRE, timeoutFor };
