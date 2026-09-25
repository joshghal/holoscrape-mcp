// Two builds from one tree. `npm run build` writes both.
//
// The only difference between them is env.js and the name in the manifest — the code is
// identical, which is the point: a staging build you can trust to behave like production
// except where it is deliberately louder. The staging name and icons differ so both can be
// installed side by side without one shadowing the other in the extensions list.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname);
export const FILES = ['manifest.json', 'background.js',
  // The service worker's own modules — one concern each; the map is at the top of background.js.
  'bg-state.js', 'bg-log.js', 'bg-windows.js', 'bg-files.js', 'bg-store.js', 'bg-awake.js', 'bg-rows.js',
  'bg-cdp.js', 'bg-net.js', 'bg-scan.js', 'bg-details.js', 'bg-sites.js', 'bg-harvest.js', 'bg-walk.js',
  'scan.js', 'rows.js', 'point.js',
  'frames.js', 'raf.js', 'pace.js', 'mail.js', 'tld.js', 'sites.js', 'place.js', 'twogis.js', 'providers.js', 'provider-gmaps.js', 'provider-2gis.js', 'provider-x.js', 'provider-shopee.js', 'provider-gmail.js', 'x-video-resolve.js',
  // The module form, for the offscreen document. Its classic-script twin, `harvest-inject.js`, is
  // GENERATED from this file below rather than checked in — see `injectable`.
  'harvest.js',
  'env.js',
  'offscreen.html', 'offscreen.js', 'sidepanel.html',
  'bridge-window.html', 'bridge-window.js',
  'sidepanel.js',
  // The side panel's modules. sidepanel.js is the entry (`type="module"` in sidepanel.html) and
  // imports every one of these; `test/build-files-complete.mjs` fails if one is dropped from here.
  'panel-state.js', 'panel-util.js', 'panel-shell.js', 'panel-sheet.js', 'panel-card.js',
  'panel-readout.js', 'panel-history.js', 'panel-queries.js', 'panel-dial.js',
  'panel-live.js', 'panel-results.js', 'panel-scan.js',
  'table.html', 'table.js', 'paper.js',
  // The MCP bridge. `mcp/` is deliberately NOT here — that half is a Node process published to
  // npm, and shipping it inside the CRX would only put a file in the package that Chrome can
  // never run.
  'bridge.js', 'bridge-ops.js',
  // The values the bridge side agrees on — loopback host, port range, the token protocol, the
  // storage keys — named once and imported by bridge.js, bridge-ops.js and bridge-window.js,
  // instead of the same literal typed in three files.
  'tuning.js',
  // What state a page was in when it was read, and the one settle rule. Imported by background.js;
  // `test/build-files-complete.mjs` fails the build if it is ever dropped from this list.
  'settle.js'];

const ENVS = {
  prod: { dev: false, suffix: '' },
  stg: { dev: true, suffix: ' (staging)' },
};

// `npm run build:stg -- --unblock` empties the blocked-host list for one build, so the
// engine can be pointed at a page it normally refuses while it is being worked on.
//
// Three properties make this safe to have at all: prod REFUSES the flag rather than
// ignoring it, the value is written into a GENERATED env.js, and every later build
// regenerates that file — so the lift lapses on the next `npm run build` whether or not
// anyone remembers it. Nothing about it is a setting a user can reach.
const UNBLOCK = process.argv.includes('--unblock');

// The one place env.js is written. Exported because the test harness builds its own copy
// of the extension and used to hand-write this file — so adding an export here made the
// worker fail to link, which surfaces as the launch HANGING rather than as an error.
// Anything that needs an env.js calls this, and a new flag reaches every build at once.
// THE PORT IS BUILT IN, so a test build can never fight the browser a person is using.
//
// The extension dials a FIXED range because it has no way to be told where the server is. That was
// fine until the test suite started spawning its own servers on that same range: every regression
// run had to free the ports first, which meant killing the server the live extension was paired
// with. Measured cost: the person's connection dropped on every suite run, repeatedly, and each
// time it looked like a fault in the product rather than in the harness.
//
// A test build now gets its own range and the two never meet.
// One module's source, turned into a classic script that hangs its functions on `globalThis`.
// Exported so the test suite can build the same thing the build does, rather than paraphrasing it.
export function injectable(src) {
  // GUARDED AGAINST ITS OWN RE-INJECTION. `harvestRead` (background.js) injects this file with
  // no check for whether it is already there, and a second `files:` injection into the SAME
  // frame's isolated world runs alongside the first's leftover globals, not in a fresh one —
  // top-level `const`/`function` bindings from the first run are still live. Reported live:
  // "Identifier 'TIERS' has already been declared", from a second harvest call landing on a
  // page the first had already touched. Wrapping the whole body behind a check on the sentinel
  // this file itself sets at the end makes a repeat injection a no-op instead of a crash — the
  // first run's `__hsHarvest` is exactly as valid the second time, so skipping is correct, not
  // just quiet.
  return `${'// GENERATED from harvest.js by build.mjs — do not edit.\n'}if (!globalThis.__hsHarvest) {\n${
    src.replace(/^export\s+(const|function)\s/gm, '$1 ')
  }\nglobalThis.__hsHarvest = { readHarvest, fromLd, ldjson };\n}\n`;
}

// rows.js IS ASSEMBLED FROM PARTS, INSIDE ONE FUNCTION — the harvest.js/harvest-inject.js idiom,
// inverted: there the checked-in file is the source and the generated twin is written into dist;
// here the parts are the source and the generated file is checked in at the root.
//
// WHY IT CANNOT BE ES MODULES. `background.js` runs the engine with
// `chrome.scripting.executeScript({ func: pageRows, args: [op] })`, and that call SERIALISES THE
// FUNCTION'S OWN SOURCE TEXT into the page. Nothing outside the function exists there — a helper
// in another module is a ReferenceError on the first call, inside somebody's tab, with no test
// between the split and the person. So the twelve thousand lines have to stay one function body,
// and the only split that is safe is a split of the SOURCE: `rows-*.js` are function-body
// fragments, concatenated IN THIS ORDER between `export async function pageRows(op = {}) {` and
// its closing brace.
//
// THE ORDER IS SEMANTICS. Inside a function body a `const` arrow helper is not hoisted, so a part
// that reads a name defined in a later part would throw at that line. This list, not directory
// order, decides the concatenation — never `readdirSync`.
//
// THE PARTS ARE NOT MODULES AND MUST NOT BE ADDED TO `FILES`. They do not ship; rows.js does.
// eslint ignores `rows-*.js` and lints the assembled rows.js, because a part on its own refers to
// names that live in its siblings (and the dispatch part carries `return`s that do not parse
// outside a function). `test/rows-assembled.mjs` asserts the checked-in rows.js is byte-for-byte
// this assembly, so a hand edit to rows.js goes red on the next run rather than being overwritten
// by the next build.
export const ROWS_PARTS = [
  'rows-0-tuning.js',       // every number that is a decision — timeouts, thresholds, caps, ratios — named, with its reason
  'rows-a-state.js',        // the engine's opening explanation, the hop store, whose state this is, stopping, true-hidden
  'rows-b-detect.js',       // row identification, candidate scoring, masonry, detect()
  'rows-c-cells.js',        // highlight, cell extraction, naming the columns, extractOne/extractAll
  'rows-d-pager.js',        // selector, page hop, the pager, challenge-or-empty, pictures, the frame, whose fetch, pageHop
  'rows-e-details.js',      // opening each row: providers, the panel, web results, the driven pass, openEach
  'rows-f-grow.js',         // scrolling, settle, in-flight requests, load-more, scrollStep, summary, priming, ensure
  'rows-g-listmark.js',     // the list's fingerprint (listRoot/listMark), under the original "dispatch" header
  'rows-h-state-layer.js',  // the layer under the DOM: state reads, webpack registries, framework roots, discovery, joins
  'rows-i-read.js',         // read exactly what was pointed at: readOne, html, walk, choose, collect, map, read
  'rows-j-explore.js',      // explore the whole page, @dom, fill, @await, @fetch, stateReadPath
  'rows-k-main.js',         // the `switch (op.action)` dispatch — every action, to the closing brace of the switch
];
export const ROWS_FILE = 'rows.js';
const ROWS_OPEN = 'export async function pageRows(op = {}) {';
// One marker per part, so a stack trace's line can be traced back to the part that holds it, and
// so the drift test can strip them to prove the body is the parts and nothing else.
export const rowsMarker = (part) => `  // ==== ${part} ====`;

export function assembleRows(read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')) {
  let out = `// GENERATED by build.mjs from the rows-*.js parts — do not edit this file.\n`
    + `//\n`
    + `// Edit the part, then \`npm run assemble\` (or \`node build.mjs rows\`); every \`npm run build\`\n`
    + `// re-assembles it too. test/rows-assembled.mjs fails when this file and the parts disagree.\n`
    + `// The parts are function-body fragments concatenated IN THIS ORDER inside one function,\n`
    + `// because executeScript({ func: pageRows }) serialises the function's own source into the\n`
    + `// page and nothing outside it exists there. See ROWS_PARTS in build.mjs for why.\n`
    + `//\n`;
  for (const p of ROWS_PARTS) out += `//   ${p}\n`;
  out += `\n${ROWS_OPEN}\n`;
  for (const p of ROWS_PARTS) {
    let body = read(p);
    // Every part ends in a newline, so the next marker starts a line of its own and a missing
    // trailing newline in an editor does not glue two parts together. Nothing else is normalised:
    // the blank line a part keeps before the next section header is the original file's, byte
    // for byte, and the drift test depends on that.
    if (!body.endsWith('\n')) body += '\n';
    out += `${rowsMarker(p)}\n${body}`;
  }
  return `${out}}\n`;
}

// Written only when it would change: a build must not touch the mtime of a file it did not alter.
export function writeRows() {
  const text = assembleRows();
  const at = path.join(ROOT, ROWS_FILE);
  const had = fs.existsSync(at) ? fs.readFileSync(at, 'utf8') : null;
  if (had !== text) fs.writeFileSync(at, text);
  return had !== text;
}

export function envFile(name, { unblock = false, dev = ENVS[name]?.dev ?? false, portBase = 27182 } = {}) {
  return `// Generated by build.mjs — do not edit.\n`
    + `export const ENV = '${name}';\n`
    + `export const DEV = ${dev};\n`
    + `export const UNBLOCK = ${unblock};\n`
    + `export const PORT_BASE = ${portBase};\n`;
}

function build(name) {
  const cfg = ENVS[name];
  if (UNBLOCK && !cfg.dev) {
    console.error('refusing: --unblock is a development flag and cannot be built into prod.');
    process.exit(1);
  }
  const unblock = UNBLOCK && cfg.dev;
  const out = path.join(ROOT, 'dist', name);
  // BUILT BESIDE, THEN SWAPPED — because the obvious version breaks a loaded extension.
  //
  // This used to `rmSync(out)` and then copy fifteen files into the empty directory, which
  // leaves `dist/<name>` deleted or half-populated for a couple of hundred milliseconds on
  // every single build. An MV3 service worker is evicted and respawned constantly, and it
  // re-reads `background.js` FROM DISK when it respawns. Land inside that window — Chrome
  // respawning the worker, or the user clicking the icon — and it finds no worker file, or
  // half of one. The extension is then dead until somebody reloads it by hand, and the way
  // that presents is "clicking the icon does nothing", with the code and the manifest both
  // perfectly fine. It cost two debugging sessions before the build was suspected.
  //
  // So the new build is assembled in a sibling directory and moved into place with renames.
  // `dist/<name>` goes from complete-old to complete-new; it is never partial. There is still
  // an instant with nothing at that path — Node has no atomic directory swap — but it is one
  // rename rather than the whole copy, and a missing directory makes Chrome complain loudly
  // instead of silently loading half a build.
  const tmp = `${out}.tmp`;
  const old = `${out}.old`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(old, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  // rows.js is re-assembled from its parts BEFORE the copy, so the file that ships is the parts as
  // they stand and not whatever the last assemble left behind. See ROWS_PARTS.
  writeRows();
  for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  fs.cpSync(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true });

  // env.js is GENERATED, never copied as-is: the checked-in one says prod so that a tree
  // loaded unpacked is safe, and this is the only place that can say otherwise.
  fs.writeFileSync(path.join(tmp, 'env.js'), envFile(name, { unblock }));

  // harvest-inject.js is GENERATED FROM harvest.js, for the same reason env.js is generated: so
  // there is exactly one source and it cannot drift.
  //
  // The extractor has to run in two places that disagree about module syntax — as an ES module in
  // the offscreen document and in tests, and as a CLASSIC script injected into a tab, where an
  // `export` keyword is a syntax error. Writing it twice would mean two implementations of the one
  // function whose entire promise is that the fetch path and the tab path read identically, and the
  // fetch path is the one nobody watches. So the bodies are copied verbatim, the export keywords are
  // dropped, and the result is hung on `globalThis`.
  fs.writeFileSync(path.join(tmp, 'harvest-inject.js'), injectable(
    fs.readFileSync(path.join(ROOT, 'harvest.js'), 'utf8'),
  ));

  const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  mf.name = `${mf.name}${cfg.suffix}`;
  fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(mf, null, 2) + '\n');

  // Read back rather than trusted: the guarantee that matters is about the file on disk,
  // and asserting the variable we just wrote would only prove we can concatenate strings.
  const wrote = fs.readFileSync(path.join(tmp, 'env.js'), 'utf8');
  if (!cfg.dev && !/UNBLOCK = false/.test(wrote)) throw new Error('prod build has UNBLOCK set');

  // EVERY FILE PRESENT BEFORE THE SWAP. A build that is missing a file is a broken extension
  // in exactly the way described above, and checking here means a bad build never replaces a
  // good one — the old `dist/<name>` is still standing when this throws.
  const want = [...FILES, 'public'];
  const missing = want.filter((f) => !fs.existsSync(path.join(tmp, f)));
  if (missing.length) throw new Error(`build incomplete, refusing to swap: ${missing.join(', ')}`);

  const n = fs.readdirSync(tmp).length;
  // The swap. `renameSync` over an existing directory fails on POSIX, so the old one is moved
  // aside first and deleted afterwards, when nothing is reading it any more.
  if (fs.existsSync(out)) fs.renameSync(out, old);
  fs.renameSync(tmp, out);
  fs.rmSync(old, { recursive: true, force: true });
  console.log(`${name.padEnd(5)} → dist/${name}  (${n} entries, DEV=${cfg.dev})`
    + (unblock ? '  ⚠ BLOCKED HOSTS LIFTED — development only, lapses on the next build' : ''));
}

// Only when run as a command. Importing this for envFile() must not write a build.
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'build.mjs')) {
  const args = process.argv.slice(2);
  // `node build.mjs rows` assembles rows.js from its parts and builds nothing — the step to run
  // after editing a part, without swapping a dist/ somebody has loaded. Named envs still build.
  const rowsOnly = args.includes('rows');
  if (rowsOnly) console.log(writeRows() ? 'rows.js assembled from parts (changed)' : 'rows.js already matches its parts');
  const want = args.filter((a) => ENVS[a]);
  if (want.length || !rowsOnly) for (const n of (want.length ? want : Object.keys(ENVS))) build(n);
}
