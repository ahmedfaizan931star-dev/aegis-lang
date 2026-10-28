import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyze } from '../src/index.js';
import { toMarks } from '../vscode/src/map.js';

const lens = (src: string) => src.split('\n').map((l) => l.length);

test('diagnostics become 0-based underline ranges inside their line', () => {
  const src = 'tool t\n  description "d"\n  run get "https://evil.com/x"\n';
  const marks = toMarks(analyze(src).diagnostics, lens(src));
  const host = marks.find((m) => m.code === 'host-not-allowed');
  assert.ok(host);
  assert.equal(host.startLine, 2);
  assert.equal(src.split('\n')[2].slice(host.startCol, host.endCol), '"https://evil.com/x"');
  assert.equal(host.severity, 0);
  assert.match(host.message, /not in this tool's network allow list/);
  assert.match(host.message, /allow network "evil.com"/); // the hint is shown too
  assert.ok(marks.some((m) => m.severity === 1)); // warnings
});

test('ranges never leave the line, and are never empty when the line has text', () => {
  const m = toMarks([{ severity: 'error', code: 'x', message: 'm', line: 1, col: 50, endCol: 60 }, { severity: 'info', code: 'y', message: 'm', line: 9, col: 1, endCol: 1 }], [5, 3]);
  assert.deepEqual([m[0].startCol, m[0].endCol], [5, 5]);
  assert.equal(m[1].startLine, 1); // clamped to the last line
  assert.equal(m[1].severity, 2);
  assert.ok(m[1].endCol > m[1].startCol);
});

// ---- the extension itself, run against a pretend "vscode" module -----------------------------
// This checks our wiring (when we check, what we show, clean-up). It cannot prove that real VS Code accepts the calls.

test('the bundled extension checks open and changed documents and clears closed ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-ext-'));
  const out = join(dir, 'extension.cjs');
  await build({ bundle: true, entryPoints: ['vscode/src/extension.ts'], platform: 'node', format: 'cjs', outfile: out, external: ['vscode'], logLevel: 'silent' });

  const sets = new Map<string, any[]>();
  const handlers: Record<string, (...a: any[]) => void> = {};
  const on = (name: string) => (fn: (...a: any[]) => void) => ((handlers[name] = fn), { dispose() {} });
  let enabled = true;
  const makeDoc = (text: string, languageId = 'aegis', uri = 'file:///a.aegis') => ({
    languageId,
    uri: { toString: () => uri },
    lineCount: text.split('\n').length,
    lineAt: (i: number) => ({ text: text.split('\n')[i] }),
    getText: () => text,
  });
  let doc = makeDoc('tool t\n  description "d"\n  run get "https://evil.com/x"\n');
  const stub = {
    Range: class { constructor(public sl: number, public sc: number, public el: number, public ec: number) {} },
    Diagnostic: class { source?: string; code?: string; constructor(public range: unknown, public message: string, public severity: number) {} },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    languages: { createDiagnosticCollection: () => ({ set: (u: any, d: any[]) => sets.set(u.toString(), d), delete: (u: any) => sets.delete(u.toString()), dispose() {} }) },
    workspace: {
      textDocuments: [doc],
      getConfiguration: () => ({ get: (k: string, d: unknown) => (k === 'enable' ? enabled : k === 'delayMs' ? 0 : d) }),
      onDidOpenTextDocument: on('open'),
      onDidChangeTextDocument: on('change'),
      onDidSaveTextDocument: on('save'),
      onDidCloseTextDocument: on('close'),
      onDidChangeConfiguration: on('config'),
    },
  };
  const M = Module as any;
  const original = M._load;
  M._load = (request: string, ...rest: unknown[]) => (request === 'vscode' ? stub : original.call(M, request, ...rest));
  let ext: any;
  try {
    ext = createRequire(import.meta.url)(out);
  } finally {
    M._load = original;
  }
  ext.activate({ subscriptions: [] });

  // Open documents are checked on activation.
  const first = sets.get('file:///a.aegis')!;
  assert.ok(first.some((d) => d.code === 'host-not-allowed' && d.source === 'aegis' && d.severity === 0));

  // A change is re-checked (after the delay), and fixing the error removes it.
  doc = makeDoc('tool t\n  description "d"\n  allow network "evil.com"\n  limit time 1s\n  limit calls 1/min\n  run get "https://evil.com/x"\n');
  handlers.change({ document: doc });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!sets.get('file:///a.aegis')!.some((d) => d.severity === 0));

  // Other languages are ignored. Closing a file clears its marks. Turning the setting off clears them too.
  handlers.change({ document: makeDoc('tool', 'plaintext', 'file:///b.txt') });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sets.has('file:///b.txt'), false);
  enabled = false;
  handlers.save(doc);
  assert.equal(sets.has('file:///a.aegis'), false);
  enabled = true;
  handlers.save(doc);
  assert.equal(sets.has('file:///a.aegis'), true);
  handlers.close(doc);
  assert.equal(sets.has('file:///a.aegis'), false);
});

test('the extension manifest points at files that exist and registers the .aegis language', () => {
  const m = JSON.parse(readFileSync('vscode/package.json', 'utf8'));
  assert.deepEqual(m.contributes.languages[0].extensions, ['.aegis']);
  assert.equal(m.contributes.grammars[0].scopeName, 'source.aegis');
  for (const f of [m.contributes.languages[0].configuration, m.contributes.grammars[0].path]) readFileSync(join('vscode', f)); // throws if missing
  assert.deepEqual(m.activationEvents, ['onLanguage:aegis']);
  JSON.parse(readFileSync('vscode/language-configuration.json', 'utf8'));
});
