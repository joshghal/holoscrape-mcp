// GOOGLE MAPS, as a provider — everything that is true of this map and of no other.
//
// Nothing here is imported by the injected engine. `rows.js` is serialised to source by
// `chrome.scripting.executeScript` and therefore cannot import anything at all, which is why the
// DESCRIPTOR below is plain serialisable data: patterns as strings, traits as scalars. It travels
// into the page through `args`, exactly as `tld.js` hands the TLD list to the mail reader.
//
// The READER is a different matter. It runs in the worker, so it is an ordinary module import.

// --- the descriptor: what the engine needs to recognise and walk this map -----------------------
export const descriptor = {
  id: 'gmaps',
  // Strings, not RegExp: `executeScript` args must be JSON-serialisable, so the engine compiles
  // these on arrival. A literal RegExp here would arrive as `{}` and match nothing — silently.
  host: '(^|\\.)google(\\.[a-z]{2,3})+$',
  path: '^/maps(/|$)',

  // WHICH LINKS IN A ROW ARE RECORDS. A safety rule, not a nicety: a Maps rail carries suggestion
  // cards ("Hotels", "Things to do") whose links are SEARCHES. Clicking one re-runs the query, the
  // rail being read is replaced, and the pass goes on opening records from whatever replaced it —
  // a search for restaurants came back holding hotels.
  recordHref: '/maps/place/',

  // HOW THE LIST GETS LONGER. Maps extends its rail in place as you scroll; there is no pager to
  // press and no page to turn.
  grows: 'scroll',

  // HOW A RECORD IS READ. The panel is client-rendered, so `/maps/preview/place` carries about
  // nine of the fifteen columns the panel does — the fetch is the cheap-but-partial path and the
  // tab pass exists to finish the job. Hence 'click', with the fetch as an optimisation inside it
  // rather than a replacement for it.
  reads: 'click',

  // TURNING A SENTENCE INTO A SEARCH. "scrape google maps for restaurants in cimahi" is how the
  // request actually arrives, and without this the agent has to know Maps' URL shape — which it
  // will guess, and guess differently each time. `{query}` is URL-encoded on substitution.
  //
  // Maps needs no separate place slot: the whole phrase goes in the query and Google resolves it.
  searchFor: 'https://www.google.com/maps/search/{query}',

  // THREE STEPS: the list, each record, then each business's own website — because Google does not
  // publish an email address anywhere in the record, so the third step goes and finds one.
  steps: 3,
};

// --- the reader: worker-side, an ordinary import ------------------------------------------------
export { placeUrl, parseBody, readPlace } from './place.js';
