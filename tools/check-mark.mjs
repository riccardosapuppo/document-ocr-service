#!/usr/bin/env node
/**
 * The mark in the header and the mark in the tab have to be the same mark.
 *
 * They live in two files because they have to: the component draws with CSS
 * custom properties so it can sit on a light or a dark ground, and a favicon is
 * loaded outside the page and inherits nothing, so its colours are literal.
 * Two files, one drawing — and "keep them in step by remembering" is not a
 * plan. Both source files say a test checks this. This is that test.
 *
 * It compares the geometry, which is the part that makes it the same mark, and
 * ignores the colours, which are the part that has to differ.
 *
 *     npm run check:mark
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, '..', 'public');

const component = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
const favicon = fs.readFileSync(path.join(web, 'favicon.svg'), 'utf8');

/**
 * Every shape, as the numbers that place it.
 *
 * Read with a pattern rather than an XML parser because one of the two files is
 * an Angular template with attribute bindings in it, and no XML parser is going
 * to be happy about `[attr.fill]`.
 *
 * Rects AND circles, because the mark is a ring now. When it was four bands
 * this read only `<rect>` — and had the mark been redrawn without this being
 * widened, the check would have compared nothing against nothing and reported
 * a match. A check that passes by finding nothing is worse than no check, so
 * an empty file is a failure of its own below.
 */
function shapes(source) {
  const found = [];

  for (const match of source.matchAll(/<(rect|circle)\b([^>]*)>/g)) {
    const kind = match[1];
    const attributes = match[2] ?? '';
    const number = (name) => {
      const hit = attributes.match(new RegExp(`\\b${name}="([\\d.]+)"`));
      return hit ? Number(hit[1]) : null;
    };
    const text = (name) => attributes.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1] ?? null;

    found.push({
      kind,
      x: number('x') ?? 0,
      y: number('y') ?? 0,
      width: number('width'),
      height: number('height'),
      rx: number('rx'),
      cx: number('cx'),
      cy: number('cy'),
      r: number('r'),
      // These are what make one ring the day and the other the appointment.
      // Without them the two files could draw the same two circles and still
      // be a different mark.
      strokeWidth: number('stroke-width'),
      dashes: text('stroke-dasharray'),
      turned: text('transform'),
    });
  }

  return found.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.y - b.y ||
      a.x - b.x ||
      (a.strokeWidth ?? 0) - (b.strokeWidth ?? 0)
  );
}

const COMPARED = [
  'kind',
  'x',
  'y',
  'width',
  'height',
  'rx',
  'cx',
  'cy',
  'r',
  'strokeWidth',
  'dashes',
  'turned',
];

const inComponent = shapes(component);
const inFavicon = shapes(favicon);

const problems = [];

if (inComponent.length === 0) {
  problems.push('no shapes were found at all — this check has stopped reading the mark');
} else if (inComponent.length !== inFavicon.length) {
  problems.push(
    `the component draws ${inComponent.length} shapes and the favicon ${inFavicon.length}`
  );
} else {
  inComponent.forEach((shape, at) => {
    const other = inFavicon[at];
    for (const key of COMPARED) {
      if (shape[key] !== other[key]) {
        problems.push(
          `shape ${at + 1} (${shape.kind}): ${key} is ${shape[key]} in the component and ${other[key]} in the favicon`
        );
      }
    }
  });
}

// The one colour all three must agree on: the ground, which is also the theme
// colour in index.html — a tab strip in one colour and an icon in another is
// worse than no theme colour at all.
//
// All three are REQUIRED, not merely required to agree. `.filter(Boolean)`
// alone means a token that has been renamed drops out of the comparison and
// the check passes by finding less — which is how the same check passed on this
// project while looking at two of the three.
const grounds = {
  'styles.css': fs
    .readFileSync(path.join(web, 'styles.css'), 'utf8')
    .match(/--logo-ground:\s*(#[0-9a-f]{6})/i)?.[1],
  'the favicon': favicon.match(/<rect[^>]*rx="7"[^>]*fill="(#[0-9a-f]{6})"/i)?.[1],
  'the theme colour': fs
    .readFileSync(path.join(web, 'index.html'), 'utf8')
    .match(/name="theme-color"\s+content="(#[0-9a-f]{6})"/i)?.[1],
};

for (const [where, colour] of Object.entries(grounds)) {
  if (!colour) problems.push(`no ground colour could be found in ${where}`);
}

const found = Object.values(grounds).filter(Boolean);
if (found.length === 3 && new Set(found.map((one) => one.toLowerCase())).size > 1) {
  problems.push(
    `the ground differs: ` +
      Object.entries(grounds)
        .map(([where, colour]) => `${colour} in ${where}`)
        .join(', ')
  );
}

if (problems.length > 0) {
  console.error('The header mark and the tab icon have drifted apart:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('\nBoth are drawn in public/index.html and public/favicon.svg.');
  process.exit(1);
}

console.log(`The mark matches: ${inComponent.length} shapes, and one ground colour throughout.`);
