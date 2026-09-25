// The panel's plumbing to the worker (`send`, stale-context detection, the log), the drawer sheet
// and its screens, and the AI-agents / connection screen. These share one module because they are
// one loop: `showStale` closes the drawer, `goScreen` repaints the connection screen, and the
// connection screen sends — splitting them would be a circular import.
import { $ } from './panel-util.js';
import { S } from './panel-state.js';

// Reloading (or updating) the extension tears down the old context. The panel
// document survives on screen but is orphaned: every message silently fails and
// the UI looks alive while doing nothing. Detect it and offer the one fix.
function contextAlive() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

function showStale() {
  if ($('stale').hidden === false) return;
  $('stale').hidden = false;
  $('panel').hidden = true;
  $('arm').hidden = true;
  // Nothing in the sheet works once the context is gone, so it must not be left
  // open over the notice explaining why.
  toggleDrawer(false);
}

// Long, because a deep scan legitimately holds one of these open for minutes. Bounded at
// all, because an unbounded await is how a suspended service worker wedges the panel: the
// promise neither resolves nor rejects, `busy` is never released, and every later press
// lands on a UI that looks alive and does nothing.
const SEND_TIMEOUT_MS = 300000;

async function send(msg) {
  if (!contextAlive()) { showStale(); throw new Error('stale'); }
  try {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('no answer from the extension')), SEND_TIMEOUT_MS);
    });
    try {
      return await Promise.race([chrome.runtime.sendMessage(msg), timeout]);
    } finally { clearTimeout(timer); }
  } catch (e) {
    if (/context invalidated|Receiving end does not exist|message port closed/i.test(e.message)) {
      showStale();
      throw new Error('stale');
    }
    throw e;
  }
}

// EVERY ACTION THIS PANEL TAKES, into the same log the worker writes.
//
// The log had 45 entries' worth of coverage and every one of them was in the worker: nothing about
// which button was pressed, which phase started, which card appeared or what was answered. So a
// run that stopped at 47 of 120 left a file that could not say why, and the honest answer to "what
// happened" was that we could not tell. Fire and forget — a log that can delay a press is worse
// than no log.
const logIt = (tag, data) => {
  try { send({ type: 'LOG', tag, data: data || {} }).catch(() => {}); } catch (_) {}
};

// The sheet has two levels: the menu, and one screen per entry. Escape steps back
// through them in the order you arrived — screen to menu, menu to closed — rather
// than dumping you out of the sheet from wherever you are.

function toggleDrawer(force) {
  const d = $('drawer');
  const open = force ?? !d.classList.contains('open');
  d.classList.toggle('open', open);
  d.setAttribute('aria-hidden', String(!open));
  $('menu').classList.toggle('open', open);
  $('menu').setAttribute('aria-expanded', String(open));
  if (open) paintMenu(); else goScreen(null);
}

function goScreen(id) {
  S.atScreen = id;
  $('menuList').classList.toggle('off', !!id);
  document.querySelectorAll('.screen').forEach((s) => {
    const on = s.id === id;
    s.classList.toggle('on', on);
    s.hidden = !on;
    if (on) s.scrollTop = 0;
  });
  if (id) document.querySelector(`#${id} .sback`)?.focus();
  // Repainted on entry rather than kept warm, because everything on it is a live fact about a
  // socket and a set of grants — and a trust screen showing what WAS true is worse than one
  // showing nothing at all. Settings now carries three of these switches too (moved there
  // per request), so it needs the same repaint on entry, not just the AI agents screen.
  if (id === 'scBridge' || id === 'scSettings') paintBridge();
}

// Each row states its own current value, so the list answers the common
// questions — how many pages, how thorough, anything queued — unopened.
function paintMenu() {
  const n = S.lastHistoryCount;
  $('mvHist').textContent = n ? `${n} page${n === 1 ? '' : 's'}` : 'none yet';
}

// --- connecting an agent -------------------------------------------------------------------------
// WHAT EACH AGENT WANTS, which is five different things and not one thing said five ways. One takes
// a shell command; the rest take JSON, in three different files — and VS Code spells the key
// `servers` where everyone else says `mcpServers`. Getting that wrong throws no error at all: the
// tool simply never appears, which is the worst thing to debug from a side panel. So each is
// written out in full rather than left as "same as the one above".
const MCP_CLIENTS = {
  'claude-code': {
    where: 'in a terminal',
    // `--scope user` is the part that matters. Left at the CLI's own default (`local`), this
    // registers HoloScrape for whichever PROJECT happens to be open in the terminal the command
    // was run from — invisible in every other project, including the very next one the person
    // opens. Measured cost of getting this wrong: two full Claude Code restarts before the
    // mismatch between "where I ran the command" and "where the session actually was" was found.
    text: 'claude mcp add holoscrape --scope user -- npx -y holoscrape-mcp',
    after: 'Then restart Claude Code so it picks the server up — available in every project '
      + 'from here on, not just this one.',
  },
  'claude-desktop': {
    where: 'claude_desktop_config.json — Settings › Developer › Edit Config',
    text: '{\n  "mcpServers": {\n    "holoscrape": {\n      "command": "npx",\n'
      + '      "args": ["-y", "holoscrape-mcp"]\n    }\n  }\n}',
    after: 'Quit and reopen Claude Desktop afterwards.',
  },
  cursor: {
    where: '~/.cursor/mcp.json  (or .cursor/mcp.json for one project)',
    text: '{\n  "mcpServers": {\n    "holoscrape": {\n      "command": "npx",\n'
      + '      "args": ["-y", "holoscrape-mcp"]\n    }\n  }\n}',
    after: 'Cursor picks it up without a restart.',
  },
  windsurf: {
    where: '~/.codeium/windsurf/mcp_config.json',
    text: '{\n  "mcpServers": {\n    "holoscrape": {\n      "command": "npx",\n'
      + '      "args": ["-y", "holoscrape-mcp"]\n    }\n  }\n}',
    after: 'Reload the MCP servers from Windsurf\u2019s settings.',
  },
  vscode: {
    where: '.vscode/mcp.json',
    text: '{\n  "servers": {\n    "holoscrape": {\n      "command": "npx",\n'
      + '      "args": ["-y", "holoscrape-mcp"]\n    }\n  }\n}',
    after: 'Note the key is "servers" here, not "mcpServers".',
  },
};

// Remembered, because someone who uses Cursor uses Cursor every time, and re-picking your own
// editor on every visit is the panel forgetting what it was told.
function showClient(id) {
  const c = MCP_CLIENTS[id] || MCP_CLIENTS['claude-code'];
  if ($('brCmd')) $('brCmd').textContent = c.text;
  if ($('brWhere')) $('brWhere').textContent = c.where;
  if ($('brAfter')) $('brAfter').textContent = c.after || '';
  document.querySelectorAll('#brSeg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.client === id);
  });
  try { localStorage.setItem('mcpClient', id); } catch (_) {}
}

// One handler for every Copy in the screen, found by `data-copy`. `writeText` can be refused, and
// a button that says "Copied" when nothing was copied sends someone to paste an empty clipboard
// into a config file — so the fallback selects the text and says to copy it by hand.
function wireCopies() {
  document.querySelectorAll('.bcopy[data-copy]').forEach((b) => {
    b.onclick = async () => {
      const src = $(b.dataset.copy);
      const text = src?.textContent?.trim() || '';
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = 'Copied';
      } catch (_) {
        b.textContent = 'Select';
        const r = document.createRange();
        r.selectNodeContents(src);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
      setTimeout(() => { b.textContent = 'Copy'; }, 1500);
    };
  });
}

// One definition of "an agent is live right now", asked fresh — never derived from `site` or
// from whether a pairing token merely EXISTS, both of which stay true long after the socket
// that made them true has dropped. Shared by `paintBridge` (which needs the fuller state
// object too) and `sync` (which only needs this one boolean, for `mcpHint`).
async function bridgeIsLive() {
  const b = await send({ type: 'BRIDGE_STATE' }).catch(() => null);
  return !!(b && !b.error && b.paired && b.enabled);
}

// THE SCREEN STATES WHAT IS TRUE NOW. Every question here is about trust, and a stale answer to a
// trust question is worse than none — "connected" that actually means "was, two minutes ago" is
// the state in which a person stops checking.
async function paintBridge() {
  const b = await send({ type: 'BRIDGE_STATE' }).catch(() => null);
  if (!b || b.error) return;
  S.bridgeLive = !!(b.paired && b.enabled);

  if ($('brOn')) $('brOn').checked = !!b.enabled;
  if ($('brAutoWindow')) $('brAutoWindow').checked = b.autoWindow !== false;
  if ($('brKeepOnClose')) $('brKeepOnClose').checked = !!b.keepOnClose;

  const live = S.bridgeLive;
  const st = $('brState');
  if (st) {
    // Four states that look alike from outside and need different next moves: nothing set up,
    // a code held but switched off, switched on with nothing answering, and connected.
    st.className = `bstat ${live ? 'on' : b.enabled ? 'warn' : ''}`;
    // NOT THE PORT ANYMORE. That lived here before the per-host list existed below; once every
    // connection has its own row with its own port, repeating one of them up here was noise, and
    // repeating all of them was the flat "127.0.0.1:27182 · 127.0.0.1:27183" string this replaces.
    st.querySelector('span').textContent = live ? `Connected · ${b.agents} agent${b.agents === 1 ? '' : 's'}`
      : b.off ? 'Turned off — no agent can connect'
      : !b.hasToken ? 'Not connected — follow the steps below'
      : !b.enabled ? 'Paired, but switched off'
      : 'Waiting for your agent to start';
  }
  const mv = $('mvBridge');
  if (mv) mv.textContent = live ? 'connected' : b.enabled ? 'waiting' : 'off';

  // Offered whenever pairing exists — a window has been asked for at every point past that, and this
  // is the one click guaranteed to bring it forward regardless of why it never got raised.
  if ($('brShow')) $('brShow').hidden = !b.hasToken;

  // ONE ROW PER AGENT — the connection window's own list, mirrored here (both read the same
  // `hosts` the window pushes on every state change, so they never disagree about who is connected).
  const hosts = $('brHosts');
  if (hosts) {
    const list = b.hosts || [];
    hosts.hidden = !list.length;
    hosts.textContent = '';
    for (const h of list) {
      const row = document.createElement('div');
      row.className = `bhost${h.released ? ' released' : ''}`;
      const who = document.createElement('span');
      who.className = 'bhwho';
      who.textContent = h.released ? `${h.client?.name || 'an agent'} — released` : (h.client?.name || 'an agent');
      const at = document.createElement('span');
      at.className = 'bhat';
      at.textContent = `127.0.0.1:${h.port}`;
      const btns = document.createElement('span');
      btns.className = 'bhbtns';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = h.released ? 'Reconnect' : 'Release';
      btn.onclick = async () => {
        await send({ type: h.released ? 'BRIDGE_RECONNECT_HOST' : 'BRIDGE_RELEASE_HOST', port: h.port }).catch(() => {});
        paintBridge();
      };
      btns.append(btn);
      // Only offered live — killing sends a message down this session's own socket, and a released
      // row has none until it reconnects.
      if (!h.released) {
        const kill = document.createElement('button');
        kill.type = 'button';
        kill.className = 'kill';
        kill.title = 'Ends the agent’s process entirely and frees its port for a fresh session — cannot be undone.';
        kill.textContent = 'End session';
        kill.onclick = async () => {
          await send({ type: 'BRIDGE_KILL_HOST', port: h.port }).catch(() => {});
          paintBridge();
        };
        btns.append(kill);
      }
      row.append(who, at, btns);
      hosts.append(row);
    }
  }

  // EACH TICK IS EARNED BY STATE, NEVER BY HAVING BEEN CLICKED. Node and the agent config are both
  // proven by one fact and neither is checkable from here: a server that connected had to have
  // been installed, configured and started. A tick meaning "I pressed copy" would claim a step is
  // done at exactly the moment it is most likely not to be.
  const step = (id, done) => $(id)?.classList.toggle('done', !!done);
  step('brStep1', !!b.paired);
  step('brStep2', !!b.paired);
  step('brStep3', !!b.hasToken);
  // A paired connection could not exist without the window having been opened at least once.
  step('brStep4', !!b.paired);
  // The companion cannot be seen from here (its Chromium lives beside the server), so step 5
  // never ticks; it is marked optional for that reason.

  if ($('brPinned')) {
    $('brPinned').textContent = b.pinned
      ? `Pinned: ${(b.pinned.title || b.pinned.url || '').slice(0, 60)}`
      : 'No page pinned — agents use whichever tab is in front.';
  }

}

function wireBridge() {
  wireCopies();

  const seg = $('brSeg');
  if (seg) {
    seg.onclick = (e) => {
      const b = e.target.closest('button[data-client]');
      if (b) showClient(b.dataset.client);
    };
    let held = 'claude-code';
    try { held = localStorage.getItem('mcpClient') || held; } catch (_) {}
    showClient(MCP_CLIENTS[held] ? held : 'claude-code');
  }

  // The official download page rather than an in-panel walkthrough: installers differ per platform
  // and go out of date, and nodejs.org will not.
  if ($('brNode')) $('brNode').onclick = () => chrome.tabs.create({ url: 'https://nodejs.org/en/download' });

  if ($('brOn')) {
    $('brOn').onchange = async () => {
      await send({ type: 'BRIDGE_ENABLE', on: $('brOn').checked }).catch(() => {});
      paintBridge();
    };
  }
  if ($('brAutoWindow')) {
    $('brAutoWindow').onchange = async () => {
      await send({ type: 'BRIDGE_SET_AUTOWINDOW', on: $('brAutoWindow').checked }).catch(() => {});
      paintBridge();
    };
  }
  if ($('brKeepOnClose')) {
    $('brKeepOnClose').onchange = async () => {
      await send({ type: 'BRIDGE_SET_KEEP_ON_CLOSE', on: $('brKeepOnClose').checked }).catch(() => {});
      paintBridge();
    };
  }
  // THIS CLICK IS THE ONE THING THAT CAN RAISE THE WINDOW. Chrome only lets `focused: true` bring a
  // window forward when the creation is tied to a real user gesture — a reload, a browser restart or
  // the unattended reconnect all open it without one, and it can end up sitting behind the main
  // window with no way back short of Mission Control. This button is a fresh gesture every time.
  if ($('brShow')) {
    $('brShow').onclick = async () => {
      await send({ type: 'BRIDGE_SHOW' }).catch(() => {});
      paintBridge();
    };
  }
  // Step 5's button — same message, same handler, just reachable from inside the wizard too.
  if ($('brStep5Show')) {
    $('brStep5Show').onclick = async () => {
      await send({ type: 'BRIDGE_SHOW' }).catch(() => {});
      paintBridge();
    };
  }

  if ($('brPair')) {
    const pair = async () => {
      const code = ($('brCode')?.value || '').trim();
      if (!code) return;
      const err = $('brPairErr');
      const r = await send({ type: 'BRIDGE_PAIR', token: code }).catch((e) => ({ error: e.message }));
      if (r?.error) {
        // The typed code is LEFT IN PLACE on failure: clearing it makes someone fetch the whole
        // thing again to change one character.
        if (err) { err.hidden = false; err.textContent = r.error; }
        return;
      }
      if (err) err.hidden = true;
      $('brCode').value = '';
      paintBridge();
    };
    $('brPair').onclick = pair;
    if ($('brCode')) $('brCode').onkeydown = (e) => { if (e.key === 'Enter') pair(); };
  }

  const thisTab = async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

  if ($('brPin')) {
    $('brPin').onclick = async () => {
      const t = await thisTab();
      if (!t) return;
      await send({ type: 'BRIDGE_PIN', tabId: t.id }).catch(() => {});
      paintBridge();
    };
  }
  if ($('brUnpin')) {
    $('brUnpin').onclick = async () => {
      await send({ type: 'BRIDGE_PIN', tabId: null }).catch(() => {});
      paintBridge();
    };
  }
}

export { contextAlive, showStale, send, logIt, toggleDrawer, goScreen, paintMenu, bridgeIsLive, paintBridge, wireBridge };
