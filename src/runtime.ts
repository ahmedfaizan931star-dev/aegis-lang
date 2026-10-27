import type { Host } from './host.js';
import { effectiveApproval } from './report.js';
import { escapesRoot, hostMatches, insideDir, isLocalHost, normalizePath } from './policy.js';
import { parseTemplate } from './template.js';
import type { Action, Program, Scalar, Tool } from './types.js';
import { fmtMs, sha256 } from './util.js';

export type ErrorCode =
  | 'UNKNOWN_TOOL'
  | 'BAD_INPUT'
  | 'RATE_LIMITED'
  | 'DENIED'
  | 'NEEDS_APPROVAL'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'MISSING_SECRET'
  | 'FAILED';

export class AegisError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}

export interface AuditEntry {
  seq: number;
  time: string;
  tool: string;
  event: string;
  detail: string;
  prev: string;
  hash: string;
}

export interface ApprovalRequest {
  tool: string;
  args: Record<string, Scalar>;
  reason: string;
}

export interface CallOptions {
  /** True when the model's context already contains untrusted content (web pages, files). */
  untrusted?: boolean;
  approver?: (req: ApprovalRequest) => Promise<boolean> | boolean;
}

export interface CallResult {
  ok: boolean;
  output?: string;
  error?: { code: ErrorCode; message: string };
  /** The output came from outside (web, files). Treat it as data, never as instructions. */
  untrusted: boolean;
  truncated: boolean;
  cached: boolean;
  ms: number;
}

export interface RuntimeOptions {
  maxRedirects?: number;
  maxResponseBytes?: number;
}

type Vars = { args: Record<string, Scalar>; secrets: Map<string, string> };

const GENESIS = 'GENESIS';

export class Runtime {
  readonly audit: AuditEntry[] = [];
  private tail: Promise<void> = Promise.resolve();
  private hits = new Map<string, number[]>();
  private cache = new Map<string, { at: number; output: string; truncated: boolean }>();
  private maxRedirects: number;
  private maxResponseBytes: number;

  constructor(
    readonly program: Program,
    readonly host: Host,
    opts: RuntimeOptions = {},
  ) {
    this.maxRedirects = opts.maxRedirects ?? 3;
    this.maxResponseBytes = opts.maxResponseBytes ?? 2 * 1024 * 1024;
  }

  // ---- audit log (hash-chained, tamper-evident) ---------------------------
  private log(tool: string, event: string, detail: string): Promise<void> {
    const run = async () => {
      const prev = this.audit.length ? this.audit[this.audit.length - 1].hash : GENESIS;
      const e = { seq: this.audit.length + 1, time: new Date(this.host.now()).toISOString(), tool, event, detail };
      const hash = await sha256(prev + '|' + JSON.stringify(e));
      this.audit.push({ ...e, prev, hash });
    };
    const p = this.tail.then(run);
    this.tail = p.catch(() => {});
    return p;
  }

  static async verifyAudit(entries: AuditEntry[]): Promise<{ ok: boolean; brokenAt?: number }> {
    let prev = GENESIS;
    for (const en of entries) {
      const { seq, time, tool, event, detail } = en;
      const hash = await sha256(prev + '|' + JSON.stringify({ seq, time, tool, event, detail }));
      if (en.prev !== prev || en.hash !== hash) return { ok: false, brokenAt: en.seq };
      prev = en.hash;
    }
    return { ok: true };
  }

  verifyAudit() {
    return Runtime.verifyAudit(this.audit);
  }

  // ---- calling a tool ------------------------------------------------------
  async call(name: string, rawArgs: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<CallResult> {
    const started = this.host.now();
    const tool = this.program.tools.find((t) => t.name === name);
    if (!tool) {
      await this.log(name, 'error', 'unknown tool');
      return this.fail('UNKNOWN_TOOL', `No tool named "${name}".`, started, false);
    }

    const secrets = new Map<string, string>();
    for (const s of tool.secrets) {
      const v = this.host.env(s.name);
      if (v) secrets.set(s.name, v);
    }
    const redact = (text: string): string => {
      let t = text;
      for (const [n, v] of secrets) {
        if (v.length < 4) continue;
        for (const variant of new Set([v, encodeURIComponent(v), JSON.stringify(v).slice(1, -1)])) t = t.split(variant).join(`[REDACTED:${n}]`);
      }
      return t;
    };
    const log = (event: string, detail: string) => this.log(tool.name, event, redact(detail));
    const untrustedSource = this.isUntrustedSource(tool);

    try {
      const args = coerceArgs(tool, rawArgs);
      await log('call', JSON.stringify(args));

      this.checkRate(tool);

      const ap = effectiveApproval(tool);
      const needs = ap.mode === 'always' || (ap.mode === 'untrusted' && !!opts.untrusted);
      if (needs) {
        const reason = ap.mode === 'always' ? (ap.implicit ? 'this tool has side effects' : 'this tool always requires approval') : 'the conversation contains untrusted content';
        if (!opts.approver) throw new AegisError('NEEDS_APPROVAL', `This call needs human approval (${reason}) and no approver is available.`);
        const ok = await opts.approver({ tool: tool.name, args, reason });
        await log(ok ? 'approved' : 'denied', `human approval: ${reason}`);
        if (!ok) throw new AegisError('DENIED', 'A human declined this call.');
      }

      const cacheKey = tool.name + '|' + JSON.stringify(args);
      const kind = tool.action?.kind;
      if (tool.cacheMs && (kind === 'get' || kind === 'read' || kind === 'echo')) {
        const hit = this.cache.get(cacheKey);
        if (hit && this.host.now() - hit.at < tool.cacheMs) {
          await log('cache_hit', `age ${fmtMs(this.host.now() - hit.at)}`);
          const res: CallResult = { ok: true, output: hit.output, untrusted: untrustedSource || !!opts.untrusted, truncated: hit.truncated, cached: true, ms: this.host.now() - started };
          return res;
        }
      }

      const ctrl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const work = this.execute(tool, { args, secrets }, ctrl.signal, log);
      const raw = await (tool.timeMs
        ? Promise.race([
            work,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                ctrl.abort();
                reject(new AegisError('TIMEOUT', `The tool took longer than its limit of ${tool.timeLabel}.`));
              }, tool.timeMs);
            }),
          ]).finally(() => clearTimeout(timer))
        : work);

      let { text, truncated } = finish(tool, raw);
      text = redact(text);
      if (tool.cacheMs && (kind === 'get' || kind === 'read' || kind === 'echo')) this.cache.set(cacheKey, { at: this.host.now(), output: text, truncated });
      await log('result', `ok, ${new TextEncoder().encode(text).length} bytes${truncated ? ', truncated' : ''}${untrustedSource ? ', untrusted' : ''}`);
      return { ok: true, output: text, untrusted: untrustedSource || !!opts.untrusted, truncated, cached: false, ms: this.host.now() - started };
    } catch (e) {
      const err = e instanceof AegisError ? e : new AegisError('FAILED', e instanceof Error ? e.message : String(e));
      const message = redact(err.message);
      await log('error', `${err.code}: ${message}`);
      return { ok: false, error: { code: err.code, message }, untrusted: false, truncated: false, cached: false, ms: this.host.now() - started };
    }
  }

  private fail(code: ErrorCode, message: string, started: number, untrusted: boolean): CallResult {
    return { ok: false, error: { code, message }, untrusted, truncated: false, cached: false, ms: this.host.now() - started };
  }

  private isUntrustedSource(tool: Tool): boolean {
    const k = tool.action?.kind;
    return k === 'get' || k === 'post' || k === 'read';
  }

  private checkRate(tool: Tool): void {
    if (!tool.calls) return;
    const now = this.host.now();
    const recent = (this.hits.get(tool.name) ?? []).filter((t) => now - t < tool.calls!.perMs);
    if (recent.length >= tool.calls.max) {
      const wait = Math.ceil((tool.calls.perMs - (now - recent[0])) / 1000);
      throw new AegisError('RATE_LIMITED', `Limit of ${tool.calls.label} reached. Try again in ${wait}s.`);
    }
    recent.push(now);
    this.hits.set(tool.name, recent);
  }

  // ---- executing the action --------------------------------------------------
  private async execute(tool: Tool, vars: Vars, signal: AbortSignal, log: (e: string, d: string) => Promise<void>): Promise<unknown> {
    const act = tool.action as Action;
    let value: unknown;
    switch (act.kind) {
      case 'echo':
        value = render(act.text.value, vars, 'raw');
        break;
      case 'read': {
        const path = this.authorizePath(tool, 'read', render(act.path.value, vars, 'raw'));
        await log('read', path);
        value = await this.host.readFile(path).catch((e: Error) => {
          throw new AegisError('FAILED', `Could not read "${path}": ${e.message}`);
        });
        break;
      }
      case 'write': {
        const path = this.authorizePath(tool, 'write', render(act.path.value, vars, 'raw'));
        const content = render(act.content.value, vars, 'raw');
        await log('write', `${path} (${content.length} chars)`);
        await this.host.writeFile(path, content).catch((e: Error) => {
          throw new AegisError('FAILED', `Could not write "${path}": ${e.message}`);
        });
        value = `Wrote ${content.length} characters to ${path}`;
        break;
      }
      case 'get':
      case 'post': {
        const headers: Record<string, string> = {};
        for (const h of act.headers) headers[h.name] = render(h.value.value, vars, 'header');
        let body: string | undefined;
        if (act.kind === 'post') {
          body = act.body ? render(act.body.value, vars, 'json') : undefined;
          if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
        }
        const url = render(act.url.value, vars, 'url');
        const attempts = 1 + tool.retry;
        let last: unknown;
        for (let i = 0; i < attempts; i++) {
          try {
            value = await this.request(tool, act.kind === 'post' ? 'POST' : 'GET', url, headers, body, signal, log);
            last = undefined;
            break;
          } catch (e) {
            last = e;
            if (!(e instanceof AegisError && e.retryable) || i === attempts - 1) throw e;
            await log('retry', `attempt ${i + 2} of ${attempts}`);
            await this.host.sleep(200 * 2 ** i);
          }
        }
        if (last) throw last;
        break;
      }
    }
    for (const t of tool.transforms) {
      if (t.kind === 'json') {
        try {
          value = typeof value === 'string' ? JSON.parse(value) : value;
        } catch {
          throw new AegisError('FAILED', 'The result is not valid JSON.');
        }
      } else if (t.kind === 'pick') {
        let cur: unknown = value;
        if (typeof cur === 'string') {
          try {
            cur = JSON.parse(cur);
          } catch {
            throw new AegisError('FAILED', `Cannot pick "${t.path}": the result is not JSON.`);
          }
        }
        for (const seg of t.path.split('.')) {
          if (cur !== null && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, seg)) cur = (cur as Record<string, unknown>)[seg];
          else throw new AegisError('FAILED', `Cannot find "${t.path}" in the result.`);
        }
        value = cur;
      } else {
        const s = typeof value === 'string' ? value : JSON.stringify(value);
        value = s.length > t.chars ? s.slice(0, t.chars) : s;
      }
    }
    return value;
  }

  private authorizeHost(tool: Tool, url: URL): void {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const okScheme = url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHost(url.hostname));
    if (!okScheme || url.username || url.password || !tool.network.some((n) => hostMatches(url.hostname, n.value) || hostMatches(host, n.value))) {
      throw new AegisError('DENIED', `Network access to "${url.hostname}" is not allowed for ${tool.name}.`);
    }
  }

  private authorizePath(tool: Tool, cap: 'read' | 'write', raw: string): string {
    const n = normalizePath(raw);
    const dirs = (cap === 'read' ? tool.read : tool.write).map((d) => d.value);
    if (n === null || escapesRoot(n) || !dirs.some((d) => insideDir(n, d))) {
      throw new AegisError('DENIED', `${cap === 'read' ? 'Reading' : 'Writing'} "${raw}" is not allowed for ${tool.name}.`);
    }
    return n === '' ? '.' : n;
  }

  private async request(
    tool: Tool,
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal,
    log: (e: string, d: string) => Promise<void>,
  ): Promise<string> {
    let current: URL;
    try {
      current = new URL(url);
    } catch {
      throw new AegisError('BAD_INPUT', 'The request URL is not valid.');
    }
    let hdrs = { ...headers };
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      this.authorizeHost(tool, current);
      await log('network', `${method} ${current.toString()} headers=[${Object.keys(hdrs).join(', ')}]`);
      const res = await this.host.fetch(current.toString(), { method, headers: hdrs, body, signal });
      if (res.status >= 300 && res.status < 400) {
        const loc = Object.entries(res.headers).find(([k]) => k.toLowerCase() === 'location')?.[1];
        if (!loc) throw new AegisError('HTTP_ERROR', `HTTP ${res.status} without a Location header.`);
        const next = new URL(loc, current);
        if (next.hostname !== current.hostname) hdrs = {}; // never forward credentials to another host
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        await log('redirect', `-> ${next.toString()}`);
        current = next;
        continue;
      }
      if (res.status === 0) throw new AegisError('FAILED', 'The request was redirected, and this environment cannot follow redirects safely.');
      if (res.status === 429 || res.status >= 500) throw new AegisError('HTTP_ERROR', `HTTP ${res.status}`, true);
      if (res.status >= 400) throw new AegisError('HTTP_ERROR', `HTTP ${res.status}`);
      if (res.text.length > this.maxResponseBytes) throw new AegisError('FAILED', 'The response is larger than the 2 MB safety limit.');
      return res.text;
    }
    throw new AegisError('HTTP_ERROR', `More than ${this.maxRedirects} redirects.`);
  }
}

// ---- helpers ---------------------------------------------------------------

function coerceArgs(tool: Tool, raw: Record<string, unknown>): Record<string, Scalar> {
  for (const k of Object.keys(raw)) {
    if (!tool.inputs.some((i) => i.name === k)) throw new AegisError('BAD_INPUT', `Unknown input "${k}". Allowed: ${tool.inputs.map((i) => i.name).join(', ') || 'none'}.`);
  }
  const out: Record<string, Scalar> = {};
  for (const inp of tool.inputs) {
    let v = raw[inp.name];
    if (v === undefined || v === null) {
      if (inp.default === undefined) throw new AegisError('BAD_INPUT', `Missing required input "${inp.name}".`);
      v = inp.default;
    }
    if (inp.type === 'text') {
      if (typeof v === 'object') throw new AegisError('BAD_INPUT', `Input "${inp.name}" must be text.`);
      const s = String(v);
      if (s.length > 100_000) throw new AegisError('BAD_INPUT', `Input "${inp.name}" is too long (max 100,000 characters).`);
      out[inp.name] = s;
    } else if (inp.type === 'number') {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n)) throw new AegisError('BAD_INPUT', `Input "${inp.name}" must be a number.`);
      out[inp.name] = n;
    } else {
      if (v === true || v === 'true') out[inp.name] = true;
      else if (v === false || v === 'false') out[inp.name] = false;
      else throw new AegisError('BAD_INPUT', `Input "${inp.name}" must be true or false.`);
    }
  }
  return out;
}

/** mode decides how placeholder values are escaped for where they land. */
function render(template: string, vars: Vars, mode: 'raw' | 'url' | 'header' | 'json'): string {
  const { parts } = parseTemplate(template);
  return parts
    .map((p) => {
      if ('lit' in p) return p.lit;
      let v: Scalar;
      if (p.ref.startsWith('secret.')) {
        const n = p.ref.slice(7);
        const s = vars.secrets.get(n);
        if (s === undefined) throw new AegisError('MISSING_SECRET', `Secret ${n} is not set in the environment.`);
        v = s;
      } else v = vars.args[p.ref];
      const s = String(v);
      if (mode === 'url') return encodeURIComponent(s);
      if (mode === 'header') {
        if (/[\r\n]/.test(s)) throw new AegisError('BAD_INPUT', 'Header values cannot contain line breaks.');
        return s;
      }
      if (mode === 'json') return typeof v === 'string' ? JSON.stringify(v).slice(1, -1) : s;
      return s;
    })
    .join('');
}

function finish(tool: Tool, value: unknown): { text: string; truncated: boolean } {
  let text: string;
  if (tool.output === 'number') {
    const n = typeof value === 'number' ? value : Number(typeof value === 'string' ? value.trim() : NaN);
    if (!Number.isFinite(n)) throw new AegisError('FAILED', 'The result is not a number.');
    text = String(n);
  } else if (tool.output === 'json') {
    let v = value;
    if (typeof v === 'string') {
      try {
        v = JSON.parse(v);
      } catch {
        /* keep the string; it will be encoded as a JSON string */
      }
    }
    text = JSON.stringify(v);
  } else {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  }
  let truncated = false;
  if (tool.outputBytes) {
    const enc = new TextEncoder();
    if (enc.encode(text).length > tool.outputBytes) {
      truncated = true;
      let cut = Math.min(text.length, tool.outputBytes);
      while (cut > 0 && enc.encode(text.slice(0, cut)).length > tool.outputBytes) cut = Math.floor(cut * 0.9);
      text = text.slice(0, cut);
    }
  }
  return { text, truncated };
}
