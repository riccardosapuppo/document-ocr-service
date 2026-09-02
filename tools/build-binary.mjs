#!/usr/bin/env node
/**
 * One file to copy onto a machine that has no Node on it.
 *
 *     npm run build:binary
 *
 * The original shipped this way with `pkg`, which is no longer maintained. Node
 * has since grown the capability itself — a Single Executable Application — so
 * this uses that: the same idea, with nothing unmaintained in the chain.
 *
 * Two steps, and the first one is useful on its own:
 *
 *   1. **Bundle** every module into one CommonJS file. That works on any
 *      platform and produces `dist/service.cjs`, which is already a thing you
 *      can copy to a server with a bare Node on it and run.
 *   2. **Inject** that bundle into a copy of the Node binary. This one can only
 *      produce a binary for the platform it runs on — an executable is the host
 *      Node with a blob glued into it, so a Linux binary is built on Linux.
 *
 * Rather than pretend otherwise on Windows, it says so and stops after step
 * one. The Linux binary is built by CI, which means the claim in the README is
 * tested on every push instead of asserted once.
 *
 * The client file and the samples stay OUTSIDE the binary on purpose. They are
 * configuration and data, and a service whose list of callers is baked into the
 * executable cannot have a caller added without a rebuild — which is the whole
 * thing the reloading client file exists to avoid.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const dist = path.join(root, 'dist');

fs.mkdirSync(dist, { recursive: true });

// ---------------------------------------------------------------- 1. bundle

const { build } = await import('esbuild');

await build({
  entryPoints: [path.join(root, 'src', 'index.js')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: path.join(dist, 'service.cjs'),
  // Left as it is written. A service is read in an incident at three in the
  // morning, and a minified stack trace at that hour costs more than the
  // megabyte it saves.
  minify: false,

  /**
   * `import.meta.url` does not exist in CommonJS, and the source uses it to
   * find `public/` and `samples/` next to itself.
   *
   * Without this the bundle builds with a warning and then fails at startup
   * with a syntax error — a build that "succeeded" and produced something that
   * cannot run. The shim gives the same value the module system would.
   *
   * The paths still resolve: the bundle sits in `dist/`, and `dist/../public`
   * is `public/`, exactly as `src/../public` was.
   */
  define: {
    // A single identifier, because that is all `define` accepts — an
    // expression here is ignored in silence and esbuild substitutes its own
    // `{}` shim, which is what produced a bundle that built cleanly and then
    // died on `fileURLToPath(undefined)` at startup. The identifier is
    // declared in the banner below.
    'import.meta.url': '__bundleFileUrl',
  },
  banner: {
    js: [
      '// Built by tools/build-binary.mjs. Edit src/, not this.',
      'const __bundleFileUrl = require("node:url").pathToFileURL(__filename).href;',
    ].join('\n'),
  },
});

const bundled = fs.statSync(path.join(dist, 'service.cjs')).size;
console.log(`  dist/service.cjs  ${Math.round(bundled / 1024)} KB`);

if (process.platform === 'win32' || process.platform === 'darwin') {
  console.log(`
The bundle is ready and runs anywhere Node does:

    node dist/service.cjs --port 3400

A single executable is the host Node with the bundle glued inside it, so it can
only be built for the platform doing the building. This is ${os.platform()}; the
Linux binary is built by CI on every push, which is also how the README's claim
about it stays true.`);
  process.exit(0);
}

// -------------------------------------------------------------- 2. the binary

const config = path.join(dist, 'sea.json');
fs.writeFileSync(
  config,
  JSON.stringify(
    {
      main: 'dist/service.cjs',
      output: 'dist/service.blob',
      disableExperimentalSEAWarning: true,
      // Nothing is embedded. The client file and the samples are read from
      // disk, so a deployment can change who may call without a rebuild.
      useSnapshot: false,
      useCodeCache: true,
    },
    null,
    2
  )
);

execFileSync(process.execPath, ['--experimental-sea-config', config], {
  cwd: root,
  stdio: 'inherit',
});

const binary = path.join(dist, 'document-ocr-service');
fs.copyFileSync(process.execPath, binary);

execFileSync(
  'npx',
  [
    'postject',
    binary,
    'NODE_SEA_BLOB',
    path.join(dist, 'service.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
  { cwd: root, stdio: 'inherit' }
);

fs.chmodSync(binary, 0o755);

const size = fs.statSync(binary).size;
console.log(`
  dist/document-ocr-service  ${Math.round(size / 1024 / 1024)} MB

It needs the client file beside it:

    ./dist/document-ocr-service --clients ./config/clients.json --port 3400
`);
