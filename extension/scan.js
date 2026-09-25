// HoloScrape scan engine.
// Runs inside the page's own JS world. Must stay fully self-contained:
// chrome.scripting.executeScript serialises this function to source.

export async function pageScan(opts) {
  const log = [];
  const found = new Map();
  let blobHits = 0; // media delivered as blob: — counted so a zero can explain itself
  let staleHits = 0; // assets held over from a route we have already left
  let screens = 0;  // how far the deep scan actually walked, reported as coverage
  let stopped = ''; // and why it stopped, so a bounded walk never reads as complete
  const wireSize = new Map(); // url -> bytes, for spotting beacons by weight

  // --- named values -------------------------------------------------------------------------------
  // INSIDE the function on purpose: `pageScan` is serialised to source and run in the page, so
  // nothing outside its body — no import, no module-level const — exists where it runs. Every
  // decision below therefore lives here rather than in tuning.js.
  //
  // Text clipped for a title or a label carried back in a result — long enough to recognise a
  // track or a product by, short enough that a thousand of them is a table and not a document.
  const TEXT_CLIP_CHARS = 140;
  // How much taller than its box an element has to be before it counts as scrolling at all; a
  // few pixels of overflow is a border, not a scroller.
  const SCROLL_SLACK_PX = 40;
  // Bounds on tree sweeps, so a huge DOM cannot turn a lookup into a full-tree scan: blocks
  // looked at when hunting the tallest scrollable region, and controls looked at when hunting a
  // load-more button (a page with 700 controls spends the budget on links otherwise).
  const SCROLLER_SWEEP_MAX = 400;
  const CONTROL_SWEEP_MAX = 4000;
  // The resource-timing log's ceiling — more assets than any real page has, so a runaway feed
  // cannot grow it without bound.
  const RESOURCE_LOG_MAX = 3000;
  // The smallest on-screen area (px²) an <img> may have and still be offered as a row's preview:
  // an icon is not a preview.
  const PREVIEW_MIN_AREA_PX = 2500;
  // Size classes for pictures, by width in CSS pixels. Below TINY is a spacer or a favicon; below
  // SMALL is a thumbnail or an icon; at or above LARGE is a full-size photo. Applied once when an
  // asset is first seen and again when a variant is chosen, so the two must be the same numbers.
  const TINY_MAX_W = 64;
  const SMALL_MAX_W = 240;
  const LARGE_MIN_W = 1200;
  // An <img> narrower than this, by its own decoded width, is a tracking pixel or a spacer.
  const SPACER_MAX_W = 32;
  // An image that weighs less than this on the wire is a beacon, whatever its url says.
  const TRACKER_MAX_BYTES = 512;
  // Media shorter than this many seconds is a clip or a sample, tagged so a filter can skip it.
  const SHORT_MEDIA_S = 30;
  //
  // The lazy-load walk. How many screens it scrolls and how long it pauses on each when the
  // caller does not say, how many quiet screens count as the end (high enough to wait out a slow
  // feed), and the overall budget: derived from steps x pause with slack rather than a flat
  // minute, because at 220 screens x 550 ms a 60 s ceiling cut the walk at less than half its
  // screens and reported "timed out", so it could never do what it said. Bounded both ways.
  const SCROLL_STEPS_DEFAULT = 60;
  const SCROLL_PAUSE_DEFAULT_MS = 320;
  const DRY_SCREENS_DEFAULT = 4;
  const WALK_BUDGET_SLACK = 1.5;
  const WALK_BUDGET_MIN_MS = 30000;
  const WALK_BUDGET_MAX_MS = 150000;
  // Each step moves this share of a screen (the rest is overlap, so nothing mounts between two
  // reads unseen), and never less than this many pixels on a tiny viewport.
  const SCREEN_STEP_SHARE = 0.8;
  const SCREEN_STEP_MIN_PX = 200;
  // A beat after the first seek before the walk starts reading, and one at the end before the
  // scroll position is handed back, so the page has repainted where it was left.
  const SEEK_SETTLE_MS = 220;
  const RESTORE_SETTLE_MS = 250;
  // At the bottom of a feed: how long to give it to append more, and how many bottoms in a row
  // with the same height before the page is called finished.
  const FEED_APPEND_BEAT_MS = 700;
  const STILL_SCREENS_END = 2;
  // Waiting on the page's own requests: how often `awaitNet` re-checks the in-flight count, the
  // most a screen waits for the batch it asked for, and the most a load-more press waits for
  // what the press asked for (a press is rarer and worth more than a scroll).
  const NET_POLL_MS = 120;
  const SCREEN_NET_CAP_MS = 8000;
  const PRESS_NET_CAP_MS = 9000;
  // After a load-more press, at least this long before anything else — a press whose fetch was
  // slower than one pause used to be scrolled straight past, which looks exactly like the click
  // not happening.
  const PRESS_SETTLE_MIN_MS = 900;
  // Load-more presses per walk when the caller does not say.
  const MORE_CLICKS_DEFAULT = 5;
  // A load-more control is WITHIN REACH when it is on screen or within this many screens below,
  // or no further than this many pixels above the top — a control mid-page above a tall footer
  // was walked straight past and only pressed once the document ran out.
  const REACH_SCREENS_BELOW = 1.2;
  const REACH_PX_ABOVE = 100;
  // The row engine's walk marker carries its own ttl; this is the fallback when it does not, and
  // only guards against a worker evicted between set and clear.
  const WALK_TTL_DEFAULT_MS = 60000;
  //
  // Peeking at players. How often to look for the url a click produced, the grace after the first
  // url lands for the siblings a player prefetches alongside it, the sweep for stragglers after
  // the last row, and the second sweep only a page with a real player pays for — a player needs a
  // beat after the click before it requests its manifest, so a single sweep routinely misses it.
  const PEEK_POLL_MS = 15;
  const PEEK_GRACE_MS = 40;
  const PEEK_SWEEP_MS = 400;
  const PEEK_PLAYER_SWEEP_MS = 1200;
  const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|m4b|aac|flac|opus|aiff?|wma|amr|midi?|ape|wv)(\?|$)/i;
  const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi|flv|m4v|ogv|3gp|3g2|wmv|mpe?g|mts|m2ts|asf|vob|divx)(\?|$)/i;
  // `.image` is the ByteDance CDN convention (Tokopedia, TikTok, Lark all serve
  // `…~tplv-<key>-image.image`). Without it every product photo on those sites
  // reads as extensionless and gets mistaken for a beacon.
  const IMG_EXT = /\.(jpe?g|jfif|png|apng|gif|webp|avif|svgz?|bmp|ico|cur|tiff?|heic|heif|jxl|image)(\?|$)/i;
  // A manifest is not a file. It is a text index pointing at thousands of
  // segments, and saving it gets you 2KB of playlist. It earns its own type so
  // the UI can never offer it as if it were a download.
  const STREAM_EXT = /\.(m3u8?|mpd|ism|ismc|f4m)(\?|$)/i;
  const SUB_EXT = /\.(vtt|srt|ttml|dfxp|ass|ssa|sbv|sub)(\?|$)/i;
  // Beacons, not assets. Matched on host and on the handful of path shapes the
  // whole ad industry shares, so a new vendor is usually caught by the second.
  // Grouped the way EasyPrivacy groups them, because the categories behave
  // differently: ad exchanges rotate domains constantly, analytics and session
  // replay vendors almost never do.
  const TRACKER_HOST = new RegExp('(^|//|\\.)(' + [
    // analytics & tag managers
    'google-analytics\\.com', 'googletagmanager\\.com', 'analytics\\.[a-z]+', 'segment\\.(io|com)',
    'mixpanel\\.com', 'amplitude\\.com', 'heap(analytics)?\\.com', 'matomo\\.(org|cloud)',
    'statcounter\\.com', 'chartbeat\\.com', 'parsely\\.com', 'comscore\\.com', 'scorecardresearch\\.com',
    'quantserve\\.com', 'nielsen\\.com', 'branch\\.io', 'appsflyer\\.com', 'adjust\\.com',
    // advertising & exchanges
    'doubleclick\\.net', 'googlesyndication\\.com', 'googleadservices\\.com', 'adservice\\.google\\.[a-z.]+',
    '2mdn\\.net', 'adsrvr\\.org', 'adnxs\\.com', 'rubiconproject\\.com', 'pubmatic\\.com',
    'casalemedia\\.com', 'openx\\.net', 'adform\\.net', 'smartadserver\\.com', 'indexww\\.com',
    'sharethrough\\.com', 'triplelift\\.com', '33across\\.com', 'id5-sync\\.com', 'liveramp\\.com',
    'rlcdn\\.com', 'bluekai\\.com', 'krxd\\.net', 'agkn\\.com', 'mathtag\\.com', 'bidswitch\\.net',
    'adsymptotic\\.com', 'everesttech\\.net', 'serving-sys\\.com', 'flashtalking\\.com',
    'udmserve\\.net', 'clickagy\\.com', 'tapad\\.com', 'exelator\\.com', 'criteo\\.(com|net)',
    'taboola\\.com', 'outbrain\\.com', 'bat\\.bing\\.com', 'ads\\.linkedin\\.com',
    // session replay & heatmaps — record what you do, not just that you came
    'hotjar\\.(com|io)', 'clarity\\.ms', 'fullstory\\.com', 'mouseflow\\.com', 'smartlook\\.com',
    'logrocket\\.(com|io)', 'inspectlet\\.com', 'luckyorange\\.com', 'crazyegg\\.com',
    'quantummetric\\.com', 'glassbox\\.com', 'contentsquare\\.(com|net)',
    // social & error reporting
    'connect\\.facebook\\.net', 'facebook\\.com/tr', 'analytics\\.tiktok\\.com', 'sc-static\\.net',
    'sentry\\.io', 'newrelic\\.com', 'bugsnag\\.com',
  ].join('|') + ')', 'i');
  // Deliberately NOT matching bare "track": /track/1234/song.mp3 is a real file
  // on every music site, and a false positive here hides a real asset.
  // Shapes rather than names, so a vendor that changes domain is still caught.
  // Cookie-sync endpoints are the big family: an ad exchange redirects you
  // through a chain of partners, each dropping a pixel to trade user IDs.
  const TRACKER_PATH = new RegExp([
    '/(ga-audiences|collect|beacon|impression|telemetry|action/0|__utm|tracking|tracker)\\b',
    '/(pixel|pxl|px)\\b',
    '[/_-]sync(\\b|/)',            // channel-sync, usersync, cookie-sync, idsync
    '/(setuid|getuid|usermatch|cksync|dmp|rtb)\\b',
    '\\.(pix|gif)\\?.*[?&](id|uid|cb|rnd|r)=',   // cache-busted gif with an id
    '[?&](rtbh?|bidder|partnerid|partneruserid|us_privacy|gdpr_consent|gdpr_pd)=',
  ].join('|'), 'i');
  const PDF_EXT = /\.pdf(\?|$)/i;
  const DOC_EXT = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|epub|mobi)(\?|$)/i;
  const FILE_EXT = /\.(zip|rar|7z|tar|t?gz|bz2|xz|iso|dmg|pkg|apk|exe|msi|deb|rpm)(\?|$)/i;

  // Order matters: a manifest is checked before anything else, so it can never
  // be mistaken for the media it indexes.
  // Deliberately ABSENT: json, xml, txt, js, css, html, and .ts — those are API
  // and infrastructure traffic, not assets, and matching them turns every scan
  // into a network log. (.ts is doubly bad: TypeScript source and HLS segment
  // share the extension.)
  const KINDS = [
    [STREAM_EXT, 'stream'], [AUDIO_EXT, 'audio'], [VIDEO_EXT, 'video'], [IMG_EXT, 'image'],
    [SUB_EXT, 'subtitle'], [PDF_EXT, 'pdf'], [DOC_EXT, 'doc'], [FILE_EXT, 'file'],
  ];

  // Only click things that plausibly reveal media. An ALLOWLIST, because a
  // denylist can never be complete — that is how an Upload modal got opened.
  // NOTE: "download" is deliberately absent. Pressing a download button performs
  // the download and fires the site's attribution modal — that is an action, not
  // a peek. Opt in with opts.clickDownloads if you really want it.
  const WANT_TEXT = opts.clickDownloads
    ? /\b(play|preview|listen|audition|sample|hear|download)\b/i
    : /\b(play|preview|listen|audition|sample|hear)\b/i;
  const WANT_CLASS = opts.clickDownloads
    ? /^(play|preview|listen|audition|sample|audio|download)$/
    : /^(play|preview|listen|audition|sample|audio)$/;
  // Second gate: even if it looks like a play button, never touch these.
  const NEVER = /\b(upload|sign ?in|sign ?up|log ?in|log ?out|sign ?out|register|subscribe|delete|remove|buy|purchase|checkout|pay|order|send|submit|cancel|unfollow|unsubscribe|report|block|confirm|deactivate|archive|settings|account|profile|cart|invite|share|publish|post|donate|follow|license|certificate|save)\b/i;

  // The same flag the row engine reads, hoisted to the top of the scan because the
  // media phase needs it too. It used to be read only inside the scroll walk, so a
  // Stop pressed while the panel said "Opening media…" bought nothing: this phase
  // clicks up to 120 triggers at 200ms apiece and then sweeps twice, and none of it
  // asked. That is where "Finishing the current step" came to mean half a minute.
  const halted = () => !!window.__holoscrapeStop;
  // Live progress, published on the page rather than returned at the end. Both engines
  // run in the MAIN world of the same page, so the row engine's `progress` action can
  // read this and the panel gets one poll for the whole scan. Without it the media
  // phase was a minute of an unmoving sheet: the numbers it reports — rows, hops — do
  // not exist yet, and "how much of this is left" had no answer at all.
  const SCANST = '__holoscrapeScan';
  const mark = (p) => { window[SCANST] = { ...(window[SCANST] || {}), ...p }; };
  mark({ phase: 'reading', walked: 0, screens: 0, clicked: 0, triggers: 0, files: 0, at: Date.now() });
  // Sliced so a stop is felt inside a wait, not only between two of them.
  // Interruptible, and — while the frame keeper is armed — also resolvable by the service
  // worker's pump, whose clock a hidden tab cannot slow. Without that second path the asset
  // walk dies of clamped timers the moment the user alt-tabs: this is the same fix `nap()` in
  // rows.js carries, duplicated because the engines are serialised into the page separately.
  const sleep = (ms) => new Promise((r) => {
    const t0 = Date.now();
    let done = false;
    const fin = () => { if (done) return; done = true; clearInterval(tick); r(); };
    const tick = setInterval(() => {
      if (Date.now() - t0 >= ms || halted()) fin();
    }, Math.min(60, Math.max(15, ms)));
    const box = window['__holoscrapeFrames'];
    if (box?.on && typeof box.wait === 'function') box.wait(ms).then(fin);
  });

  // Which element the wheel actually moves. Returns null when it is the document,
  // which is the common case and needs no work.
  //
  // Found from the middle of the viewport outwards rather than by searching the
  // whole tree: whatever is under the centre of the screen is the content, and the
  // first scrollable thing above it is what carries that content. That is one
  // elementFromPoint plus a walk up a handful of parents, on any size of page.
  const scrolls = (el) => {
    if (!el || el === document.documentElement || el === document.body) return false;
    if (el.scrollHeight <= el.clientHeight + SCROLL_SLACK_PX) return false;
    const ov = getComputedStyle(el).overflowY;
    return ov === 'auto' || ov === 'scroll' || ov === 'overlay';
  };

  function findScroller() {
    const de = document.documentElement;
    if (de.scrollHeight > de.clientHeight + SCROLL_SLACK_PX) return null; // the document scrolls
    try {
      const mid = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
      for (let n = mid; n && n !== de; n = n.parentElement) if (scrolls(n)) return n;
      // Nothing under the centre — an empty shell, or content off to one side.
      // Fall back to the tallest scrollable block, bounded (SCROLLER_SWEEP_MAX) so a
      // huge DOM cannot turn this into a full-tree scan.
      let best = null, looked = 0;
      for (const n of document.body.querySelectorAll('div, main, section, ul, [role="main"], [role="feed"]')) {
        if (++looked > SCROLLER_SWEEP_MAX) break;
        if (scrolls(n) && (!best || n.clientHeight > best.clientHeight)) best = n;
      }
      return best;
    } catch (_) { return null; }
  }

  // Embedded players (Vimeo, Brightcove, JW, Kaltura) live in a cross-origin
  // iframe with its own resource-timing buffer, so a top-frame-only scan cannot
  // see them at all. We now run in every frame — but a subframe is someone
  // else's document, and an ad frame with a "Play" label must not be clicked on
  // our account. So a guest frame only earns the click phase if it actually
  // hosts media. Reading is always safe; clicking has to be justified.
  // A client-side route change does not create a new document, so the resource
  // timing buffer keeps everything the previous route fetched. Without this, an
  // SPA reports the last page's audio as if it belonged to this one.
  //
  // The marker has to be stamped when navigation happens, not when the scan
  // runs — stamping it at scan time would exclude the current route's own files.
  // Installed once and left in the page; our later injections share the document.
  if (!window.__holoscrapeNav) {
    window.__holoscrapeNav = { href: location.href, at: 0, scannedAt: 0 };
    const n = window.__holoscrapeNav;
    const mark = () => {
      if (location.href === n.href) return;
      n.href = location.href;
      n.at = performance.now();
    };
    // Wrapping history.pushState is not enough on its own, and this is the bug
    // that made Envato hand back a graphics page's images on an audio page:
    // Next.js captures history.pushState at bundle init, so the router calls a
    // reference taken long before any extension could wrap it. Our wrapper never
    // ran, `at` stayed 0, and every hold-over from the last route passed through.
    //
    // So the URL itself is watched instead of the call that changed it. The
    // wrappers and the events stay because they react instantly; the poll is the
    // one that cannot be bypassed, whatever the router does — a saved reference,
    // the Navigation API, or anything else.
    for (const k of ['pushState', 'replaceState']) {
      const orig = history[k];
      history[k] = function (...a) { const r = orig.apply(this, a); setTimeout(mark, 0); return r; };
    }
    window.addEventListener('popstate', () => setTimeout(mark, 0));
    window.addEventListener('hashchange', mark);
    try { navigation.addEventListener('navigate', () => setTimeout(mark, 0)); } catch (_) {}

    // The resource-timing buffer holds 250 entries and then silently drops
    // everything after. An asset grid passes 250 in the first few screens, so on
    // exactly the pages this tool is for, the log we read was a truncated
    // prefix — assets went missing, and hold-overs from the previous route kept
    // their cover because there was no entry left to date them by.
    // A PerformanceObserver is not subject to the cap. `buffered: true` replays
    // whatever the buffer still holds at the moment we install it.
    //
    // Capped, and holding three numbers per URL rather than the entry object:
    // this lives in the page for as long as the tab does, so it has to have a
    // ceiling. 3000 is more assets than any real page has.
    n.seen = new Map();
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (n.seen.size >= RESOURCE_LOG_MAX || n.seen.has(e.name)) continue;
          n.seen.set(e.name, { t: e.startTime, it: e.initiatorType, sz: e.encodedBodySize });
        }
      }).observe({ type: 'resource', buffered: true });
    } catch (_) { /* the live buffer below is the fallback */ }
  }

  // A router that calls a saved reference to pushState fires none of the events
  // above, so the URL still has to be checked directly — but not on a timer.
  // An interval here runs in every frame of every page ever scanned, for as long
  // as the tab lives, and costs more than it is worth: the panel already rescans
  // every couple of seconds, so checking once per scan is the same signal at
  // none of the cost.
  //
  // When the change is caught this way we cannot know exactly when it happened,
  // so the boundary is the previous scan: everything fetched before then, on the
  // route we have since left, is old. The panel's cadence keeps that tight.
  if (window.__holoscrapeNav.href !== location.href) {
    window.__holoscrapeNav.href = location.href;
    window.__holoscrapeNav.at = window.__holoscrapeNav.scannedAt || performance.now();
  }

  // Everything the page has fetched, as far as we can know it: the observer's
  // record first, then the live buffer for anything logged in the moment before
  // its callback ran.
  function resourceLog() {
    const out = new Map(window.__holoscrapeNav.seen || []);
    try {
      for (const e of performance.getEntriesByType('resource')) {
        if (!out.has(e.name)) out.set(e.name, { t: e.startTime, it: e.initiatorType, sz: e.encodedBodySize });
      }
    } catch (_) {}
    return out;
  }
  const nav = window.__holoscrapeNav;
  const since = nav.at;
  // Stamped at the END of the scan, so the next one can use it as the boundary
  // for a route change no event announced.
  const stampScan = () => { nav.scannedAt = performance.now(); nav.href = location.href; };

  // When each URL was first fetched, captured BEFORE the scan does anything, so
  // a deep scan's own finds are never in it. Filtering the resource log by
  // `since` was only half the job: an SPA that caches the route you came from
  // keeps its <img> elements in the document — Next.js hides them rather than
  // unmounting them — so the DOM walk kept handing back the previous page's
  // pictures with no network entry left to disqualify them.
  const fetchedAt = new Map();
  for (const [name, e] of resourceLog()) fetchedAt.set(name, e.t);

  // Does this element occupy space in the page as it stands now?
  // <source>/<track>/<link> never have a box of their own, so the parent answers
  // for them. Asking the parent for an <img> would defeat the whole check: a
  // display:none image sits inside a <body> that is very much rendered.
  const BOXLESS = /^(SOURCE|TRACK|LINK|META|SCRIPT)$/;
  const rendered = (el) => {
    if (!el) return false;
    const box = BOXLESS.test(el.tagName || '') ? el.parentElement : el;
    return !!box?.getClientRects?.().length;
  };

  // Belongs to a route we have already left: fetched before the last client-side
  // navigation AND no longer shown. Both halves are required — a header logo
  // predates the route change too, but it is still on the screen, so it is still
  // part of this page. On a page that never route-changed, `since` is 0 and this
  // rule is inert, which keeps hidden-media detection working as before.
  const staleRoute = (abs, el) => {
    if (!since || !el) return false;
    if (rendered(el)) return false;    // on the screen now, so it belongs to this page
    // Not rendered, and this route did not fetch it. A missing timestamp counts
    // as "not this route": the timing buffer drops everything past 250 entries,
    // and an asset grid passes 250 in the first few screens — requiring a
    // timestamp meant the biggest pages were exactly the ones that kept leaking.
    // Anything the current route did load has an entry, because the observer
    // above has been running since the first scan.
    const t = fetchedAt.get(abs);
    return t === undefined || t < since;
  };

  const isSubframe = window !== window.top;
  const hostsMedia = !!document.querySelector('audio, video, source, [class*="player" i]');
  const mayPeek = !!opts.peek && (!isSubframe || hostsMedia);

  // The tab-level restricted check cannot see into frames, so a YouTube embed on
  // a third-party page would be scanned — and, since it hosts a <video>, clicked.
  // Running in every frame makes the restricted list bypassable by embedding
  // unless the frame also refuses for itself.
  const here = location.hostname.replace(/^www\./, '');
  if ((opts.restricted || []).some((d) => here === d || here.endsWith('.' + d))) {
    return {
      items: [], log: [`skipped restricted frame: ${here}`], url: location.href,
      frame: { url: location.href, top: !isSubframe, peeked: false, restricted: true },
      coverage: { frames: 1, framesPeeked: 0, restrictedFrames: 1, deep: !!opts.peek },
    };
  }

  // A request shaped like a manifest but carrying no extension we recognise —
  // the Vimeo/Azure case. Used twice: the read pass tries to prove each one by
  // its body, and whatever survives unproven is reported as a near miss.
  const SMELLS = /manifest|playlist|master|chunklist|\/hls\/|\/dash\/|format=m3u8|\.ism/i;

  function typeOf(url, forced) {
    if (STREAM_EXT.test(url)) return 'stream';  // wins over `forced`: a manifest is never a file
    if (forced) return forced;
    for (const [re, kind] of KINDS) if (re.test(url)) return kind;
    return null; // unknown extension and no context — not media
  }

  const ROW_SEL =
    'li, article, tr, [role="listitem"], div[class*="row" i], div[class*="card" i], div[class*="item" i], div[class*="cell" i], figure';

  const rowOf = (el) => el?.closest?.(ROW_SEL) || el?.parentElement || null;

  const clip = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_CLIP_CHARS);

  // The still a page is already showing for a video: the player's own poster first,
  // then the biggest picture in the same card. Biggest, because cards carry an
  // author avatar and a badge or two alongside the frame, and the frame is the one
  // sized like the tile.
  function posterFor(el) {
    if (!el) return '';
    try {
      const v = el.tagName === 'VIDEO' ? el : el.querySelector?.('video[poster]');
      const p = v?.getAttribute?.('poster');
      if (p) return new URL(p, location.href).href;
      const row = rowOf(el);
      if (!row) return '';
      let best = '', area = 0;
      for (const im of row.querySelectorAll('img')) {
        const u = im.currentSrc || im.src;
        if (!u || !/^https?:|^data:/.test(u)) continue;
        const b = im.getBoundingClientRect();
        const a = b.width * b.height;
        if (a > area) { area = a; best = u; }
      }
      return area > PREVIEW_MIN_AREA_PX ? best : ''; // an icon is not a preview
    } catch (_) { return ''; }
  }

  function titleOf(el) {
    const row = rowOf(el);
    if (!row) return '';
    // A <dt> is a label and the <dd> after it describes the thing — that is what
    // a definition list means, and it is how listing pages of documents are
    // built. Without this an arXiv listing named every paper after its id.
    // Scoped to that <dd> only. Searching the whole row for a heading looked
    // like a generalisation and was not: where rowOf lands on a large container,
    // every asset inside it inherits the section heading, and a page came back
    // with a dozen rows sharing one title.
    if (row.tagName === 'DT' && row.nextElementSibling?.tagName === 'DD') {
      const t = row.nextElementSibling.querySelector('[class*="title" i], [itemprop="name"]');
      // "Title:" here is a descriptor the markup prints before the value, not
      // part of the value. Only that exact word, so "Python: The Good Parts"
      // keeps its colon.
      const txt = clip(t?.textContent).replace(/^title:\s*/i, '');
      if (txt.length > 2) return txt;
    }
    // THE ASSET'S OWN DESCRIPTION OUTRANKS A LINK THAT IS ABOUT SOMETHING ELSE.
    //
    // The link branch below reads the first link in the row, and on anything discussion-shaped
    // that link is the AUTHOR. Measured on a Discourse topic: 15 of 21 assets came back titled
    // `merefield` — including four other people's avatars and the site's own banner, so the
    // export could not say whose avatar was whose. The note above already worries about this
    // leak through the heading; it arrives through the link the same way.
    //
    // `alt`, `aria-label` and `title` on the element ITSELF are the only strings that are
    // guaranteed to be about this file, so they go first. Empty and decorative ones fall
    // through to the row, which is what the row branches are for.
    const own = el.getAttribute && (el.getAttribute('alt') || el.getAttribute('aria-label')
      || el.getAttribute('title'));
    if (own && own.trim().length > 2) return own.trim().slice(0, TEXT_CLIP_CHARS);
    const link = [...row.querySelectorAll('a[href]')].find((a) => a.textContent.trim().length > 2);
    if (link) return link.textContent.trim().slice(0, TEXT_CLIP_CHARS);
    const img = row.querySelector('img[alt]');
    if (img?.alt?.trim()) return img.alt.trim().slice(0, TEXT_CLIP_CHARS);
    return (row.innerText || '').trim().split('\n')[0].slice(0, TEXT_CLIP_CHARS);
  }

  // A link with no usable extension, that nonetheless says what it is.
  //
  // Requiring an extension meant arXiv reported zero PDFs: every paper is served
  // from /pdf/<id> with no extension at all, and 50 of them on a listing page
  // were all rejected. Documents are the type where this is normal — papers,
  // books and reports are routinely served from an id route.
  //
  // Three ways a link may declare itself, in order of how much it is worth:
  // the `download` attribute (the page saying "save this"), the format named in
  // its own label, or the format as a path segment. Whatever it claims is only
  // provisional — `add` tags it `unverified` and the worker checks the real
  // Content-Type before the table repeats the claim, so a wrong guess becomes a
  // `page` row rather than a PDF that is not one.
  const PAGE_EXT = /\.(html?|php|aspx?|jsp|cgi)(\?|$)/i;
  const FMT_WORD = new RegExp('\\b(pdf|epub|mobi|djvu|docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv'
    + '|zip|rar|7z|tar|t?gz|dmg|pkg|apk|exe|msi|deb|rpm'
    + '|mp3|wav|flac|m4a|ogg|mp4|webm|mov|mkv|svg)\\b', 'i');
  // Only format words, never generic ones. "/download/" and "/file/" say nothing
  // about what is at the end of them, and a page route is far more likely.
  const FMT_SEG = /\/(pdf|epub|mobi|djvu|csv)\//i;

  function declaredKind(a) {
    // Gutenberg serves /cache/epub/<id>/pg<id>-images.html — an HTML page inside
    // a directory called epub. A URL that names itself a page is a page.
    if (PAGE_EXT.test(a.href)) return null;
    // A link back to THIS page carrying only a query is a filter or a sort, not a file.
    // Search pages offer to narrow by format, and the label on such a link IS the format
    // word — freesound's sidebar has /search/?f=type:"wav", "mp3", "flac", "m4a", "ogg",
    // and FMT_WORD matched every one, so five facet links arrived as five audio files
    // sharing a single URL. A real file lives at its own path.
    //
    // Safe against ?file=song.mp3, because typeOf() recognises the extension before
    // declaredKind is ever consulted — this only ever sees links with nothing to go on.
    try {
      const u = new URL(a.href, location.href);
      if (u.pathname === location.pathname && u.search) return null;
    } catch (_) {}
    // `download` alone says "save this", not what it is. Unsplash puts it on
    // /photos/<id>/download with no filename, which produced 15 rows all called
    // "download". Only honour it when it names the file it will save.
    const named = typeOf(a.getAttribute('download') || '');
    if (named) return named;
    // A URL WITH NO FILENAME IS NOT A FILE, whatever the words around it say.
    //
    // This is the third time FMT_WORD has typed a page as a media file, and the first two were
    // patched one entry point at a time — `?f=type:"wav"` facet links above, and PAGE_EXT before
    // that. The word list is the problem: it reads a FORMAT NAME anywhere in a link's text,
    // aria-label or title as a declaration of what the link points at.
    //
    // Freesound names every sound after its format. `217 BPM Industrial Drum Loop #17157 (WAV)`
    // links to `/people/looplicator/sounds/866305/` — the sound's HTML page — and arrived as an
    // audio asset beside the real `.mp3` preview, one phantom per row, sharing the row's title so
    // that neither the duplicate-url nor the duplicate-asset check could see it.
    //
    // A file lives at a path that ends in its own name. A path ending in `/` addresses a directory
    // or a route, and no amount of "(WAV)" in the label changes that — so this is measured off the
    // url rather than added to the vocabulary. Deliberately does not touch extensionless CDN file
    // urls (`/photos/<id>/download`), which end in a segment and are still free to be typed.
    try {
      const u = new URL(a.href, location.href);
      if (u.pathname.endsWith('/')) return null;
    } catch (_) { /* unparseable; the checks below still apply */ }
    const label = `${a.textContent} ${a.getAttribute('aria-label') || ''} ${a.title || ''}`.slice(0, 120);
    let m = FMT_WORD.exec(label);
    if (!m) { try { m = FMT_SEG.exec(new URL(a.href, location.href).pathname); } catch (_) {} }
    return m ? typeOf('x.' + m[1].toLowerCase()) : null;
  }

  // forcedType lets an <img>/<audio> tag declare what it is, so extensionless
  // CDN URLs (Unsplash, Cloudinary, imgix, /_next/image) stop being dropped.
  // What a file IS, beyond its extension. Lets a 32px avatar be filtered out
  // without throwing away the photo next to it.
  function tagsFor(url, el, type, source) {
    const t = new Set();
    const u = String(url).toLowerCase();
    const alt = (el?.getAttribute?.('alt') || '').toLowerCase();
    const cls = (typeof el?.className === 'string' ? el.className : '').toLowerCase();
    const w = el?.naturalWidth || 0;
    const h = el?.naturalHeight || 0;

    // only HoloScrape finds these — the page had not loaded them
    if (/^(peek|a\[download\]|window\.open)/.test(source)) t.add('hidden');

    // Analytics and ad beacons are shaped like images but are not assets: a 1x1
    // GIF whose only job is to be requested. They belong to the ad network, not
    // the page, so they are listed but never selected.
    if (TRACKER_HOST.test(u) || TRACKER_PATH.test(u) || (w === 1 && h === 1)) t.add('tracker');
    // Typed as an image only because something REQUESTED it as one, while the
    // URL names no image format at all — /channel-sync/4?clkgypv=jstag is a
    // cookie sync, not a picture. Extensionless CDN images (Unsplash, imgix)
    // are safe from this because they come from an <img> we can point at.
    if (type === 'image' && !el && !IMG_EXT.test(u)) t.add('tracker');

    if (type === 'image') {
      if (/(^|[/_-])(profile|avatar|user|member|author)[/_.-]/.test(u) || /profile|avatar/.test(alt + cls)) t.add('avatar');
      else if (/logo/.test(u + alt + cls)) t.add('logo');
      // SVG is a delivery format, not a role. Treating every one as an icon hid
      // real illustrations and diagrams — only a small one, or one the path
      // actually names as furniture, is an icon.
      else if (/(^|[/_-])(icon|favicon|sprite|badge)[/_.-]/.test(u)) t.add('icon');
      else if (/\.svgz?(\?|$)/.test(u) && w && w < SMALL_MAX_W) t.add('icon');
      else if (/thumb|[/_-]tn[/_.-]|preview/.test(u)) t.add('thumbnail');
      if (w && h && w / h > 3) t.add('banner');
      if (w && w < TINY_MAX_W) t.add('tiny');
      else if (w && w < SMALL_MAX_W) t.add('small');
      else if (w >= LARGE_MIN_W) t.add('large');
      if (!t.has('avatar') && !t.has('icon') && !t.has('logo')) t.add('photo');
    }
    if (type === 'audio' || type === 'video') {
      if (/preview|sample|snippet|demo/.test(u)) t.add('preview');
      if (el?.duration && el.duration > 0) t.add(el.duration < SHORT_MEDIA_S ? 'short' : 'long');
    }
    if (type === 'stream') {
      t.add(/\.mpd(\?|$)/i.test(u) ? 'dash' : 'hls');
      if (/master|playlist|index\.m3u8|manifest/.test(u)) t.add('maybe-master');
    }
    return [...t];
  }

  // Build tools bury the size in a path hash (/38bdc/cover.jpg), but the page
  // still declares it in the srcset descriptor ("… 1200w"). Without this the
  // format picker shows four indistinguishable "jpg" options.
  const declaredWidth = new Map();

  // When the PAGE says several files are one asset, believe it over the URLs.
  // Vimeo lists four progressive renditions of one video at four unrelated paths
  // (…/449262797.mp4, …/468975811.mp4) with no shared segment to group on, so the
  // variant collapse — which can only read URLs — reported one video as four rows.
  // url -> group key, consulted by assetKey before any heuristic runs.
  const assetGroup = new Map();

  function parseSrcset(srcset, el, source) {
    (srcset || '').split(',').forEach((part) => {
      const [u, desc] = part.trim().split(/\s+/);
      if (!u) return;
      const m = /^(\d+)w$/.exec(desc || '');
      if (m) {
        try { declaredWidth.set(new URL(u, location.href).href, +m[1]); } catch (_) {}
      }
      add(u, source, el, 'image');
    });
  }

  // Below this an inline image is furniture: icons, spacers, gradient stubs.
  // Above it, it is a picture. 2KB is roughly where a real thumbnail starts.
  const INLINE_MIN = 2048;

  function dataUri(url) {
    const m = /^data:([^;,]+)(;base64)?,/i.exec(url);
    if (!m) return null;
    const mime = m[1].toLowerCase();
    // Same authority as everywhere else — the extension the MIME implies.
    const type = mime === 'image/svg+xml' ? 'image'
      : mime.startsWith('image/') ? 'image'
      : mime.startsWith('audio/') ? 'audio'
      : mime.startsWith('video/') ? 'video'
      : mime === 'application/pdf' ? 'pdf'
      : null;
    if (!type) return null;
    const body = url.slice(m[0].length);
    // base64 is 4 characters per 3 bytes; percent-encoded text is close enough
    // to its own length. Neither needs decoding to be counted.
    const bytes = m[2] ? Math.floor(body.length * 3 / 4) : body.length;
    if (bytes < INLINE_MIN) return null;
    return { type, mime, bytes };
  }

  function add(url, source, el, forcedType, forcedTitle) {
    if (!url || typeof url !== 'string') return false;
    if (url.startsWith('blob:')) { blobHits++; return false; }
    // An inlined file is still a file. Search results and CMS thumbnails are
    // routinely base64'd into the markup, and dropping them outright meant a page
    // whose pictures were all inline reported nothing at all.
    //
    // The guard is size, not shape: a page carries dozens of inline SVG icons and
    // 1x1 spacers, and those are noise at any resolution. Everything above the
    // floor is a picture someone may have come for.
    if (url.startsWith('data:')) {
      const d = dataUri(url);
      if (!d) return false;
      if (found.has(url)) return false;
      found.set(url, {
        url, type: d.type, source: source + ':data',
        title: forcedTitle ?? (el ? titleOf(el) : ''),
        // Exact, and free — the length is the file. No request, no header.
        bytes: d.bytes,
        tags: ['inline'],
        page: location.href,
        w: el?.naturalWidth || 0,
        h: el?.naturalHeight || 0,
      });
      return true;
    }
    let abs;
    try { abs = new URL(url, location.href).href; } catch { return false; }
    const type = typeOf(abs, forcedType);
    if (!type) return false;
    if (staleRoute(abs, el)) { staleHits++; return false; }
    if (found.has(abs)) {
      const prev = found.get(abs); // a better-attributed pass may fill the title
      if (!prev.title && (forcedTitle || el)) prev.title = forcedTitle || titleOf(el);
      return false;
    }
    // Did the URL itself prove the type, or did we take a tag's / metadata's word
    // for it? og:video on Vimeo points at player.vimeo.com/video/<id> — an HTML
    // page, not a file — and downloading it saved the page. Anything typed by
    // assertion rather than by extension is flagged for a Content-Type check in
    // the worker before the table is allowed to call it a video.
    const tags = tagsFor(abs, el, type, source);
    if (!typeOf(abs)) tags.push('unverified');

    found.set(abs, {
      url: abs, type, source,
      title: forcedTitle ?? (el ? titleOf(el) : ''),
      tags,
      page: location.href,
      // The picture the card was already showing for this video. Free, correct, and
      // the only preview that exists before the file is downloaded — a `<video>` has
      // to fetch metadata to render even one frame, and a results table holding a
      // thousand of them cannot afford a thousand of those.
      ...(type === 'video' || type === 'stream' ? { poster: posterFor(el) } : {}),
      // Natural pixels, when the page actually decoded the image. Anything found
      // only in the network log has none — the table fills those in later from
      // its own thumbnail rather than guessing here.
      w: el?.naturalWidth || 0,
      h: el?.naturalHeight || 0,
    });
    return true;
  }

  // --- 0. wake the lazy content ----------------------------------------------
  // Galleries mount images only as they scroll into view, so a scan of the
  // visible page misses most of them. Deep scan walks the page first, then
  // returns you to where you were.
  // Jumping straight to the bottom is why a hand-scroll used to beat a deep scan:
  // lazy loaders mount on IntersectionObserver, and a teleport means the whole
  // middle of the page never enters the viewport, so it never loads. Walk down a
  // screen at a time — slightly less than a screen, so nothing falls between
  // steps — and pause long enough at each for the observers to fire.
  if (mayPeek && opts.autoScroll !== false && !isSubframe) {
    // WHAT scrolls has to be answered before scrolling it. An app shell puts
    // overflow-y on an inner element and leaves the document at exactly the
    // viewport height, so window.scrollTo moves nothing — and because the
    // document then never grows, the walk concluded "reached the end" after two
    // screens, having scrolled nothing at all. It reported success.
    const scroller = findScroller();
    // A SCROLL POSITION IS NOT A GESTURE — the thing `rows.js` already knows and this file did not.
    //
    // Assigning scrollTop moves the pane and fetches NOTHING on a list that virtualizes: those
    // mount on the wheel and key events their own handlers listen for. Measured on Discord, which
    // is why the row engine grew this trio: 15 rows from assignment, 75 once the events fired.
    // Measured again on a 733-post Discourse topic, which is what sent this here: the asset walk
    // was allowed 220 screens, went dry after a handful, and came back with ONE post's images
    // while ~350 image URLs sat further down the thread.
    //
    // Same trio as `rows.js`, deliberately — the note above says these two copies are edited
    // together, and a scroll that only one engine can drive is exactly the split that caused this.
    const gesture = (el, dy) => {
      const target = el || document.scrollingElement || document.body;
      try {
        target.dispatchEvent(new WheelEvent('wheel', {
          deltaY: dy, deltaX: 0, deltaMode: 0, bubbles: true, cancelable: true, composed: true,
        }));
      } catch (_) { /* an element that refuses it is a real answer */ }
      try {
        const key = dy < 0 ? 'PageUp' : 'PageDown';
        const code = dy < 0 ? 33 : 34;
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true, composed: true,
        }));
      } catch (_) { /* same */ }
      try { target.dispatchEvent(new Event('scroll', { bubbles: false })); } catch (_) { /* same */ }
    };
    // `quiet` is for the two calls that are not steps: the reset to the top before the walk and the
    // restore to where the person was after it. Gesturing those would ask the page to load content
    // for a position nobody is reading.
    const seek = (v, quiet) => {
      const at = scroller ? scroller.scrollTop : (window.scrollY || 0);
      if (scroller) scroller.scrollTop = v; else window.scrollTo(0, v);
      if (!quiet) gesture(scroller, v - at);
    };
    const fullH = () => (scroller ? scroller.scrollHeight : document.documentElement.scrollHeight);
    const viewH = () => (scroller ? scroller.clientHeight : window.innerHeight);

    const startY = scroller ? scroller.scrollTop : window.scrollY;
    const maxSteps = opts.maxScrollSteps || SCROLL_STEPS_DEFAULT;
    const pause = opts.scrollPauseMs || SCROLL_PAUSE_DEFAULT_MS;
    // Derived from the steps rather than a flat minute — see WALK_BUDGET_* above.
    const budgetMs = Math.min(WALK_BUDGET_MAX_MS, Math.max(WALK_BUDGET_MIN_MS, Math.round(maxSteps * pause * WALK_BUDGET_SLACK)));
    const started = Date.now();
    let y = 0, still = 0, lastH = 0, stopped_early = false;
    // How many quiet screens count as done. High enough to wait out a slow feed.
    const dryLimit = opts.dryScreens || DRY_SCREENS_DEFAULT;
    if (scroller) log.push(`scrolling an inner container (${scroller.tagName.toLowerCase()}${scroller.id ? '#' + scroller.id : ''})`);

    // --- pressing what the page put there ------------------------------------
    // Scrolling is not the only way a page extends a list. Tokopedia gates its
    // feed behind "Muat Lebih Banyak": the walk reaches the bottom, sees the page
    // stop growing, reports "reached the end", and leaves the button unpressed —
    // so a hand-click beat a deep scan, which is the one thing a deep scan must
    // never lose to.
    //
    // The wording lists below are duplicated from the row engine on purpose. Both
    // engines are serialised to source by chrome.scripting.executeScript, so
    // neither can import anything — which is why each already carries its own
    // scroller detection too. Duplication here is the architecture, not an
    // oversight; the two copies must be edited together.
    const MORE_STRONG = /load\s*more|show\s*more\s*results|more\s*results|muat\s*lebih|tampilkan\s*lebih|carregar\s*mais|cargar\s*m[áa]s|daha\s*fazla|mehr\s*laden|charger\s*plus|さらに表示|もっと見る|加载更多|더\s*보기/i;
    const MORE_WEAK = /show\s*more|see\s*more|view\s*more|selengkapnya|lihat\s*lebih|ver\s*mais|mostrar\s*mais|ver\s*m[áa]s|mostrar\s*m[áa]s|devam|mehr\s*anzeigen|voir\s*plus|查看更多|更多/i;
    const MORE_NEVER = /pelajari|learn\s*more|read\s*more|baca\s*selengkapnya|saiba\s*mais|m[áa]s\s*informaci|en\s*savoir\s*plus|next\s*page|halaman\s*berikutnya|pr[óo]xima\s*p[áa]gina/i;
    const MORE_ATTR = /load[-_]?more|show[-_]?more|infinite|pagination-more/i;

    // NOT ON A MAP THAT PAGES — the same rule `rows.js` already applies, and the reason this
    // file needed it too was written into a user's export: every asset's `page` came back as
    // `…?immersive=on`, before a single page had been followed.
    //
    // 2GIS has no load-more. What matched here is its «иммерсивные дороги» DISPLAY TOGGLE, and
    // pressing it rewrites the URL. That is not a cosmetic mistake: the URL is what `visitKey` is
    // built from, so a rewrite mid-scan mints a NEW session — and the row table, the walk and the
    // record pass then file against different ids. The asset scan runs FIRST, so it was splitting
    // the visit before the table had a single row, which is why a later "read each record" landed
    // on nothing.
    //
    // Gating `rows.js` alone fixed half of it. A provider that declares how its list grows is
    // declaring that guessing is not needed, and that is true of every engine, not just one.
    const findMore = () => {
      const grows = (Object.values(opts.providers || {})
        .find((d) => d.host && new RegExp(d.host).test(location.hostname)
          && (!d.path || new RegExp(d.path).test(location.pathname))) || {}).grows;
      if (grows && grows !== 'press') return null;
      let best = null;
      let looked = 0;
      for (const b of document.querySelectorAll('button,a[role="button"],[role="button"],a')) {
        if (++looked > CONTROL_SWEEP_MAX) break;
        if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
        // Wording before geometry: a page with 700 controls spends the sweep budget
        // on links otherwise, and forcing layout for each is the slower order too.
        const label = `${(b.innerText || '').replace(/\s+/g, ' ').trim()} `
          + `${b.getAttribute('aria-label') || ''} ${b.title || ''}`;
        const attrs = `${b.className || ''} ${b.getAttribute('data-testid') || ''} ${b.id || ''}`;
        if (MORE_NEVER.test(label)) continue;
        const strong = MORE_STRONG.test(label) || MORE_ATTR.test(attrs);
        const weak = !strong && MORE_WEAK.test(label);
        if (!strong && !weak) continue;
        const box = b.getClientRects()[0];
        if (!box || box.width < 24 || box.height < 12) continue;
        const isButton = b.tagName === 'BUTTON' || b.getAttribute('role') === 'button';
        // A 26px inline link saying "see more" is a disclosure, not a control.
        if (weak && !isButton && box.height < 32) continue;
        // And a link that goes somewhere is pagination, not a list extender.
        // Clicking one navigated away mid-scan on Pixabay and the entire result
        // came back empty: "Execution context was destroyed".
        if (b.tagName === 'A' && !isButton) {
          const href = b.getAttribute('href') || '';
          if (href && !/^#|^javascript:/i.test(href)) continue;
        }
        const rank = (strong ? 4 : 0) + (isButton ? 2 : 0) + (box.height >= 36 ? 1 : 0);
        const low = box.top;
        if (!best || rank > best.rank || (rank === best.rank && low > best.low)) {
          best = { el: b, rank, low, label: label.trim().slice(0, 40) };
        }
      }
      return best;
    };

    // --- waiting for the page's own API ---------------------------------------
    // Resource-timing only reports requests that have LANDED, so a walk pacing
    // itself on a fixed sleep scrolls straight through the gap between firing a
    // fetch and that fetch answering. Counting requests in flight closes it: don't
    // scroll while the page is still waiting on itself.
    //
    // Duplicated from the row engine for the same reason the wording lists are:
    // both functions are serialised to source by executeScript and can import
    // nothing. Edit the two together.
    const NET = '__holoscrapeNet';
    (function watchNet() {
      if (window[NET]) return;
      // AGED, NOT MERELY COUNTED. A bare counter cannot tell a fetch from a stream, and
      // Google Maps holds a long-poll open for the life of the page: `inflight` never
      // returned to zero, so every screen of the walk paid the network cap in full.
      // Measured on a Maps search: ~5 seconds per scroll, with "waiting on 1 request the
      // page has not answered" still on screen at 28 seconds. The page was not slow — it
      // was subscribed, and we were queuing behind a subscription.
      //
      // A request still unanswered after this long is not something to wait for. Nothing
      // the walk cares about takes longer — an image batch, a JSON page of rows — and a
      // page that genuinely is that slow gets its chance on the NEXT screen instead of
      // holding this one. Dropped from the live set once aged, so it can never be counted
      // again however long it stays open.
      const STREAM_MS = 2500;
      const st = { inflight: 0, peak: 0, done: 0, streams: 0 };
      const live = new Map();
      let seq = 0;
      st.prune = () => {
        const now = Date.now();
        for (const [id, t] of live) {
          if (now - t <= STREAM_MS) continue;
          live.delete(id);
          st.inflight = Math.max(0, st.inflight - 1);
          st.streams++;   // reported, so a walk that waited on nothing says so
        }
      };
      const up = () => {
        const id = ++seq;
        live.set(id, Date.now());
        st.inflight++;
        if (st.inflight > st.peak) st.peak = st.inflight;
        return id;
      };
      const dn = (id) => {
        if (!live.delete(id)) return;   // already aged out; do not double-decrement
        st.inflight = Math.max(0, st.inflight - 1);
        st.done++;
      };
      try {
        const orig = window.fetch;
        if (typeof orig === 'function') {
          window.fetch = function (...a) {
            const id = up();
            let p;
            try { p = orig.apply(this, a); } catch (e) { dn(id); throw e; }
            if (!p || typeof p.then !== 'function') { dn(id); return p; }
            return p.then((r) => { dn(id); return r; }, (e) => { dn(id); throw e; });
          };
        }
      } catch (_) {}
      try {
        const X = window.XMLHttpRequest;
        if (X && X.prototype && typeof X.prototype.send === 'function') {
          const send0 = X.prototype.send;
          X.prototype.send = function (...a) {
            let settled = false;
            const id = up();
            const fin = () => { if (!settled) { settled = true; dn(id); } };
            try { this.addEventListener('loadend', fin); return send0.apply(this, a); }
            catch (e) { fin(); throw e; }
          };
        }
      } catch (_) {}
      window[NET] = st;
    })();

    // Named for what it asks, and deliberately not `stopped` — that name is already the
    // walk's reason string in this scope, and shadowing it turned every "reached the
    // end" into an assignment to a const.
    // ...OR BECAUSE A WALK OWNS THIS PAGE.
    //
    // `walking` in the worker refuses a scan that has not started; nothing told a scan already in
    // flight to let go, so its steps and a harvest's steps landed on the same pane. The worker now
    // publishes the claim here when it takes a walk and deletes it on release, so this is an exact
    // answer rather than a guess about how long a hop should take — the earlier heartbeat version
    // went stale on a loaded machine and the collision came straight back.
    //
    // Yielding is right either way: the walk was asked for, this scan's poll was not.
    const cancelled = () => {
      if (halted()) return true;
      try {
        const w = window.__holoscrapeWalk;
        // The ttl only guards against a worker evicted between set and clear; see `markWalking`.
        return !!w && Date.now() - (w.at || 0) < (w.ttl || WALK_TTL_DEFAULT_MS);
      } catch (_) { return false; }
    };

    let netWaited = 0;
    const awaitNet = async (cap) => {
      const st = window[NET];
      if (!st) return;
      const t0 = Date.now();
      // `halted()` belongs in the condition, not only inside the sleep: with the sleep
      // now interruptible, a stopped scan would otherwise spin here until the nine-second
      // cap because a busy page never lets `inflight` reach zero.
      // Aged out before each check, not only when a request settles: a stream never
      // settles, so nothing else would ever drop it and the loop would run to the cap.
      while (!halted() && Date.now() - t0 < cap) {
        if (st.prune) st.prune();
        if (st.inflight <= 0) break;
        await sleep(NET_POLL_MS);
      }
      netWaited += Date.now() - t0;
    };

    let pressed = 0;
    const maxPress = opts.maxMoreClicks == null ? MORE_CLICKS_DEFAULT : opts.maxMoreClicks;
    // On screen, or within a screen below. A load-more mid-page above a tall footer
    // was walked straight past and only pressed once the document ran out — see the
    // same note in the row engine.
    const withinReach = (el) => {
      try {
        const r = el.getClientRects()[0];
        return !!r && r.top < innerHeight * REACH_SCREENS_BELOW && r.bottom > -REACH_PX_ABOVE;
      } catch (_) { return false; }
    };
    const pressMore = async (onlyIfVisible) => {
      if (pressed >= maxPress) return false;
      const b = findMore();
      if (!b) return false;
      if (onlyIfVisible && !withinReach(b.el)) return false;
      pressed++;
      // Never upwards. scrollIntoView with block:'center' does whatever it takes to
      // centre the element, and by the time a load-more is pressed the walk is near
      // the bottom of a page that has grown — centring the button jumped the view
      // back up by 4,905px, mid-scan, every single time. A button on screen is
      // clickable where it is; one below is reached by going further down.
      try {
        const r = b.el.getClientRects()[0];
        if (r && !(r.top >= 0 && r.bottom <= innerHeight) && r.bottom >= 0) {
          window.scrollTo({ top: (window.scrollY || 0) + r.top - innerHeight * 0.4,
            behavior: 'instant' });
        }
      } catch (_) {}
      b.el.click();
      log.push(`pressed "${b.label}" (${pressed})`);
      // Wait for what the press asked for, here, before doing anything else. The
      // walk used to scroll first and only check the network on the next iteration,
      // so a press whose fetch was slower than one pause was scrolled straight past
      // — the click happened and its result was never waited for, which looks
      // exactly like the click not happening.
      await sleep(Math.max(PRESS_SETTLE_MIN_MS, pause * 2));
      await awaitNet(PRESS_NET_CAP_MS);
      return true;
    };

    seek(0, true);
    await sleep(SEEK_SETTLE_MS);

    // An infinite feed never ends, so "scroll to the bottom" is not a stopping
    // rule. Two are used instead: the page stops growing (a finite page), or it
    // keeps growing but stops producing anything new (a feed of the same thing).
    // Whichever fires first, and the budget as a backstop.
    let seen = 0, dry = 0;
    for (; screens < maxSteps && Date.now() - started < budgetMs; screens++) {
      if (cancelled()) { stopped_early = true; break; }
      y += Math.max(SCREEN_STEP_MIN_PX, Math.round(viewH() * SCREEN_STEP_SHARE)); // overlap
      mark({ phase: 'walking', walked: screens + 1, screens: maxSteps, files: found.size });
      seek(y);
      await sleep(pause);
      // A request on the wire outranks the pause: the batch this screen asked for
      // has not arrived yet, and counting it as "nothing new" is how a slow feed
      // reads as a finished one.
      await awaitNet(SCREEN_NET_CAP_MS);

      // READ AT EVERY STEP, BECAUSE BY THE END THE PICTURES ARE GONE.
      //
      // This walk existed only to WAKE lazy content: it scrolled, and step 1 below read the DOM once
      // afterwards. That works on a page that grows and fails completely on one that RECYCLES —
      // there, the document holds one screenful and the walk's own scrolling is what throws the rest
      // away. Measured on a 733-post topic: the whole walk produced ONE post's images, while the
      // browser's network panel listed 126 image requests for the same tab.
      //
      // `rows.js` learned this for rows and says so in `collectRows`: *reads at every step and keeps
      // what it sees, instead of scrolling first and reading at the end — by which time the rows are
      // gone.* Media is the identical problem and this file never applied it.
      //
      // Cheap by construction: `add()` is keyed on the url, so a picture seen on five consecutive
      // screens is stored once, and the sweep is a handful of querySelectorAll over one viewport's
      // worth of nodes. It needs no debugger, so it works while DevTools is open — which the network
      // capture cannot.
      domSweep();

      // Press what this screen brought into view, rather than saving it for the end
      // of the document — which on a page with a long footer is thousands of pixels
      // past the point where pressing would have helped.
      if (await pressMore(true)) { dry = 0; still = 0; lastH = 0; continue; }

      const h = fullH();
      const now = document.images.length + document.querySelectorAll('audio,video,source').length;

      // "Nothing new" only counts as done if the document ALSO stopped growing.
      // A page that is still getting taller is still loading, and calling that dry
      // is what made every walk stop in the same place regardless of budget: the pause
      // is shorter than the time a slow lazy-loader takes to mount its next batch.
      const growing = h > lastH;
      if (now > seen || growing) { seen = Math.max(seen, now); dry = 0; } else dry++;
      lastH = Math.max(lastH, h);
      // Patience scales with the setting — that is most of what the setting means.
      if (dry >= dryLimit) {
        // Before believing a feed is dry, offer it its own button.
        if (await pressMore()) { dry = 0; still = 0; lastH = 0; continue; }
        screens++; stopped = `nothing new in ${dryLimit} screens`; break;
      }

      if (y < h - viewH()) { still = 0; continue; }
      // At the current bottom: an infinite feed needs a beat to append more.
      await sleep(FEED_APPEND_BEAT_MS);
      await awaitNet(SCREEN_NET_CAP_MS);
      still = fullH() === h ? still + 1 : 0;
      if (still >= STILL_SCREENS_END) {
        if (await pressMore()) { still = 0; dry = 0; lastH = 0; continue; }
        screens++; stopped = 'reached the end'; break;
      }
    }
    if (stopped_early) stopped = 'stopped';
    if (!stopped) stopped = screens >= maxSteps ? 'hit the depth limit' : 'timed out';

    // Left where the walk ended when a row pass follows, so the two phases are one
    // descent instead of two round trips. The row pass owns the single restore.
    // Two engines each springing back to the start is what made a deep scan look
    // like it was fighting the scrollbar.
    if (!opts.keepScroll) {
      seek(startY, true);
      await sleep(RESTORE_SETTLE_MS);
    }
    log.push(`walked ${screens} screen(s)${pressed ? `, pressed load-more ${pressed}x` : ''}`
      + `${netWaited > 400 ? `, waited ${Math.round(netWaited / 100) / 10}s on the page's requests` : ''}`
      + ` — ${stopped}`);
    // Never let a bounded walk read as a complete one.
    // There is no Thoroughness to raise any more, and a bounded walk must still never
    // read as a complete one.
    if (stopped !== 'reached the end') log.push('more may exist below — scan again to continue');
  }

  // --- 1. the DOM: tags declare their own type -------------------------------
  const domBefore = found.size;
  domSweep();
  log.push(`dom: ${found.size - domBefore}`);
  // eslint-disable-next-line no-unused-vars
  function domSweep() {
  document.querySelectorAll('img').forEach((img) => {
    if (img.naturalWidth && img.naturalWidth < SPACER_MAX_W) return; // trackers, spacers
    add(img.currentSrc || img.src, 'img', img, 'image');
    add(img.dataset.src, 'img[data-src]', img, 'image');
    add(img.dataset.original, 'img[data-original]', img, 'image');
    parseSrcset(img.srcset || img.dataset.srcset, img, 'srcset');
  });
  document.querySelectorAll('picture source[srcset]').forEach((s) => parseSrcset(s.srcset, s, 'picture'));
  document.querySelectorAll('audio, video').forEach((el) => {
    const t = el.tagName === 'AUDIO' ? 'audio' : 'video';
    add(el.currentSrc || el.src, el.tagName.toLowerCase(), el, t);
    el.querySelectorAll('source').forEach((s) => add(s.src, 'source', el, t));
    if (el.poster) add(el.poster, 'poster', el, 'image'); // the thumbnail we used to discard
  });
  document.querySelectorAll('a[href]').forEach((a) => {
    if (typeOf(a.href)) return void add(a.href, 'link', a);
    const kind = declaredKind(a);
    if (kind) add(a.href, 'link', a, kind);
  });
  }

  // --- 1b. ask the player itself ----------------------------------------------
  // We run in the page's own JS world, so a player's config object is simply
  // readable. This reaches files that NOTHING else can: Vimeo lists four
  // progressive MP4s in window.playerConfig, and the 720p one is never requested
  // unless you pick that quality — so it appears in no DOM node and in no
  // network log. Reading the config is the only way to see it.
  const cfgBefore = found.size;
  const pageTitle = (document.title || '').trim().slice(0, TEXT_CLIP_CHARS);

  try {
    const files = window.playerConfig?.request?.files;
    if (files) {
      // One key for every progressive rendition the player declares, so the four
      // of them collapse into a single row whose picker is the quality list.
      const gid = `video|progressive|${window.playerConfig?.video?.id || location.pathname}`;
      (files.progressive || []).forEach((p) => {
        if (!p?.url) return;
        // Feeds the existing variant collapse, so qualities become one picker.
        try {
          const abs = new URL(p.url, location.href).href;
          if (p.width) declaredWidth.set(abs, +p.width);
          assetGroup.set(abs, gid);
        } catch (_) {}
        add(p.url, 'player-config', null, 'video', pageTitle);
      });
      ['hls', 'dash'].forEach((k) => {
        Object.values(files[k]?.cdns || {}).forEach((c) =>
          add(c?.url || c?.avc_url, 'player-config', null, 'stream', pageTitle));
      });
    }
  } catch (_) {}

  // video.js, and everything built on it (Brightcove and many news sites)
  try {
    (window.videojs?.getAllPlayers?.() || []).forEach((pl) => {
      (pl.currentSources?.() || []).forEach((s) => add(s?.src, 'player-config', null, null, pageTitle));
      const po = pl.poster?.();
      if (po) add(po, 'player-poster', null, 'image', pageTitle);
    });
  } catch (_) {}

  try {
    if (typeof window.jwplayer === 'function') {
      (window.jwplayer()?.getPlaylist?.() || []).forEach((it) => {
        (it.sources || []).forEach((s) => add(s?.file, 'player-config', null, null, it.title || pageTitle));
        if (it.image) add(it.image, 'player-poster', null, 'image', it.title || pageTitle);
      });
    }
  } catch (_) {}

  // Structured metadata. og:video and JSON-LD contentUrl are frequently a direct
  // file even when the player on the page uses adaptive streaming.
  document.querySelectorAll('meta[property^="og:video"], meta[name="twitter:player:stream"]').forEach((m) => {
    const prop = m.getAttribute('property') || '';
    if (/:(type|width|height|duration|tag)$/.test(prop)) return; // not URLs
    add(m.content, 'og:video', null, 'video', pageTitle);
  });
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        const type = String(n['@type'] || '');
        if (/VideoObject|AudioObject|MediaObject/.test(type)) {
          const t = (n.name || pageTitle || '').slice(0, TEXT_CLIP_CHARS);
          if (n.contentUrl) add(n.contentUrl, 'json-ld', null, /Audio/.test(type) ? 'audio' : 'video', t);
          if (n.thumbnailUrl) [].concat(n.thumbnailUrl).forEach((u) => add(u, 'json-ld', null, 'image', t));
        }
        Object.values(n).forEach(walk);
      };
      walk(JSON.parse(s.textContent));
    } catch (_) {}
  });
  if (found.size > cfgBefore) log.push(`player config & metadata: +${found.size - cfgBefore}`);

  // --- 2. everything the page already downloaded ------------------------------
  const netBefore = found.size;
  try {
    // resourceLog(), not the live buffer: past 250 entries the buffer stops
    // recording, and an asset grid reaches that in the first few screens.
    resourceLog().forEach((e, name) => {
      if (e.t < since) return; // belongs to the route we came from
      const forced =
        e.it === 'img' ? 'image'
        : e.it === 'media' ? (AUDIO_EXT.test(name) ? 'audio' : 'video')
        : null;
      // Bytes on the wire. A cross-origin response without Timing-Allow-Origin
      // reports 0, so only a positive number means anything.
      if (e.sz > 0) { try { wireSize.set(new URL(name, location.href).href, e.sz); } catch (_) {} }
      add(name, 'network', null, forced);
    });
  } catch (_) { log.push('network scan failed'); }
  log.push(`network: +${found.size - netBefore}`);

  // --- 3. find the triggers (always) -----------------------------------------
  // Finding them costs nothing, so a passive scan can tell you how much a deep
  // scan would open before you commit fifteen seconds to it.
  let clicked = 0, skipped = 0, peekAdded = 0, dismissed = 0, blockedDownloads = 0, prefetched = 0, unmatched = 0;

  const labelOf = (el) => {
    const own = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${(el.innerText || '').slice(0, 60)}`;
    const kids = [...el.querySelectorAll('[aria-label],[title]')].slice(0, 4)
      .map((k) => `${k.getAttribute('aria-label') || ''} ${k.getAttribute('title') || ''}`).join(' ');
    return `${own} ${kids}`.trim();
  };
  // "playOverlay--x9f" -> [play, overlay, x, f];  "display-flex" -> [display, flex]
  const classTokens = (el) => {
    const c = typeof el.className === 'string' ? el.className : '';
    return c.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z]+/).filter(Boolean).map((t) => t.toLowerCase());
  };

  const candSel = 'button, [role="button"], [onclick], [class*="play" i], [class*="preview" i]'
    + (opts.clickDownloads ? ', [class*="download" i]' : '');
  const cands = [...document.querySelectorAll(candSel)].filter((el) => {
    if (!el.offsetParent && el.getClientRects().length === 0) return false;
    // Refused on safety grounds: it sits in a region where clicking has
    // consequences, or it is named after an action we will not take on your
    // behalf. These are the only two things "ignored as unsafe" may count.
    if (el.closest('nav, header, footer, form, [role="navigation"], [role="dialog"]')) { skipped++; return false; }
    const label = labelOf(el);
    if (NEVER.test(label)) { skipped++; return false; }
    // Not a play control at all. This used to be counted as "unsafe" too, which
    // is how an ordinary page reported "123 ignored as unsafe" — almost all of
    // them ordinary buttons that were never candidates for anything.
    if (!(WANT_TEXT.test(label) || classTokens(el).some((t) => WANT_CLASS.test(t)))) return false;
    return true;
  });
  const triggers = cands.length;
  log.push(`${triggers} media trigger(s) found (${skipped} refused as unsafe)`);

  // --- 4. peek: click them, block every consequence ---------------------------
  if (mayPeek) {
    const origPlay = HTMLMediaElement.prototype.play;
    const origAudio = window.Audio;
    const srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    const origOpen = window.open;
    // Set for the duration of one click so whatever the page loads is attributed
    // to THAT row. Reading the row's DOM afterwards fails on sites like Pixabay
    // that reuse one shared <audio> element outside the row.
    let capture = null;
    const origSubmit = HTMLFormElement.prototype.submit;
    const origBeacon = navigator.sendBeacon;
    const DIALOG_SEL = '[role="dialog"], [aria-modal="true"], dialog[open]';
    const stop = (e) => {
      const a = e.target.closest?.('a[href]');
      if (!a) return;
      // Sites download by synthesising <a download>.click() — record the URL,
      // then kill the event so nothing lands on disk.
      if (a.hasAttribute('download')) { add(a.href, 'a[download]', a); blockedDownloads++; }
      e.preventDefault();
      e.stopPropagation();
    };

    try {
      HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      window.Audio = function (u) { if (capture && u) capture.push(u); return new origAudio(u); };
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        get() { return srcDesc.get.call(this); },
        set(v) { if (capture && v) capture.push(v); srcDesc.set.call(this, v); },
      });
      window.open = function (u) { add(u, 'window.open', null); return { close() {}, focus() {}, closed: true }; };
      HTMLFormElement.prototype.submit = function () {};
      navigator.sendBeacon = function () { return true; };
      document.addEventListener('click', stop, true);

      // Opening media is the expensive phase by a wide margin, and it is why scanning
      // one page can take longer than fetching twenty-five more: a fetch never enters
      // this phase at all. The tempting cure — skip triggers whose row already holds a
      // media file — is unsound, and this suite proves it: the frames fixture has a row
      // whose video is already found AND whose play button reveals a different file. What
      // a click produces cannot be known before the click.
      //
      // So nothing is skipped. What goes instead is the OVER-WAITING. The pause after
      // each click was a fixed 200ms whether the page answered in five milliseconds or
      // not at all; now the click is followed as fast as the page actually responds, with
      // the same 200ms only as the ceiling. Identical clicks, identical captures, a
      // fraction of the wall-clock on any site that answers promptly.
      const queue = cands.slice(0, opts.maxClicks);
      mark({ phase: 'peeking', clicked: 0, triggers: queue.length, files: found.size });
      for (const el of queue) {
        if (halted()) { stopped = stopped || 'cancelled'; break; }
        mark({ clicked: clicked + 1, files: found.size });
        const row = rowOf(el);
        const title = titleOf(el);
        const dlgBefore = document.querySelectorAll(DIALOG_SEL).length;
        capture = [];
        try { el.click(); clicked++; } catch (_) { capture = null; continue; }
        // As fast as the page answers, and never longer than the budget. A player that
        // sets its src in five milliseconds used to cost the same two hundred as one that
        // never answers at all; on a hundred triggers that is the difference between four
        // seconds and twenty. Once the first URL lands, a short grace (PEEK_GRACE_MS)
        // catches the siblings a player prefetches alongside it.
        {
          const t0 = Date.now();
          while (!capture.length && Date.now() - t0 < opts.delayMs && !halted()) await sleep(PEEK_POLL_MS);
          if (capture.length) await sleep(Math.min(PEEK_GRACE_MS, opts.delayMs));
        }
        // Only the FIRST url belongs to this row — sites prefetch neighbours on
        // play, and attributing those here is what duplicated the titles.
        if (capture[0] && add(capture[0], 'peek', el, null, title)) peekAdded++;
        prefetched += Math.max(0, capture.length - 1);
        capture = null;
        if (document.querySelectorAll(DIALOG_SEL).length > dlgBefore) {
          dismissed++;
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
          await sleep(120);
        }
        // Attribute to THIS row by reading the media the click created inside it,
        // instead of racing a global list (which mislabelled every mp3).
        if (row) {
          row.querySelectorAll('audio, video').forEach((m) => {
            const t = m.tagName === 'AUDIO' ? 'audio' : 'video';
            if (add(m.currentSrc || m.src, 'peek', el, t, title)) peekAdded++;
          });
        }
      }
      // Stragglers: a file prefetched during an earlier row's click, so its own
      // click produced nothing. We cannot know which row owns it — so we take
      // the file and leave the title EMPTY rather than borrow a neighbour's.
      // Reported as "unmatched" instead of quietly mislabelled.
      const sweepLate = () => {
        document.querySelectorAll('audio, video').forEach((m) => {
          const t = m.tagName === 'AUDIO' ? 'audio' : 'video';
          if (add(m.currentSrc || m.src, 'peek-late', null, t, '')) { peekAdded++; unmatched++; }
        });
        resourceLog().forEach((e, name) => {
          if (e.t < since) return; // belongs to the route we came from
          const forced = e.it === 'media' ? (AUDIO_EXT.test(name) ? 'audio' : 'video') : null;
          // A manifest is fetched over XHR the moment playback starts, so it
          // does not exist until after the click AND never carries the 'media'
          // initiator — it is the one thing a media-only filter structurally
          // cannot see. Widening further pulls in late tracking pixels with no
          // titles, which is why this admits streams and nothing else.
          if (!forced && typeOf(name) !== 'stream') return;
          if (add(name, 'peek-network', null, forced, '')) { peekAdded++; unmatched++; }
        });
      };

      await sleep(PEEK_SWEEP_MS);
      sweepLate();
      // A player needs a beat after the click before it requests its manifest, so a
      // single sweep routinely misses it (PEEK_PLAYER_SWEEP_MS). Only pages that
      // actually have a player pay for the extra wait.
      if (document.querySelector('video') || [...found.values()].some((i) => i.type === 'stream')) {
        await sleep(PEEK_PLAYER_SWEEP_MS);
        sweepLate();
      }
    } finally {
      HTMLMediaElement.prototype.play = origPlay;
      window.Audio = origAudio;
      Object.defineProperty(HTMLMediaElement.prototype, 'src', srcDesc);
      window.open = origOpen;
      HTMLFormElement.prototype.submit = origSubmit;
      navigator.sendBeacon = origBeacon;
      document.removeEventListener('click', stop, true);
    }
    log.push(`peek: +${peekAdded} from ${clicked} clicks`);
    if (blockedDownloads) log.push(`blocked ${blockedDownloads} download(s)`);
    if (dismissed) log.push(`dismissed ${dismissed} modal(s)`);
    if (unmatched) log.push(`${unmatched} file(s) could not be matched to a row`);
  }

  // --- 5. read the manifests --------------------------------------------------
  // A manifest is a format table, and until it is read a stream is one opaque row
  // saying "m3u8" — a format nobody can use, standing in for renditions we never
  // looked at. Reading it turns the row into what the manifest actually indexes.
  //
  // Written from the specs (RFC 8216 §4.3.4 for HLS, ISO/IEC 23009-1 §5.3 for
  // DASH); only four tags matter here. Nothing is ported from anything.
  //
  // This is also the only place that can refuse for the right reason. A host list
  // catches the services we thought to name; an encryption marker catches every
  // stream that is not ours to assemble, on hosts nobody listed.

  const manifests = new Map();  // url -> { kind, encrypted, encMethod, renditions }
  const disproved = new Set();  // typed `stream` by assertion, then read and found not to be one

  // #EXT-X-STREAM-INF:BANDWIDTH=5145000,RESOLUTION=1920x1080,CODECS="avc1,mp4a"
  // Attributes are comma-separated and CODECS is a quoted string CONTAINING
  // commas, so splitting on the comma is the classic way to get this wrong.
  function hlsAttrs(line) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(line))) out[m[1]] = m[2].replace(/^"|"$/g, '');
    return out;
  }

  const absFrom = (uri, base) => { try { return new URL(uri, base).href; } catch { return ''; } };

  function parseHls(text, base) {
    const lines = text.split(/\r?\n/);
    const renditions = [];
    let encrypted = false, encMethod = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // Any key method other than NONE means the segments are encrypted. Both
      // families count: SAMPLE-AES needs a licence server, and AES-128 hands out
      // its key over HTTPS — neither is a file we may reassemble for you.
      if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-SESSION-KEY')) {
        const a = hlsAttrs(line);
        if (a.METHOD && a.METHOD !== 'NONE') { encrypted = true; encMethod = encMethod || a.METHOD; }
        continue;
      }
      // Note the exact prefix: #EXT-X-I-FRAME-STREAM-INF is trick-play, not a
      // rendition anyone wants, and it does not start with this.
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        const a = hlsAttrs(line);
        // The URI is the next non-comment line, not an attribute.
        let uri = '';
        for (let j = i + 1; j < lines.length; j++) {
          const n = lines[j].trim();
          if (!n || n.startsWith('#')) continue;
          uri = n; i = j; break;
        }
        const abs = absFrom(uri, base);
        if (!abs) continue;
        const [w, h] = String(a.RESOLUTION || '').split('x').map((n) => +n || 0);
        renditions.push({
          url: abs, kind: 'video', width: w || 0, height: h || 0,
          tbr: Math.round((+a['AVERAGE-BANDWIDTH'] || +a.BANDWIDTH || 0) / 1000),
          codecs: a.CODECS || '', fps: +a['FRAME-RATE'] || 0, lang: '', name: '',
        });
      } else if (line.startsWith('#EXT-X-MEDIA')) {
        const a = hlsAttrs(line);
        // No URI means the track is muxed into the video rendition already.
        if (!a.URI) continue;
        const t = String(a.TYPE || '').toLowerCase();
        if (t !== 'audio' && t !== 'subtitles') continue;
        const abs = absFrom(a.URI, base);
        if (!abs) continue;
        renditions.push({
          url: abs, kind: t === 'audio' ? 'audio' : 'subtitle',
          width: 0, height: 0, tbr: 0, codecs: '', fps: 0,
          lang: a.LANGUAGE || '', name: a.NAME || '',
        });
      }
    }
    return { kind: 'hls', encrypted, encMethod, renditions };
  }

  function parseDash(text, base) {
    let doc;
    try { doc = new DOMParser().parseFromString(text, 'application/xml'); } catch (_) { return null; }
    if (!doc || doc.querySelector('parsererror')) return null;
    // A type selector with no namespace prefix matches any namespace, which is
    // what makes this work against the MPD default xmlns without declaring it.
    if (!doc.querySelector('MPD')) return null;
    const encrypted = !!doc.querySelector('ContentProtection');
    const renditions = [];
    doc.querySelectorAll('Representation').forEach((r) => {
      const set = r.closest('AdaptationSet');
      const mime = r.getAttribute('mimeType') || set?.getAttribute('mimeType') || '';
      // image/* is a thumbnail strip for scrubbing, not a rendition of the video.
      // Kept out of the picker for the same reason HLS's I-FRAME playlists are:
      // offering it as a quality would be offering a contact sheet.
      const kind = /audio/i.test(mime) ? 'audio'
        : /text|ttml|vtt/i.test(mime) ? 'subtitle'
        : /image/i.test(mime) ? 'thumbnail' : 'video';
      // BaseURL is the case we can turn into a URL. A SegmentTemplate describes a
      // thousand segments and no single file, so that rendition is still worth
      // DESCRIBING — the resolution is true either way — but it gets no link.
      const bu = r.querySelector('BaseURL')?.textContent?.trim()
        || set?.querySelector(':scope > BaseURL')?.textContent?.trim() || '';
      renditions.push({
        url: bu ? absFrom(bu, base) : '',
        kind,
        width: +r.getAttribute('width') || 0,
        height: +r.getAttribute('height') || 0,
        tbr: Math.round((+r.getAttribute('bandwidth') || 0) / 1000),
        codecs: r.getAttribute('codecs') || set?.getAttribute('codecs') || '',
        fps: 0,
        lang: set?.getAttribute('lang') || '',
        // A Representation id is only worth showing when it is a NAME. Most are
        // serial numbers, and "audio · 13" tells a person nothing they can act on.
        name: /^\d+$/.test(r.getAttribute('id') || '') ? '' : (r.getAttribute('id') || ''),
      });
    });
    return { kind: 'dash', encrypted, encMethod: encrypted ? 'CENC' : '', renditions };
  }

  // The manifest a player is using when the element itself only carries blob:.
  // MSE hands the element a synthetic URL, so `video.src` is worthless — but the
  // object that built it still knows where the text came from. Each library keeps
  // it somewhere slightly different; these are the shapes that occur.
  const PLAYER_PROPS = ['hls', 'shakaPlayer', 'dashPlayer', 'player', '_player', 'dash', '_hls'];
  const playerUrl = (o) => {
    if (!o || typeof o !== 'object') return '';
    try {
      if (typeof o.getAssetUri === 'function') return String(o.getAssetUri() || '');   // shaka
      if (typeof o.getSource === 'function') return String(o.getSource() || '');       // dash.js
      if (typeof o.url === 'string') return o.url;                                     // hls.js
      if (typeof o.src === 'string') return o.src;
    } catch (_) {}
    return '';
  };

  const manifestBefore = found.size;
  const MANIFEST_MAX = 8;            // per frame — a bound, not a sample of one
  const MANIFEST_MS = 4000;
  const MANIFEST_BYTES = 1 << 20;

  async function readManifest(url) {
    const ctl = new AbortController();
    const bail = setTimeout(() => ctl.abort(), MANIFEST_MS);
    try {
      // same-origin credentials ONLY. This is a file the player already read; it
      // is no reason to hand anyone's cookies to a third-party host.
      const r = await fetch(url, { credentials: 'same-origin', signal: ctl.signal, redirect: 'follow' });
      if (!r.ok) return null;
      const buf = await r.arrayBuffer();
      if (buf.byteLength > MANIFEST_BYTES) return null;
      const text = new TextDecoder().decode(buf);
      // Sniffed from the BODY, never from the name. That is the whole point: the
      // Azure/Smooth bridge serves a master playlist from
      // …/manifest(format=m3u8-aapl), which no extension test can ever reach.
      if (/^\s*#EXTM3U/.test(text)) return parseHls(text, r.url || url);
      if (/<MPD[\s>]/.test(text)) return parseDash(text, r.url || url);
      // Fetched cleanly, and it is not a manifest. That is an ANSWER, and a
      // different one from "could not check" — see `disproved` below.
      return { notManifest: true };
    } catch (_) { return null; } finally { clearTimeout(bail); }
  }

  {
    const cands = [];
    const push = (u) => { const a = absFrom(u, location.href); if (a) cands.push(a); };

    // Anything already typed as a stream.
    for (const it of found.values()) if (it.type === 'stream') cands.push(it.url);

    // Players holding a manifest the element hides behind blob:.
    document.querySelectorAll('video, audio').forEach((el) => {
      for (const p of PLAYER_PROPS) {
        const u = playerUrl(el[p]);
        if (u && !u.startsWith('blob:')) push(u);
      }
    });

    // A BLOB-BACKED PLAYER'S REAL SEGMENTS ARE ALREADY IN `found` — step 2 above
    // (`everything the page already downloaded`) sweeps every typed network
    // response unconditionally, blob or no blob, so X's own player (using none
    // of the PLAYER_PROPS shapes, since it is neither hls.js, Shaka nor dash.js)
    // needed no special recovery at all: confirmed live, navigating straight to
    // one of its captured `video.twimg.com/…/vid/avc1/…mp4` urls played the clip
    // end to end in Chrome's own player, even though HoloScrape's OWN capture of
    // that same url (via the page's own byte-range-sliced fetch) showed only a
    // ~1KB init segment — the smallness was the page's own request shape, not a
    // property of the file.
    //
    // What step 2 does NOT do: an adaptive stream fetches several resolutions of
    // the SAME clip, and every one lands in `found` as its own unrelated file —
    // three or more near-duplicate rows for one video. `SIZE_PARAM` below already
    // collapses this for an image CDN's WIDTH/HEIGHT QUERY PARAMS; a video's
    // resolution instead sits in its own PATH SEGMENT (".../0/0/1280x720/hash.mp4"),
    // which that regex never sees. Grouped here on everything but the last two
    // segments (the resolution folder and the fragment filename) — the part every
    // bitrate variant of one clip shares — keeping only the largest.
    {
      const groups = new Map(); // shared prefix -> { url, area }
      for (const [url, it] of found) {
        if (it.type !== 'video') continue;
        const parts = url.split('/');
        if (parts.length < 3) continue;
        const m = url.match(/(\d+)x(\d+)/);
        if (!m) continue; // no declared resolution — nothing to rank it against
        const key = parts.slice(0, -2).join('/');
        const area = +m[1] * +m[2];
        const g = groups.get(key);
        if (!g || area > g.area) groups.set(key, { url, area });
      }
      for (const [key, winner] of groups) {
        for (const [url] of found) {
          if (url === winner.url) continue;
          const parts = url.split('/');
          if (parts.length < 3) continue;
          if (parts.slice(0, -2).join('/') === key) found.delete(url);
        }
      }
    }

    // WHICH TWEET A VIDEO FILE BELONGS TO — learned from the page, not fetched.
    //
    // The file survived the collapse above as a real, complete-when-fetched-correctly video
    // (see the note above it), but its own url carries an internal media id
    // ("amplify_video/<id>/…"), not the tweet's — there is no way to ask X's public,
    // unauthenticated syndication endpoint for a clean, direct, CORS-open mp4 without the
    // TWEET's id specifically (confirmed live: `cdn.syndication.twimg.com/tweet-result?id=…`
    // returns `mediaDetails[].video_info.variants[]`, plain `video/mp4` urls, one measured at
    // 17MB with `access-control-allow-origin: *` — a real file, not a fragment).
    //
    // The two ids ARE linked on the page, with no request needed to see it: a post's own
    // `<video poster="…/amplify_video_thumb/<id>/…">` carries the SAME internal id as its
    // `amplify_video/<id>/…` file, and the enclosing `article[data-testid="tweet"]` carries
    // the tweet's own id in its permalink. Cross-referencing the two here means the lightbox
    // can resolve the clean url LATER, only for the one file someone actually opens, instead
    // of this scan resolving every video on the page whether anyone looks at it or not.
    //
    // KEPT ACROSS SCANS, NOT REBUILT EACH TIME. X's timeline is virtualized — a post scrolled
    // past unmounts within seconds — and this function runs fresh on every scan, including the
    // panel's own 2.5-second passive poll. A map rebuilt from only what is CURRENTLY mounted
    // would associate a video with its tweet only in the narrow window where a scan happens to
    // land while that exact post is still on screen, and lose the association forever the
    // moment it scrolls away — the same "measured this instant, not accumulated" mistake
    // already fixed once this session for row uniqueness (`snapshotRows` in rows.js). Living on
    // `window` survives exactly as long as that fix's own accumulator does: the tab's lifetime.
    try {
      if (!window.__holoscrapeVideoStatus) window.__holoscrapeVideoStatus = new Map();
      const videoIdToStatus = window.__holoscrapeVideoStatus;
      document.querySelectorAll('article[data-testid="tweet"]').forEach((art) => {
        const permalink = art.querySelector('a[href*="/status/"]');
        const sm = permalink?.getAttribute('href')?.match(/status\/(\d+)/);
        if (!sm) return;
        art.querySelectorAll('[poster]').forEach((el) => {
          const vm = (el.getAttribute('poster') || '').match(/amplify_video_thumb\/(\d+)\//);
          if (vm) videoIdToStatus.set(vm[1], sm[1]);
        });
      });
      if (videoIdToStatus.size) {
        for (const [url, it] of found) {
          if (it.type !== 'video') continue;
          const vm = url.match(/(?:amplify_video|ext_tw_video)\/(\d+)\//);
          const statusId = vm && videoIdToStatus.get(vm[1]);
          if (statusId) it.statusId = statusId;
        }
      }
    } catch (_) {}

    // THE CAPTURED URL IS OFTEN NOT A PLAYABLE FILE; THE APP'S OWN STORE HAS ONE THAT IS.
    //
    // X streams video as CMAF/DASH, so what the network capture sees is frequently a tiny
    // init segment or one timed fragment — reported live as "904 B · This browser can't play
    // this file", and it downloads as a broken file too, which is worse than an honest
    // failure because it looks like it worked. The existing `statusId` path above can only
    // help when the poster cross-reference happens to match, and for those fragments it
    // routinely does not.
    //
    // X's own Redux store carries `video_info.variants` on every media entity it has loaded:
    // the real mp4s, several bitrates, keyed by the SAME internal id that appears in the
    // captured url. So this is a local lookup — no network call, no syndication token, no
    // cross-referencing — that swaps an unplayable fragment for the whole file. `playUrl` is
    // kept BESIDE the captured url rather than overwriting it, so what was actually seen on
    // the wire is still reported truthfully; the panel prefers `playUrl` when it exists.
    try {
      const st = window.scroller?.context?.store?.getState?.();
      const cached = st?.entities?.tweets?.entities;
      if (cached) {
        const byVideoId = new Map();
        for (const t of Object.values(cached)) {
          const media = Array.isArray(t?.entities?.media) ? t.entities.media : [];
          for (const m of media) {
            const vid = m?.id_str;
            const vs = Array.isArray(m?.video_info?.variants) ? m.video_info.variants : [];
            if (!vid || !vs.length) continue;
            let best = '';
            let top = -1;
            for (const v of vs) {
              if (v?.content_type !== 'video/mp4' || !v.url) continue;
              const rate = Number(v.bitrate) || 0;
              if (rate >= top) { top = rate; best = v.url; }
            }
            if (best) byVideoId.set(String(vid), best);
          }
        }
        if (byVideoId.size) {
          // ONE ENTRY PER VIDEO, AND IT IS THE FILE THAT PLAYS.
          //
          // DASH delivery means one clip arrives as SEVERAL captured requests: a video
          // fragment (`/vid/avc1/0/0/...`) and a separate audio track (`/aud/mp4a/...`),
          // each a few hundred bytes. Listed as-is they are two rows per video, both
          // sub-1KB, and the audio one can never play as a video no matter what url is
          // attached to it — reported live as a Files list full of unplayable entries.
          // So when the store gives us the real file, that url REPLACES the fragment's
          // (size, preview and download then all describe the thing itself) and the other
          // fragments of the same clip are dropped rather than left as decoys.
          const keep = new Map();   // video id -> the one item that survives for that clip
          const remove = [];
          for (const [url, it] of found) {
            if (it.type !== 'video') continue;
            const id = url.match(/(?:amplify_video|ext_tw_video)\/(\d+)\//)?.[1];
            const real = id && byVideoId.get(id);
            if (!real) continue;
            remove.push(url);
            // The VIDEO fragment is the better carrier than the audio one — same clip
            // either way once the url is replaced, but its dimensions and type describe
            // something watchable, and an `/aud/` row that lost a race would keep 0x0.
            const isVid = url.includes('/vid/');
            const held = keep.get(id);
            if (held && !(isVid && !held.fromVid)) continue;
            it.playUrl = real;
            it.fromVid = isVid;
            // The fragment's measured size describes the fragment, not the clip. Cleared so
            // the normal measure pass reports the real file instead of "903 B".
            if (real !== it.url) { it.url = real; it.bytes = 0; it.measured = false; }
            keep.set(id, it);
          }
          for (const url of remove) found.delete(url);
          for (const it of keep.values()) { delete it.fromVid; found.set(it.url, it); }
        }
      }
    } catch (_) {}

    // Requests that smell like a manifest but carry no extension we recognise.
    // These used to be counted in the diagnosis and thrown away.
    try {
      resourceLog().forEach((e, name) => {
        if (e.t < since) return;
        if (typeOf(name)) return;
        if (!SMELLS.test(name)) return;
        push(name);
      });
    } catch (_) {}

    const seen = new Set();
    const queue = cands.filter((u) => !seen.has(u) && !!seen.add(u)).slice(0, MANIFEST_MAX);
    // Concurrent: eight bounded GETs of a few kilobytes each, so the whole pass
    // costs one round trip rather than eight.
    const read = halted() ? [] : await Promise.all(queue.map(readManifest));

    let encCount = 0;
    queue.forEach((u, i) => {
      const parsed = read[i];
      // Fetched, and demonstrably not a manifest. Only the ones whose URL never
      // proved anything are retracted: those were typed `stream` because a player
      // config listed them, and Vimeo's config points at its own playlist.json
      // alongside the real m3u8. A URL ending .m3u8 keeps its type — the body may
      // simply have been an error page, and disagreeing with the name on that
      // basis would be worse than the row we are removing.
      if (parsed?.notManifest) { if (!typeOf(u)) disproved.add(u); return; }
      if (!parsed) return;
      manifests.set(u, parsed);
      add(u, 'manifest', null, 'stream', pageTitle);
      const it = found.get(u);
      if (!it) return;
      // We read the body, so the type is no longer a claim to be checked later,
      // and the hls/dash guess from the extension is replaced by what it IS.
      it.tags = (it.tags || []).filter((t) => t !== 'unverified' && t !== 'hls' && t !== 'dash');
      it.tags.push(parsed.kind);
      // `maybe-master` was a guess from the filename. We have read the body, so it
      // is now answerable: no #EXT-X-STREAM-INF means this is a media playlist.
      if (!parsed.renditions.length) it.tags = it.tags.filter((t) => t !== 'maybe-master');
      if (parsed.encrypted) { it.tags.push('encrypted'); encCount++; }
    });

    const readOk = read.filter(Boolean).length;
    if (queue.length) {
      log.push(`manifests: read ${readOk}/${queue.length}`
        + (found.size > manifestBefore ? `, +${found.size - manifestBefore} unnamed` : '')
        + (encCount ? `, ${encCount} encrypted (refused)` : ''));
    }
  }

  // --- collapse variants -----------------------------------------------------
  // The same asset arrives many times: srcset width variants, and format
  // alternates (x.mp3 / x.m4a). One row per asset, formats offered as a choice.
  // Without this, Unsplash reports 350 "images" for 40 actual photos.
  // Image CDN transform params (imgix, Cloudinary, Next.js, Shopify, Contentful).
  // Two URLs differing only in these are the SAME asset at a different size.
  // Parameters that can only ever mean "render it this way".
  const SIZE_PARAM = /^(w|h|width|height|quality|fm|format|auto|fit|crop|dpr|ixlib|ixid|cs|ch|blend|sharp|usm|rect|ar|max-w|max-h|size|scale|resize|tr|bg|pad|mask|border|flip|rot|trim|sat|con|bri|exp|gam|vib|nr|lossless|dpi|fp-x|fp-y|fp-z|cropmode|gravity|anchor|quality_auto|f_auto|mw|mh|maxw|maxh)$/i;
  // Short names that mean a size on one CDN and identify the asset on the next.
  // `q` is the case that matters: it is quality on imgix and Cloudinary, and it
  // is the whole query on an image search endpoint — /images?q=tbn:ANd9Gc… .
  // Treating it as quality collapsed a page of search results into one row.
  // A quality is a small number; an identifier is not, so the value decides.
  const AMBIG_PARAM = /^(q|s|v|t|ver|version|cb|rev|hash)$/i;
  const looksLikeSize = (v) => /^\d{1,4}$/.test(v);
  // `f` is a format on Vimeo's image CDN (?f=webp) and an identifier on plenty of
  // other hosts, so the VALUE decides — the same rule AMBIG_PARAM uses for `q`.
  // Without it one Vimeo poster arrived as three rows: ?f=webp, ?mw=2600&mh=1462
  // and ?mw=80, all the same picture at three sizes.
  const FMT_PARAM = /^(f|out|output|ext)$/i;
  const FMT_VALUE = /^(webp|jpe?g|png|avif|gif|auto)$/i;
  const EXT_RANK = ['mp3', 'm4a', 'ogg', 'wav', 'flac', 'mp4', 'webm', 'mov', 'jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'svg', 'pdf', 'zip', 'm3u8', 'mpd'];
  const extOf = (u) => (String(u).match(/\.([a-z0-9]{2,5})(?:\?|$)/i) || [undefined, ''])[1].toLowerCase();
  const widthOf = (u) =>
    declaredWidth.get(u) || +((String(u).match(/[?&](?:w|width|max-w|maxw|mw|size)=(\d{2,5})/i) || [])[1] || 0);

  // Build-tool CDNs (Gatsby, Hugo, Next static) put the asset id and the size
  // variant in the path:  /static/<asset-hash>/<variant-hash>/cover.jpg
  // A SHORT hex segment is a variant; a LONG one identifies the asset. Dropping
  // the short ones is what collapses five "cover.jpg" rows into one image.
  const isVariantSeg = (seg) => /^[0-9a-f]{4,10}$/i.test(seg) || /^[0-9]{2,4}x[0-9]{2,4}$/i.test(seg);

  function assetKey(url, type) {
    // An explicit grouping from the page beats every heuristic below, because it
    // is knowledge rather than inference.
    if (assetGroup.has(url)) return assetGroup.get(url);
    // Never group streams. Renditions sit at sibling paths (/1080/index.m3u8,
    // /720/index.m3u8) and the variant-segment heuristic would fold distinct
    // manifests into one, hiding the master behind a rendition.
    if (type === 'stream') return url;
    try {
      const u = new URL(url);
      const segs = u.pathname.split('/').filter(Boolean);
      let file = segs.pop() || '';
      // Strip the extension only when it IS one. Stripping any trailing
      // dot-segment turned arxiv.org/pdf/2607.24720 into /pdf/2607 — the same key
      // as every other paper that month, so 50 papers collapsed into one row.
      // typeOf is the same authority the rest of the scan uses, so this can never
      // drift from the list of extensions we actually recognise.
      const tail = /\.[a-z0-9]{2,5}$/i.exec(file);
      if (tail && typeOf('x' + tail[0])) file = file.slice(0, -tail[0].length);
      const kept = segs.filter((s) => !isVariantSeg(s));
      const path = '/' + [...kept, file].join('/');
      if (path.replace(/\W/g, '').length < 4) return url; // too generic to group on
      const q = [];
      u.searchParams.forEach((v, k) => {
        if (SIZE_PARAM.test(k)) return;
        if (AMBIG_PARAM.test(k) && looksLikeSize(v)) return;
        if (FMT_PARAM.test(k) && FMT_VALUE.test(v)) return;
        q.push(k + '=' + v);
      });
      return `${type}|${u.host}${path}${q.length ? '?' + q.sort().join('&') : ''}`;
    } catch { return url; }
  }

  const groups = new Map();
  for (const it of found.values()) {
    const k = assetKey(it.url, it.type);
    if (!groups.has(k)) groups.set(k, { ...it, variants: [] });
    const g = groups.get(k);
    g.variants.push(it.url);
    if (!g.title && it.title) g.title = it.title;       // best title across variants
    if (it.source === 'peek') g.source = 'peek';
    // Whether ANY variant of this asset was a real element on the page. The
    // tracker SHAPE guess is only ever made about a URL nothing pointed at, so
    // one variant arriving from an <img> disproves it for the whole group.
    g.dom = g.dom || !/^(network|peek-network)/.test(it.source || '');
    g.tags = [...new Set([...(g.tags || []), ...(it.tags || [])])];
  }

  // What a rendition is called in the picker. A height is what people recognise;
  // the bitrate is what distinguishes two renditions at the same height.
  const rateOf = (t) => (t >= 1000 ? `${(t / 1000).toFixed(1)} Mbps` : `${t} kbps`);
  const rlabel = (r) => (r.kind === 'video'
    ? [r.height ? `${r.height}p` : r.width ? `${r.width}w` : 'video', r.tbr ? rateOf(r.tbr) : '']
    : [r.kind, r.name || r.lang || '']).filter(Boolean).join(' · ');

  // A rendition indexed by a master we are already showing is not a separate asset.
  // A player requests them individually as it switches quality, so the network log
  // ends up holding five siblings of one video — and before the master could be
  // read there was no way to tell that from five unrelated streams. Now there is.
  const childUrls = new Set();
  for (const m of manifests.values()) for (const r of m.renditions) if (r.url) childUrls.add(r.url);
  const isChild = (g) => g.type === 'stream' && childUrls.has(g.url)
    && !manifests.get(g.url)?.renditions.length;   // a master is never folded away

  // Two manifests we have READ that index the same ladder are one manifest served
  // by two CDNs. Vimeo hands out both a vod-adaptive-ak and a skyfire copy of the
  // same playlist, under signed paths that share not one segment — so no URL rule
  // could ever pair them. Ten renditions agreeing on resolution AND bitrate is not
  // a coincidence; two renditions is the floor, below which it could be.
  const ladder = (m) => (m && m.renditions.length >= 2
    ? m.kind + '|' + m.renditions.map((r) => `${r.kind}:${r.width}x${r.height}:${r.tbr}`).sort().join(',')
    : '');
  const SIZE_TAGS = new Set(['tiny', 'small', 'large']);
  const seenLadder = new Set();
  const isMirror = (g) => {
    if (g.type !== 'stream') return false;
    const fp = ladder(manifests.get(g.url));
    if (!fp || seenLadder.has(fp)) return !!fp;
    seenLadder.add(fp);
    return false;
  };

  const items = [...groups.values()]
    .filter((g) => !disproved.has(g.url) && !isChild(g) && !isMirror(g))
    .map((g) => {
    // A stream is not a file, so its picker cannot be a list of formats. It is
    // the renditions the manifest indexes — and NOTHING when the manifest was
    // unreadable or encrypted. Offering "m3u8" was always an offer of 2KB of
    // playlist; offering renditions we may not assemble would be worse.
    if (g.type === 'stream') {
      const man = manifests.get(g.url);
      const rends = (man && !man.encrypted ? man.renditions : [])
        .filter((r) => r.kind !== 'thumbnail');
      return {
        ...g,
        encrypted: !!man?.encrypted,
        encryption: man?.encMethod || null,
        // Best rendition first, so the row's own width/height describe the stream.
        variants: rends.slice().sort((a, b) => (b.height - a.height) || (b.tbr - a.tbr))
          .map((r) => ({ ...r, label: rlabel(r) })),
        formats: [],
        w: g.w || Math.max(0, ...rends.map((r) => r.width)),
        h: g.h || Math.max(0, ...rends.map((r) => r.height)),
      };
    }
    // Two URLs with the same format AND the same width are the same file twice.
    const byShape = new Map();
    for (const u of new Set(g.variants)) {
      const shape = `${extOf(u)}|${widthOf(u)}`;
      if (!byShape.has(shape)) byShape.set(shape, u);
    }
    const uniq = [...byShape.values()];
    uniq.sort((a, b) => {
      const wd = widthOf(b) - widthOf(a);            // biggest image wins
      if (wd) return wd;
      const ra = EXT_RANK.indexOf(extOf(a)), rb = EXT_RANK.indexOf(extOf(b));
      if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);  // most playable format
      return b.length - a.length;
    });
    // Size class describes a VARIANT, not an asset, and the merge above unions
    // tags across every one of them — so an 80px thumbnail made the 1280px photo
    // it belongs to read as `small`, and a filter for real pictures dropped it.
    // Re-derived from the variant actually chosen.
    // Images only, matching tagsFor: a size class is about a picture, and a 1280px
    // MP4 is not a "large" anything — it is one of four qualities of a video.
    let tags = g.tags || [];
    if (g.type === 'image') {
      const w0 = widthOf(uniq[0]);
      tags = tags.filter((t) => !SIZE_TAGS.has(t));
      if (w0 && w0 < TINY_MAX_W) tags.push('tiny');
      else if (w0 && w0 < SMALL_MAX_W) tags.push('small');
      else if (w0 >= LARGE_MIN_W) tags.push('large');
    }

    return {
      ...g,
      url: uniq[0],
      tags,
      variants: uniq.map((u) => ({
        url: u,
        width: widthOf(u) || null,
        label: widthOf(u) ? `${extOf(u) || 'file'} · ${widthOf(u)}w` : (extOf(u) || 'file'),
      })),
      // A format has to be one we actually recognise. Requiring only "has a
      // letter" let a URL ending in a bare domain produce a chip reading "com",
      // and a sized CDN path produce one reading "54".
      formats: [...new Set(uniq.map((u) => extOf(u)).filter((f) => f && typeOf('a.' + f)))],
    };
  });

  // A host serving many images is a CDN; a host serving a single extensionless
  // "image" is a beacon. Frequency tells them apart without a blocklist, which
  // is the only approach that keeps pace with ad networks minting new domains.
  // This is why Tokopedia's ~60 product photos survive while one udmserve pixel
  // on the same page does not.
  const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u); } };
  const imgPerHost = new Map();
  for (const it of items) {
    if (it.type !== 'image') continue;
    const h = hostOf(it.url);
    imgPerHost.set(h, (imgPerHost.get(h) || 0) + 1);
  }
  for (const it of items) {
    if (it.type !== 'image' || !(it.tags || []).includes('tracker')) continue;
    // Only the SHAPE guess is revocable. A known ad host or a beacon path stands
    // however many files it serves.
    if (TRACKER_HOST.test(it.url) || TRACKER_PATH.test(it.url)) continue;
    // Two ways the guess is revoked. Frequency: a host serving many images is a
    // CDN. Provenance: the guess is only ever made about a URL nothing pointed
    // at, so a sibling variant arriving from a real <img> refutes it outright —
    // which is what saved Vimeo's poster, seen once in the network log at a size
    // the page never rendered and once as the picture itself.
    if (it.dom || (imgPerHost.get(hostOf(it.url)) || 0) >= 3) {
      it.tags = it.tags.filter((t) => t !== 'tracker');
    }
  }
  // Internal to the collapse — not something the table or an export should carry.
  for (const it of items) delete it.dom;

  // Weight, applied last so the frequency rule above cannot revoke it. A 1x1
  // transparent GIF is 43 bytes; nothing under half a kilobyte is a picture
  // anyone wants. This is the only test that survives CNAME cloaking, where the
  // tracker is served from the site's own subdomain and looks first-party — no
  // host list can catch that, and an extension cannot resolve DNS to unmask it.
  for (const it of items) {
    // Bytes on the wire, where the browser was allowed to tell us. Carried onto
    // the item so the table can show a real number instead of a dash.
    // An inlined file already knows its own size exactly — it was counted from
    // the URL, which IS the file — and there is no wire entry to overwrite it with.
    it.bytes = wireSize.get(it.url) || it.bytes || 0;
    // Fall back to the srcset descriptor when the image was never decoded.
    if (!it.w) it.w = declaredWidth.get(it.url) || 0;
    if (it.type !== 'image' || (it.tags || []).includes('tracker')) continue;
    if (it.bytes && it.bytes < TRACKER_MAX_BYTES) it.tags.push('tracker');
  }

  const RANK = { hidden: -40, photo: -8, large: -6, banner: 4, thumbnail: 6, logo: 8, small: 9, avatar: 12, icon: 14, tiny: 16 };
  items.sort((a, b) => {
    const w = (x) => (x.tags || []).reduce((n, t) => n + (RANK[t] || 0), 0);
    return w(a) - w(b);
  });

  const collapsed = found.size - items.length;
  if (collapsed > 0) log.push(`collapsed ${collapsed} duplicate variant(s)`);
  log.push(`total: ${items.length} asset(s)`);

  // --- why nothing? -----------------------------------------------------------
  // An empty result is only useful if it says WHICH empty it is. "We never got
  // in", "the player uses MSE so no file exists", and "we saw the manifest and
  // dropped it for having no extension" look identical to a user and need three
  // different fixes. Read after the fact, so this works for a passive scan too.
  const diagnosis = { mse: blobHits, drm: null, nearMisses: [] };
  document.querySelectorAll('video, audio').forEach((m) => {
    if (String(m.currentSrc || m.src || '').startsWith('blob:')) diagnosis.mse++;
    // Set once EME has negotiated a licence — definitive, and needs no patching.
    if (m.mediaKeys) diagnosis.drm = diagnosis.drm || m.mediaKeys.keySystem || 'unknown';
  });
  // Requests that smelled like a manifest and are STILL unaccounted for. The read
  // pass above takes the same list and tries to prove each one by its body, so
  // anything left here is a genuine miss rather than a name we could not parse.
  try {
    resourceLog().forEach((e, name) => {
      if (!/xmlhttprequest|fetch/i.test(e.it || '')) return;
      if (typeOf(name)) return;              // already captured, not a miss
      if (!SMELLS.test(name)) return;
      if (found.has(absFrom(name, location.href))) return;  // read and promoted
      if (diagnosis.nearMisses.length < 8) diagnosis.nearMisses.push(name);
    });
  } catch (_) {}
  if (diagnosis.mse) log.push(`${diagnosis.mse} media element(s) using blob:/MSE`);
  if (diagnosis.drm) log.push(`DRM in use (${diagnosis.drm})`);
  if (diagnosis.nearMisses.length) log.push(`${diagnosis.nearMisses.length} unrecognised manifest-like request(s)`);
  if (staleHits) log.push(`${staleHits} held over from the previous route, dropped`);
  stampScan();
  return {
    items, log, url: location.href, diagnosis,
    frame: { url: location.href, top: !isSubframe, peeked: mayPeek },
    // frames/framesPeeked are 1 here and SUM across frames when merged, so the
    // panel can say how much of the page we actually reached.
    coverage: {
      triggers, clicked, skipped, dismissed, blockedDownloads, unmatched, collapsed, screens, stopped, staleHits,
      deep: !!opts.peek, frames: 1, framesPeeked: mayPeek ? 1 : 0,
    },
  };
}
