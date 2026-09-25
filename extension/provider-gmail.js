// GMAIL — an inbox is a list whose pager carries no address, and that is the whole file.
//
// Nothing here is imported by the injected engine. `rows.js` is serialised to source by
// `chrome.scripting.executeScript` and cannot import, so this DESCRIPTOR is plain serialisable
// data: patterns as strings, selectors as strings, traits as scalars — the same door
// `provider-shopee.js` and `provider-x.js` use.
//
// MEASURED LIVE on mail.google.com, signed in, 2026-09-21, against the person's own inbox while
// it stood on its third page. Full account in `GMAIL-PAGER-HAS-NO-ADDRESS.md`. The four facts
// that shaped this file:
//
//   1. THE URL DOES NOT MOVE. The tab read `#inbox` while the page showed `101–150 of 8,614`.
//      Every route this extension had to a second page — a `?page=` dial, a `/page/N` path, a
//      `rel=next` anchor, two addresses pasted by the person — reads the address bar, and the
//      address bar says page one forever. The paste-two-addresses card cannot be answered here,
//      and it was: both boxes held the same string, and the panel said "I could not read a page
//      number out of those". `grows: 'pager-click'` is the declaration that turns that card off.
//
//   2. THE PAGER IS TWO ICON BUTTONS THAT IGNORE A SCRIPTED CLICK. `div[role=button]` with an
//      `aria-label` and a `cleardot.gif`, driven by closure's jsaction, which gates its handler on
//      `event.isTrusted`. `el.click()` does nothing — confirmed by reading the same 50 rows before
//      and after (`test/walk-trusted-click.mjs`). The walk therefore escalates to a real
//      CDP-dispatched press when the list did not change — see `pressForReal` in the worker.
//      `next` names the control THREE ways because two of them are fragile: `aria-label` and
//      `data-tooltip` are localised ("Older" is English), while the arrow icon's class is not —
//      `img.amJ` is the older arrow and `img.amI` the newer one, on a button whose own classes
//      (`amD`) are shared by both. `:has()` on the icon is the hook that survives a language change.
//
//   3. THE ONLY CONTROL THAT SAYS "MORE" IS A MENU. `[aria-label="Show more messages"]` is the
//      count dropdown ("101–150 of 8,614", opens Newest/Oldest), and the wording finder took it
//      for a load-more: the log shows it pressed seven times in a row with the count never moving
//      and the list never growing. A provider that declares how it grows is never searched for a
//      load-more (`findLoadMore`), which is what stops that. The same count is also the ONE place
//      the page number can be read from, so `pageLabel` names it: `.Dj` reads "101–150 of 8,614",
//      and 101–150 at fifty a page is page three.
//
//   4. THE ROWS CARRY NO LINKS AT ALL. A thread row is `tr.zA`, `jsaction`-driven, with no `<a>`;
//      the generic column namer gets `Text 1 … Text 9`. The row's own cells carry the facts under
//      stable hooks — the sender in `span.zF[email][name]`, the subject in `.y6 .bog`, the snippet
//      in `.y2`, the exact time in the date cell's `title`, and the thread id in `span.bqe` — so
//      the fields are named here. Class hooks like `zA`/`zF`/`bog`/`y6`/`xW`/`Dj` are Gmail's own
//      component names and have been stable for many years; nothing here keys on a `:kw`-style
//      generated id.
export const descriptor = {
  id: 'gmail',
  host: '(^|\\.)mail\\.google\\.com$',
  path: '^/mail/',

  // The visible thread table. Gmail's categorised inbox holds one such table per tab panel with
  // the inactive ones `display:none`, so the engine matches this preferring a VISIBLE hit.
  list: 'div[role="main"] table.F > tbody',

  // Pages turn by pressing, and the address never changes. See fact 1.
  grows: 'pager-click',

  // The "Older" arrow, named by icon first and by localised text second. See fact 2.
  next: 'div[role="main"] [role="button"]:has(img.amJ), '
    + 'div[role="main"] [role="button"][aria-label="Older"], '
    + 'div[role="main"] [role="button"][data-tooltip="Older"]',

  // Where the page number can be read: "101–150 of 8,614". See fact 3.
  pageLabel: 'div[role="main"] .Dj',

  // Named fields, read off the row instead of guessed from its shape. `css` reads text,
  // `css@attr` reads that attribute, both relative to one `tr.zA`.
  fields: {
    From: 'span.zF@name',
    Email: 'span.zF@email',
    Subject: '.y6 .bog',
    Snippet: '.y2',
    Date: 'td.xW span@title',
    Thread: 'span.bqe@data-legacy-thread-id',
  },
};
