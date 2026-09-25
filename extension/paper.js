// paper.js — the two exports that are FILES rather than text, written by hand because
// this extension ships no dependencies and an MV3 page cannot fetch a library.
//
// CSV and JSON are strings; a person opens them in the thing they already use. .xlsx and
// .pdf are not strings, and the usual answer — SheetJS, jsPDF — is a megabyte of vendored
// minified code inside a Chrome Web Store review. So both are assembled here from the
// primitives the browser already has:
//
//   .xlsx   a ZIP of six XML parts. The ZIP is written byte by byte (local headers,
//           central directory, EOCD) with a CRC32 computed here, and deflated by
//           CompressionStream('deflate-raw') when the browser has it — STORE if not,
//           which Excel opens perfectly well, just larger.
//   .pdf    objects, one content stream per page, and an xref table, all in Helvetica so
//           nothing has to be embedded. Its limits are real and stated at `toWinAnsi`.
//
// This file is a PLAIN PAGE SCRIPT, not a module: table.js is one too, and a classic
// script cannot import. It publishes `globalThis.Paper` and nothing else, and must be
// listed BEFORE table.js in table.html and in build.mjs's FILES — a file left out of that
// array simply does not exist in dist/, which presents as a results window with dead
// buttons rather than as any kind of error.
//
// WHAT IT IS NOT GIVEN: the empty-cell rule. `orDash`/`CELL_EMPTY` live in table.js and
// every caller applies them before handing rows over, so this file never decides what an
// empty value looks like — there is one such decision in the codebase and it is not here.
(function () {
  'use strict';

  // --- named values -----------------------------------------------------------------
  // A classic script cannot import, so every layout decision this file makes is named
  // here rather than in tuning.js. The ZIP header sizes and signatures further down are
  // the ZIP specification, not decisions, and stay as they are.
  //
  // .xlsx
  // A column's width in characters, from its content: never narrower than a short
  // number's cell, never wider than a URL that would push every other column off screen,
  // with a little padding past the widest value. The scan for the widest value stops the
  // moment the cap is reached (see `sheetXml`).
  const XLSX_COL_MIN_CHARS = 9;
  const XLSX_COL_MAX_CHARS = 60;
  const XLSX_COL_PAD_CHARS = 2;
  // Excel's own limit on a sheet name.
  const XLSX_SHEET_NAME_MAX = 31;
  // Excel keeps fifteen significant digits, and this is the magnitude at which that limit
  // starts eating the INTEGER part: 1234567890123456 really is stored as ...450. Below it a
  // double survives the trip exactly, however many decimals it carries. See `isNumeric`.
  const EXCEL_EXACT_BELOW = 1e15;
  // A whole number with this many digits or more in scraped text is an IDENTIFIER — a phone
  // number, an account, a timestamp — never a quantity anyone will sum, and Excel would show
  // it as 6.28E+11. Ten is past every count, rating, year and price this engine produces.
  const ID_DIGITS = 10;
  //
  // .pdf — all in PostScript points (1/72 in). The two layouts use different margins because
  // they are different documents: a landscape table wants the width, a portrait list of
  // labelled records wants room to read.
  const PDF_LANDSCAPE_MARGIN_PT = 32;
  const PDF_PORTRAIT_MARGIN_PT = 40;
  // The furniture every page carries: title, subtitle and a rule above the content, and the
  // page number below it. Content starts this far below the margin and stops this far above it.
  const PDF_HEAD_H_PT = 42;
  const PDF_FOOT_H_PT = 14;
  // Type sizes. Small is the table body, the footer and a record's field labels — the
  // smallest size still legible on paper; the record body is one step up so wrapped prose
  // reads; a record's heading is bold and larger still; title and subtitle top the page.
  const PDF_SMALL_PT = 7.5;
  const PDF_RECORD_PT = 8.5;
  const PDF_RECORD_HEAD_PT = 10.5;
  const PDF_TITLE_PT = 11;
  const PDF_SUB_PT = 8;
  // The table: one row of the body, the tinted band behind the header, the padding measured
  // into every cell's wanted width, and the bounds a column may take before the page's slack
  // is shared out. Below the minimum a rating column cannot fit its own name; above the
  // maximum one URL column owns the sheet.
  const PDF_TABLE_ROW_PT = 12;
  const PDF_HEAD_BAND_PT = 14;
  const PDF_CELL_PAD_PT = 8;
  const PDF_COL_MIN_PT = 34;
  const PDF_COL_MAX_PT = 240;
  // Column widths are measured on a SAMPLE of the rows rather than every row — this many is
  // enough to tell an address column from a rating.
  const PDF_WIDTH_SAMPLE_ROWS = 100;
  // Records: the label column's width, the gap before the value, the leading between wrapped
  // lines, and how much room a record's heading needs below it before a new page is started
  // — so a record's name is never left alone at the foot of a page.
  const PDF_LABEL_W_PT = 116;
  const PDF_LABEL_GAP_PT = 10;
  const PDF_RECORD_LEAD_PT = 11.2;
  const PDF_RECORD_KEEP_PT = 60;

  // --- bytes ------------------------------------------------------------------------
  const utf8 = (s) => new TextEncoder().encode(s);

  function concat(chunks) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const out = new Uint8Array(n);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  // A "binary string" — every char code is a byte — turned into the bytes it stands for.
  // The PDF writer builds its whole file this way because an xref table is a list of BYTE
  // OFFSETS, and a string's length is only the same number as its byte length while every
  // char stays under 256. WinAnsi guarantees that; see `toWinAnsi`.
  function latin1(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // Chrome has had CompressionStream since 80, so this is the path that runs. The fallback
  // is not theoretical politeness — a STORED zip is a legal zip and Excel opens it, so a
  // browser without the API gets a working file that is simply bigger, never a broken one.
  async function deflate(bytes, format) {
    if (typeof CompressionStream !== 'function') return null;
    try {
      const cs = new CompressionStream(format);
      const buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
      return new Uint8Array(buf);
    } catch (_) {
      return null; // an unsupported format name, on some future engine
    }
  }

  // --- zip --------------------------------------------------------------------------
  function dosStamp(d) {
    // Below 1980 is unrepresentable in the DOS field, and a zero there makes some tools
    // report the archive as damaged, so clamp rather than emit a bad date.
    const y = Math.max(1980, d.getFullYear());
    return {
      date: (((y - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    };
  }

  async function zip(files) {
    const { date, time } = dosStamp(new Date());
    const local = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const name = utf8(f.name);
      const raw = f.bytes;
      const crc = crc32(raw);
      let data = await deflate(raw, 'deflate-raw');
      let method = 8;
      // Deflate can make a tiny part BIGGER. Storing it then is both smaller and simpler.
      if (!data || data.length >= raw.length) { data = raw; method = 0; }

      const head = new Uint8Array(30 + name.length);
      const hv = new DataView(head.buffer);
      hv.setUint32(0, 0x04034b50, true);
      hv.setUint16(4, 20, true);      // version needed: 2.0, which is what deflate wants
      hv.setUint16(6, 0x0800, true);  // bit 11: the name is UTF-8
      hv.setUint16(8, method, true);
      hv.setUint16(10, time, true);
      hv.setUint16(12, date, true);
      hv.setUint32(14, crc, true);
      hv.setUint32(18, data.length, true);
      hv.setUint32(22, raw.length, true);
      hv.setUint16(26, name.length, true);
      hv.setUint16(28, 0, true);
      head.set(name, 30);

      const dir = new Uint8Array(46 + name.length);
      const dv = new DataView(dir.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);      // version made by
      dv.setUint16(6, 20, true);      // version needed
      dv.setUint16(8, 0x0800, true);
      dv.setUint16(10, method, true);
      dv.setUint16(12, time, true);
      dv.setUint16(14, date, true);
      dv.setUint32(16, crc, true);
      dv.setUint32(20, data.length, true);
      dv.setUint32(24, raw.length, true);
      dv.setUint16(28, name.length, true);
      dv.setUint32(42, offset, true); // where this member's local header starts
      dir.set(name, 46);

      local.push(head, data);
      central.push(dir);
      offset += head.length + data.length;
    }

    const dirBytes = concat(central);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, dirBytes.length, true);
    ev.setUint32(16, offset, true);
    return concat([...local, dirBytes, end]);
  }

  // --- xlsx -------------------------------------------------------------------------

  // XML 1.0 has no escape for most control characters — they cannot appear in a document
  // at all. One of them anywhere in a scraped cell and Excel refuses the whole workbook
  // with "unreadable content", so they are dropped here rather than escaped.
  const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
  const xml = (v) => String(v == null ? '' : v)
    .replace(XML_BAD, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

  // A1, ..., Z1, AA1 — a 26-column alphabet with no zero, so the usual base-26 is off by one.
  function colRef(i) {
    let s = '';
    for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
    return s;
  }

  // WHAT COUNTS AS A NUMBER, and why the rule is this narrow.
  //
  // Everything the engine captures is a string; there is no type to preserve, so calling a
  // cell numeric is always a guess. A wrong guess is not cosmetic — Excel reads `(86)` as
  // accounting notation and turns 86 reviews into -86, and reads `0812…` as a quantity,
  // eating the leading zero off a phone number that then cannot be dialled.
  //
  // Admitted: `4.5`, `5.0`, `-6.8992214`, `-6.887732199999999`, `2019`. Refused: `(86)`,
  // `0877-2020-5225`, `08123` and any other leading zero, `1,200`, `1e3`, ` 7 `, `4H26+8R`.
  //
  // THE PRECISION GUARD IS ABOUT MAGNITUDE, NOT DIGIT COUNT, and the user's own data is
  // what corrected that. The first version refused anything with more than fifteen
  // significant digits, on the grounds that Excel keeps fifteen — and Google Maps returns
  // latitudes like `-6.887732199999999`, which is sixteen. One such value forced the whole
  // Latitude column to text.
  //
  // Sixteen digits after a decimal point is float noise, not information: the number is a
  // double either way and survives the trip exactly. Sixteen digits BEFORE one is an
  // account number. So the test is `EXCEL_EXACT_BELOW` — the magnitude at which the
  // fifteen-digit limit starts eating the integer part — and `ID_DIGITS` for whole numbers.
  const NUMERIC = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
  function isNumeric(s) {
    if (!NUMERIC.test(s)) return false;
    const n = Number(s);
    if (!Number.isFinite(n) || Math.abs(n) >= EXCEL_EXACT_BELOW) return false;
    return s.includes('.') || s.replace('-', '').length < ID_DIGITS;
  }

  // THE DECISION IS PER COLUMN, NOT PER CELL, and that was a correction made against the
  // real data rather than a preference.
  //
  // Judging each cell on its own gave a Rating column where `4.5` was a number and `5.0`
  // was text, and a Phone column where two local seven-digit numbers went numeric while the
  // other 104 stayed text. Excel then right-aligns some cells and left-aligns others in the
  // same column and sorts the two groups separately — a column you cannot sort is worse
  // than one that is entirely text.
  //
  // So a column is numeric only when EVERY value in it is, and one `(86)` anywhere in
  // Reviews keeps the whole column as text. `empty` is the caller's placeholder for a blank
  // — this file is never told what that looks like, it is handed the string — and a blank
  // is not evidence either way, so it is skipped when deciding and written as text.
  function numericCols(columns, rows, empty) {
    return columns.map((_, i) => {
      let seen = false;
      for (const r of rows) {
        const v = r[i] == null ? '' : String(r[i]);
        if (!v || v === empty) continue;
        if (!isNumeric(v)) return false;
        seen = true;
      }
      return seen;
    });
  }

  // Excel's own ceiling. Longer than this and the file opens with the cell emptied, which
  // is a worse lie than a visibly cut value.
  const CELL_MAX = 32767;

  // Sheet names cannot hold []:*?/\ , cannot exceed XLSX_SHEET_NAME_MAX characters, and cannot be blank.
  const sheetTitle = (s) => (String(s || '').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, XLSX_SHEET_NAME_MAX) || 'Sheet1');

  function sheetXml(columns, rows, empty) {
    const numeric = numericCols(columns, rows, empty);
    const last = colRef(Math.max(0, columns.length - 1));
    const span = `A1:${last}${rows.length + 1}`;
    const out = [];
    out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
    out.push(`<dimension ref="${span}"/>`);
    // The header stays put while the rows scroll. On a 25-column table this is the
    // difference between a spreadsheet and a wall of values.
    out.push('<sheetViews><sheetView workbookViewId="0">'
      + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
      + '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>');
    out.push('<sheetFormatPr defaultRowHeight="15"/>');

    // Widths from the content, because a default-width column of addresses shows six
    // characters of each. Capped so one long URL cannot push every other column off screen
    // (XLSX_COL_MIN_CHARS / XLSX_COL_MAX_CHARS, with XLSX_COL_PAD_CHARS past the widest value).
    if (columns.length) {
      out.push('<cols>');
      columns.forEach((name, i) => {
        let wide = String(name || '').length;
        for (const r of rows) {
          const v = r[i] == null ? '' : String(r[i]);
          if (v.length > wide) wide = v.length;
          // Once the padded width would hit the cap, no wider value can change the answer.
          if (wide >= XLSX_COL_MAX_CHARS - XLSX_COL_PAD_CHARS) break;
        }
        out.push(`<col min="${i + 1}" max="${i + 1}" width="${Math.min(XLSX_COL_MAX_CHARS, Math.max(XLSX_COL_MIN_CHARS, wide + XLSX_COL_PAD_CHARS))}" customWidth="1"/>`);
      });
      out.push('</cols>');
    }

    out.push('<sheetData>');
    out.push(`<row r="1">${columns.map((name, i) =>
      `<c r="${colRef(i)}1" s="1" t="inlineStr"><is><t xml:space="preserve">${xml(name)}</t></is></c>`
    ).join('')}</row>`);

    rows.forEach((row, ri) => {
      const r = ri + 2;
      const cells = [];
      for (let i = 0; i < columns.length; i++) {
        const raw = row[i] == null ? '' : String(row[i]);
        if (!raw) continue; // an absent <c> is an empty cell; writing one would only be bytes
        // The raw text goes straight into <v>: `4.5` and `5.0` are both valid number
        // literals, and re-printing them through Number() would only lose the trailing zero
        // earlier than Excel does.
        if (numeric[i] && isNumeric(raw)) {
          cells.push(`<c r="${colRef(i)}${r}"><v>${raw}</v></c>`);
        } else {
          // s="2" is the Text number format. Without it Excel treats a cell holding "4.50"
          // as a number it should have parsed and flags it; with it, the cell says what it is.
          cells.push(`<c r="${colRef(i)}${r}" s="2" t="inlineStr"><is><t xml:space="preserve">`
            + `${xml(raw.slice(0, CELL_MAX))}</t></is></c>`);
        }
      }
      out.push(`<row r="${r}">${cells.join('')}</row>`);
    });
    out.push('</sheetData>');

    if (columns.length && rows.length) {
      out.push(`<autoFilter ref="A1:${last}${rows.length + 1}"/>`);
      // The green triangle on every text cell that looks like a number. The values are
      // deliberately text — see `numericCols` — so the warning is noise about a decision
      // already made, on hundreds of cells at once.
      out.push(`<ignoredErrors><ignoredError sqref="A2:${last}${rows.length + 1}" numberStoredAsText="1"/></ignoredErrors>`);
    }
    out.push('</worksheet>');
    return out.join('');
  }

  const XLSX_PARTS = {
    contentTypes: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '</Types>',
    rels: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>',
    bookRels: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '</Relationships>',
    // Three formats: default, bold (the header), and 49 — the "@" text format.
    // The two fills are not optional padding: Excel requires index 0 to be none and index 1
    // to be gray125, and rejects a styles part that does not have them.
    styles: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
      + '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
      + '<fills count="2"><fill><patternFill patternType="none"/></fill>'
      + '<fill><patternFill patternType="gray125"/></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="3">'
      + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
      + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
      + '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
      + '</cellXfs>'
      // Named "Normal" or readers report a workbook with no default style and substitute
      // their own — harmless, but it is a warning about this file every time it is opened.
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + '</styleSheet>',
  };

  // `empty` is the caller's placeholder for a blank cell — table.js's `CELL_EMPTY`. It is
  // passed in rather than known here so there stays exactly one place in the codebase that
  // decides what an empty cell looks like, and this is not it.
  async function xlsx({ columns = [], rows = [], sheet = 'Sheet1', empty = '' } = {}) {
    const name = sheetTitle(sheet);
    const book = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `<sheets><sheet name="${xml(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

    const bytes = await zip([
      { name: '[Content_Types].xml', bytes: utf8(XLSX_PARTS.contentTypes) },
      { name: '_rels/.rels', bytes: utf8(XLSX_PARTS.rels) },
      { name: 'xl/workbook.xml', bytes: utf8(book) },
      { name: 'xl/_rels/workbook.xml.rels', bytes: utf8(XLSX_PARTS.bookRels) },
      { name: 'xl/styles.xml', bytes: utf8(XLSX_PARTS.styles) },
      { name: 'xl/worksheets/sheet1.xml', bytes: utf8(sheetXml(columns, rows, empty)) },
    ]);
    return {
      blob: new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      note: '',
    };
  }

  // --- pdf --------------------------------------------------------------------------

  // Adobe's own Helvetica advance widths, read out of the AFM and indexed by WinAnsi code
  // from 32 up. They are here because wrapping and truncating need the real width of a
  // string: guess it and a column either overflows its neighbour or gets cut two words early.
  // Bold is a separate table — it is not the regular one scaled.
  const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,0,556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500];
  const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,0,556,0,278,556,500,1000,556,556,333,1000,667,333,1000,0,611,0,0,278,278,500,500,350,556,1000,333,1000,556,333,944,0,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556];

  // The 0x80–0x9F band, where WinAnsi differs from Latin-1 and holds the punctuation that
  // actually turns up in scraped text — the en dash in "8.00 am–5.00 pm", curly quotes
  // pasted out of a CMS, the bullet, the ellipsis.
  const HIGH = {
    0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
    0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
    0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
    0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
    0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
  };

  // WHAT A CORE-FONT PDF CAN AND CANNOT SAY.
  //
  // Helvetica is one of the fourteen fonts every reader already has, which is the only
  // reason this file needs no embedded font and stays small. The price is its encoding:
  // 8-bit WinAnsi, so 224 glyphs. Every Latin script fits — the whole Indonesian dataset,
  // accents, ·, –, €, ø. Chinese, Japanese, Korean, Arabic, Thai, Hebrew, Greek and
  // Cyrillic DO NOT, and there is no encoding trick that would make them: the font has no
  // such glyph to point at. They become "?" and the caller is told how many, because a
  // silent row of question marks is the one outcome worse than a warning.
  let dropped = 0;
  function toWinAnsi(s) {
    let out = '';
    const str = String(s == null ? '' : s);
    for (const ch of str) {
      const u = ch.codePointAt(0);
      let b;
      if (u === 9 || u === 10 || u === 13) b = 32;          // whitespace flattens to a space
      else if (u < 32 || u === 127) continue;               // control bytes are not text at all
      else if (u <= 126) b = u;
      else if (u >= 0xa0 && u <= 0xff) b = u;
      else if (HIGH[u] !== undefined) b = HIGH[u];
      else { b = 63; dropped++; }                            // "?" — and the caller is told
      out += String.fromCharCode(b);
    }
    return out;
  }

  const widthOf = (win, size, bold) => {
    const t = bold ? W_BOLD : W_REG;
    let w = 0;
    for (let i = 0; i < win.length; i++) {
      const c = win.charCodeAt(i) - 32;
      w += c >= 0 && c < t.length ? t[c] : 0;
    }
    return (w * size) / 1000;
  };

  // Cut to fit, with an ellipsis that is itself measured — trimming to a character count
  // makes "Jl. Jend. H. Amir…" and "IIIIIIIIIIIIIIIII…" occupy wildly different widths.
  function clip(win, max, size, bold) {
    if (widthOf(win, size, bold) <= max) return win;
    const dots = String.fromCharCode(0x85); // WinAnsi ellipsis
    let lo = 0;
    let hi = win.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (widthOf(win.slice(0, mid) + dots, size, bold) <= max) lo = mid; else hi = mid - 1;
    }
    return win.slice(0, lo) + dots;
  }

  // Greedy word wrap. A single word longer than the line — a 250-character Maps URL, which
  // every row of the real data has — is broken by character rather than left to run off
  // the page.
  function wrap(win, max, size, bold) {
    const lines = [];
    for (const para of win.split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (widthOf(next, size, bold) <= max) { line = next; continue; }
        if (line) { lines.push(line); line = ''; }
        let rest = word;
        while (widthOf(rest, size, bold) > max) {
          let n = 1;
          while (n < rest.length && widthOf(rest.slice(0, n + 1), size, bold) <= max) n++;
          // NEVER END A BROKEN LINE ON A HYPHEN. Measured, not guessed: row 18 of the
          // user's export has `…19sChIJry-hs6Pla…`, the break landed after the `-`, and
          // pdftotext read the result back as `ry` + `hs6` — one character short of a URL
          // that no longer resolves. Readers and human eyes both treat a hyphen at a line
          // end as hyphenation and drop it, so the break moves back one character instead.
          if (n > 1 && rest[n - 1] === '-') n--;
          lines.push(rest.slice(0, n));
          rest = rest.slice(n);
        }
        line = rest;
      }
      lines.push(line);
    }
    return lines.length ? lines : [''];
  }

  // A PDF literal string is a byte string. Only the delimiters and the escape need escaping;
  // control bytes go octal so no line ending can end the string early.
  function pdfStr(win) {
    let out = '';
    for (let i = 0; i < win.length; i++) {
      const c = win.charCodeAt(i);
      if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + win[i];
      else if (c < 32) out += '\\' + c.toString(8).padStart(3, '0');
      else out += win[i];
    }
    return out;
  }

  // A page under construction: operators accumulate, and `text` records nothing but its own
  // coordinates so a caller never has to think in PDF's bottom-left origin.
  function Canvas(w, h) {
    const ops = [];
    return {
      w, h, ops,
      text(win, x, y, size, bold, grey) {
        if (!win) return;
        ops.push(`BT ${grey == null ? '0 g' : `${grey} g`} /${bold ? 'F2' : 'F1'} ${size} Tf `
          + `1 0 0 1 ${x.toFixed(2)} ${(h - y).toFixed(2)} Tm (${pdfStr(win)}) Tj ET`);
      },
      rule(x1, y, x2, grey = 0.82) {
        ops.push(`${grey} G 0.5 w ${x1.toFixed(2)} ${(h - y).toFixed(2)} m ${x2.toFixed(2)} ${(h - y).toFixed(2)} l S`);
      },
      band(x, y, w2, h2, grey = 0.92) {
        ops.push(`${grey} g ${x.toFixed(2)} ${(h - y - h2).toFixed(2)} ${w2.toFixed(2)} ${h2.toFixed(2)} re f`);
      },
      body() { return ops.join('\n'); },
    };
  }

  const A4 = { w: 595.28, h: 841.89 };
  const A4L = { w: 841.89, h: 595.28 };
  // Past this many columns a landscape page gives each one under 60pt — about a dozen
  // characters — and a table of "Toko Be…" everywhere is a picture of a table rather than
  // the data. The wide case is drawn as records instead; see `records`.
  const TABLE_MAX_COLS = 12;

  async function assemble(pages, title) {

    const objects = [];
    const N = pages.length;
    // 1 catalog, 2 pages, 3 F1, 4 F2, 5 info, then a page object and a stream each.
    const pageId = (i) => 6 + i * 2;
    objects[1] = '<</Type/Catalog/Pages 2 0 R>>';
    objects[2] = `<</Type/Pages/Kids[${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}]/Count ${N}>>`;
    objects[3] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>';
    objects[4] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold/Encoding/WinAnsiEncoding>>';
    const now = new Date();
    const two = (n) => String(n).padStart(2, '0');
    const stamp = `D:${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
      + `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
    objects[5] = `<</Producer (HoloScrape)/Title (${pdfStr(toWinAnsi(title))})/CreationDate (${stamp})>>`;

    const streams = [];
    for (let i = 0; i < N; i++) {
      const p = pages[i];
      const raw = latin1(p.body());
      // Flate is worth it here: a page of table operators is extremely repetitive, and an
      // uncompressed 40-page export is several hundred kilobytes of coordinates.
      const packed = await deflate(raw, 'deflate');
      const data = packed || raw;
      objects[pageId(i)] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${p.w.toFixed(2)} ${p.h.toFixed(2)}]`
        + '/Resources<</Font<</F1 3 0 R/F2 4 0 R>>>>'
        + `/Contents ${pageId(i) + 1} 0 R>>`;
      streams[pageId(i) + 1] = { data, flate: !!packed };
    }

    // Written in one pass so an offset is always the length of everything emitted so far.
    // The xref is a list of byte positions and a stale one makes readers reject the file,
    // so nothing may be inserted after this point.
    const chunks = [];
    let at = 0;
    const put = (bytes) => { chunks.push(bytes); at += bytes.length; };
    put(latin1('%PDF-1.4\n'));
    put(new Uint8Array([0x25, 0xc4, 0xe5, 0xf2, 0xe5, 0xeb, 0xa7, 0xf3, 0xa0, 0xd0, 0xc4, 0xc6, 0x0a]));

    const total = 5 + N * 2;
    const offsets = new Array(total + 1).fill(0);
    for (let n = 1; n <= total; n++) {
      offsets[n] = at;
      if (streams[n]) {
        const s = streams[n];
        put(latin1(`${n} 0 obj\n<</Length ${s.data.length}${s.flate ? '/Filter/FlateDecode' : ''}>>\nstream\n`));
        put(s.data);
        put(latin1('\nendstream\nendobj\n'));
      } else {
        put(latin1(`${n} 0 obj\n${objects[n]}\nendobj\n`));
      }
    }

    const xrefAt = at;
    let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= total; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    xref += `trailer\n<</Size ${total + 1}/Root 1 0 R/Info 5 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
    put(latin1(xref));
    return new Blob(chunks, { type: 'application/pdf' });
  }

  // Chrome, dark-mode CSS and a scraped table all disagree about what a heading is; the PDF
  // settles it once. Every page carries the same furniture so a printed page found on its
  // own still says what it is and where it came from.
  function furnish(c, title, sub, page, pages, m) {
    c.text(toWinAnsi(title), m, m + 8, PDF_TITLE_PT, true);
    if (sub) c.text(toWinAnsi(sub), m, m + 21, PDF_SUB_PT, false, 0.42);
    c.rule(m, m + 28, c.w - m);
    const foot = toWinAnsi(`Page ${page} of ${pages}`);
    c.text(foot, c.w - m - widthOf(foot, PDF_SMALL_PT, false), c.h - m + 4, PDF_SMALL_PT, false, 0.45);
  }

  function table(columns, rows, title, sub) {
    const m = PDF_LANDSCAPE_MARGIN_PT;
    const top = m + PDF_HEAD_H_PT;
    const bottom = A4L.h - m - PDF_FOOT_H_PT;
    const avail = A4L.w - m * 2;
    const size = PDF_SMALL_PT;

    // Widths proportional to what the column actually holds, measured on a sample rather
    // than every row (PDF_WIDTH_SAMPLE_ROWS), and bounded (PDF_COL_MIN_PT .. PDF_COL_MAX_PT).
    const want = columns.map((name, i) => {
      let w = widthOf(toWinAnsi(name), size, true) + PDF_CELL_PAD_PT;
      const step = Math.max(1, Math.floor(rows.length / PDF_WIDTH_SAMPLE_ROWS));
      for (let r = 0; r < rows.length; r += step) {
        const v = widthOf(toWinAnsi(rows[r][i] == null ? '' : rows[r][i]), size, false) + PDF_CELL_PAD_PT;
        if (v > w) w = v;
      }
      return Math.min(PDF_COL_MAX_PT, Math.max(PDF_COL_MIN_PT, w));
    });
    // Short of the page, the slack is shared EQUALLY rather than in proportion. Scaling up
    // proportionally hands most of the spare room to the column that was already widest —
    // six columns of the real data gave Name 40% of the sheet and a trough of white space,
    // while Rating still had to fit "Rating spread" in 40pt.
    const sum = want.reduce((a, b) => a + b, 0) || 1;
    const widths = sum <= avail
      ? want.map((w) => w + (avail - sum) / want.length)
      : want.map((w) => (w * avail) / sum);

    const pages = [];
    let c = null;
    let y = 0;
    const header = () => {
      c = Canvas(A4L.w, A4L.h);
      pages.push(c);
      y = top;
      c.band(m, y - 10, avail, PDF_HEAD_BAND_PT);
      let x = m;
      columns.forEach((name, i) => {
        c.text(clip(toWinAnsi(name), widths[i] - 6, size, true), x + 3, y, size, true);
        x += widths[i];
      });
      y += 8;
      c.rule(m, y - 4, A4L.w - m, 0.6);
    };
    header();
    for (const row of rows) {
      if (y + PDF_TABLE_ROW_PT > bottom) header();
      let x = m;
      columns.forEach((_, i) => {
        c.text(clip(toWinAnsi(row[i] == null ? '' : row[i]), widths[i] - 6, size, false), x + 3, y + 8, size, false);
        x += widths[i];
      });
      y += PDF_TABLE_ROW_PT;
      c.rule(m, y - 2.5, A4L.w - m, 0.9);
    }
    pages.forEach((p, i) => furnish(p, title, sub, i + 1, pages.length, m));
    return pages;
  }

  // The wide case. Twenty-five columns cannot be a table on any paper size, so each row
  // becomes a block of labelled fields — complete, wrapped, nothing truncated. It is longer
  // than a table would be and it is the only version of this data a person can read.
  function records(columns, rows, title, sub) {
    const m = PDF_PORTRAIT_MARGIN_PT;
    const top = m + PDF_HEAD_H_PT;
    const bottom = A4.h - m - PDF_FOOT_H_PT;
    const labelW = PDF_LABEL_W_PT;
    const gap = PDF_LABEL_GAP_PT;
    const valueX = m + labelW + gap;
    const valueW = A4.w - m - valueX;
    const size = PDF_RECORD_PT;
    const lead = PDF_RECORD_LEAD_PT;

    const pages = [];
    let c = null;
    let y = 0;
    const fresh = () => { c = Canvas(A4.w, A4.h); pages.push(c); y = top; };
    fresh();

    rows.forEach((row, ri) => {
      const first = columns.length ? String(row[0] == null ? '' : row[0]).trim() : '';
      const head = toWinAnsi(`${ri + 1}. ${first && first !== '-' ? first : `Row ${ri + 1}`}`);
      // Never leave a record's name alone at the foot of a page (PDF_RECORD_KEEP_PT).
      if (y + PDF_RECORD_KEEP_PT > bottom) fresh();
      if (ri && y > top) { c.rule(m, y - 6, A4.w - m, 0.88); y += 8; }
      c.text(clip(head, A4.w - m * 2, PDF_RECORD_HEAD_PT, true), m, y + 8, PDF_RECORD_HEAD_PT, true);
      y += 8 + lead + 2;

      columns.forEach((name, i) => {
        const value = String(row[i] == null ? '' : row[i]);
        const lines = wrap(toWinAnsi(value), valueW, size, false);
        const label = clip(toWinAnsi(name), labelW - 4, PDF_SMALL_PT, true);
        for (let k = 0; k < lines.length; k++) {
          if (y + lead > bottom) { fresh(); }
          if (!k) c.text(label, m, y + 7, PDF_SMALL_PT, true, 0.4);
          c.text(lines[k], valueX, y + 7, size, false);
          y += lead;
        }
      });
      y += 6;
    });

    pages.forEach((p, i) => furnish(p, title, sub, i + 1, pages.length, m));
    return pages;
  }

  async function pdf({ columns = [], rows = [], title = 'HoloScrape', subtitle = '' } = {}) {
    dropped = 0;
    let pages;
    if (!rows.length || !columns.length) {
      const c = Canvas(A4.w, A4.h);
      c.text(toWinAnsi('Nothing to export.'), PDF_PORTRAIT_MARGIN_PT, 100, 10, false, 0.4);
      pages = [c];
      furnish(c, title, subtitle, 1, 1, PDF_PORTRAIT_MARGIN_PT);
    } else {
      pages = columns.length <= TABLE_MAX_COLS
        ? table(columns, rows, title, subtitle)
        : records(columns, rows, title, subtitle);
    }
    // Read BEFORE the await. Every character has been encoded by now, and `dropped` is one
    // counter shared by the module — a second export starting during `assemble` would reset
    // it and this note would describe the wrong file.
    const lost = dropped;
    const blob = await assemble(pages, title);
    return {
      blob,
      note: lost ? `PDF: ${lost} character${lost === 1 ? '' : 's'} outside the Latin alphabet became "?"` : '',
    };
  }

  globalThis.Paper = { xlsx, pdf, _internals: { isNumeric, numericCols, colRef, toWinAnsi, widthOf, wrap, clip, zip, crc32, sheetXml, TABLE_MAX_COLS } };
})();
