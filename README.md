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

## Why local

The alternative is a hosted relay that sees every page it reads. This process listens only on
`127.0.0.1`, and the pairing code is the only thing that can talk to it — printed once, typed once,
checked before a socket is even allowed to open.

## Tools

| Tool | What it does |
|---|---|
| `current_page` | The tab the person has open right now, and whether it can be read. |
| `search_open` | Turn plain words ("restaurants in cimahi") into a real search, opened in their browser. |
| `tabs_list` | Every http(s) tab currently open. |
| `tab_open` | Open a specific URL. |
| `site_probe` | A cheap check, before committing to a run: is there a list, how many rows, how does it paginate. |
| `page_study` | Every repeating structure on a tab, ranked with evidence — not one verdict, several candidates so the caller chooses. Flags page furniture (footers, filter sidebars) that a naive reading mistakes for the real list. |
| `page_grow` | Press a load-more control or scroll, and report the record count before and after — the only honest way to answer "does this load more". |
| `list_extract` | Start reading a list into a table, following its pages. Returns immediately; poll `run_status`. |
| `run_status` | Progress on a run — including `waiting_for_user` when the site puts up a human check. |
| `run_stop` | Stop a run early; keeps what it already read. |
| `results_list` | Tables already extracted in this browser, newest first. |
| `results_get` | Rows and columns from a saved table. |
| `results_export` | Write a whole table to CSV in Downloads, for tables too big to read inline. |

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
