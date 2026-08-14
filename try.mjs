#!/usr/bin/env node
// Drive the MCP server the way an agent would, without needing an agent.
//
// The point is to prove the WHOLE chain — this script → the server over stdio → the WebSocket →
// the extension → a real tab — before Claude Code is anywhere near it. When something is broken it
// says which hop broke, which is the thing a coding agent's error message never tells you.
//
//   node try.mjs                                   what is open, and is it extractable
//   node try.mjs tabs                              every tab
//   node try.mjs search gmaps "restaurant in cimahi"
//   node try.mjs extract <tabId> [pages]           walk it, then poll to the end
//   node try.mjs get <resultId>                    the rows
//   node try.mjs study <tabId>                     every candidate list, ranked, with evidence
//   node try.mjs grow <tabId> [selector]           press it, or scroll, and count before/after
import { spawn } from 'node:child_process';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const srv = spawn(process.execPath, [path.join(HERE, 'index.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],   // stderr straight through: the pairing code lives there
});

// --- the wire: bytes in, one JSON-RPC reply out at a time -----------------------------------------
let id = 0, buf = '';
const pending = new Map();

// One complete line, turned into a reply and handed to whoever is waiting for that id. Split out of
// the `data` handler below so "find where the newlines are" and "make sense of one message" are two
// separate jobs rather than a try/catch and a lookup stacked inside a while inside a callback.
function deliverReply(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  const held = pending.get(msg.id);
  if (!held) return;
  pending.delete(msg.id);
  held(msg);
}

srv.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let cut;
  while ((cut = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, cut).trim();
    buf = buf.slice(cut + 1);
    if (line) deliverReply(line);
  }
});

const rpc = (method, params) => new Promise((res) => {
  const n = ++id;
  pending.set(n, res);
  srv.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
});

// A tool result is text content; the interesting part is always the JSON inside it.
const callTool = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? '';
  if (r.result?.isError) return { __error: text };
  try { return JSON.parse(text); } catch (_) { return { __text: text }; }
};
const show = (label, v) => console.log(`\n\x1b[1m${label}\x1b[0m\n${JSON.stringify(v, null, 2)}`);

// --- the commands with enough going on to earn their own function ---------------------------------
// `extract`, `study` and `grow` each buried a loop or a multi-line conditional inside the dispatch
// below — a while inside an if inside an else-if. Same logic, given a name and pulled level with
// the thing it's part of, so nesting never runs deeper than "a loop, doing one job".

// `list_extract` only returns a runId; everything the person actually wants — the row count, when
// it finishes — comes from polling `run_status`, which happens here so "extract" means the whole
// job, not just the part that starts it.
function statusLine(st) {
  return st.state === 'waiting_for_user'
    ? `waiting for you — ${st.what}, ${st.secondsLeft}s left (${st.rowsSoFar} rows so far)`
    : `${st.state}  rows=${st.rows ?? st.rowsSoFar ?? 0} pages=${st.pages ?? st.pagesSoFar ?? 0}`;
}

// Polled exactly as an agent should: never assume it finished, and read `waiting_for_user` as an
// instruction rather than as an error. One job — wait for done-or-failed — kept apart from what
// each tick is supposed to look like on screen (`statusLine`) and from what "extract" means as a
// whole (`runExtract`).
async function pollUntilDone(runId) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await callTool('run_status', { runId });
    process.stdout.write(`\r  ${statusLine(st).padEnd(78)}`);
    if (st.state === 'done' || st.state === 'failed') { console.log(); show('run_status', st); return; }
  }
}

async function runExtract(tabId, pages) {
  const started = await callTool('list_extract', { tabId, pages });
  show('list_extract', started);
  if (started.runId) await pollUntilDone(started.runId);
}

// One printed line per candidate list, not just the winner. The whole point of `page_study` is
// that it does not hand back a single answer — a caller that reads only `chosen` is back to the
// one verdict that once offered Apple's footer directory and Adobe's filter sidebar as search
// results.
function printCandidate(l) {
  console.log(`  ${l.chosen ? '->' : '  '} rank ${l.rank}  rows=${String(l.rows).padStart(4)}`
    + ` cols=${String(l.columns).padStart(3)} area=${String(l.areaPercentOfViewport).padStart(3)}%`
    + ` distinct=${l.distinctness} ${l.looksLikeFurniture ? 'FURNITURE' : 'content  '}`
    + ` [${l.landmarks.join('>') || 'no landmark'}]`);
  console.log(`        ${String(l.selector).slice(-92)}`);
  if (l.sample?.[0]) console.log(`        e.g. ${l.sample[0].slice(0, 88)}`);
}

async function runStudy(tabId) {
  const out = await callTool('page_study', { tabId });
  if (out.__error) { show('page_study FAILED', out); return; }
  console.log(`\n\x1b[1m${out.title || ''}\x1b[0m\n  ${out.url || ''}\n`);
  for (const l of out.lists || []) printCandidate(l);
  show('pagination', out.pagination);
  show('growth — candidates are UNVERIFIED; press one with `grow`', out.growth);
}

// No selector means scroll; a selector comes from `study`'s growth.candidates.
async function runGrow(tabId, selector) {
  const args = selector ? { tabId, selector } : { tabId, scroll: true };
  show('page_grow', await callTool('page_grow', args));
}

// --- the command line itself -----------------------------------------------------------------
// A LOOKUP, NOT A CHAIN. Eight `else if` branches were still a chain even once their bodies were
// one-liners — reading it meant checking each condition in turn to find the one that matched, and
// adding a ninth command meant growing the chain rather than adding an entry. A plain object makes
// "what commands exist" a single flat list, and dispatch is "find the matching key", not "walk a
// sequence of comparisons".
const USAGE = 'commands: here | tabs | search <source> <query> | study <tabId> | grow <tabId> '
  + '[selector] | extract <tabId> [pages] | get <resultId> | results';

const COMMANDS = {
  here: async () => show('current_page', await callTool('current_page')),
  tabs: async () => show('tabs_list', await callTool('tabs_list')),
  search: async (rest) => show('search_open',
    await callTool('search_open', { source: rest[0], query: rest.slice(1).join(' ') })),
  extract: (rest) => runExtract(Number(rest[0]), Number(rest[1] || 0)),
  study: (rest) => runStudy(Number(rest[0])),
  grow: (rest) => runGrow(Number(rest[0]), rest[1]),
  get: async (rest) => show('results_get',
    await callTool('results_get', { resultId: rest[0], limit: Number(rest[1] || 10) })),
  results: async () => show('results_list', await callTool('results_list')),
};

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'try', version: '0' } });
srv.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
// The extension dials US, so there is a beat between the server listening and the browser noticing.
await new Promise((r) => setTimeout(r, 1200));

const [cmd = 'here', ...rest] = process.argv.slice(2);
try {
  const run = COMMANDS[cmd];
  if (run) await run(rest);
  else console.log(USAGE);
} finally {
  srv.kill();
}
