// Merging one scan result per frame into one result per page.
//
// Kept out of background.js so it can be tested directly: it is a pure function
// and it carries the one rule that is easy to get wrong (see below).

// `results` is what chrome.scripting.executeScript returns with allFrames:true —
// one entry per frame, unordered, some with a null result.
//
// The returned URL must come from the TOP frame. Keying a page's results on an
// iframe's URL would file them under a player CDN or an ad server, and the
// per-page history would stop matching the page you were actually on.
export function mergeFrames(results, tabUrl) {
  const frames = (results || []).map((r) => r?.result).filter(Boolean);
  if (!frames.length) {
    return { items: [], log: ['no result'], url: tabUrl || '', diagnosis: { mse: 0, drm: null, nearMisses: [] } };
  }
  const top = frames.find((f) => f.frame?.top) || frames[0];

  const items = [], seen = new Set(), cov = {};
  // The reason a page yielded nothing usually lives in the CHILD frame — the
  // embed is what uses MSE or DRM, not the document around it.
  const diagnosis = { mse: 0, drm: null, nearMisses: [] };
  let embedded = 0;
  for (const f of frames) {
    const d = f.diagnosis;
    if (d) {
      diagnosis.mse += d.mse || 0;
      diagnosis.drm = diagnosis.drm || d.drm || null;
      for (const u of d.nearMisses || []) {
        if (diagnosis.nearMisses.length < 12 && !diagnosis.nearMisses.includes(u)) diagnosis.nearMisses.push(u);
      }
    }
    for (const it of f.items || []) {
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      // Tagged so the results table can show where it came from — an asset the
      // top document never referenced is exactly what this feature is for.
      if (f.frame?.top) items.push(it);
      else { items.push({ ...it, tags: [...new Set([...(it.tags || []), 'embedded'])] }); embedded++; }
    }
    for (const [k, v] of Object.entries(f.coverage || {})) {
      if (typeof v === 'number') cov[k] = (cov[k] || 0) + v;
      else if (v) cov[k] = v; // `deep` is true if ANY frame ran deep
    }
  }

  const log = [...(top.log || [])];
  if (cov.frames > 1) log.push(`${cov.frames} frames scanned, ${cov.framesPeeked || 0} clicked`);
  if (embedded) log.push(`${embedded} asset(s) from embedded frames`);
  return { items, log, url: top.url || tabUrl || '', coverage: cov, diagnosis };
}
