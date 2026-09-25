// HoloScrape — service worker: capturing what a page fetched — the network layer, its watch, and
// walking a feed by its own API.
import { netRows, rowIdent } from './harvest.js';
import { runRows } from './bg-rows.js';
import { cdp, cdpHold, cdpRelease } from './bg-cdp.js';

// --- CAPTURING THE JSON A PAGE FETCHED ----------------------------------------------------------
//
// WHY THIS LIVES IN HARVEST AND NOT IN A NAVIGATE-AND-READ TOOL. Reading a page's API responses is
// the right answer for a client-rendered site — the field is already named in the payload, before
// React has mounted, with no hashed classname to track and no "show more" to expand. It is the
// wrong answer bolted to a per-page tool: one page per call is the 733-call shape this project
// exists to delete, and a raw GraphQL body is the LARGEST thing in the system to send through a
// model. Here the bodies are read in the lane, mapped by the same field spec as the DOM, and only
// rows come out. 398 products stay one call.
//
// Cost, paid honestly: one yellow "HoloScrape is debugging this browser" bar per lane, for the
// duration of the run — not one per page. Only one debugger may attach to a tab at a time, so a
// tab with DevTools open cannot be captured; that is reported, never worked around.
const NET_WAIT_MS = 6000;      // longest wait for a matching response after the document is done
const NET_QUIET_MS = 350;      // ... and how still it must go before the page is called finished
const NET_BODY_MAX = 4000000;
const NET_BODIES_MAX = 12;
// How many responses a single reply will NAME. Four short fields each, so this is inventory rather
// than data — 400 of them is roughly 30KB, which fits where a dozen decoded JSON bodies would not.
// It exists because the alternative was a count, and a count is something a caller cannot act on.
const NET_LIST_MAX = 400;

// base64 FROM CDP IS BYTES, NOT LATIN-1 TEXT. `atob` alone turns every non-ASCII character into
// mojibake — which on an Indonesian storefront is most of the description, silently corrupted in a
// way that still parses as JSON and still fills the column. Decode the bytes as UTF-8.
function b64utf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

// One attach per LANE. Returns a state object, or `{ why }` when the tab cannot be attached — the
// caller keeps going without capture rather than failing the navigation, because a page that reads
// from the DOM is still a page that reads.

// `kinds` LETS A CALLER ASK THIS ONE CAPTURE FOR A DEVTOOLS CATEGORY, rather than growing a second
// listener beside it. CDP already labels every response with the resource type that caused it —
// `Image`, `XHR`, `Fetch`, `Document` — and those labels ARE the network panel's filter buttons. So
// "every image this page fetched" is a category on the capture that already sees everything, not a
// new mechanism. The url filter and the mime exclusion below stay exactly as they were for every
// existing caller; `kinds` is checked first and only when asked for.
export async function netOpen(tabId, filter, { bodies = 0, kinds = null } = {}) {
  const target = { tabId };
  const st = { target, filter, hits: new Map(), done: new Set(), dead: new Set(), last: 0, why: '' };
  const onEvent = (src, method, params) => {
    if (src.tabId !== tabId) return;
    if (method === 'Network.responseReceived') {
      const u = params.response?.url || '';
      const mime = String(params.response?.mimeType || '');
      // `*` IS DISCOVERY, AND DISCOVERY MEANS THE FETCHES — not the document, not the forty script
      // files, not the stylesheets. CDP labels each response with the resource type that caused it,
      // which is a far better discriminator than anything guessable from the url: "what did this
      // page fetch" is literally XHR and Fetch. A url substring the caller typed is left alone,
      // because they were specific and may well mean a document.
      const kind = String(params.type || '');
      if (kinds && kinds.length) {
        // `['*']` IS EVERY RESPONSE, AND IT IS THE HONEST DEFAULT FOR AN INVENTORY.
        //
        // Filtering at capture time means trusting the server's own labelling, and servers get it
        // wrong: an svg served as `text/xml`, an upload served as `application/octet-stream`, an
        // image fetched through XHR so CDP calls it `Fetch`. Each of those is a picture the page
        // shows and a whitelist silently drops — the same silent-drop failure the JSON filter below
        // was already rewritten to avoid. So take everything and let the consumer decide; a hit is
        // four short strings, and a heavy page load is a few hundred of them.
        const want = kinds.includes('*')
          || kinds.includes(kind)
          || kinds.some((k) => k !== '*' && new RegExp('^' + k.toLowerCase() + '/').test(mime));
        // Inline data never travelled, so it is not a network hit; the page reader reports those.
        if (want && u && !u.startsWith('data:')) {
          st.hits.set(params.requestId, { url: u, mime, status: params.response?.status || 0, kind });
          st.last = Date.now();
        }
        return;
      }
      if (filter === '*') {
        // `*` IS EVERYTHING ON THE WIRE. It used to keep only XHR and Fetch on the reasoning that
        // "what did this page fetch" means the data calls — and that reasoning was wrong in the one
        // way that matters: it decided FOR the caller what could possibly be interesting, so an
        // image, a font, a document-served svg or an upload the server mislabelled was dropped at
        // capture time and no later call could get it back. A dropped response cannot be recovered;
        // an unwanted one costs four short strings. Capture everything, and let the reply decide
        // what to spell out — which is what `netTake` and the census in the reply now do.
        st.hits.set(params.requestId, { url: u, mime, status: params.response?.status || 0, kind });
        st.last = Date.now();
        return;
      }
      // NO EXCLUSION AT ALL. This used to drop image, video, audio and font mimes on the grounds
      // that they are "certainly not readable" — which was the same mistake as the whitelist it
      // replaced, one step smaller. A caller who typed a url substring asked for the responses at
      // that url; whether one of them is a picture is THEIR question, and dropping it here means no
      // later call can get it back. Ask for `cdn.example.com` and you now get every response from
      // it, images included.
      if (u.includes(filter)) {
        // `kind` here too: without it every row in a named filter's census read "Other", which is
        // worse than no census — it says the browser could not tell, when the browser told us.
        st.hits.set(params.requestId, { url: u, mime, status: params.response?.status || 0, kind });
        st.last = Date.now();
      }
      return;
    }
    if (!st.hits.has(params.requestId)) return;
    // BOTH ENDINGS, OR THE WAIT NEVER ENDS. A request that failed and one that finished both leave
    // the pending set; watching only for `loadingFinished` means one cancelled beacon holds the
    // page for the full budget on every page in the queue.
    if (method === 'Network.loadingFinished') {
      st.done.add(params.requestId); st.last = Date.now();
      // What actually came down the wire, recorded on the event that already fires. Existing
      // callers never read it; the asset merge does, so a network-found file reports a real size
      // instead of a blank column.
      const hit = st.hits.get(params.requestId);
      if (hit) hit.bytes = Math.round(Number(params.encodedDataLength) || 0);
    }
    if (method === 'Network.loadingFailed') { st.dead.add(params.requestId); st.last = Date.now(); }
  };
  chrome.debugger.onEvent.addListener(onEvent);
  st.onEvent = onEvent;
  try {
    // BORROWED, NEVER SEIZED. See the rule above `cdpHold`.
    await cdpHold(target, { bodies });
    st.attached = true;
  } catch (e) {
    chrome.debugger.onEvent.removeListener(onEvent);
    st.why = String(e?.message || e);
  }
  return st;
}

export const netReset = (st) => { if (st) { st.hits.clear(); st.done.clear(); st.dead.clear(); st.last = 0; } };

export async function netClose(st) {
  if (!st) return;
  if (st.onEvent) chrome.debugger.onEvent.removeListener(st.onEvent);
  // RELEASE, NOT DETACH. A watch or a feed reader may still be on this tab; taking the session away
  // would stop it dead without an error anywhere. See rule 2 above `cdpHold`.
  if (st.attached) await cdpRelease(st.target);
  st.attached = false;
}

// --- WHAT DID THIS PAGE FETCH? -------------------------------------------------------------------
//
// THE HALF THAT MAKES THE OTHER HALF USABLE. Capture needs a url substring and `$.` paths, and on a
// site nobody has read before, the caller has neither — the endpoint host is unknown and so is the
// shape of what it answers. Without this the network tier only works on sites you already
// understand, which is the opposite of the point. `page_state` settled this shape already: no path
// means DISCOVERY, a path means READ. This is the same split for the network layer.
//
// What comes back is a MAP, not the data: every response, and for the JSON ones a list of paths
// with their types and array lengths. That is what a caller needs to write `$.data.item.title` —
// and it is a few hundred bytes where the bodies are megabytes, which matters because this reply is
// the one that travels through a model.
const SHAPE_PATHS = 60;      // paths listed per response
const SHAPE_DEPTH = 6;
const SHAPE_SAMPLE = 60;     // characters of a string value, so a field is recognisable

// Depth-first with a path accumulator. Arrays report their length and describe ONLY element 0 —
// a 200-review array described element by element is the payload again, and every element has the
// same shape anyway. `[0]` in the printed path is a reminder that it is an array, and `$.` paths
// accept exactly that form.
function netShape(v, path = '$', out = [], depth = 0) {
  if (out.length >= SHAPE_PATHS) return out;
  if (v === null) { out.push(`${path}: null`); return out; }
  if (Array.isArray(v)) {
    out.push(`${path}: array(${v.length})`);
    if (v.length && depth < SHAPE_DEPTH) netShape(v[0], `${path}[0]`, out, depth + 1);
    return out;
  }
  if (typeof v === 'object') {
    if (depth >= SHAPE_DEPTH) { out.push(`${path}: object(${Object.keys(v).length} keys, deeper)`); return out; }
    for (const k of Object.keys(v)) {
      if (out.length >= SHAPE_PATHS) { out.push('… more'); break; }
      netShape(v[k], `${path}.${k}`, out, depth + 1);
    }
    return out;
  }
  // THE VALUE, TRIMMED — not just the type. "string(2841)" tells a caller nothing about whether it
  // is the description they want; the first sixty characters tell them immediately.
  if (typeof v === 'string') {
    const one = v.replace(/\s+/g, ' ').trim();
    out.push(`${path}: string(${v.length}) ${JSON.stringify(one.slice(0, SHAPE_SAMPLE))}`);
    return out;
  }
  out.push(`${path}: ${typeof v} ${JSON.stringify(v).slice(0, 40)}`);
  return out;
}

// The catalogue. Bodies are read and summarised, then dropped — nothing large survives this call.
export function netCatalogue(bodies) {
  return bodies.map((b) => ({
    url: b.url,
    mime: b.mime || '',
    status: b.status || 0,
    bytes: b.bytes || 0,
    ...(b.body && typeof b.body === 'object'
      ? { paths: netShape(b.body) }
      : { notJson: String(b.body || '').replace(/\s+/g, ' ').slice(0, 200) }),
  }));
}

// Wait for the matching responses to land, then read them. Bounded twice: an overall budget, and a
// quiet period after the last event so a page that answers in three calls is not cut after one.
export async function netTake(st, { max = 0 } = {}) {
  if (!st || !st.attached) return { bodies: [], why: st?.why || '' };
  const until = Date.now() + NET_WAIT_MS;
  for (;;) {
    const pending = [...st.hits.keys()].filter((id) => !st.done.has(id) && !st.dead.has(id));
    if (st.hits.size && !pending.length && Date.now() - st.last > NET_QUIET_MS) break;
    if (Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // A CENSUS OF EVERYTHING, BESIDE THE BODIES OF THE FEW WORTH READING.
  //
  // Capturing everything must not mean REPLYING with everything — a page load is hundreds of
  // responses and this reply travels through a model. So the caller gets a count per resource type,
  // which is what the browser's own network panel shows on its filter buttons, and the JSON-shaped
  // bodies are still spelled out in full below. Nothing is dropped at capture, and nothing floods
  // the reply.
  const census = {};
  const all = [];
  for (const info of st.hits.values()) {
    const k = (info.kind || 'Other');
    census[k] = (census[k] || 0) + 1;
    // EVERY RESPONSE IS IN THE ANSWER. The reply used to list only the ones whose body had been
    // read, so a page that fetched 290 things reported 12 and hid the rest behind a number — the
    // caller could see that something existed and had no way to name it. These four fields are
    // short, they are what the browser's own network panel shows in its columns, and they are what
    // a caller needs to then ask for one specific url.
    all.push({ url: info.url, mime: info.mime || '', status: info.status || 0,
      kind: k, ...(info.bytes ? { bytes: info.bytes } : {}) });
  }
  const bodies = [];
  for (const [id, info] of st.hits) {
    if (bodies.length >= (max || NET_BODIES_MAX)) break;
    if (!st.done.has(id)) continue;
    // WHICH BODIES TO FETCH IS A COST DECISION, NOT A FILTER ON THE ANSWER. Every response is
    // already listed in `all` above, so nothing is hidden by skipping a read here: `getResponseBody`
    // costs a round trip each, and a decoded PNG is base64 a model cannot use. A caller who wants
    // that specific body names its url and gets it.
    if (info.kind && info.kind !== 'XHR' && info.kind !== 'Fetch'
        && !/json|text|xml|javascript/.test(info.mime || '')) continue;
    try {
      const r = await cdp(st.target, 'Network.getResponseBody', { requestId: id });
      let txt = String(r?.body || '');
      if (r?.base64Encoded) { try { txt = b64utf8(txt); } catch (_) { continue; } }
      if (txt.length > NET_BODY_MAX) txt = txt.slice(0, NET_BODY_MAX);
      let parsed = null;
      try { parsed = JSON.parse(txt); } catch (_) { /* not JSON — try JSONP, then keep the text */ }
      // JSONP IS JSON IN A COAT. A widget that predates CORS asks for `callback=fn` and gets back
      // `fn({...})`, which fails JSON.parse — so the body stays a string, every `$.` path into it
      // matches nothing, and (before this) the reply quietly substituted schema.org rows instead.
      // Measured on a Bazaarvoice reviews widget: `BV._internal.dataHandler0({...})`, 54,222 chars
      // of perfectly good review data that no path could reach.
      //
      // Unwrapped only when the whole body IS one call — a leading dotted identifier, one balanced
      // pair of parentheses around the rest, optional trailing semicolon. Anything else is left as
      // text, because guessing at the shape of a script is how you start executing one.
      if (parsed === null) {
        const m = /^\s*(?:\/\*+[^*]*\*+\/\s*)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(([\s\S]*)\)\s*;?\s*$/.exec(txt);
        if (m) { try { parsed = JSON.parse(m[1]); } catch (_) { /* really not JSON */ } }
      }
      bodies.push({ url: info.url, mime: info.mime, status: info.status,
        bytes: txt.length, body: parsed ?? txt });
    } catch (_) { /* the body was evicted from the buffer; nothing to do about it */ }
  }
  // A FILTER THAT MATCHED NOTHING IS THE COMMONEST MISTAKE AND MUST NOT LOOK LIKE AN EMPTY PAGE.
  // And a page that fetched MORE than the cap must say so rather than present a truncated map as
  // the whole of what happened — the same rule as every other cap in this file.
  return {
    bodies,
    all,
    seen: st.hits.size,
    // The census travels with the bodies, so a caller can see that images, fonts or documents were
    // fetched even though only the data-shaped ones were read out. Without it, "3 bodies" from a
    // page that made 280 requests reads as a quiet page, which is the wrong thing to believe.
    kinds: census,
    why: st.hits.size
      ? (st.hits.size > bodies.length
        ? `${st.hits.size} responses seen, ${bodies.length} had a body read as data `
          + `(cap ${max || NET_BODIES_MAX}); every one of them is NAMED in the response list beside `
          + `this — pass a url substring to read a specific body`
        : '')
      : (st.filter === '*'
        ? 'this page fetched nothing at all while loading'
        : `no response url contained "${st.filter}"`),
  };
}

// --- A WATCH THAT OUTLIVES THE CALL THAT STARTED IT ----------------------------------------------
//
// Every capture path so far is start-work-take-detach inside ONE call, because each knew what it
// was about to do. That cannot serve the ordinary case: a person clicks a filter, opens a drawer,
// types in a search box, and the fields arrive in a response nobody asked for in advance. Capture
// has to be running BEFORE the thing happens — `getResponseBody` only works for requests seen while
// the domain was enabled, so a watch started afterwards has nothing to give.
//
// So: start a watch, go and do whatever causes the traffic with any tool at all, then poll. Each
// poll answers with what arrived SINCE THE LAST POLL and leaves the watch running.
//
// Reached as a page_state PATH — `@net(...)` — deliberately, and not as a new tool: a client that
// has already fetched its tool list will never see a new NAME, and this needs to work in the
// session that is already open. Same reason `@dom(...)` and `@collect(...)` are paths.
const WATCH_MAX = 4;
const WATCH_IDLE_MS = 10 * 60 * 1000;
const watches = new Map();   // tabId -> { st, filter, at, took }

async function netWatchStop(tabId) {
  const w = watches.get(Number(tabId));
  if (!w) return false;
  watches.delete(Number(tabId));
  await netClose(w.st).catch(() => {});
  return true;
}

// A WATCH HOLDS A DEBUGGER ATTACHED TO SOMEONE'S TAB. It is not something to leak: the banner stays
// up, DevTools cannot be opened on that tab, and the buffer grows. Oldest goes when the cap is hit,
// idle ones are dropped on the next touch, and a closed tab takes its watch with it.
function watchSweep() {
  const now = Date.now();
  for (const [id, w] of [...watches]) {
    if (now - w.at > WATCH_IDLE_MS) netWatchStop(id);
  }
}
chrome.tabs.onRemoved.addListener((id) => { netWatchStop(id); });

export async function netWatch(tabId, arg) {
  const id = Number(tabId);
  watchSweep();
  const spec = String(arg || '').trim();

  if (/^stop$/i.test(spec)) {
    const had = await netWatchStop(id);
    return { watching: false, stopped: had,
      why: had ? 'watch closed and the debugger detached' : 'there was no watch on this tab' };
  }

  let w = watches.get(id);
  // A FILTER GIVEN WHEN ONE IS ALREADY RUNNING MEANS "WATCH THIS INSTEAD", not "poll".
  if (spec && w && w.filter !== spec) { await netWatchStop(id); w = null; }

  if (!w) {
    const filter = spec || '*';
    if (watches.size >= WATCH_MAX) await netWatchStop([...watches.keys()][0]);
    const st = await netOpen(id, filter, { bodies: FEED_BODIES });
    if (st.why) { await netClose(st); return { error: `cannot watch this tab: ${st.why}` }; }
    w = { st, filter, at: Date.now(), took: 0 };
    watches.set(id, w);
    return {
      watching: true,
      filter,
      since: 'now',
      seen: 0,
      // SAYING THIS OUT LOUD, because the mistake it prevents is the whole reason the watch exists:
      // starting a watch does not retrieve what already happened.
      next: 'the watch is running from THIS MOMENT — requests the page already made are gone. Now '
        + 'do the thing that loads the data (page_grow, a click, tab_here, typing) and call '
        + 'page_state path:"@net()" again to see what it fetched. "@net(stop)" ends it.',
    };
  }

  w.at = Date.now();
  const { bodies, all, seen, why, kinds } = await netTake(w.st, { max: FEED_BODIES });
  // WHAT ARRIVED SINCE THE LAST POLL. Cleared after reading so a poll loop reports each response
  // once — a poller that re-reports everything every time cannot answer "did that click fetch
  // anything", which is the question it exists for.
  netReset(w.st);
  w.took += bodies.length;
  return {
    watching: true,
    filter: w.filter,
    new: bodies.length,
    totalSoFar: w.took,
    responses: netCatalogue(bodies),
    // EVERY RESPONSE, NAMED. `responses` above are the ones whose body was read and shaped into $.
    // paths; this is the whole list, so nothing the page fetched is invisible to the caller. Capped
    // only by what a reply can carry, and the cap SAYS SO rather than presenting a slice as the set.
    ...(all && all.length ? {
      network: all.slice(0, NET_LIST_MAX),
      ...(all.length > NET_LIST_MAX
        ? { networkNote: `${all.length} responses; first ${NET_LIST_MAX} listed — narrow with `
            + `"@net(<url substring>)" to see the rest` }
        : {}),
    } : {}),
    ...(kinds && Object.keys(kinds).length ? { kinds } : {}),
    ...(why ? { netWhy: why } : {}),
    ...(seen > bodies.length ? { note: `${seen} responses seen, ${bodies.length} read as data this poll` } : {}),
    next: bodies.length
      ? 'pick the response holding what you want; its `paths` are $. paths you can hand to '
        + 'page_harvest({network}) or page_grow({network, rows})'
      : 'nothing matched since the last poll — either the action fetched nothing, or the filter is '
        + 'too narrow. "@net(*)" watches EVERY response, not just the data calls, so `kinds` shows '
        + 'what a page fetched even when no body was worth reading.',
  };
}


// --- WALKING A FEED BY ITS OWN API ---------------------------------------------------------------
//
// ONE SCROLL, ONE REQUEST, ONE PAGE OF ITEMS. An infinite list already says where its data is and
// when it has run out: each scroll fires a call, that call carries the items. Reading the DOM after
// each step — which is what `collect` does — is the same loop against a worse source: a virtualized
// list holds only a screenful, so rows must be caught before they unmount, and whatever the markup
// omits is simply gone. The response has every field, already named.
//
// THIS DOES NOT REIMPLEMENT THE LOOP. `collectRows` in rows.js already owns stepping a list: the
// hop cap, the DRY counter, `ended`, identity-based de-duplication, the row cap — and the part that
// is easy to miss, that a scroll POSITION is not a gesture and some apps only listen for the
// gesture. A first cut of this walked the list itself with `studypress` one hop at a time and would
// have failed on exactly the apps that comment was written for. So `collect` runs once, exactly as
// it always does, and the capture happens AROUND it: attach, let it scroll, then read every
// response its scrolling caused.
//
// Both halves are kept, because neither is complete. The DOM half carries the first screenful,
// which was rendered before anything attached and is therefore in no response we can see. The
// network half carries the rows the DOM never held and the fields the markup left out.
const FEED_BODIES = 200;

export async function growFeed({ tabId, network, rows, selector = '', pane = '',
  waitMs, hops, limit, dry, direction }) {
  const st = await netOpen(tabId, String(network), { bodies: FEED_BODIES });
  if (st.why) { await netClose(st); return { error: `cannot watch this tab: ${st.why}` }; }
  try {
    // NO ROW SELECTOR MEANS THE DOM IS NOT THE SOURCE, AND THAT IS THE POINT.
    //
    // Requiring one put the DOM's ceiling back into the one path built to escape it: a read of the
    // rendered list is capped by the reply budget — measured, 85 rows over 71KB — and a virtualized
    // list never holds more than a screenful anyway. Here the rows come out of the responses the
    // scrolling causes, so neither limit applies and nothing is read from the page at all.
    //
    // The stop signal is the site's own: it keeps answering with items until it has none left.
    if (!selector) {
      const out = [];
      const seenKeys = new Set();
      const cap = Math.max(1, Math.min(400, Number(hops) || 20));
      const DRY = Math.max(2, Math.min(8, Number(dry) || 3));
      const max = Math.min(Math.max(50, Number(limit) || 2000), 5000);
      const perHop = [];
      let dryRun = 0;
      let ended = 'hops';
      for (let h = 0; h < cap && out.length < max; h++) {
        const step = await runRows(tabId, {
          action: 'scrollstep', selector: String(pane || ''), direction, waitMs,
        }).catch(() => null);
        const { bodies } = await netTake(st, { max: FEED_BODIES });
        netReset(st);
        let fresh = 0;
        for (const r of netRows(bodies, rows?.at, rows?.fields)) {
          const k = rowIdent(r);
          if (!k || seenKeys.has(k) || out.length >= max) continue;
          seenKeys.add(k);
          out.push(r);
          fresh++;
        }
        perHop.push({ calls: bodies.length, fresh, moved: !!step?.moved });
        if (fresh) { dryRun = 0; continue; }
        // A PANE THAT WILL NOT MOVE AND A FEED THAT SENDS NOTHING NEW ARE BOTH ENDINGS, and they
        // are different ones — worth telling apart, because "it stopped fetching" is the list
        // finishing and "it stopped moving" may be a pane the caller did not mean.
        if (++dryRun >= DRY) { ended = step?.atEnd ? 'the list reached its end' : 'the feed stopped returning new items'; break; }
      }
      return {
        rows: out,
        fromNetwork: out.length,
        fromDom: 0,
        hops: perHop.length,
        perHop: perHop.slice(-8),
        ended,
        capped: out.length >= max,
        ...(out.length ? {} : {
          netHint: 'no items came out of the responses. Check rows.at against '
            + 'page_state path:"@net(*)" on this page — and note the FIRST screenful is usually '
            + 'fetched before a watch can see it, so a list that never scrolls has nothing to catch.',
        }),
      };
    }
    // The loop, unchanged and not re-stated here. `selector` is the rows for the DOM half; when the
    // caller only wants the API half they still need one, because it is also how `collect` knows
    // the list is moving.
    const dom = await runRows(tabId, {
      action: 'collect', selector: String(selector || ''), pane: String(pane || ''),
      direction, hops, waitMs, limit, dry,
    });
    const { bodies, seen: sawCalls, why } = await netTake(st, { max: FEED_BODIES });
    const fromNetwork = netRows(bodies, rows?.at, rows?.fields);
    const domRows = Array.isArray(dom?.rows) ? dom.rows : [];
    // MERGED, NOT CONCATENATED. The same item arrives twice — once as markup, once as JSON — so
    // identity has to come from the fields, and by the SAME rule the DOM half already uses. See
    // `rowIdent` in harvest.js: it is `identOf`'s rule for rows that are objects, kept in one place
    // so the two halves of a walk cannot disagree about what "the same item" means.
    //
    // Network first: where both halves hold an item, the payload's version wins, because it has the
    // fields the markup left out and no truncation.
    const out = [];
    const seenKeys = new Set();
    for (const r of [...fromNetwork, ...domRows]) {
      const k = rowIdent(r);
      if (!k || seenKeys.has(k)) continue;
      seenKeys.add(k);
      out.push(r);
    }
    return {
      rows: out,
      fromNetwork: fromNetwork.length,
      fromDom: domRows.length,
      calls: sawCalls,
      // `collect`'s own verdict on why the walk ended, passed through rather than re-derived.
      ended: dom?.ended || '',
      why: dom?.why || '',
      capped: !!dom?.capped,
      ...(why ? { netWhy: why } : {}),
      ...(fromNetwork.length ? {} : {
        netHint: 'nothing came out of the responses — check rows.at against '
          + 'tab_here({network:"*"}) on this page. The DOM half still ran.',
      }),
    };
  } finally {
    await netClose(st);
  }
}
