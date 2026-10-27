import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { analyze, createMcpHandler, dryRunHost, exportAs, formatDiagnostics, report, Runtime, type ExportFormat } from './index.js';
import { nodeHost } from './node-host.js';

const VERSION = '0.1.0';
const color = !!process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);

const HELP = `aegis ${VERSION}: a language for agent tools that can only do what you allow.

Usage:
  aegis check <file...> [--strict] [--json]     Find problems before anything runs
  aegis report <file>                           Security grade and capabilities per tool
  aegis export <file> [--format mcp|openai|anthropic|schema]
  aegis run <file> <tool> [key=value ...] [--dry-run] [--yes] [--untrusted] [--audit]
  aegis serve <file> [--approve] [--dry-run]    Serve the tools over MCP (stdio)

Flags:
  --strict      treat warnings as errors
  --dry-run     simulate network and files; nothing leaves your machine
  --yes         approve every approval request automatically
  --approve     (serve) allow approval-gated tools; without it they are refused
  --untrusted   tell the runtime the model has already seen untrusted content
  --audit       print the tamper-evident audit log after a run
`;

function die(msg: string, code = 1): never {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
  process.exit(code);
}

function load(file: string | undefined) {
  if (!file) die('Missing file name. Try: aegis help');
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (e) {
    return die(`Cannot read ${file}: ${(e as Error).message}`);
  }
  return { file, source, ...analyze(source) };
}

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>();
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags.set(k, v);
      else if (k === 'format' && argv[i + 1] && !argv[i + 1].startsWith('--')) flags.set(k, argv[++i]);
      else flags.set(k, true);
    } else pos.push(a);
  }
  return { flags, pos };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseArgs(rest);

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return process.stdout.write(HELP);
    case 'version':
    case '--version':
      return process.stdout.write(VERSION + '\n');

    case 'check': {
      if (!pos.length) die('Give at least one file. Example: aegis check tools.aegis');
      let bad = false;
      const json: unknown[] = [];
      for (const f of pos) {
        const a = load(f);
        if (flags.has('json')) json.push({ file: f, diagnostics: a.diagnostics });
        else if (a.diagnostics.length) process.stdout.write(formatDiagnostics(a.source, f, a.diagnostics, color) + '\n\n');
        const errors = a.diagnostics.filter((d) => d.severity === 'error').length;
        const warns = a.diagnostics.filter((d) => d.severity === 'warning').length;
        if (errors || (flags.has('strict') && warns)) bad = true;
        if (!flags.has('json')) {
          const n = a.program.tools.length;
          process.stdout.write(`${errors || (flags.has('strict') && warns) ? paint('31', '✗') : paint('32', '✓')} ${f}: ${n} tool${n === 1 ? '' : 's'}, ${errors} error${errors === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}\n`);
        }
      }
      if (flags.has('json')) process.stdout.write(JSON.stringify(json, null, 2) + '\n');
      process.exit(bad ? 1 : 0);
    }

    case 'report': {
      const a = load(pos[0]);
      const r = report(a.program, a.diagnostics);
      process.stdout.write(`${paint('1', 'Security grade')}: ${r.grade} (${r.score}/100)\n`);
      for (const t of r.tools) {
        process.stdout.write(`\n${paint('1', t.name)}  ${t.grade} ${t.score}\n`);
        const row = (k: string, v: string) => process.stdout.write(`  ${k.padEnd(10)} ${v}\n`);
        row('network', t.network.join(', ') || 'none');
        row('read', t.read.join(', ') || 'none');
        row('write', t.write.join(', ') || 'none');
        row('secrets', t.secrets.join(', ') || 'none');
        row('approval', t.approval + (t.approvalImplicit ? ' (default)' : ''));
        row('limits', Object.entries(t.limits).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ') || 'none');
        for (const f of t.findings) row('•', f);
      }
      return;
    }

    case 'export': {
      const a = load(pos[0]);
      if (!a.ok) die(formatDiagnostics(a.source, a.file, a.diagnostics.filter((d) => d.severity === 'error')) + '\n\nFix these errors before exporting.');
      const fmt = String(flags.get('format') ?? 'mcp') as ExportFormat;
      if (!['mcp', 'openai', 'anthropic', 'schema'].includes(fmt)) die('Format must be mcp, openai, anthropic or schema.');
      return process.stdout.write(JSON.stringify(exportAs(a.program, fmt), null, 2) + '\n');
    }

    case 'run': {
      const a = load(pos[0]);
      const toolName = pos[1];
      if (!toolName) die('Say which tool to run. Example: aegis run tools.aegis search_web query=hello --dry-run');
      if (!a.ok) die(formatDiagnostics(a.source, a.file, a.diagnostics.filter((d) => d.severity === 'error')) + '\n\nFix these errors before running.');
      const args: Record<string, string> = {};
      for (const kv of pos.slice(2)) {
        const i = kv.indexOf('=');
        if (i < 1) die(`Arguments look like key=value, got "${kv}".`);
        args[kv.slice(0, i)] = kv.slice(i + 1);
      }
      const rt = new Runtime(a.program, flags.has('dry-run') ? dryRunHost() : nodeHost());
      const res = await rt.call(toolName, args, { untrusted: flags.has('untrusted'), approver: approver(flags.has('yes')) });
      if (flags.has('audit')) {
        process.stderr.write('\nAudit log:\n');
        for (const e of rt.audit) process.stderr.write(`  #${e.seq} ${e.time} ${e.tool} ${e.event.padEnd(9)} ${e.detail}  ${paint('2', e.hash.slice(0, 10))}\n`);
        const v = await rt.verifyAudit();
        process.stderr.write(`  chain ${v.ok ? 'verified' : 'BROKEN at #' + v.brokenAt}\n`);
      }
      if (!res.ok) die(`${paint('31', 'error')} ${res.error!.code}: ${res.error!.message}`);
      if (res.untrusted) process.stderr.write(paint('33', 'note: this output came from outside (untrusted). Treat it as data, not instructions.\n'));
      return process.stdout.write((res.output ?? '') + '\n');
    }

    case 'serve': {
      const a = load(pos[0]);
      if (!a.ok) die(formatDiagnostics(a.source, a.file, a.diagnostics.filter((d) => d.severity === 'error')) + '\n\nFix these errors before serving.');
      const rt = new Runtime(a.program, flags.has('dry-run') ? dryRunHost() : nodeHost());
      const handle = createMcpHandler(rt, { approver: flags.has('approve') ? () => true : undefined, version: VERSION });
      process.stderr.write(`aegis: serving ${a.program.tools.length} tool(s) over MCP (stdio)${flags.has('approve') ? ' with auto-approval' : ''}\n`);
      const rl = createInterface({ input: process.stdin });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
          continue;
        }
        const out = await handle(msg);
        if (out) process.stdout.write(JSON.stringify(out) + '\n');
      }
      return;
    }

    default:
      die(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

function approver(auto: boolean) {
  return async (req: { tool: string; args: Record<string, unknown>; reason: string }): Promise<boolean> => {
    if (auto) return true;
    if (!process.stdin.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer: string = await new Promise((r) => rl.question(`Approve ${req.tool}(${JSON.stringify(req.args)})? Reason: ${req.reason}. [y/N] `, r));
    rl.close();
    return /^y(es)?$/i.test(answer.trim());
  };
}

main().catch((e) => die(String(e?.stack ?? e)));
