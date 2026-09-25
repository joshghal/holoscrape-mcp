// X (TWITTER) VIDEO RESOLUTION, SHARED BY THE EXTENSION AND THE MCP SERVER.
//
// A captured X video asset is frequently NOT a file that plays: `video.twimg.com/amplify_video/...`
// urls are session-bound (they answer 0 bytes to a fetch made outside the person's own signed-in
// browser), and X's newer CMAF/DASH delivery hands out a small init segment plus separately-fetched
// `.m4s` timed fragments named by millisecond range — a captured asset url is often just ONE of
// those fragments, which plays a second or two and stops.
//
// X's own public syndication API sidesteps both problems: `cdn.syndication.twimg.com/tweet-result`
// is the same unauthenticated endpoint X's oEmbed-style embeds use, keyed by the TWEET's id (not the
// video's own internal id) plus a token derived from it with a documented, widely-used formula. Its
// `mediaDetails[].video_info.variants[]` are plain `video/mp4` urls, third-party-fetchable, nothing
// session-bound about them at all — measured live, `access-control-allow-origin: *`.
//
// COPIED BYTE-IDENTICAL into three places, the same discipline `mcp/index.mjs` already keeps between
// the two HoloScrape repos: `x-video-resolve.js` here (imported by `background.js`, browser side),
// `mcp/x-video-resolve.js` (imported by the local dev copy of the MCP server), and
// `holoscrape-mcp/x-video-resolve.js` (the published npm package). It can be one file because both
// runtimes have plain global `fetch` and `BigInt` — nothing here is browser- or Node-specific.
//
// table.js keeps its OWN small copy of this rather than importing it, on purpose — it is loaded as a
// classic (non-module) script for load-ordering reasons (see the comment above its <script> tag in
// table.html) and cannot `import`. Two tiny copies of a pure function is cheaper than making that
// tag a module for this alone.

export function syndicationToken(id) {
  // Split via BigInt before the float math — a tweet id is 19 digits now, past
  // Number.MAX_SAFE_INTEGER (16), so converting it to a Number directly first can silently drop
  // precision the token formula then bakes in wrong. High and low 15-digit halves added back
  // together keeps every digit through the conversion.
  const n = BigInt(id);
  const HALF = 1000000000000000n;
  return ((Number(n / HALF) + Number(n % HALF) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

// statusId: the tweet/post id. wantId: optional — the specific video's OWN internal id (from its
// captured asset url's amplify_video/<id>/ or ext_tw_video/<id>/ segment), to disambiguate a tweet
// that carries more than one video (a quote-post keeping its own clip alongside the quoted post's).
// Returns the best (highest-bitrate) plain mp4 url, or null — never throws for "no video", since
// that is an ordinary answer, not a failure.
export async function resolveXVideo(statusId, wantId = null) {
  if (!statusId) return null;
  let res;
  try {
    res = await fetch(
      `https://cdn.syndication.twimg.com/tweet-result?id=${statusId}&token=${syndicationToken(statusId)}`,
      { credentials: 'omit' },
    );
  } catch (_) { return null; }
  if (!res.ok) return null;
  let data;
  try { data = await res.json(); } catch (_) { return null; }
  const variantSets = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.variants)) variantSets.push(node.variants);
    for (const v of Object.values(node)) walk(v);
  })(data);
  for (const variants of variantSets) {
    const mp4 = variants.filter((v) => v.content_type === 'video/mp4');
    if (!mp4.length) continue;
    const matched = wantId ? mp4.filter((v) => v.url.includes(`/${wantId}/`)) : [];
    const pool = matched.length ? matched : mp4;
    // Highest bitrate first — the point of asking at all is the real, full-quality file.
    pool.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    if (pool[0]) return pool[0].url;
  }
  return null;
}

// For a caller holding the post's page url (a harvested column, a page_state row) rather than the
// bare numeric id.
export function statusIdFromUrl(url) {
  const m = String(url || '').match(/status(?:es)?\/(\d+)/);
  return m ? m[1] : null;
}

// For a caller holding a captured video asset's own url rather than its bare id.
export function videoIdFromUrl(url) {
  const m = String(url || '').match(/(?:amplify_video|ext_tw_video)\/(\d+)\//);
  return m ? m[1] : null;
}

// True for anything this module can help with — an X/Twitter status page url or a captured
// amplify_video/ext_tw_video asset url. The one hostname check this file has, kept in exactly one
// place so a caller never has to know X's domains itself.
export function looksLikeXVideoAsset(url) {
  return /(?:amplify_video|ext_tw_video)\/\d+\//.test(String(url || ''));
}
