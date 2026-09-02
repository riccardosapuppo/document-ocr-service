/**
 * Reading the text layer out of a PDF, by hand.
 *
 * This is the engine that runs first, and for most documents it is the only one
 * that needs to run at all. A PDF produced by a word processor, a browser, an
 * accounting package or a label printer already carries its text — recognising
 * it from the pixels instead is slower, costs money per page, and gives a worse
 * answer than the one already in the file. A service that sends everything to a
 * hosted model is paying to guess at something it was told.
 *
 * So: if the file has a text layer, take it. If it does not — a scan, a
 * photograph, a fax — say so plainly and let an engine that can read pixels have
 * it. Saying so is a result, not a failure.
 *
 * Written against PDFs a real producer wrote, not ones this file also made. The
 * samples come out of a browser's print-to-PDF, which means subset fonts, glyph
 * codes that are not character codes, Flate-compressed streams and text placed
 * by matrix rather than by line. Every one of those is a thing a hand-rolled
 * reader gets wrong on the first attempt.
 *
 * What it does not do: encrypted PDFs, CID fonts with no ToUnicode map, and
 * text drawn as vector outlines. Each returns "no text layer here", which is
 * the honest answer and sends the document to the other engine.
 */

import zlib from 'node:zlib';

/**
 * How far down the cursor must move before it is a new line, as a fraction of
 * the type size. A wrapped line moves a whole line-height; a superscript or a
 * baseline nudge moves a fraction of one.
 */
const A_NEW_LINE = 0.35;

/**
 * How wide a horizontal gap must be before it is a space, as a fraction of the
 * type size. Cells in a table row are separate runs at the same height; so are
 * the two halves of a sentence with a bold word in the middle, and those must
 * NOT gain a space that was never there.
 */
const A_SPACE = 0.18;

/**
 * A backwards kern wide enough to be a space, in thousandths of an em.
 *
 * `TJ` moves the cursor between glyphs to kern them, and some producers write a
 * space as a large negative move rather than as a space glyph. Under about 120
 * it is ordinary kerning, and treating that as a space puts a gap inside every
 * other word.
 */
const A_KERNED_SPACE = 120;

export function hasTextLayer(bytes) {
  return readPdfText(bytes).text.trim().length > 0;
}

/**
 * @returns {{ text: string, pages: string[], fonts: number, why: string }}
 */
export function readPdfText(bytes) {
  if (!looksLikeAPdf(bytes)) {
    return { text: '', pages: [], fonts: 0, why: 'this is not a PDF' };
  }

  const raw = bytes.toString('latin1');
  const objects = findObjects(raw, bytes);

  if (objects.size === 0) {
    return { text: '', pages: [], fonts: 0, why: 'no objects could be read out of it' };
  }

  const unicode = toUnicodeMaps(objects);
  const widths = widthTables(objects);
  const pages = pagesOf(objects);

  if (pages.length === 0) {
    return { text: '', pages: [], fonts: unicode.size, why: 'it has no pages this reader could find' };
  }

  const read = pages.map((page) => {
    const content = contentOf(page, objects);
    return content ? textIn(content, page.fonts, unicode, widths) : '';
  });

  const text = read.join('\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  return {
    text,
    pages: read,
    fonts: unicode.size,
    why: text
      ? `read from the text layer of ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`
      : 'it has pages but no text layer — a scan, or text drawn as shapes',
  };
}

function looksLikeAPdf(bytes) {
  // The header is allowed to be preceded by junk; readers are expected to find
  // it within the first kilobyte, and files served through some gateways do
  // arrive with a byte-order mark in front.
  return bytes.subarray(0, 1024).includes('%PDF-');
}

/**
 * Every `N G obj … endobj`, found by scanning.
 *
 * Not by following the cross-reference table, deliberately. A PDF that has been
 * signed or annotated has several xrefs chained together, a linearised one has
 * two, and a file that has been through an email gateway may have a broken one
 * — and a reader that insists on the index fails on documents every other
 * reader opens. Scanning costs one pass and copes with all of it.
 */
function findObjects(raw, bytes) {
  const objects = new Map();
  const heads = /(\d+)\s+(\d+)\s+obj\b/g;

  let head;
  while ((head = heads.exec(raw))) {
    const id = Number(head[1]);
    const from = head.index + head[0].length;
    const end = raw.indexOf('endobj', from);
    if (end === -1) continue;

    objects.set(id, { id, dict: raw.slice(from, end), from, bytes });
  }

  return objects;
}

/** The bytes of an object's stream, decompressed if it is compressed. */
function streamOf(entry) {
  if (!entry) return null;

  const at = entry.dict.indexOf('stream');
  if (at === -1) return null;

  let from = entry.from + at + 'stream'.length;
  // The keyword is followed by CRLF or LF, and the newline is not data.
  if (entry.bytes[from] === 0x0d) from += 1;
  if (entry.bytes[from] === 0x0a) from += 1;

  const ends = entry.bytes.indexOf('endstream', from, 'latin1');
  if (ends === -1) return null;

  let out = entry.bytes.subarray(from, ends);

  if (/\/FlateDecode/.test(entry.dict)) {
    try {
      out = zlib.inflateSync(out);
    } catch {
      try {
        // Some producers omit the zlib header. Raw deflate is the same data.
        out = zlib.inflateRawSync(out);
      } catch {
        return null;
      }
    }
  }

  return out;
}

/**
 * The glyph-code to character maps, one per font that has one.
 *
 * This is the part that cannot be skipped. In a subset font — which is what
 * every browser and word processor emits — the codes in the content stream are
 * positions in that subset and have nothing to do with letters. `48` is not
 * `0`; it is whichever glyph happened to land there. The `/ToUnicode` map is
 * the producer telling you what each one means, and without it the text comes
 * out as convincing nonsense rather than as an error.
 */
function toUnicodeMaps(objects) {
  const maps = new Map();

  for (const entry of objects.values()) {
    if (!/\/Type\s*\/Font\b/.test(entry.dict)) continue;

    const ref = entry.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    if (!ref) continue;

    const bytes = streamOf(objects.get(Number(ref[1])));
    if (!bytes) continue;

    maps.set(entry.id, readCMap(bytes.toString('latin1')));
  }

  return maps;
}

/**
 * How wide each glyph is, by font object id.
 *
 * Two formats, because there are two kinds of font in a PDF and a real document
 * has both. A simple font declares `/FirstChar` and a flat `/Widths` array. A
 * composite one — which is what a subset of Georgia or Arial is — puts a `/W`
 * array on its DESCENDANT font, in a shape that mixes two notations:
 *
 *     /W [ 3 [253.9]  16 [378.9 328.1 0 701.2]  36 45 758.3 ]
 *          ^ one code, a list      ^ a run of codes sharing one width
 *
 * Without these the spacing has to be guessed, and guessing is what put
 * "medium126.2074.40" in an invoice.
 */
function widthTables(objects) {
  const tables = new Map();

  for (const entry of objects.values()) {
    if (!/\/Type\s*\/Font\b/.test(entry.dict)) continue;

    const descendant = entry.dict.match(/\/DescendantFonts\s*\[\s*(\d+)\s+\d+\s+R/);
    const source = descendant ? (objects.get(Number(descendant[1]))?.dict ?? '') : entry.dict;

    const table = new Map();

    const w = balanced(source, '/W', '[', ']');
    if (w) readCidWidths(w, table);

    const simple = balanced(source, '/Widths', '[', ']');
    const first = source.match(/\/FirstChar\s+(\d+)/);
    if (simple && first) {
      const numbers = [...simple.matchAll(/-?[\d.]+/g)].map((one) => Number(one[0]));
      numbers.forEach((width, at) => table.set(Number(first[1]) + at, width));
    }

    if (table.size > 0) tables.set(entry.id, table);
  }

  return tables;
}

function readCidWidths(source, table) {
  const tokens = source.matchAll(/(\[[^\]]*\])|(-?[\d.]+)/g);
  const flat = [];

  for (const token of tokens) {
    if (token[1]) flat.push([...token[1].matchAll(/-?[\d.]+/g)].map((one) => Number(one[0])));
    else flat.push(Number(token[2]));
  }

  for (let at = 0; at < flat.length; ) {
    const start = flat[at];
    const next = flat[at + 1];

    if (Array.isArray(next)) {
      // `code [w w w]` — consecutive codes, one width each.
      next.forEach((width, step) => table.set(start + step, width));
      at += 2;
    } else if (typeof next === 'number' && typeof flat[at + 2] === 'number') {
      // `first last width` — a run of codes sharing one width.
      const width = flat[at + 2];
      for (let code = start; code <= next && code - start < 4096; code += 1) {
        table.set(code, width);
      }
      at += 3;
    } else {
      at += 1;
    }
  }
}

/** The text between a key's opening bracket and its matching close. */
function balanced(source, key, open, close) {
  const at = source.indexOf(key);
  if (at === -1) return null;

  const from = source.indexOf(open, at);
  if (from === -1) return null;

  let depth = 0;
  for (let scan = from; scan < source.length; scan += 1) {
    if (source[scan] === open) depth += 1;
    else if (source[scan] === close) {
      depth -= 1;
      if (depth === 0) return source.slice(from + 1, scan);
    }
  }

  return null;
}

function readCMap(source) {
  const map = new Map();

  for (const block of source.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const pair of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(pair[1], 16), fromUtf16Hex(pair[2]));
    }
  }

  for (const block of source.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    // `<lo> <hi> <base>` — a run of codes mapping to a run of characters.
    for (const run of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const lo = parseInt(run[1], 16);
      const hi = parseInt(run[2], 16);
      const base = parseInt(run[3], 16);

      // Bounded. A malformed range saying 0 to 0xFFFF would otherwise build a
      // map of sixty-five thousand entries out of one bad file.
      for (let code = lo; code <= hi && code - lo < 4096; code += 1) {
        map.set(code, String.fromCodePoint(base + (code - lo)));
      }
    }
  }

  return map;
}

function fromUtf16Hex(hex) {
  let out = '';
  for (let at = 0; at + 4 <= hex.length; at += 4) {
    out += String.fromCharCode(parseInt(hex.slice(at, at + 4), 16));
  }
  return out;
}

/** The pages, each with the font names its content stream will name. */
function pagesOf(objects) {
  const pages = [];

  for (const entry of objects.values()) {
    if (!/\/Type\s*\/Page\b/.test(entry.dict)) continue;

    pages.push({
      contents: contentRefs(entry.dict),
      fonts: fontsFor(entry, objects),
    });
  }

  return pages;
}

/**
 * A page's content can be one stream or an array of them.
 *
 * The array form is how a producer appends to a page it has already written,
 * and reading only the first of them loses everything added afterwards.
 */
function contentRefs(dict) {
  const one = dict.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
  if (one) return [Number(one[1])];

  const many = dict.match(/\/Contents\s*\[([^\]]*)\]/);
  if (!many) return [];

  return [...many[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((one) => Number(one[1]));
}

/**
 * The `/Font` sub-dictionary only.
 *
 * Reading every `/Name N 0 R` in the resources picks up `/XObject` images and
 * `/Parent` as though they were fonts. It happens to work when the names do not
 * collide and stops working on the first page that has a picture on it.
 */
function fontsFor(entry, objects) {
  const fonts = new Map();

  const resources = resolveDict(entry.dict, /\/Resources/, objects);
  if (!resources) return fonts;

  const fontDict = resolveDict(resources, /\/Font/, objects);
  if (!fontDict) return fonts;

  for (const found of fontDict.matchAll(/\/([A-Za-z0-9+.\-_]+)\s+(\d+)\s+\d+\s+R/g)) {
    fonts.set(found[1], Number(found[2]));
  }

  return fonts;
}

/** A dictionary that may be written inline or referred to by number. */
function resolveDict(dict, key, objects) {
  const source = dict.match(new RegExp(`${key.source}\\s+(\\d+)\\s+\\d+\\s+R`));
  if (source) return objects.get(Number(source[1]))?.dict ?? null;

  const at = dict.search(new RegExp(`${key.source}\\s*<<`));
  if (at === -1) return null;

  // Balanced `<< >>`, because a resources dictionary contains dictionaries.
  const from = dict.indexOf('<<', at);
  let depth = 0;
  for (let scan = from; scan < dict.length - 1; scan += 1) {
    if (dict.startsWith('<<', scan)) depth += 1;
    else if (dict.startsWith('>>', scan)) {
      depth -= 1;
      if (depth === 0) return dict.slice(from, scan + 2);
    }
  }

  return null;
}

function contentOf(page, objects) {
  const parts = page.contents
    .map((id) => streamOf(objects.get(id)))
    .filter(Boolean)
    .map((bytes) => bytes.toString('latin1'));

  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * The text in one content stream.
 *
 * A content stream is operators in postfix order. Six matter here: `Tf` chooses
 * a font and a size, `Tj`/`TJ`/`'` show text, and `Tm`, `Td`, `TD` and `T*`
 * move the cursor.
 *
 * **`Tm` is absolute and `Td` is relative**, and treating them alike is the
 * defect this function was written around twice. A browser draws a heading one
 * glyph at a time — `Tm` once, then a `Tx 0 Td` before each letter — so reading
 * every move as absolute made the y jump from 65 to 0 after the first
 * character, and every heading in every document came out as "I" on one line
 * and "nvoice" on the next.
 *
 * The cursor is tracked properly instead, which then gives the other thing for
 * free: knowing where a run **ended** as well as where the next one begins. A
 * table row is four runs at the same height and different x, and without the
 * width of what was drawn there is no way to tell that from a sentence with a
 * bold word in it. One needs spaces between the parts and the other must not
 * have them — "Nitrile gloves, medium126.2074.40" was the first, and
 * "Total  due  EUR 128.10" would be the second.
 *
 * So the glyph widths are read out of the font. It is more work than guessing
 * and it is the difference between a table somebody can read and a row of
 * digits run together.
 */
function textIn(content, fonts, unicode, widths) {
  let out = '';

  /** The font in use, and its size, from the last `Tf`. */
  let map = null;
  let wide = null;
  let size = 12;

  /** Where the current line starts, and how far along it the pen has got. */
  let originX = 0;
  let originY = 0;
  let penX = 0;
  let leading = 0;
  let started = false;

  const tokens = content.matchAll(
    new RegExp(
      [
        String.raw`/([A-Za-z0-9+.\-_]+)\s+(-?[\d.]+)\s+Tf`, // 1,2
        String.raw`(-?[\d.]+)\s+TL`, // 3: leading
        String.raw`(-?[\d.]+)\s+(-?[\d.]+)\s+(Td|TD)`, // 4,5,6: relative move
        String.raw`(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm`, // 7..12
        String.raw`(T\*)`, // 13
        String.raw`\[((?:[^\]\\]|\\.)*)\]\s*TJ`, // 14
        String.raw`(\((?:\\.|[^\\)])*\))\s*(Tj|')`, // 15,16
        String.raw`<([0-9a-fA-F\s]*)>\s*(Tj|')`, // 17,18
      ].join('|'),
      'g'
    )
  );

  /** Puts the pen somewhere, and says what that means for the text so far. */
  function moveTo(x, y) {
    if (!started) {
      started = true;
    } else if (Math.abs(y - originY) > A_NEW_LINE * size) {
      out += '\n';
    } else if (x - penX > A_SPACE * size && !/\s$/.test(out) && out !== '') {
      // Same line, and a gap wider than a word space: the next cell of a table
      // row, or a tab stop. Not inserted after existing whitespace, and not
      // when the run simply continues where the last one stopped.
      out += ' ';
    }

    originX = x;
    originY = y;
    penX = x;
  }

  for (const token of tokens) {
    const [
      ,
      font,
      fontSize,
      setLeading,
      relX,
      relY,
      relKind,
      ,
      ,
      ,
      ,
      absX,
      absY,
      star,
      kerned,
      literal,
      literalOp,
      hex,
      hexOp,
    ] = token;

    if (font !== undefined) {
      map = unicode.get(fonts.get(font)) ?? null;
      wide = widths.get(fonts.get(font)) ?? null;
      size = Math.abs(Number(fontSize)) || 12;
      continue;
    }

    if (setLeading !== undefined) {
      leading = Number(setLeading);
      continue;
    }

    if (relX !== undefined) {
      if (relKind === 'TD') leading = -Number(relY);
      moveTo(originX + Number(relX), originY + Number(relY));
      continue;
    }

    if (absX !== undefined) {
      moveTo(Number(absX), Number(absY));
      continue;
    }

    if (star !== undefined) {
      moveTo(originX, originY + leading);
      continue;
    }

    // `'` shows text on the next line, which is `T*` and then `Tj`.
    if (literalOp === "'" || hexOp === "'") moveTo(originX, originY + leading);

    if (kerned !== undefined) {
      for (const part of kerned.matchAll(/<([0-9a-fA-F\s]*)>|(\((?:\\.|[^\\)])*\))|(-?[\d.]+)/g)) {
        if (part[1] !== undefined) {
          const drawn = fromHex(part[1], map, wide);
          out += drawn.text;
          penX += drawn.width * size;
        } else if (part[2] !== undefined) {
          const drawn = fromLiteral(part[2], map, wide);
          out += drawn.text;
          penX += drawn.width * size;
        } else {
          const kern = Number(part[3]);
          penX -= (kern / 1000) * size;
          if (kern < -A_KERNED_SPACE && !/\s$/.test(out)) out += ' ';
        }
      }
      continue;
    }

    if (literal !== undefined) {
      const drawn = fromLiteral(literal, map, wide);
      out += drawn.text;
      penX += drawn.width * size;
    } else if (hex !== undefined) {
      const drawn = fromHex(hex, map, wide);
      out += drawn.text;
      penX += drawn.width * size;
    }
  }

  return out;
}

/** How wide one glyph is, in ems. 0.5 for a font that did not say. */
function widthOf(code, wide) {
  const said = wide?.get(code);
  return (said === undefined ? 500 : said) / 1000;
}

function fromHex(hex, map, wide) {
  const clean = hex.replace(/\s+/g, '');
  let text = '';
  let width = 0;

  // Two bytes per glyph, because these are Identity-H CID fonts. Guessing the
  // width from the string length reads a three-glyph run as one.
  for (let at = 0; at + 4 <= clean.length; at += 4) {
    const code = parseInt(clean.slice(at, at + 4), 16);
    text += map ? (map.get(code) ?? '') : String.fromCharCode(code);
    width += widthOf(code, wide);
  }

  return { text, width };
}

const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };

function fromLiteral(literal, map, wide) {
  const body = literal.slice(1, -1);
  let text = '';
  let width = 0;

  for (let at = 0; at < body.length; at += 1) {
    let code;

    if (body[at] === '\\') {
      const next = body[at + 1];

      if (next in ESCAPES) {
        // A named escape is a character in its own right, and in a subset font
        // it still goes through the map: `\n` here is glyph 10.
        code = ESCAPES[next].charCodeAt(0);
        at += 1;
      } else if (/[0-7]/.test(next)) {
        const octal = body.slice(at + 1).match(/^[0-7]{1,3}/)[0];
        code = parseInt(octal, 8);
        at += octal.length;
      } else {
        at += 1;
        code = body.charCodeAt(at);
      }
    } else {
      code = body.charCodeAt(at);
    }

    text += map ? (map.get(code) ?? '') : String.fromCharCode(code);
    width += widthOf(code, wide);
  }

  return { text, width };
}
