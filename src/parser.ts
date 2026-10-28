import { lexLine, type Tok } from './lexer.js';
import { deepFreeze, LruCache } from './cache.js';
import { ERROR_CODES, MAX_STEPS } from './types.js';
import type { Action, Diagnostic, ErrorCode, Header, InputDef, MockDef, Program, Scalar, Step, Str, TestCall, TestCase, Tool, Transform } from './types.js';
import { didYouMean, fmtMs, parseDuration, parseSize } from './util.js';

export const KEYWORDS = [
  'description',
  'input',
  'allow',
  'deny',
  'secret',
  'limit',
  'cache',
  'retry',
  'approve',
  'run',
  'then',
  'output',
] as const;

const ALLOW_CAPS = ['network', 'read', 'write'];
const DENY_CAPS = ['network', 'read', 'write', 'files', 'shell', 'env'];
const IDENT = /^[a-z][a-z0-9_]*$/;

function toStr(t: Tok, line: number): Str {
  return { value: t.v, line, col: t.col, endCol: t.end };
}

function newTool(name: string, line: number, col: number, endCol: number): Tool {
  return {
    name,
    line,
    col,
    endCol,
    inputs: [],
    network: [],
    read: [],
    write: [],
    deny: [],
    secrets: [],
    retry: 0,
    steps: [],
    output: 'text',
  };
}

/** While parsing, `then` lines attach to the most recent `run` step. */
const cursors = new WeakMap<Tool, { last: Step | null; pending: Transform[] }>();
function cursorOf(tool: Tool) {
  let c = cursors.get(tool);
  if (!c) cursors.set(tool, (c = { last: null, pending: [] }));
  return c;
}

const TEST_KEYWORDS = ['mock', 'call', 'expect'] as const;
type ErrFn = (t: { col: number; end: number }, code: string, message: string, hint?: string) => void;

export interface ParseResult {
  program: Program;
  diagnostics: Diagnostic[];
}

/** Sources bigger than this are parsed every time instead of being remembered. */
const MAX_CACHED_SOURCE = 512 * 1024;
export const parseCache = new LruCache<ParseResult>(64, 1_000_000);

/**
 * Parse a source text. Results are cached by source text, so parsing the same text again
 * (editor re-checks, test suites, servers) is a map lookup. Cached results are frozen,
 * so nobody can change one and poison the cache for the next caller.
 */
export function parse(source: string): ParseResult {
  if (source.length > MAX_CACHED_SOURCE) return parseUncached(source);
  const hit = parseCache.get(source);
  if (hit) return hit;
  const fresh = deepFreeze(parseUncached(source));
  parseCache.set(source, fresh);
  return fresh;
}

export function parseUncached(source: string): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const tools: Tool[] = [];
  const tests: TestCase[] = [];
  let cur: Tool | null = null;
  let curTest: TestCase | null = null;

  source.split(/\r?\n/).forEach((raw, idx) => {
    const line = idx + 1;
    const toks = lexLine(raw, line, diagnostics);
    if (!toks.length) return;
    const indent = raw.length - raw.trimStart().length;
    const first = toks[0];
    const err = (t: { col: number; end: number }, code: string, message: string, hint?: string) =>
      diagnostics.push({ severity: 'error', code, message, line, col: t.col, endCol: t.end, hint });

    if (indent === 0) {
      if (first.t === 'word' && first.v === 'tool') {
        const name = toks[1];
        if (!name || name.t !== 'word') {
          err(first, 'tool-name', 'A tool needs a name.', 'Write: tool search_web');
          cur = null;
          return;
        }
        if (!IDENT.test(name.v)) {
          err(name, 'tool-name-format', `"${name.v}" is not a valid tool name.`, 'Use lowercase letters, digits and underscores, starting with a letter (for example search_web).');
        }
        if (toks.length > 2) err(toks[2], 'unexpected', 'Unexpected text after the tool name.');
        cur = newTool(name.v, line, name.col, name.end);
        curTest = null;
        tools.push(cur);
        return;
      }
      if (first.t === 'word' && first.v === 'test') {
        const name = toks[1];
        cur = null;
        curTest = null;
        if (!name || name.t !== 'str') {
          err(first, 'test-name', 'A test needs a name in quotes.', 'Write: test "blocks an evil host"');
          return;
        }
        if (toks.length > 2) err(toks[2], 'unexpected', 'Unexpected text after the test name.');
        curTest = { name: name.v, mocks: [], calls: [], line, col: name.col, endCol: name.end };
        tests.push(curTest);
        return;
      }
      cur = null;
      curTest = null;
      if (first.t === 'word' && (KEYWORDS as readonly string[]).includes(first.v)) {
        err(first, 'not-indented', `"${first.v}" must be indented under a tool.`, 'Indent the line by two spaces.');
      } else {
        const guess = first.t === 'word' ? didYouMean(first.v, ['tool', 'test']) : undefined;
        err(first, 'expected-tool', `Expected "tool" or "test" at the start of a line, found "${first.v}".`, guess ? `Did you mean "${guess}"?` : 'Every tool starts with: tool my_tool (and every test with: test "name")');
      }
      return;
    }

    if (curTest) {
      testStatement(curTest, toks, line, diagnostics);
      return;
    }
    if (!cur) {
      err(first, 'outside-tool', 'This line is not inside a tool.', 'Start the tool first: tool my_tool');
      return;
    }
    statement(cur, toks, line, diagnostics);
  });

  return { program: { tools, tests }, diagnostics };
}

function statement(tool: Tool, toks: Tok[], line: number, diags: Diagnostic[]): void {
  const err = (t: { col: number; end: number }, code: string, message: string, hint?: string): void => {
    diags.push({ severity: 'error', code, message, line, col: t.col, endCol: t.end, hint });
  };
  const kw = toks[0];
  const rest = toks.slice(1);
  const noExtra = (from: number) => {
    if (rest[from]) err(rest[from], 'unexpected', `Unexpected "${rest[from].v}".`, 'Remove it, or check the syntax of this line.');
  };

  if (kw.t !== 'word') {
    err(kw, 'syntax', 'Each line inside a tool starts with a keyword.', `Keywords: ${KEYWORDS.join(', ')}`);
    return;
  }

  /** Parses `a, b, c` where items are strings or words. */
  const list = (from: number): Tok[] => {
    const items: Tok[] = [];
    let i = from;
    while (i < rest.length) {
      const t = rest[i];
      if (t.t === 'sym') {
        err(t, 'list-syntax', `Unexpected "${t.v}".`, 'Separate items with commas.');
        return items;
      }
      items.push(t);
      i++;
      if (i < rest.length) {
        if (rest[i].v === ',' && rest[i].t === 'sym') {
          i++;
          if (i >= rest.length) err(rest[i - 1], 'list-syntax', 'Trailing comma.');
        } else {
          err(rest[i], 'list-syntax', 'Items must be separated by commas.');
          return items;
        }
      }
    }
    return items;
  };

  switch (kw.v) {
    case 'description': {
      const s = rest[0];
      if (!s || s.t !== 'str') return err(kw, 'description', 'description needs a quoted string.', 'description "What this tool does"');
      tool.description = toStr(s, line);
      return noExtra(1);
    }

    case 'input': {
      const [nameT, colonT, typeT] = rest;
      if (!nameT || nameT.t !== 'word' || !colonT || colonT.v !== ':' || !typeT || typeT.t !== 'word') {
        return err(nameT ?? kw, 'input-syntax', 'Inputs look like: input name: type', 'input query: text "What to search for"');
      }
      if (!IDENT.test(nameT.v)) err(nameT, 'input-name', `"${nameT.v}" is not a valid input name.`, 'Use lowercase letters, digits and underscores.');
      if (!['text', 'number', 'bool'].includes(typeT.v)) {
        const g = didYouMean(typeT.v, ['text', 'number', 'bool']);
        return err(typeT, 'input-type', `Unknown type "${typeT.v}".`, g ? `Did you mean "${g}"?` : 'Use text, number or bool.');
      }
      const def: InputDef = { name: nameT.v, type: typeT.v as InputDef['type'], line, col: nameT.col, endCol: nameT.end };
      let i = 3;
      if (rest[i]?.t === 'str') {
        def.description = rest[i].v;
        i++;
      }
      if (rest[i]?.t === 'sym' && rest[i].v === '=') {
        const val = rest[i + 1];
        if (!val) err(rest[i], 'input-default', 'Missing a default value after "=".');
        else {
          if (def.type === 'text') {
            if (val.t === 'str') def.default = val.v;
            else err(val, 'input-default', 'A text default must be in quotes.', `= "${val.v}"`);
          } else if (def.type === 'number') {
            const n = Number(val.v);
            if (val.t === 'word' && val.v !== '' && Number.isFinite(n)) def.default = n;
            else err(val, 'input-default', 'A number default must be a number.', '= 5');
          } else if (val.t === 'word' && (val.v === 'true' || val.v === 'false')) def.default = val.v === 'true';
          else err(val, 'input-default', 'A bool default must be true or false.');
          i += 2;
        }
      }
      noExtra(i);
      if (tool.inputs.some((x) => x.name === def.name)) err(nameT, 'duplicate-input', `Input "${def.name}" is already declared in this tool.`);
      else tool.inputs.push(def);
      return;
    }

    case 'allow': {
      const cap = rest[0];
      if (!cap || cap.t !== 'word' || !ALLOW_CAPS.includes(cap.v)) {
        const g = cap ? didYouMean(cap.v, ALLOW_CAPS) : undefined;
        return err(cap ?? kw, 'allow-cap', cap ? `Unknown capability "${cap.v}".` : 'allow needs a capability.', g ? `Did you mean "${g}"?` : 'Use: allow network "host" | allow read "dir" | allow write "dir"');
      }
      const items = list(1);
      if (!items.length) return err(cap, 'allow-empty', `allow ${cap.v} needs at least one value.`, `allow ${cap.v} "…"`);
      const target = cap.v === 'network' ? tool.network : cap.v === 'read' ? tool.read : tool.write;
      for (const it of items) target.push(toStr(it, line));
      return;
    }

    case 'deny': {
      const items = list(0);
      if (!items.length) return err(kw, 'deny-empty', 'deny needs at least one capability.', 'deny shell, files');
      for (const it of items) {
        if (it.t !== 'word' || !DENY_CAPS.includes(it.v)) {
          const g = didYouMean(it.v, DENY_CAPS);
          err(it, 'deny-cap', `Unknown capability "${it.v}".`, g ? `Did you mean "${g}"?` : `Use: ${DENY_CAPS.join(', ')}`);
        } else tool.deny.push({ cap: it.v, line, col: it.col, endCol: it.end });
      }
      return;
    }

    case 'secret': {
      const items = list(0);
      if (!items.length) return err(kw, 'secret-empty', 'secret needs a name.', 'secret API_KEY');
      for (const it of items) {
        if (it.t !== 'word' || !/^[A-Z][A-Z0-9_]*$/.test(it.v)) {
          err(it, 'secret-name', `"${it.v}" is not a valid secret name.`, 'Use UPPER_CASE, like API_KEY. The value is read from the environment variable of the same name.');
        } else if (tool.secrets.some((s) => s.name === it.v)) err(it, 'duplicate-secret', `Secret ${it.v} is already declared.`);
        else tool.secrets.push({ name: it.v, line, col: it.col, endCol: it.end });
      }
      return;
    }

    case 'limit': {
      const what = rest[0];
      const v = rest[1];
      if (!what || what.t !== 'word') return err(kw, 'limit-kind', 'limit needs a kind.', 'limit time 5s | limit calls 10/min | limit output 10kb');
      if (what.v === 'time') {
        const ms = v ? parseDuration(v.v) : null;
        if (!v || ms === null || ms <= 0) return err(v ?? what, 'limit-time', 'limit time needs a duration.', 'limit time 5s (units: ms, s, m, h)');
        tool.timeMs = ms;
        tool.timeLabel = fmtMs(ms);
        return noExtra(2);
      }
      if (what.v === 'calls') {
        const m = v ? /^(\d+)\/(sec|min|hour)$/.exec(v.v) : null;
        if (!v || !m || Number(m[1]) < 1) return err(v ?? what, 'limit-calls', 'limit calls needs a rate.', 'limit calls 10/min (units: sec, min, hour)');
        const perMs = { sec: 1000, min: 60_000, hour: 3_600_000 }[m[2] as 'sec' | 'min' | 'hour'];
        tool.calls = { max: Number(m[1]), perMs, label: v.v };
        return noExtra(2);
      }
      if (what.v === 'output') {
        const b = v ? parseSize(v.v) : null;
        if (!v || b === null || b <= 0) return err(v ?? what, 'limit-output', 'limit output needs a size.', 'limit output 20kb (units: b, kb, mb)');
        tool.outputBytes = b;
        return noExtra(2);
      }
      const g = didYouMean(what.v, ['time', 'calls', 'output']);
      return err(what, 'limit-kind', `Unknown limit "${what.v}".`, g ? `Did you mean "${g}"?` : 'Use time, calls or output.');
    }

    case 'cache': {
      const ms = rest[0] ? parseDuration(rest[0].v) : null;
      if (!rest[0] || ms === null || ms <= 0) return err(rest[0] ?? kw, 'cache', 'cache needs a duration.', 'cache 60s');
      tool.cacheMs = ms;
      return noExtra(1);
    }

    case 'retry': {
      const n = rest[0] ? Number(rest[0].v) : NaN;
      if (!rest[0] || !Number.isInteger(n) || n < 0 || n > 5) return err(rest[0] ?? kw, 'retry', 'retry needs a whole number from 0 to 5.', 'retry 2');
      tool.retry = n;
      return noExtra(1);
    }

    case 'approve': {
      let i = 0;
      if (rest[0] && (rest[0].v === 'if' || rest[0].v === 'when')) i = 1;
      const m = rest[i];
      if (!m || !['never', 'always', 'untrusted'].includes(m.v)) {
        const g = m ? didYouMean(m.v, ['never', 'always', 'untrusted']) : undefined;
        return err(m ?? kw, 'approve', 'approve needs never, always or untrusted.', g ? `Did you mean "${g}"?` : 'approve always | approve untrusted | approve never');
      }
      tool.approve = m.v as Tool['approve'];
      tool.approveLine = line;
      return noExtra(i + 1);
    }

    case 'run':
      return runStep(tool, kw, rest, line, err);

    case 'then': {
      const cursor = cursorOf(tool);
      // `then` belongs to the run step above it. Before any run step it waits for the first one.
      const into = cursor.last ? cursor.last.transforms : cursor.pending;
      const k = rest[0];
      if (!k || k.t !== 'word') return err(kw, 'then', 'then needs a step.', 'then json | then pick a.b.c | then trim 500');
      if (k.v === 'json') {
        into.push({ kind: 'json', line });
        return noExtra(1);
      }
      if (k.v === 'pick') {
        const p = rest[1];
        if (!p || p.t !== 'word' || !/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(p.v)) return err(p ?? k, 'pick-path', 'then pick needs a path.', 'then pick results.0.title');
        into.push({ kind: 'pick', path: p.v, line });
        return noExtra(2);
      }
      if (k.v === 'trim') {
        const n = rest[1] ? Number(rest[1].v) : NaN;
        if (!rest[1] || !Number.isInteger(n) || n < 1) return err(rest[1] ?? k, 'trim', 'then trim needs a number of characters.', 'then trim 500');
        into.push({ kind: 'trim', chars: n, line });
        return noExtra(2);
      }
      const g = didYouMean(k.v, ['json', 'pick', 'trim']);
      return err(k, 'then', `Unknown step "${k.v}".`, g ? `Did you mean "${g}"?` : 'Use json, pick or trim.');
    }

    case 'output': {
      const m = rest[0];
      if (!m || !['text', 'json', 'number'].includes(m.v)) return err(m ?? kw, 'output', 'output needs text, json or number.', 'output json');
      tool.output = m.v as Tool['output'];
      return noExtra(1);
    }

    case 'let':
      return err(kw, 'let-syntax', '"let" goes after "run".', 'Write: run let page = get "https://…"');

    default: {
      const g = didYouMean(kw.v, KEYWORDS);
      return err(kw, 'unknown-keyword', `Unknown keyword "${kw.v}".`, g ? `Did you mean "${g}"?` : `Keywords: ${KEYWORDS.join(', ')}`);
    }
  }
}

/** `run get "…"` or `run let name = get "…"`. One call adds one step to the tool. */
function runStep(tool: Tool, kw: Tok, args: Tok[], line: number, err: ErrFn): void {
  const cursor = cursorOf(tool);
  cursor.last = null; // if this line is broken, the `then` lines below it must not stick to an older step
  if (tool.steps.length >= MAX_STEPS) return err(kw, 'too-many-steps', `A tool can have at most ${MAX_STEPS} run steps.`, 'Split the work into two tools.');
  let rest = args;
  let name: Tok | undefined;
  if (rest[0]?.t === 'word' && rest[0].v === 'let') {
    const n = rest[1];
    const eq = rest[2];
    if (!n || n.t !== 'word' || !eq || eq.t !== 'sym' || eq.v !== '=') {
      return err(n ?? rest[0], 'let-syntax', 'A named step looks like: run let name = get "https://…"', 'Later steps can then use {name}.');
    }
    if (!IDENT.test(n.v)) err(n, 'step-name', `"${n.v}" is not a valid step name.`, 'Use lowercase letters, digits and underscores, starting with a letter.');
    else if (n.v === 'secret') err(n, 'step-name', '"secret" is reserved for {secret.NAME}.', 'Pick another name.');
    name = n;
    rest = rest.slice(3);
  }
  const a = rest[0];
  const kinds = ['get', 'post', 'read', 'write', 'echo'];
  if (!a || a.t !== 'word' || !kinds.includes(a.v)) {
    const g = a ? didYouMean(a.v, kinds) : undefined;
    return err(a ?? kw, 'run-kind', a ? `Unknown action "${a.v}".` : 'run needs an action.', g ? `Did you mean "${g}"?` : 'run get "https://…" | post | read "path" | write "path" content "…" | echo "…"');
  }
  const arg = rest[1];
  if (!arg || arg.t !== 'str') return err(arg ?? a, 'run-arg', `run ${a.v} needs a quoted string.`, `run ${a.v} "…"`);
  const headers: Header[] = [];
  let body: Str | undefined;
  let content: Str | undefined;
  let i = 2;
  while (i < rest.length) {
    const k = rest[i];
    if (k.t === 'word' && k.v === 'header' && (a.v === 'get' || a.v === 'post')) {
      const n = rest[i + 1];
      const eq = rest[i + 2];
      const v = rest[i + 3];
      if (!n || n.t !== 'word' || !eq || eq.v !== '=' || !v || v.t !== 'str') {
        err(k, 'header-syntax', 'Headers look like: header Name = "value"');
        break;
      }
      headers.push({ name: n.v, value: toStr(v, line), line, col: n.col, endCol: v.end });
      i += 4;
      continue;
    }
    if (k.t === 'word' && k.v === 'body' && a.v === 'post') {
      const v = rest[i + 1];
      if (!v || v.t !== 'str') {
        err(k, 'body-syntax', 'body needs a quoted string.', 'body "{{\\"q\\": \\"{query}\\"}}"');
        break;
      }
      body = toStr(v, line);
      i += 2;
      continue;
    }
    if (k.t === 'word' && k.v === 'content' && a.v === 'write') {
      const v = rest[i + 1];
      if (!v || v.t !== 'str') {
        err(k, 'content-syntax', 'content needs a quoted string.');
        break;
      }
      content = toStr(v, line);
      i += 2;
      continue;
    }
    const opts = a.v === 'get' ? 'header' : a.v === 'post' ? 'header or body' : a.v === 'write' ? 'content' : 'nothing more';
    err(k, 'unexpected', `Unexpected "${k.v}" after run ${a.v}.`, `run ${a.v} accepts: ${opts}.`);
    break;
  }
  const loc = { line, col: a.col, endCol: rest[rest.length - 1].end };
  const s = toStr(arg, line);
  let action: Action | undefined;
  if (a.v === 'get') action = { kind: 'get', url: s, headers, ...loc };
  else if (a.v === 'post') action = { kind: 'post', url: s, body, headers, ...loc };
  else if (a.v === 'read') action = { kind: 'read', path: s, ...loc };
  else if (a.v === 'echo') action = { kind: 'echo', text: s, ...loc };
  else if (!content) return err(a, 'write-content', 'run write needs content.', 'run write "./out/{name}.txt" content "{text}"');
  else action = { kind: 'write', path: s, content, ...loc };
  const step: Step = { action, transforms: cursor.pending.splice(0) };
  if (name) {
    step.name = name.v;
    step.nameAt = { line, col: name.col, endCol: name.end };
  }
  tool.steps.push(step);
  cursor.last = step;
}

/** Lines inside `test "name"`: mock, call, expect. */
function testStatement(test: TestCase, toks: Tok[], line: number, diags: Diagnostic[]): void {
  const err: ErrFn = (t, code, message, hint) => {
    diags.push({ severity: 'error', code, message, line, col: t.col, endCol: t.end, hint });
  };
  const kw = toks[0];
  const rest = toks.slice(1);
  const endOf = rest.length ? rest[rest.length - 1].end : kw.end;

  if (kw.t !== 'word') return err(kw, 'syntax', 'Each line inside a test starts with a keyword.', `Keywords: ${TEST_KEYWORDS.join(', ')}`);

  switch (kw.v) {
    case 'mock': {
      const u = rest[0];
      if (!u || u.t !== 'str') return err(u ?? kw, 'mock-syntax', 'mock needs a quoted URL.', 'mock "https://api.example.com/x" status 200 body "ok"');
      const mock: MockDef = { url: toStr(u, line), status: 200, body: '', headers: {}, line, col: kw.col, endCol: endOf };
      let i = 1;
      while (i < rest.length) {
        const k = rest[i];
        if (k.t === 'word' && k.v === 'status') {
          const n = rest[i + 1];
          const code = n ? Number(n.v) : NaN;
          if (!n || n.t !== 'word' || !Number.isInteger(code) || code < 100 || code > 599) return err(n ?? k, 'mock-status', 'status needs a number from 100 to 599.', 'status 302');
          mock.status = code;
          i += 2;
        } else if (k.t === 'word' && k.v === 'body') {
          const v = rest[i + 1];
          if (!v || v.t !== 'str') return err(v ?? k, 'mock-body', 'body needs a quoted string.', 'body "{\\"id\\": 42}"');
          mock.body = v.v;
          i += 2;
        } else if (k.t === 'word' && k.v === 'header') {
          const n = rest[i + 1];
          const eq = rest[i + 2];
          const v = rest[i + 3];
          if (!n || n.t !== 'word' || !eq || eq.v !== '=' || !v || v.t !== 'str') return err(k, 'header-syntax', 'Headers look like: header Name = "value"');
          mock.headers[n.v] = v.v;
          i += 4;
        } else {
          return err(k, 'unexpected', `Unexpected "${k.v}" in mock.`, 'mock accepts: status, body, header.');
        }
      }
      test.mocks.push(mock);
      return;
    }

    case 'call': {
      const t = rest[0];
      if (!t || t.t !== 'word') return err(t ?? kw, 'call-syntax', 'call needs a tool name.', 'call search_web query="cats"');
      const call: TestCall = { tool: t.v, args: [], untrusted: false, approved: false, expects: [], line, col: t.col, endCol: endOf };
      let i = 1;
      while (i < rest.length) {
        const k = rest[i];
        const eq = rest[i + 1];
        // The words `untrusted` and `approved` are flags, unless they are followed by "=" (then they are inputs).
        if (k.t === 'word' && (k.v === 'untrusted' || k.v === 'approved') && eq?.v !== '=') {
          call[k.v] = true;
          i++;
          continue;
        }
        const val = rest[i + 2];
        if (k.t !== 'word' || !eq || eq.t !== 'sym' || eq.v !== '=' || !val || val.t === 'sym') {
          return err(k, 'call-arg', 'Arguments look like: name="text", count=3 or flag=true.', 'Flags: untrusted, approved');
        }
        let v: Scalar;
        if (val.t === 'str') v = val.v;
        else if (val.v === 'true' || val.v === 'false') v = val.v === 'true';
        else if (val.v !== '' && Number.isFinite(Number(val.v))) v = Number(val.v);
        else return err(val, 'call-arg', 'Text values must be in quotes.', `${k.v}="${val.v}"`);
        if (call.args.some((a) => a.name === k.v)) err(k, 'call-arg-duplicate', `"${k.v}" is given twice.`);
        else call.args.push({ name: k.v, value: v, line, col: k.col, endCol: val.end });
        i += 3;
      }
      test.calls.push(call);
      return;
    }

    case 'expect': {
      const call = test.calls[test.calls.length - 1];
      if (!call) return err(kw, 'expect-before-call', 'expect must come after a call.', 'Write a call line first: call my_tool name="x"');
      const w = rest[0];
      if (!w || w.t !== 'word') return err(w ?? kw, 'expect-syntax', 'expect needs ok, denied, error or output.', 'expect ok | expect denied | expect error CODE | expect output contains "text"');
      const loc = { line, col: w.col, endCol: endOf };
      const extra = (from: number) => {
        if (rest[from]) err(rest[from], 'unexpected', `Unexpected "${rest[from].v}".`, 'Remove it, or check the syntax of this line.');
      };
      if (w.v === 'ok' || w.v === 'denied') {
        call.expects.push({ kind: w.v, ...loc });
        return extra(1);
      }
      if (w.v === 'error') {
        const c = rest[1];
        if (!c) {
          call.expects.push({ kind: 'error', ...loc });
          return;
        }
        if (c.t !== 'word' || !(ERROR_CODES as readonly string[]).includes(c.v)) {
          const g = didYouMean(c.v, ERROR_CODES);
          return err(c, 'expect-code', `Unknown error code "${c.v}".`, g ? `Did you mean "${g}"?` : `Codes: ${ERROR_CODES.join(', ')}`);
        }
        call.expects.push({ kind: 'error', code: c.v as ErrorCode, ...loc });
        return extra(2);
      }
      if (w.v === 'output') {
        let i = 1;
        let mode: 'equals' | 'contains' | 'not-contains' = 'equals';
        if (rest[i]?.t === 'word' && rest[i].v === 'contains') {
          mode = 'contains';
          i++;
        } else if (rest[i]?.t === 'word' && rest[i].v === 'not') {
          if (rest[i + 1]?.v !== 'contains') return err(rest[i + 1] ?? rest[i], 'expect-syntax', '"not" must be followed by "contains".', 'expect output not contains "text"');
          mode = 'not-contains';
          i += 2;
        }
        const v = rest[i];
        if (!v || v.t !== 'str') return err(v ?? w, 'expect-syntax', 'expect output needs a quoted string.', 'expect output "42" | expect output contains "42" | expect output not contains "secret"');
        call.expects.push({ kind: 'output', mode, text: v.v, ...loc });
        return extra(i + 1);
      }
      const g = didYouMean(w.v, ['ok', 'denied', 'error', 'output']);
      return err(w, 'expect-syntax', `Unknown expectation "${w.v}".`, g ? `Did you mean "${g}"?` : 'Use ok, denied, error or output.');
    }

    default: {
      const g = didYouMean(kw.v, TEST_KEYWORDS);
      return err(kw, 'unknown-keyword', `Unknown keyword "${kw.v}" in a test.`, g ? `Did you mean "${g}"?` : `Keywords: ${TEST_KEYWORDS.join(', ')}`);
    }
  }
}
