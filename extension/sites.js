// What we know about a site before scanning it.
//
// Four states, and the difference between the middle two is the whole point:
//
//   blocked   — we refuse. DRM, or Chrome Web Store policy, or both.
//   thin      — we scan, but the page structurally holds little to find, and we
//               say why up front instead of letting a near-empty result read as
//               a broken tool.
//   verified  — scanned end to end and confirmed, either by the test suite or by
//               hand. Named types, so the claim is checkable.
//   unknown   — never checked here. The default, and not a warning: most of the
//               web is unknown and most of it works.
//
// `thin` is deliberately NOT a block. Blocking removes the chance of finding the
// thing; a note only sets expectations, and if the note turns out to be wrong the
// user still gets their files. A wrong block is silent, a wrong note is not.

import { UNBLOCK } from './env.js';

export const SITES = [
  // --- blocked ---------------------------------------------------------------
  // Two hard reasons, both independent: the media arrives as encrypted expiring
  // segments so there is no file to take, and store policy prohibits extensions
  // that download from these services.
  { hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'], status: 'blocked',
    why: 'Streams are DRM-protected and store policy prohibits downloading from it.' },
  { hosts: ['netflix.com', 'primevideo.com', 'disneyplus.com', 'hulu.com', 'max.com'],
    status: 'blocked', why: 'Video is DRM-protected — there is no file sitting there to take.' },
  { hosts: ['spotify.com', 'tidal.com', 'deezer.com', 'audible.com'],
    status: 'blocked', why: 'Audio is DRM-protected and store policy prohibits downloading from it.' },

  // --- thin ------------------------------------------------------------------
  // Not a judgement about the site, a fact about how it delivers. Each note names
  // the mechanism so it can be checked — and disproved — rather than believed.
  //
  // Note on Google: blocking every Google domain would be the wrong instrument.
  // These are the user's own documents and photos, not a policy problem, and
  // googleusercontent.com is a CDN that serves images for half the web. What is
  // true is narrower: these particular apps put no file URLs on the page.
  { hosts: ['drive.google.com'], status: 'thin',
    why: 'Drive lists files by id, not by URL. Only thumbnails are on the page; the file itself lives behind a download endpoint built from your session.' },
  { hosts: ['docs.google.com'], status: 'thin',
    why: 'Docs, Sheets and Slides are drawn to a canvas. There is no document file on the page to find.' },
  { hosts: ['photos.google.com'], status: 'thin',
    why: 'Photos delivers through blob: URLs assembled in JavaScript, which no extension can reach.' },
  { hosts: ['mail.google.com'], status: 'thin',
    why: 'Attachments are fetched with a token the page builds for itself.' },
  { hosts: ['figma.com'], status: 'thin',
    why: 'The canvas is WebGL. Frames are drawn, not loaded as files.' },
  { hosts: ['maps.google.com'], status: 'thin',
    why: 'Map tiles are drawn to a canvas, and the imagery is not a file you can take.' },

  // --- verified --------------------------------------------------------------
  // Only what has actually been run. `suite` means the automated tests cover it
  // on every run; `manual` means it was scanned by hand and the result read.
  // Was `verified · finds audio and images`, and is not any more. Pixabay serves an
  // automated browser a page that never comes alive: every script returns 200, no
  // framework global is ever set, and the play controls carry no event listener on
  // themselves or any ancestor (checked with DOMDebugger.getEventListeners). Clicks land
  // on real buttons and nothing happens — no request, no Audio(), no play(), no error.
  // Images still come back, because those are in the served HTML.
  //
  // A person browsing normally sees none of this. The note is written for the case where
  // it happens to someone, so an empty audio list reads as a known limit rather than as a
  // broken tool. Not `blocked`: the images are real and worth having.
  { hosts: ['pixabay.com'], status: 'thin',
    why: 'Pixabay does not start its player for an automated browser, so previews cannot be opened here. Images on the page are still found.' },
  { hosts: ['unsplash.com'], status: 'verified', by: 'suite', finds: 'images, with size variants' },
  { hosts: ['pixelpoint.io'], status: 'verified', by: 'suite', finds: 'images' },
  { hosts: ['developer.mozilla.org'], status: 'verified', by: 'suite', finds: 'images' },
  { hosts: ['arxiv.org'], status: 'verified', by: 'manual', finds: 'PDFs, named after the paper' },
  { hosts: ['gutenberg.org'], status: 'verified', by: 'manual', finds: 'EPUB and other book formats' },
  { hosts: ['elements.envato.com'], status: 'verified', by: 'manual', finds: 'audio previews and images' },
  { hosts: ['tokopedia.com'], status: 'verified', by: 'manual', finds: 'product images' },

  // VERIFIED ON ONE PATH, NOT ON A WHOLE HOST — the first entry that needs `only`.
  //
  // x.com/home has been worked over exhaustively: the timeline is a recycler that mounts about
  // nine cells however far you scroll, and reading it properly meant going to the app's own
  // Redux store (see `provider-x.js`). All of that was measured, tuned and re-measured against
  // the home timeline and nothing else. A profile, a search, a bookmarks page, a single post's
  // replies — each is a different component with a different store slice, and claiming the host
  // is "tested" would extend a promise that was only ever earned on one route.
  //
  // `only` is a path pattern; a host match OUTSIDE it reports `partial`. That is the honest
  // third answer between "tested" and "we have never seen this" — and the one page where
  // pointing at the agent is genuinely the better tool, because a custom field or an unusual
  // route is exactly what it does and what a fixed descriptor cannot.
  { hosts: ['x.com', 'twitter.com'], status: 'verified', by: 'manual',
    only: '^/home/?$',
    finds: 'posts with author, text, time, engagement, images and video',
    elsewhere: 'Only the home timeline has been tested on X. Other pages — profiles, search, '
      + 'replies — each render differently, so the scan is a best guess there.' },
];

const matches = (host, d) => host === d || host.endsWith('.' + d);

export function siteStatus(url) {
  let host, path = '/';
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, '');
    path = u.pathname || '/';
  } catch { return { status: 'unknown' }; }
  for (const s of SITES) {
    const hit = s.hosts.find((d) => matches(host, d));
    if (!hit) continue;
    // A CLAIM SCOPED TO THE ROUTE IT WAS EARNED ON. An entry carrying `only` was verified on
    // that path and nowhere else on the host, so anywhere else it reports `partial` — neither
    // "tested" (a promise that was never earned there) nor "unknown" (the host IS known, and
    // what is known about it is useful). See the x.com entry for the case this exists for.
    if (s.only && !new RegExp(s.only).test(path)) {
      return { ...s, host: hit, status: 'partial', verifiedPath: s.only };
    }
    // Lifted for development. Reported as `thin` rather than as an ordinary site,
    // because everything the block said is still TRUE — the streams are still
    // encrypted and the policy still stands — and a build that hides that while
    // scanning anyway is how a temporary switch becomes permanent.
    if (UNBLOCK && s.status === 'blocked') {
      return { ...s, host: hit, status: 'thin', lifted: true,
        why: `${s.why} Blocked in production; lifted in this development build.` };
    }
    return { ...s, host: hit };
  }
  return { status: 'unknown', host };
}

// The blocked list, derived rather than kept in parallel. It used to be written
// out twice — once in the worker and once in the panel — which is exactly the
// shape of thing that drifts.
//
// Empty when UNBLOCK is set, which is the whole mechanism: every refusal in the
// worker, the panel and the frame guard reads this one list, so lifting it lifts
// all three and there is no fourth copy to forget.
export const RESTRICTED = UNBLOCK ? [] : SITES
  .filter((s) => s.status === 'blocked')
  .flatMap((s) => s.hosts);
