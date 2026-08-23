// The operating manual, served to the client on `initialize` as MCP's `instructions`.
//
// WHY THIS EXISTS AS A STRING IN THE PACKAGE AND NOT AS A FILE IN THE REPO. Everything an agent
// will ever know about this server arrives over the wire: the tool list, the parameter schemas,
// and this. Someone running `npx -y holoscrape-mcp` on a machine that has never seen the source
// gets no README, no design notes, and none of the hard-won operational facts below. Written in a
// repo doc they teach the author alone. Written here they travel.
//
// The facts below were each paid for by a failed session. They are kept in the order an agent
// meets them, not in order of importance.

export const INSTRUCTIONS = `HoloScrape drives the person's OWN already-signed-in Chrome. There is
no cloud browser and no separate profile: every page you read is the page they would see, with
their logins and their IP. Treat their browser as someone's desk you are working at.

# Cheapest thing that answers the question

ASK WHAT THE LIST PAGE ALREADY SHOWS BEFORE OPENING ANYTHING. Most asks are answered by the rows in
front of you, and the difference is not small:

  on this page, no page opens   list_extract / page_state "@dom(<row css>)"    seconds
  one page per record           page_harvest                                  minutes

Measured: 95 marketplace products took 6m38s through page_harvest and would have been about 15
seconds off the list — because name, price, rating and seller were on the cards all along. Only what
is NOT on the list justifies opening pages: a full description, sku, stock, variants, specs, reviews.

When you do open pages, the cost is pages x per-page-load / lanes. Lanes divide it up to about
five and then stop helping — eight is measurably slower and loses rows. On a site that has shown a
captcha, fewer lanes is both safer AND more accurate: measured, 3 lanes returned 0 failures on 180
pages where 5 lanes returned 96 thin on 625.

# Which tool

EVERY TOOL NAMED IN THIS DOCUMENT EXISTS ON THIS SERVER. Your client may have shown you only a few
of the twenty-one — schemas are fetched on demand, and a keyword search returns the top matches, not
the set. So the tools you were handed are NOT the tools there are. Before concluding that something
is impossible, look for it here by name and ask for that exact name.

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
- current_page — start here for "I have a page open, scrape it".
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

# PATHS SURVIVE A STALE CLIENT; TOOL NAMES DO NOT

Clients cache the tool list when the session starts. A tool added since then is INVISIBLE — calling
it fails as "no such tool", which is indistinguishable from a feature that was never built. Paths on
an existing tool have no such problem, which is why the read primitives below ride page_state.

If a capability you were told exists appears to be missing, suspect the cached list before
concluding it is absent, and say so rather than silently working around it. The workaround is
usually an order of magnitude more expensive: one session hand-walked document.body.children[N]
for hours to rebuild what @dom(<css>) returns in a single call.

# The pseudo-paths, and the mistake everyone makes

THE PARENTHESES ARE PART OF THE SYNTAX. Bare "@dom" is walked as an ordinary property name, the
window does not have it, and the reply is NO_PATH — which reads exactly like "unsupported here".
It is a typo, not a verdict.

  @dom(<css>)                              rows of {text,label,href,img}; hidden:N means more exists
  @html(<css> :: <depth> :: <index>)       markup, scoped and stripped, TRUE length reported
  @map(<scope>)                            expands disclosures; splits links (href) from controls
  @collect(<rows> :: <hops> :: <up|down>)  harvests a recycler; ends dry | capped | limit

@collect reads at EVERY step and dedupes by row identity, because a virtualized list RECYCLES: the
window slides and the row count never grows, so "no new rows" does not mean the end. It drives the
pane with wheel and PageDown gestures — some apps load nothing at all from an assignment to
scrollTop, and a run that only assigns scrollTop reports honest, useless failure.

WHAT THESE PATHS COST, because two of them can empty a context in one call.

page_study FIRST on a page you have not read. It names the repeating container for a couple of
hundred bytes. @html on a container you guessed at prints that container: measured, @html on a search
result grid returned 55,803 characters and showed 20,000 of them, nearly all framework attributes,
where page_study would have named the row selector outright. @html is for ONE node you have already
identified, at the shallowest depth that answers the question -- and list_extract is what turns a
hundred of those into a table.

page_state with NO path is a census of the app's own globals, for finding a store worth reading. On a
page carrying analytics, wallet extensions and an ad stack it is enormous and answers nothing: one
measured reply enumerated a 7,977-key window object beside four crypto wallet providers. Use it when
you want the store, not as a general "what is here".

A URL FILTER MATCHES ASSETS TOO, so pick a fragment only a data call can have. Measured twice in one
session, ~24,000 characters each: @net("review") matched the site's STYLESHEET, whose bundle name
contains "reviews-section", and @net("api/v3/ajax") matched its recommendations spec. Neither had
anything to do with reviews. A filter is a substring of the whole url, not a category — prefer a path
fragment the data endpoint owns, and read the mime on what comes back before reading the body.

@net(<filter>) BEFORE @net(*). The unfiltered watch keeps every response, and on a heavy app the
reply cannot be returned at all -- measured, 120,979 bytes against a 37,500 limit, so nothing came
back. Name the filter from the request the app makes to page ITSELF: infinite scroll fetches each
next batch from one url shape, and watching only that shape turns the whole problem into one readable
response. * is for discovery on a light page, never a first move on an application.

AND WHAT AN IMG SRC IN A GRID ACTUALLY IS. In a search or gallery grid it is almost always a preview
-- a hundred pixels wide, served off the search engine's own cdn, not the file anyone wanted. The
original usually lives in the batch payload @net just caught, joined to its row by whatever id the
markup carries. Check a dimension before promising someone files.

Read \`ended\` before believing a harvest finished: dry means the list really ended, capped means it
ran out of hops AND THERE IS MORE, limit means it hit the row cap. Never report capped as complete.

# NEITHER LAYER IS COMPLETE ALONE

The rendered page and the app's store each hold things the other omits. Measured on a chat app: the
store held only opaque privacy identifiers where a phone number belonged, while the page displayed
the real numbers the app had resolved for display. The reverse is just as common — a virtualized
list can never hold more than the mounted window, and its store holds all of it.

So never conclude a field is unavailable after reading ONE layer. Check the other, and say which
you checked.

# Reading history

Do not scroll up from the bottom to reach the beginning. Jump to the boundary — the app's own
oldest-first URL (a trailing /0 on a chat channel, ?page=1, sort=oldest) — then @collect DOWNWARD,
which is the direction that pages cheaply. Verified: a boundary jump reached a channel's true first
message from 2019 in one navigation.

For a RECENT window the opposite holds: you already land on the newest item, so
@collect(... :: ... :: up) and stop as soon as timestamps leave your window. Choosing the wrong end
turns a few hops into years of paging.

# Triage before you navigate

Opening every item to discover which ones changed is almost always avoidable. Many systems encode
creation time inside the identifier — snowflakes ((id >> shift) + epoch), MongoDB ObjectIds (first
4 bytes, unix seconds), UUIDv7 (first 48 bits, ms), ULIDs, KSUIDs. A list view usually carries a
last-item id per row. Decode it and you know what is stale WITHOUT a single navigation.

Treat a decoded last-item id as an UPPER BOUND on activity, not proof of it: the item it names may
have been deleted. Safe for excluding dormant rows; never for asserting a row is live.

# The list on screen is often not the whole list

Two different causes, and scrolling only fixes one:
- VIRTUALIZED — rows exist but only the mounted window is in the DOM. @collect handles it.
- COLLAPSED — a closed section renders ZERO children. Scrolling cannot reveal what is not there.
  Expand it (@map) or find the app's dedicated browse-all view, which usually renders everything.

Also: the view an app opens on is rarely where its activity is. Route by whatever the interface
itself marks as unread, recent or count-bearing, rather than by whatever loaded first.

# Many things to visit: check for an href before you walk

Three shapes, and picking the wrong one costs the person their browser for minutes:

- **The rows carry hrefs** — that is a WORK LIST. Read them once with page_state "@dom(<row css>)", then
  handle each URL. Do not press through them one at a time.
- **The rows are pressable only** (icon rails, tab strips, modals — no href anywhere) — that is
  what page_grow mode:"walk" is for, and the cost is real: it drives THEIR tab, serially, while they watch.
- **One page that keeps growing** — page_grow or @collect, not either of the above.

The check is one call: page_state "@dom(<row css>)" reports href on every row that has one. A list that has them is
almost never worth walking.

# The person's browser is not yours

tab_here newTab:true creates a tab that NOTHING will ever close — there is no close op, and tabs opened this
way are not tracked for cleanup. Every call leaves litter the person clears by hand. It is for
"open this page for them", not for navigation.

To visit many things that are pressable rather than linked, use page_grow mode:"walk": it presses
each in place and returns via history.back or Escape, leaving their tab where they left it. For
ordinary links it is tab_here, one URL at a time, or page_harvest for the whole set at once.

current_page follows the person's ACTIVE tab unless they pinned one in the HoloScrape panel. It
moves when they browse.

A HELD tabId IS NOT A DURABLE HANDLE EITHER. It is valid only while that tab is open, and a tab
you opened is one the person may close the moment they notice it — at which point every call
using it fails with "there is no tab" and whatever was in flight stops there. Measured twice in
one session, both times on scratch tabs that had just been tidied away.

So for a run of any length, ASK THEM TO PIN the tab in the HoloScrape panel and use current_page.
A pinned tab is one they chose to keep; a tabId you are holding is one they did not. If a call
does fail this way, tabs_list re-establishes where things are — and a page_grow mode:"walk" resumes from its
offset rather than starting over.

# A FIELD YOU NAMED IS A CLAIM, AND CLAIMS GET TESTED

filled: 66 of 70 says a column has values. It does not say they are values OF THE ROW. A column
that is populated and misidentified is the most expensive answer you can hand anyone, because unlike
an empty one it reads as verified.

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
looks like success. Spend the check on the second one.

# WHAT A MARKETPLACE SEARCH ACTUALLY RETURNS

Two things it is not, and both have shipped into answers:

NOT THE THING YOU ASKED FOR. A search for "psychology book" returned journals, planners, printable
worksheets, PDF bundles, a study guide, brain-shaped bookends and a neon sign. Measured on one run:
14 of 50 delivered "books" were not books; on another, 424 cards held 124 book-shaped listings.
Filter to what was asked for, and report how many you dropped and why — a filtered 50 with the count
of discards is honest; an unfiltered 50 is a different question answered.

NOT RANKED THE WAY "TOP" IMPLIES. The first slots are usually PAID. Cards carry it in their own text
("Ad by", "Ad from shop"), so it costs nothing to label them — and "top 50" over an ad-seeded
relevance order, unlabelled, claims an authority the page never offered.

# DOES THE ANSWER DEPEND ON WHO IS ASKING?

That is the whole question, and it decides the route. Not "inside or outside the browser" — an
earlier version of this section said outside fetches were simply wrong, and that was too broad by
half. It cost speed for nothing on every public endpoint.

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

# WHICH APP IS RENDERING, AND ON A PAGE WHERE IT IS AWAKE

Reviews, ratings, chat, search on a commerce site are usually a third-party widget, and naming the
wrong one sends the whole run down a dead end. Two ways to get it wrong, both measured in one day:

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

# Many pages, the same thing off each: that is ONE call

If you are about to open a list's links one at a time and read the same shape off every page, stop.
That is page_harvest. The extension iterates in parallel lanes, keeps the rows, and hands back a
resultId you finish with results action:"export" — you make a handful of calls and never see a row.

Measured on 250 film pages done the other way: 52m33s, 733 calls, and only 17% of it was the
browser. The rest was rows being read out of one reply and typed into the next, plus 164 file
appends that existed only because the model was holding the data.

The server enforces this rather than trusting the advice: after a few navigate-then-read-rows
cycles, tab_here REFUSES and tells you the call to make. An instruction to "split the work N ways,
one tab each" is the shape that loses — take the goal from it and harvest instead.

# A "thin" page is not a blocked site, and page_harvest already knows the difference

A storefront, a dashboard, any app that paints from JavaScript: the document is complete long before
the fields exist. page_harvest reads every page TWICE for exactly this reason — once at load, once
after a settle — and reports late: N for the pages that only answered on the second look. So:

- late high and rows present: the site is client-rendered. Nothing is wrong. It is slower.
- refused: true: the site is genuinely turning the run away. Every one of those pages was read
  twice before the claim was made. Do not retry in a loop, and say so in your report.
- Rows missing but read high: that is YOUR SELECTOR, not the site. The commonest cause is a
  hashed classname (css-5wh65g, _1a2b3c) copied off the list page — those are per-component and
  differ on the record page. Anchor on data-testid, text, or structure instead, and confirm with
  page_state @dom(<css>) on ONE record page before harvesting hundreds.

Concluding "this site blocks batch scraping" and falling back to one page at a time has been
measured at 25+ calls and 50 minutes for zero rows. Check the three lines above first; the fallback
is almost never the answer, and if it truly is, say which of the three you ruled out.

# Two failures that look like your bug and are not

- After the extension is reloaded, tabs that were already open hold a DEAD engine and simply hang.
  Every mysterious timeout right after a reload is this. Open a fresh tab.
- A bare container URL may redirect to a login page where the fully-qualified one does not. Use the
  deepest URL you have rather than the tidiest.
- "No browser connected" is almost never about pairing. Every agent session runs its own server, and
  the extension attaches to all of them; if you are told a PEER has the browser, the message says so
  and says what to do. Do not go looking through process lists, do not ask for a re-pair, and do not
  start killing processes — sessions have lost entire hours to that, and the answer is usually the
  person needs to reload the extension once. Read the failure you were given before investigating.

# Reporting

Say what you actually checked. "This field is not available" after reading one layer, or "the list
ended" on a capped harvest, is worse than no answer: it closes a question that was still open. When
a run comes back short, the honest report names which layer was read, what ended said, and what you
have not tried yet.`;
