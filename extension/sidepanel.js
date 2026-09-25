// THE SIDE PANEL'S ENTRY. sidepanel.html loads this one file as a module; it imports the panel's
// modules, exposes the names the test suite reaches by bare identifier, and starts the panel up
// in the order the monolith did. It decides nothing itself — the flow is in panel-scan.js.
//
//   panel-state.js    shared mutable state (`S`, the live-bound `tab`/`liveTimer`/`liveTab`), SCAN config
//   panel-util.js     pure helpers: `$`, `esc`, URL and time formatting
//   panel-shell.js    `send` and stale-context detection, the drawer, the AI-agents screen
//   panel-sheet.js    the live sheet's instruments: gauge, ledger, chain traits, closeLive, stopScan
//   panel-card.js     the half-card (`ask`)
//   panel-readout.js  the count, caption, chips, coverage and untested-site banner (`show`)
//   panel-history.js  the history screen
//   panel-queries.js  small asks of the worker: detail-pass state, site links, detection, open result
//   panel-dial.js     learning the page dial from pasted addresses
//   panel-live.js     `liveGrow`, the sheet's ticker
//   panel-results.js  `openResults` and the end-of-run `runSummary` card
//   panel-scan.js     the scan flow itself: init, watch, sync, run, pointing, the passes, afterScan
import { S, tab, setTab } from './panel-state.js';
import { showStale, goScreen, paintBridge, wireBridge } from './panel-shell.js';
import { gauge, head, closeLive } from './panel-sheet.js';
import { show } from './panel-readout.js';
import { wireHistory } from './panel-history.js';
import { liveGrow } from './panel-live.js';
import { runSummary } from './panel-results.js';
import { init, afterScan } from './panel-scan.js';

// THE PANEL'S TEST-FACING SURFACE. As a classic script every top-level name here was a window
// global, and the suite reaches these by BARE NAME from `page.evaluate(() => …)` closures —
// test/mcp-hint.mjs, test/extension.mjs, test/autofollow-toggle.mjs, test/bridge-off.mjs,
// test/bridge-host-kill.mjs, test/bridge-host-release.mjs. A module hides its names, so they are
// put back explicitly. A name removed from here goes red in those tests.
//
// Five of them are STATE the tests assign (`tab = {…}`, `site = {…}`, `bridgeLive = false`,
// `chain = {…}`, `livePhase = 'stopping'`). A plain copy would be one-way — the test's write would
// land on window while the panel kept reading its own binding — so those are accessors whose
// setter writes into the module state.
Object.defineProperty(window, 'tab', { get: () => tab, set: (v) => { setTab(v); }, configurable: true });
for (const k of ['site', 'bridgeLive', 'chain', 'livePhase']) {
  Object.defineProperty(window, k, { get: () => S[k], set: (v) => { S[k] = v; }, configurable: true });
}
Object.assign(window, { show, goScreen, paintBridge, afterScan, showStale, runSummary, closeLive, liveGrow, head, gauge });

// The start-up sequence, in the monolith's order: `init()` first (its synchronous prefix wires the
// buttons; the rest resumes after this module has finished evaluating), then the history screen's
// Clear button, then the connection screen.
init();

wireHistory();

// WIRED LAST, AND THAT IS NOT A STYLE CHOICE. This call once sat at line 370, above `paintMenu`.
// `wireBridge` is a function declaration so it hoists — but it reads `MCP_CLIENTS`, a `const`
// declared down here, and reading a `const` before its line throws ReferenceError. That threw while
// the panel's top-level script was still running, so nothing after it ran and the panel painted as
// an empty box: no visible error, no controls, no clue which of three files did it.
// (`MCP_CLIENTS` now lives in panel-shell.js, which is evaluated before this module — but the
// order is kept: wiring last is still the rule for anything that reads state declared above.)
wireBridge();
