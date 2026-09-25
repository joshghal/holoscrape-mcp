// Bytes in, a read site out.
//
// This runs in the offscreen document (see `offscreen.html`) and is the ONLY thing in the extension
// that turns a fetched body into a document. It holds no state, makes no decisions and knows
// nothing about the pass that calls it: the worker fetches, this parses and reads, the worker
// decides what to do with the answer.
//
// A PORT, NOT `sendMessage`, and the reason is not style. `chrome.runtime.sendMessage` broadcasts to
// every extension context at once — the side panel and the results window would both be handed a
// hundred page bodies they have no use for, and any one of them answering first would win the reply.
// A port is point to point. It also keeps the worker alive for as long as it is open, which matters
// on a pass that can run for a minute with no other extension API call to reset the idle timer.
import { pageMail } from './mail.js';
import { TLDS } from './tld.js';

const port = chrome.runtime.connect({ name: 'hs-mail' });

port.onMessage.addListener((msg) => {
  if (!msg || msg.dg !== 'read') return;
  const t0 = Date.now();
  let out = null;
  let why = '';
  try {
    // `text/html` and not `application/xhtml+xml`: a real small-business page is rarely well
    // formed, and the HTML parser is the forgiving one. It is also the one the browser would have
    // used had the page been opened, which is the point — the fetch path must not read a document
    // the tab path would never have seen.
    const doc = new DOMParser().parseFromString(String(msg.html || ''), 'text/html');
    out = pageMail(doc, msg.url || '', TLDS);
  } catch (e) {
    why = (e && e.message) || 'parse failed';
  }
  port.postMessage({ dg: 'read', id: msg.id, out, why, ms: Date.now() - t0 });
});
