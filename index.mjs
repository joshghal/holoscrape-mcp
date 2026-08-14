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

// Returns complete messages and keeps whatever is left over. A browser client always masks, so
// the mask is required rather than optional — an unmasked frame from a client is a protocol error
// and here it means something other than our extension is talking.
function unframe(state) {
  const out = [];
  for (;;) {
    const b = state.buf;
    if (b.length < 2) break;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let at = 2;
    if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); at = 4; } else if (len === 127) {
      if (b.length < 10) break;
      const big = b.readBigUInt64BE(2);
      if (big > 8n * 1024n * 1024n) { state.kill = 'frame too large'; return out; }
      len = Number(big); at = 10;
    }
    if (!masked) { state.kill = 'unmasked frame from a client'; return out; }
    if (b.length < at + 4 + len) break;
    const key = b.subarray(at, at + 4);
    const body = Buffer.from(b.subarray(at + 4, at + 4 + len));
    for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
    state.buf = b.subarray(at + 4 + len);
    if (op === 0x8) { state.kill = 'closed'; return out; }
    if (op === 0x9 || op === 0xa) continue;               // ping/pong: nothing to carry
    state.parts.push(body);
    if (fin) {
      out.push(Buffer.concat(state.parts).toString('utf8'));
      state.parts = [];
    }
  }
  return out;
}

const srv = http.createServer((_req, res) => { res.writeHead(404); res.end(); });

srv.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return sock.destroy();

  // THE TOKEN IS CHECKED BEFORE THE SOCKET OPENS, NOT AFTER.
  //
  // It used to be the first MESSAGE on an already-open socket, and that one detail is why the panel
  // could sit there reading "Connected — 127.0.0.1:27182" while this end had no live extension at
  // all: `onopen` fired for the person the moment TCP came up, and whether the code was any good was
  // decided a round-trip later, in silence. This file's own note said the difference between the
  // socket and the handshake "is the whole of 'it is connected but nothing works'" — and then the
  // code shipped the version that cannot tell them apart.
  //
  // Read from the WebSocket SUBPROTOCOL, which the browser sends inside the upgrade request, so a
  // wrong code never reaches 101 and `onopen` becomes proof of pairing rather than proof of TCP.
  // (Learned from figma-agent-bridge, which does exactly this and whose connected light therefore
  // cannot lie.)
  const offered = String(req.headers['sec-websocket-protocol'] || '')
    .split(',').map((x) => x.trim()).filter(Boolean);
  const bearing = offered.find((p) => p.startsWith(TOKEN_PROTO));
  let atUpgrade = false;
  if (bearing) {
    if (bearing.slice(TOKEN_PROTO.length) !== PAIR) {
      // 401 rather than a silent destroy: the extension can tell "wrong code" from "nothing there"
      // and must NOT sit in a retry loop with a token it now knows is bad.
      say('refused an upgrade with the wrong pairing code');
      sock.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return sock.destroy();
    }
    atUpgrade = true;
  }

  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
    + (bearing ? `Sec-WebSocket-Protocol: ${bearing}\r\n` : '')
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);

  const state = { buf: Buffer.alloc(0), parts: [], kill: '' };
  let paired = false;

  // A message the extension can BELIEVE. Nothing was ever sent on success before, so the only
  // evidence of pairing available to the panel was the socket opening — which is why it drew
  // "Connected" for a handshake that had not happened yet.
  const welcome = () => {
    paired = true;
    live = sock;
    beat(sock);
    try { sock.write(frame(JSON.stringify({ type: 'welcome', server: 'holoscrape' }))); } catch (_) {}
  };
  if (atUpgrade) { say('extension connected (authenticated at upgrade)'); welcome(); }
  sock.on('data', (chunk) => {
    state.buf = Buffer.concat([state.buf, chunk]);
    for (const text of unframe(state)) {
      let msg;
      try { msg = JSON.parse(text); } catch (_) { continue; }
      // THE FIRST MESSAGE IS THE TOKEN AND NOTHING ELSE HAPPENS BEFORE IT.
      if (!paired) {
        if (msg.type !== 'hello' || msg.token !== PAIR) {
          say(`refused a connection with the wrong pairing code`);
          return sock.destroy();
        }
        say(`extension connected — ${msg.version || 'unknown version'}`);
        welcome();
        continue;
      }
      if (msg.type === 'pong' || msg.type === 'hello') continue;
      const held = waiting.get(msg.id);
      if (!held) continue;
      waiting.delete(msg.id);
      clearTimeout(held.timer);
      if (msg.error) held.reject(new Error(msg.error));
      else held.resolve(msg.result);
    }
    if (state.kill) {
      if (state.kill !== 'closed') say(`dropped a connection: ${state.kill}`);
      sock.destroy();
    }
  });
  const gone = () => {
    if (live === sock) { live = null; say('extension disconnected'); }
    for (const [id, held] of waiting) {
      clearTimeout(held.timer);
      held.reject(new Error('the extension disconnected mid-call'));
      waiting.delete(id);
    }
  };
  sock.on('close', gone);
  sock.on('error', gone);
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
function beat(sock) {
  let missed = 0;
  const timer = setInterval(() => {
    if (live !== sock) return clearInterval(timer);
    if (++missed > BEAT_MISSES) {
      clearInterval(timer);
      say('no heartbeat reply — dropping the connection');
      return sock.destroy();
    }
    try { sock.write(frame(JSON.stringify({ type: 'ping' }))); } catch (_) { clearInterval(timer); }
  }, BEAT_MS);
  sock.on('close', () => clearInterval(timer));
  sock.on('data', () => { missed = 0; });
}

function ask(op, args, ms = 30000) {
  if (!live) {
    return Promise.reject(new Error(
      'No browser connected. Open Chrome with the HoloScrape extension installed, '
      + 'then pair it in the side panel.'));
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`the browser did not answer "${op}" within ${Math.round(ms / 1000)}s`));
    }, ms);
    waiting.set(id, { resolve, reject, timer });
    live.write(frame(JSON.stringify({ id, op, args })));
  });
}

// --- the agent end: MCP over stdio ---------------------------------------------------------------
// Newline-delimited JSON-RPC 2.0 — one message per line, which is what MCP's stdio transport is.
// stdout carries protocol and NOTHING else; every human-readable word goes to stderr, because a
// stray console.log here corrupts the stream and the failure looks like the agent going mad.
const say = (s) => process.stderr.write(`holoscrape-mcp: ${s}\n`);
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

const T = (name, description, props = {}, required = []) => ({
  name, description,
  inputSchema: { type: 'object', properties: props, required, additionalProperties: false },
});
const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const N = (description) => ({ type: 'number', description });
const B = (description) => ({ type: 'boolean', description });

// ELEVEN VERBS, AND NOT ONE OF THEM TAKES CODE. See `bridge-ops.js` — a tool that accepted a
// script body would be an MV3 remote-code rejection and would also hand arbitrary execution inside
// a signed-in browser to whatever a poisoned page talked this agent into.
//
// The descriptions are written for a model deciding WHICH to call, so each says what it is for
// rather than what it does, and names the tool that comes next.
const TOOLS = [
  T('current_page',
    'The page the person is looking at right now, and what can be extracted from it. Takes no '
    + 'arguments — use this for "I have a page open, scrape it". Returns a tabId to pass to '
    + 'site_probe or list_extract. Honours a page the person pinned in the HoloScrape panel; '
    + 'otherwise it is the active tab of their last-used Chrome window.'),

  T('search_open',
    'Turn a request like "restaurants in cimahi" into a real search in the person\'s browser, and '
    + 'open it. Use this for "scrape google maps for X" — do NOT hand-write a search URL, this '
    + 'builds the right one. Returns a tabId ready for list_extract.',
    { source: S('Which site to search. "gmaps" is Google Maps. Call with a wrong value to be told what else is available.'),
      query: S('What to search for, in plain words, e.g. "restaurant in cimahi".'),
      city: S('Required by some sources whose city is part of the URL rather than the query.'),
      tld: S('Required by sources split across country domains, e.g. "kz" or "ru".'),
      active: B('Bring the tab to the front. Default false, so the person is not interrupted.') },
    ['source', 'query']),

  T('tabs_list',
    'Every http(s) tab open in the person\'s browser. Use only when current_page is not the one '
    + 'they meant and you need to ask which — for the ordinary case prefer current_page.'),

  T('tab_open',
    'Open a specific URL in the person\'s browser. Prefer search_open when you are searching a '
    + 'site; use this when you already have an exact URL.',
    { url: S('http or https only.'), active: B('Bring it to the front. Default false.') },
    ['url']),

  T('site_probe',
    'What a run on this tab would involve, before starting one: whether there is a list, how many '
    + 'rows are on the page, how it paginates, whether records can be read, and whether the site '
    + 'is currently showing a check. Cheap. Call it before list_extract so you can tell the person '
    + 'what they are about to wait for.',
    { tabId: N('From current_page, search_open, tab_open or tabs_list.') },
    ['tabId']),

  T('page_study',
    'Every repeating structure on a tab, RANKED, with the evidence behind the ranking — plus how the '
    + 'page continues (next link, rel=next, numbered pager) and what might load more. Use this when '
    + 'site_probe gave a list you do not trust, or before writing a scrape you want to be right: it '
    + 'returns several candidates rather than one verdict, so YOU choose. Read two fields before '
    + 'trusting the one it marks chosen: looksLikeFurniture (the candidate sits inside a footer, nav '
    + 'or aside landmark — measured on real sites where the engine picked a footer site-directory and '
    + 'a filter sidebar over the actual results) and distinctness (rows that all point at the same '
    + 'place are one record repeated, which is how a filter panel outscores a product grid). Growth '
    + 'affordances come back verified:false — they are candidates found by POSITION, not by reading '
    + 'words off buttons. Press one with page_grow to find out.',
    { tabId: N('From current_page, search_open, tab_open or tabs_list.') },
    ['tabId']),

  T('page_grow',
    'Press a load-more control, or scroll to the bottom, and report how many distinct record links '
    + 'the page had before and after. This is the only honest way to answer does-this-load-more: a '
    + 'button saying More may do nothing, and a page with no button at all may grow on scroll. '
    + 'CHANGES THE PAGE, unlike page_study. Pass a selector from page_study growth.candidates, or '
    + 'scroll:true. A reply of grew:false with by:0 is a real answer, not a failure.',
    { tabId: N('The tab.'),
      selector: S('A selector from page_study growth.candidates. Omit when using scroll.'),
      scroll: B('Scroll to the bottom instead of pressing anything.'),
      waitMs: N('How long to wait for new rows. Default 2500, max 8000.') },
    ['tabId']),
  T('list_extract',
    'Start reading the list on a tab into a table, following its pages. Returns a runId '
    + 'IMMEDIATELY — the work continues in the background and can take minutes. Poll run_status. '
    + 'Never assume it finished.',
    { tabId: N('The tab holding the list.'),
      pages: N('How many pages to follow. 0 or omitted means keep going until the list ends.'),
      withRecords: B('Also open each row\'s own record page and fill in the extra columns. '
        + 'Slower, and much richer — this is what turns a listing into contact details.') },
    ['tabId']),

  T('run_status',
    'How a run is going. States: running, reading_records, waiting_for_user, done, failed. '
    + 'waiting_for_user means the SITE asked the person to prove they are human — relay that and '
    + 'wait; do NOT retry, and do not start another run, because retrying is what turns a check '
    + 'into a block. On done, use the resultId with results_get.',
    { runId: S('From list_extract.') }, ['runId']),

  T('run_stop', 'Stop a run early. What it has already read is kept.',
    { runId: S('From list_extract.') }, ['runId']),

  T('results_list', 'Tables already extracted and saved in this browser, newest first. Check here '
    + 'before scraping something again.'),

  T('results_get',
    'Rows and column names from a saved table. Returns data, never HTML. Large tables are '
    + 'truncated — the reply says so and gives the true total; use results_export for all of it.',
    { resultId: S('From run_status or results_list.'),
      limit: N('Rows to return. Default 100, max 1000.'),
      columns: { type: 'array', items: { type: 'string' },
        description: 'Only these columns. Omit for all of them.' } },
    ['resultId']),

  T('results_export',
    'Write a whole table to a CSV file in the person\'s Downloads and return the filename. Use '
    + 'this instead of results_get when the table is too big to be worth reading into the '
    + 'conversation.',
    { resultId: S('From run_status or results_list.') }, ['resultId']),
];

// Tool name -> the browser op behind it. One line each, because the interesting decisions all live
// in `bridge-ops.js` where the browser is.
const OPS = {
  current_page: 'current.page', tabs_list: 'tabs.list', tab_open: 'tab.open',
  search_open: 'search.open', site_probe: 'site.probe', list_extract: 'list.extract',
  page_study: 'page.study', page_grow: 'page.grow',
  run_status: 'run.status', run_stop: 'run.stop', results_list: 'results.list',
  results_get: 'results.get', results_export: 'results.export',
};

// A walk can take minutes; everything else is a page load at worst.
const SLOW = new Set(['tab_open', 'search_open', 'site_probe', 'results_export']);

// A tool result is text content; big tables are trimmed HERE rather than in the browser, so the
// count the agent is told is the real one and not the one that happened to fit.
function asResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

async function call(name, args) {
  const op = OPS[name];
  if (!op) throw new Error(`no such tool: ${name}`);
  if (name === 'tab_open' && !/^https?:\/\//i.test(String(args?.url || ''))) {
    throw new Error('url must be http or https');
  }
  return asResult(await ask(op, args || {}, SLOW.has(name) ? 60000 : 30000));
}

let line = '';
process.stdin.on('data', async (chunk) => {
  line += chunk.toString('utf8');
  let cut;
  while ((cut = line.indexOf('\n')) >= 0) {
    const one = line.slice(0, cut).trim();
    line = line.slice(cut + 1);
    if (!one) continue;
    let msg;
    try { msg = JSON.parse(one); } catch (_) { continue; }
    // A notification has no id and takes no answer. Replying to one is a protocol error.
    const reply = (result) => { if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result }); };
    const fail = (code, message) => {
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    };
    try {
      switch (msg.method) {
        case 'initialize':
          // The client's own version is echoed back. A simple server has no reason to argue about
          // a revision it does not use any feature of, and guessing the current one wrongly is how
          // a working server refuses to start.
          reply({
            protocolVersion: msg.params?.protocolVersion || '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'holoscrape', version: '0.1.0' },
          });
          break;
        case 'notifications/initialized':
          break;
        case 'tools/list':
          reply({ tools: TOOLS });
          break;
        case 'tools/call':
          try {
            reply(await call(msg.params?.name, msg.params?.arguments || {}));
          } catch (e) {
            // A TOOL THAT FAILED IS NOT A PROTOCOL ERROR. Reported as a result the model can read
            // and act on — "no browser connected, ask the person to open Chrome" is something it
            // can relay; a JSON-RPC error code is something it can only give up on.
            reply({ content: [{ type: 'text', text: String(e.message || e) }], isError: true });
          }
          break;
        case 'ping':
          reply({});
          break;
        default:
          fail(-32601, `unknown method: ${msg.method}`);
      }
    } catch (e) {
      fail(-32603, String(e.message || e));
    }
  }
});

// --- start -------------------------------------------------------------------------------------
let bound = false;
function listen(i = 0) {
  if (i >= PORT_SPAN) {
    say(`ports ${PORT_BASE}-${PORT_BASE + PORT_SPAN - 1} are all busy — is another holoscrape-mcp running?`);
    process.exit(1);
  }
  // ONE SUCCESSFUL LISTEN, AND THEN STOP. This retry re-`listen`ed the SAME server object and the
  // log shows the consequence: a single process announcing "listening on 127.0.0.1:27182" and then
  // "listening on 127.0.0.1:27183", which made "which port am I on" unanswerable from the output —
  // during an evening spent trying to work out which of two servers the browser had paired with.
  if (bound) return;
  srv.once('error', (e) => (e.code === 'EADDRINUSE' ? listen(i + 1) : (say(String(e.message)), process.exit(1))));
  srv.listen(PORT_BASE + i, '127.0.0.1', () => {
    bound = true;
    say(`listening on 127.0.0.1:${PORT_BASE + i}`);
    say('');
    say(`  pairing code:  ${PAIR}`);
    say('');
    say('  Open the HoloScrape side panel in Chrome and enter it once.');
    say('');
  });
}
listen();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { srv.close(); process.exit(0); });
