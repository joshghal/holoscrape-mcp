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
const PORT_SPAN = 4;
// Which port this process actually got, filled in by listen(). Needed so a peer scan can tell a
// neighbour's server from its own listener, and so a failure can name where it is.
const MINE = { at: 0 };

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
    if (held?.token?.length >= 8) return held.token;
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
let live = null;                 // the one connected extension
const waiting = new Map();       // id -> {resolve, reject, timer}
let seq = 0;

// A REAL CLOSE FRAME, sendable only because the handshake below now always completes first.
// RFC 6455 §5.5.1: a close frame is protocol data, and protocol data does not exist before the
// protocol has started — which is the whole reason this file no longer rejects a bad token with a
// raw HTTP 401 ahead of the 101 response. Payload is the 2-byte status code, big-endian, plus an
// optional UTF-8 reason; capped well under the 125-byte control-frame limit.
function closeFrame(code, reason = '') {
  const text = Buffer.from(reason, 'utf8').subarray(0, 100);
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
    if (op === 0x8) { state.kill = 'closed'; return out; }
    if (op === 0x9 || op === 0xa) continue;               // ping/pong: nothing to carry
    state.parts.push(body);
    if (!fin) continue;                                   // more parts of this message still coming
    out.push(Buffer.concat(state.parts).toString('utf8'));
    state.parts = [];
  }
  return out;
}

const srv = http.createServer((_req, res) => { res.writeHead(404); res.end(); });

// THE SAME REFUSAL, FROM BOTH PLACES THAT CAN REFUSE. A real close frame, then a moment for it to
// reach the client before the TCP socket dies underneath it — without the pause this degrades back
// into the abrupt, indistinguishable code-1006 close that the handshake ordering below exists to
// avoid. It was written twice, identically, which is one edit away from being written differently.
function refuse(sock, code, reason) {
  try { sock.write(closeFrame(code, reason)); } catch (_) {}
  setTimeout(() => sock.destroy(), 50);
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
    refuse(sock, 4001, 'wrong pairing code');
    return false;
  }
  if (msg.token !== PAIR) {
    say('refused a connection with the wrong pairing code');
    refuse(sock, 4001, 'wrong pairing code');
    return false;
  }
  say(`extension connected — ${msg.version || 'unknown version'}`);
  welcome();
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
function take(sock, conn, welcome, text) {
  let msg = null;
  try { msg = JSON.parse(text); } catch (_) { return true; }
  if (!conn.paired) return greet(sock, conn, welcome, msg);
  if (msg.type === 'pong' || msg.type === 'hello') return true;
  settle(msg);
  return true;
}

function onData(sock, state, conn, welcome, chunk) {
  state.buf = Buffer.concat([state.buf, chunk]);
  for (const text of unframe(state)) if (!take(sock, conn, welcome, text)) return;
  if (!state.kill) return;
  if (state.kill !== 'closed') say(`dropped a connection: ${state.kill}`);
  sock.destroy();
}

function failWaiter(id, held) {
  clearTimeout(held.timer);
  held.reject(new Error('the extension disconnected mid-call'));
  waiting.delete(id);
}

function onGone(sock) {
  if (live === sock) { live = null; say('extension disconnected'); }
  for (const [id, held] of waiting) failWaiter(id, held);
}

// Everything that belongs to one accepted connection.
function attach(sock, atUpgrade) {
  const state = { buf: Buffer.alloc(0), parts: [], kill: '' };
  const conn = { paired: false };
  // A message the extension can BELIEVE. Nothing was ever sent on success before, so the only
  // evidence of pairing available to the panel was the socket opening — which is why it drew
  // "Connected" for a handshake that had not happened yet.
  const welcome = () => {
    conn.paired = true;
    live = sock;
    beat(sock);
    try { sock.write(frame(JSON.stringify({ type: 'welcome', server: 'holoscrape' }))); } catch (_) {}
  };
  if (atUpgrade) { say('extension connected (authenticated at upgrade)'); welcome(); }
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
  const wrongAtUpgrade = bearing && bearing.slice(TOKEN_PROTO.length) !== PAIR;

  openHandshake(sock, key, bearing);
  if (!wrongAtUpgrade) return attach(sock, !!bearing);
  say('refused an upgrade with the wrong pairing code');
  refuse(sock, 4001, 'wrong pairing code');
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
  if (live !== sock) return clearInterval(timer);
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
    const s = net.connect({ port: at, host: '127.0.0.1' });
    const done = (yes) => { try { s.destroy(); } catch (_) {} resolve(yes); };
    s.setTimeout(300, () => done(false));
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
  return `No browser connected here (127.0.0.1:${MINE.at || '?'}), and ${others.length === 1
    ? `another agent session's server is also listening, on 127.0.0.1:${others[0]}`
    : `other agent sessions' servers are also listening, on 127.0.0.1:${others.join(', ')}`}.\n`
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

function ask(op, args, ms = 30000) {
  if (!live) return whyNoBrowser().then((why) => Promise.reject(new Error(why)));
  const id = ++seq;
  // Timed so the trace can separate what the BROWSER took from what the whole call took. Charged
  // on both paths, because a call that timed out still spent the time.
  const t0 = Date.now();
  const charge = () => { browserMs.spent += Date.now() - t0; };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => giveUp(id, op, ms, reject), ms);
    waiting.set(id, { resolve, reject, timer });
    live.write(frame(JSON.stringify({ id, op, args })));
  }).then((v) => { charge(); return v; }, (e) => { charge(); throw e; });
}

// --- the agent end: MCP over stdio ---------------------------------------------------------------
// Newline-delimited JSON-RPC 2.0 — one message per line, which is what MCP's stdio transport is.
// stdout carries protocol and NOTHING else; every human-readable word goes to stderr, because a
// stray console.log here corrupts the stream and the failure looks like the agent going mad.
const say = (s) => process.stderr.write(`holoscrape-mcp: ${s}\n`);
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

import { TOOLS as TOOLS0, OPS as OPS0, SLOW as SLOW0, NEXT as NEXT0, timeoutFor as timeoutFor0 } from './tools.mjs';
import { INSTRUCTIONS } from './guidance.mjs';

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
const surface = { TOOLS: TOOLS0, OPS: OPS0, SLOW: SLOW0, NEXT: NEXT0, timeoutFor: timeoutFor0 };

// READ FROM package.json RATHER THAN TYPED HERE. A version in two places is a version that will
// disagree with itself, and the whole point of reporting it is that it is trustworthy.
const VERSION = (() => {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    return JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version || '0.0.0';
  } catch (_) { return '0.0.0'; }
})();


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
  page_state: 'fields to keep only the columns you need, then limit/offset to page the rest.',
  results_get: 'columns:["..."] to keep only the columns you need, then limit.',
};

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
  const sample = rows?.[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]).slice(0, 40) : null;

  return {
    content: [{ type: 'text', text: JSON.stringify({
      error: 'REPLY_TOO_BIG',
      bytes: text.length,
      limit: MAX_REPLY,
      rows: rows ? rows.length : undefined,
      fieldsOnFirstRow: sample || undefined,
      why: 'Nothing was returned. A reply this size cannot be read, and returning the front of it '
        + 'would look like the whole answer — so the request has to get smaller, not the response.',
      tell: SMALLER[name] || 'ask for less: a narrower selector, fewer rows, or a shallower read.',
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
  if (v === null || v === undefined || depth > 6 || into.size >= OFFER_SCAN) return;
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

async function call(name, args) {
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

  let out;
  try {
    out = await ask(op, args || {}, surface.timeoutFor(name));
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
    if (!gone) { if (DETERMINISTIC.test(msg)) rememberFailure(key, msg.slice(0, 300)); throw e; }
    let open = [];
    let pinned = null;
    try {
      const seen = await ask('tabs.list', {}, 10000);
      open = (seen?.tabs || []).map((t) => `${t.tabId} ${t.title || t.url || ''}`.slice(0, 90));
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
  if (out && typeof out === 'object' && !Array.isArray(out) && !out.error && out.hint == null) {
    try {
      const edge = surface.NEXT?.[name]?.(out);
      if (edge) out.hint = edge;
    } catch (_) { /* a hint that throws must never cost the caller their result */ }
  }
  const res = asResult(out, name);
  // REPLY_TOO_BIG comes back as an error-shaped RESULT, not a throw, so it needs recording here
  // or the identical call is free to repeat forever — which is exactly what happened.
  if (res.isError) rememberFailure(key, String(res.content?.[0]?.text || '').slice(0, 300));
  return res;
}

// The client's own version is echoed back. A simple server has no reason to argue about a revision
// it does not use any feature of, and guessing the current one wrongly is how a working server
// refuses to start.
function hello(msg, reply) {
  reply({
    protocolVersion: msg.params?.protocolVersion || '2025-06-18',
    // listChanged, because the watcher below can genuinely send one. Declaring it without meaning
    // it would be worse than silence: a client would trust a notification that never arrives.
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: 'holoscrape', version: VERSION },
    // THE OPERATING MANUAL RIDES THE HANDSHAKE. A tool description can only say what ONE tool is
    // for; the facts that cost whole sessions are cross-cutting — which layer to read second, that
    // a cached tool list hides new tools, that a new tab litters, that a virtualized list recycles
    // rather than ends. There is nowhere else to put them that reaches a stranger's machine, and a
    // client that ignores `instructions` is no worse off than before.
    //
    // THE BUILD IDENTITY IS APPENDED, and it is the cheapest fix for the worst failure this server
    // has. A client caches the tool list when the session starts; edit this package and the running
    // process is a version nobody can see. An agent that is TOLD it should be holding 18 tools, and
    // counts 14, knows in one step that the answer is a reconnect and not a workaround. Without
    // that line the only symptom is a tool that "does not exist", which is indistinguishable from
    // one that was never built — and a session was lost to exactly that.
    instructions: `${INSTRUCTIONS}\n\n# This build\n\nholoscrape-mcp ${VERSION}, serving `
      + `${surface.TOOLS.length} tools: ${surface.TOOLS.map((t) => t.name).join(', ')}.\n`
      + `If your tool list is missing any of these, it was cached before this server started — `
      + `reconnect the MCP server rather than working around the gap. Paths on an existing tool `
      + `(see page_state) are reachable either way.`,
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
      ...(failed ? { failed: String(failed).slice(0, 120) } : {}),
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

// A lookup rather than a switch: one named function per method, and adding one is adding a line
// here instead of another `case` in a block that only grows.
const METHODS = {
  initialize: hello,
  // Deliberately nothing. The client announcing it has finished initialising needs no answer —
  // an empty handler is the whole correct behaviour, not an unfinished one.
  'notifications/initialized': () => {},
  'tools/list': (_msg, reply) => reply({ tools: surface.TOOLS }),
  'tools/call': callTool,
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
      if (now - last < 300) return;
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
          send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
          say(`tools reloaded: ${before} -> ${fresh.TOOLS.length}`);
        } catch (e) {
          say(`tools reload failed, keeping the previous surface: ${e.message || e}`);
        }
      }, 60);   // let the editor finish writing before reading it back
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
  if (!handler) return fail(-32601, `unknown method: ${msg.method}`);
  try { await handler(msg, reply); } catch (e) { fail(-32603, String(e.message || e)); }
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
  say(`listening on 127.0.0.1:${MINE.at}`);
  say('');
  say(`  pairing code:  ${PAIR}`);
  say('');
  say('  Open the HoloScrape side panel in Chrome and enter it once.');
  say('');
});

function listen(i = 0) {
  if (i >= PORT_SPAN) {
    say(`ports ${PORT_BASE}-${PORT_BASE + PORT_SPAN - 1} are all busy — is another holoscrape-mcp running?`);
    process.exit(1);
  }
  srv.once('error', (e) => (e.code === 'EADDRINUSE' ? listen(i + 1) : (say(String(e.message)), process.exit(1))));
  srv.listen(PORT_BASE + i, '127.0.0.1');
}
listen();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { srv.close(); process.exit(0); });
