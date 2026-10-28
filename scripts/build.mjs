// Bundles everything with esbuild. This is what GitHub Actions runs (npm run build).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

rmSync('dist', { recursive: true, force: true });
rmSync('site', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
mkdirSync('site', { recursive: true });

// One version number for everything: package.json. The code reads it as __AEGIS_VERSION__.
const common = { bundle: true, logLevel: 'warning', legalComments: 'none', define: { __AEGIS_VERSION__: JSON.stringify(pkg.version) } };

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

// 2. The library, for `import` (ESM) and `require` (CJS). "aegis-lang" is the portable part,
//    "aegis-lang/node" adds nodeHost (disk, network, process.env).
for (const [entry, name, platform] of [
  ['src/index.ts', 'index', 'neutral'],
  ['src/node.ts', 'node', 'node'],
]) {
  for (const [format, ext] of [['esm', 'mjs'], ['cjs', 'cjs']]) {
    await build({ ...common, entryPoints: [entry], platform, format, target: 'node20', outfile: `dist/${name}.${ext}`, external: ['node:*'] });
  }
}

// 3. Type declarations. TypeScript writes .d.ts; CommonJS users need .d.cts next to them, so we copy each one
//    and point its imports at the .cjs twins.
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
for (const f of readdirSync('dist/types')) {
  if (!f.endsWith('.d.ts')) continue;
  const text = readFileSync(`dist/types/${f}`, 'utf8');
  writeFileSync(`dist/types/${f.replace(/\.d\.ts$/, '.d.cts')}`, text.replace(/(['"])(\.{1,2}\/[^'"]+)\.js\1/g, '$1$2.cjs$1'));
}

// 4. The tests. aegis.test.ts keeps its old output name (dist/test.mjs); every other test/*.test.ts becomes dist/test-<name>.mjs.
const nodeRequire = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);";
for (const f of readdirSync('test').filter((n) => n.endsWith('.test.ts'))) {
  const base = f.replace(/\.test\.ts$/, '');
  await build({
    ...common,
    entryPoints: [`test/${f}`],
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: base === 'aegis' ? 'dist/test.mjs' : `dist/test-${base}.mjs`,
    external: ['node:*', 'esbuild'], // the extension test builds the extension on the fly
    banner: { js: nodeRequire },
  });
}

// 5. The web playground (static files in ./site).
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
