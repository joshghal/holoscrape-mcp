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
