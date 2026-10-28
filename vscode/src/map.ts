import type { Diagnostic } from '../../src/types.js';

/** Plain numbers, so this can be tested without VS Code. 0-based lines and columns, like VS Code uses. */
export interface MarkInfo {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  /** 0 = error, 1 = warning, 2 = information (the same numbers as vscode.DiagnosticSeverity). */
  severity: 0 | 1 | 2;
  message: string;
  code: string;
}

/**
 * Turns checker diagnostics (1-based) into underline positions (0-based).
 * `lineLengths[n]` is the length of line n, so a range can never run past the end of its line.
 */
export function toMarks(diags: readonly Diagnostic[], lineLengths: readonly number[]): MarkInfo[] {
  const lastLine = Math.max(0, lineLengths.length - 1);
  return diags.map((d) => {
    const line = Math.min(Math.max(0, d.line - 1), lastLine);
    const len = lineLengths[line] ?? 0;
    const start = Math.min(Math.max(0, d.col - 1), len);
    let end = Math.min(Math.max(0, d.endCol - 1), len);
    if (end <= start) end = Math.min(len, start + 1); // always underline at least one character, if the line has one
    return {
      startLine: line,
      startCol: start,
      endLine: line,
      endCol: end,
      severity: d.severity === 'error' ? 0 : d.severity === 'warning' ? 1 : 2,
      message: d.hint ? `${d.message}\n${d.hint}` : d.message,
      code: d.code,
    };
  });
}
