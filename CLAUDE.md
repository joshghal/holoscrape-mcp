# CLAUDE.md — holoscrape-mcp (standalone MCP server)

This is the **public, npm-published half** of HoloScrape. The other half — the Chrome MV3
extension the server talks to — lives in the **private** repo `joshghal/holoscrape` at
`~/Documents/personal/ideation/holoscrape`.

**Rule: `index.mjs` here and `holoscrape/mcp/index.mjs` in the extension repo must stay
byte-identical.** Any change to one must be applied to the other in the same task, verified
with `diff`. The extension repo's test suite is what exercises this server — run `npm test`
over there after touching `index.mjs` here.

Publishing: users get this via `npx -y holoscrape-mcp` from the npm registry. Local edits
reach nobody until commit → push → version bump → `npm publish` (the user supplies the OTP).
Never publish, commit, or push without the user explicitly asking.

## Communication

Explain changes in **tables and bullet points**, not paragraph prose.

## Tool descriptions are the product, not documentation

This file is where every tool's description text lives, and those descriptions are the only
thing steering the model that calls them. Write them as **decision procedures for a model**,
not as API reference prose:

- say WHEN to reach for the tool and when NOT to (the "Best for: / Not recommended for:" shape);
- name the field to read before trusting a result (`looksLikeFurniture`, `distinctness`,
  `containerRows`) and say what a misleading value looks like;
- prefer teaching the model to choose over adding a special case to the engine. **Capability goes
  in the code generically; the knowledge of when to use it goes in the description.**

Corollary: no site-specific logic in the server or engine. Per-app facts (where an app hides its
store, how it paginates) live in the extension's `providers.js` descriptors as DATA. A tool that
branches on a hostname is a bug in this architecture.

## Never tune a test to get green

A red test means the logic is wrong — change the logic until the ORIGINAL assertion passes.
Never loosen an assertion, skip a case, soften a fixture, or special-case test input in
production code. If a test genuinely asserts wrong behaviour, say so and get agreement before
editing it; never quietly edit it and report "all green."

## ⚠ The credential boundary — non-negotiable

HoloScrape's whole market position is being the opposite of this category's malware (the March
2026 "Chrome MCP Server" RAT; BrowserMCP binding its socket to 0.0.0.0). Two properties carry
that: pairing-code auth on the local bridge, and per-origin consent. A third must never break:

| Layer | Rule |
|---|---|
| Page **data** — DOM, app state/store, network response bodies, localStorage/IndexedDB | Rides the ordinary per-origin consent. Fine — the person can already see it. |
| **Credentials** — cookies, `Authorization`/bearer headers, tokens, session secrets | A separate explicit opt-in, never bundled into "allow this site". **Never returned raw to the agent by default.** Redact, and report that something was redacted. |

The line is "read what's on my screen" vs "hand over my logged-in identity." An agent holding a
session cookie can *be* the person on that site from any machine. Any new tool that reaches a
deeper layer must respect this split — see `DEEP-EXTRACTION.md` in the extension repo for the
full initiative and the layer roadmap (`page_state` built, and the network layer with it —
`@net(...)` watches and `$.` paths into response bodies; `record_open` and `page_storage` ahead).

## Always re-read the DOM — neither layer is complete alone

**Rule: never conclude a field is unavailable from ONE layer.** Every query that comes back
short or missing a field must be retried against the OTHER layer before it is reported as absent.

Measured on WhatsApp Web, 2026-08-15, both directions in one session:

| Layer | Has | Lacks |
|---|---|---|
| Store (`page_state`) | structure, admin flags, group metadata, the COMPLETE list (10,066 contacts vs the DOM's 67) | phone numbers — `@lid` privacy identifiers only |
| DOM (`page_study` / `list_extract`) | the REAL phone numbers, photo URLs — the app resolves them for display | structure; only what is rendered, and virtualized lists truncate |

The cost of forgetting this: "WhatsApp's LID change hides saved contacts' numbers" was reported as
a wall after reading only the store. The numbers were on screen the entire time — one
`page_study` away — and a group's 16 member numbers came straight out of the rendered modal.

**How to apply:** a store read missing an obvious field → `page_study` the tab and look at the
`lists[]` samples. A DOM extraction that is truncated or link-less → read the app's store. Report
"not available" only after both.

## Test cases are written from the USER's side, not the tool's

A case is not done when a number comes back. The person asking never wanted a count — they wanted
the thing. Every case must therefore state, and check:

1. **The actual records, not the tally.** "23 rows found" is not a result; twenty-three server
   names are. A run that reports `rows: 23` and cannot hand them over has failed the case.
2. **Depth.** The detail behind each row — the fields the person would ask for next. A member list
   is names AND numbers AND roles, not ids. If the DOM omits a field, go to the store; if the store
   holds only an opaque key, resolve it. Report a field missing only after BOTH layers.
3. **Everything, or an honest ceiling.** All of it, or a stated total with the reason the rest is
   out of reach. "156 of 156" is a result; "16" beside a store that says 156 is a bug report.

Measured cost of forgetting this: a chat-list export "succeeded" with 308 rows whose phone column
held privacy identifiers, and a group export stopped at the 16 rows the modal happened to paint
while the store held 156. Both passed every check the tool made of itself.

**Applies to the tool descriptions too** — they steer the model that will do this. A description
that stops at "returns rows" invites a caller to stop at rows.
