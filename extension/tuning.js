// tuning.js — the values two or more files have to AGREE on, named once and explained once.
//
// Every constant here is a decision that used to be written out as a bare literal in at least two
// files: the same port span in the server and the window that dials it, the same close code sent
// by one side and interpreted by the other, the same message-type string on both ends of
// `chrome.runtime.sendMessage`. Written twice, such a value is one edit away from being written
// differently — and when the two copies disagree the failure is never an error, it is a window
// that dials ports nobody listens on, or a close code that reads as "abrupt" instead of "released".
//
// WHAT IS NOT HERE. A value used in one file stays in that file, beside the code it governs, in a
// clearly labelled block near the top. `mcp/index.mjs` and `mcp/tools.mjs` cannot import this: the
// MCP server is a separate npm package mirrored byte-identical to another repository, and adding a
// file to it is a distribution change. Where a value below is also needed there, the server keeps
// its own copy with a comment pointing back here — and the two MUST be changed together.
//
// This is an ES module. Only module consumers (bridge.js, bridge-window.js, bridge-ops.js) import
// it; classic page scripts (table.js, paper.js) and injected engines (scan.js) cannot, and carry
// their own labelled block instead.

// --- the local socket -----------------------------------------------------------------------------

// The extension dials out, the server listens, and both live on the same machine — so the host is
// never anything but loopback. Named because it appears in a URL, in status strings a person reads,
// and in a `net.connect` on the server, and a typo in any one of those is a connection that never
// happens.
export const LOOPBACK_HOST = '127.0.0.1';

// THE PORT THE SERVER TAKES WHEN NOTHING ELSE IS SAID, and the one the window falls back to when a
// build's env.js does not carry a `PORT_BASE`. 27182 for the digits of e — a number nobody can
// recall is a number nobody can debug. See `mcp/index.mjs` for why this range and not 3000/8080.
// `build.mjs` writes the same default into env.js (`portBase = 27182`).
export const PORT_BASE_DEFAULT = 27182;

// EIGHT, AND IT MUST MATCH `mcp/index.mjs`. The server takes the lowest free port of its span; the
// window dials every port of the same span. A server that binds above what the window dials is
// invisible forever, so the two numbers are one decision written in two files — this one, and the
// server's own copy.
export const PORT_SPAN = 8;

// The pairing token rides in the WebSocket subprotocol, prefixed so the server can find it among
// whatever else a client offers. A wrong token is refused at the upgrade, which is what makes
// "connected" mean connected rather than "a TCP socket exists". Mirrored in `mcp/index.mjs`.
export const TOKEN_PROTO = 'holoscrape.token.';

// The shortest thing that counts as a pairing code, on both ends: the panel refuses to store a
// shorter one ("that does not look like a pairing code"), and the server refuses to trust a stored
// `pair.json` holding one. The server generates 20 characters; 8 is the floor below which a stray
// paste is more likely than a code. Mirrored in `mcp/index.mjs`.
export const TOKEN_MIN_CHARS = 8;

// WebSocket close codes the two ends exchange. 1000 is the protocol's own "normal closure"; the
// 4000-range is application-defined (RFC 6455 §7.4.2) and each one below is a sentence the other
// side reads:
//   REFUSED     the server did not accept the pairing code — the ONLY code the window trusts as
//               "refused", because browsers report every handshake failure as 1006 on purpose
//   TURNED_OFF  the person switched agents off in the panel; the server tells its agent exactly that
//               instead of "reload the extension"
//   RELEASED    the person released this one host from the connection window — reversible, the
//               server process is still running
//   ENDED       the server is exiting because the person pressed End session — nothing left to
//               reconnect to, so the window removes the row outright
// Interpreted in `bridge-window.js`; sent and logged by `mcp/index.mjs`, which keeps its own copy.
export const WS_CLOSE = {
  NORMAL: 1000,
  REFUSED: 4001,
  TURNED_OFF: 4002,
  RELEASED: 4003,
  ENDED: 4004,
};

// How much of an error message travels back to the agent. Written for a model to relay to a
// person, so it says what to do about it — and is cut here so a stack trace or a page's own
// error text cannot swallow the reply. Applied where the worker answers the window (bridge.js) and
// where the window answers the socket (bridge-window.js), so both cut at the same place.
export const MAX_ERROR_CHARS = 400;

// --- storage and message vocabulary --------------------------------------------------------------

// The `chrome.storage.local` key under which the bridge settings live — token, enabled, off,
// autoWindow, keepOnClose, origins. Read by the worker and by the window through two separate
// `settings()` functions that must agree; the key is the first thing they have to agree on.
export const BRIDGE_SETTINGS_KEY = 'bridge';

// Where a result's tables and assets are stored: `table:<resultId>`. Written by the panel and the
// walk, read by the bridge ops (`results.*`) and by the results page (`table.js`, which cannot
// import and carries its own copy).
export const TABLE_KEY_PREFIX = 'table:';

// THE WINDOW -> WORKER VOCABULARY, `{ hs: <one of these> }`. The connection window relays into the
// worker and executes nothing itself, so these four words are the whole of what it can say:
//   STATE   here is what the panel should draw
//   ALIVE   a nudge that keeps the worker warm while the window is open
//   PANELS  is a side panel open right now? (the window has the clock; the worker has getContexts)
//   OP      run this operation — the one message that does work, and consent is checked there
export const HS = {
  STATE: 'state',
  ALIVE: 'alive',
  PANELS: 'panels',
  OP: 'op',
};

// THE WORKER -> WINDOW VOCABULARY, `{ type: <one of these> }`. One message type per action rather
// than one that overloads a boolean: the worker holds no socket, so each of these is a request the
// window carries out on the sockets it does hold.
//   OFF        close every socket with `WS_CLOSE.TURNED_OFF` BEFORE the window is removed, so the
//              server sees why rather than a dropped line
//   RELEASE    let go of one host, by port
//   RECONNECT  undo a release
//   KILL       ask one host's server process to exit
//   ALIVE      proof of life — the worker asks before trusting a window id it found in storage,
//              because a window whose extension was reloaded still exists and can never answer
export const WIN_MSG = {
  OFF: 'hs:off',
  RELEASE: 'hs:release',
  RECONNECT: 'hs:reconnect',
  KILL: 'hs:kill',
  ALIVE: 'hs:winalive',
};
