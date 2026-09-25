// HoloScrape — service worker: the log.
// prod or stg — see env.js. The staging build is the only one that keeps a log.
import { DEV } from './env.js';

// --- the log -----------------------------------------------------------------
// A ring buffer of what the worker actually did, written to a file on demand. It exists
// because the interesting failures happen on sites that cannot be reached from a test —
// a page renders for you and not for a fresh profile, a wall appears once and never again
// — and "it returned nothing" is not a report anyone can act on. Every line carries the
// numbers that would otherwise have to be guessed at.
export const LOG = [];
// Raised from 800: a details pass over 120 records writes a line per record plus its phases and
// messages, and at 800 the beginning of the run — the gate, the width, the zoom — rolled off the
// front, which is the half that explains the end.
const LOG_MAX = 4000;
// OFF unless asked for. Kept in storage rather than in memory alone, because the worker is
// restarted whenever Chrome feels like it and a switch that forgets itself between two
// halves of the same investigation is worse than no switch.
// On in staging, off in production. Storage can still turn it on — the tests do — but the
// switch that offers it only exists in a staging build, and nothing is ever written to disk
// in production without the user asking by name.
export let devLog = DEV;
chrome.storage.local.get('devLog').then((r) => {
  if (r.devLog != null) devLog = !!r.devLog;
  if (!devLog) LOG.length = 0;
}).catch(() => {});
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local' || !ch.devLog) return;
  devLog = !!ch.devLog.newValue;
  // OFF MEANS OFF, INCLUDING WHAT WAS ALREADY COLLECTED. Silencing new entries while
  // keeping the buffer would still hand over everything gathered before the switch was
  // flipped, the next time anything wrote a file — which is exactly the litter this
  // switch exists to prevent. It matters more now that every message is noted at the
  // door: by the time someone turns logging off, the buffer holds their browsing.
  if (!devLog) LOG.length = 0;
});
export function note(tag, data) {
  if (!devLog) return;   // no buffer, no file, no cost
  LOG.push({ at: new Date().toISOString().slice(11, 23), tag, ...(data || {}) });
  if (LOG.length > LOG_MAX) LOG.shift();
}
export function logText() {
  return LOG.map((l) => {
    const { at, tag, ...rest } = l;
    const body = Object.entries(rest)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
    return `${at}  ${tag.padEnd(14)} ${body}`;
  }).join('\n');
}
// A LOG THAT OVERWRITES ITSELF IS NOT A LOG.
//
// This used to write one fixed path, `HoloScrape/holoscrape-log.txt`, with conflictAction
// 'overwrite', from every site where a result was saved. The passive poll saves every couple
// of seconds, so a Maps session downloaded the file ~28 times a minute and each write destroyed
// the one before it. The run a person actually wanted to read was therefore gone before they
// could open it — the file they opened held 72 seconds of poll ticks and nothing else.
//
// That is not a cosmetic problem. Four attempts at the "120 became 47" bug were debugged with no
// evidence, chasing hidden-tab throttling, because the instrument that would have named the real
// cause in one run was quietly erasing itself. The broken instrument cost more than the bug.
//
// So: stamped names that sort by time and can never overwrite each other, written when a RUN
// ENDS rather than when a result is saved, and a floor between writes so a burst of passes
// cannot bury the folder. `uniquify` on top, because two runs inside one second are possible
// and losing one of them to a name collision is the same failure in miniature.
let lastLogAt = 0;
const LOG_FLOOR_MS = 4000;

// Reads that happen on their own: the panel's poll (`detect`) and the worker-driven detail
// steps. These are the same set the message log excludes at the door, for the same reason —
// they are the heartbeat, not an event.
// `mapkind` and `atpage` are pure READS — the worker asks them once per walk and once per page
// press. Left out of this list they each force a log write, so a twenty-page walk pays forty
// file writes to learn two facts it already had.
export const PASSIVE_OP = /^(detect|progress|stopped|mapkind|atpage|d(click|mark|step|web|read|gate|done|tables|screen))$/;

// Seconds are not fine enough: two writes inside one second asked for the same path, and
// leaning on Chrome's `uniquify` to sort that out means the name reported back to the panel
// is not the name on disk. Milliseconds, plus a counter for the pathological case, so the
// path this function returns is the path the file actually has.
let logSeq = 0;
let lastLogName = '';

function logName(at = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const base = `HoloScrape/holoscrape-log-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`
    + `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}-${p(at.getMilliseconds(), 3)}`;
  let name = `${base}.txt`;
  if (name === lastLogName) name = `${base}-${++logSeq}.txt`;
  lastLogName = name;
  return name;
}

export async function saveLog(opts = {}) {
  if (!LOG.length) return { lines: 0, skipped: 'nothing logged — is "Keep a log" on?' };
  // The button in the panel always writes; automatic writes respect the floor.
  if (!opts.force && Date.now() - lastLogAt < LOG_FLOOR_MS) {
    return { lines: LOG.length, skipped: 'a log was written moments ago' };
  }
  lastLogAt = Date.now();
  const name = logName();
  const text = `HoloScrape log — ${new Date().toISOString()}\n`
    + `${LOG.length} entries${LOG.length >= LOG_MAX ? ` (capped at ${LOG_MAX}; the oldest were dropped)` : ''}\n`
    + `${'-'.repeat(72)}\n${logText()}\n`;
  const b64 = btoa(unescape(encodeURIComponent(text)));
  const id = await chrome.downloads.download({
    url: `data:text/plain;charset=utf-8;base64,${b64}`,
    filename: name,
    conflictAction: 'uniquify',
    saveAs: false,
  });
  return { id, lines: LOG.length, bytes: text.length, name };
}
