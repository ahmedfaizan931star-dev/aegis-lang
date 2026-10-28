import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

// These tests look at the BUILT package (dist/), exactly what `npm pack` ships.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const SRC = 'tool t\n  description "d"\n  input a: text\n  run echo "hi {a}"\n';

test('the library works with import (ESM) and require (CJS) and both give the same answers', async () => {
  const esm: any = await import(pathToFileURL(resolve('dist/index.mjs')).href);
  const cjs: any = createRequire(import.meta.url)(resolve('dist/index.cjs'));
  for (const lib of [esm, cjs]) {
    assert.equal(lib.analyze(SRC).ok, true);
    assert.equal(typeof lib.Runtime, 'function');
    assert.equal(typeof lib.runTests, 'function');
    assert.equal(lib.VERSION, pkg.version);
  }
  assert.deepEqual(Object.keys(esm).sort(), Object.keys(cjs).sort());
  const res = await new cjs.Runtime(cjs.analyze(SRC).program, cjs.dryRunHost()).call('t', { a: 'there' });
  assert.equal(res.output, 'hi there');
});

test('"aegis-lang" and "aegis-lang/node" resolve through the exports map', async () => {
  const req = createRequire(resolve('package.json'));
  assert.equal(typeof req('aegis-lang').analyze, 'function');
  const node = req('aegis-lang/node');
  assert.equal(typeof node.nodeHost, 'function');
  const host = node.nodeHost({ X: '1' });
  assert.equal(host.env('X'), '1');
  const esmNode: any = await import(pathToFileURL(resolve('dist/node.mjs')).href);
  assert.equal(typeof esmNode.nodeHost, 'function');
});

test('every file named in package.json exists', () => {
  const files: string[] = [pkg.main, pkg.module, pkg.types, ...Object.values<string>(pkg.bin)];
  for (const entry of Object.values<any>(pkg.exports)) {
    if (typeof entry === 'string') files.push(entry);
    else for (const cond of Object.values<any>(entry)) files.push(...(typeof cond === 'string' ? [cond] : Object.values<string>(cond)));
  }
  for (const f of files) assert.ok(existsSync(resolve(f)), `${f} is missing`);
});

test('the command line tool has a shebang and reports the package version', () => {
  assert.match(readFileSync('dist/aegis.mjs', 'utf8'), /^#!\/usr\/bin\/env node\n/);
  const r = spawnSync(process.execPath, ['dist/aegis.mjs', 'version'], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), pkg.version);
});

test('type declarations exist for both module systems and the CJS ones point at .cjs', () => {
  assert.ok(existsSync('dist/types/index.d.ts') && existsSync('dist/types/index.d.cts'));
  const cts = readFileSync('dist/types/index.d.cts', 'utf8');
  assert.match(cts, /from '\.\/checker\.cjs'/);
  assert.ok(!/from '\.\/[a-z-]+\.js'/.test(cts), 'a .d.cts file still imports a .js file');
  assert.match(readFileSync('dist/types/index.d.ts', 'utf8'), /export declare function analyze/);
});

test('npm pack ships the build and nothing else', () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(r.status, 0, r.stderr);
  const names: string[] = JSON.parse(r.stdout)[0].files.map((f: { path: string }) => f.path);
  for (const must of ['package.json', 'README.md', 'LICENSE', 'dist/aegis.mjs', 'dist/index.mjs', 'dist/index.cjs', 'dist/node.mjs', 'dist/node.cjs', 'dist/types/index.d.ts', 'dist/types/index.d.cts', 'examples/multistep.aegis']) {
    assert.ok(names.includes(must), `${must} is not in the package`);
  }
  for (const n of names) {
    assert.ok(!/^(src|test|vscode|playground|scripts|site|\.github)\//.test(n), `${n} should not be published`);
    assert.ok(!/^dist\/(test|vsix)/.test(n) && !n.endsWith('.vsix'), `${n} should not be published`);
  }
});
