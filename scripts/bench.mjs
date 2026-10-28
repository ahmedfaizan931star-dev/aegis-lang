// Speed check: node scripts/bench.mjs [path-to-index.mjs] [path-to-example.aegis]
// Needs a build first (npm run build). Prints a table; numbers depend on the machine, so compare runs on the SAME machine.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const lib = await import(pathToFileURL(resolve(process.argv[2] ?? 'dist/index.mjs')).href);
const { analyze, Runtime, dryRunHost } = lib;
const hasCache = typeof lib.clearCaches === 'function';

const ROUNDS = 7;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Runs fn() `n` times per round for several rounds, returns the median time per call in microseconds. */
function time(n, fn) {
  for (let i = 0; i < Math.min(n, 50); i++) fn(i); // warm-up
  const per = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn(i);
    per.push(((performance.now() - t0) * 1000) / n);
  }
  return median(per);
}
async function timeAsync(n, fn) {
  for (let i = 0; i < Math.min(n, 20); i++) await fn(i);
  const per = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) await fn(i);
    per.push(((performance.now() - t0) * 1000) / n);
  }
  return median(per);
}

const TOOL = (i) => `tool tool_${i}
  description "Tool number ${i}"
  input query: text "What to search for"
  input count: number "How many" = 5
  allow network "api.example.com"
  secret KEY_${i}
  limit time 5s
  limit calls 10/min
  cache 60s
  retry 2
  run get "https://api.example.com/v1/search?q={query}&n={count}" header Authorization = "Bearer {secret.KEY_${i}}"
  then json
  output json
`;
const program = (n) => Array.from({ length: n }, (_, i) => TOOL(i)).join('\n');

const rows = [];
const add = (name, us, note = '') => rows.push([name, us, note]);

// ---- parsing + checking ------------------------------------------------------------------------
const inputs = [
  ['a real file (research.aegis, 5 tools)', readFileSync(process.argv[3] ?? 'examples/research.aegis', 'utf8')],
  ['10 tools', program(10)],
  ['100 tools', program(100)],
  ['1000 tools', program(1000)],
];
for (const [label, src] of inputs) {
  const n = src.length > 100_000 ? 20 : 300;
  // "cold": a new text every time (a unique comment at the end), so no cache can help.
  const cold = time(n, (i) => analyze(src + `\n# ${i}-${Math.random()}`));
  // "warm": the same text again and again (an editor re-checking, a server, a test suite).
  const warm = time(hasCache ? n * 20 : n, () => analyze(src));
  add(`analyze, ${label}`, cold, 'cold: new text each time');
  add(`analyze, ${label}`, warm, hasCache ? 'warm: same text again (cache hit)' : 'same text again (no cache in this version)');
}

// ---- running tools -------------------------------------------------------------------------------
const host = dryRunHost();
const ONE = `tool one\n  description "d"\n  input q: text\n  allow network "api.example.com"\n  secret K\n  limit time 5s\n  limit calls 1000000/hour\n  run get "https://api.example.com/s?q={q}" header A = "{secret.K}"\n  then json\n  output json\n`;
const rtOne = new Runtime(analyze(ONE).program, host);
add('run a tool, 1 step (incl. audit hash chain)', await timeAsync(300, (i) => rtOne.call('one', { q: 'x' + i })), 'dry-run host, no real network');

const hasSteps = analyze('tool t\n  description "d"\n  run let a = echo "x"\n  run echo "{a}"\n').ok;
if (hasSteps) {
  const TWO = `tool two\n  description "d"\n  input q: text\n  allow network "api.example.com"\n  secret K\n  limit time 5s\n  limit calls 1000000/hour\n  run let a = get "https://api.example.com/s?q={q}" header A = "{secret.K}"\n  then json\n  then pick url\n  run get "https://api.example.com/t?u={a}"\n  then json\n  output json\n`;
  const rtTwo = new Runtime(analyze(TWO).program, host);
  add('run a tool, 2 steps (incl. audit hash chain)', await timeAsync(300, (i) => rtTwo.call('two', { q: 'x' + i })), 'dry-run host, no real network');
}

// ---- report ------------------------------------------------------------------------------------------
const w = Math.max(...rows.map((r) => r[0].length));
console.log(`Aegis benchmark, Node ${process.version}, median of ${ROUNDS} rounds\n`);
console.log(`${'what'.padEnd(w)}  ${'time per op'.padStart(12)}  ${'ops/sec'.padStart(11)}  note`);
for (const [name, us, note] of rows) {
  const t = us >= 1000 ? `${(us / 1000).toFixed(2)} ms` : `${us.toFixed(1)} µs`;
  console.log(`${name.padEnd(w)}  ${t.padStart(12)}  ${Math.round(1e6 / us).toLocaleString('en-US').padStart(11)}  ${note}`);
}
if (hasCache) {
  const speedups = [];
  for (let i = 0; i < rows.length; i += 2) if (rows[i].length && rows[i + 1] && rows[i][0].startsWith('analyze')) speedups.push(`${rows[i][0].replace('analyze, ', '')}: ${(rows[i][1] / rows[i + 1][1]).toFixed(0)}x`);
  console.log(`\nCache speed-up (cold / warm): ${speedups.join(', ')}`);
}
