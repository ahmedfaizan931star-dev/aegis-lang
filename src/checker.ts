import type { Diagnostic, Located, Program, Severity, Step, Str, Tool } from './types.js';
import { MAX_STEPS } from './types.js';
import { parseTemplate, refsOf, type ParsedTemplate } from './template.js';
import { escapesRoot, hostMatches, insideDir, isLocalHost, normalizePath } from './policy.js';
import { effectiveApproval } from './report.js';
import { isNet, isSide, isUntrusted } from './steps.js';
import { didYouMean } from './util.js';

type Add = (severity: Severity, code: string, message: string, loc: Located, hint?: string) => void;

/** Static analysis: everything we can prove about a program before it ever runs. */
export function check(program: Program): Diagnostic[] {
  const out: Diagnostic[] = [];
  const add: Add = (severity, code, message, loc, hint) =>
    out.push({ severity, code, message, line: loc.line, col: loc.col, endCol: loc.endCol, hint });
  const seen = new Set<string>();
  for (const tool of program.tools) {
    if (seen.has(tool.name)) add('error', 'duplicate-tool', `Tool "${tool.name}" is defined twice.`, tool);
    seen.add(tool.name);
    checkTool(tool, add);
  }
  checkTests(program, add);
  return out.sort((a, b) => a.line - b.line || a.col - b.col);
}

const FORBIDDEN_HEADERS = ['host', 'content-length', 'transfer-encoding', 'connection'];

function checkTool(tool: Tool, add: Add): void {
  const usedInputs = new Set<string>();
  const usedSecrets = new Set<string>();
  const inputNames = tool.inputs.map((i) => i.name);
  const secretNames = new Set(tool.secrets.map((s) => s.name));

  if (!tool.description) add('warning', 'no-description', `Tool "${tool.name}" has no description.`, tool, 'Models pick tools by reading the description. Add: description "What this tool does"');

  // ---- allow lists -------------------------------------------------------
  for (const s of tool.network) {
    const v = s.value;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
      add('error', 'allow-host-format', 'Use a bare host name, without https://.', s, `allow network "${v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[\/?#].*$/, '')}"`);
    } else if (/[\/?#@\s]/.test(v) || v === '') {
      add('error', 'allow-host-format', 'A network rule is a host name only (no path, port or spaces).', s, 'Example: allow network "api.example.com"');
    } else if (v.includes('*') && v.replace(/^\*\.[^*]+\.[^*]+$/, '') !== '') {
      add('error', 'wildcard-format', 'Wildcards are only allowed as a leading "*." followed by a full domain.', s, 'Example: allow network "*.example.com"');
    } else if (v.startsWith('*.')) {
      add('warning', 'wildcard-host', `"${v}" allows every subdomain, including ones you don't control.`, s, 'Prefer listing exact hosts.');
    }
  }
  for (const [cap, list] of [['read', tool.read], ['write', tool.write]] as const) {
    for (const s of list) {
      const n = normalizePath(s.value);
      if (n === null || n === '/' || s.value.trim() === '') add('error', 'path-too-broad', `"${s.value}" is too broad to allow.`, s, `Pick a specific folder: allow ${cap} "./data"`);
      else if (escapesRoot(n)) add('error', 'path-escape', `"${s.value}" points outside the working folder.`, s);
      else if (n === '') add('warning', 'broad-dir', `allow ${cap} "${s.value}" covers the whole working folder.`, s, 'Prefer a sub-folder such as "./data".');
    }
  }
  for (const d of tool.deny) {
    if (d.cap === 'network' && tool.network.length) add('error', 'allow-deny-conflict', 'This tool both allows and denies network access.', d);
    if ((d.cap === 'read' || d.cap === 'files') && tool.read.length) add('error', 'allow-deny-conflict', `This tool both allows and denies reading (${d.cap}).`, d);
    if ((d.cap === 'write' || d.cap === 'files') && tool.write.length) add('error', 'allow-deny-conflict', `This tool both allows and denies writing (${d.cap}).`, d);
  }

  // ---- templates ---------------------------------------------------------
  const tpl = (s: Str, ctx: 'url' | 'header' | 'body' | 'path' | 'content' | 'text', lets: Set<string>, usedLets: Set<string>): ParsedTemplate => {
    const p = parseTemplate(s.value);
    for (const e of p.errors) add('error', 'template', e, s);
    for (const ref of refsOf(p)) {
      if (ref.startsWith('secret.')) {
        const n = ref.slice(7);
        if (!secretNames.has(n)) add('error', 'undeclared-secret', `Secret ${n} is not declared.`, s, `Add this line to the tool: secret ${n}`);
        else usedSecrets.add(n);
        if (!['url', 'header', 'body'].includes(ctx)) {
          add('error', 'secret-leak', `{secret.${n}} cannot be used here. It would end up in the output or on disk.`, s, 'Secrets are only allowed in URLs, headers and request bodies.');
        }
      } else if (inputNames.includes(ref)) usedInputs.add(ref);
      else if (lets.has(ref)) usedLets.add(ref);
      else {
        const g = didYouMean(ref, [...inputNames, ...lets]);
        add('error', 'undeclared-input', `{${ref}} is not an input ${lets.size ? 'or an earlier step result ' : ''}of this tool.`, s, g ? `Did you mean {${g}}?` : `Declare it first: input ${ref}: text`);
      }
    }
    return p;
  };

  // ---- run steps ----------------------------------------------------------
  // Every step gets the same checks. A step can read the results of the steps before it.
  const lets = new Set<string>(); // step names defined so far
  const usedLets = new Set<string>();
  const taintedLets = new Set<string>(); // step results that carry outside content (web, files)
  const stepNames = new Set<string>();

  if (!tool.steps.length) {
    add('error', 'missing-run', `Tool "${tool.name}" has no run step.`, tool, 'Add a line like: run get "https://api.example.com/…"');
  }
  if (tool.steps.length > MAX_STEPS) add('error', 'too-many-steps', `A tool can have at most ${MAX_STEPS} run steps.`, tool.steps[MAX_STEPS].action);

  tool.steps.forEach((step: Step, idx) => {
    const act = step.action;
    const isLast = idx === tool.steps.length - 1;
    const refsInStep: string[] = [];

    const stepTpl = (s: Str, ctx: 'url' | 'header' | 'body' | 'path' | 'content' | 'text'): ParsedTemplate => {
      const p = tpl(s, ctx, lets, usedLets);
      refsInStep.push(...refsOf(p));
      return p;
    };

    if (act.kind === 'get' || act.kind === 'post') {
      const p = stepTpl(act.url, 'url');
      const first = p.parts[0];
      const lit = first && 'lit' in first ? first.lit : '';
      const m = /^(https?):\/\/([^\/?#]*)/i.exec(lit);
      if (!m || m[2] === '') {
        add('error', 'url-host', 'The URL must start with a fixed scheme and host, like "https://api.example.com/…". Placeholders are not allowed in the host.', act.url);
      } else {
        if (!(m[0].length < lit.length || p.parts.length === 1)) {
          add('error', 'url-host-interp', 'A placeholder right after the host could change the host. Put a "/" or "?" before it.', act.url);
        }
        if (m[2].includes('@')) add('error', 'url-userinfo', 'URLs with user@host are not allowed.', act.url);
        const hostname = m[2].replace(/:\d+$/, '');
        if (m[1].toLowerCase() === 'http' && !isLocalHost(hostname)) add('error', 'url-http', 'Plain http is only allowed for localhost. Use https.', act.url);
        if (!tool.network.some((n) => hostMatches(hostname, n.value))) {
          add('error', 'host-not-allowed', `"${hostname}" is not in this tool's network allow list.`, act.url, `Add this line to the tool: allow network "${hostname}"`);
        }
      }
      for (const h of act.headers) {
        if (!/^[A-Za-z0-9-]+$/.test(h.name)) add('error', 'header-name', `"${h.name}" is not a valid header name.`, h);
        if (FORBIDDEN_HEADERS.includes(h.name.toLowerCase())) add('error', 'header-forbidden', `The ${h.name} header is set automatically and cannot be overridden.`, h);
        if (/[\r\n]/.test(h.value.value)) add('error', 'header-newline', 'Header values cannot contain line breaks.', h.value);
        stepTpl(h.value, 'header');
      }
      if (act.kind === 'post' && act.body) stepTpl(act.body, 'body');
    } else if (act.kind === 'read' || act.kind === 'write') {
      const p = stepTpl(act.path, 'path');
      const allowed = act.kind === 'read' ? tool.read : tool.write;
      if (!allowed.length) {
        add('error', 'cap-missing', `run ${act.kind} needs permission, and none is granted.`, act.path, `Add this line to the tool: allow ${act.kind} "./data"`);
      } else {
        const first = p.parts[0];
        const prefix = first && 'lit' in first ? first.lit : '';
        const dotdot = p.parts.some((x) => 'lit' in x && /(^|[\\/])\.\.([\\/]|$)/.test(x.lit));
        if (dotdot) add('error', 'path-escape', 'Paths cannot contain "..".', act.path);
        else if (!prefix) add('error', 'path-prefix', 'The path must start with a fixed folder, like "./data/{name}".', act.path);
        else {
          const norm = normalizePath(prefix);
          const hasRefs = p.parts.some((x) => 'ref' in x);
          if (norm === null || escapesRoot(norm) || !allowed.some((a) => insideDir(prefix, a.value))) {
            add('error', 'path-not-allowed', `"${prefix}" is outside the folders this tool may ${act.kind}.`, act.path, `Allowed: ${allowed.map((a) => a.value).join(', ')}`);
          } else if (hasRefs && allowed.some((a) => normalizePath(a.value) === norm) && !prefix.endsWith('/')) {
            add('error', 'path-boundary', 'Put a "/" after the folder so an input cannot change the folder name.', act.path, `Use "${prefix}/{…}"`);
          }
        }
      }
      if (act.kind === 'write') stepTpl(act.content, 'content');
    } else {
      stepTpl(act.text, 'text');
    }

    // Outside content that flows into a step with side effects is how prompt injection becomes action.
    const tainted = isUntrusted(act) || refsInStep.some((r) => taintedLets.has(r));
    if (isSide(act) && refsInStep.some((r) => taintedLets.has(r)) && effectiveApproval(tool).mode !== 'always') {
      add('warning', 'untrusted-flow', 'This step sends or saves data that came from the web or a file, and a human does not approve every call.', act, 'Add: approve always');
    }

    const ji = step.transforms.findIndex((t) => t.kind === 'json');
    const ti = step.transforms.findIndex((t) => t.kind === 'trim');
    if (ji >= 0 && ti >= 0 && ti < ji) add('warning', 'trim-before-json', 'Trimming before parsing JSON will usually break the JSON.', act, 'Put "then json" before "then trim".');

    if (step.name) {
      if (stepNames.has(step.name)) add('error', 'duplicate-step', `A step named "${step.name}" already exists in this tool.`, step.nameAt ?? act);
      else if (inputNames.includes(step.name)) add('error', 'step-name-conflict', `"${step.name}" is already an input of this tool.`, step.nameAt ?? act, 'Pick another name for the step.');
      stepNames.add(step.name);
      lets.add(step.name);
      if (tainted) taintedLets.add(step.name);
    } else if (!isLast && !isSide(act)) {
      add('warning', 'step-result-discarded', 'The result of this step is never used.', act, 'Name it so a later step can use it: run let name = …');
    }
  });

  // Rules about the tool as a whole, looking at every step.
  const firstSide = tool.steps.find((s) => isSide(s.action))?.action;
  const firstNet = tool.steps.find((s) => isNet(s.action))?.action;
  const firstPost = tool.steps.find((s) => s.action.kind === 'post')?.action;
  if (firstSide && tool.approve === undefined) {
    add('info', 'approval-default', `"${tool.name}" changes things, so every call needs human approval by default.`, firstSide, 'Add "approve never" to remove this (not recommended).');
  }
  if (firstSide && tool.approve === 'never') {
    add('warning', 'approve-never-side-effect', 'A tool with side effects runs without any human approval.', { line: tool.approveLine ?? firstSide.line, col: 1, endCol: 40 }, 'Prefer "approve always" or "approve untrusted".');
  }
  if (firstNet && tool.timeMs === undefined) add('warning', 'no-timeout', 'This network tool has no time limit.', firstNet, 'Add: limit time 5s');
  if (firstNet && !tool.calls) add('warning', 'no-rate-limit', 'This network tool has no call limit.', firstNet, 'Add: limit calls 10/min');
  if (firstPost && tool.retry > 0) add('warning', 'retry-post', 'Retrying a POST can repeat a side effect.', firstPost, 'Remove "retry" or make sure the endpoint is idempotent.');
  if (tool.cacheMs && firstSide) add('error', 'cache-side-effect', 'Caching is only allowed for tools that read, not for tools with side effects.', firstSide);

  for (const st of tool.steps.slice(0, -1)) {
    if (st.name && !usedLets.has(st.name)) add('warning', 'unused-step', `Step result "${st.name}" is never used.`, st.nameAt ?? st.action);
  }

  for (const i of tool.inputs) if (!usedInputs.has(i.name)) add('warning', 'unused-input', `Input "${i.name}" is never used.`, i);
  for (const s of tool.secrets) if (!usedSecrets.has(s.name)) add('warning', 'unused-secret', `Secret ${s.name} is declared but never used.`, s);
}

/** Built-in tests: every `call` must point at a real tool with real inputs. */
function checkTests(program: Program, add: Add): void {
  const toolNames = program.tools.map((t) => t.name);
  const seen = new Set<string>();
  for (const t of program.tests ?? []) {
    if (seen.has(t.name)) add('error', 'duplicate-test', `A test named "${t.name}" already exists.`, t);
    seen.add(t.name);
    if (!t.calls.length) add('warning', 'test-no-call', `Test "${t.name}" never calls a tool.`, t, 'Add: call my_tool name="x"');
    for (const m of t.mocks) {
      if (!/^https?:\/\//i.test(m.url.value)) add('error', 'mock-url', 'A mock URL must start with https:// or http://.', m.url);
    }
    for (const c of t.calls) {
      const tool = program.tools.find((x) => x.name === c.tool);
      if (!tool) {
        const g = didYouMean(c.tool, toolNames);
        add('error', 'test-unknown-tool', `There is no tool named "${c.tool}".`, c, g ? `Did you mean "${g}"?` : undefined);
        continue;
      }
      for (const a of c.args) {
        if (!tool.inputs.some((i) => i.name === a.name)) {
          const g = didYouMean(a.name, tool.inputs.map((i) => i.name));
          add('error', 'test-unknown-arg', `"${tool.name}" has no input called "${a.name}".`, a, g ? `Did you mean "${g}"?` : undefined);
        }
      }
      if (!c.expects.length) add('warning', 'test-no-expect', 'This call has no expect line, so nothing is checked.', c, 'Add: expect ok');
    }
  }
}
