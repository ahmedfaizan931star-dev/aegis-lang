import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyze, report, runTests } from '../src/index.js';
import { codes, errorCodes } from './helpers.js';

const TOOLS = `
tool fetch_page
  description "d"
  input slug: text
  allow network "docs.example.org"
  limit time 1s
  limit calls 2/min
  run get "https://docs.example.org/p?slug={slug}"

tool save
  description "d"
  input name: text
  allow write "./out"
  run write "./out/{name}.txt" content "x"

tool load
  description "d"
  input name: text
  allow read "./in"
  run read "./in/{name}"
`;
const prog = (tests: string) => {
  const a = analyze(TOOLS + '\n' + tests);
  assert.equal(a.ok, true, JSON.stringify(a.diagnostics));
  return a.program;
};

// ---- parsing ---------------------------------------------------------------------------------

test('test blocks are parsed: mocks, calls, flags, arguments and expectations', () => {
  const p = prog(`test "everything"
  mock "https://docs.example.org/p" status 302 body "hi" header Location = "https://evil.com/x"
  call fetch_page slug="a b" untrusted approved
  expect ok
  expect denied
  expect error RATE_LIMITED
  expect error
  expect output "x"
  expect output contains "y"
  expect output not contains "z"
`);
  const t = p.tests[0];
  assert.equal(t.name, 'everything');
  assert.deepEqual([t.mocks[0].status, t.mocks[0].body, t.mocks[0].headers], [302, 'hi', { Location: 'https://evil.com/x' }]);
  const c = t.calls[0];
  assert.deepEqual([c.tool, c.untrusted, c.approved], ['fetch_page', true, true]);
  assert.deepEqual(c.args.map((a) => [a.name, a.value]), [['slug', 'a b']]);
  assert.deepEqual(c.expects.map((e) => e.kind), ['ok', 'denied', 'error', 'error', 'output', 'output', 'output']);
  assert.deepEqual(c.expects.filter((e) => e.kind === 'output').map((e: any) => e.mode), ['equals', 'contains', 'not-contains']);
});

test('argument types: numbers, booleans, and inputs that are named like the flags', () => {
  const a = analyze(`tool t\n  description "d"\n  input n: number\n  input b: bool\n  input approved: bool\n  run echo "{n}{b}{approved}"\ntest "x"\n  call t n=2.5 b=true approved=false\n  expect ok\n`);
  assert.equal(a.ok, true, JSON.stringify(a.diagnostics));
  const c = a.program.tests[0].calls[0];
  assert.deepEqual(c.args.map((x) => x.value), [2.5, true, false]);
  assert.equal(c.approved, false);
});

test('syntax mistakes inside tests are reported', () => {
  const t = (body: string) => errorCodes(TOOLS + `\ntest "x"\n${body}`);
  assert.ok(t('  expect ok\n').includes('expect-before-call'));
  assert.ok(t('  call fetch_page slug=hello\n').includes('call-arg'));
  assert.ok(t('  call fetch_page slug\n').includes('call-arg'));
  assert.ok(t('  call fetch_page slug="a"\n  expect okk\n').includes('expect-syntax'));
  assert.ok(t('  call fetch_page slug="a"\n  expect error NOPE\n').includes('expect-code'));
  assert.ok(t('  call fetch_page slug="a"\n  expect output\n').includes('expect-syntax'));
  assert.ok(t('  call fetch_page slug="a"\n  expect output not "x"\n').includes('expect-syntax'));
  assert.ok(t('  mock "https://a.com" status 99\n').includes('mock-status'));
  assert.ok(t('  mock https://a.com\n').includes('mock-syntax'));
  assert.ok(t('  calll fetch_page\n').includes('unknown-keyword'));
  assert.ok(errorCodes('test oops\n').includes('test-name'));
  const hint = analyze(TOOLS + '\ntest "x"\n  call fetch_page slug="a"\n  expect error RATE_LIMTED\n').diagnostics.find((d) => d.code === 'expect-code');
  assert.match(hint?.hint ?? '', /RATE_LIMITED/);
});

test('static checks: unknown tools and inputs, duplicates, empty tests', () => {
  const c = (body: string) => codes(TOOLS + `\n${body}`);
  assert.ok(c('test "x"\n  call fech_page slug="a"\n  expect ok\n').includes('test-unknown-tool'));
  assert.ok(c('test "x"\n  call fetch_page slg="a"\n  expect ok\n').includes('test-unknown-arg'));
  assert.ok(c('test "x"\n  call save name="a"\n  expect ok\ntest "x"\n  call save name="b"\n  expect ok\n').includes('duplicate-test'));
  assert.ok(c('test "x"\n').includes('test-no-call'));
  assert.ok(c('test "x"\n  call save name="a"\n').includes('test-no-expect'));
  assert.ok(c('test "x"\n  mock "ftp://a.com"\n  call save name="a"\n  expect ok\n').includes('mock-url'));
  assert.deepEqual(codes(TOOLS + '\ntest "fine"\n  call save name="a" approved\n  expect ok\n').filter((x) => x !== 'approval-default'), []);
});

test('messages in a test block never count against the tool above it', () => {
  const clean = analyze(TOOLS);
  const withBadTest = analyze(TOOLS + '\ntest "x"\n  call save name="a"\n');
  const grade = (a: ReturnType<typeof analyze>) => report(a.program, a.diagnostics).tools[1].score;
  assert.equal(grade(withBadTest), grade(clean));
});

// ---- running ---------------------------------------------------------------------------------

test('passing tests pass, and failures say which line and why', async () => {
  const p = prog(`test "good"
  call fetch_page slug="a"
  expect ok
  expect output contains "dry_run"

test "bad"
  call fetch_page slug="a"
  expect denied
  expect output "nope"
  expect error BAD_INPUT
`);
  const [good, bad] = await runTests(p);
  assert.equal(good.passed, true);
  assert.equal(bad.passed, false);
  assert.equal(bad.failures.length, 3);
  assert.match(bad.failures[0], /^line \d+: expected denied, but it succeeded/);
  assert.match(bad.failures[1], /^line \d+: expected output "nope"/);
  assert.match(bad.failures[2], /^line \d+: expected an error/);
});

test('mocks answer matching requests, everything else gets the simulated reply', async () => {
  const p = prog(`test "mocked"
  mock "https://docs.example.org/p?slug=a" body "from the mock"
  call fetch_page slug="a"
  expect output "from the mock"
  call fetch_page slug="b"
  expect output contains "dry_run"
`);
  assert.equal((await runTests(p))[0].passed, true);
});

test('denied means a security rule said no: a blocked redirect, a path escape, or a call that needs a human', async () => {
  const p = prog(`test "redirect"
  mock "https://docs.example.org/" status 302 header Location = "https://evil.com/x"
  call fetch_page slug="a"
  expect denied
  expect error DENIED

test "needs a human"
  call save name="a"
  expect denied
  expect error NEEDS_APPROVAL
  call save name="a" approved
  expect ok

test "path"
  call load name="../../x"
  expect error DENIED

test "not denied: a plain error"
  mock "https://docs.example.org/" status 404
  call fetch_page slug="a"
  expect denied
`);
  const r = await runTests(p);
  assert.deepEqual(r.map((x) => x.passed), [true, true, true, false]);
});

test('every test starts fresh: limits and caches do not leak between tests', async () => {
  const p = prog(`test "uses up the limit"
  call fetch_page slug="1"
  call fetch_page slug="2"
  call fetch_page slug="3"
  expect error RATE_LIMITED

test "has its own limit"
  call fetch_page slug="1"
  expect ok
`);
  assert.deepEqual((await runTests(p)).map((x) => x.passed), [true, true]);
});

test('the test host never touches the real network', async () => {
  const p = prog(`test "x"\n  call fetch_page slug="a"\n  expect output contains "simulated"\n`);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('real network used!');
  }) as typeof fetch;
  try {
    assert.equal((await runTests(p))[0].passed, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('filter runs only matching tests', async () => {
  const p = prog(`test "alpha one"\n  call save name="a" approved\n  expect ok\ntest "beta two"\n  call save name="a" approved\n  expect ok\n`);
  assert.deepEqual((await runTests(p, { filter: 'beta' })).map((x) => x.name), ['beta two']);
});

// ---- the command line ---------------------------------------------------------------------------

const cli = (...args: string[]) => spawnSync(process.execPath, ['dist/aegis.mjs', ...args], { encoding: 'utf8' });
const tmp = (name: string, text: string) => {
  const f = join(mkdtempSync(join(tmpdir(), 'aegis-')), name);
  writeFileSync(f, text);
  return f;
};

test('aegis test: exit code 0 when everything passes, 1 on a failure, 1 on a broken file', () => {
  const ok = tmp('ok.aegis', TOOLS + '\ntest "a"\n  call save name="a" approved\n  expect ok\n');
  const bad = tmp('bad.aegis', TOOLS + '\ntest "a"\n  call save name="a"\n  expect ok\n');
  const broken = tmp('broken.aegis', TOOLS + '\ntest "a"\n  call nope\n  expect ok\n');
  const good = cli('test', ok);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /PASSED: 1 passed, 0 failed/);
  const fail = cli('test', bad);
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /FAILED: 0 passed, 1 failed/);
  assert.match(fail.stdout, /expected ok, but it failed with NEEDS_APPROVAL/);
  const br = cli('test', broken);
  assert.equal(br.status, 1);
  assert.match(br.stdout, /cannot run tests/);
});

test('aegis test: no tests is a failure unless --allow-empty', () => {
  const none = tmp('none.aegis', TOOLS);
  assert.equal(cli('test', none).status, 1);
  assert.equal(cli('test', none, '--allow-empty').status, 0);
  assert.equal(cli('test', '--filter', 'zzz', none).status, 1);
});

test('aegis test: the bundled examples pass', () => {
  const r = cli('test', 'examples/research.aegis', 'examples/github.aegis', 'examples/multistep.aegis');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
