// Bundles everything with esbuild. This is what GitHub Actions runs (npm run build).
import { build } from 'esbuild';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
rmSync('site', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
mkdirSync('site', { recursive: true });

const common = { bundle: true, logLevel: 'warning', legalComments: 'none' };

// 1. The command-line tool: one self-contained file.
await build({
  ...common,
  entryPoints: ['src/cli.ts'],
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/aegis.mjs',
  banner: { js: '#!/usr/bin/env node' },
});
chmodSync('dist/aegis.mjs', 0o755);

// 2. The tests.
await build({
  ...common,
  entryPoints: ['test/aegis.test.ts'],
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/test.mjs',
  external: ['node:*'],
});

// 3. The web playground (static files in ./site).
if (existsSync('playground/main.ts')) {
  await build({
    ...common,
    entryPoints: ['playground/main.ts'],
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    outfile: 'site/playground.js',
    minify: true,
    loader: { '.aegis': 'text' },
  });
  copyFileSync('playground/index.html', 'site/index.html');
  copyFileSync('dist/aegis.mjs', 'site/aegis.mjs');
}

console.log('build ok');
