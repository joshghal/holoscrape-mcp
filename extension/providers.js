// THE REGISTRY. One import for the worker, one payload for the engine, one place to add a map.
//
// Before this, a provider's facts lived in seven registries across three files — `MAPS`,
// `MAPPINGS`, `FETCH_READ`, `RECORD_HREF` in the engine, `CLICK_PAGER` in the worker, `STEP_COUNT`
// and `PAGED` in the panel. Each was added the moment something broke, so nothing ever held the
// whole answer and adding a second map meant finding them one at a time by getting them wrong.
//
// THE BOUNDARY IS WHY THIS FILE HAS TWO SHAPES.
//
// `rows.js` is handed to `chrome.scripting.executeScript` as a FUNCTION and serialised to source,
// so it cannot import anything — that is also why the engines carry deliberate duplicates of some
// helpers. What it CAN receive is `args`, which must be JSON-serialisable. So:
//
//   DESCRIPTORS   plain data — patterns as strings, traits as scalars. Travels into the page.
//                 Same door `tld.js` uses to hand the TLD list to the mail reader.
//   readerFor()   real modules, imported normally, used only in the worker.
//
// A RegExp cannot make that trip: it arrives as `{}` and matches nothing, silently. Hence strings,
// compiled on arrival by `compileProviders` below.
import { descriptor as gmaps } from './provider-gmaps.js';
import { descriptor as twogis } from './provider-2gis.js';
import { descriptor as x } from './provider-x.js';
import { descriptor as shopee } from './provider-shopee.js';
import { descriptor as gmail } from './provider-gmail.js';

// Bing is deliberately recognised and deliberately unread. Its own things are named its own way,
// and a reader built by loosening Google's selectors until they match both is specific to neither
// and fails silently as empty columns. `reads: null` means "refuse with NO_MAPPING and say so"
// rather than click through 122 records for nothing.
const bing = {
  id: 'bing',
  host: '(^|\\.)bing\\.com$',
  path: '^/maps(/|$)',
  reads: null,
  steps: 3,
};

// AMAZON SEARCH, PINNED — because it has been measured and a measurement should not be re-guessed.
//
// `/s?k=…` is the one page where the generic score genuinely cannot decide. Measured twice on the
// same URL with opposite winners: `#s-refinements` (242x8278, 55 thin filter rows) against
// `.s-main-slot` (1002x6473, 16 product cards), 1.22e9 vs 1.18e9 — a three-percent margin settled
// by how tall the sidebar happened to render that load. `identSpread` now costs the sidebar its
// collapse, and the chooser lets a person override anything; neither is a reason to keep guessing
// at a site we have already read.
//
// THE TWO FIELDS THAT ARE KNOWLEDGE, and one that is new:
//
//   list        which container is the list. A heuristic ranks; this states.
//   recordHref  what a record's URL looks like. Without it `rowIdentity` takes the longest
//               origin+pathname in the row, which on a refinement row is `/s` for every one of
//               them — 54 rows keying alike, deduped to 1, and a walk that stops after one page
//               because "the page brought no new identities". That is the reported symptom.
//   grows       `pager`, because Amazon search paginates by ordinary links (`ref=sr_pg_2`) and has
//               no load-more at all. `findLoadMore` refuses any provider whose `grows` is not
//               `press`, which also stops it pressing the sidebar's "See more, Camera Feature"
//               facet expanders — a real <a>, 76x24, that grows a filter group and never the list.
//               NOT `pager-click`: that is 2GIS's sliding window, walked by clicking. Amazon's
//               next page is a real href, so the ordinary next-link path is the correct one.
//
// The marketplaces share one codebase and one markup, so the host pattern is the TLD list rather
// than one entry per country.
const amazon = {
  id: 'amazon',
  host: '(^|\\.)amazon\\.(com|ca|com\\.mx|com\\.br|co\\.uk|de|fr|it|es|nl|se|pl|com\\.be|com\\.tr|co\\.jp|in|sg|ae|sa|eg|com\\.au)$',
  path: '^/s(/|$)',
  list: '.s-main-slot',
  recordHref: '/dp/[A-Z0-9]{10}',
  grows: 'pager',
};

// WHATSAPP WEB, AND IT IS IN THIS TABLE FOR ONE FIELD. Measured on the live chat list: a
// selector-pinned run returned **67 rows** — the mounted virtualization window, not the list —
// and a phone number for UNSAVED contacts only, because the chat-list DOM does not carry a number
// for a saved contact at all. The app has a name for that person, so it renders the name. Both
// answers are one layer down, in the app's own Store, which is why `state` is the only knowledge
// this entry holds.
//
// AND WHY THE STORE IS THE RIGHT LAYER RATHER THAN THE NETWORK: WhatsApp transports over an
// ENCRYPTED WebSocket (Signal protocol). There is no readable JSON response to capture — the
// plaintext exists only after the app has decrypted it, i.e. in the app's own memory. `page_state`
// is the layer that reaches it; `page_network` never could.
//
// DELIBERATELY NOT SETTING `grows`, `reads`, `recordHref` OR `list`. Every one of those changes
// what the row engine DOES on this host, and none of them has been measured here — `reads` in
// particular gates the record pass, and a Google-shaped reader pointed at a chat app would click
// its way down someone's conversations filling nothing. Recognising a host is not the same as
// having a mapping for it; see `bing`, which is in this table precisely to be refused.
const whatsapp = {
  id: 'whatsapp',
  host: '(^|\\.)web\\.whatsapp\\.com$',
  path: '^/',
  // The mechanism that reads this is generic and lives in `rows.js` (`stateDiscover`,
  // `stateModules`): find a webpack chunk global, get the app's own `__webpack_require__` from it,
  // and read the module CACHE. What is app-specific — and therefore what is here — is the chunk
  // global's name, which export keys are worth surfacing first out of a registry of thousands,
  // and which zero-argument accessor those collections expose.
  state: {
    webpack: {
      chunk: 'webpackChunkwhatsapp_web_client',
      want: ['ContactCollection', 'ChatCollection', 'MsgCollection', 'GroupMetadataCollection',
        'ProfilePicThumbCollection'],
      accessors: ['getModelsArray'],
    },
    // MEASURED: the webpack chunk global exists here and its registry holds ZERO modules, because
    // this app registers through Meta's Haste loader (`__d` / `require`) instead. These are the
    // module ids to ask `require()` for — a fixed, reviewed list, never a sweep, because `require`
    // can instantiate a module that has not run yet and only stores the UI is already rendering
    // from belong in it. `ContactCollection` is the one that carries a saved contact's number,
    // which the chat-list DOM never does.
    haste: {
      want: ['WAWebContactCollection', 'WAWebChatCollection', 'WAWebGroupMetadataCollection',
        'WAWebProfilePicThumbCollection', 'WAWebMsgCollection',
        // LID -> PHONE NUMBER. Measured: a 1:1 chat's id is now a `@lid` privacy identifier and the
        // contact record beside it exposes no number at all, so a saved contact's number is simply
        // absent from the collections above. If this app keeps a mapping anywhere, it is in one of
        // these; each is a candidate to be confirmed or ruled out by reading it.
        'WAWebLidPnCache', 'WAWebLidPnMappingStore', 'WAWebAltDeviceIdentityUtils',
        'WAWebUserPrefsLid', 'WAWebLidMigrationUtils', 'WAWebPnLidUtils'],
      accessors: ['getModelsArray'],
    },
  },
};

export const DESCRIPTORS = [gmaps, twogis, bing, amazon, whatsapp, x, shopee, gmail];

// What the engine builds on arrival. Kept here rather than in `rows.js` so the shape is defined
// once, beside the data it compiles.
export function compileProviders(list) {
  const out = {};
  for (const d of (list || [])) {
    out[d.id] = {
      ...d,
      hostRe: new RegExp(d.host, 'i'),
      pathRe: new RegExp(d.path),
      recordRe: d.recordHref ? new RegExp(d.recordHref) : null,
      // A CSS selector, not a pattern — it is used with `querySelector`, so it makes the trip
      // into the page as-is and needs no compiling. Named `list` in the descriptor because that
      // is what it is; carried as `list` throughout.
      list: d.list || '',
    };
  }
  return out;
}

// The traits every consumer asks for. Defaults are what a site that is not a map has always been:
// three steps, no pager, no reader.
export function traitsOf(map, table) {
  const v = (table || {})[map] || {};
  return {
    map: map || '',
    reader: !!v.reads,
    grows: v.grows || '',
    reads: v.reads || '',
    // What a record link looks like — the walk keys rows by it. See `rowIdentity`.
    recordHref: v.recordHref || '',
    // Which container is the list, where a descriptor says so outright. See `detect`.
    list: v.list || '',
    // A click-through pager the descriptor NAMES, and where its page number can be read. Both
    // exist for a list whose address never changes — see `provider-gmail.js`.
    next: v.next || '',
    pageLabel: v.pageLabel || '',
    steps: v.steps || 3,
  };
}
