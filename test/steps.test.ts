import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, exportAs, report } from '../src/index.js';
import { codes, errorCodes, fake, json, rt } from './helpers.js';

const TWO = `
tool two
  description "Look something up, then fetch its details"
  input q: text
  allow network "api.example.com"
  secret API_KEY
  limit time 2s
  limit calls 50/min
  run let first = get "https://api.example.com/a?q={q}" header Authorization = "Bearer {secret.API_KEY}"
  then json
  then pick id
  run get "https://api.example.com/b?id={first}"
  then json
  output json
`;

// ---- parsing -------------------------------------------------------------------------------

test('run steps keep their own then lines and names', () => {
  const t = analyze(TWO).program.tools[0];
  assert.equal(t.steps.length, 2);
  assert.equal(t.steps[0].name, 'first');
  assert.deepEqual(t.steps[0].transforms.map((x) => x.kind), ['json', 'pick']);
  assert.equal(t.steps[1].name, undefined);
  assert.deepEqual(t.steps[1].transforms.map((x) => x.kind), ['json']);
});

test('a then line before the first run still belongs to the first step (old files keep working)', () => {
  const src = `tool t\n  description "d"\n  then json\n  run echo "{{}}"\n  output json\n`;
  const t = analyze(src).program.tools[0];
  assert.deepEqual(t.steps[0].transforms.map((x) => x.kind), ['json']);
});

test('bad step syntax gets helpful errors', () => {
  assert.ok(errorCodes('tool t\n  description "d"\n  run let = echo "x"\n').includes('let-syntax'));
  assert.ok(errorCodes('tool t\n  description "d"\n  let x = echo "x"\n').includes('let-syntax'));
  assert.ok(errorCodes('tool t\n  description "d"\n  run let Bad = echo "x"\n').includes('step-name'));
  assert.ok(errorCodes('tool t\n  description "d"\n  run let secret = echo "x"\n').includes('step-name'));
  const many = Array.from({ length: 11 }, () => '  run echo "x"').join('\n');
  assert.ok(errorCodes(`tool t\n  description "d"\n${many}\n`).includes('too-many-steps'));
});

test('a broken run line does not hand its then lines to the step above it', () => {
  const src = `tool t\n  description "d"\n  run echo "a"\n  run bogus "b"\n  then trim 1\n`;
  const t = analyze(src).program.tools[0];
  assert.equal(t.steps.length, 1);
  assert.deepEqual(t.steps[0].transforms, []);
});

// ---- the result of one step feeds the next ---------------------------------------------------

test('step results feed later steps, encoded for where they land', async () => {
  const host = fake({ respond: (url) => (url.includes('/a?') ? json({ id: 'x y&z' }) : json({ ok: 1 })) });
  const res = await rt(TWO, host).call('two', { q: 'cats' });
  assert.equal(res.ok, true);
  assert.equal(res.output, '{"ok":1}');
  assert.equal(host.calls[0].url, 'https://api.example.com/a?q=cats');
  assert.equal(host.calls[1].url, 'https://api.example.com/b?id=x%20y%26z');
  // The secret header belongs to step 1 only.
  assert.equal(host.calls[0].init.headers.Authorization, 'Bearer sk-super-secret-123');
  assert.equal(host.calls[1].init.headers.Authorization, undefined);
});

test('a step result can never change the host of the next request', async () => {
  const host = fake({ respond: (url) => (url.includes('/a?') ? json({ id: '@evil.com/x' }) : json({ ok: 1 })) });
  await rt(TWO, host).call('two', { q: 'q' });
  assert.equal(new URL(host.calls[1].url).hostname, 'api.example.com');
});

test('a secret that shows up in a step result is redacted before the next step can use it', async () => {
  const host = fake({ respond: (url, init) => (url.includes('/a?') ? json({ id: init.headers.Authorization }) : json({ ok: 1 })) });
  const r = rt(TWO, host);
  const res = await r.call('two', { q: 'q' });
  assert.equal(res.ok, true);
  assert.ok(!host.calls[1].url.includes('sk-super-secret-123'), host.calls[1].url);
  assert.match(host.calls[1].url, /REDACTED/);
  assert.ok(!JSON.stringify(r.audit).includes('sk-super-secret-123'));
});

test('step values that are not text are passed on as JSON', async () => {
  const src = `
tool t
  description "d"
  allow network "api.example.com"
  limit time 1s
  limit calls 5/min
  run let obj = get "https://api.example.com/a"
  then json
  run get "https://api.example.com/b?o={obj}"
`;
  const host = fake({ respond: () => json({ a: [1, 2] }) });
  await rt(src, host).call('t');
  assert.equal(host.calls[1].url, 'https://api.example.com/b?o=%7B%22a%22%3A%5B1%2C2%5D%7D');
});

// ---- every step is checked, statically ------------------------------------------------------

const base = (steps: string, extra = '') => `tool t\n  description "d"\n  input q: text\n  allow network "api.example.com"\n  secret API_KEY\n  allow read "./data"\n  limit time 1s\n  limit calls 5/min\n${extra}${steps}\n`;

test('the allow list applies to every step', () => {
  const ok = '  run let a = get "https://api.example.com/x?q={q}"\n  run get "https://api.example.com/y?q={a}"';
  assert.deepEqual(errorCodes(base(ok)), []);
  const bad2 = '  run let a = get "https://api.example.com/x?q={q}"\n  run get "https://evil.com/y?q={a}"';
  assert.ok(errorCodes(base(bad2)).includes('host-not-allowed'));
  const bad1 = '  run let a = get "https://evil.com/x?q={q}"\n  run get "https://api.example.com/y?q={a}"';
  assert.ok(errorCodes(base(bad1)).includes('host-not-allowed'));
});

test('a step result can never be part of the host', () => {
  const first = '  run let a = get "https://api.example.com/x?q={q}"\n';
  assert.ok(errorCodes(base(first + '  run get "https://{a}/y"')).includes('url-host'));
  assert.ok(errorCodes(base(first + '  run get "https://api.example.com{a}"')).includes('url-host-interp'));
  assert.ok(errorCodes(base(first + '  run get "http://api.example.com/y?x={a}"')).includes('url-http'));
});

test('folder rules apply to every step', () => {
  const first = '  run let a = get "https://api.example.com/x?q={q}"\n';
  assert.deepEqual(errorCodes(base(first + '  run read "./data/{a}.txt"')), []);
  assert.ok(errorCodes(base(first + '  run read "./other/{a}.txt"')).includes('path-not-allowed'));
  assert.ok(errorCodes(base(first + '  run read "./data/../x"')).includes('path-escape'));
  assert.ok(errorCodes(base(first + '  run read "{a}"')).includes('path-prefix'));
  assert.ok(errorCodes(base(first + '  run write "./data/x" content "{a}"')).includes('cap-missing'));
});

test('secrets cannot leak from any step', () => {
  const first = '  run let a = get "https://api.example.com/x?q={q}"\n';
  assert.ok(errorCodes(base(first + '  run echo "{secret.API_KEY}"')).includes('secret-leak'));
  assert.ok(errorCodes(base(first + '  run echo "{secret.NOPE}"')).includes('undeclared-secret'));
});

test('step names: use before definition, duplicates, clashes with inputs, unused results', () => {
  const x = (steps: string) => errorCodes(base(steps));
  assert.ok(x('  run get "https://api.example.com/y?q={later}"\n  run let later = get "https://api.example.com/x"').includes('undeclared-input'));
  assert.ok(x('  run let a = get "https://api.example.com/x?q={a}"').includes('undeclared-input'));
  assert.ok(x('  run let a = get "https://api.example.com/x?q={q}"\n  run let a = get "https://api.example.com/y?q={a}"').includes('duplicate-step'));
  assert.ok(x('  run let q = get "https://api.example.com/x"\n  run get "https://api.example.com/y?q={q}"').includes('step-name-conflict'));
  assert.ok(codes(base('  run let a = get "https://api.example.com/x?q={q}"\n  run get "https://api.example.com/y?q={q}"')).includes('unused-step'));
  assert.ok(codes(base('  run get "https://api.example.com/x?q={q}"\n  run get "https://api.example.com/y?q={q}"')).includes('step-result-discarded'));
  // The typo suggestion knows about step names.
  const d = analyze(base('  run let page = get "https://api.example.com/x?q={q}"\n  run get "https://api.example.com/y?q={pgae}"')).diagnostics.find((e) => e.code === 'undeclared-input');
  assert.match(d?.hint ?? '', /\{page\}/);
});

test('whole-tool rules look at every step', () => {
  const post = '  run let a = get "https://api.example.com/x?q={q}"\n  run post "https://api.example.com/y" body "{{\\"v\\": \\"{a}\\"}}"';
  assert.ok(codes(base(post)).includes('approval-default'));
  assert.ok(errorCodes(base(post, '  cache 1m\n')).includes('cache-side-effect'));
  assert.ok(codes(base(post, '  retry 2\n  approve always\n')).includes('retry-post'));
  assert.ok(!codes(base('  run let a = get "https://api.example.com/x?q={q}"\n  run get "https://api.example.com/y?q={a}"')).includes('no-timeout'));
  const noLimits = `tool t\n  description "d"\n  input q: text\n  allow network "api.example.com"\n  run echo "x"\n  run get "https://api.example.com/x?q={q}"\n`;
  assert.ok(codes(noLimits).includes('no-timeout'));
  assert.ok(codes(noLimits).includes('no-rate-limit'));
});

test('outside content flowing into a side effect is flagged unless a human approves every call', () => {
  const flow = (approve: string) => `tool t\n  description "d"\n  input q: text\n  allow network "api.example.com"\n  allow write "./out"\n  limit time 1s\n  limit calls 5/min\n${approve}  run let a = get "https://api.example.com/x?q={q}"\n  run write "./out/{q}.txt" content "{a}"\n`;
  assert.ok(codes(flow('  approve never\n')).includes('untrusted-flow'));
  assert.ok(codes(flow('  approve untrusted\n')).includes('untrusted-flow'));
  assert.ok(!codes(flow('  approve always\n')).includes('untrusted-flow'));
  assert.ok(!codes(flow('')).includes('untrusted-flow'));
  // It follows the data through an echo step too.
  const viaEcho = `tool t\n  description "d"\n  input q: text\n  allow network "api.example.com"\n  allow write "./out"\n  limit time 1s\n  limit calls 5/min\n  approve never\n  run let a = get "https://api.example.com/x?q={q}"\n  run let b = echo "{a}!"\n  run write "./out/f.txt" content "{b}"\n`;
  assert.ok(codes(viaEcho).includes('untrusted-flow'));
});

// ---- every step is checked, at run time ----------------------------------------------------

test('runtime: a step result used in a path cannot escape the folder', async () => {
  const src = `
tool t
  description "d"
  allow network "api.example.com"
  allow read "./data"
  limit time 1s
  limit calls 5/min
  run let name = get "https://api.example.com/n"
  run read "./data/{name}"
`;
  const host = fake({ respond: () => ({ status: 200, headers: {}, text: '../../etc/passwd' }) });
  host.files.set('data/ok.txt', 'fine');
  const r = rt(src, host);
  assert.equal((await r.call('t')).error?.code, 'DENIED');
  host.respond = () => ({ status: 200, headers: {}, text: 'ok.txt' });
  assert.equal((await r.call('t')).output, 'fine');
});

test('runtime: a redirect inside the second step is checked against the allow list', async () => {
  const host = fake({ respond: (url) => (url.includes('/a?') ? json({ id: 1 }) : { status: 302, headers: { Location: 'https://evil.com/x' }, text: '' }) });
  const res = await rt(TWO, host).call('two', { q: 'q' });
  assert.equal(res.error?.code, 'DENIED');
  assert.equal(host.calls.length, 2);
});

test('runtime: a failing step stops the tool, later steps never run', async () => {
  const host = fake({ respond: () => ({ status: 404, headers: {}, text: '' }) });
  const res = await rt(TWO, host).call('two', { q: 'q' });
  assert.equal(res.error?.code, 'HTTP_ERROR');
  assert.equal(host.calls.length, 1);
});

test('runtime: after a timeout no later step may start', async () => {
  const src = `
tool slow
  description "d"
  allow network "api.example.com"
  limit time 30ms
  limit calls 5/min
  approve never
  run get "https://api.example.com/a"
  run post "https://api.example.com/b" body "{{}}"
`;
  // The first answer arrives AFTER the time limit. The POST must still not be sent.
  const host = fake({ respond: () => new Promise((r) => setTimeout(() => r({ status: 200, headers: {}, text: '{}' }), 120)) });
  const res = await rt(src, host).call('slow');
  assert.equal(res.error?.code, 'TIMEOUT');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(host.calls.length, 1, 'the POST must not have been sent');
});

test('runtime: approval is asked once, before ANY step runs', async () => {
  const src = `
tool t
  description "d"
  input q: text
  allow network "api.example.com"
  limit time 1s
  limit calls 5/min
  run let a = get "https://api.example.com/x?q={q}"
  run post "https://api.example.com/y" body "{{\\"v\\": \\"{a}\\"}}"
`;
  const host = fake();
  const r = rt(src, host);
  assert.equal((await r.call('t', { q: 'x' })).error?.code, 'NEEDS_APPROVAL');
  assert.equal(host.calls.length, 0, 'not even the first GET may run');
  let asked = 0;
  const ok = await r.call('t', { q: 'x' }, { approver: () => (asked++, true) });
  assert.equal(ok.ok, true);
  assert.equal(asked, 1);
  assert.equal(host.calls.length, 2);
  const no = await r.call('t', { q: 'x' }, { approver: () => false });
  assert.equal(no.error?.code, 'DENIED');
  assert.equal(host.calls.length, 2);
});

test('runtime: the call limit counts tool calls, not steps', async () => {
  const src = TWO.replace('limit calls 50/min', 'limit calls 2/min');
  const host = fake({ respond: () => json({ id: 1 }) });
  const r = rt(src, host);
  assert.equal((await r.call('two', { q: 'a' })).ok, true);
  assert.equal((await r.call('two', { q: 'b' })).ok, true);
  assert.equal((await r.call('two', { q: 'c' })).error?.code, 'RATE_LIMITED');
});

test('runtime: caching works only when every step just reads', async () => {
  const cached = TWO.replace('  run let first', '  cache 1m\n  run let first');
  const host = fake({ respond: () => json({ id: 1 }) });
  const r = rt(cached, host);
  await r.call('two', { q: 'same' });
  const again = await r.call('two', { q: 'same' });
  assert.equal(again.cached, true);
  assert.equal(host.calls.length, 2, 'both steps ran once, the second call came from the cache');
});

test('runtime: the audit log records each step of a multi-step tool, and still verifies', async () => {
  const host = fake({ respond: () => json({ id: 1 }) });
  const r = rt(TWO, host);
  await r.call('two', { q: 'q' });
  const steps = r.audit.filter((e) => e.event === 'step').map((e) => e.detail);
  assert.deepEqual(steps, ['1 of 2 (first): get', '2 of 2: get']);
  assert.equal((await r.verifyAudit()).ok, true);
  // Single-step tools log exactly what they logged before.
  const single = rt(`tool s\n  description "d"\n  run echo "x"\n`);
  await single.call('s');
  assert.deepEqual(single.audit.map((e) => e.event), ['call', 'result']);
});

// ---- reports and exports see every step -----------------------------------------------------

test('reports and exports count a risky step even when it is not the last one', () => {
  const src = `
tool t
  description "d"
  input q: text
  allow network "api.example.com"
  allow write "./out"
  limit time 1s
  limit calls 5/min
  approve never
  run write "./out/a.txt" content "{q}"
  run get "https://api.example.com/x?q={q}"
`;
  const a = analyze(src);
  const r = report(a.program, a.diagnostics).tools[0];
  assert.equal(r.sideEffects, true);
  assert.equal(r.steps, 2);
  assert.ok(r.score <= 75, `score was ${r.score}`);
  assert.ok(r.findings.some((f) => /without approval/.test(f)));
  const mcp = (exportAs(a.program, 'mcp') as { tools: any[] }).tools[0];
  assert.equal(mcp.annotations.destructiveHint, true);
  assert.equal(mcp.annotations.readOnlyHint, false);
  assert.equal(mcp.annotations.openWorldHint, true);
  assert.equal(mcp.annotations.idempotentHint, false);
});

test('a multi-step tool with a side-effect step needs approval by default', () => {
  const a = analyze(`tool t\n  description "d"\n  allow write "./o"\n  run echo "x"\n  run write "./o/a" content "x"\n`);
  const r = report(a.program, a.diagnostics).tools[0];
  assert.equal(r.approval, 'always');
  assert.equal(r.approvalImplicit, true);
});
