#!/usr/bin/env node
// HoloScrape, as a tool any agent can call.
//
// TWO PIPES, AND THE DIRECTION OF THE SECOND ONE IS THE WHOLE DESIGN.
//
//   agent ──stdio JSON-RPC──▶  this process  ◀──WebSocket── the extension
//
// Nothing outside Chrome can call into an extension: there is no API for "run extension X", and
// `sidePanel.open()` needs a user gesture so we cannot even show ourselves. A service worker also
// cannot listen on a port. So the extension DIALS OUT and this process listens, which means the
// browser is whatever browser the person already has open — with their logins, their cookies and
// their IP. That is the entire reason to exist: a cloud browser cannot be signed in as you unless
// you ship it your session, and that is the thing people refuse.
//
// ZERO DEPENDENCIES, ON PURPOSE. `npx -y holoscrape-mcp` starts instantly with nothing to install,
// and the audit surface for a program that drives a logged-in browser is this one file. That is
// worth more than the convenience of `ws` and an SDK. The costs are paid below: the MCP wire
// format is newline-delimited JSON-RPC 2.0, which is small, and RFC 6455 framing, which is not
// small but is bounded because both ends are ours.
//
//   npx -y holoscrape-mcp
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const HOME = path.join(os.homedir(), '.holoscrape');
const PAIR_FILE = path.join(HOME, 'pair.json');
// A FIXED PORT, NOT AN EPHEMERAL ONE. The extension has to find us without being told, and there
// is nowhere to leave a note it can read — it cannot see the filesystem. So the port is the
// contract. The span exists so a second instance does not simply fail; the extension tries each.
//
// AND IT IS CHOSEN TO BE IN NOBODY'S WAY, which rules out most of the obvious numbers:
//
//   3000 3001 4000 5000 8000 8080 8081   every framework's default
//   5173 4321 4200 1337 7777             Vite, Astro, Angular, and the cute ones
//   8787                                 Cloudflare Wrangler — the first choice here, and wrong
//   9229 5432 6379 27017                 Node inspector, Postgres, Redis, Mongo
//
// It also has to sit BELOW both operating systems' ephemeral ranges, or an outbound socket can
// take it first: macOS hands out from 49152 and Linux from 32768. That leaves roughly 20000-32767
// as the window where a fixed listener is neither a service nor in the way of one.
//
// 27182 for the digits of e, because a number nobody can recall is a number nobody can debug.
const PORT_BASE = Number(process.env.HOLOSCRAPE_PORT || 27182);
// EIGHT, NOT FOUR. A developer runs one agent session per window and four is an ordinary number of
// windows to have open — so the ceiling was reachable by simply working, and reaching it cost every
// tool (see `listen` at the bottom). Widening is not the fix, it is the headroom; the fix is that the
// ninth session now degrades instead of disappearing. `bridge-window.js` dials this same span and
// must be changed WITH it, or a server above the extension's range listens to nobody forever.
// The test harness gives each slot a 16-wide window (`PORT_STRIDE` in `test/run-all.mjs`), so this
// still fits inside one slot.
const PORT_SPAN = 8;
// Which port this process actually got, filled in by listen(). Needed so a peer scan can tell a
// neighbour's server from its own listener, and so a failure can name where it is.
const MINE = { at: 0 };

// --- named values ---------------------------------------------------------------------------------
// THIS FILE CANNOT IMPORT THE EXTENSION'S `tuning.js`: it is a separate npm package, mirrored
// byte-identical to another repository, and every module it loads ships in that tarball. So the
// values the two ends have to AGREE on are written here a second time, each marked "mirrors
// tuning.js" — change them together or the window dials a server that speaks another dialect.
//
// The socket is loopback and nothing else: the extension dials out, this process listens, both on
// one machine. Named because it is a URL fragment, a `net.connect` host and a line a person reads,
// and a typo in any one is a connection that never happens. Mirrors tuning.js.
const LOOPBACK_HOST = '127.0.0.1';
// The shortest thing that counts as a stored pairing code. `token()` generates 20 characters; a
// `pair.json` holding fewer than this is a corrupt or hand-edited file, not a code. The panel
// refuses to store a shorter one under the same rule. Mirrors tuning.js.
const TOKEN_MIN_CHARS = 8;
// WebSocket close codes in the application range (RFC 6455 §7.4.2), each a sentence the extension's
// window reads — it trusts REFUSED as "the code was refused" precisely because browsers report every
// handshake failure as 1006 on purpose, and only a completed handshake can carry a real code:
//   REFUSED     wrong pairing code, or a first message that was not a hello
//   TURNED_OFF  the person switched agents off in the panel (sent by the window, read here)
//   RELEASED    the person released this one host from the connection window (sent by the window)
//   ENDED       this process is exiting because the person pressed End session
// Mirrors tuning.js.
const WS_CLOSE = { REFUSED: 4001, TURNED_OFF: 4002, RELEASED: 4003, ENDED: 4004 };
// A close frame's reason is capped well under RFC 6455's 125-byte control-frame payload limit:
// two bytes of status code plus at most this many bytes of UTF-8 reason.
const CLOSE_REASON_MAX_BYTES = 100;
// A beat between writing a close frame and destroying the TCP socket, so the frame reaches the
// client — without it this degrades back into the abrupt, indistinguishable 1006 close that the
// handshake ordering exists to avoid.
const CLOSE_BEAT_MS = 50;
// The same beat before `process.exit` on a `terminate`, so the ENDED frame leaves before the
// process — and the port — go with it. Carries more weight than a refusal, so a little longer.
const EXIT_BEAT_MS = 60;
// How long a neighbour port is given to accept TCP before the peer scan calls it empty. Loopback
// answers in microseconds; this is only ever paid by a port that is held and not answering.
const PEER_PROBE_MS = 300;
// How long `ask()` waits for the extension to answer an op when the tool's own budget does not say:
// the ordinary read, a quick tab list, and opening a tab in the other browser (a document load).
const ASK_MS = 30000;
const ASK_QUICK_MS = 10000;
const ASK_OPEN_MS = 60000;
// The companion browser's launch: how often to look for its socket, how many looks a re-grant may
// take before it is called lost (50 x 200 ms = 10 s), how long Playwright is given to surface the
// extension's service worker, and the viewport a headless page paints at — a laptop-class width,
// so a responsive site serves its desktop layout and not a phone menu.
const COMPANION_POLL_MS = 200;
const COMPANION_REGRANT_POLLS = 50;
const COMPANION_SW_MS = 20000;
const COMPANION_VIEWPORT = { width: 1366, height: 900 };
// Reply-shape sizes. A FAILURE REASON remembered for the repeat-call gate, or appended as a note,
// may run longer than a snippet because it is the whole of what the caller gets. A TAB LINE is
// "id title" in a "which tab did you mean" list. The SNIPPET size and the too-big-reply caps live
// beside the spool (`SNIPPET_CHARS`, `SAMPLE_FIELDS_MAX`, `INDEX_ROWS_MAX` below `SPOOL_DIR`):
// `test/spool-too-big.mjs` lifts that region out of this file and runs it on its own, so the
// values it reads have to travel with it.
const FAIL_WHY_MAX_CHARS = 300;
const TAB_LINE_CHARS = 90;
// How deep `offerScan` walks a reply looking for urls. A row is an object of strings; six levels
// covers a nested `value.items[].fields.href` and stops a pathological reply from costing a walk.
const OFFER_DEPTH_MAX = 6;
// Reloading tools.mjs from a checkout: fs.watch fires more than once per save on most platforms, so
// bursts closer than this are one save; and the editor is given this long to finish writing before
// the file is read back.
const RELOAD_DEBOUNCE_MS = 300;
const RELOAD_SETTLE_MS = 60;
// JSON-RPC 2.0 §5.1 error codes: the method does not exist, and an exception inside a handler.
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INTERNAL_ERROR = -32603;
// The MCP protocol revision this server speaks when the client does not name one.
const MCP_PROTOCOL_VERSION = '2025-06-18';

// --- pairing ------------------------------------------------------------------------------------
// 127.0.0.1 IS NOT A TRUST BOUNDARY. Every process on this machine can reach this port, and what
// is on the other end is a browser signed into the person's mail, bank and work accounts. Without
// a shared secret, any program on the laptop — or any npm postinstall script — can drive it.
//
// So the extension must present a token it could only have got from the person: printed here,
// typed there, once. Kept in the home directory so a restart does not ask again.
function token() {
  try {
    const held = JSON.parse(fs.readFileSync(PAIR_FILE, 'utf8'));
    if (held?.token?.length >= TOKEN_MIN_CHARS) return held.token;
  } catch (_) { /* first run */ }
  // Six groups of four from an unambiguous alphabet — no O/0, no I/l/1 — because this gets read
  // off a terminal and typed into a side panel by a person.
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const raw = crypto.randomBytes(24);
  const made = [...raw].slice(0, 20).map((b) => abc[b % abc.length]).join('')
    .replace(/(.{4})(?=.)/g, '$1-');
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PAIR_FILE, JSON.stringify({ token: made }, null, 2), { mode: 0o600 });
  return made;
}
const PAIR = token();
// A SECOND TOKEN FOR THE SERVER'S OWN BROWSER, NEVER PRINTED. The companion (see `companion` below)
// is a headless Chromium this process launches with the same extension loaded, and it dials the
// same port range as the person's Chrome. The hello whose token matches THIS one is the companion;
// `PAIR` stays the person's. Random per process and handed to the extension by `bridgePair` over
// Playwright, so no one types it and nothing on disk holds it — a token that outlived the process
// would let the next launch be paired by something other than this server. Same alphabet as PAIR
// because `bridgePair` upper-cases what it is given (research/COMPANION-DESIGN.md).
// ON BY DEFAULT, AND THE VARIABLE IS TRI-STATE. The people who need the companion are the ones
// whose debugger is blocked by policy or by DevTools — the least likely to know an environment
// variable exists — and a flag defeats the dynamic switch this exists for (owner's decision,
// 2026-09-22). Unset means on. `HOLOSCRAPE_COMPANION=1` or `--companion` means on. Any OTHER set
// value — `0`, `off`, even an empty string in an MCP config's env block — means off. It costs
// nothing while on: nothing launches until a switch is called for (`companionEnsure`).
const VERSION = (() => {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    return JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version || '0.0.0';
  } catch (_) { return '0.0.0'; }
})();

// A FLAG THIS SERVER DOES NOT KNOW STOPS IT. Measured 2026-09-22: `npx -y holoscrape-mcp
// --install-browser` fetched the PUBLISHED package — five weeks behind, no such flag — which
// ignored the word and started serving: a pairing code, four ports, a process paired to the
// person's extension until it was killed by PID. Nothing said "unknown flag" or which version was
// running, so a failed install read as a server that had started. Refused here, before anything
// binds, with the version in the message so a stale package announces itself.
const KNOWN_FLAGS = new Set(['--code', '--companion', '--install-browser', '--print']);
{
  const unknown = process.argv.slice(2).filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a));
  if (unknown.length) {
    process.stderr.write(`holoscrape-mcp ${VERSION}: unknown flag ${unknown.join(' ')}. Known flags: `
      + `${[...KNOWN_FLAGS].join(' ')}. If you expected this flag to exist, you may be running an older `
      + 'published version — `npx -y holoscrape-mcp@latest`, or run the server from a checkout.\n');
    process.exit(2);
  }
}

const COMPANION_ON = process.argv.includes('--companion')
  || process.env.HOLOSCRAPE_COMPANION === undefined
  || process.env.HOLOSCRAPE_COMPANION === '1';
const COMPANION_PAIR = (() => {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return [...crypto.randomBytes(20)].map((b) => abc[b % abc.length]).join('').replace(/(.{4})(?=.)/g, '$1-');
})();
const whereOf = (tok) => (tok === COMPANION_PAIR ? 'companion' : 'person');

// ONE SENTENCE, THE SAME EVERYWHERE THE COMPANION CANNOT LAUNCH. It is what an agent relays to the
// person, so it says what to run and what it unlocks, and nothing else.
const INSTALL_HINT = 'a headless companion can take public pages when a lane in your Chrome cannot paint '
  + '(DevTools open, or a managed browser blocking the debugger) — run `npx holoscrape-mcp --install-browser` '
  + 'once to unlock it (downloads Chromium for Testing, ~150 MB), then retry.';

// `npx holoscrape-mcp --install-browser` — the manual step, done through playwright-core's own CLI
// so the browser build always matches the library this server imports. `--print` shows the
// command instead of running it. Exits; never starts serving.
if (process.argv.includes('--install-browser')) {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  let cli = '';
  try { cli = path.join(path.dirname(req.resolve('playwright-core/package.json')), 'cli.js'); } catch (_) {
    try { cli = path.join(path.dirname(req.resolve('playwright/package.json')), 'cli.js'); } catch (_2) { /* neither */ }
  }
  if (!cli || !fs.existsSync(cli)) {
    process.stderr.write('holoscrape-mcp: playwright-core is not installed beside this server, so there is no CLI to '
      + 'download the browser with. Reinstall holoscrape-mcp (playwright-core is a dependency) and run this again.\n');
    process.exit(2);
  }
  const argv = [cli, 'install', 'chromium'];
  if (process.argv.includes('--print')) {
    process.stdout.write(`${process.execPath} ${argv.join(' ')}\n`);
    process.exit(0);
  }
  process.stderr.write('holoscrape-mcp: downloading Chromium for Testing through playwright-core (about 150 MB, once)…\n');
  const { spawn: spawnProc } = await import('node:child_process');
  const child = spawnProc(process.execPath, argv, { stdio: 'inherit' });
  child.on('exit', (code) => {
    if (code === 0) process.stderr.write('holoscrape-mcp: done. The companion browser will launch itself the first time a lane in your Chrome cannot paint.\n');
    process.exit(code ?? 1);
  });
  // Keep the process alive until the child exits; nothing below runs.
  await new Promise(() => {});
}
// ONE ID PER SERVER PROCESS, NOT PER PORT. A port gets reused — this process exits, a new agent
// session binds the same number a minute later — and "release the connection on 27182" must mean
// THIS session, never whichever one happens to be sitting on that port later. The extension keys its
// release list on this, not on the port.
const SESSION = crypto.randomUUID();
// The MCP client's own name, learned from `initialize` — "Claude Code", "Cursor", whichever agent is
// actually driving. Null until that handshake happens, which can land before OR after the extension's
// socket connects; both orders are handled where each is used.
let CLIENT_INFO = null;
// Same prefix on both ends; the token rides in the WebSocket subprotocol.
const TOKEN_PROTO = 'holoscrape.token.';

// PRINTING THE CODE ON ITS OWN, because by the time it is needed it is usually unreachable. The
// code goes to stderr at startup — and when an agent launched the server, that stderr is the
// agent's own log, which is somewhere between hard to find and not shown at all. The person is
// then told to paste a code they cannot see.
//
// A flag rather than "look in ~/.holoscrape/pair.json": that path needs a different command on
// Windows, and the file is an implementation detail we should stay free to move.
if (process.argv.includes('--code')) {
  process.stdout.write(`${PAIR}\n`);
  process.exit(0);
}

// --- the extension end: a WebSocket server, hand-rolled ------------------------------------------
// Only what our own client sends: no extensions, no permessage-deflate, no server-to-client
// masking (forbidden by the RFC anyway). Continuation frames ARE handled, because a table of six
// hundred rows does not arrive in one.
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// TWO BROWSERS, KEYED BY THE TOKEN THEIR HELLO CARRIED. `person` is the connected extension this
// server has always held — the person's own Chrome, logins and all. `companion` is the headless
// Chromium this process launches on demand (`companion` below): no session, no banner, no lane tabs
// on anyone's desk. Every op names which one it rides (`ask(..., where)`); the default is `person`.
// Measured why both are needed (research/COMPANION-DESIGN.md): a lane with no debugger hold read
// 0 of 6 pages in the person's Chrome and 6 of 6 in a fresh headless one, while a page behind a
// sign-in is readable ONLY in the person's. No cookie, header or storage ever moves between them.
const browsers = { person: { sock: null }, companion: { sock: null } };
// When the person last turned agents off in HoloScrape — the extension closes its socket with 4002 to
// say so. Cleared by the next connection. Without it that close reads as any other drop, and the agent
// is told to reload the extension: the opposite of what was just decided.
let turnedOffAt = 0;
// When the person released THIS specific connection (not all of them) from the connection window or
// the panel's host list. Same reasoning as `turnedOffAt`, scoped to one session instead of every one.
let releasedAt = 0;
const waiting = new Map();       // id -> {resolve, reject, timer}
let seq = 0;

// A REAL CLOSE FRAME, sendable only because the handshake below now always completes first.
// RFC 6455 §5.5.1: a close frame is protocol data, and protocol data does not exist before the
// protocol has started — which is the whole reason this file no longer rejects a bad token with a
// raw HTTP 401 ahead of the 101 response. Payload is the 2-byte status code, big-endian, plus an
// optional UTF-8 reason; capped at CLOSE_REASON_MAX_BYTES, well under the 125-byte control-frame limit.
function closeFrame(code, reason = '') {
  const text = Buffer.from(reason, 'utf8').subarray(0, CLOSE_REASON_MAX_BYTES);
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
}

function frame(payloadStr) {
  const body = Buffer.from(payloadStr, 'utf8');
  const n = body.length;
  let head;
  if (n < 126) {
    head = Buffer.alloc(2);
    head[1] = n;
  } else if (n < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  head[0] = 0x81;               // FIN + text
  return Buffer.concat([head, body]);
}

// RFC 6455 §5.2 length sentinels. A 7-bit length of 126 means "the real length is the next two
// bytes"; 127 means "the next eight". Named, because `126` and `127` sitting bare in a comparison
// read as arbitrary numbers rather than as the two values the spec reserves.
const LEN_16 = 126;
const LEN_64 = 127;
// A declared length arrives from a socket every process on this machine can reach, so an unbounded
// one is a memory-exhaustion lever: allocate what you were told to and a single frame header takes
// the process down. 8MB is far above any table this carries and far below trouble.
const MAX_FRAME = 8 * 1024 * 1024;

// THREE OUTCOMES, EACH NAMED — because two of them used to be tangled together.
//
// This was one line holding an `if` inside an `if`, mixing a `break` (a partial frame: wait for more
// bytes, the connection is fine) with a `return` (a fatal one: kill it). Those are opposite
// instructions, and a single expression carrying both is how someone later "simplifies" one into
// the other and silently turns "the rest is still arriving" into a dropped connection.
function frameLength(b) {
  const first = b[1] & 0x7f;
  if (first < LEN_16) return { len: first, at: 2 };
  if (first === LEN_16 && b.length < 4) return { short: true };
  if (first === LEN_16) return { len: b.readUInt16BE(2), at: 4 };
  if (b.length < 10) return { short: true };
  const big = b.readBigUInt64BE(2);
  if (big > BigInt(MAX_FRAME)) return { huge: true };
  return { len: Number(big), at: 10 };
}

// A browser client always masks (RFC 6455 §5.3), so the four mask bytes sit between the header and
// the payload and every byte is XORed against them in turn.
function unmask(b, at, len) {
  const key = b.subarray(at, at + 4);
  const body = Buffer.from(b.subarray(at + 4, at + 4 + len));
  for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
  return body;
}

// Returns complete messages and keeps whatever is left over. A browser client always masks, so
// the mask is required rather than optional — an unmasked frame from a client is a protocol error
// and here it means something other than our extension is talking.
function unframe(state) {
  const out = [];
  for (;;) {
    const b = state.buf;
    if (b.length < 2) break;
    const size = frameLength(b);
    if (size.short) break;
    if (size.huge) { state.kill = 'frame too large'; return out; }
    if ((b[1] & 0x80) === 0) { state.kill = 'unmasked frame from a client'; return out; }
    if (b.length < size.at + 4 + size.len) break;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    const body = unmask(b, size.at, size.len);
    state.buf = b.subarray(size.at + 4 + size.len);
    if (op === 0x8) { state.kill = 'closed'; state.closeCode = body.length >= 2 ? body.readUInt16BE(0) : 0; return out; }
    if (op === 0x9 || op === 0xa) continue;               // ping/pong: nothing to carry
    state.parts.push(body);
    if (!fin) continue;                                   // more parts of this message still coming
    out.push(Buffer.concat(state.parts).toString('utf8'));
    state.parts = [];
  }
  return out;
}

const srv = http.createServer((_req, res) => { res.writeHead(404); res.end(); });

// THE SAME REFUSAL, FROM BOTH PLACES THAT CAN REFUSE. A real close frame, then a moment
// (CLOSE_BEAT_MS) for it to reach the client before the TCP socket dies underneath it. It was
// written twice, identically, which is one edit away from being written differently.
function refuse(sock, code, reason) {
  try { sock.write(closeFrame(code, reason)); } catch (_) {}
  setTimeout(() => sock.destroy(), CLOSE_BEAT_MS);
}

// The token rides in the subprotocol so it can be judged before any data flows.
function offeredToken(req) {
  return String(req.headers['sec-websocket-protocol'] || '')
    .split(',').map((x) => x.trim()).filter(Boolean)
    .find((p) => p.startsWith(TOKEN_PROTO)) || '';
}

function openHandshake(sock, key, bearing) {
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
    + (bearing ? `Sec-WebSocket-Protocol: ${bearing}\r\n` : '')
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);
}

// THE FIRST MESSAGE IS THE TOKEN AND NOTHING ELSE HAPPENS BEFORE IT.
//
// The two ways this can fail are separate events and now report themselves separately. A first
// message that is not a hello is a PROTOCOL fault; a hello carrying the wrong code is an AUTH
// failure. Both used to log "refused a connection with the wrong pairing code", so a client that
// simply spoke out of turn sent whoever read that log hunting a pairing problem that did not exist.
// The wire behaviour is unchanged — same close code, same reason text — only the local log is honest
// about which of the two happened.
//
// Returns false when the socket has been refused, meaning nothing further may be read from it.
function greet(sock, conn, welcome, msg) {
  if (msg.type !== 'hello') {
    say(`refused a connection whose first message was "${msg.type || 'untyped'}", not a hello`);
    refuse(sock, WS_CLOSE.REFUSED, 'wrong pairing code');
    return false;
  }
  if (msg.token !== PAIR && msg.token !== COMPANION_PAIR) {
    say('refused a connection with the wrong pairing code');
    refuse(sock, WS_CLOSE.REFUSED, 'wrong pairing code');
    return false;
  }
  say(`extension connected — ${msg.version || 'unknown version'}`);
  welcome(whereOf(msg.token));
  return true;
}

// An answer to something we asked. Unknown ids are ignored rather than treated as errors: a reply
// to a call that already timed out is late, not wrong.
function settle(msg) {
  const held = waiting.get(msg.id);
  if (!held) return;
  waiting.delete(msg.id);
  clearTimeout(held.timer);
  if (msg.error) held.reject(new Error(msg.error));
  else held.resolve(msg.result);
}

// One decoded message. False means the socket was refused and the caller must stop reading it.
// TERMINATE MEANS THE PROCESS EXITS, NOT JUST THE SOCKET. Release (4003, extension-side only) leaves
// this process running so Reconnect has something to reconnect to. This is the other thing entirely —
// asked for when the person wants the PORT back, for a fresh session to bind on its own next start —
// so there is nothing left running to reconnect to, on purpose.
function take(sock, conn, welcome, text) {
  let msg = null;
  try { msg = JSON.parse(text); } catch (_) { return true; }
  if (!conn.paired) return greet(sock, conn, welcome, msg);
  if (msg.type === 'pong' || msg.type === 'hello') return true;
  if (msg.type === 'terminate') {
    say('the person ended this session from the extension — exiting so the port frees up');
    try { sock.write(closeFrame(WS_CLOSE.ENDED, 'ended by request')); } catch (_) {}
    // A beat (EXIT_BEAT_MS) for the close frame to actually leave the socket before the process —
    // and the port — goes with it. Same reasoning as `refuse()`'s pause; this one carries more weight.
    setTimeout(() => closeCompanion().then(() => process.exit(0), () => process.exit(0)), EXIT_BEAT_MS);
    return true;
  }
  settle(msg);
  return true;
}

function onData(sock, state, conn, welcome, chunk) {
  state.buf = Buffer.concat([state.buf, chunk]);
  for (const text of unframe(state)) if (!take(sock, conn, welcome, text)) return;
  if (!state.kill) return;
  if (state.kill !== 'closed') say(`dropped a connection: ${state.kill}`);
  sock.hsCloseCode = state.closeCode || 0;
  sock.destroy();
}

function failWaiter(id, held) {
  clearTimeout(held.timer);
  held.reject(new Error('the extension disconnected mid-call'));
  waiting.delete(id);
}

function onGone(sock) {
  const held = browsers[sock.hsWhere];
  if (held && held.sock === sock) {
    held.sock = null;
    if (sock.hsWhere === 'companion') say('companion disconnected');
    else if (sock.hsCloseCode === WS_CLOSE.TURNED_OFF) { turnedOffAt = Date.now(); say('extension disconnected: the person turned agents off'); }
    else if (sock.hsCloseCode === WS_CLOSE.RELEASED) { releasedAt = Date.now(); say('extension disconnected: the person released this connection'); }
    // ENDED never reaches here in practice — this process is already exiting when it sends that frame
    // — but `onGone` fires from the socket's own 'close'/'error' events regardless of who is faster,
    // so the branch exists for correctness rather than to ever actually log anything useful.
    else if (sock.hsCloseCode === WS_CLOSE.ENDED) { /* exiting */ }
    else say('extension disconnected');
  }
  // Only the calls that were riding THIS socket: the other browser's calls are still in flight.
  for (const [id, w] of waiting) if (w.sock === sock) failWaiter(id, w);
}

// Everything that belongs to one accepted connection. `where` is which browser the token said this
// is; decided at upgrade when the token rode the subprotocol, otherwise by the hello.
function attach(sock, atUpgrade, where = 'person') {
  const state = { buf: Buffer.alloc(0), parts: [], kill: '' };
  const conn = { paired: false };
  // A message the extension can BELIEVE. Nothing was ever sent on success before, so the only
  // evidence of pairing available to the panel was the socket opening — which is why it drew
  // "Connected" for a handshake that had not happened yet.
  const welcome = (at = where) => {
    conn.paired = true;
    sock.hsWhere = at;
    browsers[at].sock = sock;
    if (at === 'person') turnedOffAt = 0;
    beat(sock);
    try { sock.write(frame(JSON.stringify({ type: 'welcome', server: 'holoscrape', session: SESSION, client: CLIENT_INFO }))); } catch (_) {}
  };
  if (atUpgrade) { say(`${where === 'companion' ? 'companion' : 'extension'} connected (authenticated at upgrade)`); welcome(); }
  sock.on('data', (chunk) => onData(sock, state, conn, welcome, chunk));
  const gone = () => onGone(sock);
  sock.on('close', gone);
  sock.on('error', gone);
}

srv.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return sock.destroy();

  // THE HANDSHAKE ALWAYS COMPLETES. THE TOKEN IS CHECKED AFTER, NOT BEFORE.
  //
  // This used to reject a bad subprotocol token with a raw HTTP 401 before completing the WebSocket
  // handshake — meant to let the extension tell "wrong code" apart from "nothing here", and to keep
  // `onopen` from firing for a code that was never accepted. The intent was right; the mechanism was
  // not. Browsers deliberately report EVERY handshake failure — nothing listening, TCP refused, a
  // non-101 HTTP response — as the identical close code 1006 with no reason, specifically so a page
  // cannot fingerprint what is running on a person's machine. Rejecting before 101 put "wrong code"
  // and "no server here at all" on the same event. Measured: with nothing running on any of the four
  // ports, the panel reported "the pairing code was refused by 27182, 27183, 27184, 27185" — a
  // specific, confident, and entirely fabricated diagnosis.
  //
  // A close code is only a real, distinguishable signal once the connection has actually opened, so
  // the handshake is now accepted unconditionally and a bad token gets a genuine close frame (4001)
  // immediately after. This does NOT reopen the "Connected but nothing works" problem — `paired` was
  // already gated on receiving `welcome`, never on the socket opening, and that is the fix that
  // mattered. Only WHEN the token was checked changes here, not what the panel is allowed to believe
  // before the server has said so.
  const bearing = offeredToken(req);
  const borne = bearing.slice(TOKEN_PROTO.length);
  const wrongAtUpgrade = bearing && borne !== PAIR && borne !== COMPANION_PAIR;

  openHandshake(sock, key, bearing);
  if (!wrongAtUpgrade) return attach(sock, !!bearing, whereOf(borne));
  say('refused an upgrade with the wrong pairing code');
  refuse(sock, WS_CLOSE.REFUSED, 'wrong pairing code');
});

// Ask the extension to do something and wait for its answer.
// KEEPING AN MV3 SERVICE WORKER ALIVE IS OUR PROBLEM, NOT THE EXTENSION'S.
//
// figma-agent-bridge reconnects with a 1.5s timer and that is enough for it, because a Figma plugin
// UI is a live iframe that persists while the plugin is open. Our end is a service worker Chrome
// evicts after ~30 seconds of quiet, and a timer inside it dies with it — so copying their loop
// would fix nothing. Measured tonight: the socket dropped and had not returned twelve minutes later.
//
// Chrome resets that idle timer on WebSocket ACTIVITY, so traffic is the fix. A text frame each way
// every 20 seconds is unambiguous activity in the worker's own JS context (an automatic protocol-
// level pong is handled by the network stack and may not count). It also catches the half-open
// socket neither end has noticed: no reply for two beats and this connection is not live.
// Overridable so a test can watch a real beat cycle without waiting twenty seconds for each one.
// The interval under test is the extension REPLYING, not Chrome eviction timing.
const BEAT_MS = Number(process.env.HOLOSCRAPE_BEAT_MS || 20000);
const BEAT_MISSES = 2;
// One tick of the heartbeat, lifted out of the interval so its three outcomes — the socket has been
// replaced, it has stopped answering, it gets a ping — are three flat statements instead of a
// nested branch inside a callback.
function pulse(sock, timer, count) {
  if (browsers[sock.hsWhere]?.sock !== sock) return clearInterval(timer);
  // Counted here and not at the call site, so a socket already replaced never accrues a miss —
  // the original incremented only after the liveness check and that ordering is load-bearing.
  count.missed += 1;
  if (count.missed <= BEAT_MISSES) return ping(sock, timer);
  clearInterval(timer);
  say('no heartbeat reply — dropping the connection');
  return sock.destroy();
}

function ping(sock, timer) {
  try { sock.write(frame(JSON.stringify({ type: 'ping' }))); } catch (_) { clearInterval(timer); }
}

function beat(sock) {
  const count = { missed: 0 };
  const timer = setInterval(() => pulse(sock, timer, count), BEAT_MS);
  sock.on('close', () => clearInterval(timer));
  sock.on('data', () => { count.missed = 0; });
}

const NO_BROWSER = 'No browser connected. Open Chrome with the HoloScrape extension installed, '
  + 'then pair it in the side panel.';
// A DECISION, NOT A FAULT, AND IT HAS TO READ AS ONE. Every other message here ends in a fix; this one
// must not, because the only "fix" would be overruling the person who turned it off.
const TURNED_OFF = 'The person turned off agent access in HoloScrape, so this session has no browser. '
  + 'That was their decision, not a fault: do not tell them to reload the extension, re-pair, or reopen '
  + 'the side panel to get it back, and do not retry these calls. If the task needs their browser, say '
  + 'so plainly and leave it to them to turn it back on.';
// DIFFERENT FROM TURNED_OFF ON PURPOSE. Other agent sessions may still be connected fine — this one
// was singled out, not everything shut off — so the fix (if any) is "reconnect just this one," not
// "check whether agents are allowed at all."
const RELEASED = 'The person released this specific browser connection in HoloScrape — other agent '
  + 'sessions may still be connected fine. Do not tell them to reload the extension or re-pair, and do '
  + 'not retry these calls. If the task needs the browser back, say so plainly; they can reconnect this '
  + 'session from the connection window or the AI agents screen in the side panel.';

// THAT MESSAGE IS A LIE WHENEVER ANOTHER SERVER IS RUNNING, AND THAT IS THE COMMON CASE.
//
// Every agent session starts its own copy of this server, and each takes the lowest FREE port in the
// range. An extension build that keeps one socket takes the first port that answers — the lowest,
// which is the OLDEST server — and never looks again. The newest session therefore gets nothing,
// always, and the only thing it is told is "pair it in the side panel": Chrome IS running, the
// extension IS installed, it IS paired, and re-pairing cannot possibly help. Sessions have spent
// entire hours on `lsof` and `ps` rediscovering this, because the one lead they were given pointed
// at the one action that does nothing.
//
// This server cannot see the extension's socket, but it can see its neighbours: anything else
// listening in the range is another session's server, and if there is one, that — not pairing — is
// almost certainly the answer. Cheap enough to do on the failure path only.
function peerAt(at) {
  return new Promise((resolve) => {
    const s = net.connect({ port: at, host: LOOPBACK_HOST });
    const done = (yes) => { try { s.destroy(); } catch (_) {} resolve(yes); };
    s.setTimeout(PEER_PROBE_MS, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function peers() {
  const ports = [];
  for (let i = 0; i < PORT_SPAN; i++) if (PORT_BASE + i !== MINE.at) ports.push(PORT_BASE + i);
  const found = await Promise.all(ports.map(peerAt));
  return ports.filter((_, i) => found[i]);
}

async function whyNoBrowser() {
  // NO PORT AT ALL IS A DIFFERENT FAULT FROM AN UNDIALLED ONE, and it has a different fix.
  //
  // Reloading the extension is the answer when a server holds a port nobody dialled. It cannot be
  // the answer here: this process never bound one, so there is nothing for the extension to dial and
  // a reload is a wasted session. Said first, and named as the pool rather than as pairing.
  if (POOL_FULL) {
    const held = await peers().catch(() => []);
    return `This server never got a port. ${PORT_BASE}-${PORT_BASE + PORT_SPAN - 1} is the whole `
      + `pool and all of it is in use${held.length ? ` (listening now: ${held.join(', ')})` : ''}, so `
      + 'the extension has nothing here to connect to and no browser call can succeed from this '
      + 'session.\n'
      + 'RELOADING THE EXTENSION WILL NOT HELP — there is no port on this side to dial.\n'
      + 'Close one other agent session (or kill its `mcp/index.mjs` — `lsof -nP -iTCP:'
      + `${PORT_BASE}-${PORT_BASE + PORT_SPAN - 1}`
      + '`), then reconnect this one with `/mcp`. That reconnect has to happen interactively; a '
      + 'session that started without a port cannot recover on its own, so plan a fallback rather '
      + 'than retrying these calls.';
  }
  if (turnedOffAt) return TURNED_OFF;
  if (releasedAt) return RELEASED;
  const others = await peers().catch(() => []);
  if (!others.length) return NO_BROWSER;
  // A LISTENING PEER IS NOT EVIDENCE THAT THE BROWSER IS ON IT.
  //
  // This used to open with "this is NOT a pairing problem, so do not investigate the extension" on
  // the strength of one fact: another port is open. That fact says nothing about where the browser
  // is. Measured — two servers listening, `lsof` showing ZERO established connections to either, so
  // the browser was attached to nothing at all, and this message was telling the reader to look
  // anywhere but at the extension. A confident wrong diagnosis costs more than an honest uncertain
  // one, because it forecloses the check that would have found it.
  //
  // All this process can see is: nobody dialled ME, and someone else is also listening. Both of the
  // two explanations lead to the same first action, so say both and give the action.
  return `No browser connected here (${LOOPBACK_HOST}:${MINE.at || '?'}), and ${others.length === 1
    ? `another agent session's server is also listening, on ${LOOPBACK_HOST}:${others[0]}`
    : `other agent sessions' servers are also listening, on ${LOOPBACK_HOST}:${others.join(', ')}`}.\n`
    + 'Two possibilities, and this process cannot tell them apart — it only knows nobody dialled it:\n'
    + `  a. The browser is attached to ${others.length === 1 ? 'that server' : 'one of those servers'} `
    + 'instead of this one. An extension build from before the multi-socket change keeps ONE socket, '
    + 'given to whichever port answered first.\n'
    + '  b. The browser is attached to NOTHING. A reload leaves the connection window behind with a '
    + 'dead script context: it is still on screen, its sockets are gone, and it can never dial again.\n'
    + 'RELOAD THE HOLOSCRAPE EXTENSION. That is the fix for both, it takes seconds, and it costs '
    + 'nobody their session — a current build replaces a window that cannot answer and dials every '
    + 'server at once.\n'
    + 'Only if that is impossible: ending the other session (or killing it — `lsof -nP -iTCP:PORT`) '
    + 'makes an old build redial and land here in about three seconds. It takes HoloScrape away from '
    + 'that session, so ask first — and it does nothing at all if the answer was (b).';
}

// How long the EXTENSION has taken, accumulated here and read by the trace in `callTool`. Declared
// beside the only thing that adds to it; the trace subtracts a before-and-after reading to get the
// browser's share of one tool call.
const browserMs = { spent: 0 };

// The timeout's own body, named, so the promise executor below stays one level deep.
function giveUp(id, op, ms, reject) {
  waiting.delete(id);
  reject(new Error(`the browser did not answer "${op}" within ${Math.round(ms / 1000)}s`));
}

// `where` names the browser: 'person' (default, as it always was) or 'companion'. A companion that
// is off or never came up is a refusal with the switch to flip, not a "no browser" hunt.
function ask(op, args, ms = ASK_MS, where = 'person') {
  const sock = browsers[where]?.sock;
  if (!sock) {
    return (where === 'companion' ? Promise.resolve(companionWhy()) : whyNoBrowser())
      .then((why) => Promise.reject(new Error(why)));
  }
  const id = ++seq;
  // Timed so the trace can separate what the BROWSER took from what the whole call took. Charged
  // on both paths, because a call that timed out still spent the time.
  const t0 = Date.now();
  const charge = () => { browserMs.spent += Date.now() - t0; };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => giveUp(id, op, ms, reject), ms);
    waiting.set(id, { resolve, reject, timer, sock });
    sock.write(frame(JSON.stringify({ id, op, args })));
  }).then((v) => { charge(); return v; }, (e) => { charge(); throw e; });
}

// --- the companion: a headless Chromium this process launches, with the same extension ------------
//
// THE PERSON'S CHROME CANNOT DO EVERYTHING, AND NEITHER CAN A BROWSER WITH NO LOGIN. Measured with
// the real harvest, 3 lanes (research/WORK-WINDOW-EXPERIMENT.md): with the debugger hold, background
// lane tabs read 12 of 12; with the hold unavailable — DevTools open on a lane, or Chrome 155's
// managed policy blocking `debugger.attach` — they read 0 of 6. A fresh headless Chromium has no
// DevTools open and no policy, so the same lanes paint. The other way round, a page behind a sign-in
// is readable only where the person is signed in. So the server holds both and routes each op to
// the one that can answer (`routed` below); this section is only the launching.
//
// ON BY DEFAULT, OFF WITH HOLOSCRAPE_COMPANION=0 (any set value but `1`); `--companion` or `=1` say
// on out loud. The companion is the SERVER's browser, holding nothing of the person's, and the
// restricted-host list still applies inside it.
//
// LAZY, ONCE PER PROCESS, AND TEMPORARY. Nothing launches until a call needs it. The profile is a
// fresh temp dir, the extension is a temp build with THIS server's port as its portBase (the way
// probe/headless-mcp.mjs assembles one), and both are removed at exit. Playwright is loaded with a
// dynamic import so this file stays zero-dependency for everyone who never turns the companion on.
const COMPANION_HELLO_MS = 25000;
const companion = { ctx: null, sw: null, build: '', profile: '', starting: null, granted: new Set(), why: '' };

function companionWhy() {
  if (!COMPANION_ON) {
    return 'The companion browser was turned off for this session (HOLOSCRAPE_COMPANION is set to '
      + `${JSON.stringify(process.env.HOLOSCRAPE_COMPANION)}). It is a headless Chromium this server launches itself (no `
      + 'login, no debugging banner) for public pages. Turn it on with HOLOSCRAPE_COMPANION=1 in the MCP '
      + 'config env, or --companion on the command; unset means on. Until then every call runs in their Chrome.';
  }
  return companion.why || 'The companion browser is not connected yet — it launches on first use.';
}

// Branded Chrome refuses --load-extension, so the channel is chromium. The UA string of a headless
// build says "HeadlessChrome", which Cloudflare and Techaro match on (measured in test/quiet.mjs:
// 1 image bare, 24 and 44 with the word removed, matching headed). One throwaway launch reads the
// real string, cached per Playwright version in tmp so the cost lands once per machine.
async function quietUserAgent(pw) {
  const stamp = (() => { try { return JSON.parse(fs.readFileSync(new URL(import.meta.resolve('playwright/package.json')), 'utf8')).version; } catch (_) { return 'unknown'; } })();
  const file = path.join(os.tmpdir(), 'holoscrape-ua.json');
  try {
    const hit = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (hit.stamp === stamp && hit.ua) return hit.ua;
  } catch (_) { /* no cache yet */ }
  const probe = await pw.chromium.launch({ headless: true, channel: 'chromium' });
  let ua;
  try { ua = (await (await probe.newPage()).evaluate(() => navigator.userAgent)).replace(/HeadlessChrome/g, 'Chrome'); } finally { await probe.close(); }
  try { fs.writeFileSync(file, JSON.stringify({ stamp, ua })); } catch (_) { /* read-only tmp: probe again next time */ }
  return ua;
}

async function launchCompanion() {
  let pw;
  try { pw = await import('playwright'); } catch (_) {
    try { pw = await import('playwright-core'); } catch (_2) {
      throw new Error(`companion unavailable: ${INSTALL_HINT} (playwright-core is missing where this server runs — `
        + 'reinstall holoscrape-mcp, it is a dependency).');
    }
  }
  // The extension source: HOLOSCRAPE_EXT_DIR, else the repo root beside mcp/. The npm package does
  // not carry the extension yet, so a bare `npx holoscrape-mcp` has nothing to load — said plainly.
  // THE SAME FILE RUNS FROM TWO LAYOUTS. In the repo it is `<root>/mcp/index.mjs` and the
  // extension is the root itself; in the npm package it is `<pkg>/index.mjs` and the extension
  // is the bundled `<pkg>/extension/` (scripts/bundle-extension.mjs writes it at mirror time). One
  // resolution order serves both, and HOLOSCRAPE_EXT_DIR overrides either.
  const here = path.dirname(new URL(import.meta.url).pathname);
  const hasExt = (d) => fs.existsSync(path.join(d, 'manifest.json')) && fs.existsSync(path.join(d, 'build.mjs'));
  const extDir = [process.env.HOLOSCRAPE_EXT_DIR, path.join(here, 'extension'), path.join(here, '..')]
    .filter(Boolean).find(hasExt);
  if (!extDir) {
    throw new Error('companion unavailable: the HoloScrape extension source was not found (looked for '
      + `manifest.json + build.mjs in ${process.env.HOLOSCRAPE_EXT_DIR ? `${process.env.HOLOSCRAPE_EXT_DIR}, ` : ''}`
      + `${path.join(here, 'extension')} and ${path.join(here, '..')}). Point HOLOSCRAPE_EXT_DIR at a checkout `
      + 'of the HoloScrape repo, or reinstall holoscrape-mcp — the package bundles it.');
  }
  const { envFile, injectable } = await import(pathToFileURL(path.join(extDir, 'build.mjs')).href);
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-companion-ext-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-companion-prof-'));
  companion.build = build; companion.profile = profile;
  for (const f of fs.readdirSync(extDir)) if (/\.(js|html)$/.test(f)) fs.copyFileSync(path.join(extDir, f), path.join(build, f));
  fs.copyFileSync(path.join(extDir, 'manifest.json'), path.join(build, 'manifest.json'));
  // THIS server's port as the base, so the companion dials the span this process is in and no other.
  fs.writeFileSync(path.join(build, 'env.js'), envFile('stg', { unblock: false, portBase: MINE.at || PORT_BASE }));
  // Generated by the build, not checked in; without it every harvested page fails to inject.
  fs.writeFileSync(path.join(build, 'harvest-inject.js'), injectable(fs.readFileSync(path.join(extDir, 'harvest.js'), 'utf8')));
  fs.cpSync(path.join(extDir, 'public'), path.join(build, 'public'), { recursive: true });
  let ctx;
  try {
    ctx = await pw.chromium.launchPersistentContext(profile, {
      headless: true, channel: 'chromium', userAgent: await quietUserAgent(pw).catch(() => undefined),
      viewport: COMPANION_VIEWPORT,
      args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`],
    });
  } catch (e) {
    // "Executable doesn't exist" is what a fresh install says: the library is here, the browser is
    // not. That is the one thing the person has to do by hand — a 150 MB download is never silent.
    const m = String(e?.message || e);
    if (/Executable doesn't exist|browserType\.launch|install/i.test(m)) throw new Error(`companion unavailable: ${INSTALL_HINT}`);
    throw e;
  }
  companion.ctx = ctx;
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: COMPANION_SW_MS });
  companion.sw = sw;
  await sw.evaluate(async (t) => { await globalThis.__holoscrape.bridgePair(t); }, COMPANION_PAIR);
  for (let i = 0; i < COMPANION_HELLO_MS / COMPANION_POLL_MS && !browsers.companion.sock; i++) await pause(COMPANION_POLL_MS);
  if (!browsers.companion.sock) throw new Error(`companion unavailable: it launched but never dialled ${LOOPBACK_HOST}:${MINE.at} within ${COMPANION_HELLO_MS / 1000}s`);
  say('companion connected — a headless Chromium of this server\'s own, no session in it');
  return companion;
}

// Idempotent and single-flight: two calls that both need the companion share one launch.
function companionEnsure() {
  if (browsers.companion.sock) return Promise.resolve(companion);
  if (!COMPANION_ON) return Promise.reject(new Error(companionWhy()));
  if (!companion.starting) {
    companion.starting = launchCompanion()
      .catch((e) => { companion.why = String(e?.message || e); closeCompanion(); throw e; })
      .finally(() => { companion.starting = null; });
  }
  return companion.starting;
}

// Consent inside the companion, per origin, on demand. Nothing of the person's is exposed by a read
// in a browser that holds nothing of theirs, so the server grants it the way the panel would.
//
// A GRANT RESTARTS THE SOCKETS. bridge-window.js shuts every socket and redials on ANY change to the
// `bridge` setting in storage — a grant included — so the companion drops for about a second right
// after this write, and a call sent into that gap dies "the extension disconnected mid-call".
// Measured on the very first switched harvest. So this waits for the socket to come back before
// returning, rather than asking the extension to tell a re-pair from a grant.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function companionGrant(origin) {
  if (!origin || companion.granted.has(origin) || !companion.sw) return;
  const before = browsers.companion.sock;
  await companion.sw.evaluate(async (o) => { await globalThis.__holoscrape.bridgeGrant(o, true); }, origin);
  companion.granted.add(origin);
  for (let i = 0; i < COMPANION_REGRANT_POLLS; i++) {
    const now = browsers.companion.sock;
    if (now && now !== before) break;
    await pause(COMPANION_POLL_MS);
  }
  if (!browsers.companion.sock) throw new Error(`companion unavailable: it did not reconnect after consenting to ${origin}`);
}
const originOf = (u) => { try { return new URL(String(u)).origin; } catch (_) { return ''; } };
const originsOf = (args) => new Set([args?.url, ...(Array.isArray(args?.urls) ? args.urls : [])].map(originOf).filter(Boolean));

function closeCompanion() {
  const { ctx, build, profile } = companion;
  companion.ctx = null; companion.sw = null; companion.granted = new Set();
  const rm = () => { for (const d of [build, profile]) if (d) fs.rmSync(d, { recursive: true, force: true }); };
  if (!ctx) { rm(); return Promise.resolve(); }
  return ctx.close().catch(() => {}).then(rm, rm);
}

// --- the agent end: MCP over stdio ---------------------------------------------------------------
// Newline-delimited JSON-RPC 2.0 — one message per line, which is what MCP's stdio transport is.
// stdout carries protocol and NOTHING else; every human-readable word goes to stderr, because a
// stray console.log here corrupts the stream and the failure looks like the agent going mad.
const say = (s) => process.stderr.write(`holoscrape-mcp: ${s}\n`);
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

import { TOOLS as TOOLS0, OPS as OPS0, SLOW as SLOW0, NEXT as NEXT0, PRE as PRE0, timeoutFor as timeoutFor0 } from './tools.mjs';
import { BRIEF, BRIEF_COMPANION, INSTRUCTIONS } from './guidance.mjs';
import { resolveXVideo, statusIdFromUrl } from './x-video-resolve.js';

// THE TOOL SURFACE IS HELD IN A BOX SO IT CAN BE REPLACED WHILE RUNNING.
//
// The worst failure this server has is invisible: a client caches the tool list when the session
// starts, so a tool added afterwards does not exist as far as the agent is concerned — and "no
// such tool" is indistinguishable from "never built". A whole session went to that, working around
// capabilities that were sitting in the file the entire time.
//
// MCP already has the answer — `notifications/tools/list_changed` — but it is only useful if the
// process notices. So the box below is swapped when tools.mjs changes on disk, and the client is
// told. Editing the file now updates a live session instead of requiring a reconnect nobody knows
// to perform.
const surface = { TOOLS: TOOLS0, OPS: OPS0, SLOW: SLOW0, NEXT: NEXT0, PRE: PRE0, timeoutFor: timeoutFor0 };

// READ FROM package.json RATHER THAN TYPED HERE. A version in two places is a version that will
// disagree with itself, and the whole point of reporting it is that it is trustworthy.
// (VERSION is defined near the top of the file, beside the flag gate that prints it.)


// A tool result is text content; big tables are trimmed HERE rather than in the browser, so the
// count the agent is told is the real one and not the one that happened to fit.
// A REPLY TOO BIG TO READ IS WORSE THAN A REFUSAL, BECAUSE IT COSTS THE WHOLE BUDGET TO FIND OUT.
//
// page_state can be pointed at a collection with thousands of records and no projection, and the
// honest answer is 92KB. The client then refuses it, spills it to a file, and tells the caller to
// "use offset and limit" — which is the wrong lever, so the same call gets made again. Measured:
// four identical 92KB dumps in a row against one WhatsApp collection, each one costing a turn and
// teaching nothing.
//
// So the size check happens HERE, where the right lever is known per tool, and the reply that comes
// back is the instruction rather than the data. It never truncates and hands the front of a list
// back as if it were the list — a short answer that looks complete is the failure this project
// keeps paying for. Nothing is returned, and the reply says so.
// THE CEILING IS IN TOKENS, NOT CHARACTERS, AND THAT IS WHY THE FIRST VERSION OF THIS MISSED.
//
// Set at 70,000 characters on the assumption that a client refusing 92KB would accept 70KB. Then a
// 68,132-character reply was refused — under the limit and still rejected — because the client
// counts TOKENS and this kind of payload tokenizes far worse than prose. Snowflake ids fragment
// into pieces, emoji in names cost 2-4 tokens each, and JSON punctuation is a token per bracket.
// Measured on the replies that failed: roughly 2.7 characters per token, against the ~4 you would
// assume from English.
//
// So the budget is stated in tokens and converted pessimistically. 15,000 tokens is well under any
// client limit seen (~25k) and still a very large answer; at 2.5 chars/token that is 37,500
// characters. Erring low costs a caller one extra paged call. Erring high costs a whole turn, a
// spilled file, and — measured four times in one session — an identical retry that fails the same
// way.
const MAX_TOKENS = 15000;
const CHARS_PER_TOKEN = 2.5;     // pessimistic on purpose; ids and emoji are worse than prose
const MAX_REPLY = Math.floor(MAX_TOKENS * CHARS_PER_TOKEN);   // 37,500

// The lever that actually shrinks each tool, named rather than described. `fields` is first for
// page_state because a projection is what turns thirty calls into one — offset only walks a list
// that was never worth reading whole.
const SMALLER = {
  page_state: 'fields:["a.b","c"] to keep only the columns you need — the biggest win by far — '
    + 'then limit for fewer rows and depth for a shallower read. offset walks the rest.',
  // ONE key per tool. A second `page_state` line sat under this one for a while and, being
  // later in the literal, silently won — the advice above was never what an agent saw.
  results_get: 'columns:["..."] to keep only the columns you need, then limit.',
};

// --- SPOOLING A REPLY THAT WILL NOT FIT -------------------------------------------------------
//
// A REFUSED REPLY USED TO DESTROY THE ANSWER, NOT JUST WITHHOLD IT.
//
// `REPLY_TOO_BIG` told the caller to ask for less, which is sound advice only when less exists.
// For a map of everything a page fetched it does not: the point of `@net(*)` is that it is wide,
// and `limit`/`fields`/`depth` page the ROWS while the bulk is each response's own paths map.
// Worse, `@net()` returns what is new SINCE THE LAST POLL — so an oversized reply that returned
// nothing had still marked those responses seen. Measured three times in one session against
// shopee.co.id: 206,957 bytes captured, refused, and then unreachable. The data existed, was paid
// for, and was thrown away by the transport.
//
// So the bytes are written to disk instead. The MCP server runs on the person's own machine and
// already has `fs`; a file is cheap where a reply is not. The caller gets a path, an index and a
// count — and then has grep, jq and a streaming read, which beat any paging protocol this channel
// could have grown.
//
// WHY THIS IS SAFE AT THIS LAYER, AND WOULD NOT BE ONE LAYER UP: `text` here is the reply as it
// was going to be sent, which means `page_state` has ALREADY masked every credential-shaped value
// on its way out (see its own note on the mask). Spooling the serialized reply therefore writes
// exactly what the caller would have read. Spooling the raw object instead would have turned this
// into a credential bypass — the one trust tier the project treats as non-negotiable.
const SPOOL_DIR = path.join(os.tmpdir(), 'holoscrape-spool', String(process.pid));
const CHUNK_TARGET = Math.floor(MAX_REPLY * 0.8);   // a chunk any single read can swallow whole
// HERE, NOT IN THE BLOCK AT THE TOP: `test/spool-too-big.mjs` lifts everything from `SPOOL_DIR` to
// the repeat-call gate out of this file and runs it standalone, so what this region reads must be
// defined inside it. A SNIPPET is a short quote inside a sentence — a row's label in the index, the
// first line of an error, the `failed` field in a trace line. When a reply is too big to return,
// this many field names of the first row are quoted so a projection can be written from them, and
// this many rows are named in the index — sixty, so the index itself can never become the thing
// that is too big.
const SNIPPET_CHARS = 120;
const SAMPLE_FIELDS_MAX = 40;
const INDEX_ROWS_MAX = 60;
let spoolN = 0;

// The one array worth splitting: the longest top-level one. Everything else is small enough that
// the whole file answers it.
function biggestArray(v) {
  if (Array.isArray(v)) return { at: '$', rows: v };
  if (!v || typeof v !== 'object') return null;
  let best = null;
  for (const [k, val] of Object.entries(v)) {
    if (Array.isArray(val) && (!best || val.length > best.rows.length)) best = { at: `$.${k}`, rows: val };
    else if (val && typeof val === 'object') {
      for (const [k2, v2] of Object.entries(val)) {
        if (Array.isArray(v2) && (!best || v2.length > best.rows.length)) best = { at: `$.${k}.${k2}`, rows: v2 };
      }
    }
  }
  return best;
}

function spool(value, text, name) {
  try {
    fs.mkdirSync(SPOOL_DIR, { recursive: true });
    const stem = `${String(++spoolN).padStart(3, '0')}-${(name || 'reply').replace(/[^\w.-]+/g, '_')}`;
    const whole = path.join(SPOOL_DIR, `${stem}.json`);
    fs.writeFileSync(whole, text);

    // CHUNKS, BECAUSE ONE 200KB FILE IS NOT OBVIOUSLY BETTER THAN ONE 200KB REPLY. Split the
    // longest array into pieces each small enough to read in a single call, so the caller can
    // work through them without a jq expression or a byte offset.
    const big = biggestArray(value);
    const chunks = [];
    if (big && big.rows.length > 1) {
      // MEASURED THE WAY IT IS WRITTEN. The first version budgeted with `JSON.stringify(row)` and
      // wrote with `JSON.stringify(cur, null, 2)` — compact in, pretty out — so every chunk came
      // out about 3% over the cap it was supposed to respect. Caught by this file's own test at
      // 38,629 bytes against a 37,500 limit, which is exactly the kind of near-miss that would
      // have looked fine in review. The candidate array is now serialized the way it will be
      // stored, and the row that pushes it over starts the next chunk instead.
      const write = (rows) => {
        const f = path.join(SPOOL_DIR, `${stem}.part${String(chunks.length).padStart(3, '0')}.json`);
        fs.writeFileSync(f, JSON.stringify(rows, null, 2));
        chunks.push({ file: f, rows: rows.length });
      };
      let cur = [];
      for (const row of big.rows) {
        cur.push(row);
        if (cur.length > 1 && JSON.stringify(cur, null, 2).length > CHUNK_TARGET) {
          cur.pop();
          write(cur);
          cur = [row];
        }
      }
      if (cur.length) write(cur);
    }
    return { whole, chunks, at: big ? big.at : '', rows: big ? big.rows : null };
  } catch (e) {
    return { error: e.message };
  }
}

// A few words per row, so the index says WHICH row to open rather than only how many there are.
// Urls first: a network map is a list of urls and nothing else identifies a response.
function labelOf(row) {
  if (row == null) return '';
  if (typeof row !== 'object') return String(row).slice(0, SNIPPET_CHARS);
  for (const k of ['url', 'href', 'name', 'title', 'id', 'path', 'selector', 'text']) {
    if (typeof row[k] === 'string' && row[k]) return `${k}=${row[k].slice(0, SNIPPET_CHARS)}`;
  }
  return Object.keys(row).slice(0, 6).join(',');
}

function asResult(value, name = '') {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= MAX_REPLY) return { content: [{ type: 'text', text }] };

  // What the caller needs to shrink it: how big it was, how many rows, and what a row holds — the
  // field names are what a projection is written from, so guessing them is the next failure.
  // FOUR SHAPES, BECAUSE THE FIRST VERSION ONLY KNEW THREE. page_state does not return a bare
  // array: a collection comes back as { value: { "[array]": {total,shown}, items: [...] } }, so the
  // check for an array at `value.value` missed it and the refusal named the lever without naming
  // the FIELDS. That left a discovery call to make by hand — the exact call this is meant to save.
  // Found on the first live run against a real store; no fixture of mine had that shape.
  const rows = Array.isArray(value?.rows) ? value.rows
    : Array.isArray(value?.value?.items) ? value.value.items
      : Array.isArray(value?.value) ? value.value
        : Array.isArray(value?.items) ? value.items
          : Array.isArray(value) ? value : null;
  const sample = rows?.[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]).slice(0, SAMPLE_FIELDS_MAX) : null;

  // WRITTEN TO DISK BEFORE THE REFUSAL IS COMPOSED, so the answer survives being un-returnable.
  const put = spool(value, text, name);

  // An index of the rows, not the rows: enough to say WHICH one to open. Capped at INDEX_ROWS_MAX
  // so the index itself can never become the thing that is too big.
  //
  // INDEXED FROM THE ARRAY THAT WAS ACTUALLY CHUNKED, not from `rows` above. `rows` only knows
  // four shapes (`value.rows`, `value.value.items`, `value.value`, `value.items`) and a network
  // poll is none of them — its rows live under `value.responses`, so the index came back empty on
  // the exact reply this whole mechanism was built for. `biggestArray` already found that array
  // to split it; the index uses the same answer.
  const indexRows = put.rows || rows;
  const index = indexRows ? indexRows.slice(0, INDEX_ROWS_MAX).map(labelOf).filter(Boolean) : undefined;

  return {
    content: [{ type: 'text', text: JSON.stringify({
      error: 'REPLY_TOO_BIG',
      bytes: text.length,
      limit: MAX_REPLY,
      rows: rows ? rows.length : undefined,
      fieldsOnFirstRow: sample || undefined,
      // NOT "nothing was returned" any more — that was the old, worse truth. The bytes are on
      // disk, which matters most for a poll that consumes what it reports: `@net()` hands back
      // what is new SINCE THE LAST POLL, so a refusal used to lose those responses for good.
      why: put.whole
        ? 'Too big to return, so it was written to disk instead — nothing was lost. Read it with '
          + 'your own file tools; grep and jq are better at this than any reply could be.'
        : 'Nothing was returned. A reply this size cannot be read, and returning the front of it '
          + 'would look like the whole answer — so the request has to get smaller, not the response.',
      ...(put.whole ? {
        spooled: put.whole,
        ...(put.chunks.length > 1 ? {
          chunks: put.chunks.map((c) => c.file),
          chunkedFrom: put.at,
          chunkRows: put.chunks.map((c) => c.rows),
        } : {}),
        index: index && index.length ? index : undefined,
      } : {}),
      ...(put.error ? { spoolFailed: put.error } : {}),
      tell: put.whole
        ? 'open the file, or one chunk at a time — the request does not have to get smaller.'
        : (SMALLER[name] || 'ask for less: a narrower selector, fewer rows, or a shallower read.'),
      ...(sample ? { example: `${name} fields:["${sample.slice(0, 3).join('","')}"]` } : {}),
    }, null, 2) }],
    isError: true,
  };
}

// THE SAME FAILING CALL, MADE AGAIN, IS THE MOST EXPENSIVE THING AN AGENT DOES.
//
// Measured: one page_state against a 2,427-record collection returned 92KB and was refused by the
// client, four times in a row, identical arguments each time. Four round trips to the browser, four
// spilled files, four turns, and nothing learned — because the reply that came back said the same
// thing and there was nothing to make the fifth attempt different.
//
// ONLY DETERMINISTIC FAILURES COUNT. "No browser connected", a timeout, a closed tab and a bot
// check are all worth retrying — the world changes and the same call can succeed. A reply that is
// too big, a path that does not exist, a selector that matches nothing: those are answers about the
// REQUEST, and asking again with the same request gets the same answer.
const DETERMINISTIC = /REPLY_TOO_BIG|NO_PATH|BAD_PATH|matches nothing|must be http|is missing its argument/i;
const failures = new Map();      // "tool:args" -> { n, why }
const FAIL_KEY_MAX = 200;        // a long session should not accumulate keys forever

function failKey(name, args) {
  // Key order does not matter to the caller, so it must not matter here either — the same call
  // written two ways is still the same call.
  const a = args && typeof args === 'object'
    ? Object.keys(args).sort().map((k) => `${k}=${JSON.stringify(args[k])}`).join('&')
    : String(args ?? '');
  return `${name}:${a}`;
}

function rememberFailure(key, why) {
  if (failures.size > FAIL_KEY_MAX) failures.clear();
  const held = failures.get(key) || { n: 0, why: '' };
  failures.set(key, { n: held.n + 1, why });
}

// THE EXPENSIVE PATTERN, STOPPED BY THE INFRASTRUCTURE RATHER THAN BY A GOOD PROMPT.
//
// Measured on 250 film pages: navigate a tab, read rows off it, write them out, 250 times. 52m33s
// and 733 calls, of which the browser was 17% — the rest was rows moving through the model. The
// same work through `page_harvest` is a handful of calls, because the extension iterates and the
// rows never leave it.
//
// Guidance alone does not stop it. The instructions are served at `initialize`, before any brief
// exists, and they still lose to a brief that says "split the work five ways, each worker gets its
// own tab, write one file per worker" — an instruction from the person beats a note from the
// server, every time and correctly. So the loop is stopped HERE, where no prompt can reach.
//
// WHAT COUNTS AS THE PATTERN, kept narrow on purpose: the same tab sent to a NEW url, and then a
// read of that tab that comes back with more than one row. Requiring rows is what keeps this off
// legitimate multi-step navigation — a login, a form, a one-off lookup — none of which return a row
// set. Requiring a new url each time keeps it off polling one page.
//
// It refuses rather than warns, because a warning is a thing to read past, and it names the call to
// make instead. `oneByOne` is the way out for the genuine exception, so this is a default with an
// escape rather than a wall.
const LOOP_LIMIT = 5;
const LOOP_TABS = 32;
// KEPT PER TAB, because the brief this exists to defeat is "split it five ways, each worker gets its
// own tab". A single slot keyed on the last tabId seen is wiped by every switch between them, so five
// interleaved sweeps each counted zero and the refusal never fired — the gate was beaten by exactly
// the shape it was built for, and a person reading the code would not have seen it. Bounded, because
// a long session touches many tabs and none of this is worth leaking.
const loops = new Map();

function loopFor(tabId) {
  let l = loops.get(tabId);
  if (l) return l;
  if (loops.size >= LOOP_TABS) loops.delete(loops.keys().next().value);
  l = { urls: new Set(), cycles: 0, armed: false, hits: 0, at: '' };
  loops.set(tabId, l);
  return l;
}

// THE EARLIER, STRONGER SIGNAL: the caller just read a list, and is now walking its own links.
//
// Counting navigate-then-read cycles only knows something is wrong after five pages have already
// been paid for. But a list page HANDS OVER its links — they come back in the rows of the read that
// preceded the sweep. Once those addresses are known, the second one navigated to is not a guess
// about intent; it is the sweep, observed, with the whole queue already in hand.
//
// So every read remembers the http(s) addresses it returned, and navigation into that set is
// counted separately and much sooner. One free look is deliberate: reading a result list and opening
// a single hit is how a person checks something, and refusing that would be hated.
const OFFER_LIMIT = 2;       // two free looks; the third is a sweep
const OFFER_MIN = 10;        // fewer links than this is a page, not a queue
const OFFER_SCAN = 800;
const OFFERS_MAX = 3000;
const offers = new Map();    // url -> the tabId whose read handed it over

function offerScan(v, into, depth = 0) {
  if (v === null || v === undefined || depth > OFFER_DEPTH_MAX || into.size >= OFFER_SCAN) return;
  if (typeof v === 'string') { if (/^https?:\/\/./.test(v)) into.add(v); return; }
  if (Array.isArray(v)) { for (const x of v) offerScan(x, into, depth + 1); return; }
  if (typeof v === 'object') for (const x of Object.values(v)) offerScan(x, into, depth + 1);
}

const samePath = (a, b) => {
  try { return new URL(a).pathname === new URL(b).pathname; } catch (_) { return false; }
};

function loopSawOffer(tabId, reply) {
  if (!tabId) return;
  const found = new Set();
  offerScan(reply, found);
  if (found.size < OFFER_MIN) return;
  // PAGINATION IS NOT A SWEEP, and it is the false positive that would make this hated. `?page=2` of
  // the list shares the list's own path; the records it points at do not. Dropping same-path links
  // keeps walking a list's own pages free, which is correct — harvest does not paginate.
  const here = loops.get(tabId)?.at || '';
  for (const u of found) {
    if (here && samePath(u, here)) continue;
    if (offers.size >= OFFERS_MAX) offers.delete(offers.keys().next().value);
    offers.set(u, tabId);
  }
}

function offerRefusal(n) {
  return 'REFUSED — you already have these addresses, and page_harvest takes all of them at once.\n'
    + `A read on this tab handed back ${n} links and you are now visiting them one at a time. That is `
    + 'a harvest done by hand: roughly one model turn per page, for every page still in the list.\n'
    + 'Measured on exactly this pattern: 250 pages took 52 minutes and 733 calls, and only 17% of '
    + 'that was the browser — the rest was rows being read out of one reply and typed into the next. '
    + 'The same 250 pages through page_harvest took 3 minutes 13 seconds.\n'
    + 'Call it with the LIST tab and the css that selects those links, and it opens them in parallel '
    + 'lanes, extracts each one, and hands back a resultId you finish with results_export:\n'
    + '  page_harvest({ tabId: <the list tab>, links: "<css for the links>",\n'
    + '                 record: { <one-per-page fields> }, rows: { at: "<repeating row css>", '
    + 'fields: { … } } })\n'
    + 'Pass `urls` instead of `links` if you already hold the addresses. Give neither `record` nor '
    + '`rows` and it reads schema.org, which is often the whole answer.\n'
    + 'If these pages genuinely need visiting one at a time — a login, a form, pages that differ '
    + 'from each other — pass oneByOne:true and this will stand aside.';
}

function loopSawNav(tabId, url) {
  if (!tabId || !url) return;
  const l = loopFor(tabId);
  l.at = url;                                               // so a later read can tell its own pages apart
  if (l.urls.has(url)) { l.armed = false; return; }         // back to a page already seen: not a sweep
  l.urls.add(url);
  l.armed = true;                                           // a read of rows after this completes a cycle
}

function loopSawRead(tabId, rows) {
  if (!tabId || rows <= 1) return;
  const l = loops.get(tabId);
  if (!l || !l.armed) return;
  l.armed = false;
  l.cycles++;
}

function loopRefusal(l) {
  const left = l.urls.size;
  return 'REFUSED — you are doing by hand what page_harvest does in one call.\n'
    + `You have sent this tab to ${l.cycles + 1} different pages and read rows off each. That is a `
    + 'harvest, and continuing costs roughly one model turn per page for the rest of the list.\n'
    + 'Measured on exactly this pattern: 250 pages took 52 minutes and 733 calls, and only 17% of '
    + 'that was the browser — the rest was rows being read out of one reply and typed into the next.\n'
    + 'Call page_harvest instead. It opens the pages in parallel lanes, extracts each one, keeps the '
    + 'rows in the extension and hands back a resultId you finish with results_export:\n'
    + '  page_harvest({ links: "<css for the links on the list page>", tabId: <the list tab>,\n'
    + '                 record: { <one-per-page fields> }, rows: { at: "<repeating row css>", '
    + 'fields: { … } } })\n'
    + 'Pass `urls` instead of `links` if you already hold the addresses. Give neither `record` nor '
    + '`rows` and it reads schema.org, which is often the whole answer.\n'
    + `If these ${left} pages genuinely need visiting one at a time — a login, a form, pages that `
    + 'differ from each other — pass oneByOne:true to tab_here and this will stand aside.';
}

// --- which browser answers ---------------------------------------------------------------------
// THE ROUTING RULES, IN ORDER (research/COMPANION-DESIGN.md "Routing rules"):
//   1. OWNERSHIP WINS. A tabId, runId or resultId belongs to the browser that minted it — a companion
//      tab id means nothing in the person's Chrome and vice versa — so the three maps below are filled
//      from every reply and a call naming one of them goes there, always.
//   2. EXPLICIT `where` next; refused plainly when that browser is off or unavailable.
//   3. DEFAULT IS THE PERSON.
//   4. person -> companion, once per call, when the reply says the page was read in a lane that could
//      not paint (page.frames:false, lanes.held:false, or the op threw about the debugger).
//   5. companion -> person, once per call, when the companion's reply says the page wanted the person
//      (a challenge, a login bounce, or the op threw about signing in).
//   6. Never both in one call; never a results/status call (ownership decides); never a refusal the
//      other browser would give too (those throw messages match neither regex).
const OWN_MAX = 4000;
const tabWhere = new Map();
const runWhere = new Map();
const resultWhere = new Map();
const remember = (map, key, where) => {
  if (key === undefined || key === null || key === '') return;
  if (map.size >= OWN_MAX) map.delete(map.keys().next().value);
  map.set(String(key), where);
};
// Every id a reply carries, top level and one array down (tabs.list, results.list).
function own(where, out) {
  if (!out || typeof out !== 'object') return;
  remember(tabWhere, out.tabId, where);
  remember(runWhere, out.runId, where);
  remember(resultWhere, out.resultId, where);
  for (const t of Array.isArray(out.tabs) ? out.tabs : []) remember(tabWhere, t?.tabId, where);
  for (const r of Array.isArray(out.results) ? out.results : []) remember(resultWhere, r?.resultId, where);
}
function ownerOf(args) {
  if (!args || typeof args !== 'object') return null;
  if (args.tabId !== undefined && args.tabId !== null && tabWhere.has(String(args.tabId))) return tabWhere.get(String(args.tabId));
  for (const k of ['runId', 'retryOf']) if (args[k] && runWhere.has(String(args[k]))) return runWhere.get(String(args[k]));
  if (args.resultId && resultWhere.has(String(args.resultId))) return resultWhere.get(String(args.resultId));
  const first = Array.isArray(args.resultIds) ? args.resultIds.find((id) => resultWhere.has(String(id))) : null;
  return first ? resultWhere.get(String(first)) : null;
}

// The tools a switch may move. `results` (every action) routes by owner only; current_page and
// tabs_list describe the person's desk and have no companion meaning.
const SWITCHABLE = new Set(['tab_here', 'list_extract', 'page_harvest', 'page_study', 'page_grow', 'page_state']);
const UNPAINTED = /debugger|attach|DevTools/i;
const WANTS_PERSON = /log ?in|sign ?in|verify/i;

// A LOGIN BOUNCE, READ OFF TWO URLS — the same structural test `heldForReturn` makes in bridge-ops.js,
// here because `tab.open` (the companion's door) reports only where it landed. A site that bounces
// you keeps your destination in a query parameter to return you afterwards; no vocabulary is needed
// because what is checked is that SOME parameter value decodes to a url holding the PATH asked for.
// Decoded until it stops changing (three passes), because a challenge nests it two redirects deep.
function heldBack(landed, wanted) {
  try {
    const L = new URL(String(landed)); const W = new URL(String(wanted));
    if (L.pathname === W.pathname || W.pathname.length < 4) return false;
    for (const v of L.searchParams.values()) {
      let dec = v;
      for (let i = 0; i < 3; i++) { let n = dec; try { n = decodeURIComponent(dec); } catch (_) { break; } if (n === dec) break; dec = n; }
      if (dec.includes(W.pathname)) return true;
    }
  } catch (_) { /* not urls */ }
  return false;
}

// Why a reply (or a throw) calls for the other browser, or '' when it does not.
function switchWhy(name, where, out, threw, args) {
  if (!SWITCHABLE.has(name)) return '';
  const msg = threw ? String(threw.message || threw) : '';
  if (where === 'person') {
    if (!COMPANION_ON) return '';
    if (out?.lanes?.held === false) return 'lanes.held:false — the debugger hold was unavailable in the person\'s Chrome, so lane tabs there do not paint';
    if (out?.page?.frames === false) return 'page.frames:false — the tab was not painting in the person\'s Chrome';
    // NOT CONNECTED IS ITS OWN REASON. The refusal text below (`noBrowserHere`) contains the word
    // "attached", which UNPAINTED matched, so a session whose extension had not dialled yet was told
    // its DEBUGGER was blocked (2026-09-23, alibaba.com). Switching is still right — a companion is
    // exactly what answers when no person's browser is here — but the why has to say so.
    if (msg && /^No browser connected here/.test(msg)) return 'no browser is connected to this server — the person\'s Chrome has not attached (reload the extension); the companion answered instead';
    if (msg && UNPAINTED.test(msg)) return `the op threw about the debugger in the person's Chrome: ${msg.slice(0, SNIPPET_CHARS)}`;
    return '';
  }
  if (out?.challenge) return `the site showed a check (${out.challenge}) to a browser with no session`;
  if (out?.arrived === false && out?.gate) return `login bounce (${out.gate}) — the page wants the person's session`;
  if (out?.url && args?.url && heldBack(out.url, args.url)) return 'login bounce — the site held the destination to return to, so it wants the person\'s session';
  if (msg && WANTS_PERSON.test(msg)) return `the op threw about signing in: ${msg.slice(0, SNIPPET_CHARS)}`;
  return '';
}


// Where the page is, for the browser that has to open it: the call's own url, else what the loop
// tracker last saw this tab at, else the browser that holds the tab is asked.
async function urlOfTab(where, args, out) {
  if (args?.url) return String(args.url);
  if (out?.url && /^https?:/i.test(String(out.url))) return String(out.url);
  const tabId = Number(args?.tabId);
  if (!tabId) return '';
  const known = loops.get(tabId)?.at;
  if (known) return known;
  const seen = await ask('tabs.list', {}, ASK_QUICK_MS, where).catch(() => null);
  return String((seen?.tabs || []).find((t) => Number(t.tabId) === tabId)?.url || '');
}

// The same op, once more, in the other browser. Returns the reply with `switched` on it.
async function switchTo(name, op, args, from, to, out, why, ms) {
  const url = await urlOfTab(from, args, out);
  if (to === 'companion') {
    await companionEnsure();
    for (const o of new Set([originOf(url), ...originsOf(args)].filter(Boolean))) await companionGrant(o);
  }
  const needsTab = name === 'tab_here' || (args?.tabId !== undefined && args?.tabId !== null);
  let tabId;
  if (needsTab) {
    if (!/^https?:/i.test(url)) throw new Error(`could not switch to the ${to}: the page's url is unknown (${why}). Pass url, or read it from tabs_list first.`);
    const opened = await ask('tab.open', { url }, ASK_OPEN_MS, to);
    own(to, opened);
    tabId = opened.tabId;
    // tab_here IS the open — re-navigating the tab just opened would load the page twice.
    if (name === 'tab_here') return { ...opened, switched: { from, to, why, tabId } };
  }
  const again = { ...args };
  delete again.where;
  if (needsTab) again.tabId = tabId;
  const reply = await ask(op, again, ms, to);
  own(to, reply);
  if (reply && typeof reply === 'object' && !Array.isArray(reply)) {
    reply.switched = { from, to, why, ...(tabId !== undefined ? { tabId } : {}) };
  }
  return reply;
}

// One ask, one possible switch. When the other browser is called for and cannot be had, the
// original answer stands with a hint saying so — rules 4-5 are then skipped, never faked.
async function routed(name, op, args, where, ms) {
  let out; let threw = null;
  try { out = await ask(op, args, ms, where); } catch (e) { threw = e; }
  own(where, out);
  const why = switchWhy(name, where, out, threw, args);
  if (!why) { if (threw) throw threw; return { out, where }; }
  const to = where === 'person' ? 'companion' : 'person';
  try {
    return { out: await switchTo(name, op, args, where, to, out, why, ms), where: to };
  } catch (e) {
    const note = `${why}; the ${to} was tried and could not answer: ${String(e?.message || e).slice(0, FAIL_WHY_MAX_CHARS)}`;
    if (threw) throw new Error(`${threw.message}\n\n${note}`);
    if (out && typeof out === 'object' && !Array.isArray(out)) out.hint = `${out.hint ? `${out.hint}\n` : ''}${note}`;
    return { out, where };
  }
}

async function call(name, args) {
  // WHAT THE SURFACE ANSWERS BY ITSELF, BEFORE ANY OF THE MACHINERY BELOW. An argument the tool does
  // not define is refused with the accepted names instead of being dropped on the way to the browser
  // (`list_extract {page: 3}` used to run an unbounded walk and call it success); `results` with
  // `saveTo` pages the table into a file here; `results action:"guide"` needs no browser at all. The
  // logic lives in tools.mjs `PRE` so this file — mirrored byte-for-byte — holds one call site.
  const pre = await surface.PRE?.(name, args, ask);
  if (pre?.refuse) throw new Error(pre.refuse);
  if (pre?.reply) return asResult(pre.reply, name);
  // THE ONE TOOL THAT NEVER TOUCHES THE BROWSER. Every other name below becomes a browser op and
  // rides `ask()` over the paired socket — that is what the rest of this function is for. This one
  // is a single HTTPS call to a public X endpoint, answerable whether or not Chrome is even open,
  // so it is handled here and returns before any of the browser-specific machinery (pairing state,
  // tab bookkeeping, the loop detector) gets a chance to ask about a browser it does not need.
  if (name === 'resolve_x_video') {
    const statusId = String(args?.statusId || '').trim() || statusIdFromUrl(args?.url);
    if (!statusId) {
      return asResult({ url: null, why: 'give either `url` (an x.com/twitter.com post address) or '
        + '`statusId` (the bare numeric id) — neither was present, or `url` had no /status/<id> in it.' }, name);
    }
    const videoId = String(args?.videoId || '').trim() || null;
    try {
      const url = await resolveXVideo(statusId, videoId);
      return asResult(url
        ? { url, statusId }
        : { url: null, statusId, why: 'the syndication API answered but had no matching video — '
          + 'either this tweet has no video, or the tweet is gone/protected.' }, name);
    } catch (e) {
      return asResult({ url: null, statusId, why: `lookup failed: ${e.message || e}` }, name);
    }
  }
  // A CONSOLIDATED TOOL RESOLVES ITS OWN OP. `results` is one name over five ops, chosen by
  // `action`; every other entry is still a plain string. The branch lives in the surface, not
  // here, so this stays the one place a tool name becomes a browser op.
  const entry = surface.OPS[name];
  const op = typeof entry === 'function' ? entry(args) : entry;
  if (!op) {
    if (typeof entry === 'function') {
      throw new Error(`${name} needs a valid action — got ${JSON.stringify(args?.action ?? null)}`);
    }
    throw new Error(`no such tool: ${name}`);
  }
  // ONE DOOR NOW. `tab_open` was folded into `tab_here` as `newTab`, so a sweep cannot slip past —
  // and a tab per record is the more expensive version, since per-tab state can never accumulate
  // when every page gets a fresh tab. The offer set is keyed on the tab that HANDED the links over,
  // so it holds either way.
  // THE THIRD DOOR, found the hard way. A walk that presses a link navigates too — the tab lands,
  // the walk's own answer is lost, and the caller carries on from `current_page` as if it had meant
  // to go there. Counting only the two explicit navigations left the whole sweep unwatched, which is
  // exactly how a run that already held all fifty addresses went back to one page at a time.
  if (name === 'page_grow' && String(args?.mode || '') === 'walk' && !args?.oneByOne) {
    const l = loops.get(Number(args?.tabId));
    if (l && l.hits >= OFFER_LIMIT) throw new Error(offerRefusal(offers.size));
  }
  if (name === 'tab_here' && !args?.oneByOne) {
    const url = String(args?.url || '');
    const owner = offers.get(url);
    if (owner) {
      const ol = loopFor(owner);
      if (ol.hits >= OFFER_LIMIT) throw new Error(offerRefusal(offers.size));
      ol.hits++;
    }
  }
  if (name === 'tab_here' && !args?.oneByOne) {
    const l = loops.get(Number(args?.tabId));
    if (l && l.cycles >= LOOP_LIMIT && !l.urls.has(String(args?.url || ''))) throw new Error(loopRefusal(l));
  }
  if (name === 'tab_here' && args?.newTab && !/^https?:\/\//i.test(String(args?.url || ''))) {
    throw new Error('url must be http or https');
  }
  // A PSEUDO-PATH WITHOUT ITS PARENTHESES IS THE ONE MISTAKE THAT LOOKS LIKE AN ABSENT FEATURE.
  // Walked as properties, "@dom" is simply a key the window does not have, so the reply is
  // NO_PATH — indistinguishable from a build that never had it. That cost a whole session: the
  // caller tried the bare form, read the refusal as "not supported here", and hand-walked
  // document.body.children[N] for what one call returns. Caught here rather than in the page,
  // because the answer is known without asking the browser anything.
  if (name === 'page_state') {
    const p = String(args?.path || '').trim();
    const bare = /^@(dom|html|map|collect)$/i.exec(p);
    if (bare) {
      const how = { dom: '@dom(<css>)', html: '@html(<css> :: <depth>)',
        map: '@map(<scope css>)', collect: '@collect(<row css> :: <hops> :: <up|down>)' };
      throw new Error(`"${p}" is missing its argument — the parentheses are part of the syntax. `
        + `Did you mean ${how[bare[1].toLowerCase()]}? These pseudo-paths read the rendered page; `
        + `omit path entirely to discover the store instead.`);
    }
  }
  // A TAB THAT VANISHED MID-RUN SHOULD NOT COST A ROUND TRIP TO RECOVER FROM.
  //
  // Every call carries a tabId the caller is holding, and that handle is only valid while the tab
  // is open — a scratch tab is exactly the kind a person tidies away the moment they notice it.
  // When that happens the bare refusal names the dead id and nothing else, so the caller has to
  // stop, call tabs_list, work out which of the survivors it meant, and start again. Measured
  // twice in one session, both times mid-walk.
  //
  // So the refusal is answered here with the live list attached, and the pinned tab called out —
  // a pinned tab is one the person chose to keep, which is the handle that survives.
  //
  // IT DOES NOT RETRY SOMEWHERE ELSE. Picking a replacement tab would mean reading a page nobody
  // asked for, and a scrape of the wrong page is worse than a refusal: it comes back looking like
  // an answer. The caller decides, with the facts in hand.
  // THE THIRD IDENTICAL ATTEMPT IS REFUSED WITHOUT ASKING THE BROWSER.
  //
  // The second is allowed: a page can genuinely change between calls, and a caller who has just
  // fixed something deserves one more go. By the third the evidence is in — same tool, same
  // arguments, same deterministic answer twice — and another round trip cannot produce a different
  // one. Refusing here costs nothing and says what the previous two replies apparently did not.
  //
  // It is escapable by changing ANY argument, which is also the only thing that could help.
  const key = failKey(name, args);
  const seen = failures.get(key);
  if (seen && seen.n >= 2) {
    throw new Error(`This exact call has already failed ${seen.n} times with the same answer, so `
      + 'it was not sent again. Repeating it cannot help — the refusal is about the REQUEST, not '
      + `about the browser.\n\nWhat came back: ${seen.why}\n\n`
      + 'Change something before trying again: narrow the selector, project with fields, ask for '
      + 'fewer rows, or read a different path. Any change to the arguments clears this.');
  }

  // RULES 1-3: the owner of any id named, else the explicit `where`, else the person. `where` is the
  // server's word and never reaches the browser.
  const sent = { ...(args || {}) };
  delete sent.where;
  let where = ownerOf(args) || String(args?.where || 'person');
  if (where !== 'person' && where !== 'companion') throw new Error(`where must be "person" or "companion" — got ${JSON.stringify(args.where)}`);
  if (where === 'companion') {
    await companionEnsure();
    // An explicit ask consents the call's own origins in the companion, the way a switch does.
    for (const o of originsOf(args)) await companionGrant(o);
  }
  let out;
  try {
    ({ out, where } = await routed(name, op, sent, where, surface.timeoutFor(name)));
  } catch (e) {
    const msg = String(e?.message || e);
    // AN OLD EXTENSION AGAINST A NEW SERVER, SAID PLAINLY.
    //
    // These two halves ship separately: the server is an npm package anyone can update on its own,
    // the browser half is an extension that only updates when its owner reloads it. So a tool can
    // exist in the tool list and have no implementation behind it — and the browser's honest reply,
    // `this browser does not know how to "page.harvest"`, reads to a fresh session exactly like a
    // feature that was never built. That misreading has a documented cost in the other direction
    // (a stale TOOL LIST, see the server instructions), and it ends the same way here: the caller
    // concludes the capability is absent and hand-rolls the expensive version of it.
    //
    // It is a version skew and it has a one-line fix, so the error says so.
    if (/does not know how to/i.test(msg)) {
      throw new Error(`${msg}\n\n`
        + 'THIS IS A VERSION SKEW, NOT A MISSING FEATURE. The tool exists in this server; the '
        + 'browser half of HoloScrape is older than it and has no implementation for it yet. The '
        + 'two ship separately — the server is an npm package, the extension updates only when its '
        + 'owner reloads it.\n'
        + 'Ask the person to reload the HoloScrape extension (chrome://extensions → reload), then '
        + 'try again. Do NOT conclude the capability is absent and do NOT hand-roll it — the '
        + 'workaround is usually an order of magnitude more expensive than the tool.');
    }
    const gone = /there is no tab/i.test(msg);
    // A tab that vanished is transient — the caller reopens or repoints and tries again.
    if (!gone) { if (DETERMINISTIC.test(msg)) rememberFailure(key, msg.slice(0, FAIL_WHY_MAX_CHARS)); throw e; }
    let open = [];
    let pinned = null;
    try {
      const seen = await ask('tabs.list', {}, ASK_QUICK_MS, where);
      open = (seen?.tabs || []).map((t) => `${t.tabId} ${t.title || t.url || ''}`.slice(0, TAB_LINE_CHARS));
      pinned = seen?.pinned ?? null;
    } catch (_) { /* the browser is gone too; the original message still stands */ }
    throw new Error(`${e.message}\n\n`
      + (open.length
        ? `Open now:\n  ${open.join('\n  ')}\n\n`
        : 'No http(s) tabs are open.\n\n')
      + (pinned
        ? `Tab ${pinned} is pinned in the HoloScrape panel — current_page resolves to it and it `
          + 'will not disappear under you. Prefer it for anything long-running.'
        : 'Nothing is pinned. For a run of any length, ask the person to pin the tab they mean in '
          + 'the HoloScrape panel, then use current_page — a held tabId dies with the tab.')
      + (name === 'page_grow' && args?.mode === 'walk' ? '\nA walk resumes from its offset; it does not start over.' : ''));
  }
  // THE TOOL GRAPH, ATTACHED TO THE REPLY THAT PROVES IT. See NEXT in tools.mjs for why the edges
  // live on replies rather than in descriptions.
  //
  // THE EXTENSION WINS. It measured the page and can say things no amount of reading the reply
  // would reveal — that a rail held 23 entries while the extractor returned 1, that a container is
  // collapsed rather than virtualized, that the pane never moved. When a reply already carries
  // `next`, it came from there and is better than anything derivable here, so it is left alone.
  //
  // Silence is the common case: every edge returns null unless something is about to go wrong.
  // WRITTEN TO `hint`, NEVER TO `next`. `next` was already taken: page_state and a walk
  // return it as a PAGINATION CURSOR — the offset to pass back to continue. Putting a
  // sentence there made one field mean two things depending on which tool answered, and quietly
  // suppressed the hint on exactly the paginated replies where it matters most. Caught on the
  // first live call after wiring it, which is what live calls are for.
  // A `switched` reply gets its line even beside an extension hint — which browser answered is the
  // one fact the extension cannot know; NEXT keeps the extension's words under it.
  if (out && typeof out === 'object' && !Array.isArray(out) && !out.error && (out.hint == null || out.switched)) {
    try {
      const edge = surface.NEXT?.[name]?.(out, args);
      if (edge) out.hint = edge;
    } catch (_) { /* a hint that throws must never cost the caller their result */ }
  }
  const res = asResult(out, name);
  // REPLY_TOO_BIG comes back as an error-shaped RESULT, not a throw, so it needs recording here
  // or the identical call is free to repeat forever — which is exactly what happened.
  if (res.isError) rememberFailure(key, String(res.content?.[0]?.text || '').slice(0, FAIL_WHY_MAX_CHARS));
  return res;
}

// The client's own version is echoed back. A simple server has no reason to argue about a revision
// it does not use any feature of, and guessing the current one wrongly is how a working server
// refuses to start.
function hello(msg, reply) {
  // Learned once, kept for the life of the process — a released connection can be reconnected without
  // the agent re-announcing itself, and the row it left behind should still say who it was.
  CLIENT_INFO = msg.params?.clientInfo || CLIENT_INFO;
  // THE EXTENSION MAY ALREADY BE CONNECTED. `initialize` is the agent talking to THIS process over
  // stdio — nothing to do with the browser socket — so if one is already attached, tell it who just
  // showed up rather than waiting for its next reconnect to find out.
  for (const b of Object.values(browsers)) {
    if (b.sock) { try { b.sock.write(frame(JSON.stringify({ type: 'identity', session: SESSION, client: CLIENT_INFO }))); } catch (_) {} }
  }
  reply({
    protocolVersion: msg.params?.protocolVersion || MCP_PROTOCOL_VERSION,
    // listChanged, because the watcher below can genuinely send one. Declaring it without meaning
    // it would be worse than silence: a client would trust a notification that never arrives.
    // `resources` is the long doctrine, on demand — see `GUIDE` below.
    capabilities: { tools: { listChanged: true }, resources: {} },
    serverInfo: { name: 'holoscrape', version: VERSION },
    // ONLY THE BRIEF RIDES THE HANDSHAKE. The whole manual used to: 27,561 chars, of which Claude
    // Code keeps about the first 2,300 — so 18 of its 19 sections reached nobody while every session
    // paid for them. BRIEF is what must be known before a first call and how to fetch the rest; the
    // doctrine is served on demand (`GUIDE` below, and results action:"guide" in tools.mjs). The
    // whole string stays under 2,000 chars so it survives that cut intact —
    // test/mcp-surface-budget.mjs holds it there.
    //
    // THE BUILD IDENTITY IS APPENDED, and it is the cheapest fix for the worst failure this server
    // has. A client caches the tool list when the session starts; edit this package and the running
    // process is a version nobody can see. An agent that is TOLD it should be holding 10 tools, and
    // counts 7, knows in one step that the answer is a reconnect and not a workaround. Without
    // that line the only symptom is a tool that "does not exist", which is indistinguishable from
    // one that was never built — and a session was lost to exactly that.
    // The companion sentence rides only when the companion is on: a line about a browser that does
    // not exist in this session is the kind of unconditional text the diet removed.
    instructions: `${BRIEF}${COMPANION_ON ? `\n\n${BRIEF_COMPANION}` : ''}\n\nholoscrape-mcp ${VERSION}, ${surface.TOOLS.length} tools: `
      + `${surface.TOOLS.map((t) => t.name).join(', ')}. If your tool list is missing any of these it `
      + 'was cached before this server started: reconnect the MCP server rather than working around the gap.',
  });
  // Armed after the handshake rather than at startup, so a `--code` run or a crashed client never
  // leaves a file watcher behind.
  watchTools();
}

// WHERE THE TIME GOES, RECORDED RATHER THAN ARGUED ABOUT.
//
// A 250-film scrape took 52m33s and the only way anyone could say why was to reconstruct timestamps
// out of six session transcripts by hand. The answer, once measured, was not what any of us guessed:
// the browser was 17% of it and the model typing rows was ~80%. That is a large enough surprise to
// be worth never having to guess again.
//
// This records the HALVES SEPARATELY, which is the whole point. `browserMs` is what the extension
// took; `ms` is the whole tool call. The difference between one call's `ms` and the NEXT call's
// start is the model's own turn — the part no instrument inside this process can see, and the part
// that turned out to dominate. A trace with only totals cannot tell those apart, and that confusion
// is exactly what cost the afternoon.
//
// Off unless HOLOSCRAPE_TRACE names a file, so the normal path pays one undefined check. Appended as
// NDJSON because a run that is killed half way through should still leave readable rows.
const TRACE = process.env.HOLOSCRAPE_TRACE || '';
function trace(row) {
  if (!TRACE) return;
  try { fs.appendFileSync(TRACE, `${JSON.stringify(row)}\n`); } catch (_) { /* never break a call to log it */ }
}

async function callTool(msg, reply) {
  const name = msg.params?.name || '';
  const args = msg.params?.arguments || {};
  const t0 = Date.now();
  const spent0 = browserMs.spent;
  const answer = (out, failed) => {
    const text = out?.content?.[0]?.text ?? '';
    // The loop detector reads the same reply the trace measures, so watching costs one parse of a
    // string that is already in hand. A reply that will not parse simply teaches it nothing.
    if (!failed) {
      try {
        const v = JSON.parse(text);
        if (name === 'tab_here') loopSawNav(Number(args?.tabId), String(v?.url || args?.url || ''));
        // A walk that MOVED counts as a visit, whether it says so proudly or reports CROSS_DOCUMENT.
        // Either way the tab is on one of the offered pages, which is the thing being counted.
        else if (name === 'page_grow' && args?.mode === 'walk') {
          const found = new Set();
          offerScan(v, found);
          for (const u of found) {
            const owner = offers.get(u);
            if (owner) { loopFor(owner).hits++; break; }
          }
        }
        else if (/^page_(state|read|html|study|explore)$|^list_extract$|^results_get$/.test(name)) {
          const rows = Array.isArray(v?.rows) ? v.rows.length
            : Array.isArray(v?.value?.items) ? v.value.items.length : 0;
          loopSawRead(Number(args?.tabId), rows);
          // EVERY read, not just the ones that look like lists. The addresses are what matter, and a
          // caller who is about to sweep does not announce which tool it used to collect them.
          loopSawOffer(Number(args?.tabId), v);
        }
      } catch (_) { /* not JSON — nothing to learn, and never a reason to fail the call */ }
    }
    trace({
      at: new Date(t0).toISOString(),
      tool: name,
      ms: Date.now() - t0,
      browserMs: browserMs.spent - spent0,
      argsBytes: JSON.stringify(args).length,
      replyBytes: String(text).length,
      ...(failed ? { failed: String(failed).slice(0, SNIPPET_CHARS) } : {}),
    });
    reply(out);
  };
  try {
    answer(await call(name, args));
  } catch (e) {
    // A TOOL THAT FAILED IS NOT A PROTOCOL ERROR. Reported as a result the model can read
    // and act on — "no browser connected, ask the person to open Chrome" is something it
    // can relay; a JSON-RPC error code is something it can only give up on.
    answer({ content: [{ type: 'text', text: String(e.message || e) }], isError: true }, e.message || e);
  }
}

const GUIDE = { uri: 'holoscrape://guide', name: 'HoloScrape operating guide', mimeType: 'text/markdown',
  description: 'The full doctrine, organised by situation: page readiness, counting lists, harvesting, '
    + 'page_state pseudo-paths, what to do when a site pushes back. Also results action:"guide".' };

// A lookup rather than a switch: one named function per method, and adding one is adding a line
// here instead of another `case` in a block that only grows.
const METHODS = {
  initialize: hello,
  // Deliberately nothing. The client announcing it has finished initialising needs no answer —
  // an empty handler is the whole correct behaviour, not an unfinished one.
  'notifications/initialized': () => {},
  'tools/list': (_msg, reply) => reply({ tools: surface.TOOLS }),
  'tools/call': callTool,
  // THE DOCTRINE, WHOLE, FOR A CLIENT THAT READS RESOURCES. One resource, so there is nothing to
  // page and nothing to template. A client without resource support reaches the same text a section
  // at a time through results action:"guide"; one that loads skills has it as skill/SKILL.md.
  'resources/list': (_msg, reply) => reply({ resources: [GUIDE] }),
  'resources/read': (msg, reply) => {
    if (msg.params?.uri !== GUIDE.uri) throw new Error(`no such resource: ${msg.params?.uri} — this server has one, ${GUIDE.uri}`);
    reply({ contents: [{ uri: GUIDE.uri, mimeType: GUIDE.mimeType, text: INSTRUCTIONS }] });
  },
  ping: (_msg, reply) => reply({}),
};

// --- live tool surface -----------------------------------------------------------------------
// Watch tools.mjs and swap the box when it changes, then tell the client its list is stale.
//
// WHY A CACHE-BUSTING QUERY. ESM caches a module by specifier forever; there is no delete-from-
// cache. Importing './tools.mjs?v=<mtime>' is a different specifier, so it is genuinely re-read.
// The old copy stays in memory, which is a few hundred KB per edit and only ever during
// development — the tradeoff nobody notices against a reconnect nobody remembers to do.
//
// A FAILED RELOAD KEEPS THE OLD SURFACE. A half-saved file is a syntax error, and swapping in a
// broken list would take the tools away from a session that was working. It logs to stderr and
// leaves everything as it was.
//
// Only armed once a client is talking to us, and only when the file is actually watchable —
// under `npx` the package sits in a read-only cache that will never change, so the watcher is
// pure cost there and quietly does not start.
let watching = false;
function watchTools() {
  if (watching) return;
  watching = true;
  const here = path.dirname(new URL(import.meta.url).pathname);
  const file = path.join(here, 'tools.mjs');
  let last = 0;
  try {
    fs.watch(file, () => {
      // fs.watch fires more than once for a single save on most platforms; collapse the burst.
      const now = Date.now();
      if (now - last < RELOAD_DEBOUNCE_MS) return;
      last = now;
      setTimeout(async () => {
        try {
          const fresh = await import(`./tools.mjs?v=${now}`);
          if (!Array.isArray(fresh.TOOLS) || !fresh.TOOLS.length) throw new Error('empty tool list');
          const before = surface.TOOLS.length;
          surface.TOOLS = fresh.TOOLS;
          surface.OPS = fresh.OPS;
          surface.SLOW = fresh.SLOW;
          surface.timeoutFor = fresh.timeoutFor;
          surface.NEXT = fresh.NEXT;
          surface.PRE = fresh.PRE;
          send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
          say(`tools reloaded: ${before} -> ${fresh.TOOLS.length}`);
        } catch (e) {
          say(`tools reload failed, keeping the previous surface: ${e.message || e}`);
        }
      }, RELOAD_SETTLE_MS);   // let the editor finish writing before reading it back
    });
  } catch (_) { /* not watchable — an installed copy never changes anyway */ }
}

async function dispatch(msg) {
  // A notification has no id and takes no answer. Replying to one is a protocol error.
  const reply = (result) => { if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result }); };
  const fail = (code, message) => {
    if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  };
  const handler = METHODS[msg.method];
  if (!handler) return fail(RPC_METHOD_NOT_FOUND, `unknown method: ${msg.method}`);
  try { await handler(msg, reply); } catch (e) { fail(RPC_INTERNAL_ERROR, String(e.message || e)); }
}

function parse(one) {
  try { return JSON.parse(one); } catch (_) { return null; }
}

let line = '';
process.stdin.on('data', async (chunk) => {
  line += chunk.toString('utf8');
  for (let cut = line.indexOf('\n'); cut >= 0; cut = line.indexOf('\n')) {
    const one = line.slice(0, cut).trim();
    line = line.slice(cut + 1);
    const msg = one ? parse(one) : null;
    if (msg) await dispatch(msg);
  }
});

// --- start -------------------------------------------------------------------------------------
// THE PORT IS READ FROM THE SOCKET, AND ANNOUNCED EXACTLY ONCE.
//
// `srv.listen(port, host, cb)` registers cb with `once('listening')`. A bind that fails with
// EADDRINUSE never fires that event, so the callback stays armed — and then the retry adds another
// one. When a later port finally succeeds, EVERY callback still queued fires, oldest first, each
// announcing the port ITS OWN attempt asked for rather than the port actually obtained.
//
// Measured: three servers started against one range each announced "listening on 127.0.0.1:29182"
// as their first line, including the two that were not on it. The previous attempt at this —
// `if (bound) return` inside the retry — could not work, because that guard is in a function which
// is never re-entered after success, while the stale callbacks live on the server object.
//
// So no callback is passed to listen() at all: success is handled by the one `once('listening')`
// registered here, and the port comes from the bound socket rather than from the loop variable that
// merely asked for it. Everything downstream that needs to know where this process ended up — the
// peer scan behind a "no browser" failure, the line a person reads to tell two servers apart — is
// then reading a fact instead of an intention.
srv.once('listening', () => {
  MINE.at = srv.address()?.port || 0;
  say(`${VERSION} listening on ${LOOPBACK_HOST}:${MINE.at}`);
  say('');
  say(`  pairing code:  ${PAIR}`);
  say('');
  say('  Open the HoloScrape side panel in Chrome and enter it once.');
  say('');
});

// A FULL POOL MUST NOT TAKE THE TOOLS WITH IT.
//
// This used to `process.exit(1)`. Exiting kills stdio, so the client registers ZERO tools and says
// nothing about why — and an agent in that session has no way to learn that HoloScrape was ever
// meant to exist. Measured: a session asked to scrape a page went looking for a browser, found no
// holoscrape tools in its list, and only discovered the cause by reading `index.mjs` and
// `bridge-window.js` out of the repository. It then reported "HoloScrape is genuinely unavailable",
// which was true, and unlearnable from anything the tool itself said.
//
// Losing the browser is unavoidable when there is no port to be reached on. Losing the TOOLS is not:
// the process keeps serving stdio, every tool stays listed, and each call answers with the cause and
// the one action that fixes it. A capability that explains its own absence costs one honest error; a
// capability that vanishes costs a session.
let POOL_FULL = false;

function listen(i = 0) {
  if (i >= PORT_SPAN) {
    POOL_FULL = true;
    say(`ports ${PORT_BASE}-${PORT_BASE + PORT_SPAN - 1} are all busy — is another holoscrape-mcp running?`);
    say('  Tools stay listed and every call will say this, rather than the session losing them silently.');
    return;
  }
  srv.once('error', (e) => (e.code === 'EADDRINUSE' ? listen(i + 1) : (say(String(e.message)), process.exit(1))));
  srv.listen(PORT_BASE + i, LOOPBACK_HOST);
}
listen();

// The companion's profile and temp build go with the process: a headless Chromium nobody can see
// must never outlive the server that launched it, and a profile left behind is a directory of
// somebody else's page content.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { srv.close(); closeCompanion().then(() => process.exit(0), () => process.exit(0)); });
}
