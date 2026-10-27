import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { analyze, createMcpHandler, dryRunHost, exportAs, report, Runtime, type Host, type HttpInit, type HttpResponse } from '../src/index.js';

// ---- helpers -----------------------------------------------------------------

const codes = (src: string) => analyze(src).diagnostics.map((d) => d.code);
const errorCodes = (src: string) => analyze(src).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);

interface Fake extends Host {
  t: number;
  calls: { url: string; init: HttpInit }[];
  files: Map<string, string>;
  respond: (url: string, init: HttpInit, n: number) => HttpResponse | Promise<HttpResponse>;
}
function fake(over: Partial<Fake> = {}): Fake {
  const f: Fake = {
    t: 1_700_000_000_000,
    calls: [],
    files: new Map(),
    respond: () => ({ status: 200, headers: {}, text: '{"ok":true}' }),
    now: () => f.t,
    sleep: async () => {},
    async fetch(url, init) {
      f.calls.push({ url, init });
      return f.respond(url, init, f.calls.length);
    },
    async readFile(p) {
      const v = f.files.get(p);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    async writeFile(p, c) {
      f.files.set(p, c);
    },
    env: (n) => (n === 'API_KEY' ? 'sk-super-secret-123' : 'tok-' + n + '-value'),
    ...over,
  };
  return f;
}
const rt = (src: string, host: Host = fake()) => {
  const a = analyze(src);
  assert.equal(a.ok, true, 'program should be valid: ' + JSON.stringify(a.diagnostics));
  return new Runtime(a.program, host);
};

const SEARCH = `
tool search
  description "Search"
  input q: text
  input n: number = 3
  allow network "api.example.com"
  secret API_KEY
  limit time 2s
  limit calls 3/min
  run get "https://api.example.com/s?q={q}&n={n}" header Authorization = "Bearer {secret.API_KEY}"
  then json
  output json
`;

// ---- parser & checker ------------------------------------------------------------

test('the bundled examples are valid and warning-free', () => {
  for (const f of ['examples/research.aegis', 'examples/github.aegis']) {
    const a = analyze(readFileSync(f, 'utf8'));
    assert.deepEqual(a.diagnostics.filter((d) => d.severity !== 'info'), [], f);
  }
});

test('unknown keywords get a suggestion', () => {
  const d = analyze('tool a\n  allw network "x.com"\n').diagnostics.find((x) => x.code === 'unknown-keyword');
  assert.ok(d);
  assert.match(d!.hint ?? '', /allow/);
});

test('syntax errors are reported with line and column', () => {
  const a = analyze('tool a\n  description "oops\n');
  const d = a.diagnostics.find((x) => x.code === 'unterminated-string');
  assert.equal(d?.line, 2);
  assert.equal(a.ok, false);
});

test('lines outside a tool and unindented keywords are errors', () => {
  assert.ok(errorCodes('  input x: text\n').includes('outside-tool'));
  assert.ok(errorCodes('input x: text\n').includes('not-indented'));
});

test('the host must be literal and on the allow list', () => {
  const base = (url: string, allow = 'allow network "api.example.com"') => `tool t\n  description "d"\n  ${allow}\n  limit time 1s\n  limit calls 1/min\n  input x: text\n  run get "${url}"\n`;
  assert.ok(errorCodes(base('https://{x}/a')).includes('url-host'));
  assert.ok(errorCodes(base('https://api.example.com{x}')).includes('url-host-interp'));
  assert.ok(errorCodes(base('https://evil.com/a?q={x}')).includes('host-not-allowed'));
  assert.ok(errorCodes(base('https://api.example.com@evil.com/a?q={x}')).includes('url-userinfo'));
  assert.ok(errorCodes(base('http://api.example.com/a?q={x}')).includes('url-http'));
  assert.deepEqual(errorCodes(base('https://api.example.com/a?q={x}')), []);
  assert.deepEqual(errorCodes(base('https://v1.example.com/a?q={x}', 'allow network "*.example.com"')), []);
  assert.ok(errorCodes(base('https://example.com/a?q={x}', 'allow network "*.example.com"')).includes('host-not-allowed'));
});

test('secrets cannot leak into output or files', () => {
  const src = `tool t\n  description "d"\n  secret API_KEY\n  run echo "key is {secret.API_KEY}"\n`;
  assert.ok(errorCodes(src).includes('secret-leak'));
  assert.ok(errorCodes('tool t\n  description "d"\n  run echo "{secret.NOPE}"\n').includes('undeclared-secret'));
});

test('paths must stay inside allowed folders', () => {
  const t = (path: string, allow = 'allow read "./data"') => `tool t\n  description "d"\n  input f: text\n  ${allow}\n  run read "${path}"\n`;
  assert.deepEqual(errorCodes(t('./data/{f}.txt')), []);
  assert.ok(errorCodes(t('./other/{f}.txt')).includes('path-not-allowed'));
  assert.ok(errorCodes(t('./data/../secret.txt')).includes('path-escape'));
  assert.ok(errorCodes(t('{f}')).includes('path-prefix'));
  assert.ok(errorCodes(t('./data{f}')).includes('path-boundary'));
  assert.ok(errorCodes(t('./data/{f}', 'allow read "/"')).includes('path-too-broad'));
  assert.ok(errorCodes('tool t\n  description "d"\n  run read "./x"\n').includes('cap-missing'));
});

test('other static rules', () => {
  assert.ok(errorCodes(`tool t\n  description "d"\n  allow network "a.com"\n  deny network\n  run echo "x"\n`).includes('allow-deny-conflict'));
  assert.ok(errorCodes(`tool t\n  description "d"\n  input x: text\n  run echo "{y}"\n`).includes('undeclared-input'));
  assert.ok(errorCodes(`tool t\n  description "d"\n  allow write "./o"\n  cache 1m\n  run write "./o/a" content "x"\n`).includes('cache-side-effect'));
  assert.ok(errorCodes(`tool t\n  description "d"\n`).includes('missing-run'));
  assert.ok(errorCodes(`tool t\n  description "d"\n  run echo "x"\ntool t\n  description "d"\n  run echo "y"\n`).includes('duplicate-tool'));
  assert.ok(codes(`tool t\n  run echo "x"\n`).includes('no-description'));
  assert.ok(codes(`tool t\n  description "d"\n  input unused: text\n  run echo "x"\n`).includes('unused-input'));
  assert.ok(errorCodes('tool t\n  description "d"\n  run echo "{{ok}} {bad"\n').includes('template'));
});

test('tools with side effects default to requiring approval', () => {
  const src = `tool w\n  description "d"\n  allow write "./o"\n  run write "./o/a" content "x"\n`;
  assert.ok(codes(src).includes('approval-default'));
  const r = report(analyze(src).program, analyze(src).diagnostics);
  assert.equal(r.tools[0].approval, 'always');
  assert.equal(r.tools[0].approvalImplicit, true);
});

test('the security grade reflects risky choices', () => {
  const risky = `tool w\n  description "d"\n  allow network "*.example.com"\n  approve never\n  run post "https://a.example.com/x" body "{{}}"\n`;
  const a = analyze(risky);
  const r = report(a.program, a.diagnostics);
  assert.ok(r.score < 60, `score was ${r.score}`);
  assert.equal(r.grade, 'F');
  const safe = analyze(readFileSync('examples/github.aegis', 'utf8'));
  assert.equal(report(safe.program, safe.diagnostics).grade, 'A');
});

// ---- runtime ----------------------------------------------------------------------

test('a normal call works, injects the secret, and encodes inputs', async () => {
  const host = fake();
  const res = await rt(SEARCH, host).call('search', { q: 'a b&c=d', n: '7' });
  assert.equal(res.ok, true);
  assert.equal(res.output, '{"ok":true}');
  assert.equal(res.untrusted, true);
  assert.equal(host.calls[0].url, 'https://api.example.com/s?q=a%20b%26c%3Dd&n=7');
  assert.equal(host.calls[0].init.headers.Authorization, 'Bearer sk-super-secret-123');
});

test('bad inputs are rejected', async () => {
  const r = rt(SEARCH);
  assert.equal((await r.call('search', {})).error?.code, 'BAD_INPUT');
  assert.equal((await r.call('search', { q: 'x', extra: 1 })).error?.code, 'BAD_INPUT');
  assert.equal((await r.call('search', { q: 'x', n: 'many' })).error?.code, 'BAD_INPUT');
  assert.equal((await r.call('nope')).error?.code, 'UNKNOWN_TOOL');
});

test('secrets are redacted from output and the audit log', async () => {
  const host = fake({ respond: (_u, init) => ({ status: 200, headers: {}, text: JSON.stringify({ echoed: init.headers.Authorization }) }) });
  const r = rt(SEARCH, host);
  const res = await r.call('search', { q: 'x' });
  assert.ok(!res.output!.includes('sk-super-secret-123'));
  assert.match(res.output!, /REDACTED:API_KEY/);
  assert.ok(!JSON.stringify(r.audit).includes('sk-super-secret-123'));
});

test('a missing secret fails cleanly', async () => {
  const res = await rt(SEARCH, fake({ env: () => undefined })).call('search', { q: 'x' });
  assert.equal(res.error?.code, 'MISSING_SECRET');
});

test('redirects to hosts that are not allowed are blocked', async () => {
  const host = fake({ respond: () => ({ status: 302, headers: { Location: 'https://evil.com/steal' }, text: '' }) });
  const res = await rt(SEARCH, host).call('search', { q: 'x' });
  assert.equal(res.error?.code, 'DENIED');
  assert.equal(host.calls.length, 1);
});

test('redirects to allowed hosts are followed without leaking headers', async () => {
  const src = SEARCH.replace('allow network "api.example.com"', 'allow network "api.example.com", "cdn.example.com"');
  const host = fake({
    respond: (url): HttpResponse => (url.startsWith('https://api.') ? { status: 301, headers: { location: 'https://cdn.example.com/r' }, text: '' } : { status: 200, headers: {}, text: '{"from":"cdn"}' }),
  });
  const res = await rt(src, host).call('search', { q: 'x' });
  assert.equal(res.output, '{"from":"cdn"}');
  assert.deepEqual(host.calls[1].init.headers, {});
});

test('path traversal is denied at runtime', async () => {
  const src = readFileSync('examples/research.aegis', 'utf8');
  const host = fake();
  const r = rt(src, host);
  const ok = await r.call('save_note', { name: 'idea', body: 'hello' }, { approver: () => true });
  assert.equal(ok.ok, true);
  assert.equal(host.files.get('notes/idea.md'), 'hello');
  for (const name of ['../../etc/passwd', '..\\..\\x', 'a/../../b']) {
    const bad = await r.call('read_note', { name }, {});
    assert.equal(bad.error?.code, 'DENIED', name);
  }
  assert.equal(host.files.size, 1);
});

test('side-effect tools need an approver, and a human can say no', async () => {
  const src = readFileSync('examples/research.aegis', 'utf8');
  const host = fake();
  const r = rt(src, host);
  assert.equal((await r.call('save_note', { name: 'a', body: 'b' })).error?.code, 'NEEDS_APPROVAL');
  assert.equal((await r.call('save_note', { name: 'a', body: 'b' }, { approver: () => false })).error?.code, 'DENIED');
  assert.equal(host.files.size, 0);
});

test('"approve untrusted" only asks when the context is tainted', async () => {
  const src = readFileSync('examples/research.aegis', 'utf8');
  const r = rt(src);
  assert.equal((await r.call('search_web', { query: 'x' })).ok, true);
  assert.equal((await r.call('search_web', { query: 'y' }, { untrusted: true })).error?.code, 'NEEDS_APPROVAL');
  assert.equal((await r.call('search_web', { query: 'z' }, { untrusted: true, approver: () => true })).ok, true);
});

test('rate limits apply per tool and recover with time', async () => {
  const host = fake();
  const r = rt(SEARCH, host);
  for (let i = 0; i < 3; i++) assert.equal((await r.call('search', { q: 'q' + i })).ok, true);
  assert.equal((await r.call('search', { q: 'again' })).error?.code, 'RATE_LIMITED');
  host.t += 61_000;
  assert.equal((await r.call('search', { q: 'later' })).ok, true);
});

test('results are cached for the configured time', async () => {
  const src = SEARCH.replace('  then json', '  cache 1m\n  then json');
  const host = fake();
  const r = rt(src, host);
  const a = await r.call('search', { q: 'same' });
  const b = await r.call('search', { q: 'same' });
  assert.equal(b.cached, true);
  assert.equal(a.output, b.output);
  assert.equal(host.calls.length, 1);
  host.t += 61_000;
  await r.call('search', { q: 'same' });
  assert.equal(host.calls.length, 2);
});

test('timeouts stop slow tools', async () => {
  const src = SEARCH.replace('limit time 2s', 'limit time 50ms');
  const res = await rt(src, fake({ respond: () => new Promise(() => {}) })).call('search', { q: 'x' });
  assert.equal(res.error?.code, 'TIMEOUT');
});

test('server errors are retried, client errors are not', async () => {
  const src = SEARCH.replace('  then json', '  retry 2\n  then json');
  const flaky = fake({ respond: (_u, _i, n) => (n < 3 ? { status: 503, headers: {}, text: '' } : { status: 200, headers: {}, text: '{"a":1}' }) });
  assert.equal((await rt(src, flaky).call('search', { q: 'x' })).ok, true);
  assert.equal(flaky.calls.length, 3);
  const notFound = fake({ respond: () => ({ status: 404, headers: {}, text: '' }) });
  const res = await rt(src, notFound).call('search', { q: 'x' });
  assert.equal(res.error?.code, 'HTTP_ERROR');
  assert.equal(notFound.calls.length, 1);
});

test('transforms, number output and truncation', async () => {
  const gh = analyze(readFileSync('examples/github.aegis', 'utf8')).program;
  const host = fake({ respond: () => ({ status: 200, headers: {}, text: '{"stargazers_count": 42, "name": "x"}' }) });
  const r = new Runtime(gh, host);
  assert.equal((await r.call('star_count', { owner: 'a', repo: 'b' })).output, '42');
  const small = `tool t\n  description "d"\n  limit output 10b\n  run echo "0123456789ABCDEF"\n`;
  const res = await rt(small).call('t', {});
  assert.equal(res.truncated, true);
  assert.equal(res.output, '0123456789');
  const bad = await new Runtime(gh, fake({ respond: () => ({ status: 200, headers: {}, text: '{"x":1}' }) })).call('star_count', { owner: 'a', repo: 'b' });
  assert.equal(bad.error?.code, 'FAILED');
});

test('the audit log is a verifiable hash chain', async () => {
  const r = rt(SEARCH);
  await r.call('search', { q: 'one' });
  await r.call('search', { q: 'two' });
  assert.ok(r.audit.length >= 6);
  assert.deepEqual(await r.verifyAudit(), { ok: true });
  const copy = r.audit.map((e) => ({ ...e }));
  copy[2].detail = 'tampered';
  assert.deepEqual(await Runtime.verifyAudit(copy), { ok: false, brokenAt: 3 });
  const dropped = r.audit.filter((e) => e.seq !== 2);
  assert.equal((await Runtime.verifyAudit(dropped)).ok, false);
});

test('concurrent calls keep the audit chain intact', async () => {
  const r = rt(SEARCH.replace('limit calls 3/min', 'limit calls 50/min'));
  await Promise.all(Array.from({ length: 10 }, (_, i) => r.call('search', { q: 'q' + i })));
  assert.equal((await r.verifyAudit()).ok, true);
});

test('dry-run host simulates everything and still redacts secrets', async () => {
  const a = analyze(SEARCH);
  const r = new Runtime(a.program, dryRunHost());
  const res = await r.call('search', { q: 'hello' });
  assert.equal(res.ok, true);
  assert.match(res.output!, /dry_run/);
  assert.match(res.output!, /REDACTED:API_KEY/);
});

// ---- exports & MCP ------------------------------------------------------------------

test('exports produce correct schemas and annotations', () => {
  const { program } = analyze(readFileSync('examples/research.aegis', 'utf8'));
  const mcp = (exportAs(program, 'mcp') as { tools: any[] }).tools;
  const search = mcp.find((t) => t.name === 'search_web');
  assert.deepEqual(search.inputSchema.required, ['query']);
  assert.equal(search.inputSchema.properties.count.default, 5);
  assert.equal(search.inputSchema.additionalProperties, false);
  assert.equal(search.annotations.readOnlyHint, true);
  assert.equal(search.annotations.openWorldHint, true);
  const save = mcp.find((t) => t.name === 'save_note');
  assert.equal(save.annotations.destructiveHint, true);
  assert.equal(save.annotations.openWorldHint, false);
  const oa = exportAs(program, 'openai') as any[];
  assert.equal(oa[0].type, 'function');
  assert.equal(oa[0].function.name, 'search_web');
  const an = exportAs(program, 'anthropic') as any[];
  assert.ok(an[0].input_schema);
});

test('the MCP handler speaks the protocol and guards against injection', async () => {
  const { program } = analyze(readFileSync('examples/research.aegis', 'utf8'));
  const r = new Runtime(program, fake());
  const h = createMcpHandler(r);
  const init: any = await h({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, 'aegis');
  assert.equal(await h({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list: any = await h({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.result.tools.length, 4);
  const first: any = await h({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_web', arguments: { query: 'cats' } } });
  assert.equal(first.result.isError, false);
  assert.match(first.result.content[0].text, /UNTRUSTED CONTENT/);
  // The session is now tainted, so a tool marked "approve untrusted" is refused.
  const second: any = await h({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search_web', arguments: { query: 'dogs' } } });
  assert.equal(second.result.isError, true);
  assert.match(second.result.content[0].text, /NEEDS_APPROVAL/);
  const unknown: any = await h({ jsonrpc: '2.0', id: 5, method: 'nope' });
  assert.equal(unknown.error.code, -32601);
});
