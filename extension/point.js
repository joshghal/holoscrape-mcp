// HoloScrape — pointing at a control.
//
// Runs inside the page's own JS world and must stay fully self-contained:
// chrome.scripting.executeScript serialises this function to source, so no imports and
// no closures over module scope.
//
// This exists because a word list cannot be finished. A census of 102 list pages in 21
// languages found the only structural invariant of a load-more is "a button with no
// destination" — which says what isn't one and can never find one whose wording we do
// not know. Icon-only controls, text baked into an SVG: unreachable by vocabulary.
// Pointing has no recall ceiling.
export async function pagePoint(op = {}) {
  const K = '__holoscrapePoint';

  // Verbs a list is never extended by. Pointing overrides the finder's caution about
  // links, but not this: a scan presses repeatedly, and pressing "Delete" or "Pay"
  // repeatedly is not something to offer whatever the user meant.
  const FORBIDDEN = new RegExp([
    'delete', 'remove', 'hapus', 'sil\\b', 'l[öo]schen', 'удалить', 'supprimer',
    'unsubscribe', 'berhenti\\s*langganan', 'abmelden',
    'checkout', 'check\\s*out', 'buy\\s*now', 'beli\\s*sekarang', 'pay\\b', 'bayar',
    'satın\\s*al', 'kaufen', 'acheter', 'comprar', 'оплатить',
    'log\\s*out', 'sign\\s*out', 'keluar\\b',
  ].join('|'), 'i');

  const CTL = 'button,a,[role="button"],input[type="submit"],input[type="button"]';

  const describe = (el) => {
    const text = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim();
    const aria = el.getAttribute('aria-label') || el.title || '';
    const tag = el.tagName === 'A' ? 'link'
      : el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' ? 'button'
      : el.tagName.toLowerCase();
    // Whether this NAVIGATES is a question about the href, not about what the element
    // calls itself. role="button" used to disqualify an anchor here, and a <button>
    // wrapped in <a href> was never examined at all — so a pager built either way
    // reported navigates:false, the panel took it for a load-more, pressed it, and the
    // tab turned the page. Blibli's next-page control is exactly this: an icon-only
    // control that the tooltip called a button and that goes to ?page=2&start=40.
    const nav = el.tagName === 'A' ? el : el.closest('a[href]');
    const href = nav?.getAttribute('href') || '';
    return {
      tag,
      label: (text || aria).slice(0, 60),
      iconOnly: !text && !aria,
      navigates: !!href && !/^#|^javascript:/i.test(href),
      href: href.slice(0, 120),
      // The whole thing, resolved. `href` above is shortened for a sentence in the
      // panel; a next-page URL has to survive intact — Alibaba's carries a dozen query
      // parameters and the first 120 characters of it fetch nothing.
      url: (() => { try { return href ? new URL(href, location.href).href : ''; } catch (_) { return ''; } })(),
      forbidden: FORBIDDEN.test(`${text} ${aria}`),
      inForm: !!el.closest('form') && (el.type === 'submit' || el.tagName === 'BUTTON' && !el.type),
    };
  };

  // A stable-ish path for the chosen element. Same rules the row engine's selectors
  // follow: ids containing digits are generated and worse than useless as an anchor.
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      if (n.id && !/\d/.test(n.id)) { parts.unshift(`${s}#${n.id}`); break; }
      const cls = Array.from(n.classList || []).filter((c) => !/^holoscrape-/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.map((c) => CSS.escape(c)).join('.');
      else {
        const sibs = Array.from(n.parentElement?.children || [])
          .filter((x) => x.tagName === n.tagName);
        if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(n) + 1})`;
      }
      parts.unshift(s);
      if (parts.length >= 6) break;
    }
    return parts.join('>');
  };

  if (op.action === 'stop') {
    if (window[K]) window[K].teardown();
    return { ok: true };
  }

  if (op.action === 'resolve') {
    let el = null;
    try { el = document.querySelector(op.selector); } catch (_) {}
    // Front-chop, exactly as the row engine's selector recovery does: a path that no
    // longer matches from the top very often still matches from further in.
    if (!el && op.selector) {
      const bits = op.selector.split('>');
      for (let i = 1; i < bits.length && !el; i++) {
        try { el = document.querySelector(bits.slice(i).join('>')); } catch (_) {}
      }
    }
    if (!el) return { found: false };
    const r = el.getClientRects()[0];
    return { found: true, ...describe(el), onScreen: !!r };
  }

  if (window[K]) window[K].teardown();

  // --- the overlay ----------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    .hs-point-hit{outline:2px solid #ffb648!important;outline-offset:2px!important;
      background:rgba(255,182,72,.10)!important}
    .hs-point-cap{position:fixed;z-index:2147483647;pointer-events:none;
      background:#0b1017;color:#eef4fb;border:1px solid rgba(255,182,72,.5);
      border-radius:6px;padding:5px 9px;font:12.5px/1.35 system-ui,sans-serif;
      max-width:320px;box-shadow:0 6px 20px rgba(0,0,0,.45)}
    .hs-point-cap b{color:#ffb648;font-weight:500}
    .hs-point-cap i{color:#8fa8c4;font-style:normal}
    html.hs-pointing,html.hs-pointing *{cursor:crosshair!important}`;
  (document.head || document.documentElement).appendChild(style);
  document.documentElement.classList.add('hs-pointing');

  const cap = document.createElement('div');
  cap.className = 'hs-point-cap';
  cap.textContent = 'Point at the control that loads more';
  document.body.appendChild(cap);

  let hit = null;
  const paint = (el) => {
    if (hit === el) return;
    if (hit) hit.classList.remove('hs-point-hit');
    hit = el;
    if (!hit) { cap.textContent = 'Point at the control that loads more'; return; }
    hit.classList.add('hs-point-hit');
    const d = describe(hit);
    cap.innerHTML = d.forbidden
      ? `<b>${d.tag}</b> · “${d.label}” — <i>not a list control</i>`
      : `<b>${d.tag}</b> · ${d.iconOnly ? '<i>icon only</i>' : `“${d.label}”`}`
        + (d.navigates ? ' — <i>leaves the page</i>' : '');
    const r = hit.getClientRects()[0];
    if (r) {
      cap.style.left = `${Math.max(6, Math.min(innerWidth - 330, r.left))}px`;
      cap.style.top = `${r.bottom + 8 > innerHeight - 40 ? Math.max(6, r.top - 34) : r.bottom + 8}px`;
    }
  };

  // The nearest thing that is actually a control; otherwise whatever is under the
  // cursor, so an icon-only div that a site wired a click onto is still pickable.
  const target = (el) => (el && (el.closest(CTL) || el)) || null;

  const onMove = (e) => paint(target(e.target));

  // THE critical part. Choosing a control is not the same act as operating it, and a
  // user who fires "Delete account" while pointing at things has been failed by us.
  // Capture phase, prevent default, stop everything: the site's own handler never runs.
  // We press it afterwards, deliberately, as a test we control.
  const swallow = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();
  };

  let settle = null;
  const finish = (payload) => { if (settle) { const f = settle; settle = null; f(payload); } };

  const onClick = (e) => {
    swallow(e);
    const el = target(e.target);
    if (!el) return;
    const d = describe(el);
    if (d.forbidden || d.inForm) {
      // Refused on the page, where the pointing is happening, rather than in the panel
      // — the answer belongs next to the thing that was pointed at.
      cap.innerHTML = `<b>refused</b> · “${d.label}” ${d.forbidden ? 'is not a list control' : 'submits a form'}`;
      return;
    }
    finish({ picked: true, selector: pathOf(el), ...d });
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { swallow(e); finish({ cancelled: true }); return; }
    if (e.key === 'Enter' && hit) { swallow(e); onClick({ ...e, target: hit, preventDefault() {}, stopImmediatePropagation() {}, stopPropagation() {} }); }
  };
  // Focus follows Tab through the page's own controls, so this works without a mouse —
  // the one escape hatch we have must not be mouse-only.
  const onFocus = (e) => paint(target(e.target));

  const opts = { capture: true, passive: false };
  addEventListener('mousemove', onMove, opts);
  addEventListener('pointerdown', swallow, opts);
  addEventListener('mousedown', swallow, opts);
  addEventListener('mouseup', swallow, opts);
  addEventListener('click', onClick, opts);
  addEventListener('keydown', onKey, opts);
  addEventListener('focusin', onFocus, opts);

  const teardown = () => {
    removeEventListener('mousemove', onMove, opts);
    removeEventListener('pointerdown', swallow, opts);
    removeEventListener('mousedown', swallow, opts);
    removeEventListener('mouseup', swallow, opts);
    removeEventListener('click', onClick, opts);
    removeEventListener('keydown', onKey, opts);
    removeEventListener('focusin', onFocus, opts);
    if (hit) hit.classList.remove('hs-point-hit');
    document.documentElement.classList.remove('hs-pointing');
    cap.remove();
    style.remove();
    delete window[K];
    finish({ cancelled: true });
  };
  window[K] = { teardown };

  // Resolves when something is picked, cancelled, or the wait runs out. A pointing mode
  // left on forever would be a page the user cannot use.
  return await new Promise((resolve) => {
    settle = (payload) => { const t = window[K]; window[K] = null; if (t) t.teardown = () => {}; 
      // tear the listeners down before answering, so the page is usable the instant
      // the choice is made rather than after a round trip to the panel.
      removeEventListener('mousemove', onMove, opts);
      removeEventListener('pointerdown', swallow, opts);
      removeEventListener('mousedown', swallow, opts);
      removeEventListener('mouseup', swallow, opts);
      removeEventListener('click', onClick, opts);
      removeEventListener('keydown', onKey, opts);
      removeEventListener('focusin', onFocus, opts);
      if (hit) hit.classList.remove('hs-point-hit');
      document.documentElement.classList.remove('hs-pointing');
      cap.remove(); style.remove();
      resolve(payload);
    };
    setTimeout(() => finish({ cancelled: true, timedOut: true }), op.waitMs || 120000);
  });
}
