---
name: holoscrape
description: Operating guide for the HoloScrape MCP server (current_page, tab_here, page_study, page_grow, page_state, list_extract, page_harvest, results, resolve_x_video). Use when extracting lists, tables or record pages from the person's own signed-in Chrome through HoloScrape, and especially when a read came back short, empty or partial, when choosing between the list page and the record pages, when using page_state pseudo-paths, or when a site shows a check.
---

HoloScrape drives the person's OWN already-signed-in Chrome. There is
no cloud browser and no separate profile: every page you read is the page they would see, with
their logins and their IP. Treat their browser as someone's desk you are working at.

This guide is organised by the SITUATION you are in, not by tool. Every fact in it was paid for by a
failed session; the measurements are kept because a rule without its number gets argued with. The
tool descriptions are short on purpose and the conditional warnings arrive as "hint" lines on the
replies that prove them, so this is where the procedure and the history live.

# Before the first call: which tool, and what it costs

EVERY TOOL NAMED IN THIS DOCUMENT EXISTS ON THIS SERVER. Your client may have shown you only a few
of the TEN — schemas are fetched on demand, and a keyword search returns the top matches, not the
set. So the tools you were handed are NOT the tools there are. Before concluding that something is
impossible, look for it here by name and ask for that exact name.

The ten: current_page, tabs_list, tab_here, page_study, page_grow, page_state, list_extract,
page_harvest, results, resolve_x_video. Two of them carry most of the surface: page_state takes the
pseudo-paths (@dom, @html, @map, @collect, @await, @fetch, @net) and results takes actions (status,
stop, list, get, export, download, merge, guide). Counting those as separate tools is how this line
used to say "twenty-one", which sent a reader hunting for eleven tool names that do not exist.

Measured, twice: a session reported "there is no direct navigate-this-tab-to-a-URL primitive" and
re-clicked through a list page for every record. tab_here is precisely that primitive and had been
shipped for weeks. Another reasoned its way to visiting 250 pages by hand with page_harvest sitting
unread. Both were correct about what they had been SHOWN.

- tab_here — POINT AN EXISTING TAB AT A URL. The navigation primitive. Use it instead of
  tab_here newTab:true (which leaves a tab per destination for someone to close by hand) and instead
  of pressing links (page_grow mode:"walk" runs INSIDE the page, so an ordinary link destroys the
  frame it is running in and the answer is lost — the tab arrives, you get nothing).
- page_harvest — MANY PAGES, ONE CALL, NO ROWS THROUGH YOU. A list page and the records behind its
  links. Measured on the same 250 pages: 52 minutes and 733 calls by hand, 3m13s and one call with
  this. If you are about to visit a set of addresses you already hold, this is the call.
- current_page — start here for "I have a page open, scrape it". It takes no arguments and returns a
  tabId to pass to page_study or list_extract.
- tabs_list — only when current_page is not the page they meant and you need to ask which; for the
  ordinary case prefer current_page.
- page_study — the cheap ranked look: what repeats, how it paginates.
- page_state path:"@dom(<css>)" — read what is rendered, no ranking. The fix when a run came back
  short, and the only way to read an icon rail whose names live in aria-label.
- page_state path:"@html(<css> :: <depth>)" — the markup itself. Reach for it the MOMENT another
  tool refuses something you can plainly see. Reading the markup answers in a minute what an hour
  of inference does not.
- list_extract — many UNIFORM rows you want followed through pages and saved as an exportable
  table. It must first agree something is a list; a 23-icon rail and a chat log are not, and it
  will return one row and fragments rather than refuse. That is not a bug in the page.
- page_state (a store path) — for records whose fields the DOM never renders.

WHAT A CALL COSTS. Every description ends with a tier, because the server knows it and used to keep
it to itself. "Cost: minutes" (list_extract, page_harvest) presses, scrolls or walks pages one after
another, so budget for it and prefer a cheaper tool when one will answer. "Cost: seconds" (tab_here,
page_grow) loads or moves a page. "Cost: instant" (current_page, tabs_list, page_study, page_state,
results) reads what is already there and is cheap enough to call before guessing. An agent that does
not know a walk runs for minutes calls it to answer a question one read would have answered; one
that does not know page_study is instant avoids it and guesses instead. Both are avoidable. Two
tools are USUALLY instant and OCCASIONALLY long: page_state answers a property read in milliseconds
but also runs a gesture-paced @collect that pages a chat backlog, and page_grow takes up to 50 hops.

READ "page" AND "hint" IN EVERY REPLY. "page" is {hidden, frames, settled, settleMs, why}: the state
the tab was read in. hidden:true or frames:false means Chrome was not painting it; settled:false
means the wait hit its cap and the page was still changing. "hint" is written only when the reply
itself shows something is about to go wrong, and it names the next call. A hint the extension wrote
outranks one the server derived, because the extension measured the page.

PATHS SURVIVE A STALE CLIENT; TOOL NAMES DO NOT. Clients cache the tool list when the session
starts. A tool added since then is INVISIBLE — calling it fails as "no such tool", which is
indistinguishable from a feature that was never built. Paths on an existing tool have no such
problem, which is why the read primitives ride page_state: a client holding a stale tool list can
still reach them. The handshake states the build and how many tools it serves; if your list is
missing any, reconnect the MCP server rather than working around the gap.

If a capability you were told exists appears to be missing, suspect the cached list before
concluding it is absent, and say so rather than silently working around it. The workaround is
usually an order of magnitude more expensive: one session hand-walked document.body.children[N]
for hours to rebuild what @dom(<css>) returns in a single call.

# When a page has just loaded: loaded is not ready, and this is the costliest mistake here

A document is complete when its HTML has arrived. On anything that paints from JavaScript — every
marketplace, most dashboards, every Shopee domain — that moment is a header, a spinner and nothing
else. Reads that land there SUCCEED. They answer about a page that does not exist yet.

It never looks like an error, which is why it costs whole sessions. One afternoon, all four:

  page_study             one list, looksLikeFurniture:true, 5 rows
                         -> taken as the product grid. It was the FOOTER; the grid had not mounted.
  page_state @dom(...)   NO_MATCH on a reviews selector, twice
                         -> concluded "reviews are blocked in background tabs". They were not. The
                            section mounts ~2s late; the same selector then returned 6 reviews.
  the search grid        13-20 anchors per read
                         -> reported "27 of 240 items". The page holds 60. It paints in pieces.
  page_harvest           4 rows, failedCount 0
                         -> reported success over 4 copies of the site's schema.org boilerplate.

The third and fourth are the dangerous shape: A PARTIAL ANSWER IS WORSE THAN AN EMPTY ONE, because
zero is obviously wrong and thirteen is not. Anything you size a plan on — how many tabs to open,
how many pages to walk, whether to fan out at all — must come from a count you watched STOP MOVING.

THE DOCUMENT BEING READY IS NOT THE APP BEING READY, AND THE tab_here REPLY TELLS YOU WHICH YOU HAVE.
On a site that paints from JavaScript the load event fires on a header and a spinner, so tab_here
also waits for a list to appear AND STOP GROWING, then reports hasList, rowsOnPage, and rising:true
when the count was still climbing when the wait ran out. READ THOSE BEFORE YOU PLAN ANYTHING.
hasList:false on a page you believe is a list means you are early, or the rows are FETCHED rather
than rendered — pass network to read what the page fetches, which is complete long before the DOM
is. rising:true means rowsOnPage is a FLOOR, not a total: sizing a fan-out off it is how a run
reports 27 of 240. Measured on shopee.com.br, where an early read saw 13-20 of 60 products and one
saw only the footer. arrived:false means the URL did not change at all.

The rules, in order of how much they save you:

1. NEVER CONCLUDE "ABSENT" FROM ONE READ. Not a selector, not a section, not a field. Read it twice,
   a second or two apart. NO_MATCH now says which case it is — believe it.
2. A COUNT STILL RISING IS A FLOOR, NOT A TOTAL. tab_here returns rowsOnPage, and sets rising:true
   when the number had not settled before its budget ran out. Never plan against a rising count.
   The same goes for any reply whose page header says settled:false.
3. GROW THE PAGE BEFORE YOU COUNT IT, EVERY TIME, AS PART OF EXPLORING RATHER THAN AS A REPAIR.
   A list page is not finished when it is painted; most of them mount a screenful and add the rest
   as you move down it. So the exploration sequence on ANY list is: read it, then page_grow, then
   page_grow AGAIN, and only believe the number when a grow reports grew:false. Measured on
   shopee.com.br: a first read saw 14 product links and said total:14; one page_grow took it to 54.
   Nothing about the first answer looked partial. If you skip this you are not reading a list, you
   are reading whatever fit on one screen, and every plan you build on it is scaled wrong.
   AND DO NOT ASSUME THE GROWN NUMBER IS THE SITE'S NUMBER either: that same page settled at 54
   anchors where the site serves 60 a page, because some cards are ads or link differently. Say
   which number you are holding and how you got it.
4. CHECK hasList BEFORE YOU HARVEST. tab_here returns it. hasList:false on a page you believe is a
   list means you are early — or the rows are FETCHED rather than rendered, which is rule 5.
5. ON A CLIENT-RENDERED SITE, PREFER WHAT THE PAGE FETCHES TO WHAT IT SHOWS. Navigate with
   network:"<part of the api url>" and read the JSON. It is complete, its fields are already named,
   and it does not care whether React has mounted. One response is routinely a whole page of rows.
6. NAVIGATING STRAIGHT TO AN API URL IS NOT THE SAME THING and usually fails: the endpoint checks
   headers and tokens the PAGE sends and an address bar does not. Shopee answers error 90309999.
   Capture the call the page makes instead.
7. SECTIONS BELOW THE FOLD OFTEN MOUNT ONLY WHEN SCROLLED TO — reviews and specs are the usual
   ones. Start the watch first, then scroll, then read. SCROLL WITH page_grow scroll:true AND A
   tabId: it works on a tab that is NOT the active one, needs no focus, and never asks the person
   to look at anything. A run that decided it could not reach a section because it was told not to
   bring tabs to the front had the tool for it the whole time, and asked for a permission it did
   not need — see rule 8. Note that page_harvest does NOT scroll the pages it opens, so a field
   that only mounts on scroll comes back EMPTY from a harvest: reach it with page_grow, or say the
   field is unreachable that way rather than reporting the record as having none.
8. WHEN A THEORY NEEDS THE BROWSER TO BE MISBEHAVING — tab focus, throttling, silent blocking —
   SUSPECT YOUR OWN TIMING FIRST. It is the cheaper explanation and it was the right one every
   single time above. The one environment fault that IS real is reported, not guessed: page.hidden
   or page.frames:false in the reply. If the header does not say it, it is your timing.
9. THE ONE SHAPE WHERE THE SITE REALLY IS REFUSING, AND IT DOES NOT LOOK LIKE A BLOCK. A challenge
   can be scoped to a single ENDPOINT rather than to the page. The page loads, every other field
   is full, and ONE section is empty on record after record. Measured on shopee.co.id: the reviews
   widget fetched, and the site answered with /verify/captcha carrying app_key=Rating.PC and
   scene=crawler_item — a challenge aimed at the ratings API, not at the product page, which had
   rendered perfectly. A run reported "no captcha, no block" while that was happening, because it
   only ever looked at the page. HOW TO TELL: the SAME field empty across several records while
   the rest of each record is complete. Then read the tab url and look for /verify. DO NOT RETRY —
   every retry is one more flagged request, and one run spent twelve minutes across four retry
   rounds making it worse. Stop, and say which endpoint is being refused.

# When you are about to count, study or size a list

SCROLL BEFORE YOU STUDY. Everything current_page, page_study, page_state and list_extract return
describes the page AS IT IS NOW, and most list pages mount ONE SCREENFUL and add the rest as you
move down them: call page_grow until it reports grew:false, and only then read or study. Measured
on shopee.com.br, a first read saw 14 product links and reported total:14 on a page that held 54
once grown — nothing about the first answer looked partial. A count taken before growing is a
FLOOR, and every plan sized on it (tabs to open, pages to walk, whether to fan out) is scaled wrong.

The list on screen is often not the whole list. Three different causes, and scrolling only fixes one:
- NOT PAINTED YET — the commonest, and the only one that LOOKS like a working read. See the section on
  loaded versus ready; a grid of sixty paints in pieces and an early read reports thirteen with full
  confidence.
- VIRTUALIZED — rows exist but only the mounted window is in the DOM. @collect handles it.
- COLLAPSED — a closed section renders ZERO children. Scrolling cannot reveal what is not there.
  Expand it (@map) or find the app's dedicated browse-all view, which usually renders everything.

Also: the view an app opens on is rarely where its activity is. Route by whatever the interface
itself marks as unread, recent or count-bearing, rather than by whatever loaded first.

READING page_study. It returns every repeating structure on the tab, RANKED, with the evidence
behind the ranking, plus how the page continues and what might load more — several candidates
rather than one verdict, so YOU choose. Use it when a list came back that you do not trust, or
before writing a scrape you want to be right. Read two fields before trusting the one it marks
chosen: looksLikeFurniture (the candidate sits inside a footer, nav or aside landmark — measured
on real sites where the engine picked a footer site-directory and a filter sidebar over the actual
results) and distinctness (rows that all point at the same place are one record repeated, which is
how a filter panel outscores a product grid; a distinctness of 1 means the engine cannot tell the
rows apart, not that they are duplicates).

IF THE ONLY CANDIDATE IS FURNITURE, THE PAGE HAS NOT RENDERED — that is not a page without a list,
it is a page read too early, and the hint says so. Re-read in a moment, or read what the page
FETCHES (tab_here with network) instead of what it shows. Measured on shopee.com.br: one
candidate, the footer, 5 rows, 8 links on a page holding 60 products.

AN EMPTY growth.candidates MEANS "NOT THERE YET", NOT "NEVER". A lazy list often renders its
load-more only AFTER the first batch fills, so a study run at first paint truthfully finds nothing.
Measured on a live storefront: 13 buttons on the page and no load-more at 10 rows; the same control
appeared once the list was deep. Grow the list, then study again — do not conclude from one empty
read that the list cannot grow. (The matcher itself is wide: it reads "Muat Lebih Banyak" and its
equivalents in a dozen languages.) Growth affordances come back verified:false — press one with
page_grow to find out. They come from TWO sweeps and carry which one found them: position (a
clickable sitting just under the list) and via:"findLoadMore", the hardened sweep that reads direct
text and accepts a div or span behind a cursor:pointer check — because the load-more is often not a
button, and is often not near the list either. An EMPTY candidates list means both sweeps found
nothing, not that nobody looked.

IF WHAT YOU WANT IS NOT ONE OF THESE LISTS, STOP LOOKING FOR A LIST. page_study only sees repeating
structure, and much of what people ask for is not repeating structure on THIS page: a name in a
header is page_state "@dom(...)"; the markup itself, when a tool refuses something you can plainly
see, is page_state "@html(...)"; and a value on each of many pages rather than in a list on this
one is page_harvest. Measured: an agent spent a whole session trying to extract 23 server names
from a rail that carries none, while pressing each server put its name in the title bar. Re-frame
after the FIRST refusal, not the fifth.

# When choosing between the list page and the record pages

ASK WHAT THE LIST PAGE ALREADY SHOWS BEFORE OPENING ANYTHING. Most asks are answered by the rows in
front of you, and the difference is not small:

  on this page, no page opens   list_extract / page_state "@dom(<row css>)"    seconds
  one page per record           page_harvest                                  minutes

Measured: 95 marketplace products took 6m38s through page_harvest and would have been about 15
seconds off the list — because name, price, rating and seller were on the cards all along. Only what
is NOT on the list justifies opening pages: a full description, sku, stock, variants, specs, reviews.

list_extract IS THE FAST PATH, AND THE ONE TO TRY FIRST. It reads the rows already on the page —
seconds, no page opens, no rate-limit surface, and it cannot trip a per-page rate limit. If
everything you need is on the cards, stop there: page_harvest costs one page load PER ROW and is
minutes for the same answer. Use list_extract when the rows ARE uniform, there are many, they page,
and the person wants a file at the end — that last part is the case nothing else covers, since the
pseudo-paths return rows into the reply with no resultId to export. withRecords:true also opens each
row's own record page and fills in the extra columns: slower, and much richer — it is what turns a
listing into contact details.

When you do open pages, the cost is pages x per-page-load / lanes. Lanes divide it up to about
five and then stop helping — eight is measurably slower and loses rows, and on a site that checks
for humans more lanes buys thin pages and challenges rather than speed. More lanes also looks more
like scraping from the person's own address. On a site that has shown a captcha, fewer lanes is
both safer AND more accurate: measured, 3 lanes returned 0 failures on 180 pages where 5 lanes
returned 96 thin on 625. Default 5; drop to 2-3 on anything that has already shown a captcha.

# When you have many pages to visit

If you are about to open a list's links one at a time and read the same shape off every page, stop.
That is page_harvest — THE TOOL FOR "open each of these and get me X". The extension iterates in
parallel lanes, keeps the rows, and hands back a resultId you finish with results action:"export"
— you make a handful of calls and never see a row. WHAT COMES BACK IS A COUNT AND A resultId,
deliberately: asking for 12,000 rows in a reply is the thing this exists to stop.

Measured on 250 film pages done the other way: 52m33s, 733 calls, and only 17% of it was the
browser. The rest was rows being read out of one reply and typed into the next, plus 164 file
appends that existed only because the model was holding the data. The same work through
page_harvest is minutes, because the rows never move through you.

The server enforces this rather than trusting the advice: after a few navigate-then-read-rows
cycles, tab_here REFUSES and tells you the call to make; a read that handed over ten or more links
makes the THIRD visit into that set a refusal, whichever door is used (tab_here, newTab, or a
walk). An instruction to "split the work N ways, one tab each" is the shape that loses — take the
goal from it and harvest instead. oneByOne:true stands the refusal aside for the genuine exception:
pages that differ from one another and must be visited in turn — a login, a form, a set of one-off
lookups. Walking a list's OWN pages (?page=2) is never refused.

Check for an href before you walk. Three shapes, and picking the wrong one costs the person their
browser for minutes:

- **The rows carry hrefs** — that is a WORK LIST. Read them once with page_state "@dom(<row css>)", then
  handle each URL. Do not press through them one at a time.
- **The rows are pressable only** (icon rails, tab strips, modals — no href anywhere) — that is
  what page_grow mode:"walk" is for, and the cost is real: it drives THEIR tab, serially, while they watch.
- **One page that keeps growing** — page_grow or @collect, not either of the above.

The check is one call: page_state "@dom(<row css>)" reports href on every row that has one. A list that has them is
almost never worth walking.

tab_here IS THE WAY TO VISIT A FEW PAGES THAT DIFFER. newTab:true makes a NEW tab every time and
nothing closes them, so N destinations means N tabs the person clears by hand; page_grow
mode:"walk" presses instead, which works on an app that changes route without reloading and CANNOT
work anywhere else — a real page load destroys the frame the walk is running in, and the call dies
reporting "Frame with ID 0 was removed" even though the tab arrived. tab_here runs outside the
page, so a navigation cannot kill it. One tab, many destinations, nothing left behind. With search
set, url names the SITE (a hostname or its search page) and the search is run there — the same
thing a person does by typing into the site's own box, which beats guessing a query string.

# When running page_harvest

ONE PAGE MAY YIELD MANY ROWS. A film has a cast, a product has variants and reviews, a question has
answers. Give rows for those. Give record for the one-per-page fields (title, price, sku); they are
copied onto every row from that page, so a cast row carries its film. Each row is given billing
(its 1-based position) unless you name your own. Give NEITHER and it reads schema.org (ld+json),
which most commerce and most editorial already publish — often the whole answer with no selectors
at all.

ZERO SELECTORS IS A REAL OPTION AND THE FASTEST ONE. Proven on a live recipe page: no record, no
rows, and it returned the full header (name, times, yield, rating) plus 13 review rows from ld+json
alone. If a page publishes schema.org, try the empty call FIRST and read columns — reconnaissance
you did not have to do is the whole margin. rows.from names WHICH schema.org array becomes the rows
("recipeIngredient", "review", "offers", "actor", "itemListElement", "performer"): use it INSTEAD of
rows.at when the page publishes ld+json, it costs no CSS and no look at the markup. A page often
carries several; without it the documented order decides and the reply tells you what it passed
over in alsoRows.

links IS OPTIONAL — omit it and the engine picks the ranked list itself (page_study's chosen
candidate) and follows its links, reporting the selector it used as linksVia. Name one only when you
mean a DIFFERENT list than the main one. Writing it by hand is how a build-hashed class from another
page of the same site ends up matching ten elements on a page that holds 180. Every matching href is
followed, de-duplicated. Prefer links over urls: typing 250 URLs into a call is ~12KB of exactly the
output this tool exists to remove.

In a selector, "css@attr" reads an attribute ("a@href" comes back absolute). USE ":self" TO TAKE THE
ROW'S OWN TEXT, whole and unparsed. That is the answer when a site has moved its per-field hooks and
your inner selectors come back empty: measured on a marketplace whose review markup no longer
carried the title and body hooks, where two attempts returned those columns ABSENT while the row
itself held every word. One {"review": ":self"} beats guessing at hooks, and the text can be split
afterwards.

THE FAST PATH FOR A CUSTOM ATTRIBUTE ON A SINGLE PAGE'S OWN ROWS: pass urls: [<that one page's
address>] with no links, and a "css@attr" field in rows.fields reads that attribute off every
repeating row in ONE call — cheaper than page_state's @html per index, which can only do one element
at a time. It only works when loading that URL fresh reproduces the exact rows you saw; a live,
session-paginated list with no such URL (page 2+ of an inbox after "older") cannot be reopened this
way and needs page_state's per-index @html instead, called for several indices in parallel rather
than one at a time.

CLIENT-RENDERED SITE? NAME THE API INSTEAD OF THE MARKUP. Set network to a substring of the request
url the page fetches its data from ("gql.tokopedia.com", "/api/products") and every matching JSON
response is captured IN THE LANE. Then any field in record or rows may be a $. path into that JSON
instead of a CSS selector: $.data.product.title, or $..description to find a key at any depth.
rows.at as a $. path makes a JSON array the rows, and fields inside it are paths into each element.
Mix freely — the title from the DOM and the description from the response is the ordinary case. The
payloads never leave the browser; only rows come back. Find the right filter and paths with ONE
tab_here({network:"*"}) first, then harvest the set. Without network nothing is captured and no
debugger is attached; with it, it costs a debugging banner per lane, and a lane whose tab has
DevTools open runs DOM-only and says so. netMissed counts pages where nothing matched — if it equals
the page count, your filter is wrong, not the site.

awaitFor: WAIT FOR A CONDITION ON EACH PAGE instead of a guessed settle. Same grammar as the @await
path: "<css> :: <mode> :: <ms>" — mode is exists (default), gone, still, or a number meaning at
least that many. THIS IS THE FIX FOR A HARVEST THAT READS SOME PAGES AND NOT OTHERS: measured, four
agents ran the same selector over the same 120 products and two got every review while two got
almost none. The pages were identical; the timing was not. Name what you are waiting for and no page
is read early, nor waited on longer than it needs. "<spinner css> :: gone" is the surest signal
where one exists, because waiting for CONTENT cannot tell a slow page from an empty one.

limit AND from: limit is pages per run — use it to pilot on 3 before committing to 250 — and NOTE it
does not trim a reply, it DROPS PAGES. When it cuts the queue the reply carries matched, skipped and
nextFrom; feed nextFrom back as from to take the next fold. Same links, next slice, so a long list
can be done in folds instead of abandoned at the cap.

background: SET IT FOR ANYTHING OVER ~20 PAGES. It returns a runId immediately instead of blocking;
results action:"status" then reports pagesDone, percent, rowsSoFar, failedSoFar and an eta, and
results action:"stop" ends it. Without it a 250-page harvest is minutes of total silence, during
which you cannot answer "how far along is it?" and neither you nor the person can tell a working run
from a hung one. Poll every 20-30s and relay the percentage.

retryOf AND merge: TWO PASSES OVER THE SAME LIST ARE ONE ANSWER. retryOf takes a finished runId and
re-runs its FAILED pages and nothing else. A thin page is usually transient rather than a bad page:
measured over 625 products, one pass read 529 and an identical second pass read 563, with only 10
failing BOTH times; the union was 615 (98%). Without retryOf the only way to recover ten failures
was to re-run all 625 and merge the passes by hand. Pair it with awaitFor if the failures look like
timing. results action:"merge" combines two or more resultIds in the browser — the rows never pass
through you. key is the COLUMN that identifies a row across passes, usually the source url or an
id; rows that have no value for it are kept and counted as unkeyed rather than dropped. Within a
matched row the LONGER value wins per field, which matters because a column can report 100% filled
while a third of it is "-" or a truncated stub. into saves the merge as a NEW result under that name
and returns its resultId, instead of returning the first 100 rows inline — use it for anything you
intend to export.

WHAT THE REPLY IS TELLING YOU. A page that yields nothing is reported in failed[] with the reason,
never as an empty success, and a truncated row group sets capped. If a site asks to verify a human,
every lane stops and walled comes back true — relay that, do not retry.

A "thin" page is not a blocked site, and page_harvest already knows the difference. A storefront, a
dashboard, any app that paints from JavaScript: the document is complete long before the fields
exist. page_harvest reads every page TWICE for exactly this reason — once at load, once after a
settle — and reports late: N for the pages that only answered on the second look, because one read
cannot tell a script-drawn page from a block. So:

- late high and rows present: the site is client-rendered. Nothing is wrong. It is slower.
- refused: true: the site is genuinely turning the run away. Every one of those pages was read
  twice before the claim was made, so refused is a claim you can pass on. Do not retry in a loop,
  and say so in your report.
- Rows missing but read high: that is YOUR SELECTOR, not the site. The commonest cause is a
  hashed classname (css-5wh65g, _1a2b3c) copied off the list page — those are per-component and
  differ on the record page. Anchor on data-testid, text, or structure instead, and confirm with
  page_state @dom(<css>) on ONE record page before harvesting hundreds.

Concluding "this site blocks batch scraping" and falling back to one page at a time has been
measured at 25+ calls and 50 minutes for zero rows. Check the three lines above first; the fallback
is almost never the answer, and if it truly is, say which of the three you ruled out.

READ fields BEFORE YOU DOCUMENT A COLUMN — see the section on naming what a field means. filled says
a column has values, distinct says how many different ones, and fieldsWhy covers the opposite
failure: filled but hollow, 1-2 characters per cell.

# When reading with page_state: store paths and pseudo-paths

page_state reads the app's OWN in-memory state — the store it renders the page FROM — instead of
the rendered page. DISCOVERY COMES FIRST, THEN A PATH: call with tabId alone and you get a map of
what state this app has (bootstrap globals like __INITIAL_STATE__ or __NEXT_DATA__, store-shaped
globals, React/Vue roots, the webpack module registry), each with a short shape summary and the
exact path prefix to read it with; call again with path set to one of those to read that slice.
There is no way to pass code — only a data path ("chats[0].id", "__INITIAL_STATE__.chats[0]",
"@stores.0.getState", "@mod[\"WAWebContactCollection\"].ContactCollection"), which is walked as
properties and never evaluated. Dots, [0] for an index, ["any key"] for a key that is not a plain
word.

Best for: virtualized and recycler lists, where the DOM holds the mounted window and can never hold
the list — and for any record whose fields the DOM simply omits. The measured example is a chat
list: a pinned list_extract returned 67 rows of a much longer list, and a phone number for UNSAVED
contacts only, because the markup carries no number for a contact the app has a name for. Its store
carries both. Not recommended for: anything the DOM already shows — list_extract is cheaper,
follows pages by itself and hands back a saved table you can export, and page_study will tell you
whether the DOM has the field at all. Reach for this when a run came back SHORT, or came back
missing a field the app plainly knows.

page_state with NO path is a census of the app's own globals, for finding a store worth reading. On a
page carrying analytics, wallet extensions and an ad stack it is enormous and answers nothing: one
measured reply enumerated a 7,977-key window object beside four crypto wallet providers. Use it when
you want the store, not as a general "what is here".

KEEPING A READ SMALL. fields reduces each row of a COLLECTION to just those field paths, e.g.
["__x_id.user","__x_name"]. It cuts the cost of a row enormously — a record with 46 fields costs
~120 of the reply's budget, five fields cost a fraction — which is what makes a long collection
readable in one call instead of thirty. It is ignored on a scalar or a single object, where it
would mean nothing. limit is entries returned per array or object (default 25, max 200) and the
TRUE total is always reported beside what was returned; offset reads past the first screenful, and
a reply that did not reach the end carries next — pass that back as offset. depth is how many
levels down to serialize (default 3, max 6); deeper is not always better: a store is an
application's whole memory, and a narrower path beats a deeper read. STRINGS ARE TRUNCATED at a few
hundred characters and neither limit nor offset raises it — they page collections, not text. For
long text read a narrower path, or read the rendered element with @dom / @html instead.

resolve IS A KEYED JOIN, for a collection whose rows only reference their records. Give {from,
into, fields}: from is the field path holding the key, into is the path of the collection to look
it up in, fields are the paths to merge in from the record found. Best for a list of opaque ids — a
chat app's group members are privacy identifiers, and the phone number lives in the contact
collection under that same key; a storefront's listing rows against its product or stock
collection. Without it, an agent makes one call per row and assembles the table itself. A key that
matches nothing sets @resolved:false on that row and is COUNTED in joinMisses — never dropped, so a
join that loses rows cannot look like a shorter list.

CREDENTIAL-SHAPED VALUES COME BACK MASKED BY DESIGN — cookies, bearer and session tokens, anything
under a key like auth/secret/session_id, and any JWT- or API-key-shaped string. The reply counts
them as redacted so you can see something was there; calling again will not unmask them, and
nothing you pass can. THE MASK IS KEYED ON THE NAME, SO IT OVER-CATCHES: a field called "author"
matches the auth prefix and comes back redacted although it holds no secret. The mask is shallow —
name the leaf you want ("...author.username") and it returns. If a plainly harmless field reads as
redacted, that is what happened; do not report the data as unavailable.

WHEN THE STORE IS UNREACHABLE, THE RENDERED TREE STILL CARRIES THE RECORDS. Frameworks hang their
own data off the DOM nodes: in React every element has __reactFiber$<key> and __reactProps$<key>,
where <key> is a per-document random suffix that changes for every tab. Discover it by asking for a
property that does not exist — the error lists the real ones — then read props directly, or walk
.return upward to the component that owns the whole collection, which is usually two or three
levels up and holds every row at once.

THE PSEUDO-PATHS READ THE RENDERED PAGE INSTEAD OF THE STORE, AND THE PARENTHESES ARE PART OF THE
SYNTAX. Bare "@dom" is walked as an ordinary property name, the window does not have it, and the
reply is NO_PATH — which reads exactly like "unsupported here". It is a typo, not a verdict, and
the server now refuses the bare form with the right spelling. These ride page_state rather than
being tools of their own, so a client holding a stale tool list can still reach them.

  @dom(<css>)                              rows of {text,label,href,img}; hidden:N means more exists
  @html(<css> :: <depth> :: <index>)       markup, scoped and stripped, TRUE length reported
  @map(<scope>)                            expands disclosures; splits links (href) from controls
  @collect(<rows> :: <hops> :: <up|down>)  harvests a recycler; ends dry | capped | limit
  @await(<css> :: <mode> :: <ms>)          waits for a condition; never throws on timeout
  @fetch(<url>)                            the PAGE makes a same-origin GET, in the person's session
  @net(<filter>) / @net() / @net(stop)     start, poll and end a network watch

"@dom(<css>)" returns the elements that selector matches, each with its text, label (aria-label or
title — often the ONLY name an icon has), href and img. No ranking, no list detection, no
re-detection — the three things that can each lose rows between what is on screen and what comes
back. Use it whenever a list_extract run returns fewer rows than you can see, or to read a header,
a title or any single element. IT NEVER RETURNS A CUSTOM ATTRIBUTE — text/label/href/img only. For
a data-* or any other attribute, read one element at a time with @html, or — if what you need is
that SAME attribute off EVERY row of a page reachable by a fresh URL load — use the page_harvest
single-page route described in the harvest section.

"@html(<css> :: <depth> :: <index>)" returns the markup itself, scoped and stripped, with the TRUE
length beside what was returned — reach for it the moment another tool refuses something you can
plainly see. WHEN YOU NEED THIS FOR MANY INDICES on the SAME already-loaded page, send those calls IN
PARALLEL, several to a turn, rather than one at a time waiting on each reply — the page is static
between reads so concurrent indices are safe, and this is the difference between one round trip and
dozens of sequential ones.

"@map(<scope>)" expands the disclosures inside scope and splits links (href) from controls
(button-routed), which is how a collapsed tree stops under-reporting.

"@collect(<row css> :: <hops> :: <up|down>)" harvests a recycler that never grows. It reads at
EVERY step and dedupes by row identity, because a virtualized list RECYCLES: the window slides and
the row count never grows, so "no new rows" does not mean the end. It drives the pane with wheel
and PageDown gestures — some apps load nothing at all from an assignment to scrollTop, and a run
that only assigns scrollTop reports honest, useless failure. Direction defaults to down; pass "up"
for older content. Read "ended" before believing a harvest finished: dry means the list really
ended, capped means it ran out of hops AND THERE IS MORE, limit means it hit the row cap. Never
report capped as complete. reply caps how many rows come BACK without capping how far it WALKS.
They used to be one number, so keeping a reply small also stopped the scrolling — and a second call
then ended limit with hopsRun:0, which reads exactly like the site refusing to load more. Set limit
for how far to go and reply for how much to see; the reply carries collected, shown and next.

"@await(<css> :: <mode> :: <ms>)" WAITS FOR A CONDITION INSTEAD OF GUESSING A DURATION, and it is
the answer to almost every "it worked that time" in this system. Modes: exists (default), gone,
still (the count stopped changing), or a NUMBER meaning at least that many matched. Reach for "gone"
on a spinner or skeleton wherever one exists — waiting for CONTENT cannot tell a slow page from an
empty one, but a spinner leaving is unambiguous. Reach for "still" when a grid paints in pieces,
which is what makes a first read say 14 on a page holding 54. It NEVER throws on timeout: ok:false
comes back with matched, peak and waitedMs, because how many arrived and which way the number was
moving is what tells you whether to wait longer or stop. page_harvest takes the same grammar as its
awaitFor, applied per page.

"@fetch(<url>)" ASKS THE PAGE TO MAKE A REQUEST instead of you opening a tab for it — SAME ORIGIN
as the tab, GET only, the person's own session. THIS IS THE LEVER WHEN A DETAILS PASS IS SLOW.
Measured on shopee.com.br: one tab per product cost 15-20s each, so 120 products ran for most of an
hour and finished 48 — because a client-rendered product page spends nearly all of that rendering
images and trackers around ONE json it fetched. Fetch that json and a record costs a fraction of a
second. It also reaches what an address bar cannot: a site that signs its own requests (Shopee
hooks fetch and XHR with an anti-crawler SDK and answers a bare navigation with error 90309999)
signs this one too, because it runs IN the page. Find the url once with tab_here({network:"*"}),
see which response held what you want, then replace the per-record navigation with @fetch on that
url with the id substituted. Cross-origin is refused on purpose — the consent the person gave is
for the site in front of them.

WATCH THE NETWORK with "@net(...)". path "@net(<url substring>)" starts a watch on the tab that
OUTLIVES the call, "@net(*)" watches EVERY response — images, fonts, stylesheets and documents as
well as the data calls — "@net()" polls what has arrived SINCE THE LAST POLL, and "@net(stop)" ends
it. Use it when the data appears because of something you are about to do — a filter click, a
drawer, a search box, a scroll — rather than on page load: start the watch FIRST, then do the thing
with any tool, then poll. A watch cannot recover requests the page already made, so starting one
after the fact returns nothing. It holds a debugger on the tab (yellow bar, and DevTools cannot be
open on it) until stopped, so stop when done.

WHAT A POLL RETURNS, and why it is three fields rather than one: responses are the ones whose body
was read and shaped into $. paths — hand those to page_harvest({network}) or page_grow({network,
rows}). network NAMES every response with url, mime, status, kind and bytes, so a page that fetched
290 things is not reported as the 12 that happened to be JSON. kinds counts them by resource type,
which is the same grouping the browser's own network panel puts on its filter buttons. Bodies are
read only for the data-shaped ones because a decoded image is bytes you cannot use — to read a
specific one, name its url with "@net(<substring>)".

tab_here network IS THE SAME CAPTURE, TAKEN DURING A NAVIGATION. START WITH "*" ON ANY SITE YOU DO
NOT ALREADY KNOW. That is DISCOVERY: it maps every response the page fetched on load — url, mime,
size, and for JSON the list of paths inside it with types, array lengths and a sample of each string
— and returns NO bodies. From that map you get both things page_harvest needs: which url substring
to filter on, and the exact $. paths to name as fields. Without it you would be guessing the API
host and the payload shape, which is why capture alone is not enough. With a substring instead, the
debugger is attached for the duration of the page load and EVERY matching response is returned in a
network array alongside the normal arrived/url fields. Use this when the data you want lives in an
API response the page fetches on load (GraphQL, REST) and is not yet in the DOM. Example:
"gql.tokopedia.com" captures the product-detail GQL reply before React renders it — navigate + read
in one call instead of two. It attaches and detaches the debugger automatically and shows a brief
yellow bar on the tab.

WHAT THESE PATHS COST, because two of them can empty a context in one call.

page_study FIRST on a page you have not read. It names the repeating container for a couple of
hundred bytes. @html on a container you guessed at prints that container: measured, @html on a search
result grid returned 55,803 characters and showed 20,000 of them, nearly all framework attributes,
where page_study would have named the row selector outright. @html is for ONE node you have already
identified, at the shallowest depth that answers the question -- and list_extract is what turns a
hundred of those into a table.

A URL FILTER MATCHES ASSETS TOO, so pick a fragment only a data call can have. Measured twice in one
session, ~24,000 characters each: @net("review") matched the site's STYLESHEET, whose bundle name
contains "reviews-section", and @net("api/v3/ajax") matched its recommendations spec. Neither had
anything to do with reviews. A filter is a substring of the whole url, not a category — ask for
"cdn.example.com" and you get every response from it, pictures included. Prefer a path fragment the
data endpoint owns, and read the mime on what comes back before reading the body.

@net(<filter>) BEFORE @net(*). The unfiltered watch keeps every response, and on a heavy app the
reply cannot be returned at all -- measured, 120,979 bytes against a 37,500 limit, so nothing came
back. Name the filter from the request the app makes to page ITSELF: infinite scroll fetches each
next batch from one url shape, and watching only that shape turns the whole problem into one readable
response. * is for discovery on a light page, never a first move on an application.

AND WHAT AN IMG SRC IN A GRID ACTUALLY IS. In a search or gallery grid it is almost always a preview
-- a hundred pixels wide, served off the search engine's own cdn, not the file anyone wanted. The
original usually lives in the batch payload @net just caught, joined to its row by whatever id the
markup carries. Check a dimension before promising someone files.

ROWS FROM THE PSEUDO-PATHS COME BACK IN THE REPLY ONLY. They carry no resultId, so results
action:"get" and action:"export" cannot reach them — if the person needs a file, that is
list_extract's job, not this one.

# When a list will not grow, or the content is history

page_grow presses a load-more control, or scrolls — the window, or ONE scrollable container — and
reports how the list changed. This is the only honest way to answer does-this-load-more: a button
saying More may do nothing, and a page with no button at all may grow on scroll. It CHANGES THE
PAGE, unlike page_study. grew:false with by:0 is a real answer, not a failure — and a selector that
matches nothing fails naming the selector rather than silently scrolling the window.

A BACKGROUND TAB LOADS NOTHING. Chrome stops animation frames in a tab nobody is looking at, and a
lazy list rides them — so grew:false on a background tab is not an answer about the site.
Measured: scrollTop moved 572 -> 3136 across twelve hops with fresh:0 every time, and the same page
loaded fine when the tab was focused. The reply now says when this is the case: page.hidden:true or
page.frames:false. When you see either, the count and the grew:false are about the tab, not the
site.

THE SELECTOR TAKES TWO KINDS OF TARGET, told apart by what it points at: a control from page_study
growth.candidates gets PRESSED; a scrollable container — one of page_study lists[].selector, or any
CSS selector of the pane — passed with scroll:true gets scrolled to ITS OWN bottom instead of the
window's. Use the container form whenever the page has more than one scrollable region (a sidebar
list beside an open conversation, a rail beside results), because scrolling the window there moves
the pane you did NOT mean. A container-targeted grow reports containerRows before/after beside the
page-wide recordLinks count: rows that carry no links — a chat list is divs all the way down — read
as 0 record links forever, so containerRows is the growth signal to trust there, and a scrolled
{from,to,max} triple says whether the pane even moved.

IT REPORTS WHETHER THE LIST IS REPEATING ITSELF: duplicates gives domRows, unique (counted by the
same row identity the export uses), duplicates, loopingPct and uniqueGained. A feed can grow
forever without ever adding a row you do not already hold — measured, one marketplace re-serves
the same ~284 products until the DOM holds 2,000 — so uniqueGained, not domRows, is what the table
will contain. Hops stop for two DIFFERENT reasons and stoppedEarly says which: nothing arriving at
all, or rows arriving that are all rows the list already had. hops is how many times to scroll and
wait, for content fetched a page at a time (default 1, max 50); it stops early when two hops in a
row bring nothing, and reports perHop so you can see what each one added. waitMs is how long to
wait for new rows (default 2500, max 8000).

FEED MODE — pass network and rows.at and page_grow stops reading the DOM at all: it scrolls one
step, reads the request THAT SCROLL CAUSED, takes the items straight out of the JSON, and repeats
until the site stops returning new ones. Use it for an infinite list, a VIRTUALIZED list (the DOM
only ever holds a screenful, so a DOM read loses rows as they unmount), or any feed where a
reply-size budget caps what one read can return. The site paginates itself — no cursor or offset to
work out — and "no new items" is the list ENDING, said by the site itself. Rows accumulate in the
browser. NOTE the first screenful is usually already in the document and NOT in the capture, so
read that from the page and treat this as what follows. rows is {at: "$..items", fields: {name:
"$.title"}}: at is a $. path to the ARRAY of items in the response, fields are paths inside ONE
item. Find the network substring with tab_here({network:"*"}) on that page.

READING HISTORY. direction:"up" is for OLDER content. A conversation loads its history upward — the
newest message is already at the bottom, so scrolling down there reports grew:false truthfully and
uselessly. Ten hops up a channel is ten pages of history. But do not scroll up from the bottom to
reach the beginning. Jump to the boundary — the app's own oldest-first URL (a trailing /0 on a chat
channel, ?page=1, sort=oldest) — then @collect DOWNWARD, which is the direction that pages
cheaply. Verified: a boundary jump reached a channel's true first message from 2019 in one
navigation.

For a RECENT window the opposite holds: you already land on the newest item, so
@collect(... :: ... :: up) and stop as soon as timestamps leave your window. Choosing the wrong end
turns a few hops into years of paging.

THE OTHER MODES. mode:"walk" presses one thing and reports what CHANGED — for an app that swaps
content without loading a document; it cannot follow an ordinary link, because a real navigation
destroys the frame it runs in (use tab_here for that). text is what the person would CLICK, in
their words: prefer it over a selector, it survives a redesign that renames every class. back:true
returns to the page the walk started from. A walk that stopped early reports a next cursor; pass it
back as offset and it resumes rather than starting over. mode:"explore" opens what is collapsed
and reports what appeared.

fill TYPES TEXT into the field named by selector — the third verb beside pressing and choosing, and
the one that was missing. A list reachable only through a filter, a date range or a search box the
site does not expose as a URL could not be reached at all without it. REFUSED for a password field
(that is the person's identity, not page data — if a sign-in is in the way, say so and let THEM do
it), for a hidden input (the page's own token or state blob), and for anything that looks like
payment, including any field the page itself marks autocomplete="cc-*". It does NOT submit: filling
and sending are separate decisions, so press the form's control afterwards with mode:"walk". The
value is read BACK and returned, because a masked or length-capped field can hold something other
than what you sent.

choose PICKS AN OPTION IN A <select>, by the option's visible words — "Most Recent", "Highest
rated", "100 per page". A <select> does not answer a click, so this is the only way to reach content
that exists only behind a chosen option: sort orders, filter selects, per-page counts, date ranges,
locale and currency. THE DEFAULT ORDER OF A REVIEW OR RESULT LIST IS ALMOST NEVER DATE ORDER — it
is relevance or "most helpful" — so "the 3 latest" read off the page as it loads is usually wrong;
choose the date option first. It finds the select BY the option, so no selector is needed unless
the page carries several with overlapping names. Read changed: false means the option was set and
the page looked identical afterwards, which is either a slow re-render (raise waitMs) or a widget
that ignores the event — do not report the rows as re-sorted until it is true. Pass read with the
row selector and the reply carries the rows themselves, which is how you verify the order actually
changed. Unlike a press this does NOT return to where it started: the point of choosing is that the
next read sees the new order.

# When a run came back short, or a field is missing

NEITHER LAYER IS COMPLETE ALONE. The rendered page and the app's store each hold things the other
omits. Measured on a chat app: the store held only opaque privacy identifiers where a phone number
belonged, while the page displayed the real numbers the app had resolved for display. The reverse
is just as common — a virtualized list can never hold more than the mounted window, and its store
holds all of it.

So never conclude a field is unavailable after reading ONE layer. Check the other, and say which
you checked. If a state read lacks what the app plainly shows, re-read the DOM with page_study and
list_extract before reporting it absent — and the reverse when the DOM gives a truncated or
link-less list.

list_extract MUST FIRST AGREE THAT SOMETHING IS A LIST, and when it disagrees it does not refuse —
it returns a little. Measured: an icon rail of 23 entries, which page_study itself counted as 23
rows, came back as ONE row; a chat log came back as sentence fragments carrying no author and no
timestamp. Neither is a broken page. Rows that are not uniform — icons, message groups, date
dividers — are not what this tool is for. When the count coming back is far below what is on
screen, stop growing it and read the container with @dom(<css>) via page_state instead.

list_extract returns a runId IMMEDIATELY — the work continues in the background and can take
minutes. Poll results action:"status". Never assume it finished. WHEN THE PAGE HOLDS MORE THAN ONE
SCROLLABLE REGION — a chat app's sidebar list beside an open conversation, a filter rail beside
results — the automatic ranking can grow and read the wrong one: pass selector with the CSS
selector of the container the person actually means (from page_study lists[].selector, or point at
the pane itself) and the run grows and reads THAT container, never the auto-pick; the pinned choice
survives the run's internal re-detections. If the selector matches nothing the call fails naming it
instead of silently falling back — a silent fallback to the wrong pane is the bug this parameter
exists to prevent.

THE PAGER IS A JUDGMENT, AND IT CAN BE OVERRULED. A walk that ended "no further pages" may have
looked straight at a link called "next" and rejected it because its URL carried no page number it
could read. A negative pager verdict now shows its work — saw (what it measured), nearMisses (up to
five controls that almost qualified, each with the reason it was rejected) and override — and a
finished walk carries the same nearMisses when it ended for want of a next page. If one of them IS
the next page, run it again with list_extract next: a CSS selector OR an href for the next-page
control. It outranks every guess. A finished walk also carries growable {selector, label} when a
load-more style control was on the page and was not pressed: the list is longer than what was read —
page_grow that selector until grew:false, then extract again.

On X (Twitter) and other virtualized feeds a DOM read returns single digits and looks like the end
of the feed; see the X section for the store path that holds the whole timeline.

# When the site pushes back

A CHECK IS A STATUS, NOT A FAILURE. results action:"status" reports running, reading_records,
waiting_for_user, done or failed. waiting_for_user means the SITE asked the person to prove they
are human: relay that and wait — the run carries on by itself once they clear it. Do NOT retry and
do NOT start another run, because retrying is what turns a check into a block. The same goes for
current_page reporting a challenge, and for page_harvest coming back walled:true: every lane has
already stopped.

After a captcha, come back gentler: 2-3 lanes, and retryOf so only the unfinished pages are
touched. The endpoint-scoped challenge — the page fine, ONE section empty on record after record —
is rule 9 in the section on loaded versus ready; a thin page that is NOT a block is in the harvest
section. Work through those before writing "the site blocks scraping".

# When you are working in the person's browser

tab_here newTab:true creates a tab that NOTHING will ever close by itself, and tabs opened this way
are not tracked for cleanup. Every call leaves litter the person clears by hand. It is for "open
this page for them", or for when there is no tab to move — not for navigation. tab_here close:true
CLOSES a tab instead of navigating it: the opposite of newTab, and the thing to do when a pass
ends. Lanes become tabs in the person's own window, and one run left 23 of them behind because
nothing could tidy up. close is refused for the connection window (the socket every session talks
through) and for a tab the person has PINNED.

To visit many things that are pressable rather than linked, use page_grow mode:"walk": it presses
each in place and returns via history.back or Escape, leaving their tab where they left it. For
ordinary links it is tab_here, one URL at a time, or page_harvest for the whole set at once.

current_page follows the person's ACTIVE tab unless they pinned one in the HoloScrape panel. IT
MOVES WHEN THEY BROWSE. Unpinned, it is a live reading of wherever they are now, not a handle on
the page you started from — a run that keeps calling it can silently change subject when the
person opens something else. Capture the tabId ONCE and pass it explicitly for the rest of the run.

A HELD tabId IS NOT A DURABLE HANDLE EITHER. It is valid only while that tab is open, and a tab
you opened is one the person may close the moment they notice it — at which point every call
using it fails with "there is no tab" and whatever was in flight stops there. Measured twice in
one session, both times on scratch tabs that had just been tidied away. The refusal now lists the
tabs that ARE open and names the pinned one.

So for a run of any length, ASK THEM TO PIN the tab in the HoloScrape panel and use current_page.
A pinned tab is one they chose to keep; a tabId you are holding is one they did not. If a call
does fail this way, tabs_list re-establishes where things are — and a page_grow mode:"walk" resumes from its
offset rather than starting over.

Pairing is the consent: any http or https page in this browser can be read, except the restricted
hosts no click may open. An empty new tab is not a page yet — point it at a URL.

# When the person's browser must not be touched: the companion

There is a second browser: a headless Chromium the server launches beside itself, with a copy of
the extension and NOTHING of the person's — no cookies, no logins, no tabs, and no cookie ever
crosses in either direction. It exists for one reason: a page that must be read while the person's
Chrome cannot or must not be used for it.

HOW. Every tool that takes a tab or a url also takes where:"companion" — tab_here, page_harvest,
list_extract, page_study, page_grow, page_state. tab_here {url, newTab:true, where:"companion"}
opens the page there and returns a tabId; ids in a reply always ROUTE TO THE BROWSER THAT MINTED
THEM, so a companion tabId, runId or resultId needs no where on later calls. results is the same
in both.

CHOOSE IT YOURSELF in three situations. (1) The person says their browser or a tab is not to be
touched — "I'm debugging in this tab", "leave my tabs alone", "don't open anything". (2) There is
no tab to start from: the list they mean is not open in their Chrome (tabs_list shows nothing
matching), and the job is public pages you can name by URL. (3) A read in their Chrome came back
with page.frames:false or lanes.held:false — the tab or lanes were not painting — and the site is
public. In all three, do not ask the person to open or arrange tabs; open the page in the companion.

IT STEPS IN ON ITS OWN too. When a lane in the person's Chrome cannot take the debugger hold
(DevTools open on the tab, a policy, another extension), the server re-runs that call in the
companion and the reply carries switched:{from:"person", to:"companion", why}. Read why; it is a
diagnosis of their browser, not of the site.

WHAT IT CANNOT DO. It has no session, so a page that needs a login, a member price, a private
inbox, a feed shaped by an account, or the person's IP-locked content is out of reach. A login
bounce or a challenge there hands the job BACK to the person's browser automatically (switched
to:"person", why names the bounce) — do not retry the companion on that site, and never try to
move cookies across; that is refused by design. Shopee, Gmail, X timelines, LinkedIn: person's
browser. Alibaba too: measured 2026-09-23, its search served a puzzle to the companion on the
first load ("Captcha Interception") while the person's Chrome got 47 rows. Amazon, eBay, Maps,
docs, most catalogues: companion is fine.

IF IT IS NOT INSTALLED the reply says so in one sentence and names the fix:
npx holoscrape-mcp --install-browser (downloads Chromium for Testing, ~150 MB, once). Relay
that sentence to the person; nothing else can install it. HOLOSCRAPE_COMPANION=0 in the server's
env turns the companion off entirely, in which case where:"companion" is refused and only the
person's browser answers.

# When you name what a field means

A FIELD YOU NAMED IS A CLAIM, AND CLAIMS GET TESTED. filled: 66 of 70 says a column has values. It
does not say they are values OF THE ROW. A column that is populated and misidentified is the most
expensive answer you can hand anyone, because unlike an empty one it reads as verified.

Measured, on a marketplace: a rating field asked for per listing came back filled 66 of 70 and was
reported as each book's rating. It was the SHOP's rating. The proof was already in the same table —
one row read "4 out of 5 stars" while carrying three five-star reviews of its own — and no tool said
otherwise, because no tool can. Fifty pages had answered with five different values.

So before you write down what a field means, falsify it against data you already hold:

  read distinct beside filled. Fifty rows and five distinct values is a property of something
    COARSER than the row — the shop, the page, the whole site — mislabelled as a property of it
  cross-check one row against its own contents. A per-item rating cannot read 4 stars on an item
    whose only reviews are 5, 5 and 5
  ask what the site is actually showing. A marketplace usually shows the SELLER's score beside a
    listing, and a listing with no reviews of its own still displays a number

And say which it is. "Rating (shop-level; this listing has no reviews of its own)" is an answer;
"Rating: 4.9" over the same data is a wrong one that nobody can see is wrong.

A NULL GETS SCRUTINISED BECAUSE IT LOOKS LIKE FAILURE. A populated column gets trusted because it
looks like success. Spend the check on the second one. fieldsWhy covers the opposite failure —
filled but hollow, 1-2 characters per cell.

WHAT A MARKETPLACE SEARCH ACTUALLY RETURNS. Two things it is not, and both have shipped into answers:

NOT THE THING YOU ASKED FOR. A search for "psychology book" returned journals, planners, printable
worksheets, PDF bundles, a study guide, brain-shaped bookends and a neon sign. Measured on one run:
14 of 50 delivered "books" were not books; on another, 424 cards held 124 book-shaped listings.
Filter to what was asked for, and report how many you dropped and why — a filtered 50 with the count
of discards is honest; an unfiltered 50 is a different question answered.

NOT RANKED THE WAY "TOP" IMPLIES. The first slots are usually PAID. Cards carry it in their own text
("Ad by", "Ad from shop"), so it costs nothing to label them — and "top 50" over an ad-seeded
relevance order, unlabelled, claims an authority the page never offered.

WHICH APP IS RENDERING, AND ON A PAGE WHERE IT IS AWAKE. Reviews, ratings, chat, search on a commerce
site are usually a third-party widget, and naming the wrong one sends the whole run down a dead end.
Two ways to get it wrong, both measured in one day:

  a global's NAME is not proof it is doing the work. A store carried klaviyoReviewsProductDesignMode
    and the reviews were rendered by Bazaarvoice; the Klaviyo app was merely installed.
  STRING FREQUENCY is not proof either. The same store's product markup mentioned one vendor 17 times
    and another once — and the one mentioned once was the one drawing the reviews.

What settles it is the MARKUP AROUND THE CONTENT: read the container the reviews actually live in and
look at its id and classes. A vendor prefix on the element holding the data is the answer; a script
tag in the head is an installation.

AND PROBE AN ITEM THAT HAS THE THING. Both mistakes above happened on pages where the widget was
inert — one product had no reviews at all, so every review global read null and the machinery never
started. Pick the item with the HIGHEST count of whatever you are after, because that is the page
where the code is actually running. On a catalogue that means sorting by review count first, not
taking the first handle in the list.

# When deciding between the browser and a direct fetch

DOES THE ANSWER DEPEND ON WHO IS ASKING? That is the whole question, and it decides the route. Not
"inside or outside the browser" — an earlier version of this section said outside fetches were
simply wrong, and that was too broad by half. It cost speed for nothing on every public endpoint.

IF THE ANSWER DEPENDS ON THE ASKER, USE THE BROWSER. Logged-in pages, personalised feeds, prices in
someone's currency, anything behind consent, anything behind a bot wall. An outside request carries
none of the person's cookies, none of their consent state, and a user agent the site has never seen,
so it is answered by a DIFFERENT page: a search engine hands it a consent wall, a marketplace hands
it a login, some hand back a stripped shell that looks real.

IF IT DOES NOT, FETCH IT DIRECTLY AND SAVE THE ROUND TRIP. A public data endpoint answers everyone
the same. Measured: a storefront's own /products.json returned its entire 148-product catalogue in
one request, faster than any route through a tab, and /collections.json listed every collection
beside it. Reaching for a browser there is ceremony.

THE TRAP IS THE SAME EITHER WAY, AND IT IS ABOUT WHAT AN EMPTY ANSWER MEANS. Measured on an image
search: a session grepped the curl'd HTML for the pattern carrying full-resolution urls, got zero
matches, and concluded the urls were not in the page. They were in the page — in the one the browser
had, which was never looked at. A headless probe of the same url landed on a bot wall and found one
file. So a zero from an outside fetch is NOT evidence of absence. Confirm it against what the browser
holds -- page_state "@html(<css>)" for markup, "@net(<filter>)" for what the page fetched -- before
you write down that something is not there.

# When saving rows and files

THE RUN IS NOT THE TABLE. list_extract and a backgrounded page_harvest return a runId that is still
working, and only a finished run has a resultId. So: results action:"status" while it runs, then
"get", "export" or saveTo once it is done. stop ends a run early; what it already read is kept.
list shows tables already extracted and saved in this browser, newest first — check there before
scraping something again.

get returns rows and column names — data, never HTML — limit rows at a time (default 100, max
1000), optionally only some columns. Large tables are truncated and the reply gives the true total.
offset is where to start, for taking a big table a page at a time: the reply carries nextOffset
and more whenever rows remain — pass nextOffset back and repeat until truncated is false. Without
it a table larger than one reply could be started and never finished.

FOR THE WHOLE TABLE, DO NOT PAGE IT THROUGH THE CONVERSATION. Two routes write a file instead:
- saveTo: "/absolute/path.csv" (or .json), with action get or export. The SERVER writes every row
  to that path, pulling the table from the browser a page at a time, and replies {path, rows,
  bytes} — no row enters a reply, and you read the file with your own tools. The path must be
  absolute, end in .csv or .json, sit under the person's home or a temp directory (not inside a
  dot-directory), and must not already exist: it never overwrites. columns narrows the file the
  same way it narrows a reply. A run that fails part-way leaves no file behind.
- export writes a CSV into the person's Downloads and returns the filename. Use it when the PERSON
  wants the file; use saveTo when YOU need to read it.
A file has no reply-size limit.

download saves the ASSETS a deep scan found (images, video, audio) as FILES in the person's
Downloads. The pictures never travel through the conversation: bytes in a reply would cost tens of
megabytes for one page, and handing you urls to fetch yourself drops the person's cookies so
anything behind a login answers with a login page. The browser downloads them signed in, as them.
THIS ONE NEEDS A HUMAN. Every call raises a card in the HoloScrape side panel naming the count and
the site, and nothing is written until a person presses Save. There is no way to pre-authorise it
and origin consent does not cover it. Two refusals to relay rather than retry: the panel is not
open (nobody to ask — the person opens it), and declined (do NOT ask again straight away; a prompt
asked twice is a prompt clicked without reading). Assets exist in a result only if the person ran a
deep scan in the panel — there is no call that starts one. If a result holds rows but no assets the
reply says so; use export for rows. types saves just those kinds ("image", "video", "audio"); a kind
that is not in the result is named back to you with what is, rather than answered with a silent
zero. max caps how many files (default 500, max 2000), and the person sees that number on the card
they approve.

OR pass urls and skip the result entirely: any addresses you already hold — a harvested column, a
@net payload, an API response — can be saved the same way, behind the same press. http(s) only; a
data: or blob: url cannot be fetched on your behalf. The card names the DISTINCT HOSTS as well as
the count, because a list you assembled can span many sites. Use this rather than fetching the urls
yourself: the browser downloads them signed in as the person, so anything behind a login arrives
intact instead of as a saved login page.

A REPLY TOO BIG TO RETURN IS WRITTEN TO DISK, NOT LOST. Over about 15,000 tokens the server refuses
with REPLY_TOO_BIG, names the fields on the first row and the lever that shrinks the call (fields
on page_state, columns on results get), and spools the whole answer plus chunk files and a row
index to a temp directory. Open the file, or ask for less; do not repeat the same call — the third
identical failing call is refused without asking the browser.

# X (Twitter): the store, and video files

X's timeline mounts about 9 <article> cells no matter how far you scroll, so any DOM read of a feed
returns single digits and looks like the end of the feed. It is the DOM ceiling, not the end — read
the store. page_state path "scroller.context.store.getState.entities.tweets.entities" held 284
complete tweets at the same moment, keyed by id, each with full text, engagement counts and media —
including video_info.variants[], a list of {bitrate, content_type, url} where the video/mp4 entries
are the real, complete files, which the DOM never carries. Sort by bitrate and take the top one.
"...entities.users.entities[<id>]" beside it resolves authors (name, screen_name, followers_count,
is_blue_verified) without a second pass. Unlike the DOM it keeps what scrolled out of view. With an
X tab already open this is the cheapest route to the mp4 urls: no network call and no lookup at all.

resolve_x_video turns ONE post into a real, plain, third-party-fetchable video/mp4 url through X's
own public syndication API (unauthenticated, the same endpoint its oEmbed embeds use), which
returns the highest-bitrate whole file rather than whatever fragment or session-bound url happened
to be captured. IT RUNS ENTIRELY ON THIS MACHINE: no browser tab, no pairing, no origin consent, and
it works even with Chrome closed — one HTTPS call to a public X endpoint. Give EITHER url (an x.com
or twitter.com post address — the id is read out of it) or statusId (the bare numeric id). Add
videoId only to disambiguate a tweet carrying more than one video (a quote-post keeping its own
clip alongside the quoted post's) — pull it from a captured asset url's amplify_video/<id>/ or
ext_tw_video/<id>/ segment; omitted, the highest-bitrate video on the tweet wins. It returns {url,
statusId} on success. A tweet with no video, a bad id, or a lookup failure comes back {url: null,
why} rather than throwing — "no video here" is an ordinary answer, not an error to retry. Use it
when there is no open tab holding the post, or the post was never loaded into that store.

THE RETURNED URL NEEDS NO COOKIES OR SESSION, SO IT CAN BE FETCHED DIRECTLY — curl, a script,
anything outside the browser — instead of routing it through results action:"download". That
action's human-approval gate exists because most assets need the person's own signed-in browser to
fetch; a resolved X video needs none of that. Bulk-finding posts to resolve: on a timeline, a DOM
read for article:has(video) a[href*="/status/"] (via page_state @dom(...)) after scrolling beats
parsing the timeline's own GraphQL response — the feed only refetches once you have scrolled to
the true bottom of what is already rendered, which a few scroll-hops rarely reach. Whatever you
fetch yourself, confirm it landed — check the file type and a real byte size — rather than trusting
a 200 or an exit code alone; a session-bound or truncated response can still return success.

GETTING THE ACTUAL FILES, three paths, cheapest first: (1) a deep scan found them — results
action:"download" resolves each one the same way automatically before saving, whenever a scan
learned the post's id, and reports resolvedX counting how many it had to rescue (nothing to ask
for; it just means the file that landed is not necessarily the url the scan reported); (2) you hold
post urls or ids — call resolve_x_video per post and fetch the returned urls yourself, no browser
and no approval gate needed because the resolved url is public; (3) you hold urls from anywhere
and want them saved by the person's own signed-in browser — results action:"download" with urls.

WHY THE CAPTURED URL IS USUALLY NOT THE FILE, so you recognise it: an amplify_video url is often
session-bound, and X delivers video as CMAF/DASH fragments. A fragment url carries an extra "/0/0/"
segment — /vid/avc1/0/0/<W>x<H>/<name>.mp4 is a ~900-byte fragment, while
/vid/avc1/<W>x<H>/<name>.mp4 is the whole clip (6.6MB in the measured pair). A
/aud/mp4a/0/0/<bitrate>/ url is the separate AUDIO track, not a video at all. Any sub-kilobyte
"video" is one of these, never a clip — treat a byte size under a few KB as proof the resolve did
not happen rather than as a small file.

# Triage before you navigate

Opening every item to discover which ones changed is almost always avoidable. Many systems encode
creation time inside the identifier — snowflakes ((id >> shift) + epoch), MongoDB ObjectIds (first
4 bytes, unix seconds), UUIDv7 (first 48 bits, ms), ULIDs, KSUIDs. A list view usually carries a
last-item id per row. Decode it and you know what is stale WITHOUT a single navigation.

Treat a decoded last-item id as an UPPER BOUND on activity, not proof of it: the item it names may
have been deleted. Safe for excluding dormant rows; never for asserting a row is live.

# When a failure looks like your bug and is not

- After the extension is reloaded, tabs that were already open hold a DEAD engine and simply hang.
  Every mysterious timeout right after a reload is this: if a tab that was working starts hanging
  on every call, the extension was probably reloaded underneath it. Open a fresh tab.
- A bare container URL may redirect to a login page where the fully-qualified one does not. Use the
  deepest URL you have rather than the tidiest.
- "No browser connected" is almost never about pairing. Every agent session runs its own server, and
  the extension attaches to all of them; if you are told a PEER has the browser, the message says so
  and says what to do. Do not go looking through process lists, do not ask for a re-pair, and do not
  start killing processes — sessions have lost entire hours to that, and the answer is usually the
  person needs to reload the extension once. Read the failure you were given before investigating.
- "this browser does not know how to ..." is a VERSION SKEW, not a missing feature: the server is an
  npm package and the extension updates only when its owner reloads it. Ask the person to reload the
  HoloScrape extension, then try again. Do not hand-roll the capability.
- "Unknown argument for tool ..." means a parameter name the tool does not define; nothing was sent
  to the browser. The message lists the accepted names. Fix the name — do not drop the argument and
  carry on, because the call without it is usually a different, larger call.
- "This exact call has already failed N times" means the refusal is about the REQUEST, not the
  browser. Change an argument: narrow the selector, project with fields, ask for fewer rows.

# Reporting

Say what you actually checked. "This field is not available" after reading one layer, or "the list
ended" on a capped harvest, is worse than no answer: it closes a question that was still open. When
a run comes back short, the honest report names which layer was read, what ended said, what the
page header said about the tab it was read in, and what you have not tried yet.
