#!/usr/bin/env node
// Resolve a real, downloadable mp4 url for an X (Twitter) post from the command line — no MCP
// server, no browser, no pairing, just X's public syndication API. The CLI counterpart to the
// `resolve_x_video` MCP tool (see tools.mjs) and to `downloadAll`'s automatic use of the same
// resolver (background.js's results.download pipeline) — all three are this one file,
// `x-video-resolve.js`, called from a different door.
//
//   node mcp/resolve-video.mjs <x.com/twitter.com post url OR bare status id> [videoId]
//
//   node mcp/resolve-video.mjs https://x.com/Rainmaker1973/status/2100940406632640943
//   node mcp/resolve-video.mjs 2100940406632640943
//   node mcp/resolve-video.mjs 2101249943553908738 2100967670447308801   (disambiguate a multi-video tweet)
import { resolveXVideo, statusIdFromUrl } from './x-video-resolve.js';

const [arg, videoId] = process.argv.slice(2);
if (!arg) {
  console.error('usage: node resolve-video.mjs <x.com/twitter.com post url OR bare status id> [videoId]');
  process.exit(1);
}
const statusId = /^\d+$/.test(arg) ? arg : statusIdFromUrl(arg);
if (!statusId) {
  console.error(`could not find a status id in "${arg}" — pass the post's url or its bare numeric id`);
  process.exit(1);
}
let url;
try {
  url = await resolveXVideo(statusId, videoId || null);
} catch (e) {
  console.error(`lookup failed: ${e.message || e}`);
  process.exit(1);
}
if (!url) {
  console.error(`no video found for status ${statusId} — no video on the post, or it is gone/protected`);
  process.exit(1);
}
console.log(url);
