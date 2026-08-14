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

let id = 0, buf = '';
const pending = new Map();
srv.stdout.on('data', (c) => {
  buf += c.toString();
  let cut;
  while ((cut = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, cut).trim(); buf = buf.slice(cut + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch (_) { continue; }
    const held = pending.get(m.id);
    if (held) { pending.delete(m.id); held(m); }
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

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'try', version: '0' } });
srv.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
// The extension dials US, so there is a beat between the server listening and the browser noticing.
await new Promise((r) => setTimeout(r, 1200));

const [cmd = 'here', ...rest] = process.argv.slice(2);
try {
  if (cmd === 'here') show('current_page', await callTool('current_page'));
  else if (cmd === 'tabs') show('tabs_list', await callTool('tabs_list'));
  else if (cmd === 'search') {
    show('search_open', await callTool('search_open', { source: rest[0], query: rest.slice(1).join(' ') }));
  } else if (cmd === 'extract') {
    const started = await callTool('list_extract', { tabId: Number(rest[0]), pages: Number(rest[1] || 0) });
    show('list_extract', started);
    if (started.runId) {
      // Polled exactly as an agent should: never assume it finished, and read `waiting_for_user`
      // as an instruction rather than as an error.
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const st = await callTool('run_status', { runId: started.runId });
        const line = st.state === 'waiting_for_user'
          ? `waiting for you — ${st.what}, ${st.secondsLeft}s left (${st.rowsSoFar} rows so far)`
          : `${st.state}  rows=${st.rows ?? st.rowsSoFar ?? 0} pages=${st.pages ?? st.pagesSoFar ?? 0}`;
        process.stdout.write(`\r  ${line.padEnd(78)}`);
        if (st.state === 'done' || st.state === 'failed') { console.log(); show('run_status', st); break; }
      }
    }
  } else if (cmd === 'study') {
    // The whole point of page_study is that it does NOT hand back a single answer, so print the
    // ranking rather than the winner. A caller that reads only `chosen` is back to the one verdict
    // that offered Apple's footer directory and Adobe's filter sidebar as search results.
    const out = await callTool('page_study', { tabId: Number(rest[0]) });
    if (out.__error) { show('page_study FAILED', out); } else {
      console.log(`\n\x1b[1m${out.title || ''}\x1b[0m\n  ${out.url || ''}\n`);
      for (const l of out.lists || []) {
        console.log(`  ${l.chosen ? '->' : '  '} rank ${l.rank}  rows=${String(l.rows).padStart(4)}`
          + ` cols=${String(l.columns).padStart(3)} area=${String(l.areaPercentOfViewport).padStart(3)}%`
          + ` distinct=${l.distinctness} ${l.looksLikeFurniture ? 'FURNITURE' : 'content  '}`
          + ` [${l.landmarks.join('>') || 'no landmark'}]`);
        console.log(`        ${String(l.selector).slice(-92)}`);
        if (l.sample && l.sample[0]) console.log(`        e.g. ${l.sample[0].slice(0, 88)}`);
      }
      show('pagination', out.pagination);
      show('growth — candidates are UNVERIFIED; press one with `grow`', out.growth);
    }
  } else if (cmd === 'grow') {
    // No selector means scroll; a selector comes from study.growth.candidates.
    show('page_grow', await callTool('page_grow', rest[1]
      ? { tabId: Number(rest[0]), selector: rest[1] }
      : { tabId: Number(rest[0]), scroll: true }));
  } else if (cmd === 'get') show('results_get', await callTool('results_get', { resultId: rest[0], limit: Number(rest[1] || 10) }));
  else if (cmd === 'results') show('results_list', await callTool('results_list'));
  else console.log('commands: here | tabs | search <source> <query> | study <tabId> | grow <tabId> [selector] | extract <tabId> [pages] | get <resultId> | results');
} finally {
  srv.kill();
}
