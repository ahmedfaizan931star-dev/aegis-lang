import { check } from './checker.js';
import { parse } from './parser.js';
import type { Diagnostic, Program } from './types.js';

export * from './types.js';
export { parse } from './parser.js';
export { check } from './checker.js';
export { Runtime, AegisError, type CallResult, type CallOptions, type AuditEntry, type ApprovalRequest } from './runtime.js';
export type { Host, HttpResponse, HttpInit } from './host.js';
export { dryRunHost } from './dry-run.js';
export { exportAs, toMCP, toOpenAI, toAnthropic, inputSchema, type ExportFormat } from './export.js';
export { report, effectiveApproval, type ProgramReport, type ToolReport, type Grade } from './report.js';
export { createMcpHandler } from './mcp.js';

export interface Analysis {
  program: Program;
  diagnostics: Diagnostic[];
  ok: boolean; // no errors
}

/** Parse + statically check. This is all a UI or CI job needs. */
export function analyze(source: string): Analysis {
  const { program, diagnostics } = parse(source);
  const parseErrors = diagnostics.some((d) => d.severity === 'error');
  // If a line failed to parse, rules that depend on it would only add noise.
  const noisy = new Set(['missing-run', 'unused-input', 'unused-secret']);
  const checked = check(program).filter((d) => !(parseErrors && noisy.has(d.code)));
  const all = [...diagnostics, ...checked].sort((a, b) => a.line - b.line || a.col - b.col);
  return { program, diagnostics: all, ok: !all.some((d) => d.severity === 'error') };
}

/** Human-friendly diagnostics with the source line and a caret underline. */
export function formatDiagnostics(source: string, file: string, diags: Diagnostic[], color = false): string {
  const c = (code: string, s: string) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
  const lines = source.split(/\r?\n/);
  const sevColor = { error: '31', warning: '33', info: '36' } as const;
  return diags
    .map((d) => {
      const text = lines[d.line - 1] ?? '';
      const gutter = String(d.line).padStart(4);
      const caret = ' '.repeat(Math.max(0, d.col - 1)) + '^'.repeat(Math.max(1, Math.min(d.endCol, text.length + 1) - d.col));
      const out = [
        `${c('1', `${file}:${d.line}:${d.col}`)} ${c(sevColor[d.severity], d.severity)} ${d.message}`,
        `${c('2', gutter + ' |')} ${text}`,
        `${c('2', '     |')} ${c(sevColor[d.severity], caret)}`,
      ];
      if (d.hint) out.push(`     ${c('2', '=')} ${d.hint}`);
      return out.join('\n');
    })
    .join('\n\n');
}
