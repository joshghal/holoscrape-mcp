// The extension's end of the MCP bridge.
//
// WE DIAL OUT, ALWAYS. A service worker cannot listen on a port and nothing outside Chrome can
// call into an extension, so the local `holoscrape-mcp` process listens and this connects to it.
// That inversion is not a workaround — it is what keeps the browser being the person's own
// browser, with their logins, instead of a clean one we launched.
//
// THREE THINGS THIS FILE IS RESPONSIBLE FOR, and the last two are why it is not fifty lines:
//
//   1. staying connected, across a service worker that Chrome evicts whenever it likes
//   2. proving who is on the other end, because 127.0.0.1 is not a trust boundary
//   3. refusing to touch an origin the person has not agreed to
//
// On (2): every process on the machine can reach that port, and what is behind it is a browser
// signed into their mail and their bank. An npm postinstall script could open a socket to it. So
// the server prints a pairing code, the person types it here once, and a connection that cannot
// present it is dropped before it can ask for anything.
//
// On (3): the same reasoning one step further in. A paired agent is still an agent reading web
// pages, and a web page can carry instructions aimed at it. Per-origin consent means the worst a
// poisoned page can talk an agent into is more of the site the person already allowed.

import { UNBLOCK, DEV } from './env.js';
// What this worker and the connection window have to agree on — the storage key, the message words,
// how much of an error travels — is named once in tuning.js. Each value is explained there.
import { TOKEN_MIN_CHARS, MAX_ERROR_CHARS, BRIDGE_SETTINGS_KEY, HS, WIN_MSG } from './tuning.js';

// --- this file's own timings and sizes -----------------------------------------------------------
// The connection window's size. A popup wide enough for one host row — label, `127.0.0.1:port`,
// Release / End session — and tall enough for the handful of rows a developer's sessions make.
const WIN_WIDTH = 520;
const WIN_HEIGHT = 400;
// How long `bridgeEnable(false)` waits for the window to acknowledge `hs:off` before removing it
// anyway. The window closes its own sockets with a code that says why (see the note at the call);
// this is the most a hung or already-dead window may hold up the person's "off".
const OFF_ACK_MS = 900;

// The socket, the ports and the redial timers all moved to `bridge-window.js`. What stays here is
// the operation table the window relays into, and the consent gate that guards it.
let ops = {};

async function settings() {
  const { [BRIDGE_SETTINGS_KEY]: bridge = {} } = await chrome.storage.local.get(BRIDGE_SETTINGS_KEY);
  // `enabled` DEFAULTS ON, and grants nothing by itself. Three separate things have to be true
  // before an agent reads a single page, and this is the weakest of them: `bridge-window.js`
  // refuses to dial any port without a TOKEN, the token rides in the WebSocket subprotocol so a
  // wrong one is refused at the upgrade, and page access is gated PER ORIGIN on top of that.
  // Defaulting it off meant a person who had already pasted a pairing code still found nothing
  // connected, with the reason three screens away — a switch that reads as broken rather than as
  // safe. `off` still defaults false and is written only by a person, so an explicit turn-off is
  // still a decision that holds. Mirrored in `bridge-window.js`'s own `settings()`; the two are
  // read by different contexts and drift silently if only one is changed.
  const now = { token: '', origins: {}, enabled: true, off: false, autoWindow: true, keepOnClose: true, ...bridge };
  // A STORED `enabled:false` IS USUALLY NOT A DECISION. `saveSettings` writes the whole merged
  // object, so the first save of anything at all — granting one origin, pairing once — baked the
  // THEN-CURRENT default into storage. Every profile that ever used the extension therefore holds
  // `enabled:false` whether or not anyone chose it, and because the stored object is spread last,
  // that stale value outranks the default above and flipping the default alone changes nothing.
  //
  // `off` is what tells the two apart: `bridgeEnable(false)` is the only writer of `off:true`, and
  // only a person calls it (see the note above it). So `enabled:false` WITHOUT `off` is the old
  // default echoing back, and is read as on; `off:true` is someone saying no, and still holds.
  if (now.enabled === false && now.off !== true) now.enabled = true;
  return now;
}
async function saveSettings(patch) {
  const now = await settings();
  await chrome.storage.local.set({ [BRIDGE_SETTINGS_KEY]: { ...now, ...patch } });
  return { ...now, ...patch };
}

// --- what may be read ----------------------------------------------------------------------------
// Three answers: a blank tab (nothing to read yet — say so, it is not a refusal), a non-web scheme
// (never readable), or a web page (readable: pairing was the consent, see below).
function originOf(url) {
  try { return new URL(url).origin; } catch (_) { return ''; }
}
async function allowed(url) {
  const o = originOf(url);
  // A BLANK TAB IS NOT A REFUSED SITE, AND SAYING SO WRONGLY COSTS THE WHOLE RUN.
  //
  // A new-tab page has no origin, so this once fired with the same words as a refused site — and
  // the caller was told, in the hint, to go and get it approved. There was nothing to approve. Measured: a session read that as the browser being unavailable
  // and abandoned navigate-and-capture entirely on the case it was designed for. An empty url is a
  // tab sitting on nothing; the answer is to send it somewhere, which is a tool call, not a click.
  if (!o) {
    return url
      ? { ok: false, origin: '', why: 'that is not a URL we can open' }
      : { ok: false, origin: '', blank: true,
        why: 'that tab is empty — it is not on a page yet, so there is nothing to consent to. '
          + 'Point it at a URL with tab_here, or open one with tab_here newTab:true.' };
  }
  if (!/^https?:$/.test(new URL(url).protocol)) {
    return { ok: false, origin: o, why: 'only http and https pages can be read' };
  }
  // PAIRING IS THE CONSENT. There used to be a second lock here — a per-origin list the person
  // filled in from the panel, one site at a time — and it was removed on purpose (2026-09-23): a
  // person who pastes a pairing code into this browser has already said which program may read it,
  // and a sixth setup step that refused every first read with "go and click Allow" was measured as
  // the step people got stuck on, not the one that protected them. The restricted-host list below
  // (`restrictedHost`) is the lock that survives: it names the pages an agent may never touch and
  // no click lifts it. `bridgeGrant` and the stored `origins` are kept for the test harness only;
  // nothing reads them here.
  return { ok: true, origin: o };
}

// --- the socket is NOT here any more -------------------------------------------------------------
//
// It lived in this service worker and that is why it kept stopping. Chrome evicts an MV3 worker after
// ~30 seconds of quiet and takes the WebSocket with it; measured, the connection dropped and had not
// returned twelve minutes later. Chrome 116 extends a worker's life on WebSocket traffic, and it is
// still not enough — the openclaw relay reports being killed while pinging every five seconds.
//
// So the socket moved to `bridge-window.html`, an ordinary page that Chrome does not evict, and this
// file kept the two things that belong to a worker: the operations, and consent. The window is
// transport; nothing it receives is executed there.
//
// The window is VISIBLE deliberately. A hidden offscreen document would work identically and would
// tell the person nothing about a socket open inside a browser holding their logins. Closing the
// window disconnects — a choice they can see and undo, rather than a failure they cannot.

// What the panel draws, mirrored from the window so the two never disagree.
const state = { at: '', paired: false, since: 0, why: 'the connection window is not open' };
let onState = () => {};
// THE SAME LESSON, ONE FILE OVER. A plain `winId` is lost when the worker is evicted, and the next
// `openWindow()` would then open a SECOND connection window while the first sat there connected.
// Stored where a window id belongs: session storage, gone when the browser is.
const WIN_KEY = 'bridgeWindowId';
async function winIdNow() {
  try { const g = await chrome.storage.session.get(WIN_KEY); return g?.[WIN_KEY] || 0; } catch (_) { return 0; }
}
async function setWinId(id) {
  try {
    await chrome.storage.session.set({ [WIN_KEY]: id || 0, [`${WIN_KEY}At`]: id ? Date.now() : 0 });
  } catch (_) { /* closing */ }
}
// When the current window was created, so a page that has not finished loading is not mistaken for
// a page that cannot answer. Zero for a window we did not open — which is exactly the case that
// must NOT get the benefit of the doubt.
async function winBornAt() {
  try { const g = await chrome.storage.session.get(`${WIN_KEY}At`); return g?.[`${WIN_KEY}At`] || 0; } catch (_) { return 0; }
}

// One window, ever. Chrome hands back a fresh id each time, so a stale one is checked before use
// rather than trusted — a closed window's id still looks like a number.
// EXISTING IS NOT THE SAME AS ALIVE, AND THAT DIFFERENCE IS THE "No browser connected" BUG.
//
// Reloading an unpacked extension does NOT close its windows. Chrome keeps the popup on screen and
// invalidates its script context: the page is still there, its sockets are dead, and it can never
// dial again. Meanwhile `winId` lives in storage.local and survives the reload — so this returned
// true, `openWindowNow` returned early, no window was created, nothing dialled, and every session
// after that read "No browser connected" until someone closed the corpse by hand.
//
// Measured across a whole afternoon and mis-diagnosed twice, because the fix that was made — having
// the window hold a socket to EVERY live server — lives INSIDE the window. It cannot help when the
// window is the thing that died.
//
// So liveness is now PROVEN rather than assumed: the window answers a ping, or it is not alive. The
// grace period is for the only honest false negative — a window created moments ago whose page has
// not finished loading and so has not registered its listener yet.
const WIN_GRACE_MS = 5000;
const WIN_PING_MS = 1200;

async function windowAlive() {
  const id = await winIdNow();
  if (!id) return false;
  try { await chrome.windows.get(id); } catch (_) { await setWinId(0); return false; }
  if (Date.now() - (await winBornAt()) < WIN_GRACE_MS) return true;
  const answered = await Promise.race([
    chrome.runtime.sendMessage({ type: WIN_MSG.ALIVE }).catch(() => null),
    new Promise((r) => setTimeout(() => r(null), WIN_PING_MS)),
  ]);
  if (answered?.alive) return true;
  // A window that cannot answer cannot connect. Remove it, so what replaces it is a working one and
  // the person is not left looking at two.
  await chrome.windows.remove(id).catch(() => {});
  await setWinId(0);
  state.why = 'the connection window was left behind by an extension reload — reopening';
  return false;
}

// CONCURRENT CALLERS SHARE ONE ATTEMPT, NOT ONE EACH.
//
// `openWindow` is called from several places that can genuinely fire close together — the panel
// connecting and its very first heartbeat ping land within the same tick of each other. Every step
// in here is async (`windowAlive` alone is two awaits), so two overlapping calls can each check "is
// one alive?", each see no window yet because NEITHER has finished creating one, and each go on to
// create its own. Measured on a real install: two windows, both titled "HoloScrape — connected",
// both genuinely paired, the extra one untracked and unclosable because only one winId can be
// stored at a time. This makes every call after the first AWAIT the same in-flight attempt instead
// of starting a second one.
let opening = null;
// EVERY OPEN SAYS WHO ASKED FOR IT. A window appearing on a ~90s rhythm was reported while the only
// timer with a 90 in it — the panel-staleness alarm — can nothing but CLOSE. That means some other
// caller is reopening it, and there are six of them; guessing which would be guessing. The reason
// is logged rather than inferred, so the next occurrence identifies its own cause in the service
// worker console instead of costing another round of theories.
async function openWindow(steal = true, why = 'unknown') {
  if (opening) return opening;
  console.log(`[holoscrape] opening the connection window — asked by: ${why}, focus: ${steal}`);
  opening = openWindowNow(steal).finally(() => { opening = null; });
  return opening;
}

async function openWindowNow(steal = true) {
  if (await windowAlive()) return;
  // FOCUSED BY DEFAULT, BUT ONLY WHEN SOMEONE JUST DID SOMETHING. It was `focused: false`
  // unconditionally, and the consequence was measured on a real install: the window opened — macOS
  // confirmed "HoloScrape — connected" existed — behind the browser's main window, where the person
  // looking for it saw nothing and reported no window at all. So a real action (pairing, flipping the
  // toggle, the Show button) still steals focus — that person is looking right at the panel.
  //
  // But the 5-second heartbeat backstop (`bridgePanelPing`) calls this too, every time it notices the
  // window died and silently reopens it, and that call has no gesture behind it at all — the person
  // could be typing in a different app entirely. Measured as the annoyance it is: the window kept
  // "coming back on screen" mid-typing, stealing focus for a reopen nobody asked for in that moment.
  // `steal:false` on that path only — `popup` still keeps it out of the tab strip either way.
  const w = await chrome.windows.create({
    url: chrome.runtime.getURL('bridge-window.html'),
    type: 'popup', width: WIN_WIDTH, height: WIN_HEIGHT, focused: steal,
  }).catch((e) => { state.why = `could not open the connection window: ${e?.message || e}`; return null; });
  // A SWALLOWED FAILURE HERE IS INVISIBLE ON A REAL INSTALL. `.catch(() => null)` used to be the
  // whole of this — no reason logged, nothing in `state.why` — so "no window opened" had no way to
  // become "here is why" short of reading source. Playwright never caught it because a headless
  // browser under test does not fail chrome.windows.create the way a person's real Chrome might.
  if (!w) { console.error('[holoscrape] chrome.windows.create failed:', state.why); onState({ ...state }); }
  await setWinId(w?.id || 0);
}

async function closeWindow() {
  if (!(await windowAlive())) return;
  const id = await winIdNow();
  await setWinId(0);
  await chrome.windows.remove(id).catch(() => {});
}

// A CLOSED WINDOW IS A DISCONNECT, AND MUST READ AS ONE. Registered at module scope so an evicted
// worker is still woken for it — the same rule that kept the redial alarm from ever firing.
// A close BY HAND is a decision, and the heartbeat must not overrule it. Our own `closeWindow` zeroes
// the id before removing, so reaching here with a matching id means a person closed it — remember
// that in session storage (an evicted worker forgets a variable, and forgetting is how the window
// kept resurrecting itself five seconds after being dismissed). Cleared by anything that IS a
// decision to reconnect: pairing, switching on, the Show button, or opening the panel fresh.
const USER_CLOSED_KEY = 'bridgeWindowUserClosed';
async function userClosed() {
  try { const g = await chrome.storage.session.get(USER_CLOSED_KEY); return !!g?.[USER_CLOSED_KEY]; } catch (_) { return false; }
}
async function setUserClosed(on) {
  try { await chrome.storage.session.set({ [USER_CLOSED_KEY]: !!on }); } catch (_) { /* closing */ }
}

chrome.windows.onRemoved.addListener(async (id) => {
  if (id !== await winIdNow()) return;
  // FIRES FOR ANY REASON THE WINDOW IS GONE — the person closing it, Chrome closing it, the
  // page inside it crashing. `keepOnClose` and `autoWindow` say nothing about THIS path; it
  // marks the closure as if the person meant it, which then blocks every automatic reopen
  // (`bridgePanelPing`, the panel's own onConnect) until a fresh 'panel' port connects. If the
  // window is disappearing on its own — not from the panel closing — this is where it is
  // happening, and the log line says so before anything else runs.
  console.log(`[holoscrape] connection window (id ${id}) was removed at ${new Date().toISOString()} `
    + '— marking userClosed=true, which blocks auto-reopen until the panel reconnects');
  await setWinId(0);
  await setUserClosed(true);
  state.paired = false;
  state.why = 'the connection window was closed — reopen the side panel to reconnect';
  onState({ ...state });
});

// THE CONNECTION LASTS EXACTLY AS LONG AS THE PANEL IS OPEN.
//
// Not a technical constraint — a decision about what this should mean. An agent driving a browser
// that holds someone's mail and bank is not a thing to leave running behind a closed panel; while
// the panel is open they can see it, and closing it is an unambiguous "stop".
//
// TWO SIGNALS, because one of them can go silently missing. The panel opens a `panel` port as a
// lifeline, and a port's `onDisconnect` fires INSTANTLY when it goes — but that listener lives
// entirely inside the specific service-worker instance that received the original `onConnect`, and
// that instance's whole JS memory is deleted the moment Chrome evicts it for being idle. Any panel
// left open longer than about thirty seconds outlives at least one eviction, and once that happens
// the listener that would have noticed its eventual close no longer exists anywhere to be woken —
// this is not a bug in the counter, it is the port itself becoming unwatchable. Measured: a panel
// closed for real and the connection window sat there regardless, still claiming to be live.
//
// So the port stays as the FAST path for the common case (worker still warm), and a heartbeat is
// the path that cannot be silently lost: the panel pings on an interval, and a ping is an ordinary
// `sendMessage`, which MV3 guarantees wakes an evicted worker to handle it — a fresh message always
// has a current instance to land in, unlike a listener attached to a worker that no longer exists.
// An alarm checks whether a ping has arrived recently; if every panel has stopped pinging, they are
// gone, and the window follows within one alarm tick.
let panelsOpen = 0;
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  panelsOpen++;
  chrome.storage.session.set({ [PANEL_SEEN_KEY]: true }).catch(() => {});
  // Opening the panel fresh is a decision to be back — it forgives an earlier manual close.
  setUserClosed(false).then(() => settings()).then(({ token, enabled, off, autoWindow }) => {
    // Same reasoning as bridgeStart: in a dev build, opening the panel is always enough — unless the
    // person turned agents off, or turned off automatic opening specifically. Neither is state a
    // reload wiped; both are decisions, and both hold.
    if (autoWindow && !off && (DEV || (enabled && token))) openWindow(false, 'panel port connected');
  }).catch(() => {});
  port.onDisconnect.addListener(async () => {
    panelsOpen = Math.max(0, panelsOpen - 1);
    if (panelsOpen > 0) return;
    // OPT-OUT OF THE INVARIANT ABOVE, and only because someone asked for it explicitly — see
    // `bridgeSetKeepOnClose`. Default stays off: state.paired is left exactly as it was, since
    // the window and its socket are, in fact, still there.
    const { keepOnClose } = await settings();
    console.log(`[holoscrape] panel port disconnected — keepOnClose=${keepOnClose} at ${new Date().toISOString()}`);
    if (keepOnClose) return;
    closeWindow();
    state.paired = false;
    state.why = 'the side panel was closed — the connection stops with it';
    onState({ ...state });
  });
});

// The backstop. Keyed by timestamp rather than a count, so it is correct for any number of open
// panels without needing to track them individually: as long as ONE is still pinging, the most
// recent ping keeps getting refreshed and staleness never triggers: once the last one goes quiet,
// this is what eventually notices.
const PANEL_PING_KEY = 'lastPanelPing';
const PANEL_WATCH_ALARM = 'holoscrape-panel-watch';
const PANEL_STALE_MS = 90000;   // several missed 5s pings, forgiving of a throttled background tab

// A PANEL WAS SEEN AT LEAST ONCE WHILE THIS BROWSER RAN. Without this, "no panel is open" cannot
// be told apart from "no panel has ever been open", and those demand opposite behaviour: the first
// is a person closing the panel and expecting the connection to stop, the second is an unattended
// reconnect after a browser restart, where there is no panel and never was one and closing the
// window would mean an agent could never work unless someone sat watching it.
//
// Measured: making the window poll for a panel every 3s — correct for the first case — broke the
// second immediately, and `bridge-durable` caught it ("reconnects on its own, with nobody opening
// the panel"). The once-a-minute alarm had been hiding the same conflict by being too slow to fire
// before that test finished.
const PANEL_SEEN_KEY = 'panelEverSeen';
async function panelEverSeen() {
  try { const g = await chrome.storage.session.get(PANEL_SEEN_KEY); return !!g?.[PANEL_SEEN_KEY]; } catch (_) { return false; }
}

export async function bridgePanelPing() {
  await chrome.storage.session.set({ [PANEL_PING_KEY]: Date.now(), [PANEL_SEEN_KEY]: true }).catch(() => {});
  if (await userClosed()) return { ok: true };   // they dismissed it; a ping is not permission to undo that
  const { token, enabled, off, autoWindow } = await settings();
  if (autoWindow && !off && (DEV || (enabled && token))) await openWindow(false, 'panel heartbeat ping');
  return { ok: true };
}

// Registered at module scope, synchronously — the same rule that kept the old redial alarm from
// ever firing when its listener was one `await` too late for Chrome to see during the worker's
// first turn. An alarm nobody sees is an alarm that never wakes anything.
// ASK CHROME, DON'T INFER. The ping-staleness check alone flapped on a real install: Chrome
// throttles a backgrounded panel's 5s interval hard enough that pings paused past the 90s bar while
// the panel WAS still open — so the alarm closed the window, the next ping that squeaked through
// reopened it, and the person watched it "come back on screen" every ~90 seconds while typing.
// `getContexts` is the direct question: is a side-panel document open right now?
async function panelIsOpen() {
  try {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
    return { known: true, open: ctxs.length > 0 };
  } catch (_) {
    return { known: false, open: false };   // older Chrome — fall back to the ping clock
  }
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== PANEL_WATCH_ALARM) return;
  if (!(await panelEverSeen())) return;    // never a panel to close — see PANEL_SEEN_KEY above
  const panel = await panelIsOpen();
  if (panel.known) {
    if (panel.open) {
      console.log(`[holoscrape] panel-watch tick: panel is open (getContexts) — leaving the window alone, at ${new Date().toISOString()}`);
      return;
    }
  } else {
    const got = await chrome.storage.session.get(PANEL_PING_KEY).catch(() => ({}));
    const last = got[PANEL_PING_KEY];
    // No ping ever recorded means no panel has opened since the browser started — nothing to clean
    // up, and not evidence of anything having closed.
    if (!last || Date.now() - last < PANEL_STALE_MS) {
      console.log(`[holoscrape] panel-watch tick: no ping stale enough yet (last=${last ? new Date(last).toISOString() : 'never'}) — leaving the window alone`);
      return;
    }
  }
  const { keepOnClose } = await settings();
  console.log(`[holoscrape] panel-watch tick: panel looks CLOSED (known=${panel.known}) — keepOnClose=${keepOnClose} at ${new Date().toISOString()}`);
  if (keepOnClose) return;
  if (!(await windowAlive())) return;
  await closeWindow();
  state.paired = false;
  state.why = 'the side panel was closed — the connection stops with it';
  onState({ ...state });
});
chrome.alarms.create(PANEL_WATCH_ALARM, { periodInMinutes: 1 });

// The window's half of the conversation. Three messages, and the third is the whole point: the worker
// still performs every operation, so consent and tab state have exactly one home.
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (!msg || !msg.hs) return undefined;
  if (msg.hs === HS.STATE) {
    Object.assign(state, msg.state || {});
    onState({ ...state });
    respond({ ok: true });
    return true;
  }
  // Answering at all is what keeps this worker warm while the window is open.
  if (msg.hs === HS.ALIVE) { respond({ ok: true }); return true; }
  // THE WINDOW ASKS THIS EVERY FEW SECONDS, because it has a clock Chrome cannot take away and the
  // alarm below cannot run faster than once a minute. `getContexts` is the direct question; a
  // browser too old to answer it reports `known:false`, and the window then leaves the decision to
  // the alarm rather than guessing.
  if (msg.hs === HS.PANELS) {
    // `open: true` when no panel has EVER been seen — nothing to have closed, so nothing to stop.
    Promise.all([panelIsOpen(), panelEverSeen()])
      .then(([p, ever]) => respond({
        open: !ever ? true : (p.known ? p.open : true),
        known: p.known,
        ever,
      }))
      .catch(() => respond({ open: true, known: false }));
    return true;
  }
  if (msg.hs === HS.OP) {
    const fn = ops[msg.op];
    if (!fn) { respond({ error: `this browser does not know how to "${msg.op}"` }); return true; }
    Promise.resolve(fn(msg.args || {}))
      .then((result) => respond({ result }))
      // Written for a model to relay to a person, so it says what to do about it.
      .catch((e) => respond({ error: String(e?.message || e).slice(0, MAX_ERROR_CHARS) }));
    return true;
  }
  return undefined;
});

// Synchronous for the panel's sake; `windowOpen` is refreshed by every state message from the
// window itself, so it does not need a storage read on this path.
export function bridgeState() { return { ...state }; }
export function onBridgeState(fn) { onState = fn; }

// Turning it on or off, and pairing. Separated because a person who pairs once should not have to
// pair again to stop it, and a stop that forgot the code would look like a bug.
export async function bridgePair(token) {
  const clean = String(token || '').trim().toUpperCase();
  if (clean.length < TOKEN_MIN_CHARS) throw new Error('that does not look like a pairing code');
  await saveSettings({ token: clean, enabled: true, off: false });
  await setUserClosed(false);
  // The window notices the storage write and dials; opening it is all this has to do.
  await openWindow(true, 'the person entered a pairing code');
  return bridgeState();
}
// OFF IS A DECISION THAT HOLDS. `enabled:false` alone was overruled in every dev build — the panel
// opening, its heartbeat and a reload all reopened the window on `DEV ||` — so turning agents off
// looked like it did nothing. `off` is written only here, by a person, and every automatic reopen
// checks it first. Pairing or turning it back on is the only thing that clears it.
export async function bridgeEnable(on) {
  await saveSettings({ enabled: !!on, off: !on });
  if (on) { await setUserClosed(false); await openWindow(true, 'the person switched it on'); }
  else {
    // The window closes its own sockets, with a code that says why, BEFORE it is removed. Removing it
    // first cuts them abruptly, and a server that sees only a dropped socket tells its agent to reload
    // the extension — the opposite of what the person just asked for.
    await Promise.race([
      chrome.runtime.sendMessage({ type: WIN_MSG.OFF }).catch(() => null),
      new Promise((r) => setTimeout(r, OFF_ACK_MS)),
    ]);
    await closeWindow();
    state.paired = false;
    state.agents = 0;
    state.why = 'turned off';
    onState({ ...state });
  }
  return bridgeState();
}
// A CLICK IS A GESTURE; NOTHING ELSE THAT OPENS THIS WINDOW IS. Called only from a button in the
// panel, so `chrome.windows.update`'s focus request is always backed by a real one — the same reason
// `focused: true` on the original `create()` cannot be trusted when that call came from a reload, a
// browser startup, or the unattended reconnect.
export async function bridgeShow() {
  await setUserClosed(false);
  if (await windowAlive()) {
    const id = await winIdNow();
    await chrome.windows.update(id, { focused: true }).catch(() => {});
    return bridgeState();
  }
  await openWindow(true, 'the person pressed Show');
  return bridgeState();
}

export async function bridgeGrant(origin, on) {
  const { origins } = await settings();
  const next = { ...origins };
  if (on) next[origin] = true; else delete next[origin];
  await saveSettings({ origins: next });
  return next;
}

// --- what the worker exposes ---------------------------------------------------------------------
// `bridgeOps` is the vocabulary an agent may ask for; the window relays into it and executes nothing
// itself, so this table is the only place operations exist.
export function bridgeOps(table) { ops = { ...ops, ...table }; }

// THIN ON PURPOSE. The window holds every socket; the worker has none to act on, so these just relay
// to it — same shape as `hs:off` above, one message type per action instead of one that overloads a
// boolean.
export async function bridgeReleaseHost(port) {
  return chrome.runtime.sendMessage({ type: WIN_MSG.RELEASE, port }).catch(() => ({}));
}
export async function bridgeReconnectHost(port) {
  return chrome.runtime.sendMessage({ type: WIN_MSG.RECONNECT, port }).catch(() => ({}));
}
export async function bridgeKillHost(port) {
  return chrome.runtime.sendMessage({ type: WIN_MSG.KILL, port }).catch(() => ({}));
}

// THE WINDOW ITSELF IS NOT OPTIONAL — its socket is the only place a WebSocket can survive an MV3
// service worker's eviction, documented at length above. What IS optional is whether it opens
// ITSELF: install, browser startup, a reload, the panel connecting, and the panel's own heartbeat all
// call `openWindow` with no click behind them. `bridgeShow`, `bridgePair` and `bridgeEnable(true)` are
// unaffected on purpose — a person who explicitly asks for the window always gets it; this only
// silences the paths nobody asked for anything on.
export async function bridgeSetAutoWindow(on) {
  await saveSettings({ autoWindow: !!on });
  return bridgeState();
}

// THE OTHER HALF OF "THE CONNECTION LASTS EXACTLY AS LONG AS THE PANEL IS OPEN" — see the long
// comment above `chrome.runtime.onConnect`. That is the default and stays the default; this is
// how someone overrides it on purpose, for a run they want to keep going with the sidebar shut.
// Off by default for the same reason `autoWindow` defaults to on: the safe behaviour has to be
// the one that happens with nobody touching a setting.
export async function bridgeSetKeepOnClose(on) {
  const t0 = Date.now();
  await saveSettings({ keepOnClose: !!on });
  // Read back through the SAME `settings()` every other check in this file uses, rather than
  // trusting the value just written — this is the number that answers "how long to propagate":
  // the gap between the write finishing and a fresh read seeing it, which is what a caller
  // actually experiences if it toggles this and closes the panel a moment later.
  const readBack = await settings();
  console.log(`[holoscrape] keepOnClose set to ${on} — write+readback took ${Date.now() - t0}ms, `
    + `readback confirms keepOnClose=${readBack.keepOnClose}`);
  return bridgeState();
}
export { allowed as bridgeAllows, settings as bridgeSettings, saveSettings as bridgeSave };

// Opening the connection window is the whole of "start" now. The window dials, keeps its own timers,
// and reports back — none of which a worker can be relied on to do.
export async function bridgeStart() {
  let { token, enabled, off, autoWindow } = await settings();
  // NEVER STEALS FOCUS FROM HERE. `bridgeStart` runs on install, on browser startup and on an
  // extension reload — none of which is a person asking for anything, so none of which has earned
  // the right to jump in front of what they were typing. Self-pairing made this path fire on every
  // dev install, which is how a window that used to appear only after a deliberate pairing started
  // appearing unbidden. The panel's Show button remains the way to raise it on purpose.
  // A DEV BUILD IS NOT GATED ON PRIOR STATE. In prod the gate is right: no window unless the person
  // has switched it on and paired, because a window that appears without being asked for is a
  // browser-driving agent announcing itself uninvited. In development it is exactly backwards —
  // reloading an unpacked extension is how it is worked on, that reload can clear the stored
  // enable/token, and the gate then makes the window silently never appear again no matter how many
  // times it is reloaded. Measured: three reloads, no window, no error, nothing to read.
  //
  // DEV is generated by build.mjs and is false in every prod build, which build.mjs enforces — so
  // this branch cannot exist in what ships. Same mechanism as UNBLOCK above it.
  if (autoWindow && !off && (DEV || (enabled && token))) {
    await openWindow(false, DEV ? 'dev build: reload always reconnects' : 'extension install / browser startup / reload');
  } else {
    state.why = off ? 'turned off'
      : !autoWindow && enabled && token ? 'automatic opening is off — press Show window to connect'
      : token ? 'switched off' : 'not paired yet';
    onState({ ...state });
  }
}

// A cold browser reopens the window, which then dials on its own. Registered by background.js at
// module scope for the same reason the old alarm listener had to be: an evicted worker is only woken
// for events whose listeners Chrome saw during the first turn of evaluation.
chrome.runtime.onStartup.addListener(() => { bridgeStart().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { bridgeStart().catch(() => {}); });
