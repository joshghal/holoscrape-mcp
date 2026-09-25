// Finding a way to contact a business on its OWN site.
//
// Runs inside the page, like `scan.js`, and must stay fully self-contained:
// `chrome.scripting.executeScript` serialises this function to source, so it can
// reference nothing outside itself.
//
// The list gives you a name, the record gives you a phone number, and the thing
// most people actually want — an address they can write to — is on the business's
// own website, in the footer or on a contact page. That is the third step, and it
// is a different problem from the first two: those read ONE site whose markup we
// have measured, this reads a hundred sites we have never seen.
//
// So it does not look for markup at all. It looks for the five places an email
// address can be, ranked by how much the page is willing to admit:
//
//   mailto:                the page says so itself. Nothing beats it.
//   data-cfemail           Cloudflare's obfuscation, which is a plain XOR and is
//                          on a great many small-business sites. Decoded, these
//                          are as good as mailto — and invisible without this.
//   JSON-LD                schema.org markup, which names the field `email`.
//   text                   a footer line. Common, and needs the junk filtered.
//   text, obfuscated       "sales (at) example (dot) com", written that way by
//                          people who did not want a scraper to read it.
//
// The last one is worth a word. Someone who writes their address that way is
// hiding it from bulk harvesters, and this tool is pointed at a list the user
// chose, one page at a time, at a person's reading speed. That is a different
// thing from harvesting the web — but it is close enough that it belongs in the
// open rather than in a comment nobody reads, so the results window says where
// each address came from and `(at)` is one of the answers.
// `root` and `here` EXIST SO THE SAME READER CAN RUN ON A PAGE NOBODY OPENED.
//
// Step three now fetches every site first and only opens the ones that answer with no address (see
// `driveSites`). A fetched body has no tab, so it is parsed with `DOMParser` in an offscreen
// document and handed in here as a detached `Document` — which has no `location`, hence `here`.
// Both default to the live page, so the tab path calls this exactly as it always did.
//
// ONE READER, NOT TWO. A second regex-over-HTML extractor for the fetch path was the obvious
// shape and is the wrong one: it would have its own idea of what an email is, its own junk list
// and its own bugs, and the two would drift the first time either was fixed. Everything below —
// the platform, the year, the tracking stack, the phones, the socials, the contact-page hop — is
// therefore identical on both paths by construction rather than by inspection.
//
// `tlds` is the IANA root zone as one space-joined string (see `tld.js`). It is an ARGUMENT and not
// an import because this function is serialised to source by `chrome.scripting.executeScript` and
// must stay self-contained. Passing nothing is allowed and means "do not validate", which is what
// the pattern did before — but every caller in this extension passes it.
export function pageMail(root, here, tlds) {
  const doc = root || (typeof document !== 'undefined' ? document : null);
  const HERE = here || (() => { try { return location.href; } catch (_) { return ''; } })();
  if (!doc) return { dead: true, emails: [], follow: [], len: 0 };
  const HOSTS = [];
  try {
    HOSTS.push(new URL(HERE).host.replace(/^www\./, '').toLowerCase());
  } catch (_) { /* about:blank, or a body fetched from nowhere */ }

  // THE ONLY LIST OF TOP-LEVEL DOMAINS ANYONE SHOULD WRITE, WHICH IS TO SAY: NOT ONE.
  // See `tld.js` for where it comes from and why it may not be hand-picked.
  const TLD = new Set(String(tlds || '').split(' ').filter(Boolean));

  // NOT AN EMAIL, however much it looks like one. Every one of these was found
  // in a real page by an earlier version of this function:
  //
  //   image@2x.png            a retina asset, matched because `@` and a dot
  //   a3f9…@sentry.io         an error-reporting DSN, on any site using Sentry
  //   you@example.com         placeholder copy in a form's own markup
  //   u003e@…                 an escaped fragment out of an inline JSON blob
  //
  // THE FETCH PATH MADE THIS LIST LOAD-BEARING IN A WAY THE TAB PATH NEVER DID. Measured over the
  // 116 sites of one export: 154 raw values, 89 of them junk, and 61 of those 89 a single class —
  // Wix's Sentry telemetry keys, `605a7bae…9123@sentry.wixpress.com`, fourteen on one site. They
  // sit in inline script, which is exactly where the tab path's TreeWalker refuses to look, so
  // they arrive only now. Two rules catch them and neither names Wix: the hex local part, and the
  // telemetry hosts. A generic rule ages better than one vendor's hostname.
  const JUNK = new RegExp([
    '\\.(png|jpe?g|gif|webp|svg|css|js|mjs|ico|woff2?|ttf|eot|pdf|zip|mp4|webm)$',
    '@(\\d+x|2x|3x)\\.',
    '@(example|domain|yourdomain|yoursite|mydomain|email|mail|test|localhost|sentry)\\.',
    '@sentry\\.',
    '@(\\d{1,3}\\.){3}\\d{1,3}$',            // an IP, which is a log line, not an address
    // PLACEHOLDER COPY, IN FIVE LANGUAGES. A contact form's `placeholder=` attribute is not an
    // address, and the deny-list that only knew `you@` and `name@` was an English-only list of
    // exactly the kind that has now caused three bugs here. The target markets are Indonesia,
    // Brazil, Turkey, Mexico and Argentina, so their words for "name", "example" and "email" are
    // as ordinary a placeholder as the English ones.
    '^(you|your|yours|name|yourname|firstname|lastname|firstlast|username|user|someone|somebody'
      + '|email|myemail|youremail|mailadresse|test|example|sample|placeholder|johndoe|janedoe'
      + '|nombre|correo|nome|contoh|ornek|isim|adiniz|namamu|namaanda)@',
    '^[0-9a-f]{16,}@',                        // a hash, so a DSN or a bounce id
    // The same thing wearing dashes: a UUID local part is a machine's handle, never a mailbox.
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@',
    '^u00[0-9a-f]{2}',                        // an escaped JSON fragment
    // WHERE ERROR REPORTS GO. `@sentry\.` above only catches a host that STARTS with `sentry.`;
    // the DSN form in the wild is `o12345.ingest.sentry.io` and `sentry.wixpress.com`.
    '(^|[@.])sentry\\.(io|wixpress\\.com)$', 'sentry-next\\.', 'ingest\\.sentry\\.',
    // THE SITE BUILDER'S OWN SUPPORT DESK, which is on the page of every site it built and is
    // never the business's address. Extending the list that already held five of these.
    'wixpress\\.com$', 'squarespace\\.com$', 'shopifyemail\\.com$',
    'godaddy\\.com$', 'wordpress\\.com$',
    'webador\\.com$', 'weebly\\.com$', 'jimdo\\.com$', 'strikingly\\.com$', 'site123\\.com$',
    'duda\\.co$', 'webflow\\.com$', 'wix\\.com$', 'squareup\\.com$',
    // AND THE BUILDER'S TEMPLATE ADDRESS, WHICH IS NOT IN ENGLISH. Found on a live Brazilian list
    // and not on either American one: `jlmanutencaoservic.wixsite.com` publishes
    // `info@meusite.com` — Wix's own demo address, "my site" translated. `mysite.com` is the same
    // string in the English template. A deny-list of English placeholders would have caught the
    // second and shipped the first, which is exactly the failure this tool keeps having: the
    // markets are Brazil, Turkey, Indonesia and Mexico, so the translated template IS the common
    // case. Other locales' variants are NOT covered and will surface the same way — as a
    // suspiciously popular domain nobody in the list owns.
    'mysite\\.com$', 'meusite\\.com$',
  ].join('|'), 'i');

  // A mailbox nobody reads, which is not the same as junk: it IS the site's
  // address and it is the last one to offer.
  const DEAD = /^(no-?reply|donotreply|do-not-reply|bounce|mailer-daemon|postmaster|abuse|dmarc|spam|server|root|daemon|cron)@/i;
  // The mailboxes a business puts on its own site for people to write to.
  const GOOD = /^(info|contact|hello|hi|hey|sales|enquir|inquir|admin|office|mail|support|help|team|book|reservation|orders?|customerservice|cs|marketing|business|kontak|kontakt|hubungi|ask|welcome)/i;
  // FREE MAIL IS NOT A DISQUALIFICATION, and this is a rule a measurement changed. An earlier
  // pass kept own-domain addresses only, and `weplumbatx.com` published
  // `zmecom.weplumb@gmail.com` — genuinely the owner's, on Gmail. Small businesses do this
  // constantly; a filter that drops them drops real leads (`MAPS-CHAIN.md`).
  //
  // So free mail ranks BELOW an address on the site's own domain and ABOVE one on some third
  // party's, which is the case the same measurement warned about the other way:
  // `info@somethemeauthor.com` in a footer belongs to whoever wrote the template, and
  // `customerservice@acaciasplumbing.com` on a competitor's site is a different business.
  const FREEMAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|gmx|web|mail|zoho|protonmail|proton|yandex|qq|163|naver|hanmail|daum|orange|free|sfr|laposte|libero|virgilio|alice|t-online|bluewin|telus|shaw|rogers|bigpond|optusnet|iinet|xtra|uol|bol|terra|hotmail\.co)\./i;

  const RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}/g;

  const found = new Map();   // address -> { via, score }
  // Ranked as they are added rather than sorted at the end, so the first source
  // to find an address decides how it is described. `mailto:` finding what the
  // text already held should still read as `mailto`.
  const VIA_RANK = { mailto: 5, cfemail: 5, jsonld: 4, text: 2, obfuscated: 1 };

  // "POWERED BY", WHICH IS SOMEBODY ELSE'S ADDRESS. Measured on real sites: a footer reading
  // `info@somethemeauthor.com` belongs to whoever built the template, and it beat the business's
  // own address whenever the business used a plain domain the reader could not match
  // (`MAPS-CHAIN.md`). The credit line is the signal — it is right next to the address, it is a
  // fixed handful of phrasings, and nothing else uses those words in front of an email.
  const CREDIT = /(powered|designed|built|developed|created|maintained|hosted|theme|template|site|website)\s+(by|for)\b[^.!?\n]{0,40}$/i;
  const credited = (el) => {
    try {
      const whole = el.parentElement?.textContent || '';
      const own = el.textContent || '';
      const i = own ? whole.indexOf(own) : -1;
      return CREDIT.test((i > 0 ? whole.slice(0, i) : whole).slice(-80));
    } catch (_) { return false; }
  };

  // WHERE THE ADDRESS ACTUALLY ENDS, which the pattern cannot know and kept getting wrong in BOTH
  // directions. `[A-Za-z]{2,24}` is any word, so:
  //
  //   "…fix your problem at home. The…"        ->  problem@home.the       invented
  //   "…theetplumbing@gmail.com.Have a…"       ->  theetplumbing@gmail.com.have    destroyed
  //
  // The second is the one worth the file: those were CORRECT addresses being thrown away, four of
  // them on one export. Trailing labels are dropped until the last one is a real TLD — which fixes
  // both cases with one rule, because `home.the` runs out of labels and `gmail.com.have` lands on
  // `gmail.com`.
  //
  // The capital is a second, narrower cut for the case the list cannot see: a sentence that
  // continues with a word which happens to BE a TLD (`.How`, `.New`, `.One`, `.Top` are all real).
  // Only `Capitalised` exactly — `INFO@ACME.COM` shouted in a footer must survive, and it does,
  // because dropping `COM` leaves `acme`, which is not a TLD, and the rule refuses to fire unless
  // what remains still ends in one.
  const endAt = (v) => {
    if (!TLD.size) return v;                   // no list passed: behave as before
    const at = v.lastIndexOf('@');
    if (at < 1) return '';
    const local = v.slice(0, at);
    let labels = v.slice(at + 1).split('.').filter(Boolean);
    const last = labels[labels.length - 1] || '';
    if (labels.length > 2 && /^[A-Z][a-z]+$/.test(last)
      && TLD.has((labels[labels.length - 2] || '').toLowerCase())) labels.pop();
    while (labels.length > 1 && !TLD.has(labels[labels.length - 1].toLowerCase())) labels.pop();
    if (labels.length < 2 || !TLD.has(labels[labels.length - 1].toLowerCase())) return '';
    return local + '@' + labels.join('.');
  };

  const add = (raw, via, credit) => {
    // TRIMMED AFTER THE SCHEME COMES OFF, not before, and this one space was a silent data loss.
    // `mailto:%20matthew@example.com` is written by hand on real sites; decoded it is
    // `mailto: matthew@…`, and stripping `mailto:` left a LEADING SPACE — so the split below
    // returned the empty string and the address was dropped entirely. (An extractor that does not
    // decode at all gets the other half of the same bug and reports `20matthew@…`.)
    let v = String(raw || '').trim().replace(/^mailto:/i, '').trim();
    // A mailto may carry a subject, several recipients, or a trailing full stop
    // from the sentence it was written in.
    v = v.split(/[?,;\s]/)[0].replace(/[.,;:)\]}>'"]+$/, '');
    // Case is still meaningful here — see `endAt` — so the lowercasing waits until after it.
    v = endAt(v).toLowerCase();
    if (!v || v.length > 120 || !/^[^@]+@[^@]+\.[a-z]{2,24}$/i.test(v)) return;
    if (JUNK.test(v)) return;
    const host = v.split('@')[1] || '';
    // Scored, because a site usually holds several and only one of them is the
    // one to write to. Highest wins; ties keep the first seen.
    let score = (VIA_RANK[via] || 0) * 10;
    const own = HOSTS.some((h) => host === h || host.endsWith('.' + h) || h.endsWith('.' + host));
    if (own) score += 40;
    else if (FREEMAIL.test(host)) score += 12;   // the owner's, on Gmail — see FREEMAIL
    else score -= 12;                            // the template author's, or a competitor's
    if (GOOD.test(v)) score += 20;
    if (DEAD.test(v)) score -= 60;
    if (credit) score -= 35;                     // written beside "Theme by" — see CREDIT
    const had = found.get(v);
    if (had && had.score >= score) return;
    found.set(v, { via: had && had.score >= score ? had.via : via, score,
      // Carried out so the table can say WHOSE address this is rather than leaving the user to
      // compare domains by eye on ninety rows.
      whose: own ? 'own domain' : FREEMAIL.test(host) ? 'free mail' : 'another domain' });
  };

  // --- 1. what the page links ------------------------------------------------
  // Every anchor, visible or not: a footer inside a closed accordion is still
  // the site's address, and `innerText` would not have shown it.
  try {
    for (const a of doc.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href') || '';
      // DECODED PER LINK, NOT PER PAGE. `decodeURIComponent` throws on a stray `%` — and this
      // loop is inside one `try`, so a single malformed href used to abandon every anchor after
      // it and take the page's whole mailto pass with it.
      if (!/^mailto:/i.test(h)) continue;
      let dec = h;
      try { dec = decodeURIComponent(h); } catch (_) {}
      add(dec, 'mailto', credited(a));
    }
  } catch (_) {}

  // --- 2. Cloudflare's email protection -------------------------------------
  // `<a class="__cf_email__" data-cfemail="a1c0cdc4…">[email&#160;protected]</a>`.
  // The first byte is the key and the rest is XORed with it. This is not a
  // circumvention of anything — Cloudflare's own script does exactly this in the
  // browser, and only runs when the page is being looked at. On a background tab
  // it often has not run, so the address is sitting there encoded and the text
  // reads "[email protected]".
  try {
    for (const el of doc.querySelectorAll('[data-cfemail]')) {
      const hex = el.getAttribute('data-cfemail') || '';
      if (!/^[0-9a-f]{6,}$/i.test(hex) || hex.length % 2) continue;
      const key = parseInt(hex.slice(0, 2), 16);
      let out = '';
      for (let i = 2; i < hex.length; i += 2) {
        out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
      }
      add(out, 'cfemail');
    }
    // The same encoding appears in the href of the link Cloudflare rewrites:
    // `/cdn-cgi/l/email-protection#a1c0cdc4…`.
    for (const a of doc.querySelectorAll('a[href*="/cdn-cgi/l/email-protection#"]')) {
      const hex = (a.getAttribute('href') || '').split('#')[1] || '';
      if (!/^[0-9a-f]{6,}$/i.test(hex) || hex.length % 2) continue;
      const key = parseInt(hex.slice(0, 2), 16);
      let out = '';
      for (let i = 2; i < hex.length; i += 2) {
        out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
      }
      add(out, 'cfemail');
    }
  } catch (_) {}

  // --- 3. schema.org -------------------------------------------------------
  // Structured data is the one place a site states its address as a FIELD
  // rather than as prose, so it needs no pattern matching and cannot be a
  // placeholder in body copy.
  try {
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      const txt = (s.textContent || '').slice(0, 200000);
      if (!/email/i.test(txt)) continue;
      // Walked rather than regexed, because `email` may be nested inside
      // `contactPoint`, `publisher`, or an array of them.
      let data = null;
      try { data = JSON.parse(txt); } catch (_) { continue; }
      const walk = (node, depth) => {
        if (!node || depth > 6) return;
        if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1); return; }
        if (typeof node !== 'object') return;
        for (const [k, v] of Object.entries(node)) {
          if (/^e-?mail$/i.test(k) && typeof v === 'string') add(v, 'jsonld');
          else walk(v, depth + 1);
        }
      };
      walk(data, 0);
    }
  } catch (_) {}

  // --- 4. the words on the page --------------------------------------------
  // A TreeWalker rather than `innerText` or `textContent`, for one reason each:
  // `innerText` drops anything not laid out, which loses the closed accordion;
  // `textContent` includes `<script>`, which is where the Sentry DSNs and the
  // inline JSON blobs live. This is the middle: every text node the reader
  // could reach, and nothing the browser was only executing.
  let text = '';
  try {
    const skip = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS)$/;
    const w = doc.createTreeWalker(doc.body || doc.documentElement,
      NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (skip.test(n.parentElement?.tagName || '')
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
    const parts = [];
    let len = 0;
    for (let n = w.nextNode(); n && len < 300000; n = w.nextNode()) {
      const s = n.nodeValue || '';
      if (!s.trim()) continue;
      parts.push(s);
      len += s.length;
    }
    text = parts.join('\n');
    // The eighty characters in front of the address, for the same credit-line check the anchors
    // get. This is the form it usually takes: "Website by Some Studio · hello@somestudio.com".
    for (const m of text.matchAll(RE)) {
      add(m[0], 'text', CREDIT.test(text.slice(Math.max(0, m.index - 80), m.index)));
    }
  } catch (_) {}

  // --- 5. written to be unreadable -----------------------------------------
  // "sales (at) example (dot) com", "info [@] example [dot] co.uk", and the
  // spaced form "info @ example . com". Only run when the plain pass found
  // nothing on the page's own domain, so an ordinary page never pays for it.
  try {
    if (text && ![...found.keys()].some((v) => HOSTS.includes(v.split('@')[1]))) {
      const deob = text
        .replace(/\s*[[({<]\s*(at|@)\s*[\])}>]\s*/gi, '@')
        .replace(/\s+(at|arroba)\s+/gi, '@')
        .replace(/\s*[[({<]\s*(dot|punto)\s*[\])}>]\s*/gi, '.')
        .replace(/\s+(dot|punkt|punto|titik)\s+/gi, '.')
        .replace(/\s*@\s*/g, '@')
        .replace(/\s*\.\s*(?=[a-z]{2,24}\b)/gi, '.');
      for (const m of deob.matchAll(RE)) add(m[0], 'obfuscated');
    }
  } catch (_) {}

  // --- what the page says about itself, which is worth more than the email ---
  //
  // An email is on about half of these sites (42-58%, measured — `MAPS-CHAIN.md`), so half the page
  // loads used to return nothing at all and cost exactly as much as the ones that worked. Everything
  // below is on the page we have ALREADY loaded, in the same injection, and it is there far more
  // reliably than an address is. The page visit stops being a coin toss.
  //
  // Read off ATTRIBUTES, not off the network. Blocking a request does not remove the element that
  // asked for it — see `SITE_BLOCKED` in background.js — so the `<script src>` of a tag manager we
  // refused to fetch is still sitting in the DOM, which is all this needs.
  const srcs = (() => {
    try {
      const out = [];
      for (const el of doc.querySelectorAll('script[src],link[href],img[src]')) {
        out.push(el.getAttribute('src') || el.getAttribute('href') || '');
        if (out.length > 400) break;
      }
      return out.join(' ').slice(0, 60000);
    } catch (_) { return ''; }
  })();

  // WHAT THE SITE IS BUILT ON. Two witnesses each: the `generator` meta, which is the honest answer
  // when it is there, and the CDN the assets come from, which cannot be turned off without breaking
  // the site. Ordered so the specific ones are tested before the general.
  const gen = (() => {
    try { return doc.querySelector('meta[name="generator" i]')?.getAttribute('content') || ''; }
    catch (_) { return ''; }
  })();
  const PLATFORMS = [
    ['Wix', /wix/i, /wixstatic\.com|parastorage\.com/i],
    ['Squarespace', /squarespace/i, /squarespace-cdn\.com|static1\.squarespace\.com/i],
    ['Shopify', /shopify/i, /cdn\.shopify\.com|shopifycloud/i],
    ['Webflow', /webflow/i, /website-files\.com|webflow\.com/i],
    ['GoDaddy', /godaddy|starfield/i, /img1?\.wsimg\.com/i],
    ['Duda', /duda/i, /multiscreensite\.com|dudamobile/i],
    ['HubSpot', /hubspot/i, /hs-scripts\.com|hubspotusercontent/i],
    ['Blogger', /blogger/i, /blogspot\.com|blogger\.com\/static/i],
    ['Joomla', /joomla/i, /\/media\/jui\/|\/media\/system\/js\//i],
    ['Drupal', /drupal/i, /\/sites\/(all|default)\/(files|themes|modules)\//i],
    // WordPress last: plenty of the above are built on it underneath, and the more specific name is
    // the more useful answer.
    ['WordPress', /wordpress/i, /\/wp-(content|includes)\//i],
  ];
  let platform = '';
  for (const [name, inGen, inSrc] of PLATFORMS) {
    if (inGen.test(gen) || inSrc.test(srcs)) { platform = name; break; }
  }

  // WHETHER THEY SPEND MONEY ON TRAFFIC. A business running a tag manager and a pixel is a business
  // with a marketing budget and somebody to talk to about it.
  const PIXELS = [
    ['GTM', /googletagmanager\.com\/gtm/i],
    ['GA', /google-analytics\.com|gtag\/js/i],
    ['Meta', /connect\.facebook\.net/i],
    ['TikTok', /analytics\.tiktok\.com/i],
    ['Hotjar', /hotjar\.(com|io)/i],
    ['Clarity', /clarity\.ms/i],
    ['LinkedIn', /snap\.licdn\.com/i],
  ];
  const pixels = PIXELS.filter(([, re]) => re.test(srcs)).map(([n]) => n);

  // IS THE SITE STILL LOOKED AFTER. The copyright line is the one date almost every site carries,
  // and a footer stuck on 2019 is a business whose website nobody has opened in years — which is
  // itself the lead, for anyone selling websites. Capped at the page's own idea of now, so a
  // "founded 2031" typo or a phone number that looks like a year cannot win.
  let year = 0;
  try {
    const now = new Date().getFullYear();
    const hay = (text || '').slice(-6000);
    for (const m of hay.matchAll(/(?:©|\(c\)|copyright)[^0-9]{0,24}(20\d\d)/gi)) {
      const y = +m[1];
      if (y >= 2000 && y <= now + 1) year = Math.max(year, y);
    }
    // No copyright line: any plausible year in the last stretch of the page, which is where a
    // footer lives. Weaker, so it only runs when the specific signal found nothing.
    if (!year) {
      for (const m of hay.matchAll(/\b(20[0-2]\d)\b/g)) {
        const y = +m[1];
        if (y >= 2005 && y <= now + 1) year = Math.max(year, y);
      }
    }
  } catch (_) {}

  // THE NUMBER A HUMAN ANSWERS, which is often not the one on Maps. Only `tel:` links, deliberately:
  // a regex over the text finds house numbers, prices, opening hours and licence numbers in every
  // locale that does not write phones the way the pattern expects, and a column that is wrong a
  // fifth of the time is worse than a column that is empty a third of the time.
  const phones = [];
  try {
    for (const a of doc.querySelectorAll('a[href^="tel:" i]')) {
      const v = decodeURIComponent((a.getAttribute('href') || '').replace(/^tel:/i, ''))
        .replace(/[^\d+]/g, '');
      // Seven digits is the shortest real subscriber number; below that it is an extension.
      if (v.replace(/\D/g, '').length >= 7 && !phones.includes(v)) phones.push(v);
      if (phones.length >= 4) break;
    }
  } catch (_) {}

  // WHERE ELSE THEY ARE. Off-site links the site itself publishes — its Instagram, its WhatsApp, its
  // Facebook page. In Brazil, Turkey and Indonesia these are more likely to get a reply than email.
  // A `wa.me` link here is EVIDENCE of WhatsApp; the phone number alone never is, so nothing is
  // derived from it.
  const SOCIAL = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|linkedin\.com|tiktok\.com|youtube\.com|youtu\.be|twitter\.com|x\.com|pinterest\.[a-z.]+|threads\.net|wa\.me|api\.whatsapp\.com|t\.me|telegram\.me|vk\.com|line\.me)$/i;
  const social = [];
  try {
    const seen = new Set();
    for (const a of doc.querySelectorAll('a[href]')) {
      const raw = a.getAttribute('href') || '';
      if (!/^https?:/i.test(raw) && !/^\/\//.test(raw)) continue;
      let u = null;
      try { u = new URL(raw, HERE); } catch (_) { continue; }
      const host = u.host.replace(/^www\./, '').toLowerCase();
      if (!SOCIAL.test(host)) continue;
      // A bare profile root ("facebook.com") is a share button, not their page.
      if (u.pathname.replace(/\/+$/, '').length < 2) continue;
      const flat = host + u.pathname.replace(/\/+$/, '');
      if (seen.has(flat.toLowerCase())) continue;
      seen.add(flat.toLowerCase());
      social.push(u.origin + u.pathname.replace(/\/+$/, ''));
      if (social.length >= 6) break;
    }
  } catch (_) {}

  // WHAT THEY ACTUALLY DO, which Maps compresses into one word. "Plumber" is the category; "water
  // heaters, slab leaks, repiping, commercial" is what outreach segments on. Taken from navigation
  // and headings only — the two places a site states its own services — with the furniture every
  // site shares removed, because "Home · About · Contact · Blog" is true of everyone and says
  // nothing about anyone.
  // AND THE FURNITURE IS NOT ONLY ENGLISH, which is what this list quietly assumed.
  //
  // Measured on `plumber in bandung`: 29 of 116 rows came back with a `Category` full of
  // navigation — `Beranda`, `Tentang`, `Layanan`, `Kontak`, `Artikel`, `Kembali`, `Close`,
  // `Arsip Blog`, `My Wishlist` — because not one of those matches an English deny-list. On
  // `Saluran Mampet` it displaced the real category entirely.
  //
  // This tool's own target list is Brazil, Turkey, Argentina, Mexico, Indonesia, so a
  // non-English site is the ordinary case here and English is the exception. The four languages
  // that matter are added; a deny-list can never be complete, which is why the two structural
  // rules below it matter more.
  const FURNITURE = new RegExp('^(' + [
    // English
    'home|about( us)?|contact( us)?|blog|news|gallery|photos|reviews|testimonials|faq|careers',
    'jobs|privacy|terms|cookies|sitemap|login|log in|sign in|register|cart|checkout|search|menu',
    'more|read more|learn more|click here|get in touch|book now|call now|free quote|get a quote',
    'our team|team|locations|shop|store|close|back|next|previous|wishlist|my wishlist|categories',
    // Indonesian / Malay
    'beranda|tentang( kami)?|kontak|hubungi( kami)?|layanan|jasa|produk|artikel|blog|galeri',
    'kembali|lanjut|cari|masuk|daftar|keranjang|profil|profile kami|arsip blog|selengkapnya',
    'mengenai saya|karier|loker|harga|promo|testimoni|portofolio|beranda utama',
    // Portuguese
    'início|inicio|sobre( nós)?|contato|contatos|serviços|servicos|produtos|blog|galeria',
    'orçamento|orcamento|voltar|buscar|entrar|cadastro|carrinho|depoimentos',
    // Spanish
    'inicio|acerca( de)?|nosotros|contacto|servicios|productos|galería|galeria|volver|buscar',
    'iniciar sesión|registrarse|carrito|presupuesto|testimonios|español|english',
    // Turkish
    'ana sayfa|hakkımızda|hakkimizda|iletişim|iletisim|hizmetler|ürünler|urunler|galeri',
    'geri|ara|giriş|giris|kayıt|kayit|sepet|referanslar|blog',
  ].join('|') + ')$', 'i');
  const services = [];
  try {
    const seen = new Set();
    const bits = [];
    for (const el of doc.querySelectorAll('nav a, [role="navigation"] a, h1, h2, h3')) {
      bits.push(el.textContent || '');
      if (bits.length > 200) break;
    }
    // TWO STRUCTURAL RULES, because no word list is ever finished.
    //
    //   the logo link — every site's nav opens with a link carrying the site's own name, and it
    //   came out as a service on this run: `Lancar Prima mampet`, `allir.id`,
    //   `AZKO Bandung Electronic Center`, `Saluran Mampet dan Tersumbat`. A business is not one of
    //   its own services.
    //
    //   the site title — `doc.title`'s leading segment is the same string in most themes.
    //
    // Both are compared on letters and digits alone, so punctuation and casing cannot smuggle a
    // repeat past them.
    const bare = (x) => String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const selfNames = new Set();
    try {
      const host = HOSTS[0] || '';
      selfNames.add(bare(host));
      selfNames.add(bare(host.split('.')[0]));
      for (const part of String(doc.title || '').split(/[|–—\-·:]/)) {
        const b = bare(part);
        if (b.length >= 3) selfNames.add(b);
      }
      const h1 = doc.querySelector('h1');
      if (h1) selfNames.add(bare(h1.textContent));
    } catch (_) {}

    for (const raw of bits) {
      const s = raw.replace(/\s+/g, ' ').trim();
      // Words, not sentences: a heading that is a sentence is marketing copy, not a service.
      if (s.length < 3 || s.length > 40 || FURNITURE.test(s)) continue;
      if (!/^[\p{L}][\p{L}\s&'/,.-]*$/u.test(s)) continue;
      if (selfNames.has(bare(s))) continue;      // the logo link, or the site's own title
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      services.push(s);
      if (services.length >= 8) break;
    }
  } catch (_) {}

  // --- where to look next, if this page held nothing ------------------------
  // The homepage is where a site puts its email about half the time; the rest
  // put it on a contact page, and the link to it is on the homepage by
  // definition. So the extractor hands back candidates instead of the caller
  // guessing `/contact` — a guess that is wrong on every site whose page is
  // `/contact-us`, `/kontakt`, `/impressum` or `/pages/contact`.
  //
  // Ranked, because "About" is a much weaker signal than "Contact" and a site
  // has one visit's worth of patience.
  const WORDS = [
    [/(^|[^a-z])(contact|contact-?us|kontakt|kontak|contacto|contatti|contato|hubungi|iletisim|contactez)([^a-z]|$)/i, 6],
    [/(impressum|imprint|legal-?notice|mentions-?legales)/i, 5],
    [/(^|[^a-z])(about|about-?us|team|company|nosotros|tentang|hakkinda)([^a-z]|$)/i, 2],
    [/(support|help|customer-?service|enquir|inquir)/i, 2],
  ];
  const follow = [];
  try {
    const seen = new Set();
    const at = HERE;
    for (const a of doc.querySelectorAll('a[href]')) {
      const raw = a.getAttribute('href') || '';
      if (!raw || /^(#|javascript:|mailto:|tel:)/i.test(raw)) continue;
      let u = null;
      try { u = new URL(raw, at); } catch (_) { continue; }
      if (!/^https?:$/.test(u.protocol)) continue;
      // Same site only. A link to a Facebook page is not this site's contact page,
      // and following off-site is how one errand becomes four.
      const host = u.host.replace(/^www\./, '').toLowerCase();
      if (!HOSTS.some((h) => host === h || host.endsWith('.' + h))) continue;
      const url = u.origin + u.pathname + (u.search || '');
      if (url === at.split('#')[0] || seen.has(url)) continue;
      // The path and the link's own words both count: plenty of contact links
      // read "Get in touch" over a `/contact` href, and plenty read "Contact"
      // over `/p/12`.
      const hay = u.pathname + ' ' + (a.textContent || '') + ' ' + (a.getAttribute('aria-label') || '');
      let score = 0;
      for (const [re, w] of WORDS) if (re.test(hay)) score = Math.max(score, w);
      if (/get\s+in\s+touch|reach\s+us|write\s+to\s+us|email\s+us/i.test(hay)) score = Math.max(score, 6);
      if (!score) continue;
      seen.add(url);
      follow.push({ url, score });
    }
    follow.sort((a, b) => b.score - a.score);
  } catch (_) {}

  // A CHROME ERROR PAGE IS NOT A WEBSITE, and this distinction decides whether a retry ever
  // happens. A refused connection, a DNS failure or a timeout still produces a document, and that
  // document carries a couple of hundred words of advice — some of it hidden, which the text walk
  // above deliberately reads. Counting characters alone therefore files "this site publishes no
  // address" for a domain that does not exist, and the caller never asks again.
  //
  // `#main-frame-error` is the container Chrome's own template uses. The protocol check catches
  // the rest: a failed navigation leaves the document on `chrome-error://chromewebdata` even
  // though the address bar still shows the URL that was asked for.
  let dead = false;
  try {
    // ON THE FETCH PATH THERE IS NO ERROR PAGE TO FIND — a refused connection is an exception
    // and a 404 is a status, both of which the CALLER sees and this function never does. So `dead`
    // is asked of the URL we were handed, and the fetch path decides deadness from the response.
    dead = !!doc.querySelector('#main-frame-error') || !/^https?:$/i.test(new URL(HERE).protocol);
  } catch (_) { dead = true; }

  const ranked = [...found.entries()].sort((a, b) => b[1].score - a[1].score);
  return {
    dead,
    platform,
    pixels,
    year,
    phones,
    social,
    services,
    // Best first, so the caller can take `[0]` and mean it.
    emails: ranked.map(([v, m]) => ({ v, via: m.via, score: m.score, whose: m.whose })),
    follow: follow.slice(0, 3).map((f) => f.url),
    title: (doc.title || '').slice(0, 120),
    href: HERE,
    // Whether this page was worth reading at all — a parked domain, a holding
    // page or a 404 answers with almost no text, and that is a different report
    // from "read the site, it lists no address".
    len: text.length,
  };
}
