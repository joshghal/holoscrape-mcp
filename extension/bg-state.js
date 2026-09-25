// HoloScrape — service worker: the in-memory state every pass shares.
//
// Split out of background.js as a pure reorganisation. These are the claims, registries and
// cool-downs that more than one pass reads or writes — which tabs a run owns, which tab is being
// walked, what a details pass is doing, where the person's scroll was, which hosts have put up a
// wall. One module, so every other module imports the SAME instance (an ES module is a singleton)
// and no two passes can hold their own idea of what is in flight.
// One catalogue of what we know about a site: what we refuse, what we expect to
// come back thin, and what has actually been verified. The blocked list used to
// be written out here AND in the panel — two copies of the same fact.
import { RESTRICTED } from './sites.js';

export function restrictedHost(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return RESTRICTED.find((d) => h === d || h.endsWith('.' + d)) || null;
  } catch { return null; }
}

// Lane tabs in flight, so they can be shut even if the run that owns them never returns.
export const laneTabs = new Map();    // list tab -> { tabs: [ids], targets: [cdp targets] }

// Tabs whose owner has gone. Checked inside the lane loop so it stops at the next record rather
// than navigating a tab that is already closed.
export const abandoned = new Set();

// Which container the last explicit run on this tab named, in the engine's own canonical form —
// so two selectors naming one container are one visit, and two containers are two. Set by
// `list.extract` in bridge-ops.js; read by `sessionFor` below.
export const pinnedFor = new Map(); // tabId -> canonical selector, absent for the ranking's pick

// Where the user had the page before a scan moved it. A deep scan hands the descent
// from the asset walk to the row pass without springing back in between, which means
// by the time the row pass runs, nobody on the page remembers home any more — it has
// to be carried across the two phases from out here.
export const scrollHome = new Map();
// WHOSE SCROLL POSITION IS "HOME" — pinned at the press, not sampled at the scan.
//
// `runScan` samples `window.scrollY` when it starts, which was the person's place right up until
// deep scan started ASKING a question first. The card can be on screen for seconds, the passive
// poll keeps running behind it, and a poll's own read scrolls the page — so by the time the scan
// began it sampled 724 where the person was at 300, and faithfully "restored" them to 724.
// Measured: with the card bypassed the restore passes, with it in place it fails.
//
// A tab in here has had its home pinned by the panel at the moment of the press, and `runScan`
// must not overwrite it. Cleared wherever `scrollHome` is.
export const scrollPinned = new Set();

// Tabs currently being walked by the row engine. Awaiting the phases in the panel is
// the fix; this is the guarantee. Two walkers on one page each seek to their own idea
// of where it should be, and the result is neither engine's — so the worker refuses
// rather than trusting every future caller to sequence itself correctly.
// A COUNT, NOT A SET — because it has two independent owners.
//
// This was a Set. `runRows` claimed it for a walk and released it in its `finally`; `driveDetails`
// claimed it for the whole details pass and released it in its own. Whichever finished FIRST
// released it for both.
//
// Measured, from a 124-record run: at 09:32:27 the panel's "Open results" ran an `extractAll` —
// itself a walk — 55 records into the details pass. Its `finally` deleted the claim and called
// `keepAwake(tabId, false)`. From the next record onward every log line reads `frames=off`, the
// passive poll stopped being refused and its saves reappear (files 351 → 1,051 while the pass was
// still running), and a later re-read replaced the finished 124-row table with 25 rows.
//
// Counted, so only the LAST owner out releases the page and disarms the keeper.
export const walking = {
  n: new Map(),
  add(tabId) { this.n.set(tabId, (this.n.get(tabId) || 0) + 1); },
  // True when this was the last owner, which is the only moment it is safe to put the page back.
  delete(tabId) {
    const left = (this.n.get(tabId) || 1) - 1;
    if (left > 0) { this.n.set(tabId, left); return false; }
    this.n.delete(tabId);
    return true;
  },
  has(tabId) { return (this.n.get(tabId) || 0) > 0; },
};
// WHEN A TAB LAST FINISHED A DETAILS PASS, and the embargo below is why it is remembered.
//
// A details pass leaves the tab showing a RECORD, not the list. The panel's passive poll fires 2.5
// seconds later, re-reads "the page", and finds whatever that record's panel contains — and
// `saveResult` REPLACES tables, so a poll's re-read overwrote a finished 120-row table with the
// contents of one place's review section. Reported as "returning the zoom to the original replaces
// the table": the zoom restore is not what did it, it is simply what happens at the same moment.
//
// For a short while after a pass, a re-read of the page cannot improve on what the pass just
// saved, so it is refused. The pass's own carriers (`pagerows`, `commit`, `dtables`) are never
// refused — they hand over what they gathered rather than reading the page fresh.
// WHAT A DETAILS PASS IS DOING, ASKABLE — because its outcome must not live inside one message.
//
// A pass over a full Maps list is minutes of work: 123 records measured at 4.8s each, 9m51s in
// total. The panel awaited that on a single `chrome.runtime.sendMessage` with a five-minute bound,
// so at 09:31:48 the bound fired on a pass that ran happily on to 09:36:39 — and the panel, having
// nothing else to go on, reported the timeout to the user as "Not enough room to open them." The
// run finished all 123 records with nobody listening.
//
// That is not a timeout to lengthen; a long job simply cannot depend on one round trip surviving.
// The pass publishes itself here instead, so a panel that lost its reply asks what happened rather
// than inventing an answer.
export const detailRun = new Map();   // tabId -> { running, at, total, opened, filled, result }
export const detailedAt = new Map();
export const DETAIL_EMBARGO_MS = 45000;

export const hopCancel = new Map();   // tabId -> when Stop was last pressed
// What a hop has done so far, for the panel to read while it runs. The fetch pass keeps
// its own count on the page, where the progress poll already looks — but the tab passes
// run HERE, and the panel had no way to see them at all: five windows would open and the
// sheet would sit at "0 rows added, 0 pages" the whole time.
export const hopProgress = new Map();   // tabId -> { pages, added, url, via }

// A site that has just asked for verification is not asked again a minute later. The hop
// is the loud part of this tool, and the fastest way to turn a soft "prove you are a
// person" into a hard block is to answer it by trying again. Kept per host, in memory:
// it should outlive the run and not the browser, because the ban it is avoiding does not
// last either. Read before any pass opens anything.
const WALL_COOLDOWN_MS = 15 * 60 * 1000;
const walls = new Map();   // host -> when it asked

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }

// IS THIS PAGE THE BUSINESS'S, OR SOMEBODY ELSE'S PAGE THAT IT LINKS TO?
//
// A Maps listing's "website" is frequently a link-in-bio, a chat deep link, a social profile or a
// marketplace storefront. Those are all real links and none of them is the business's site: every
// heading, menu item and email address on such a page belongs to the PLATFORM or to other people
// using it. Reading one and filing what it says under a business's name is how
// `linktr.ee/jwmmartofficial` produced two strangers' email addresses and Linktree's own navigation
// as that shop's "services" (see the refusal in `driveSites`).
//
// A HOST LIST AND NOT A HEURISTIC, because the difference is not visible in the content. Every host
// here was observed in the user's own export as a `Website` value; that is the bar for adding one.
// `megabajacimahi.com` is the case that must keep working — a host that belongs to the business —
// so nothing generic (a `.com`, a short domain, a site with few pages) may be used to decide this.
//
// Matched on the registrable host and its subdomains, so `web.facebook.com` and `m.me` are covered
// without matching a business that merely has "shop" in its name.
const SHARED_HOSTS = [
  // link-in-bio
  'linktr.ee', 'linktree.com', 'lnk.bio', 'beacons.ai', 'bio.link', 'campsite.bio', 'taplink.cc',
  'linkr.bio', 'solo.to', 'carrd.co', 'msha.ke',
  // chat deep links
  'wa.me', 'wa.link', 'api.whatsapp.com', 'whatsapp.com', 'chat.whatsapp.com', 'm.me',
  't.me', 'telegram.me', 'line.me', 'zalo.me',
  // social profiles
  'facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'tiktok.com', 'twitter.com', 'x.com',
  'linkedin.com', 'youtube.com', 'youtu.be', 'pinterest.com', 'threads.net', 'vk.com',
  // marketplaces and storefront hosts — the shop's PAGE, on someone else's site
  'tokopedia.com', 'shopee.co.id', 'shopee.com', 'bukalapak.com', 'lazada.co.id', 'blibli.com',
  'tokopedia.link', 'mercadolibre.com', 'mercadolivre.com.br', 'olx.co.id', 'etsy.com',
  'amazon.com', 'aliexpress.com', 'trendyol.com', 'hepsiburada.com',
  // generic map/review/aggregator pages
  'google.com', 'goo.gl', 'maps.app.goo.gl', 'business.site', 'sites.google.com',
  'yelp.com', 'tripadvisor.com', 'foursquare.com',
];
const SHARED_RE = new RegExp(
  `(^|\\.)(${SHARED_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|')})$`, 'i');
export function sharedHost(u) {
  const h = hostOf(u);
  return !!h && SHARED_RE.test(h);
}
export function walledUntil(url) {
  const at = walls.get(hostOf(url));
  if (!at) return 0;
  const left = at + WALL_COOLDOWN_MS - Date.now();
  if (left <= 0) { walls.delete(hostOf(url)); return 0; }
  return left;
}
export const noteWall = (url) => { const h = hostOf(url); if (h) walls.set(h, Date.now()); };
// Cleared when the PERSON deals with it. The cooling period exists to stop the tool
// answering a challenge by trying again — it must not also stop the user answering it
// properly. Without this the panel's own offer was a dead end: open the page, clear the
// slider, come back, and be told to wait a quarter of an hour.
export function forgetWall(url) { walls.delete(hostOf(url)); }
