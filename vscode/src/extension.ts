import * as vscode from 'vscode';
import { analyze } from '../../src/index.js';
import { toMarks } from './map.js';

const LANGUAGE = 'aegis';

/**
 * Live checking: every time an .aegis file changes, run the real Aegis checker on its text
 * (the same code as `aegis check`) and underline what it finds.
 */
export function activate(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection('aegis');
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  context.subscriptions.push(collection);

  const settings = () => vscode.workspace.getConfiguration('aegis.check');

  function check(doc: vscode.TextDocument): void {
    if (doc.languageId !== LANGUAGE) return;
    if (!settings().get<boolean>('enable', true)) {
      collection.delete(doc.uri);
      return;
    }
    const lineLengths: number[] = [];
    for (let i = 0; i < doc.lineCount; i++) lineLengths.push(doc.lineAt(i).text.length);
    let marks;
    try {
      marks = toMarks(analyze(doc.getText()).diagnostics, lineLengths);
    } catch (e) {
      // The checker should never throw, but if it does we show one clear message instead of nothing.
      const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), `The Aegis checker crashed: ${(e as Error).message}`, vscode.DiagnosticSeverity.Warning);
      d.source = 'aegis';
      collection.set(doc.uri, [d]);
      return;
    }
    collection.set(
      doc.uri,
      marks.map((m) => {
        const d = new vscode.Diagnostic(new vscode.Range(m.startLine, m.startCol, m.endLine, m.endCol), m.message, m.severity as vscode.DiagnosticSeverity);
        d.source = 'aegis';
        d.code = m.code;
        return d;
      }),
    );
  }

  function checkSoon(doc: vscode.TextDocument): void {
    if (doc.languageId !== LANGUAGE) return;
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        check(doc);
      }, settings().get<number>('delayMs', 200)),
    );
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidChangeTextDocument((e) => checkSoon(e.document)),
    vscode.workspace.onDidSaveTextDocument(check),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      clearTimeout(timers.get(doc.uri.toString()));
      timers.delete(doc.uri.toString());
      collection.delete(doc.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aegis.check')) vscode.workspace.textDocuments.forEach(check);
    }),
  );

  vscode.workspace.textDocuments.forEach(check);
}

export function deactivate(): void {}
