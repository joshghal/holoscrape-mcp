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
