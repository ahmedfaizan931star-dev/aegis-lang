import { dryRunHost } from './dry-run.js';
import type { Host } from './host.js';
import { Runtime, type CallResult } from './runtime.js';
import type { Expectation, Program, TestCall, TestCase } from './types.js';

export interface TestResult {
  name: string;
  line: number;
  passed: boolean;
  /** One message per failed expectation, each starting with its line number. */
  failures: string[];
  ms: number;
}

export interface RunTestsOptions {
  /** Only run tests whose name contains this text. */
  filter?: string;
}

/**
 * The host used by `aegis test`. It never touches the real network or disk: every request gets the
 * simulated dry-run answer, unless a `mock` line in the test says otherwise.
 */
export function testHost(test: TestCase): Host {
  const base = dryRunHost();
  return dryRunHost({
    async fetch(url, init) {
      const mock = test.mocks.find((m) => url.startsWith(m.url.value));
      if (mock) return { status: mock.status, headers: { ...mock.headers }, text: mock.body };
      return base.fetch(url, init);
    },
  });
}

/** Run every `test` block of a program. Each test gets a fresh runtime, so tests cannot affect each other. */
export async function runTests(program: Program, opts: RunTestsOptions = {}): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const test of program.tests ?? []) {
    if (opts.filter && !test.name.includes(opts.filter)) continue;
    results.push(await runOne(program, test));
  }
  return results;
}

async function runOne(program: Program, test: TestCase): Promise<TestResult> {
  const started = Date.now();
  const rt = new Runtime(program, testHost(test));
  const failures: string[] = [];
  for (const call of test.calls) {
    const res = await rt.call(call.tool, argsOf(call), { untrusted: call.untrusted, approver: call.approved ? () => true : undefined });
    for (const e of call.expects) {
      const problem = judge(e, res);
      if (problem) failures.push(`line ${e.line}: ${problem}`);
    }
  }
  return { name: test.name, line: test.line, passed: failures.length === 0, failures, ms: Date.now() - started };
}

function argsOf(call: TestCall): Record<string, unknown> {
  return Object.fromEntries(call.args.map((a) => [a.name, a.value]));
}

const shorten = (s: string) => (s.length > 80 ? s.slice(0, 77) + '...' : s);
const what = (r: CallResult) => (r.ok ? `it succeeded with output "${shorten(r.output ?? '')}"` : `it failed with ${r.error!.code}: ${shorten(r.error!.message)}`);

/** Returns a message when the expectation does NOT hold, or undefined when it does. */
function judge(e: Expectation, r: CallResult): string | undefined {
  switch (e.kind) {
    case 'ok':
      return r.ok ? undefined : `expected ok, but ${what(r)}`;
    case 'denied':
      // "Denied" means a security rule said no: a blocked host or path, or a call that needed a human.
      return !r.ok && (r.error!.code === 'DENIED' || r.error!.code === 'NEEDS_APPROVAL') ? undefined : `expected denied, but ${what(r)}`;
    case 'error':
      if (r.ok) return `expected an error, but ${what(r)}`;
      return e.code && r.error!.code !== e.code ? `expected ${e.code}, but ${what(r)}` : undefined;
    case 'output': {
      if (!r.ok) return `expected output, but ${what(r)}`;
      const out = r.output ?? '';
      if (e.mode === 'equals') return out === e.text ? undefined : `expected output "${shorten(e.text)}", but it was "${shorten(out)}"`;
      if (e.mode === 'contains') return out.includes(e.text) ? undefined : `expected output to contain "${shorten(e.text)}", but it was "${shorten(out)}"`;
      return out.includes(e.text) ? `expected output NOT to contain "${shorten(e.text)}", but it does` : undefined;
    }
  }
}
