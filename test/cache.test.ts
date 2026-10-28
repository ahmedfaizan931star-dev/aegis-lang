import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, cacheStats, clearCaches, parse } from '../src/index.js';

const SRC = (n: number) => `tool t${n}\n  description "d"\n  run echo "x"\n`;

test('the same text gives back the very same, already-checked result', () => {
  clearCaches();
  const a = analyze(SRC(1));
  const b = analyze(SRC(1));
  assert.equal(a, b);
  assert.equal(parse(SRC(1)), parse(SRC(1)));
  const s = cacheStats();
  assert.ok(s.analyze.hits >= 1 && s.parse.hits >= 1, JSON.stringify(s));
});

test('different text is never mixed up', () => {
  clearCaches();
  assert.equal(analyze(SRC(1)).program.tools[0].name, 't1');
  assert.equal(analyze(SRC(2)).program.tools[0].name, 't2');
  assert.equal(analyze(SRC(1) + ' ').ok, true);
});

test('cached results are frozen, so nobody can poison the cache', () => {
  clearCaches();
  const a = analyze(SRC(3));
  assert.throws(() => (a.program.tools[0].name = 'hacked'));
  assert.throws(() => a.program.tools.push(a.program.tools[0]));
  assert.throws(() => a.diagnostics.push({} as never));
  assert.equal(analyze(SRC(3)).program.tools[0].name, 't3');
});

test('the cache is bounded and forgets the oldest text first', () => {
  clearCaches();
  for (let i = 0; i < 200; i++) analyze(SRC(i));
  assert.ok(cacheStats().analyze.size <= 64);
  const before = cacheStats().analyze.misses;
  analyze(SRC(199)); // recent: a hit
  assert.equal(cacheStats().analyze.misses, before);
  analyze(SRC(0)); // oldest: a miss
  assert.equal(cacheStats().analyze.misses, before + 1);
});

test('huge files are not remembered', () => {
  clearCaches();
  const big = SRC(1) + '# ' + 'x'.repeat(600 * 1024) + '\n';
  analyze(big);
  analyze(big);
  assert.equal(cacheStats().analyze.size, 0);
});

test('a cached result still gives correct diagnostics for broken files', () => {
  clearCaches();
  const bad = 'tool t\n  allw network "x.com"\n';
  const first = analyze(bad).diagnostics.map((d) => d.code);
  const second = analyze(bad).diagnostics.map((d) => d.code);
  assert.deepEqual(first, second);
  assert.ok(first.includes('unknown-keyword'));
});
