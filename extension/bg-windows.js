// HoloScrape — service worker: the results windows.

// --- results windows -------------------------------------------------------
// One popup per result set, reused and re-focused instead of duplicated, and
// never more than two on screen. They belong to the panel: close the panel and
// they go with it.
const MAX_RESULT_WINDOWS = 2;
// WINDOW IDS OUTLIVE THIS WORKER, AND A MAP IN MEMORY DOES NOT.
//
// This was `new Map()`, and that is why closing the side panel left result windows open. The chain:
// open a result window, let the worker idle for thirty seconds, Chrome evicts it, the Map goes with
// it — then the panel closes, the worker wakes for `onDisconnect`, and `closeAllResults` iterates an
// empty map and closes nothing. The code was correct and the state was gone.
//
// `storage.session` survives a worker restart and is cleared when the browser closes, which is
// exactly the lifetime of a window id: meaningless after a restart, essential before one.
const RESULT_WINDOWS = 'resultWindows';
async function resultWins() {
  try {
    const got = await chrome.storage.session.get(RESULT_WINDOWS);
    return new Map(got?.[RESULT_WINDOWS] || []);
  } catch (_) { return new Map(); }
}
async function saveResultWins(m) {
  try { await chrome.storage.session.set({ [RESULT_WINDOWS]: [...m] }); } catch (_) { /* closing */ }
}

chrome.windows.onRemoved.addListener(async (wid) => {
  const m = await resultWins();
  let hit = false;
  for (const [k, v] of m) if (v === wid) { m.delete(k); hit = true; }
  if (hit) await saveResultWins(m);
});

export async function closeAllResults() {
  const m = await resultWins();
  const ids = [...m.values()];
  await saveResultWins(new Map());
  for (const wid of ids) { try { await chrome.windows.remove(wid); } catch (_) {} }
}

export async function openResults(id) {
  const wins = await resultWins();
  const existing = wins.get(id);
  if (existing != null) {
    try {
      await chrome.windows.update(existing, { focused: true, drawAttention: true });
      return { windowId: existing, reused: true };
    } catch (_) {
      wins.delete(id);
      await saveResultWins(wins);
    }
  }
  // Make room: close the oldest rather than stacking a third window.
  while (wins.size >= MAX_RESULT_WINDOWS) {
    const [oldestId, oldestWid] = wins.entries().next().value;
    wins.delete(oldestId);
    try { await chrome.windows.remove(oldestWid); } catch (_) {}
  }

  let base = { left: 0, top: 0, width: 1440, height: 900 };
  try {
    const cur = await chrome.windows.getCurrent();
    base = { left: cur.left ?? 0, top: cur.top ?? 0, width: cur.width ?? 1440, height: cur.height ?? 900 };
  } catch (_) {}
  const width = Math.max(720, Math.min(1180, base.width - 80));
  const height = Math.max(520, Math.min(820, base.height - 60));
  const w = await chrome.windows.create({
    url: chrome.runtime.getURL(`table.html?id=${encodeURIComponent(id)}`),
    type: 'popup',
    focused: true,
    width,
    height,
    left: Math.round(base.left + (base.width - width) / 2),
    top: Math.round(base.top + 40),
  });
  wins.set(id, w.id);
  await saveResultWins(wins);
  return { windowId: w.id };
}
