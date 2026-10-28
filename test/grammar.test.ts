import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import * as oniguruma from 'vscode-oniguruma';
import * as textmate from 'vscode-textmate';

// Uses the same TextMate engine VS Code uses, so these checks show what the colours will really be.
const req = createRequire(import.meta.url);
const wasm = readFileSync(req.resolve('vscode-oniguruma/release/onig.wasm'));
const ready = oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
const registry = new textmate.Registry({
  onigLib: ready.then(() => ({ createOnigScanner: (p: string[]) => new oniguruma.OnigScanner(p), createOnigString: (s: string) => new oniguruma.OnigString(s) })),
  loadGrammar: async (scope) => (scope === 'source.aegis' ? textmate.parseRawGrammar(readFileSync('vscode/syntaxes/aegis.tmLanguage.json', 'utf8'), 'aegis.tmLanguage.json') : null),
});

/** Returns [text, last scope] for every token on every line. */
async function tokens(source: string): Promise<[string, string][][]> {
  const g = await registry.loadGrammar('source.aegis');
  assert.ok(g, 'grammar should load');
  let state = textmate.INITIAL;
  return source.split('\n').map((line) => {
    const r = g.tokenizeLine(line, state);
    state = r.ruleStack;
    return r.tokens.map((t): [string, string] => [line.slice(t.startIndex, t.endIndex), t.scopes[t.scopes.length - 1]]);
  });
}
const scopeOf = (line: [string, string][], text: string) => line.find(([t]) => t === text)?.[1];

test('block starts, statement keywords and comments are coloured', async () => {
  const [l1, l2, l3] = await tokens('tool search_web\n  description "x"  # note\n  allow network "a.com"');
  assert.equal(scopeOf(l1, 'tool'), 'storage.type.block.aegis');
  assert.equal(scopeOf(l2, 'description'), 'keyword.control.statement.aegis');
  assert.equal(l2.find(([t]) => t.includes('# note'))?.[1], 'comment.line.number-sign.aegis');
  assert.equal(scopeOf(l3, 'allow'), 'keyword.control.statement.aegis');
  assert.equal(scopeOf(l3, 'network'), 'support.type.capability.aegis');
});

test('strings, placeholders, secrets and escaped braces inside strings', async () => {
  const [l] = await tokens('  run get "https://a.com/?q={query}&k={secret.API_KEY} {{x}}"');
  assert.equal(scopeOf(l, 'run'), 'keyword.control.statement.aegis');
  assert.equal(scopeOf(l, 'get'), 'support.function.action.aegis');
  assert.equal(scopeOf(l, '{query}'), 'variable.parameter.placeholder.aegis');
  assert.equal(scopeOf(l, '{secret.API_KEY}'), 'variable.other.secret.aegis');
  assert.equal(scopeOf(l, '{{'), 'constant.character.escape.brace.aegis');
});

test('multi-step and test keywords', async () => {
  const [a, b, c, d] = await tokens('  run let page = get "https://a.com"\n  call tool_a n=3 untrusted\n  expect output not contains "x"\ntest "my test"');
  assert.equal(scopeOf(a, 'let'), 'keyword.other.let.aegis');
  assert.equal(scopeOf(a, '='), 'keyword.operator.assignment.aegis');
  assert.equal(scopeOf(b, 'call'), 'keyword.control.statement.aegis');
  assert.equal(scopeOf(b, 'untrusted'), 'constant.language.approval.aegis');
  assert.equal(scopeOf(c, 'expect'), 'keyword.control.statement.aegis');
  assert.equal(scopeOf(c, 'contains'), 'keyword.operator.expect.aegis');
  assert.equal(scopeOf(d, 'test'), 'storage.type.block.aegis');
});

test('numbers, durations, rates, types and secret names', async () => {
  const [a, b, c, d] = await tokens('  limit time 5s\n  limit calls 10/min\n  input count: number = 5\n  secret SEARCH_KEY');
  assert.equal(scopeOf(a, '5s'), 'constant.numeric.aegis');
  assert.equal(scopeOf(b, '10/min'), 'constant.numeric.rate.aegis');
  assert.equal(scopeOf(c, 'number'), 'storage.type.input.aegis');
  assert.equal(scopeOf(d, 'SEARCH_KEY'), 'constant.other.secret-name.aegis');
});

test('an unterminated string does not colour the next line', async () => {
  const [, next] = await tokens('  description "oops\n  run echo "ok"');
  assert.equal(scopeOf(next, 'run'), 'keyword.control.statement.aegis');
});

test('every example file tokenizes without throwing', async () => {
  for (const f of ['research', 'github', 'risky', 'multistep']) await tokens(readFileSync(`examples/${f}.aegis`, 'utf8'));
});
