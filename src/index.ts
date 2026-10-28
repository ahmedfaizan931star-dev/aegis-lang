import { deepFreeze, LruCache } from './cache.js';
import { check } from './checker.js';
import { parseCache, parseUncached } from './parser.js';
import type { Diagnostic, Program } from './types.js';

export * from './types.js';
export { parse, type ParseResult } from './parser.js';
export { check } from './checker.js';
export { Runtime, AegisError, type CallResult, type CallOptions, type AuditEntry, type ApprovalRequest } from './runtime.js';
export type { Host, HttpResponse, HttpInit } from './host.js';
export { dryRunHost } from './dry-run.js';
export { exportAs, toMCP, toOpenAI, toAnthropic, inputSchema, type ExportFormat } from './export.js';
export { report, effectiveApproval, type ProgramReport, type ToolReport, type Grade } from './report.js';
export { createMcpHandler } from './mcp.js';
export { runTests, testHost, type TestResult, type RunTestsOptions } from './testing.js';
export { toolTraits } from './steps.js';
export { VERSION } from './version.js';

export interface Analysis {
  program: Program;
  diagnostics: Diagnostic[];
  ok: boolean; // no errors
}

const analysisCache = new LruCache<Analysis>(64, 1_000_000);
const MAX_CACHED_SOURCE = 512 * 1024;

/** Forget everything remembered by parse() and analyze(). Mostly useful for benchmarks and tests. */
export function clearCaches(): void {
  parseCache.clear();
  analysisCache.clear();
}

/** How well the caches are working. */
export function cacheStats() {
  return { parse: { size: parseCache.size, hits: parseCache.hits, misses: parseCache.misses }, analyze: { size: analysisCache.size, hits: analysisCache.hits, misses: analysisCache.misses } };
}

/**
 * Parse + statically check. This is all a UI or CI job needs.
 * The result for a given source text is cached and frozen: asking again for the same text is a lookup.
 */
export function analyze(source: string): Analysis {
  if (source.length > MAX_CACHED_SOURCE) return analyzeUncached(source);
  const hit = analysisCache.get(source);
  if (hit) return hit;
  const fresh = deepFreeze(analyzeUncached(source));
  analysisCache.set(source, fresh);
  return fresh;
}

function analyzeUncached(source: string): Analysis {
  // analyze() keeps its own cache, so it does not also fill the parse() cache.
  const { program, diagnostics } = parseUncached(source);
  const parseErrors = diagnostics.some((d) => d.severity === 'error');
  // If a line failed to parse, rules that depend on it would only add noise.
  const noisy = new Set(['missing-run', 'unused-input', 'unused-secret', 'unused-step']);
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
