#!/usr/bin/env node
/**
 * Bundles the Electron main + preload processes with esbuild.
 *   node scripts/build-main.mjs            -> one-off production build
 *   node scripts/build-main.mjs --watch    -> rebuild on change
 *   node scripts/build-main.mjs --dev      -> also (re)start Electron
 */
import { build, context } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = require(path.join(root, 'package.json'));

const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev');

/** Runtime deps stay external — electron-builder ships them inside the app. */
const external = ['electron', ...Object.keys(pkg.dependencies ?? {})];

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: dev || watch,
  minify: !dev && !watch,
  external,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(dev || watch ? 'development' : 'production'),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
};

const targets = [
  { entryPoints: [path.join(root, 'electron/main.ts')], outfile: path.join(root, 'dist-electron/main.js') },
  { entryPoints: [path.join(root, 'electron/preload.ts')], outfile: path.join(root, 'dist-electron/preload.js') },
];

let electronProcess = null;

function restartElectron() {
  if (electronProcess) {
    electronProcess.removeAllListeners('exit');
    electronProcess.kill();
    electronProcess = null;
  }
  const electronBin = require('electron');
  electronProcess = spawn(electronBin, [path.join(root, 'dist-electron/main.js')], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development', VITE_DEV_SERVER_URL: 'http://localhost:5273' },
  });
  electronProcess.on('exit', () => process.exit(0));
}

const restartPlugin = {
  name: 'erebus-restart',
  setup(b) {
    let first = true;
    b.onEnd((result) => {
      if (result.errors.length > 0) return;
      if (first) {
        // The initial build is started by the bootstrap below.
        first = false;
        return;
      }
      restartElectron();
    });
  },
};

if (watch) {
  await Promise.all(targets.map((t) => build({ ...common, ...t })));
  if (dev) restartElectron();
  const ctxs = await Promise.all(
    targets.map((t, i) => context({ ...common, ...t, plugins: i === 0 && dev ? [restartPlugin] : [] })),
  );
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[erebus] watching main process…');
} else {
  await Promise.all(targets.map((t) => build({ ...common, ...t })));
}
