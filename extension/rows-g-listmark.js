  // --- dispatch -------------------------------------------------------------
    // THE LIST'S FINGERPRINT, defined once because two copies would never have matched.
    //
    // `clicknext` takes it before pressing and `atpage` takes it after, and the walk advances only
    // when they differ — that is how we know the ROWS changed and not merely the address bar. If
    // the two computed it differently the comparison could never succeed and every walk would stop
    // after one page, which is exactly what happened when this was called from both places and
    // defined in neither: a ReferenceError, shown to the user as "the pager would not take us
    // further". `node --check` cannot catch that, and no fixture exercised it.
    //
    // Generic on purpose — the longest href per row is what `identOf` already treats as a row's
    // identity, so this is the same notion of "which rows are these" the rest of the engine uses.
    // THE LIST'S CONTAINER, RE-FOUND AFTER A RE-RENDER.
    //
    // `cand.el` is a node captured when the list was detected, and a single-page app turning a page
    // replaces the container's contents — sometimes the container — so that reference is detached.
    // Falling back to `querySelector(cand.selector)` is not enough either: the selector is a chain
    // six levels deep, and the ancestors re-render too, so the whole chain misses.
    //
    // Measured on blibli: the mark BEFORE a press was product text and the mark AFTER was the
    // footer's links, every single time. Two different scopes, so every comparison looked like a
    // change, so the walk declared the page turned the instant it was pressed — `msList=4` — and
    // extracted before the new rows existed. Page two came back half-rendered at 18 rows and page
    // three re-read those same 18: `saw=18 fresh=0`, and it stopped at three of twenty.
    //
    // So the chain is trimmed from the front until something matches, exactly as `harvest` does to
    // re-attach a remembered container. The tail describes the container; the head only describes
    // where it used to sit.
    // The list as it stands NOW, which after a page turn is not the node we remember. All of the
    // re-finding lives in `reattach`, next to `recount`, because the mark and the rows have to
    // agree about which container they are describing: a fingerprint taken over the new page
    // while the rows come off the old one is worse than no fingerprint at all.
    const listRoot = () => {
      const cand = reattach(window[S]?.cands?.[window[S].i]);
      return cand?.el?.isConnected ? cand.el : null;
    };

    const listMark = () => {
      const seen = [];
      try {
        // SCOPED TO THE LIST, NOT THE DOCUMENT — and this is the whole bug on a real shop.
        //
        // This used to scan every `a[href]` on the page and keep the first six that looked like a
        // record. On 2GIS that is harmless: `/firm/` appears nowhere but the list. On blibli the
        // first six matches are the HEADER — nav and promo links carrying four-digit ids — which
        // are byte-identical on page one and page twenty. So the fingerprint was never empty and
        // never changed, the walk pressed the pager correctly, saw no difference, and reported
        // "pressing that control brought no new rows — this looks like the last page" while
        // sitting on page one of twenty.
        //
        // The list's own container is the only honest place to look for the list's identity.
        const scope = listRoot() || document;
        for (const a of scope.querySelectorAll('a[href]')) {
          const h = a.getAttribute('href') || '';
          if (!h || /^(#|javascript:)/i.test(h)) continue;
          if (!/\/(firm|place|item|product)\/|\/\d{4,}/.test(h)) continue;
          seen.push(h.split('?')[0]);
          if (seen.length >= MARK_LINKS) break;
        }
      } catch (_) {}
      // AND A FALLBACK, BECAUSE THE LIST ABOVE IS A GUESS AT WHAT A RECORD URL LOOKS LIKE.
      //
      // `/firm/ /place/ /item/ /product/` plus "four digits after a slash" covers 2GIS and Maps and
      // was written from them. Blibli's products are `…/ps--SAM-70048-00001` — the digits sit mid
      // segment — so nothing matched, the fingerprint came back EMPTY, and empty never differs from
      // empty. The walk pressed the pager correctly, could not tell that anything had happened, and
      // reported "brought no new rows" on page one of twenty.
      //
      // So when no href matches, fingerprint the rows themselves. Only reached when the href pass
      // found nothing, so no site that works today changes behaviour.
      if (!seen.length) {
        try {
          // READ FROM THE LIVE DOM, NEVER FROM REMEMBERED NODES.
          //
          // `cand.rows` holds element references captured when the list was detected. A
          // single-page app turns a page by replacing the container's `innerHTML`, which DETACHES
          // every one of them — and a detached node keeps its text forever. So a fingerprint built
          // from them reports page one's rows for the rest of the run: measured on the fixture,
          // `clicked=true via=number` with the mark byte-identical before and after, and the walk
          // concluding "this looks like the last page" on page one of twenty.
          //
          // The CONTAINER survives that swap (it is the thing being filled), so its current
          // children are the honest answer. Re-queried by selector if the container itself went.
          const box = listRoot();
          for (const kid of [...(box?.children || [])].slice(0, MARK_ROWS)) {
            const t = (kid.innerText || kid.textContent || '').replace(/\s+/g, ' ').trim();
            if (t) seen.push(t.slice(0, MARK_TEXT_CHARS));
          }
        } catch (_) {}
      }
      return seen.join('|');
    };

