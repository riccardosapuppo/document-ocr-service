/**
 * The README, checked against the repository it describes.
 *
 * A README is the one file everybody reads and nothing verifies, so it rots in
 * a particular way: the code moves and the prose stays, and the first person to
 * notice is a stranger typing the first command.
 *
 * That is not hypothetical here. A sweep across all ten of these repositories
 * found, among other things, a quickstart whose third command could not work on
 * a fresh clone, a disk figure measured before the data grew, a declared runtime
 * version the project could not actually run on, and check counts that had
 * drifted with nothing to notice. Every one of them had been true when written.
 *
 * The delivery rule says every README example must be run and **tied to a
 * check, so that it cannot stop being true**. This is that check for everything
 * static; the per-harness totals are checked by the harnesses themselves, at
 * the end of their own runs, where the number is a fact rather than a promise.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { claims } from '../tools/what-the-readme-claims.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/** Every `npm …` the README tells somebody to type. */
const commands = [
  ...new Set([...readme.matchAll(/\bnpm (?:run [a-z0-9:-]+|test|start|ci|install)\b/g)].map((one) => one[0])),
];

describe('every command the README tells somebody to type', () => {
  it('is a command that exists', () => {
    const missing = commands.filter((one) => {
      const script = one.match(/^npm run ([a-z0-9:-]+)$/)?.[1] ?? (one === 'npm test' ? 'test' : one === 'npm start' ? 'start' : null);
      return script !== null && !Object.hasOwn(manifest.scripts ?? {}, script);
    });

    assert.deepEqual(missing, [], `named in the README, absent from package.json: ${missing.join(', ')}`);
  });

  it('and there are several, so this cannot pass by finding nothing', () => {
    // The failure this guards against is a regex that stops matching: it would
    // then check an empty list and report success for ever.
    assert.ok(commands.length >= 4, `only found ${commands.length} commands in the README`);
  });
});

describe('every number the README states about its own checks', () => {
  const counted = claims();

  it('belongs to a command that exists', () => {
    for (const command of Object.keys(counted)) {
      const script = command.replace(/^npm (run )?/, '').trim();
      assert.ok(Object.hasOwn(manifest.scripts ?? {}, script), `the README counts \`${command}\`, which is not a script`);
    }
  });

  it('and the unit total is the number of tests there actually are', () => {
    // The other totals are checked by the harness that produces them, when it
    // runs. This one can be checked here, because the tests are right there to
    // be counted: `node --test` reports exactly the number of `it(` cases.
    const cases = fs
      .readdirSync(path.join(root, 'test'))
      .filter((one) => one.endsWith('.test.js'))
      .reduce((all, one) => all + (fs.readFileSync(path.join(root, 'test', one), 'utf8').match(/^\s+it\(/gm) ?? []).length, 0);

    if (counted['npm test'] === undefined) {
      assert.fail('the README does not say how many checks `npm test` runs, so nobody can tell when it drifts');
    }

    assert.equal(counted['npm test'], cases, `the README says ${counted['npm test']}; there are ${cases}`);
  });
});

describe('every file the README points at', () => {
  const links = [...readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map((one) => one[1]);

  it('exists on disk', () => {
    const broken = links
      .filter((one) => !/^(https?:|mailto:|#)/.test(one))
      .filter((one) => !fs.existsSync(path.join(root, one.split('#')[0])));

    assert.deepEqual(broken, [], `the README links to files that are not there: ${broken.join(', ')}`);
  });

  it('including every picture, so the page is not full of broken images on GitHub', () => {
    const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((one) => one[1]);

    assert.ok(images.length >= 1, 'no images at all — has the pattern stopped matching?');
    for (const image of images) assert.ok(fs.existsSync(path.join(root, image)), `${image} is missing`);
  });

  it('and every anchor is a heading that is really in the file', () => {
    const headings = [...readme.matchAll(/^#{1,6}\s+(.+)$/gm)].map((one) =>
      one[1].toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-')
    );

    for (const anchor of links.filter((one) => one.startsWith('#')).map((one) => one.slice(1))) {
      assert.ok(headings.includes(anchor), `the README links to #${anchor} and has no such heading`);
    }
  });
});

describe('what the README promises about the runtime', () => {
  it('is a version package.json actually enforces', () => {
    const declared = manifest.engines?.node?.match(/(\d+(?:\.\d+)?)/)?.[1];
    if (!declared) return; // nothing declared, nothing to disagree with

    const promised = [...readme.matchAll(/Node[^\n.]*?(\d+(?:\.\d+)?)/g)].map((one) => one[1]);

    assert.ok(promised.length > 0, `package.json requires Node ${declared} and the README never says so`);

    for (const one of promised) {
      assert.equal(
        Number.parseFloat(one),
        Number.parseFloat(declared),
        `the README says Node ${one}; package.json enforces ${declared}`
      );
    }
  });
});

describe('what the README says node_modules weighs', () => {
  /**
   * The folder, counted the way `du` counts it: the room the filesystem gave
   * the files, not the room their contents need. A hundred packages of small
   * files cost a cluster each, so the two figures sit a few megabytes apart,
   * and the one a reader checks is the disk one.
   *
   * A file whose block count comes back as zero is small enough to live inside
   * its own directory record — NTFS does that under about a kilobyte — and is
   * counted at its size, which is the nearest true thing to say about it.
   */
  function weigh(folder) {
    let bytes = 0;
    let files = 0;

    const walk = (dir) => {
      bytes += (fs.statSync(dir).blocks ?? 0) * 512;

      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const one = path.join(dir, entry.name);

        // Neither branch follows a symlink, and nor does `du`: on Unix, .bin is
        // a folder of links into the packages beside it, and following them would
        // weigh those packages twice.
        if (entry.isDirectory()) {
          walk(one);
        } else if (entry.isFile()) {
          const on = fs.statSync(one);
          bytes += on.blocks ? on.blocks * 512 : on.size;
          files += 1;
        }
      }
    };

    walk(folder);
    return { megabytes: bytes / 1024 / 1024, files };
  }

  // "About", because the answer moves a little and the claim should not: a
  // filesystem with larger clusters rounds a thousand small files further up,
  // and the bundler ships a different binary per platform. Five megabytes is
  // wide enough that bumping a dependency does not turn CI red, and narrow
  // enough that the 16 MB this line used to say is caught the first time
  // anybody runs the tests — which is the drift that put this check here.
  const MARGIN = 5;

  const said = readme.match(/\*\*About (\d+) MB\*\* of `node_modules`/);
  const modules = path.join(root, 'node_modules');

  it('is what the folder on disk really weighs', () => {
    assert.ok(said, 'the README no longer states a size for node_modules in a form this can read');
    assert.ok(fs.existsSync(modules), 'there is no node_modules here to weigh');

    const weighed = weigh(modules);
    const claimed = Number(said[1]);

    assert.ok(
      Math.abs(claimed - weighed.megabytes) <= MARGIN,
      `the README says about ${claimed} MB of node_modules; it weighs ${weighed.megabytes.toFixed(1)} MB`
    );
  });

  it('and the walk found the folder, so this cannot pass by weighing nothing', () => {
    // An empty or unreadable node_modules weighs nothing, and nothing is within
    // five megabytes of any figure somebody would write down. There are a
    // thousand files under there; a hundred is the loosest floor that still
    // means the walk found the folder rather than the idea of it.
    const { files } = weigh(modules);
    assert.ok(files > 100, `only ${files} files were found under node_modules`);
  });
});

describe('the checks the README calls browser-driven', () => {
  // The sentence lists them, and the list was wrong: it counted `check:mark`,
  // which compares two SVG files on disk and has never opened anything. So the
  // names are read back out of the sentence and each tool is asked.
  const listed = readme.match(/The browser-driven checks \(([^)]+)\)/s);
  const named = [...(listed?.[1] ?? '').matchAll(/`([a-z0-9:-]+)`/g)].map((one) => one[1]);

  /** Whether the script's tool loads the driver, rather than merely naming it. */
  const drivesABrowser = (script) => {
    const tool = manifest.scripts?.[script]?.match(/tools\/[a-z0-9.-]+\.mjs/)?.[0];
    if (!tool) return false;

    const source = fs.readFileSync(path.join(root, tool), 'utf8');
    return /require\(\s*['"]playwright-core['"]\s*\)|from\s+['"]playwright-core['"]/.test(source);
  };

  it('are the checks that really load one', () => {
    assert.ok(named.length >= 3, `only ${named.length} names were read out of that sentence`);

    const walking = named.filter((one) => !drivesABrowser(one));
    assert.deepEqual(walking, [], `called browser-driven and never load playwright-core: ${walking.join(', ')}`);
  });

  it('and no script that loads one is left out, so the list cannot rot by omission', () => {
    const driving = Object.keys(manifest.scripts ?? {}).filter(drivesABrowser);
    const unsaid = driving.filter((one) => !named.includes(one));

    assert.deepEqual(unsaid, [], `these drive a browser and that sentence does not say so: ${unsaid.join(', ')}`);
  });
});
