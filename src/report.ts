import { toolTraits } from './steps.js';
import type { Diagnostic, Program, Tool } from './types.js';

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface ToolReport {
  name: string;
  network: string[];
  read: string[];
  write: string[];
  secrets: string[];
  sideEffects: boolean;
  approval: 'never' | 'always' | 'untrusted';
  approvalImplicit: boolean;
  untrustedOutput: boolean;
  /** How many run steps the tool has. */
  steps: number;
  limits: { time?: string; calls?: string; output?: string };
  score: number;
  grade: Grade;
  findings: string[];
}

export interface ProgramReport {
  tools: ToolReport[];
  score: number;
  grade: Grade;
}

export function gradeOf(score: number): Grade {
  return score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
}

/** Side-effecting tools need approval unless the author explicitly says otherwise. */
export function effectiveApproval(tool: Tool): { mode: 'never' | 'always' | 'untrusted'; implicit: boolean } {
  if (tool.approve) return { mode: tool.approve, implicit: false };
  // Any step with side effects is enough: one safe-looking step must not hide a risky one.
  return toolTraits(tool).side ? { mode: 'always', implicit: true } : { mode: 'never', implicit: true };
}

export function report(program: Program, diagnostics: Diagnostic[]): ProgramReport {
  // Tools and tests both start a new block, so a test's messages never count against the tool above it.
  const starts = [...program.tools.map((t) => t.line), ...(program.tests ?? []).map((t) => t.line)].sort((a, b) => a - b);
  const tools = program.tools.map((tool): ToolReport => {
    const next = starts.find((s) => s > tool.line) ?? Infinity;
    const mine = diagnostics.filter((d) => d.line >= tool.line && d.line < next);
    const { net, side, post, untrusted } = toolTraits(tool);
    const ap = effectiveApproval(tool);
    let score = 100;
    const findings: string[] = [];

    for (const n of tool.network) if (n.value.startsWith('*.')) { score -= 15; findings.push(`Wildcard host ${n.value}`); }
    if (tool.read.length) { score -= 5; findings.push('Can read files'); }
    if (tool.write.length) { score -= 10; findings.push('Can write files'); }
    if (post) { score -= 10; findings.push('Sends data to the network'); }
    if (side && ap.mode === 'never') { score -= 25; findings.push('Side effects run without approval'); }
    if (net && tool.timeMs === undefined) { score -= 10; findings.push('No time limit'); }
    if (net && !tool.calls) { score -= 5; findings.push('No call limit'); }
    score -= 30 * mine.filter((d) => d.severity === 'error').length;
    score -= 5 * mine.filter((d) => d.severity === 'warning').length;
    if (tool.secrets.length) findings.push('Uses secrets (never shown to the model, redacted from output and logs)');
    if (side && ap.implicit) findings.push('Approval required by default');
    if (!findings.length) findings.push('No capabilities beyond its inputs');
    score = Math.max(0, Math.min(100, score));

    return {
      name: tool.name,
      network: tool.network.map((n) => n.value),
      read: tool.read.map((n) => n.value),
      write: tool.write.map((n) => n.value),
      secrets: tool.secrets.map((s) => s.name),
      sideEffects: side,
      approval: ap.mode,
      approvalImplicit: ap.implicit,
      untrustedOutput: untrusted,
      steps: tool.steps.length,
      limits: {
        time: tool.timeLabel,
        calls: tool.calls?.label,
        output: tool.outputBytes ? `${Math.round(tool.outputBytes / 1024)}kb` : undefined,
      },
      score,
      grade: gradeOf(score),
    findings,
    };
  });
  const score = tools.length ? Math.min(...tools.map((t) => t.score)) : 100;
  return { tools, score, grade: gradeOf(score) };
}
