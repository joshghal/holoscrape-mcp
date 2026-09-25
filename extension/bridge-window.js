// THE SOCKET LIVES HERE, IN A WINDOW, ON PURPOSE.
//
// It used to live in the service worker, and that is why it kept dying. Chrome evicts an MV3 service
// worker after ~30 seconds of quiet and the WebSocket goes with it — measured: the connection dropped
// and had not come back twelve minutes later. Chrome 116 does extend a worker's life on WebSocket
// traffic, but the openclaw relay reports being killed anyway when the browser is backgrounded or
// under memory pressure, with a five-second ping running. A worker is the wrong place for something
// that must not stop.
//
// A window is an ordinary page. It is not evicted. It holds a socket for as long as it is open, which
// is exactly what figma-agent-bridge relies on — its plugin UI is a live iframe, and that, not a
// cleverer retry loop, is why its connected light stays on.
//
// AND IT IS VISIBLE, WHICH IS A FEATURE. This is a socket to a local process, inside a browser signed
// into the person's mail and bank. A hidden offscreen document would survive just as well and would
// tell them nothing. If they close this window the connection stops — that is a disconnect they chose
// and can see, which beats the invisible kind.
//
// This page owns: dialling, the pairing handshake, the heartbeat, reconnection. It owns no privileges
// of its own — every actual operation is handed to the service worker, which is where the tab state,
// the walks and the consent checks live.
// From env.js, so a test build dials its own range and leaves the live one alone.
import { PORT_BASE as ENV_PORT_BASE } from './env.js';
// The values this window shares with the worker and the server — the port span, the close codes,
// the message words — live in tuning.js so the two ends cannot drift apart. Each is explained there.
import {
  LOOPBACK_HOST, PORT_BASE_DEFAULT, PORT_SPAN, TOKEN_PROTO, WS_CLOSE, MAX_ERROR_CHARS,
  BRIDGE_SETTINGS_KEY, HS, WIN_MSG,
} from './tuning.js';
const PORT_BASE = Number(ENV_PORT_BASE) || PORT_BASE_DEFAULT;

// --- this window's own timings -------------------------------------------------------------------
// How long one port is given to complete the WebSocket upgrade before the dial gives up on it. The
// ports are dialled together (see `dial`) so one dead port cannot delay a live one behind this; on
// loopback a port nobody holds refuses instantly, so this is only ever paid by a listener that
// accepted TCP and then stalled.
const DIAL_MS = 1500;
// A beat between closing every socket with `TURNED_OFF` and answering the worker's `hs:off`, so the
// close frames have left the socket before the worker removes this window from under them.
const OFF_ACK_BEAT_MS = 150;
// Consecutive "no panel is open" answers before this window closes itself, so a worker that was
// merely asleep for one round does not read as a closed panel. See the panel watch below.
const NO_PANEL_CONFIRM = 2;
const REDIAL_MS = 3000;
// How often to look for an agent that started AFTER this window connected. See the timers at the
// bottom for why this is slower than the redial.
const SWEEP_MS = 5000;
// The worker is still needed to DO the work, so it gets nudged often enough never to be evicted while
// this window is open. Cheap: one message, no reply used.
const NUDGE_MS = 8000;

const el = (id) => document.getElementById(id);
const state = { at: '', paired: false, since: 0, why: 'starting', agents: 0, off: false, hosts: [] };

// ONE SOCKET PER SERVER, NOT ONE SOCKET.
//
// Every agent session starts its own MCP server, and a server takes the lowest FREE port in the
// range — so the session started first sits on 27182 and the newest one on 27185. This window used
// to keep a SINGLE socket, to whichever port answered first, which is the lowest port, which is the
// OLDEST server; and it never re-dialled while that socket was alive. Those two together mean the
// browser was permanently bound to the session started first, while the person is always working in
// the session started last. A fresh session got "No browser connected" every single time — not
// intermittently, deterministically — and nothing in the side panel could move it, because nothing
// was wrong with the pairing. It cost several sessions to whole-hour investigations.
//
// Handing the browser to the NEWEST server instead only inverts the same bug: switching BACK to an
// earlier session would then fail identically. There is no correct single choice, because the
// premise is wrong — the browser is not a thing one agent owns.
//
// So: hold a socket to EVERY server that answers, and keep sweeping for ones that appear later.
// Every live session can drive the browser, switching between them costs nothing, and which port a
// server happened to get stops meaning anything at all. The worker still performs every operation,
// so consent and tab state have exactly one home however many agents are attached.
const socks = new Map();              // port -> WebSocket, present only while the socket is open
let dialing = false;
const refusedBy = new Map();          // port -> token it rejected; never a global "bad token"

// PER-SESSION, NOT PER-PORT. A port is reused — this server exits, a different agent binds the same
// number a minute later — so "release 27182" has to mean the session that was ON it, never whoever
// answers there next. The server hands each process a random id at startup; this is the set of ids a
// person has released, checked the moment a `welcome` names one, before it ever counts as connected.
const releasedSessions = new Set();
// EVERY HOST EVER SEEN, KEPT EVEN WHILE RELEASED. `socks`/`ready()` answer "is it connected right
// now"; a released row still needs to be drawn — with its session, its client name, a Reconnect
// button — from something that does not vanish the moment its socket closes. port -> {session, client,
// released}.
const knownHosts = new Map();

// Open is not the same as usable: a socket counts only once the server has said `welcome`.
const ready = () => [...socks.entries()].filter(([, ws]) => ws.hsReady).map(([at]) => at).sort();

function paint() {
  // Matches the revamped bridge-window.html: `.status` carries on/off instead of a standalone pill,
  // and the pulse lives in CSS on `.on .dot::after` — this only ever toggles the class.
  el('status').className = `status ${state.paired ? 'on' : 'off'}`;
  el('word').textContent = state.paired ? 'Connected' : 'Not connected';
  el('why').textContent = state.paired ? '' : (state.why || '');
  if (state.off) el('word').textContent = 'Turned off';
  paintHosts();
  document.title = state.paired
    ? `HoloScrape — connected${state.agents > 1 ? ` · ${state.agents} agents` : ''}`
    : 'HoloScrape — not connected';
}

// ONE ROW PER HOST, EACH WITH ITS OWN RELEASE. Reused by the panel's own list (it reads `state.hosts`
// off the same `tell()`), so the two never draw a different set of connections.
function hostLabel(h) {
  const who = h.client?.name || 'an agent';
  return h.released ? `${who} — released` : who;
}
function paintHosts() {
  state.hosts = [...knownHosts.entries()]
    .map(([port, h]) => ({ port, session: h.session, client: h.client, released: h.released }))
    .sort((a, b) => a.port - b.port);
  const box = el('hosts');
  if (!box) return;
  box.textContent = '';
  for (const h of state.hosts) {
    const row = document.createElement('div');
    row.className = `host${h.released ? ' released' : ''}`;
    const label = document.createElement('span');
    label.className = 'hwho';
    label.textContent = hostLabel(h);
    const at = document.createElement('span');
    at.className = 'hat';
    at.textContent = `${LOOPBACK_HOST}:${h.port}`;
    const btns = document.createElement('span');
    btns.className = 'hbtns';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = h.released ? 'Reconnect' : 'Release';
    btn.onclick = () => (h.released ? reconnectHost(h.port) : releaseHost(h.port));
    btns.append(btn);
    // ONLY ON A LIVE ROW. Killing sends a message DOWN this session's own socket — a released row
    // has none, so there is nothing to send the command through until it reconnects.
    if (!h.released) {
      const kill = document.createElement('button');
      kill.type = 'button';
      kill.className = 'kill';
      kill.title = 'Ends the agent’s process entirely and frees its port for a fresh session — cannot be undone.';
      kill.textContent = 'End session';
      kill.onclick = () => killHost(h.port);
      btns.append(kill);
    }
    row.append(label, at, btns);
    box.append(row);
  }
}

// The service worker keeps the copy the side panel draws, so the two never disagree.
const tell = () => chrome.runtime.sendMessage({ hs: HS.STATE, state: { ...state } }).catch(() => {});

// `paired` IS DERIVED, NEVER ASSIGNED. With several sockets, one server going away must not paint
// the panel red while another is still live — which is exactly what an assigned flag would do.
function sync(why) {
  const on = ready();
  const was = state.paired;
  state.paired = on.length > 0;
  state.agents = on.length;
  state.at = on.map((p) => `${LOOPBACK_HOST}:${p}`).join('  ·  ');
  if (!state.paired) state.why = state.off ? 'turned off' : (why || '');
  else { state.why = ''; if (!was) state.since = Date.now(); }
  paint();
  tell();
}

async function settings() {
  const { [BRIDGE_SETTINGS_KEY]: bridge = {} } = await chrome.storage.local.get(BRIDGE_SETTINGS_KEY);
  // Kept in step with `bridge.js`'s `settings()` — see the note there for why this defaults on.
  // The guard below at `if (off || !enabled || !token)` is what actually stops a dial, and the
  // token half of it is untouched by this.
  const now = { token: '', origins: {}, enabled: true, off: false, keepOnClose: true, ...bridge };
  // Same reading as `bridge.js`'s `settings()`, and it has to be the same or the window and the
  // panel disagree about whether to dial. See the note there.
  if (now.enabled === false && now.off !== true) now.enabled = true;
  return now;
}

// `code` travels to each server in the close frame. `TURNED_OFF` means the person turned agents off,
// and the server tells its agent exactly that instead of "reload the extension".
function shut(why, code = WS_CLOSE.NORMAL) {
  for (const ws of socks.values()) { try { ws.close(code, code === WS_CLOSE.TURNED_OFF ? 'turned off' : ''); } catch (_) {} }
  socks.clear();
  sync(why);
}

// ONE HOST, LEFT FOR A PERSON TO PICK. Everything else on this page is "is any agent connected" —
// this is the only place that acts on a SPECIFIC one, by the session id its own welcome carried, not
// by the port (a port a released session vacates is picked up by the next agent that binds it, and
// that new session must connect normally — see releasedSessions above).
function releaseHost(port) {
  const ws = socks.get(port);
  const known = knownHosts.get(port);
  const session = ws?.hsSession || known?.session;
  if (!session) return;
  releasedSessions.add(session);
  if (known) known.released = true;
  paintHosts(); tell();
  if (ws) { try { ws.close(WS_CLOSE.RELEASED, 'released'); } catch (_) {} }
}

// THE ONE ACTION THAT ENDS THE PROCESS, NOT JUST THE CONNECTION. Sent, not assumed: unlike release
// (which the extension decides on its own and shows immediately), this waits for the server to
// actually confirm it is exiting — close code `WS_CLOSE.ENDED`, handled in `onclose` below — before the row goes
// away, so a message that never reached a dead or dying socket is never reported as a session that
// is gone. If the port was full and this is why you're here: once the process exits, the OS frees the
// port, and the next `mcp/index.mjs` that starts binds it automatically on its own next redial.
function killHost(port) {
  const ws = socks.get(port);
  if (!ws) return;   // no live channel — nothing to send the command down
  try { ws.send(JSON.stringify({ type: 'terminate' })); } catch (_) {}
}

// Undoes a release. The socket for that port is very likely already gone — released hosts self-close
// the instant a redial reaches them — so this does not reopen anything itself; it only removes the
// block, and the next dial (already running every few seconds) reconnects it like any other host.
function reconnectHost(port) {
  const known = knownHosts.get(port);
  if (known?.session) releasedSessions.delete(known.session);
  if (known) known.released = false;
  paintHosts(); tell();
  dial();
}

// One server let go of, the rest untouched — a neighbour dropping is not a disconnect.
function drop(at, ws, why) {
  if (socks.get(at) === ws) socks.delete(at);
  sync(why);
}

// One operation, handed to the worker and answered back over THE SOCKET IT ARRIVED ON. Nothing is
// executed here: this page is transport, and keeping it that way means there is exactly one place
// where consent is checked.
//
// The socket is passed in rather than read from a module-level variable, because with more than one
// agent attached a shared variable would hand an answer to whichever server happened to connect
// last — the caller waiting on it would time out while another server got a reply to an id it never
// sent.
async function relay(msg, ws) {
  const reply = (body) => { try { ws.send(JSON.stringify({ id: msg.id, ...body })); } catch (_) {} };
  try {
    const out = await chrome.runtime.sendMessage({ hs: HS.OP, op: msg.op, args: msg.args || {} });
    if (out && out.error) reply({ error: String(out.error).slice(0, MAX_ERROR_CHARS) });
    else reply({ result: out ? out.result : null });
  } catch (e) {
    reply({ error: String(e?.message || e).slice(0, MAX_ERROR_CHARS) });
  }
}

function tryPort(at, token) {
  return new Promise((resolve) => {
    let ws;
    // The token rides in the subprotocol, so a wrong one is refused at the upgrade and `onopen` never
    // fires. That is what makes "connected" mean connected rather than "a TCP socket exists".
    try { ws = new WebSocket(`ws://${LOOPBACK_HOST}:${at}/`, [TOKEN_PROTO + token]); } catch (_) { return resolve(false); }
    const bail = setTimeout(() => { try { ws.close(); } catch (_) {} resolve(false); }, DIAL_MS);

    ws.onopen = () => {
      clearTimeout(bail);
      // Still not paired: the server says when, with `welcome`. Claiming it here is the bug that had
      // the panel showing "Connected — 127.0.0.1:27182" while the server had nobody.
      ws.hsReady = false;
      socks.set(at, ws);
      sync(`handshaking with ${LOOPBACK_HOST}:${at}`);
      resolve(true);
    };

    ws.onmessage = (e) => {
      let m = null;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.type === 'welcome') {
        ws.hsSession = m.session; ws.hsClient = m.client || null;
        // A SESSION THE PERSON ALREADY RELEASED, RECONNECTING ON ITS OWN. The redial loop still dials
        // every port on its normal cadence — cheaper than tracking which ones to skip, and it is what
        // lets a genuinely NEW session on this same port connect without anyone pressing Reconnect. If
        // the welcome names a released session, the row stays as released and this socket goes straight
        // back down: never marked ready, never counted, nothing for `sync()` to have changed.
        if (releasedSessions.has(m.session)) {
          knownHosts.set(at, { session: m.session, client: m.client || knownHosts.get(at)?.client || null, released: true });
          paintHosts(); tell();
          try { ws.close(WS_CLOSE.RELEASED, 'released'); } catch (_) {}
          return;
        }
        ws.hsReady = true;
        knownHosts.set(at, { session: m.session, client: m.client || null, released: false });
        return sync();
      }
      // The client name arriving late — `initialize` can land after this socket already connected.
      // Updates the row without touching `paired`/`agents`, which did not change.
      if (m.type === 'identity' && ws.hsSession === m.session) {
        ws.hsClient = m.client || null;
        const known = knownHosts.get(at);
        if (known) known.client = m.client || null;
        paintHosts(); tell();
        return;
      }
      // Answering the heartbeat proves this end is alive and lets the server drop half-open sockets.
      if (m.type === 'ping') { try { ws.send(JSON.stringify({ type: 'pong' })); } catch (_) {} return; }
      if (m.op) relay(m, ws);
    };

    ws.onerror = () => { clearTimeout(bail); resolve(false); };
    ws.onclose = (e) => {
      clearTimeout(bail);
      // ONLY 4001 MEANS REFUSED. 1006 no longer belongs in this check.
      //
      // Browsers report every handshake failure — nothing listening, TCP refused, DNS failure — as
      // the SAME close code, 1006, with no reason, deliberately: exposing which of those actually
      // happened would let a web page fingerprint services on the person's machine. Treating 1006 as
      // "the code was refused" is how this window told a person their pairing code was rejected by
      // all four ports when nothing was running on any of them — a specific, confident, and entirely
      // fabricated diagnosis.
      //
      // 4001 is different: the server now completes the WebSocket handshake unconditionally and
      // sends a real close frame with a real code only once the connection has actually opened —
      // which is the one thing that CAN'T happen for a socket that was never listening. Only that
      // code is trusted here.
      const refused = !ws.hsReady && e?.code === WS_CLOSE.REFUSED;
      if (refused) refusedBy.set(at, token);
      // ENDED (4004): THE PROCESS ITSELF IS GONE, ASKED TO BY THE PERSON. Unlike RELEASED (4003 —
      // reversible, the row stays and offers Reconnect because the process is still running), there
      // is nothing left on the other end to reconnect to — the row is removed outright rather than
      // kept as a released ghost with a button that could never actually do anything.
      if (e?.code === WS_CLOSE.ENDED) knownHosts.delete(at);
      // RELEASED/ENDED CLOSE QUIETLY. Both are the person's own deliberate action — the row already
      // said so before either `.close()` call happened — so "disconnected (code 400X, clean)" would
      // read as a fault neither of them is.
      drop(at, ws, e?.code === WS_CLOSE.RELEASED ? 'released' : e?.code === WS_CLOSE.ENDED ? 'ended' : refused
        ? `the pairing code was refused by ${LOOPBACK_HOST}:${at} — pair again in the side panel`
        : `disconnected (code ${e?.code ?? '?'}${e?.wasClean ? ', clean' : ', abrupt'})`);
      resolve(false);
    };
  });
}

// EVERY PORT, EVERY SWEEP — there is no first responder to stop at any more. Ports already held are
// skipped, so a sweep only ever costs a dial to a port nobody is on, and the ones that are dead
// refuse instantly on loopback. They are dialled together rather than in turn so that one dead port
// cannot delay a live one behind its `DIAL_MS` timeout.
async function dial() {
  if (dialing) return;
  const { token, enabled, off } = await settings();
  state.off = !!off;
  if (off || !enabled || !token) {
    if (off) knownHosts.clear();   // agents off entirely — a stale released-host row would be confusing
    return sync(off ? 'turned off' : token ? 'switched off' : 'not paired yet');
  }
  dialing = true;
  const ports = [];
  for (let i = 0; i < PORT_SPAN; i++) ports.push(PORT_BASE + i);
  try {
    await Promise.all(ports.map((at) => (
      // Skip only the ports that refused THIS token. A neighbour's server saying no says nothing
      // about the one we want — treating it as "the code is bad" is what silently broke reconnection.
      socks.has(at) || refusedBy.get(at) === token
        ? Promise.resolve(false)
        : tryPort(at, token).catch(() => false)
    )));
  } finally { dialing = false; }
  if (socks.size) return;
  const refused = [...refusedBy.entries()].filter(([, t]) => t === token).map(([p]) => p);
  sync(refused.length
    ? `the pairing code was refused by ${LOOPBACK_HOST}:${refused.join(', ')} — pair again`
    : `no agent listening on ${LOOPBACK_HOST}:${PORT_BASE}-${PORT_BASE + PORT_SPAN - 1}`);
}

// NOBODY ELSE CAN CLOSE THIS WINDOW WHEN THE EXTENSION GOES, SO IT CLOSES ITSELF.
//
// Removing an extension runs no code in it — there is no uninstall hook that could tidy up, and the
// service worker is gone before it could be told. Measured: the extension was removed and this
// window stayed on screen, still saying "Keep this window open", now attached to nothing at all.
// A reload has the same shape for a moment: the old page's context is invalidated while a fresh
// worker starts, and the window it opens would be the SECOND one.
//
// An extension page whose extension has gone loses `chrome.runtime.id` — reading it is the cheapest
// possible liveness check, and any call across that boundary throws "Extension context
// invalidated". Either is proof. The socket is closed first so the server sees a real disconnect
// rather than a half-open connection it has to time out.
// THE WINDOW WATCHES FOR THE PANEL, BECAUSE IT IS THE ONLY THING HERE WITH A RELIABLE CLOCK.
//
// Closing the side panel is supposed to close this window, and it does — eventually. Both existing
// paths are wrong for the job: the panel's port `onDisconnect` fires instantly but its listener
// lives inside one service-worker instance and is gone after the first eviction, and the alarm that
// exists to cover that runs at `periodInMinutes: 1`, which is the floor Chrome allows. Measured
// consequence: the panel is closed and this window sits there for up to a minute still saying
// "Keep this window open".
//
// A window is not evicted — that is the whole reason the socket lives here — so it can simply ask
// every few seconds. The worker answers with `chrome.runtime.getContexts({SIDE_PANEL})`, which
// `test/panel-close.mjs` verifies reports zero when no panel is open and does not mistake THIS
// window (a TAB context) for one. `NO_PANEL_CONFIRM` consecutive noes before acting, so a worker
// that was merely asleep for one round does not read as a closed panel.
const PANEL_WATCH_MS = 3000;
let noPanel = 0;
setInterval(async () => {
  let open = null;
  try {
    const r = await chrome.runtime.sendMessage({ hs: HS.PANELS });
    open = r && typeof r.open === 'boolean' ? r.open : null;
  } catch (_) { open = null; }
  if (open === null) return;            // could not ask — says nothing either way
  if (open) { noPanel = 0; return; }
  if (++noPanel < NO_PANEL_CONFIRM) return;
  // THE SAME OVERRIDE THE SERVICE WORKER ALREADY HONOURS, MISSING FROM HERE UNTIL NOW.
  //
  // This window closing itself when the panel goes was the ORIGINAL design (see the file's own
  // opening comment: "that is a disconnect they chose and can see") — written before
  // `keepOnClose` existed to let someone opt out of exactly that. The setting was added to
  // `bridge.js` in the service worker, which stopped IT from closing the window on a panel
  // disconnect — but this watchdog runs in the window's OWN page, checks the same "is a panel
  // open" fact on its own three-second timer, and had never been told about the setting at all.
  // Measured: toggle on, close the sidebar, the service worker correctly declines to close this
  // window — and six seconds later this loop closes it anyway, the toggle having had no say.
  // `noPanel` is deliberately left as it is rather than reset to 0: if the setting is switched
  // off again while the panel is still closed, the very next tick should act on it immediately
  // rather than making someone wait through two more polls it has already passed.
  const { keepOnClose } = await settings();
  if (keepOnClose) return;
  shut('the connection window is closing');
  window.close();
}, PANEL_WATCH_MS);

const ORPHAN_MS = 2000;
setInterval(() => {
  let alive = false;
  try { alive = !!chrome.runtime?.id; } catch (_) { alive = false; }
  if (alive) return;
  shut('the connection window is closing');
  window.close();
}, ORPHAN_MS);

// A window can hold a plain interval and be trusted to still be here for it — the whole reason the
// socket moved out of the worker. Idle cost is one comparison every three seconds.
//
// TWO CADENCES, because the two jobs are not the same job. Holding nothing is an outage and gets the
// fast retry. Holding something and looking for a session that started since is housekeeping, and it
// runs slower on purpose: a dial to a port with nothing on it is refused instantly but Chrome still
// prints it to the console, and sweeping four ports every three seconds forever would bury anything
// else in this window's log. Five seconds is the delay a newly-started agent waits to be picked up
// without the person touching anything, which is the whole point.
setInterval(() => { if (!socks.size) dial(); }, REDIAL_MS);
setInterval(() => { if (socks.size && socks.size < PORT_SPAN) dial(); }, SWEEP_MS);
setInterval(() => {
  // The same signal, arriving the other way: a send that fails because the context is invalidated
  // is the extension having gone, not a message that missed.
  chrome.runtime.sendMessage({ hs: HS.ALIVE }).catch((e) => {
    if (!/context invalidated|Receiving end does not exist/i.test(String(e?.message || e))) return;
    let alive = false;
    try { alive = !!chrome.runtime?.id; } catch (_) { alive = false; }
    if (alive) return;                       // worker merely asleep — that is normal and fine
    shut('the connection window is closing');
    window.close();
  });
}, NUDGE_MS);

// PROOF OF LIFE, ON DEMAND. The worker asks before deciding this window is the one that is already
// connected. A window whose context an extension reload invalidated cannot reach this listener, so
// silence is the answer — and silence is what tells the worker to replace it rather than trust it.
chrome.runtime.onMessage.addListener((msg, _from, respond) => {
  // The worker asks before it removes this window, so every socket closes with the reason attached
  // rather than being cut from under it. A beat for the close frames to leave before answering.
  if (msg?.type === WIN_MSG.OFF) {
    state.off = true;
    shut('turned off', WS_CLOSE.TURNED_OFF);
    setTimeout(() => respond({ ok: true }), OFF_ACK_BEAT_MS);
    return true;
  }
  // The panel's per-host buttons reach here the same way — it has no socket of its own to act on.
  if (msg?.type === WIN_MSG.RELEASE) { releaseHost(msg.port); respond({ ok: true }); return true; }
  if (msg?.type === WIN_MSG.RECONNECT) { reconnectHost(msg.port); respond({ ok: true }); return true; }
  if (msg?.type === WIN_MSG.KILL) { killHost(msg.port); respond({ ok: true }); return true; }
  if (msg?.type !== WIN_MSG.ALIVE) return false;
  respond({ alive: true, at: ready() });
  return true;
});

// Pairing or switching on happens in the side panel, which writes storage; this notices and dials.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[BRIDGE_SETTINGS_KEY]) return;
  refusedBy.clear();                     // a new code deserves a clean slate on every port
  releasedSessions.clear();              // a released HOST, not a released CODE — a new pairing starts over
  knownHosts.clear();
  const off = !!changes[BRIDGE_SETTINGS_KEY].newValue?.off;
  state.off = off;
  if (socks.size) shut(off ? 'turned off' : 're-pairing', off ? WS_CLOSE.TURNED_OFF : WS_CLOSE.NORMAL);
  dial();
});

paint();
dial();
