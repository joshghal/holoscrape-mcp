# holoscrape-mcp

Give an AI agent your own logged-in browser. This runs locally, does not upload anything, and never
sees your passwords — the [HoloScrape](https://github.com/joshghal/holoscrape) Chrome extension does
the actual reading, in your own signed-in Chrome, and this process is only the bridge that lets an
MCP-speaking agent (Claude Code, Claude Desktop, Cursor, Windsurf) ask it to.

## Use it

You do not install this — your agent's MCP config runs it on demand:

```json
{
  "mcpServers": {
    "holoscrape": { "command": "npx", "args": ["-y", "holoscrape-mcp"] }
  }
}
```

Then pair it once:

```
npx -y holoscrape-mcp --code
```

prints a one-time code. Open the HoloScrape side panel in Chrome and enter it there. That's the whole
setup — the code is remembered, so this is a one-time step, not a per-session one.

## What it can do

Once paired, an agent can read whatever list is on a page you've allowed — a search results grid, a
directory listing, a table — and walk its pages. Nothing runs until you've explicitly allowed the
site in the HoloScrape panel; an agent cannot grant that to itself.

On a page with more than one scrollable region — a chat app's sidebar list beside an open
conversation, a filter rail beside results — the automatic ranking favours the denser pane, which
may not be the one you mean. The fix is two calls: `page_study` lists every candidate with its
selector, and `list_extract` with that selector pinned reads exactly that pane:

```
page_study   { tabId: 12 }                                    → lists[1].selector: "aside.rail>div.chats…"
list_extract { tabId: 12, selector: "aside.rail>div.chats…" } → grows and reads the sidebar, not the feed
```

## Why local

The alternative is a hosted relay that sees every page it reads. This process listens only on
`127.0.0.1`, and the pairing code is the only thing that can talk to it — printed once, typed once,
checked before a socket is even allowed to open.

## Tools

| Tool | What it does |
|---|---|
| `current_page` | The tab the person has open right now, and whether it can be read. The place to start for "I have a page open, scrape it". |
| `tabs_list` | Every http(s) tab currently open — for when `current_page` is not the one they meant. |
| `tab_here` | Point a tab you already have at a URL, and wait until it is loaded. The navigation primitive. `search:` turns plain words into a real search; `newTab:true` opens a new tab instead, which nothing will ever close. |
| `page_study` | Every repeating structure on a tab, ranked with evidence — not one verdict, several candidates so the caller chooses. Flags page furniture (footers, filter sidebars) that a naive reading mistakes for the real list. |
| `list_extract` | Read the rows already on this page into a table, following its pages. The fast path, and the one to try first. Takes an optional `selector` naming the container, for pages with more than one scrollable region; a selector that matches nothing fails by name instead of silently falling back. |
| `page_harvest` | A list page and the records behind its links — many pages, one call, no rows through the agent. Opens one page per record in parallel lanes, so it costs minutes: if the fields you need are already on the cards, `list_extract` answers in seconds. |
| `page_grow` | Make a list longer and report whether it actually grew — press a load-more, or scroll a named pane to its own bottom. `mode:"walk"` presses one thing and reports what changed, for apps that swap content without loading a document. `mode:"explore"` opens what is collapsed. |
| `page_state` | Read the layers under the rendered page: the app's own in-memory store, and the network responses it renders from. Discovery first (what exists, with the path to read each part), then a data path. For virtualized lists, where the DOM holds only the mounted window, and for fields the markup omits. `@dom(<css>)` reads the rendered page instead. Takes a path, never code; credential-shaped values come back masked, and counted, by design. |
| `results` | Saved tables and the runs that fill them, under one `action`: `status` and `stop` for a run, `list`, `get` and `export` for a finished table. |

## Try it without an agent

```
node try.mjs tabs
node try.mjs study <tabId>
```

Drives the same stdio protocol an agent would, useful for checking the whole chain — this script →
the server → the WebSocket → the extension → a real tab — works before pointing a real agent at it.

## Requirements

- Node.js 18+
- The [HoloScrape](https://github.com/joshghal/holoscrape) Chrome extension, installed and paired

## License

MIT
