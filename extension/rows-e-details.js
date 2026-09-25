  // --- opening each row -----------------------------------------------------------
  //
  // A list card is a summary. Everything a list page holds back — the full postal address,
  // the opening hours, whether the owner has claimed the listing — lives on the record's
  // own page, and the only way to get it is to open the record.
  //
  // NOTHING NAVIGATES AWAY AND NOTHING GOES BACK. Measured on Google Maps at 1440px: the
  // detail panel opens BESIDE the list, which keeps all its rows, so the next record is one
  // more click. Browser-back was tried and is actively worse — it worked three times and
  // then returned a list holding **zero** rows, ending the run at record 4 of 5.
  //
  // Below ~1280 CSS px the same click REPLACES the list instead (measured: survives at
  // 1280, gone from the DOM at 1180 and every width below). That is a layout threshold, not
  // a zoom setting — and it is why this reads as broken with a side panel open, since the
  // panel takes ~400px off the page's width. The engine reports `tooNarrow` and the worker
  // widens the layout, because only the worker can (`chrome.tabs.setZoom`).
  // A CEILING, AND IT IS WHAT A FAILURE COSTS. Arrival is measured at 319ms, so this is
  // eight times the headroom a working record needs — and the number that matters is not
  // what a good record costs but what a bad one does. The previous value was 10s and it was
  // being paid on EVERY record, which is 10-20 seconds each and a quarter of an hour for a
  // hundred. A cap set for the worst imaginable connection is a cap that hides a broken
  // mechanism behind a long wait.
  const DETAIL_WAIT_MS = 3000;
  const DETAIL_POLL_MS = 100;
  // And the real protection, because no cap alone is enough: if records stop arriving at
  // all, that is a broken mechanism rather than a slow one, and grinding through a hundred
  // of them at the cap is three hundred seconds spent proving it a hundred times. Three in
  // a row is enough to know. Worst case is now ~9s before the pass says so and stops.
  const DETAIL_MISSES = 3;
  const DETAIL_MIN_WIDTH = 1280;
  // WHAT TO AIM FOR, which is not the same as what is survivable.
  //
  // 1280 is the measured FLOOR: on one machine the rail survives a click at 1280 and is gone at
  // 1180. Sitting on a floor is a bad plan and a report proved it — the rail was destroyed on a
  // setup that satisfied the gate, so that machine's real floor is higher than 1280 and the pass
  // sailed through the check and broke the list.
  //
  // So the pass now BUYS ROOM instead of merely checking for it: it makes the page at least this
  // wide before it clicks anything, by widening the window if the screen allows and zooming out if
  // it does not. A quarter more than the floor is enough to absorb the difference between one
  // machine's layout and another's, and it is why the zoom now visibly runs on ordinary windows
  // rather than only on very narrow ones.
  const DETAIL_WANT_WIDTH = 1600;
  // A record's page keeps most of itself below the fold, and it MOUNTS AS YOU SCROLL — the
  // same lazy behaviour a list has, one level in. Measured on one place: the panel is 646px
  // of viewport over 1,394px of content, which grows to 5,171px once walked, and its text
  // goes from 408 characters to 3,127. The plus code is in that difference, which is why it
  // kept reading as a field Maps does not publish.
  //
  // A STEP THAT DOES NOT MOVE IS NOT THE END OF THE PAGE, and reading it as one is what kept
  // the web-results section empty. Measured on "Reliant Plumbing - Austin": the walk stopped
  // after 2 steps at 410px of a 4,550px panel — because at step 2 the scroller was still
  // 1,230px tall and `scrollTop` therefore could not move. It had not finished mounting. The
  // walk declared the page read, and the section that renders at the bottom was never drawn:
  // `frame first seen: never during the walk`.
  //
  // So the end of the page is three things at once — at the bottom, no taller than it was,
  // and unable to move — confirmed twice, so a panel caught mid-mount gets another try.
  // Bounded by the CLOCK rather than a step count: a step that mounts content is worth
  // taking and a step at a settled bottom is not.
  const PANEL_WALK_MS = 6000;
  const PANEL_DWELL = 220;
  const PANEL_SETTLE = 2;
  const PANEL_SLACK = 8;       // px — "at the bottom" allowing for fractional heights
  const atEnd = (sc) => sc.scrollTop + sc.clientHeight >= sc.scrollHeight - PANEL_SLACK;
  // The whole of what one record may cost, from the click to the read. The phase caps below
  // bound each wait on its own; this bounds their SUM, so no single record can run away with
  // the pass however they interact.
  const RECORD_MS = 12000;
  // Google's own plumbing, and the vendor links that are not the business's web presence.
  // Used both to decide the panel has stopped growing and to build the Web links column.
  const PANEL_OWN = /(^|\.)(google\.[a-z.]+|gstatic\.com|googleusercontent\.com|schema\.org|goo\.gl|ggpht\.com)$/i;
  // Faster than turning a page, because clicking down a list is a faster thing to do than
  // loading page after page — but still jittered, for the reason `pace()` gives. Lower than
  // it was: each record already costs real time in arriving and walking, so the gap between
  // them does not also have to carry the whole appearance of deliberation.
  const detailPace = () => DETAIL_PACE_BASE_MS + Math.floor(Math.random() * DETAIL_PACE_JITTER_MS);

  // WHICH MAP THIS IS — AND EVERYTHING BELOW IS ONE MAP'S MAPPING, NOT A GENERAL READER.
  //
  // Every hook in the detail reader is Google's: `data-item-id="oloc"`, the `!1s0x…:0x…` place
  // id, the `!3d/!4d` coordinate pair, the `/search?…&pcl=lp` results frame, `streetviewpixels`,
  // `[role="img"][aria-label="4.1 stars"]`. Not one of them transfers. Bing Maps names its own
  // things its own way, so it needs its OWN mapping — measured field by field the way
  // `MAPS-PANEL.md` measured this one — and NOT these selectors loosened until they match both.
  // A reader that tries to be generic across two providers ends up specific to neither, and the
  // failure is silent: empty columns and no fault reported.
  //
  // So the provider is named, the mapping is gated on the name, and an unknown map is REFUSED
  // rather than clicked 122 times for nothing. `bing` is listed as a recognised map with no
  // mapping behind it yet, which is why `MAPPINGS` is separate from `MAPS`.
  //
  // `2gis` is the second mapping, and it is a genuinely different KIND of reader rather than a
  // second set of selectors — which is the case this split was written for. Google's panel is
  // client-rendered and read by SHAPE over an untyped tree; 2GIS server-renders a TYPED JSON
  // record into the page, so `twogis.js` reads it by KEY. Neither reader could have been
  // widened into the other.
  //
  // One consequence worth knowing here: a 2GIS record carries its own EMAIL, so this provider
  // has no third step. Nothing needs to fetch the business's own website.
  // THE PROVIDER TABLE ARRIVES FROM OUTSIDE — see `providers.js`.
  //
  // This engine is serialised to source by `executeScript`, so it cannot import: the descriptors
  // travel in through `op.providers` as plain data and are compiled here. Same door `tld.js` uses
  // to hand the TLD list to the mail reader, and for the same reason.
  //
  // The fallback is Google alone. A worker that somehow sends nothing still recognises the map it
  // has always recognised, rather than deciding no page is a map at all.
  const PROVIDERS = (() => {
    const out = {};
    const list = (op && op.providers) || [{ id: 'gmaps', host: '(^|\\.)google(\\.[a-z]{2,3})+$',
      path: '^/maps(/|$)', recordHref: '/maps/place/', grows: 'scroll', reads: 'click', steps: 3 }];
    for (const d of list) {
      try {
        out[d.id] = { ...d, hostRe: new RegExp(d.host, 'i'), pathRe: new RegExp(d.path),
          recordRe: d.recordHref ? new RegExp(d.recordHref) : null };
      } catch (_) { /* a malformed pattern must not take the whole table down */ }
    }
    return out;
  })();
  const MAPS = Object.entries(PROVIDERS).map(([k, v]) => [k, v.hostRe, v.pathRe]);
  const MAPPINGS = Object.keys(PROVIDERS).filter((k) => PROVIDERS[k].reads);
  const FETCH_READ = new Set(MAPPINGS.filter((k) => PROVIDERS[k].reads === 'fetch'));
  const RECORD_HREF = Object.fromEntries(
    Object.entries(PROVIDERS).filter(([, v]) => v.recordRe).map(([k, v]) => [k, v.recordRe]));
  const traitsOf = (k) => {
    const v = PROVIDERS[k] || {};
    // `recordHref` travels too: the WALK needs it to tell one row from another (a card's record
    // link is what the row is about; its category chip is not). See `rowIdentity`.
    return { map: k || '', reader: !!v.reads, grows: v.grows || '', reads: v.reads || '',
      recordHref: v.recordHref || '', list: v.list || '', steps: v.steps || 3,
      next: v.next || '', pageLabel: v.pageLabel || '' };
  };
  // THE FIRST VISIBLE MATCH, because a descriptor's selector can have hidden twins. Gmail's
  // categorised inbox renders one thread table per tab panel with the inactive ones `display:none`,
  // and `querySelector` returns whichever comes first in the DOM — a table nobody can see.
  function visibleMatch(sel) {
    let all = [];
    try { all = [...document.querySelectorAll(sel)]; } catch (_) { return null; }
    return all.find((n) => n.getClientRects && n.getClientRects().length) || null;
  }
  // THE NEXT-PAGE CONTROL THE DESCRIPTOR NAMED, resolved against the live page. `null` when this
  // site names none; `{ el: null }` when it names one that is not here; `dead` when it is here but
  // disabled, which is how a pager says "last page" far more reliably than by disappearing.
  function declaredNext() {
    const sel = traitsOf(mapKind()).next;
    if (!sel) return null;
    const el = visibleMatch(sel);
    if (!el) return { sel, el: null };
    const dead = el.getAttribute('aria-disabled') === 'true' || el.disabled
      || /(^|\s)(disabled|is-disabled)(\s|$)/.test(el.className?.toString() || '');
    const label = (el.getAttribute('aria-label') || el.getAttribute('title')
      || el.getAttribute('data-tooltip') || (el.textContent || '')).replace(/\s+/g, ' ').trim().slice(0, 40);
    return { sel, el, dead, label };
  }
  // THE PAGE NUMBER, READ OFF A "101–150 of 8,614" COUNTER — the one place a site whose address
  // never changes says where it is. The numbers are taken in order: the first two are the range,
  // the third the total, so "1-50 dari 8.614" reads the same as the English. Page = how many
  // whole pages of this size come before the range's start.
  function counterPage() {
    const sel = traitsOf(mapKind()).pageLabel;
    if (!sel) return null;
    const el = visibleMatch(sel);
    if (!el) return null;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const nums = (text.match(/\d[\d.,\u00a0 ]*\d|\d/g) || [])
      .map((x) => parseInt(x.replace(/\D/g, ''), 10)).filter((n) => Number.isFinite(n));
    if (nums.length < 2 || nums[1] < nums[0]) return null;
    const [start, end, total] = nums;
    const size = Math.max(1, end - start + 1);
    return { page: Math.floor((start - 1) / size) + 1, start, end, total: total ?? null, size, text };
  }
  const OFFSITE_VENDOR = /servicetitan|housecallpro|getjobber|clienthub|recreateai|calendly|business\.site|squareup/i;
  // AN AD CLICK IS NOT AN ANSWER ABOUT THE BUSINESS AT ALL. Maps serves a sponsored row's website
  // as a Google Ads redirect — `google.com/aclk?…`, `googleadservices.com/pagead/aclk?…` — which is
  // a tracking hop that happens to end at the advertiser's site. Measured on one export: a row
  // whose `Website` read `google.com/aclk?…` while the real site was sitting in the OTHER website
  // column the same row already carried.
  //
  // It has to be named separately from the google-host refusal beside it, because the two want
  // opposite treatment. `maps.google.com` as a website means "this business has no site of its
  // own" and is a definite answer; an `aclk` wrapper means "this link is an ad", says nothing
  // either way, and must not stop the row's real link being used. Refusing it also saves the third
  // step a request that would have been attributed to whoever the ad happened to lead to.
  const AD_REDIRECT = /(^|\.)googleadservices\.com|(^|\.)doubleclick\.net|[/?&]aclk[?&/]|[/?&]aclk$|\/pagead\//i;
  // AND A SOCIAL PAGE IS NOT A WEBSITE EITHER, measured: of 62 plumbers on one rail, one had
  // typed `m.facebook.com/plumb.masters` into Maps as their website (`MAPS-CHAIN.md`). Reading
  // that page for a contact address gives you Facebook's, not the plumber's — and there is no
  // second guess to fall back on, so this has to be refused rather than ranked down.
  const OFFSITE_SOCIAL = new RegExp('(^|\\.)(' + [
    'facebook\\.com', 'fb\\.com', 'fb\\.me', 'instagram\\.com', 'twitter\\.com', 'x\\.com',
    'linkedin\\.com', 'tiktok\\.com', 'youtube\\.com', 'youtu\\.be', 'pinterest\\.[a-z.]+',
    'threads\\.net', 'wa\\.me', 'api\\.whatsapp\\.com', 't\\.me', 'telegram\\.me',
    // Directories, which are somebody else's listing of this business, not the business.
    'yelp\\.[a-z.]+', 'tripadvisor\\.[a-z.]+', 'foursquare\\.com', 'nextdoor\\.com',
    'angi\\.com', 'homeadvisor\\.com', 'thumbtack\\.com', 'bbb\\.org', 'yellowpages\\.[a-z.]+',
    'linktr\\.ee', 'bit\\.ly',
  ].join('|') + ')$', 'i');
  const mapKind = () => {
    for (const [name, host, path] of MAPS) {
      if (host.test(location.hostname) && path.test(location.pathname)) return name;
    }
    return '';
  };

  // NAMED FIELDS FOR A ROW WHOSE SHAPE `nameCols` CANNOT LEARN BY GUESSING. See `provider-x.js`
  // for the case this exists for: a timeline that interleaves plain posts, quote-posts and
  // promoted ads, each nesting its content at a different depth, so no attribute is shared
  // structurally across every row for the generic namer to key on.
  //
  // Returns `@`-prefixed keys — the SAME convention a Maps/2GIS detail-page read already
  // produces (see `readDetail`'s `out['@' + name]`), so `nameCols` takes the name as given and
  // never runs its guessing heuristics on it. `null` when this provider names no fields, which
  // is every provider except the ones that opt in — `cellsOf` falls back to the generic walk.
  // A POST'S REAL VIDEO IS RESOLVED PER-POST, IN THE BACKGROUND, THE MOMENT ITS ROW IS FIRST
  // SEEN — NOT AFTER A WALK OF HUNDREDS OF POSTS FINISHES. `VideoThumb` (below) is only ever a
  // poster image; the actual playable file needs a round trip to X's public syndication API —
  // the same one `table.js`'s lightbox and `x-video-resolve.js`'s `resolveXVideo` use.
  // DUPLICATED HERE RATHER THAN IMPORTED, for the same reason table.js keeps its own copy:
  // `pageRows` is injected via `chrome.scripting.executeScript({func: pageRows})`, which
  // serializes this function's OWN body — nothing outside it, an ES module import included,
  // survives that trip.
  // Cached on `window`, one lookup per tweet id for this tab's lifetime, and fired ONCE per id —
  // not awaited, so the walk never blocks on a network round trip. A row re-extracts every few
  // seconds anyway (the passive poll alone does this), so the very next look at the SAME row
  // picks up the resolved url; an early post in a long scroll has it long before the scroll ends.
  function xSyndicationToken(id) {
    const n = BigInt(id);
    const HALF = 1000000000000000n;
    return ((Number(n / HALF) + Number(n % HALF) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
  }
  function xVideoCache() {
    if (!window.__holoscrapeVideoResolve) window.__holoscrapeVideoResolve = new Map();
    return window.__holoscrapeVideoResolve;
  }
  function resolveXVideoInline(statusId) {
    const cache = xVideoCache();
    const hit = cache.get(statusId);
    if (hit) return hit.status === 'done' ? hit.url : null;
    cache.set(statusId, { status: 'pending', url: null });
    fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${statusId}&token=${xSyndicationToken(statusId)}`,
      { credentials: 'omit' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        let best = null;
        (function walk(node) {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node.variants)) {
            const mp4 = node.variants.filter((v) => v.content_type === 'video/mp4');
            mp4.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
            if (mp4[0] && (!best || (mp4[0].bitrate || 0) > (best.bitrate || 0))) best = mp4[0];
          }
          for (const v of Object.values(node)) walk(v);
        })(data);
        cache.set(statusId, { status: 'done', url: best ? best.url : null });
      })
      .catch(() => cache.set(statusId, { status: 'done', url: null }));
    return null;
  }

  // X'S OWN REDUX STORE NEVER EVICTS A TWEET ONCE LOADED — THE DOM DOES, ON PURPOSE.
  //
  // Every attempt this session to out-scroll X's virtualized list (bigger press budgets,
  // a window-level snapshot accumulator surviving container swaps, letting the walk
  // survive an early Stop) was patching the DOM layer. Measured live: the DOM mounts ~9
  // `<article>` cells at a time no matter how far you've scrolled; `window.scroller`
  // (the virtualizer's own React fiber, reachable because this runs in the page's MAIN
  // world) holds a plain Redux store whose `entities.tweets`/`entities.users` caches held
  // 284 full tweets — everything the client has fetched into this tab this session,
  // never evicted. Reading it directly is strictly better than any DOM-walk budget could
  // ever be: immune to scroll state, to a `document changed` container swap, to Stop.
  //
  // Runs alongside the DOM read, never instead of it — a tab that never loaded `scroller`
  // (not on x.com, or X changed its internal component name) just gets nothing back here
  // and the DOM path is unaffected. See memory
  // `reference_holoscrape_x_full_timeline_redux_store.md` for how this was found.
  function xReduxRows() {
    try {
      const state = window.scroller?.context?.store?.getState?.();
      const tweets = state?.entities?.tweets?.entities;
      const users = state?.entities?.users?.entities;
      if (!tweets) return null;
      const out = new Map();
      for (const [id, t] of Object.entries(tweets)) {
        if (!t || typeof t.full_text !== 'string') continue;
        const u = (users && users[t.user]) || {};
        const handle = u.screen_name || '';
        const name = u.name || '';
        // A tweet/status id IS a timestamp (Twitter's snowflake format) — no separate
        // field needed, and one that survives even a legacy payload that omits it.
        let iso = '';
        try {
          const ms = (BigInt(id) >> 22n) + 1288834974657n;
          iso = new Date(Number(ms)).toISOString();
        } catch (_) { /* leave blank rather than a wrong date */ }
        const media = Array.isArray(t.entities?.media) ? t.entities.media : [];
        const photo = media.find((m) => m?.type === 'photo');
        const video = media.find((m) => m?.type === 'video' || m?.type === 'animated_gif');
        // THE PLAYABLE FILE, WITHOUT A NETWORK CALL. `video_info.variants` carries the same
        // mp4 list the syndication API would answer with — measured live: three bitrates plus
        // an HLS master, on the media entity itself. So a video post's real, complete,
        // third-party-fetchable url is already in memory: no token math, no round trip, and
        // none of the `statusId` cross-referencing that `scan.js` has to do (and that misses,
        // which is what left a captured DASH init segment playing as "904 B, can't play this
        // file"). Highest bitrate wins, same rule the syndication path already used.
        let bestMp4 = '';
        {
          const vs = Array.isArray(video?.video_info?.variants) ? video.video_info.variants : [];
          let top = -1;
          for (const v of vs) {
            if (v?.content_type !== 'video/mp4' || !v.url) continue;
            const rate = Number(v.bitrate) || 0;
            if (rate >= top) { top = rate; bestMp4 = v.url; }
          }
        }
        const cells = {
          '@Author': name && handle ? `${name}@${handle}` : (name || handle || ''),
          '@Handle': handle ? `https://x.com/${handle}` : '',
          '@Text': String(t.full_text).replace(/\s+/g, ' ').trim().slice(0, 400),
          '@Time': iso,
          '@Engagement': `${t.reply_count || 0} replies, ${t.retweet_count || 0} reposts, `
            + `${t.favorite_count || 0} likes, ${t.bookmark_count || 0} bookmarks`,
          '@Link': handle ? `https://x.com/${handle}/status/${id}/analytics` : `https://x.com/i/status/${id}`,
        };
        if (photo?.media_url_https) cells['@Image src'] = photo.media_url_https;
        if (video?.media_url_https) cells['@VideoThumb src'] = video.media_url_https;
        if (bestMp4) cells['@Video href'] = bestMp4;
        for (const k of Object.keys(cells)) if (!cells[k]) delete cells[k];
        if (Object.keys(cells).length) out.set(id, cells);
      }
      return out.size ? out : null;
    } catch (_) { return null; }
  }

  function providerFieldsOf(row) {
    const fields = PROVIDERS[mapKind()]?.fields;
    if (!fields) return null;
    const out = {};
    for (const [name, spec] of Object.entries(fields)) {
      const at = spec.indexOf('@');
      const sel = at < 0 ? spec : spec.slice(0, at);
      const attr = at < 0 ? '' : spec.slice(at + 1);
      let el;
      try { el = row.querySelector(sel); } catch (_) { continue; }
      if (!el) continue;
      // `ownText` (direct text-node children only) is right for the generic structural walk,
      // which must not swallow a whole subtree it doesn't understand — but a provider field is
      // an explicit ask for "this element's text", and sites routinely wrap that text in nested
      // spans (X wraps both the display name and the post body in `<span>`s for emoji/mixed-
      // script rendering), so `ownText` reads back empty here. Use the full text content instead.
      let v = attr ? (el.getAttribute(attr) || '') : (el.textContent || '');
      if (!v) continue;
      // An href is the one attribute worth resolving — every other attribute (a datetime, an
      // aria-label) is already the value, not a path to make absolute.
      if (attr === 'href') v = abs(v);
      else if (attr === 'src' || attr === 'poster') v = abs(v);
      // A " src"/" href" SUFFIX ON THE KEY, not just a value that happens to look like a url —
      // `nameCols` strips it back off for the header the person sees (`col.key.slice(1).replace
      // (/ (src|srcset|href)$/, '')`), but the column-`kind` classifier a few steps later reads
      // the UNSTRIPPED key to decide whether to paint a cell as a picture or as text, and it
      // matches only that suffix — never the attribute a descriptor happened to name. Reported
      // live: a provider row carried a real, working image url in `@Image`/`@VideoThumb` and the
      // results table still rendered it as a bare url string, because "Image"/"VideoThumb" ends
      // in neither. `readDetail`'s own image fields already rely on exactly this convention (see
      // `@Street view src`) — this brings a provider's own fields in line with it instead of
      // quietly disagreeing about what makes a column a picture.
      const key = (attr === 'src' || attr === 'poster') ? `${name} src` : name;
      out['@' + key] = String(v).replace(/\s+/g, ' ').trim().slice(0, 400);
    }
    // ONLY EVER FIRES ON X: gated on the provider id itself, not just field shape, since a
    // `VideoThumb src` + `Link` pair matching by coincidence on some other site's fields would
    // otherwise send it a request it never asked for.
    if (mapKind() === 'x' && out['@VideoThumb src'] && out['@Link']) {
      const m = out['@Link'].match(/status(?:es)?\/(\d+)/);
      if (m) {
        const real = resolveXVideoInline(m[1]);
        if (real) out['@Video href'] = real;
      }
    }
    return Object.keys(out).length ? out : null;
  }

  // The link that IS the record. The same rule `identOf` uses to name a row, returning the
  // element so it can be clicked — not "the first anchor", which on a listing card is the
  // country flag or a badge.
  // `want`, when given, is what a RECORD's link has to look like — see `RECORD_HREF`. Without it
  // this returns the longest link of any kind, which is right for naming a row and WRONG for
  // deciding what to click: a rail's suggestion cards link to searches, and clicking one replaces
  // the list.
  function recordLinkOf(r, want) {
    let best = null;
    let len = 0;
    try {
      for (const a of (r.querySelectorAll ? r.querySelectorAll('a[href]') : [])) {
        const h = a.getAttribute('href') || '';
        if (!h || /^(#|javascript:)/i.test(h)) continue;
        if (want && !want.test(h)) continue;
        let bare = h;
        try { const u = new URL(h, location.href); bare = u.origin + u.pathname; } catch (_) {}
        if (bare.length > len) { len = bare.length; best = a; }
      }
    } catch (_) {}
    return best;
  }

  // THE BUSINESS'S OWN SITE, from a row of the list — the input to the third step.
  //
  // `data-value` is the handle Maps stamps on that button, and the same one `nameCols` trusts
  // to name the column (see the note there: `<a data-value="Website" href="…">`, on all 64 rows
  // of a measured rail). `data-item-id="authority"` is the panel's form of it, kept so a row
  // that is really a panel still answers.
  //
  // The fallback is deliberately narrow — the ONLY off-site link in the row. A rail card links
  // to the place itself, to directions, and sometimes to a booking vendor; with two candidates
  // there is no evidence for which is the business's, and guessing wrong spends a page visit on
  // somebody else's site. `nameCols` refuses to name a Website column under exactly the same
  // condition, for the same reason.
  function siteLinkOf(r) {
    const abs = (h) => { try { return new URL(h, location.href).href; } catch (_) { return ''; } };
    try {
      const usable = (u) => {
        if (!/^https?:/i.test(u)) return false;
        let host = '';
        try { host = new URL(u).host.replace(/^www\./, '').toLowerCase(); } catch (_) { return false; }
        if (!host) return false;
        // The map's own domains are the map, not a website — an `aclk` redirect is an ad.
        if (/(^|\.)google(\.[a-z]{2,3})+$/i.test(host) || /(^|\.)goo\.gl$/i.test(host)) return false;
        if (OFFSITE_SOCIAL.test(host)) return false;
        return !OFFSITE_VENDOR.test(u);
      };
      // The stamped handle is checked against the same rules as a guess. It says which link the
      // owner CALLED their website, not that the link is one.
      const direct = r.querySelector('a[data-value="Website" i], a[data-item-id="authority"]');
      if (direct) {
        const u = abs(direct.getAttribute('href') || '');
        if (usable(u)) return u;
        // A named-but-unusable website is a definite answer: this row has no site of its own.
        // Falling through to "the only off-site link" here would pick the row's Directions link
        // or its booking vendor and read that instead.
        //
        // EXCEPT AN AD REDIRECT, which is the one unusable value that is not an answer — see
        // `AD_REDIRECT`. A sponsored row's website arrives wrapped in `aclk`, and treating that
        // wrapper as "no site" throws away the real link the same card is carrying.
        if (/^https?:/i.test(u) && !AD_REDIRECT.test(u)) return '';
      }
      const off = [];
      for (const a of (r.querySelectorAll ? r.querySelectorAll('a[href]') : [])) {
        const u = abs(a.getAttribute('href') || '');
        if (!usable(u)) continue;
        if (!off.includes(u)) off.push(u);
      }
      return off.length === 1 ? off[0] : '';
    } catch (_) { return ''; }
  }

  // The region a page opens for one record. `role="main"` with a name on it: the name is
  // what makes it answerable — it says WHICH record is showing, which is the only way to
  // know the panel has caught up with the click.
  const panelOf = () => {
    for (const m of document.querySelectorAll('[role="main"][aria-label]')) {
      try { if (m.getBoundingClientRect().width > PANEL_MIN_WIDTH) return m; } catch (_) {}
    }
    return null;
  };
  const panelName = () => (panelOf()?.getAttribute('aria-label') || '').trim();

  // WHICH RECORD THE PANEL IS SHOWING, in enough detail to tell it from the one before.
  //
  // The name alone is not enough and this rail proves it twice over: it carries "Austin
  // Plumbing" at two different addresses, and "Reliant Plumbing" beside "Reliant Plumbing -
  // Austin". So the mark carries the fields that actually differ between two records —
  // its name, its address and its phone handle.
  const panelMark = () => {
    const p = panelOf();
    if (!p) return '';
    let addr = '';
    let tel = '';
    for (const el of p.querySelectorAll('[data-item-id]')) {
      const k = el.getAttribute('data-item-id') || '';
      if (k === 'address') addr = (el.getAttribute('aria-label') || '').slice(0, 60);
      else if (k.startsWith('phone:tel:')) tel = k;
    }
    return `${p.getAttribute('aria-label') || ''}|${addr}|${tel}`;
  };

  // Labelled fields, read off the handles the page stamps on them. `data-item-id` is the
  // stable one — the class names beside it are per-build hashes that rotate.
  //
  // The values arrive with their own label glued on ("Address: 3705 San Antonio St"), so a
  // short leading label is stripped. Short, and only up to the first colon, because a value
  // may well contain one.
  const DETAIL_FIELDS = [
    // handle              column
    ['address', 'Full address'],
    ['oh', 'Hours'],
    ['oloc', 'Plus code'],          // below the fold — see the walk below
    ['menu', 'Menu'],
    ['place-info-links:', 'Attributes'],
  ];
  // Google's icon fonts put their glyphs in the Unicode PRIVATE USE AREAS, so those code points carry
  // no meaning at all once they leave the page — they are a picture, not a letter. Stripped wherever a
  // value comes from `textContent` rather than from an `aria-label`.
  const noGlyph = (v) => String(v || '').replace(/[\uE000-\uF8FF]/g, '')
    .replace(/[\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu, '');
  const unlabel = (v) => String(v || '').replace(/^[^:]{1,18}:\s*/, '').trim();

  // WHICH ELEMENT INSIDE THE PANEL SCROLLS — probed, not read off `overflow`, the same way
  // the list's own scroller is found. It is not the panel itself: measured, the panel is a
  // wrapper and the scroller is a div inside it.
  function panelScroller(panel) {
    const can = (el) => {
      try {
        const b = el.scrollTop;
        el.scrollTop = b + SCROLL_PROBE_PX;
        const moved = el.scrollTop !== b;
        el.scrollTop = b;
        return moved;
      } catch (_) { return false; }
    };
    if (can(panel)) return panel;
    for (const el of panel.querySelectorAll('div')) if (can(el)) return el;
    return null;
  }

  // --- the WEB RESULTS section ------------------------------------------------------
  //
  // This is where the record's wider web presence lives — its Facebook page, its Nextdoor
  // listing, a directory entry — and it is reachable by NEITHER of the obvious routes. Two
  // measurements killed two assumptions:
  //
  //   1. IT IS NOT IN THE PANEL. Maps renders the section as a same-origin `<iframe>`
  //      (`/search?q=…&pcl=lp&ibp=gwp;0,26,…`, 402x578, sized to the panel) sitting inside
  //      it. A query scoped to the panel's own DOM can never see it — measured: 10 anchors
  //      in the ENTIRE top document, none of them a web result, while the section was
  //      plainly on screen.
  //   2. IT HAS NO LINKS AT ALL. `contentDocument.querySelectorAll('a[href]')` returns
  //      **zero**. The destination is DISPLAY TEXT — `https://www.facebook.com ›
  //      Walker-Plumbing...` — so a link collector scoped into the frame finds nothing
  //      either. The text is the only carrier.
  //
  // Same-origin, so the parent can read it without any manifest or all-frames change.
  //
  // Its text is regular: one line of host breadcrumb, one line of title, one of snippet.
  // Parsed from THAT rather than from the per-card class (`.qbsh5d` here), which is a
  // per-build hash and will rotate.
  //
  // The full URL is NOT recoverable and the column must not pretend otherwise: Google
  // truncates it for display (`› Walker-Plumbing...`) and there is no href behind it. The
  // host and the title are what exist, so the host and the title are what is reported.
  // How many of a record's own photos to keep. Each one becomes a downloadable file, so a
  // hundred records at six apiece is six hundred — enough that a ceiling belongs here.
  const PHOTO_MAX = 6;
  // Google's camera car, not the business — see `readDetail`.
  const STREET_VIEW = /streetviewpixels-pa\.googleapis\.com/i;
  // A PICTURE OF NOTHING IS NOT A PICTURE. Measured in one Seychelles export:
  //
  //   Yummy Pots Halal Cuisines  Image 1: result-no-thumbnail-2x.png   693 bytes
  //   every row, all 110         Image 2: default_user.png             634 bytes
  //
  // Both clear the 200px floor below — Google serves its placeholders at full card size — so a
  // size test alone cannot see them, and a whole column of the second one shipped as if 110
  // businesses had each chosen the same grey avatar. This is strictly worse than an empty cell:
  // a missing photo is visibly missing, a placeholder is a quiet false claim.
  //
  // Matched on NAME, not on host, and that is deliberate. These are among the few Maps images
  // served under a real filename rather than an opaque CDN handle, which is exactly what makes
  // them recognisable — the same property noted in `STEP1-AUDIT`. An opaque handle is a real
  // photo; a file called `result-no-thumbnail` is Google telling us there isn't one.
  const PLACEHOLDER = /\/(default_user|result-no-thumbnail|no_street_view|generic_no_?photo|placeholder)[-_.\w]*\.(png|jpe?g|gif|webp)(\?|$)/i;
  // How many of Google's review topics to keep. Measured 16+ per record; the first several are
  // the ones with the counts worth reading, and a cell has to stay a cell.
  const TOPIC_MAX = 8;
  const WEB_FRAME_SRC = /\/search\?/;
  const WEB_WAIT_MS = 4000;
  const WEB_POLL_MS = 150;
  const WEB_MIN_BOX = 40;      // px — laid out, rather than mid-construction at 0x0

  function webFrameOf(panel) {
    const pick = (root) => {
      for (const f of root.querySelectorAll('iframe')) {
        if (WEB_FRAME_SRC.test(f.getAttribute('src') || '')) return f;
      }
      return null;
    };
    // Inside the panel is where Maps puts it; the document is the fallback if that moves.
    return pick(panel) || pick(document);
  }

  // WHAT THE FRAME IS DOING, not merely whether it has characters in it — because the state
  // before it is finished has PLENTY of characters and they are the wrong ones. Measured, at
  // the end of the walk on three records: `0x0 interactive len=31006`. Thirty-one thousand
  // characters is a whole search-results page; the web-results widget that replaces it is
  // 550-730. A reader that takes "has text" as its signal parses the wrong document and fills
  // the column with junk it can never be told apart from a real read.
  //
  // Ready means all three: laid out at a real size, its document finished, and text in it.
  const webFrameRead = (panel) => {
    const f = webFrameOf(panel);
    if (!f) return { has: false, ready: false, text: '' };
    let box = { width: 0, height: 0 };
    try { box = f.getBoundingClientRect(); } catch (_) {}
    const laid = box.width > WEB_MIN_BOX && box.height > WEB_MIN_BOX;
    let done = false;
    let text = '';
    try {
      const d = f.contentDocument;
      done = !!d && d.readyState === 'complete';
      text = d?.body?.innerText || '';
    } catch (_) { return { has: true, ready: false, text: '' }; }
    return { has: true, ready: laid && done && !!text, text: laid && done ? text : '' };
  };

  // AWAIT IT — AND THE FRAME DOES NOT EXIST YET WHEN THIS STARTS.
  //
  // The first version returned immediately when it could not find the frame, on the
  // reasonable-sounding grounds that a record without the section has nothing to wait for.
  // Measured, that is backwards: enumerating iframes before the walk finds **no** `/search?`
  // frame, and enumerating them after finds it, in the panel, 402x578, with its text loaded.
  // Maps CREATES the frame as the section scrolls into view. So "not there" is the normal
  // state at the moment this is called, and treating it as "nothing to wait for" is why the
  // column stayed empty on every record.
  //
  // Two waits, therefore: for the element to appear, then for its document to be FINISHED —
  // see `webFrameRead` for why "has text" is not that. Bounded twice: by its own cap and by
  // the record's overall deadline, whichever comes first.
  //
  // Measured, once the walk below reaches a settled bottom, this returns in 0-1ms on every
  // record — because arriving at the bottom is what loads the frame. This wait is now the
  // safety net for a slow one, not the mechanism.
  async function awaitWebFrame(panel, dead) {
    const until = Math.min(performance.now() + WEB_WAIT_MS, dead);
    let seen = false;
    while (performance.now() < until && !stopped()) {
      const r = webFrameRead(panel);
      seen = seen || r.has;
      if (r.ready) return { seen: true, text: r.text };
      await nap(WEB_POLL_MS);
    }
    return { seen, text: '' };
  }

  function webResults(t) {
    if (!t) return [];
    const lines = t.split('\n').map((s) => s.trim()).filter(Boolean);
    const out = [];
    const seen = new Set();
    for (let i = 0; i < lines.length - 1; i++) {
      const m = /^https?:\/\/([^\s/›]+)/i.exec(lines[i]);
      if (!m) continue;
      const host = m[1].replace(/^www\./, '');
      const next = lines[i + 1];
      if (!next || /^https?:\/\//i.test(next)) continue;   // a breadcrumb with no title under it
      if (seen.has(host)) continue;                        // one entry per site
      seen.add(host);
      out.push(`${host} — ${next.slice(0, 90)}`);
    }
    return out;
  }

  // Every off-site link the record's page is showing. This is the second half of what a
  // record is worth — the sections below the fold carry the business's own site, its booking
  // vendor and its wider web presence (a jobs listing, a directory entry, a social profile).
  function panelLinks(panel) {
    const out = [];
    const seen = new Set();
    for (const a of panel.querySelectorAll('a[href^="http"]')) {
      let u;
      try { u = new URL(a.href); } catch (_) { continue; }
      if (PANEL_OWN.test(u.host)) continue;
      // Deduped on origin + path: Maps renders the same destination twice, once as text and
      // once as an icon, and every outbound link carries its own utm parameters.
      const key = u.origin + u.pathname;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a.href);
    }
    return out;
  }

  // Walk the record's page to the BOTTOM, because the sections worth having are the ones it
  // has not drawn yet.
  //
  // The first version stopped when no new `data-item-id` arrived for two steps, which reads
  // as reasonable and is wrong: the fields with those handles are all near the top, so the
  // walk gave up two steps in — and the web-results section, which carries LINKS and no
  // handles at all, had not been drawn yet. It moved on to the next record every time.
  //
  // A DRYNESS RULE WAS THE SECOND THING TO STOP THIS WORKING, and the measurement is
  // unambiguous: with two dry steps allowed, the walk stopped at step 2 — and the scroller's
  // height then grew 4,777 → 5,171 at step 3. A page that has been quiet for two screens is
  // not a page that has finished, and the sections this walk exists to reach are the last
  // ones drawn.
  //
  // So there is no early exit on dryness any more, and — the fix that made the web-results
  // section work at all — NO EXIT ON A STEP THAT DID NOT MOVE EITHER. `scrollTop` refusing to
  // advance means one of two completely different things: the page is finished, or the page
  // is still mounting and is currently too short to scroll. Measured, both happen, and
  // treating the second as the first stopped one record in five at 410px of 4,550px with the
  // section never drawn. The end of the page is: at the bottom, no taller than it was, and
  // unable to move — twice in a row.
  //
  // Measured with that rule: 8-10 steps, 1.8-2.2s, and the bottom REACHED on 6 of 6 records
  // including the one that used to stop at step 2.
  //
  // It returns what it found, because the caller has to be able to say WHY a record came back
  // thin — a walk that ran out of clock short of the bottom is a different fact from a record
  // that has no web-results section, and the pass reports them separately.
  async function walkPanel(panel, dead) {
    const sc = panelScroller(panel);
    if (!sc) return { steps: 0, bottom: false, seen: false, web: '' };
    const until = Math.min(performance.now() + PANEL_WALK_MS, dead);
    let steps = 0;
    let still = 0;
    while (performance.now() < until && !stopped()) {
      const at = sc.scrollTop;
      const was = sc.scrollHeight;
      sc.scrollTop = at + sc.clientHeight;
      steps++;
      await nap(PANEL_DWELL);
      // This walk does not go through `detailStep`, so it collects for itself.
      sipTake();
      const stuck = sc.scrollTop === at;
      const grew = sc.scrollHeight > was;
      if (atEnd(sc) && !grew && stuck) { if (++still >= PANEL_SETTLE) break; } else still = 0;
    }
    const bottom = atEnd(sc);
    // The frame is READ HERE, at the bottom, where it is known to be loaded — and its text is
    // handed to the caller rather than looked up again later. One read, at the one moment the
    // measurement says it is trustworthy.
    const web = stopped() ? { seen: false, text: '' } : await awaitWebFrame(panel, dead);
    // Back to the top, so the next record's page does not inherit a scroll position. Measured
    // as harmless to the frame — it stays laid out and readable after this — but the read
    // above no longer depends on that being true.
    try { sc.scrollTop = 0; } catch (_) {}
    return { steps, bottom, seen: web.seen, web: web.text };
  }

  // `lite` SKIPS THE EXPENSIVE HALF, for the per-step harvest.
  //
  // The photo loop reads `naturalWidth` on every `<img>` in the panel, and that forces a layout. Once
  // per record is nothing; once per walk STEP is a stall on the very tab that is also waiting for the
  // web-results frame to load. Measured: harvesting with the full read cost 10% more per record and
  // dropped `Web results` from 7 of 7 to 6 of 7 — the harvest paying for itself with the column it
  // was supposed to protect. The fields it exists to keep are all text.
  function readDetail(href, webText, lite) {
    const panel = panelOf();
    if (!panel) return null;
    const out = {};
    const seen = new Map();
    for (const el of panel.querySelectorAll('[data-item-id]')) {
      const k = el.getAttribute('data-item-id');
      // `noGlyph`, because these rows begin with an ICON, and the icon is a character.
      //
      // Maps draws them from a private-use font, so `textContent` starts with a code point that has
      // no meaning outside Google's own typeface — measured on live panels: U+E0C8 before an address,
      // U+E0B0 before a phone, U+F186 before a plus code. It renders in the sheet as a wrong glyph
      // (`î¡` after any encoding wobble) and it is the reason a Menu cell came out `î¡Menulinktr.ee`.
      // The `aria-label` is clean where it exists, which is why most fields escaped this.
      const v = noGlyph(el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (k && v && !seen.has(k)) seen.set(k, v);
    }
    for (const [handle, name] of DETAIL_FIELDS) {
      const v = seen.get(handle);
      if (v) out['@' + name] = unlabel(v).slice(0, 200);
    }
    // The number off the handle itself. `phone:tel:+15129600044` is the E.164 form that the card's
    // own `(512) 960-0044` is not, and no formatter here could produce it — the country is not in
    // the printed number.
    //
    // BUT THE `+` IS NOT ALWAYS THERE, and requiring it silently emptied the whole column.
    // Measured on live Maps with `hl=en&gl=id` (`test/_probe-id.mjs`), three Cimahi panels:
    //
    //   phone:tel:085173274411      aria-label "Phone: 0851-7327-4411"
    //   phone:tel:087780006819      aria-label "Phone: 0877-8000-6819"
    //
    // A national number, no country code. The old pattern demanded a leading `+`, so an export of
    // 120 Indonesian places came back with NO phone column at all — not blank, absent, because a
    // column no row ever filled does not exist — while the panel's card advertises "the
    // international phone number". The same reader returns 5 of 5 in Austin, which is exactly how a
    // whole-market gap goes unnoticed.
    //
    // A national number is NOT put in `Phone (intl)`: that column's promise is that the country is
    // in the digits. It goes to `Phone`, in the form the panel prints, which is the form somebody
    // dialling locally wants anyway.
    for (const k of seen.keys()) {
      const m = /^phone:tel:(\+?[\d]+)$/.exec(k);
      if (!m) continue;
      if (m[1].startsWith('+')) out['@Phone (intl)'] = m[1];
      else out['@Phone'] = unlabel(seen.get(k)).slice(0, 40) || m[1];
      break;
    }
    // Whether the owner has taken the listing. One phrase each way, measured — and blank
    // when neither is present, because "we could not tell" is not "no".
    const txt = (panel.innerText || '').replace(/\s+/g, ' ');
    if (/Confirmed by this business/i.test(txt)) out['@Claimed'] = 'yes';
    else if (/Claim this business/i.test(txt)) out['@Claimed'] = 'no';
    // Where the record actually is. Two traps here, and the second cost a measurement.
    //
    // The map centre in the URL is the CAMERA (`@lat,lng,z`); the record's own point is the
    // `!3d/!4d` pair, which is a different number — reading the camera would give every row
    // on screen the same coordinates.
    //
    // And it is read from THE ROW'S OWN LINK, not from `location.href`. The page updates
    // the panel before it updates the address bar, so a read that waits for the panel — as
    // this one correctly does — still catches the PREVIOUS record's URL. Measured: five
    // records opened, five panels read correctly, and only **three distinct latitudes**,
    // because two of them were one row behind. The row's link already carries the pair, so
    // there is nothing to wait for and nothing to race.
    const at = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(href || '')
      || /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(location.href);
    if (at) { out['@Latitude'] = at[1]; out['@Longitude'] = at[2]; }
    // Everywhere else this business appears on the web, as the record's own page lists it:
    // its site, its booking vendor, a jobs listing, a directory entry. This is the section
    // the walk above exists to reach, and it is the input to anything that goes on to read
    // those pages. Separated by a pipe rather than a newline so a spreadsheet cell stays one
    // line and the CSV needs no special handling.
    // Its own site and its booking vendor already have columns of their own, so a "links"
    // column repeating them is noise. What is worth having here is anything ELSE the panel
    // links out to.
    // THE BUSINESS'S OWN WEBSITE, WHICH THIS CODE HAD ALL ALONG AND THREW AWAY.
    //
    // `data-item-id="authority"` is the panel's Website button. It was read here purely to
    // compute `own` — the host used to FILTER the site back out of `@Web links` — and then
    // discarded, so `readDetail` emitted fourteen fields and not one of them was the website.
    // On a lead list that is the most valuable column there is, and its absence is why a
    // record's site only ever surfaced by accident, inside `Menu`, when the menu happened to
    // live on the business's own domain (`Menudelplace-seychelles.sc`).
    //
    // The FULL URL is kept, not the host: `lailaresort.com/drink-eat` is a page somebody can
    // open, `lailaresort.com` is a guess. `own` still gets the bare host, because stripping the
    // site out of the links column has to match `booking.lailaresort.com` too.
    let own = '';
    try {
      const a = panel.querySelector('a[data-item-id="authority"]');
      if (a && /^https?:/i.test(a.href)) {
        out['@Website'] = a.href;
        own = new URL(a.href).host.replace(/^www\./, '');
      }
    } catch (_) { own = ''; }
    const extra = lite ? [] : panelLinks(panel).filter((u) => {
      if (OFFSITE_VENDOR.test(u)) return false;
      try { return !own || !new URL(u).host.replace(/^www\./, '').endsWith(own); } catch (_) { return true; }
    });
    // `@Web links` DROPPED on request. `own` is still computed above because the `@Website` read
    // needs it; `extra` is still computed because it is what `own` was filtering. Neither reaches
    // a column any more.
    void extra;
    // --- what the panel says that has no `data-item-id` -----------------------------
    //
    // Measured field by field in `MAPS-PANEL.md`, three records, and every hook below answered
    // on all three. They are written WITHOUT CLASS NAMES on purpose: `F7nice`, `DkEaL`,
    // `wiI7pd`, `eK4R0e` are per-build hashes and every one of them will rotate. What holds is
    // what Google's own event wiring and its accessibility layer depend on — `role`,
    // `aria-label`, `data-value`, `data-review-id`, `lang`, and a `jsaction` verb.
    const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    // THE SHAPE OF A REPUTATION, WHICH ITS AVERAGE HIDES. Measured on one record: 4.6 stars,
    // and `5:49 4:5 3:0 2:0 1:5` — five people gave it one star, and the review shown first on
    // that panel is one of them. There is nowhere else on the page to learn this.
    const spread = [];
    for (const el of panel.querySelectorAll('[role="img"][aria-label]')) {
      const m = /^([1-5])\s+stars?,\s*([\d,]+)\s+review/i.exec(tidy(el.getAttribute('aria-label')));
      if (m) spread.push(`${m[1]}:${m[2].replace(/,/g, '')}`);
    }
    if (spread.length >= 3) out['@Rating spread'] = spread.join(' ');

    // GOOGLE'S OWN SUMMARY OF THE REVIEWS, with counts — `reliability 7`, `honesty 6`,
    // `helpful staff 33`. Sixteen or more per record, derived from the review text by them, and
    // not computable from anything else we extract.
    const topics = [];
    for (const el of panel.querySelectorAll('[aria-label*="mentioned in"]')) {
      const m = /^(.+?),\s*mentioned in\s*([\d,]+)\s*review/i.exec(tidy(el.getAttribute('aria-label')));
      if (m) topics.push(`${m[1]} ${m[2]}`);
    }
    if (topics.length) out['@Review topics'] = topics.slice(0, TOPIC_MAX).join(' | ');

    // ONE WHOLE REVIEW rather than the clipped fragment the card carries. `data-review-id` is
    // the handle; the prose is in the only child carrying a `lang`, which is there because
    // Google offers to translate it. The "More" button's caption is part of that element's text
    // and is not part of what anybody said.
    // `@Top review stars` USED TO BE READ HERE AND IS GONE. It filled 1 row of 106 — a single
    // reviewer's own star count, which says nothing about the business and is not the histogram
    // anyone wanted when they asked for one. The whole star distribution now arrives on the fetch
    // path for every record (`readSpread` in `place.js`), so this was a column that could only
    // ever be sparse and could only ever be misread as the thing beside it. Removed, not hidden.
    const rev = panel.querySelector('[data-review-id][aria-label]');
    if (rev) {
      const said = tidy(rev.querySelector('[lang]')?.textContent).replace(/\s*More$/, '');
      const who = tidy(rev.getAttribute('aria-label'));
      if (said) out['@Top review'] = `${who ? `${who} — ` : ''}${said}`.slice(0, 300);
    }

    // What Maps calls this business, off the jsaction verb rather than off a hashed class.
    const cat = tidy(panel.querySelector('button[jsaction*=".category"]')?.textContent);
    if (cat && cat.length <= 60) out['@Category'] = cat;

    // HOURS, AND THE HANDLE WE HAD WAS THE WRONG ONE. `data-item-id="oh"` is read above and
    // measured EMPTY on all three records — the `item-id` census on those panels is only
    // `address`, `authority`, `phone:tel:…`, `oloc`. The copy button beside each row of the
    // hours table carries the whole answer in an attribute: `data-value="Tuesday, 7 AM–7 PM"`.
    //
    // One day, not seven: collapsed — which is how a walked panel arrives — only today's row is
    // in the DOM. The week costs an extra click and is not taken. Today's is free.
    if (!out['@Hours']) {
      for (const el of panel.querySelectorAll('[data-value]')) {
        const v = tidy(el.getAttribute('data-value'));
        if (/^(mon|tues|wednes|thurs|fri|satur|sun)day,\s*\S/i.test(v)) { out['@Hours'] = v; break; }
      }
    }

    // And the web-results section, which is a different mechanism entirely — see above. Its
    // text arrives from the walk, captured at the bottom where the frame is loaded, rather
    // than being looked up again from here.
    const web = webResults(webText);
    if (web.length) out['@Web results'] = web.slice(0, 4).join(' | ');
    // THE RECORD'S OWN PHOTO, and the key has to end in `src` for it to become a FILE.
    //
    // A column is typed `asset` from the SHAPE OF ITS KEY (`…src`, `…srcset`, `…data-src`)
    // and `itemsFromTables` only turns asset columns into downloads. So a detail field named
    // anything else lands in the table as text and never reaches the Files view — which is
    // the whole of why opening 122 records added no pictures.
    //
    // EVERY photo the record shows, not one. A place panel carries a hero and a strip — on
    // one measured record: 426x240, then 265x149, 112x149, 199x149 — and they are that
    // record's own, so the next one opened brings a different set. One per row would throw
    // most of them away.
    //
    // Chosen by SIZE rather than by URL pattern: the panel's reviewer avatars are 72x72 and
    // its icons smaller still, while a business photo measures 200px and up. A size floor
    // needs no knowledge of Google's CDN paths, which is one less thing to rot.
    //
    // Deduped on the photo's IDENTITY, which is the path before the sizing parameters —
    // Google serves the same picture at several sizes (`…=w426-h240-k-no`) and the hero
    // appears twice in the markup, once as the big one and once in the strip.
    // AND A STREET VIEW IS NOT A PHOTOGRAPH. Measured on one record whose hero was
    // `streetviewpixels-pa.googleapis.com/v1/thumbnail?panoid=…` — Google's camera car drove
    // past, and the business supplied nothing. It clears the size floor and lands in a Photo
    // column looking exactly like a picture somebody chose, which is a quiet false claim about
    // the record. Its own column instead: still an asset (the key ends in `src`, so it is still
    // downloadable), and a record with no photo now plainly has no photo.
    const shots = [];
    const seenShot = new Set();
    let street = '';
    for (const im of (lite ? [] : panel.querySelectorAll('img'))) {
      const u = im.currentSrc || im.getAttribute('src') || '';
      if (!/^https?:/i.test(u)) continue;
      // THE SIZE TEST CANNOT DEPEND ON THE IMAGE HAVING BEEN DRAWN.
      //
      // `naturalWidth` is 0 until an image decodes, and an image does not decode in a tab that is
      // never painted — which is exactly what a lane tab is. So on the tab pass every photo failed
      // `w < 200` and the record came back with none, which is why a whole run's export has no
      // Photo columns and the sheet hides its "Include images" button: there is nothing to include.
      //
      // Visible in the exports side by side. A Cimahi list read through a visible tab carries
      // `Photo` through `Photo 6`, filled on 6 of 7 records. The Bandung lists, read by lanes,
      // carry no photo column at all.
      //
      // Google states the size in the URL — `…=w408-h306-k-no`, `…=s96-c` — so the question can be
      // asked of the string when the pixels are not available. `naturalWidth` is still preferred
      // where it exists, because it is the truth about the image rather than a request for one.
      const named = /[=&](?:w|s)(\d{2,5})(?:-h(\d{2,5}))?/.exec(u);
      const w = im.naturalWidth || (named ? +named[1] : 0);
      const h = im.naturalHeight || (named && named[2] ? +named[2] : 0);
      // A URL with no size in it and no decoded pixels is unmeasurable, not small — and dropping
      // those silently is how this failed in the first place. Kept, and sorted last by area 0.
      if (w && w < PHOTO_MIN_PX) continue;   // an avatar or an icon, not a photograph
      if (PLACEHOLDER.test(u)) continue;     // ...and Google's "no photo" image is not one either
      const ident = u.split('=')[0];
      if (seenShot.has(ident)) continue;
      seenShot.add(ident);
      if (STREET_VIEW.test(u)) { street = street || u; continue; }
      shots.push({ url: u, area: w * h });
    }
    if (street) out['@Street view src'] = street;
    // Biggest first, so column one is the record's main picture on every row.
    shots.sort((a, b) => b.area - a.area);
    shots.slice(0, PHOTO_MAX).forEach((s, i) => {
      // The key MUST end in `src`: that is what types the column as an asset, and only asset
      // columns become downloadable files. A photo under any other name is a string.
      out[i ? `@Photo ${i + 1} src` : '@Photo src'] = s.url;
    });
    // ANYTHING THE WALK SAW THAT IS NO LONGER ON SCREEN. See `sipTake`.
    for (const [k, v] of Object.entries(sipHas())) if (!out[k]) out[k] = v;
    return Object.keys(out).length ? out : null;
  }

  // --- what the walk saw, kept ------------------------------------------------------------
  //
  // THE PANEL DOES NOT HOLD ALL OF ITSELF AT ONCE, and reading it once at the end therefore loses
  // whichever end the walk is not standing on. Measured on one real run of 120 places, the two
  // passes read the same records and lost OPPOSITE halves:
  //
  //                     Web results     Plus code · Rating spread · Top review · Review topics
  //   lane pass         35 of 98        present
  //   rail hand-over    22 of 22        MISSING
  //
  // One mechanism explains both. Maps mounts these sections as they scroll into view and drops them
  // again once they are well out of it, and the two walks stop in different places: the lane walk is
  // bounded by a wall clock, so on a cold tab it runs out mid-panel — reviews are still mounted and
  // the web-results section was never reached, so its frame was never created. The rail walk is
  // bounded by a step count, so it arrives at the true bottom — the frame exists, and the review
  // sections it scrolled past are gone. Neither walk is wrong; reading only at the end is.
  //
  // So the read happens all the way down. Every step keeps whatever is on screen that we do not
  // already hold, and the final read fills its gaps from that. First writer wins: the panel's own
  // first rendering of a field is the one nearest the truth, and later steps cannot overwrite it.
  //
  // KEYED ON THE PLACE, because the failure this could cause is the worst one in the product. If
  // these values outlived their record, every row would come out holding an earlier row's reviews —
  // the repeating-payload bug, which took a real export of 124 identical-looking records to find.
  // So the name the panel showed when collecting started is stored beside the values, and a panel
  // that names anything else throws the whole lot away rather than contributing to it.
  let sip = { at: '', v: {} };
  const sipReset = () => { sip = { at: '', v: {} }; };
  const sipHas = () => {
    const nm = panelName();
    // No name to check against means no way to prove ownership, so nothing is served.
    return nm && sip.at && nm === sip.at ? sip.v : {};
  };
  function sipTake() {
    const nm = panelName();
    if (!nm) return;
    if (!sip.at) sip.at = nm;
    else if (nm !== sip.at) { sip = { at: nm, v: {} }; }   // the panel moved on; start again
    // `readDetail` with no href and no web text: those two produce their own fields from arguments
    // rather than from the page, and with nothing passed they come out empty and are skipped by the
    // truthiness test below. Everything else it returns is read from the panel as it stands now.
    const got = readDetail('', '', true);
    if (got) for (const [k, val] of Object.entries(got)) if (val && !sip.v[k]) sip.v[k] = val;
  }

  // Open one row and wait for the panel to be ABOUT THAT ROW.
  //
  // "Wait until the panel has content" is not the test and getting it wrong is silent: the
  // PREVIOUS record's panel also has content, so the read returns it and the row is filled
  // with its neighbour's address. Measured — three clicks returned the same business three
  // times, and the tell was the read time falling 368ms → 93ms → 52ms.
  //
  // Nor is a prefix match enough. This rail carries "Reliant Plumbing" and "Reliant
  // Plumbing - Austin" as adjacent cards, so matching on the first N characters accepts the
  // one already open. The test is the whole name, and failing that, that the name CHANGED.
  // HAS THE PAGE ARRIVED AT THE RECORD WE CLICKED?
  //
  // The first version compared the panel's own name to the card's, and that is the wrong
  // instrument twice over. It is a DISPLAY STRING — it differs by locale, by wording, by a
  // suffix the panel adds — and when it fails to match there is no signal at all, so every
  // record spent the full timeout and *then* returned nothing. Measured on a real machine:
  // **10-20 seconds per record**, which is what this cost before it was replaced.
  //
  // The record's link carries its ID (`!1s0x8644…:0x2685…`) and the address bar carries the
  // same one once the page has arrived. That is a machine-readable identity: no language in
  // it, nothing to nearly-match, and it cannot be satisfied by the record that was already
  // open. Measured: **319ms**.
  //
  // A list that has no such id falls back to the panel's name CHANGING, which is weaker but
  // still better than an equality test against a string we do not control.
  const idOfLink = (href) => (href.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i) || [])[1] || '';

  // BOTH SIGNALS, AND THE URL IS THE WEAKER ONE.
  //
  // `location.href` updating is not the panel updating, and the order between them is not
  // fixed — measured both ways round on the same site. So a URL-only test reports "arrived"
  // while the panel is still showing the record BEFORE this one, and the read silently
  // returns its neighbour's data.
  //
  // That is not hypothetical: in a real export, ADK Plumbing carried its OWN coordinates
  // (read from its own link, which cannot race) beside Roger's Plumbing's postal address and
  // phone number (read from a panel that had not caught up). One row behind, silently, on a
  // list of 122.
  //
  // So arrival is: the address bar names this record AND the panel is no longer showing the
  // last one. The second half is what makes it true rather than merely likely.
  async function openRow(link, wasMark) {
    const href = link.getAttribute('href') || '';
    const id = idOfLink(href);
    // ONE DEADLINE FOR THE WHOLE RECORD, set at the click. Every wait inside takes the earlier
    // of its own cap and this, so arriving slowly cannot buy the walk extra time and a walk
    // that runs long cannot leave the frame with none.
    const dead = performance.now() + RECORD_MS;
    // A NEW RECORD, so nothing the last one revealed may follow it. See `sipTake`.
    sipReset();
    try { link.click(); } catch (_) { return { got: null, rep: null }; }
    const until = Math.min(performance.now() + DETAIL_WAIT_MS, dead);
    let panel = null;
    while (performance.now() < until && !stopped()) {
      const urlOk = id ? location.href.includes(id) : true;
      const mark = panelMark();
      if (urlOk && mark && mark !== wasMark) { panel = panelOf(); break; }
      await nap(DETAIL_POLL_MS);
    }
    if (!panel) return { got: null, rep: null };
    // Only now walk it — the fields worth having are below the fold, and walking a panel
    // that is still showing the previous record would mount the wrong one's. Nothing moves on
    // to the next record until this resolves: the walk owns the record's page until it has
    // reached the bottom of it and read what is there.
    //
    // The walk's report comes back BESIDE the detail, not inside it — anything mixed into the
    // detail object becomes a column in the user's table.
    const rep = await walkPanel(panel, dead);
    return { got: readDetail(href, rep.web), rep };
  }

  // --- the same pass, WITHOUT WAITING IN THE PAGE ---------------------------------------
  //
  // WHY THIS EXISTS, and it is the whole bug: **a page in a background tab does not get its
  // timers.** Chrome clamps `setTimeout` in a hidden tab to one second, and once the tab has
  // been hidden for five minutes, INTENSIVE THROTTLING takes it to roughly once a MINUTE. The
  // loop above waits on `nap()` — a page timer — while measuring against wall-clock deadlines of
  // three, six and twelve seconds. Under a one-minute clamp the first wait of any record
  // overshoots every deadline it is measured against, so the record "never arrives", and after
  // `DETAIL_MISSES` of those the pass stops on purpose.
  //
  // Measured: a 1s clamp (an ordinary hidden tab) is survivable — 4 of 4 records, 15.1s against
  // 9.9s in front. A 60s clamp is not, and that is what "left it running while I watched a video
  // and came back to 3 of 120" was. Three is `DETAIL_MISSES`.
  //
  // The fix is not longer deadlines — under a one-minute clamp there is no deadline that is both
  // long enough and honest. It is to STOP WAITING IN THE PAGE. Each action below does one bounded
  // piece of DOM work and returns immediately; the worker does the waiting between them, and the
  // worker's clock is not the page's. `chrome.scripting.executeScript` runs when the worker asks,
  // whatever the tab's visibility, so a throttled page simply answers each call as it comes.
  //
  // These are the ONLY place the phases are implemented — `openRow`/`walkPanel` above are the
  // foreground path and both are driven from `openEach`. The rules they encode (arrival needs the
  // id AND a changed mark; the end of a page is bottom + no-growth + cannot-move, twice; a frame
  // is ready only when laid out and complete) live in the helpers both paths call, so there is
  // one definition of each rule and two callers.
  const bagOf = () => {
    const st = window[S];
    const c = st?.cands?.[st.i];
    // The one accessor every op goes through, so the one place worth re-attaching from. Without
    // it `hopFor(c.el)` bags a node that is no longer in the document and every answer built on
    // it describes the page before last. See `reattach`.
    if (c) reattach(c);
    return c ? { st, c, bag: hopFor(c.el, true) } : null;
  };

  // --- appending a second source into one column ---------------------------------------
  //
  // Used by `dputMany`'s `add` — see the note there for why the site pass appends instead of adding
  // columns of its own. The three rules that make a merged cell readable:
  //
  //   the same separator the table already uses    ` | `, as `@Web links` has since it was written
  //   the first value is never touched             whoever reads up to the first separator gets the
  //                                               canonical answer, which is what a formula does
  //   every list is capped                        an uncapped join turns one cell into a paragraph
  const ADD_JOIN = ' | ';
  const ADD_MARK = ' (site)';
  const unmark = (s) => String(s).replace(/ \(site\)$/, '');
  const ADD_CAP = {
    '@Phone (intl)': 3,
    '@Web links': 6,
    '@Category': 6,
    '@Services': 6,
    '@Full address': 2,
  };
  // WHAT COUNTS AS THE SAME VALUE, per kind — and each of these is a measured mistake, not a guess.
  //
  //   phone    `(512) 960-0044`, `+1 512-960-0044` and `5129600044` are ONE number, and comparing
  //            the strings says they are three. The last nine digits are the part that agrees:
  //            enough to identify a subscriber line, short enough to survive a country code being
  //            present on one and absent on the other.
  //   link     every Maps outbound link carries UTM parameters, and `site.com/?utm_source=google`
  //            was once counted as a different site from `site.com/page` (`MAPS-CHAIN.md`). Host
  //            plus path, `www.` and the query gone.
  //   words    a category or a service, compared on letters alone.
  //   address  the same address written two ways is noise; a genuinely different one is a second
  //            branch and worth keeping.
  const ADD_KEY = {
    '@Phone (intl)': (v) => String(v).replace(/\D/g, '').slice(-9),
    '@Web links': (v) => {
      try {
        const u = new URL(String(v).trim());
        return (u.host.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '')).toLowerCase();
      } catch (_) { return String(v).trim().toLowerCase(); }
    },
    '@Category': (v) => String(v).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(),
    // Same rule as `@Category` — what a site calls a service is compared on letters alone, so
    // "Water Heaters" and "water heaters" are one entry rather than two.
    '@Services': (v) => String(v).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(),
    '@Full address': (v) => String(v).toLowerCase().replace(/[^a-z0-9]/g, ''),
  };

  // KEEPING ANIMATION FRAMES COMING, WHICH IS THE ACTUAL BUG.
  //
  // A hidden tab does not run `requestAnimationFrame` AT ALL — not slowly, not eventually,
  // never. And Maps mounts a record's panel from a rAF callback. Measured, driving the pass from
  // the worker so the page was never asked to keep time:
  //
  //     nothing suppressed      →  3 of 3 panels arrived, first in 544ms
  //     timers clamped to 1s    →  3 of 3 arrived, first in 1069ms
  //     rAF never fires         →  0 of 3 arrived, after 33 SECONDS of asking
  //
  // That is why "left it running and came back to 3 of 120" happened within seconds of the tab
  // going to the background, far too soon for the five-minute throttling threshold. No amount of
  // patience helps a callback that is never called.
  //
  // So every rAF gets a TIMER AS A BACKSTOP while the pass runs — see `raf.js`, which holds the
  // wrapper and the reasoning. All this does is arm and disarm it.
  //
  // ARMING RATHER THAN INSTALLING, and that distinction is the fix. Installing the wrapper here
  // was tried and measured: **0 of 3, unchanged.** Maps takes its reference to
  // `requestAnimationFrame` when its bundle loads, so replacing the global afterwards is
  // invisible to it. The wrapper has to already exist when the page's code runs, which is why it
  // is a `document_start` content script and why this function can only switch it on.
  //
  // `absent` is a real answer and the caller reports it: a tab that was already open when the
  // extension was installed or updated has no wrapper until it is reloaded once.
  const RAF = '__holoscrapeFrames';

  // Arming and disarming both live in `raf.js` — arming has to revive the frame chains that died
  // while it was dormant, which only the wrapper can do because only it still holds their
  // callbacks. This just asks.
  function keepFrames(on) {
    const box = window[RAF];
    if (!box || typeof box.arm !== 'function') return 'absent';
    return on ? box.arm() : box.disarm();
  }

  // Everything the worker needs to know before it clicks anything: is there a list, is it a
  // feed, is the window wide enough, and is this a map we have a reader for.
  function detailGate() {
    const it = bagOf();
    if (!it) return { error: 'NOT_DETECTED' };
    recount(it.c);
    if (it.c.mode !== 'feed') {
      return { error: 'NOT_A_FEED', mode: it.c.mode || '', rows: it.c.rows.length };
    }
    const map = mapKind();
    if (!MAPPINGS.includes(map)) return { error: 'NO_MAPPING', map, rows: it.c.rows.length };
    if (innerWidth < DETAIL_MIN_WIDTH) {
      return { error: 'TOO_NARROW', width: innerWidth, need: DETAIL_MIN_WIDTH, rows: 0 };
    }
    // `width` on the way out too, not only when it is a complaint: the log is the only place
    // anybody can see what the layout actually was when a pass went wrong.
    return { rows: it.c.rows.length, map, done: it.bag.details.size,
      width: innerWidth, need: DETAIL_MIN_WIDTH, hidden: trueHidden() };
  }

  // Click row `i`. Returns what the worker needs to recognise the record when it lands — and
  // `already` for a row whose detail is in the bag from an earlier pass, which is not a failure.
  function detailClick(op) {
    const it = bagOf();
    if (!it) return { error: 'NOT_DETECTED' };
    // THE LIST THIS PASS BELONGS TO, or nothing. Below 1280px a click REPLACES the rail, and the
    // engine would then re-detect whatever list took its place — a "similar places" strip, a
    // hotels carousel — and go on opening records from that. Measured from a real run: a search
    // for restaurants came back holding hotels, with the rail gone from the screen entirely.
    //
    // So the pass is bound to the container it started on. The moment that element leaves the
    // document the pass is over; it does not go looking for a replacement.
    if (!it.c.el || !it.c.el.isConnected) return { listGone: true };
    recount(it.c);
    const r = it.c.rows[op.i];
    if (!r || !document.contains(r)) return { lost: true };
    const key = identOf(r);
    if (it.bag.details.has(key)) return { already: true, key };
    // A PLACE, not a search. See `RECORD_HREF`.
    const want = RECORD_HREF[mapKind()] || null;
    const link = recordLinkOf(r, want);
    if (!link) return { notRecord: true, key };
    const href = link.getAttribute('href') || '';
    const was = panelMark();
    // Live figures for the panel's sheet, same as the in-page loop keeps.
    it.st.detail = { at: op.i + 1, of: op.of || it.c.rows.length,
      opened: op.opened || 0, filled: op.filled || 0 };
    sipReset();
    try { link.click(); } catch (_) { return { lost: true }; }
    return { ok: true, key, href, id: idOfLink(href), wasMark: was };
  }

  // Has the page caught up with that click? Same two-part test as `openRow` — see there.
  //
  // It also reports whether THE LIST IS STILL THERE and whether the tab is being drawn, because
  // those are the two ways a pass dies quietly and the driver has to be able to tell them apart:
  // a rail that was replaced by a click is a different failure from a record that is slow.
  function detailMark(op) {
    const it = bagOf();
    const urlOk = op.id ? location.href.includes(op.id) : true;
    const mark = panelMark();
    const box = window[RAF];
    return {
      arrived: !!(urlOk && mark && mark !== op.wasMark),
      mark,
      listGone: !(it?.c?.el && it.c.el.isConnected),
      hidden: trueHidden(),
      frames: box ? (box.on ? 'armed' : 'off') : 'absent',
      backstopped: box?.backstopped || 0,
    };
  }

  // One scroll step of the record's page. The worker decides when to stop, using the same three
  // facts the in-page walk uses.
  function detailStep(op) {
    const panel = panelOf();
    if (!panel) return { gone: true };
    const sc = panelScroller(panel);
    if (!sc) return { noScroller: true, bottom: true };
    // BEFORE SCROLLING, NOT AFTER. What is on screen right now is what the PREVIOUS step brought
    // into view and gave time to render — this is the last moment it can be read. Scrolling first
    // and harvesting after would collect the new position before anything has mounted in it.
    // Every walk in the engine goes through this function, so both passes gain it here.
    sipTake();
    const at = sc.scrollTop;
    const was = sc.scrollHeight;
    sc.scrollTop = at + sc.clientHeight;
    // `grew` COMPARED ACROSS CALLS, NOT WITHIN ONE — and the difference decided a whole column.
    //
    // This used to be `sc.scrollHeight > was`, both read inside this function with only a scroll
    // assignment between them. Nothing can mount in that gap: a panel grows when Maps finishes a
    // fetch and renders a section, which happens during the caller's nap, not between two adjacent
    // statements. So `grew` was false essentially always, and the caller's "at the bottom, not
    // grown, not moved — twice" rule fired after about 140ms against a panel that was still being
    // built.
    //
    // On the rail pass that costs nothing: the app is already warm, so the panel is complete the
    // instant it appears and an early exit is at the real bottom. On a freshly loaded tab it is
    // fatal, because reaching the bottom is what makes Maps CREATE the web-results section —
    // measured on one run of 124: the rail pass got web results on 22 of 24 records, the lane pass
    // on 3 of 98.
    //
    // The caller passes the height it last saw. Absent that, fall back to the old within-call
    // comparison so a caller that does not track height still gets the previous behaviour.
    const before = op && op.height != null ? op.height : was;
    return { at: Math.round(sc.scrollTop), height: sc.scrollHeight,
      moved: sc.scrollTop !== at, grew: sc.scrollHeight > before, bottom: atEnd(sc) };
  }

  // The web-results frame, if it is finished. `ready` is the same three-part test as above.
  function detailWeb() {
    const panel = panelOf();
    if (!panel) return { gone: true, seen: false, ready: false, text: '' };
    const r = webFrameRead(panel);
    return { seen: r.has, ready: r.ready, text: r.ready ? r.text : '' };
  }

  // --- one record's panel, however you arrived at it ------------------------------------------
  //
  // Two paths reach a record now: NAVIGATE to its own URL in a cold tab (`dgrab`), or CLICK it in an
  // app that is already running (`dwarm`). Everything after the arrival is identical — the panel does
  // not care how it was opened — so arrival and the read live here once and both callers use them.
  // Two copies of the walk's stopping rule is how the two passes would come to disagree about what a
  // finished panel looks like, which is the same class of bug as the three copies of row identity.

  // HAS THE RIGHT RECORD ARRIVED. Three proofs, and each one has been earned:
  //
  //   the URL carries this place's id     `chrome.tabs.update` returns while the previous document is
  //                                      still there, and reading whatever panel is present is how
  //                                      five lanes wrote their first record 124 times over
  //   the panel names the row's place     the URL can be right while the panel still shows the last
  //                                      one, because Maps updates the address bar first
  //   the panel is a DIFFERENT panel      only after a click, where the old record's panel is valid
  //                                      markup for the wrong answer. Two rows can share a name — a
  //                                      chain with two branches — so the name test alone is not
  //                                      enough to prove the click landed.
  async function awaitRecord(op, capArrive, since) {
    const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    for (;;) {
      const urlOk = !op.token || location.href.indexOf(op.token) >= 0;
      const mark = panelMark();
      const fresh = op.wasMark == null || (mark && mark !== op.wasMark);
      const panel = urlOk && fresh ? panelOf() : null;
      if (panel) {
        const nm = panelName();
        if (!op.name || !nm || flat(nm) === flat(op.name)) return { ok: true };
      }
      if (since() > capArrive) {
        // WHAT THE PAGE ACTUALLY WAS, not just that it disappointed us.
        //
        // The first version said only "the panel never named this record", which covers two very
        // different failures — no panel at all, or a panel naming somebody else — and reported the
        // name we WANTED rather than the one we found. Seventeen records failed that way at the end
        // of a 124-record pass and the log could not tell a rate-limit wall from a name mismatch.
        const mains = document.querySelectorAll('[role="main"]').length;
        const txt = (document.body?.innerText || '').slice(0, 400);
        const wall = /unusual traffic|not a robot|Before you continue|consent\.google|try again later/i
          .test(txt) || /\/sorry\/|consent\.google/.test(location.href);
        return { ok: false, ready: false, ms: since(),
          saw: panelName(), wanted: op.name || '', mains, wall,
          title: (document.title || '').slice(0, 60),
          len: (document.body?.innerText || '').length,
          why: !urlOk ? 'the tab never reached this record'
            : wall ? 'the site asked for verification'
              : !fresh ? 'the panel never changed after the click'
                : !panel ? `no panel drew (${mains} mains, ${(document.body?.innerText || '').length} chars)`
                  : `the panel says "${panelName()}"` };
      }
      await nap(RECORD_POLL_MS);
    }
  }

  // THE WALK AND THE WEBSITE BLOCK, AT THE SAME TIME.
  //
  // These ran one after the other, and nothing required that. The walk scrolls the panel to bring the
  // below-the-fold fields in — plus code, reviews, topics. The website block is a separate fetch Maps
  // makes on its own schedule, and scrolling neither starts nor hurries it. Sequenced, a record paid up
  // to 2.5s of walking THEN up to 3s of waiting; overlapped it pays the longer of the two.
  // How long to wait for the web-results section to APPEAR after the walk has finished. Separate
  // from `capWeb`, which is how long to wait for it to LOAD once it is there.
  const WEB_APPEAR_MS = 2500;

  // `capWeb <= 0` MEANS DO NOT WAIT FOR IT — but still take it if it happens to be there.
  //
  // The frame is the most expensive thing a record waits for and the least reliable. Measured on one
  // real run of 120: the 22 records that came back WITHOUT it averaged 17.7s against 10.5s for the
  // ones that got it. A success exits the instant the frame reads, so almost the whole cost of this
  // wait lands on the records it fails to serve.
  //
  // So the wait is separable from the read. With no budget the walk still happens — the fields below
  // the fold are the reason it exists — and the frame is read once at the end, free, if Maps happened
  // to have loaded it while we were scrolling past. That is the column at whatever it costs nothing.
  async function walkWeb(capWalk, capWeb) {
    let walkEnd = 0;
    let still = 0;
    let steps = 0;
    let web = '';
    let seen = false;
    let webDone = capWeb <= 0;
    let walkDone = false;
    let tall = 0;              // the panel's height as of the last step — see `detailStep`
    const w0 = performance.now();
    for (;;) {
      const t = performance.now() - w0;
      if (!webDone) {
        const w = detailWeb();
        seen = seen || !!w.seen;
        if (w.ready) { web = w.text || ''; webDone = true; }
        else if (w.gone) webDone = true;
        // THE WEB CLOCK CANNOT START BEFORE THE WALK HAS FINISHED.
        //
        // Maps creates the results frame as the section SCROLLS INTO VIEW — see `awaitWebFrame`,
        // which measured exactly this. The walk is therefore the mechanism and this wait is only the
        // safety net. Timing the net against the whole record meant that on any panel needing more
        // than the web cap to scroll, the wait expired BEFORE the frame it waits for could be
        // created: guaranteed failure, and it emptied the column on all 124 records of one run.
        else if (walkDone) {
          const after = t - walkEnd;
          // 1200ms WAS TOO SHORT, AND IT IS THE MEASURED DIFFERENCE BETWEEN THE TWO PASSES.
          //
          // This is the grace for the section to EXIST at all. On one run of 120 places the lane
          // pass came back with web results on 35 of 98 while the rail hand-over had them on 22 of
          // 22 — and the rail's own wait is twenty `dweb` calls, each a whole engine injection, so
          // it is patient by accident where this is impatient on purpose. The frame is a separate
          // request to `google.com/search` made only once the section is in view, and on a tab that
          // is a cold Maps boot with four siblings competing it does not answer in 1200ms.
          //
          // It costs nothing when the section genuinely is not there: a place with no web results
          // pays this once, at the end, and the walk has already finished.
          // THE GRACE CANNOT OUTLAST THE BUDGET. `WEB_APPEAR_MS` is the wait for the section to
          // EXIST, and it was a flat 2500ms regardless of `capWeb` — so a caller that cut the web
          // budget to a probe still paid two and a half seconds on every record whose section was
          // never there, which is precisely the population the cut exists to stop paying for.
          // Whichever is smaller: a caller asking for 400ms means 400ms.
          if (!seen && after > Math.min(WEB_APPEAR_MS, capWeb)) webDone = true;
          else if (after > capWeb) webDone = true;       // there, but never finished loading
        } else if (t > capWeb) webDone = true;
      }
      if (!walkDone) {
        if (t > capWalk) walkDone = true;
        else {
          // The height from the PREVIOUS step, so growth is measured across the nap — which is when
          // a panel actually grows. See the note in `detailStep`.
          const st = detailStep({ height: tall });
          steps++;
          if (st.height != null) tall = st.height;
          if (st.gone) walkDone = true;
          // QUIET FOR `WEB_WALK_STILL` STEPS, NOT TWO — see its note.
          else if (st.bottom && !st.grew && !st.moved) { if (++still >= WEB_WALK_STILL) walkDone = true; }
          else still = 0;
        }
        if (walkDone) walkEnd = t;
      }
      if (walkDone && webDone) break;
      await nap(WALK_WEB_TICK_MS);   // 70 rather than 90 — see its note
    }
    // ONE FREE LOOK, when the wait was skipped. The walk has just scrolled past the section, so if
    // Maps had already loaded the frame it is sitting there readable and costs a single DOM read to
    // take. Nothing is waited for and nothing is retried — this is the column at zero price.
    if (capWeb <= 0) {
      const w = detailWeb();
      seen = !!w.seen;
      if (w.ready) web = w.text || '';
    }
    return { web, steps, seen };
  }

  // Read the record and keep it. The scroll goes back to the top here rather than in the walk,
  // because with the walk driven from outside there is no single place that owns "afterwards".
  function detailRead(op) {
    const it = bagOf();
    if (!it) return { error: 'NOT_DETECTED' };
    const panel = panelOf();
    const got = readDetail(op.href || '', op.web || '');
    if (panel) {
      const sc = panelScroller(panel);
      if (sc) { try { sc.scrollTop = 0; } catch (_) {} }
    }
    if (!got || !op.key) return { got: false };
    it.bag.details.set(op.key, got);
    // The list's own URL has moved to the record just opened; say that this is still the page
    // these candidates describe, or `stamp()` throws the state away on the next call.
    it.st.href = here();
    // HOW MUCH PAGE THERE WAS TO READ, carried out beside the count of what was read.
    //
    // A rail hand-over returned 6-8 fields a record on one run where the lane pass returned 17-20
    // on the same places, and `fields` alone cannot say whose fault that is: a panel that never
    // mounted its reviews and a reader that failed to find them produce the identical number.
    // Three hypotheses were argued from that number and all three were refuted by measurement.
    // `len` settles it without another guess — a thin record on a long panel is ours, a thin record
    // on a short one is Google's, and the log can now tell them apart on the run that happens.
    return { got: true, fields: Object.keys(got).length, web: !!got['@Web results'],
      len: panel ? (panel.innerText || '').length : 0 };
  }

  // The pass is over: clear the live figures and re-stamp.
  function detailDone() {
    const st = window[S];
    if (st) { st.detail = null; st.href = here(); }
    const it = bagOf();
    // THE RAIL'S OWN COUNTERS, because the run summary was asking for them and getting nothing.
    // `note('details.done', …)` reads `end?.backstopped`, `end?.revived`, `end?.hidden` off this
    // return, and this returned two fields — so every run in the log ended
    // `backstopped=undefined revived=undefined hidden=undefined`, which is three of the four
    // numbers needed to tell a walled rail from a broken one.
    //
    // `revived` never existed anywhere in this file; the logger invented it. `frames` is the
    // honest version of that question — whether the keeper was armed at the end — and the caller
    // already sets it from `keepFrames(false)`, so the phantom is dropped rather than faked.
    const box = window[RAF];
    return { rows: it ? it.c.rows.length : 0, done: it ? it.bag.details.size : 0,
      backstopped: box?.backstopped || 0, keeper: !!box?.on, hidden: trueHidden() };
  }

  async function openEach(op) {
    const st = window[S];
    const c = st?.cands?.[st.i];
    if (!c) return { error: 'NOT_DETECTED' };
    recount(c);
    // ONLY A DECLARED FEED, and this is a safety gate rather than a fussy one. Clicking a
    // row's own link is harmless on a page that swaps its content in place and catastrophic
    // on one that does not: an ordinary product grid would NAVIGATE, taking the list, the
    // rows already gathered and the trip home with it — on the first row.
    //
    // `role="feed"` is the page stating that it holds dynamically loaded articles, which is
    // exactly the property this needs, and it is the same declaration `rowsOf` already
    // takes at its word. A page that has not said so does not get clicked.
    if (c.mode !== 'feed') {
      return { error: 'NOT_A_FEED', mode: c.mode || '', opened: 0, rows: c.rows.length };
    }
    // AND ONLY A MAP WE HAVE A MAPPING FOR. The reader below is Google's, field for field, and
    // there is no honest generic version of it — see `MAPS`. On any other feed this would click
    // its way down someone's list and fill nothing, which reads as a broken tool rather than as
    // an unsupported page.
    const kind = mapKind();
    if (!MAPPINGS.includes(kind)) {
      return { error: 'NO_MAPPING', map: kind, opened: 0, rows: c.rows.length };
    }
    // Refused rather than attempted: at this width the click takes the list away, and a
    // pass that destroys the thing it is reading is worse than one that does not run.
    if (innerWidth < DETAIL_MIN_WIDTH) {
      return { error: 'TOO_NARROW', width: innerWidth, need: DETAIL_MIN_WIDTH, opened: 0, rows: 0 };
    }
    const bag = hopFor(c.el, true);
    const rows = c.rows;
    const max = op.limit > 0 ? Math.min(op.limit, rows.length) : rows.length;
    let opened = 0;
    let filled = 0;
    let lost = 0;
    let miss = 0;      // in a row — see DETAIL_MISSES
    // Whether the web-results section EXISTED on a record, apart from whether it was read.
    // The section is optional — measured, it is on some records and absent on others — so
    // "no row carried one" is only a failure when one was there to carry. Without these two
    // counts apart, a test for it passes or fails on which five records the rail happened to
    // put first.
    let webSeen = 0;
    let webRead = 0;
    // Records whose walk ran out of clock before reaching the bottom of the page. These are
    // the ones whose thin data is OUR fault rather than the record's, and counting them is
    // what tells a page that simply has no web-results section from a walk that never got far
    // enough to draw one — the exact confusion that hid this bug behind a "longer wait".
    let walkShort = 0;
    let why = '';
    let was = panelMark();

    for (let i = 0; i < max; i++) {
      if (stopped()) break;
      // Re-read the row list every time. Opening a record can re-render the list, and an
      // element captured before the first click may not be in the document any more.
      recount(c);
      const r = c.rows[i];
      if (!r || !document.contains(r)) { lost++; continue; }
      const key = identOf(r);
      if (bag.details.has(key)) continue;   // already opened, in this run or an earlier one
      const link = recordLinkOf(r);
      if (!link) { lost++; continue; }

      st.detail = { at: i + 1, of: max, opened, filled };   // live, for the panel's poll
      const { got, rep } = await openRow(link, was);
      opened++;
      if (rep) {
        if (!rep.bottom) walkShort++;
        // Counted from the WALK, which watched the frame while it was at the bottom — not from
        // a look at the panel afterwards. The old count asked "is there a frame in the
        // document now", which said yes on every record and meant nothing.
        if (rep.seen) webSeen++;
      }
      if (got) {
        bag.details.set(key, got);
        filled++;
        miss = 0;
        was = panelMark();
        if (got['@Web results']) webRead++;
      } else if (++miss >= DETAIL_MISSES) {
        // Not slow — not working. Whatever this page does, it is not opening its records
        // where we are looking, and the honest move is to stop and say so rather than prove
        // it another ninety times at three seconds each.
        why = `${miss} records in a row did not open`;
        break;
      }
      if (i + 1 < max && !stopped()) await nap(detailPace());
    }
    st.detail = null;
    // The list is the same list — the same element, the same rows — but the page's own URL
    // has moved to the record last opened. `stamp()` reads a changed path as a different
    // page and would throw this state away on the very next call, taking every row with it.
    // Re-stamping says what is true: this is still the page these candidates describe.
    st.href = here();
    return { opened, filled, lost, why, webSeen, webRead, walkShort, map: kind,
      rows: rows.length, stopped: stopped() };
  }

