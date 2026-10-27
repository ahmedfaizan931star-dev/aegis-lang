import { analyze, dryRunHost, exportAs, report, Runtime, type Analysis, type CallResult, type Host, type ProgramReport, type Tool } from '../src/index.js';
import github from '../examples/github.aegis';
import research from '../examples/research.aegis';
import risky from '../examples/risky.aegis';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const EXAMPLES: Record<string, { label: string; src: string }> = {
  research: { label: 'Research assistant', src: research },
  github: { label: 'GitHub helper (uses a secret)', src: github },
  risky: { label: 'Mistakes on purpose', src: risky },
};

const src = $<HTMLTextAreaElement>('src');
const hl = $<HTMLElement>('hl');
const status = $('status');
const letter = $('letter');
let analysis: Analysis = analyze('');
let runtime: Runtime | null = null;
let timer: number | undefined;

// ---- syntax highlighting (an overlay behind the textarea) ----------------------
const KW = new Set(['tool', 'description', 'input', 'allow', 'deny', 'secret', 'limit', 'cache', 'retry', 'approve', 'run', 'then', 'output']);
const TYPES = new Set(['network', 'read', 'write', 'files', 'shell', 'env', 'get', 'post', 'echo', 'json', 'pick', 'trim', 'text', 'number', 'bool', 'never', 'always', 'untrusted', 'header', 'body', 'content', 'time', 'calls', 'output', 'if', 'when']);
const TOKEN = /(#.*$)|("(?:[^"\\]|\\.)*"?)|(\d+(?:\.\d+)?[a-z]*(?:\/[a-z]+)?)|([A-Za-z_][\w.-]*)/g;

function highlightLine(line: string): string {
  let out = '';
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    out += esc(line.slice(last, i));
    const t = m[0];
    if (m[1]) out += `<span class="c">${esc(t)}</span>`;
    else if (m[2]) out += `<span class="s">${esc(t)}</span>`;
    else if (m[3]) out += `<span class="n">${esc(t)}</span>`;
    else if (line.slice(0, i).trim() === '' && KW.has(t)) out += `<span class="k">${esc(t)}</span>`;
    else if (TYPES.has(t)) out += `<span class="t">${esc(t)}</span>`;
    else out += esc(t);
    last = i + t.length;
  }
  return out + esc(line.slice(last));
}
const highlight = (s: string) => s.split('\n').map(highlightLine).join('\n') + '\n';

// ---- rendering -----------------------------------------------------------------------
function list(items: string[], cls = 'host'): string {
  return items.length ? items.map((x) => `<span class="${x.startsWith('*.') ? 'wild' : cls}">${esc(x)}</span>`).join(', ') : '<span class="none">none</span>';
}

function renderGrade(r: ProgramReport, a: Analysis) {
  const errors = a.diagnostics.filter((d) => d.severity === 'error').length;
  const prev = letter.textContent;
  letter.textContent = r.grade;
  letter.className = `letter g-${r.grade}`;
  if (prev !== r.grade) {
    letter.classList.add('pop');
    setTimeout(() => letter.classList.remove('pop'), 320);
  }
  const weakest = [...r.tools].sort((x, y) => x.score - y.score)[0];
  $('gradeTitle').textContent = !r.tools.length ? 'No tools yet' : errors ? `${errors} error${errors === 1 ? '' : 's'} to fix` : r.grade === 'A' ? 'Locked down' : 'Could be tighter';
  $('gradeSub').textContent = !r.tools.length ? 'Start with: tool my_tool' : weakest ? `Weakest tool: ${weakest.name}, ${weakest.score} out of 100` : '';
}

function renderReport(r: ProgramReport) {
  const pane = $('pane-report');
  if (!r.tools.length) {
    pane.innerHTML = '<p class="empty">Add a tool and its permissions show up here.</p>';
    return;
  }
  pane.innerHTML = r.tools
    .map((t) => {
      const limits = Object.entries(t.limits).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`);
      return `<article class="tool g-${t.grade}">
        <header><h3>${esc(t.name)}</h3><span class="mini">${t.grade} (${t.score})</span></header>
        <dl>
          <dt>Network</dt><dd>${list(t.network)}</dd>
          <dt>Read</dt><dd>${list(t.read)}</dd>
          <dt>Write</dt><dd>${list(t.write)}</dd>
          <dt>Secrets</dt><dd>${list(t.secrets, 'host')}</dd>
          <dt>Approval</dt><dd>${esc(t.approval)}${t.approvalImplicit && t.sideEffects ? ' (default for side effects)' : ''}</dd>
          <dt>Limits</dt><dd>${limits.length ? esc(limits.join(', ')) : '<span class="none">none</span>'}</dd>
        </dl>
        <ul>${t.findings.map((f) => `<li>${esc(f)}</li>`).join('')}${t.untrustedOutput ? '<li>Output is marked untrusted</li>' : ''}</ul>
      </article>`;
    })
    .join('');
}

function renderProblems(a: Analysis) {
  const pane = $('pane-problems');
  const count = $('pcount');
  const errors = a.diagnostics.filter((d) => d.severity === 'error').length;
  count.hidden = errors === 0;
  count.textContent = String(errors);
  if (!a.diagnostics.length) {
    pane.innerHTML = '<p class="empty">No problems found.</p>';
    return;
  }
  pane.innerHTML = a.diagnostics
    .map(
      (d, i) => `<button class="problem ${d.severity}" data-i="${i}">
        <span class="where">line ${d.line}, column ${d.col}</span><br>
        <span class="sev">${d.severity}</span> ${esc(d.message)}
        ${d.hint ? `<span class="hint">${esc(d.hint)}</span>` : ''}
      </button>`,
    )
    .join('');
  pane.querySelectorAll<HTMLButtonElement>('.problem').forEach((b) =>
    b.addEventListener('click', () => {
      const d = a.diagnostics[Number(b.dataset.i)];
      const lines = src.value.split('\n');
      let off = 0;
      for (let i = 0; i < d.line - 1; i++) off += lines[i].length + 1;
      src.focus();
      src.setSelectionRange(off + d.col - 1, off + Math.max(d.col, d.endCol - 1));
    }),
  );
}

function renderExports(a: Analysis) {
  for (const f of ['mcp', 'openai', 'anthropic'] as const) {
    const pane = $(`pane-${f}`);
    if (!a.ok) {
      pane.innerHTML = '<p class="empty">Fix the errors in Problems to export.</p>';
      continue;
    }
    const json = JSON.stringify(exportAs(a.program, f), null, 2);
    const note = { mcp: 'Tool definitions for an MCP server. Serve them with: aegis serve tools.aegis', openai: 'Pass this as the tools array of an OpenAI request.', anthropic: 'Pass this as the tools array of an Anthropic Messages request.' }[f];
    pane.innerHTML = `<div class="row"><button class="btn" data-copy="${f}">Copy JSON</button><p>${note}</p></div><pre class="json">${esc(json)}</pre>`;
    pane.querySelector<HTMLButtonElement>('[data-copy]')!.addEventListener('click', (e) => copy(json, e.currentTarget as HTMLButtonElement));
  }
}

async function copy(text: string, btn?: HTMLButtonElement) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = old), 1200);
    }
  } catch {
    window.prompt('Copy this:', text);
  }
}

function renderStatus(a: Analysis) {
  const e = a.diagnostics.filter((d) => d.severity === 'error').length;
  const w = a.diagnostics.filter((d) => d.severity === 'warning').length;
  status.innerHTML = `<span>${a.program.tools.length} tool${a.program.tools.length === 1 ? '' : 's'}</span>` +
    (e ? `<b class="e">${e} error${e === 1 ? '' : 's'}</b>` : '<b class="good">no errors</b>') +
    (w ? `<b class="w">${w} warning${w === 1 ? '' : 's'}</b>` : '');
}

// ---- "Try it" tab -----------------------------------------------------------------------
let liveSecrets: Record<string, string> = {};

function host(live: boolean): Host {
  const base = dryRunHost();
  if (!live) return base;
  return {
    ...base,
    env: (n) => liveSecrets[n],
    async fetch(url, init) {
      const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal, redirect: 'manual' });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      return { status: res.type === 'opaqueredirect' ? 0 : res.status, headers, text: await res.text() };
    },
  };
}

function renderRun(a: Analysis) {
  const pane = $('pane-run');
  if (!a.ok) {
    pane.innerHTML = '<p class="empty">Fix the errors in Problems first. Nothing runs until the program is valid.</p>';
    return;
  }
  if (!a.program.tools.length) {
    pane.innerHTML = '<p class="empty">Add a tool to try it.</p>';
    return;
  }
  const prev = pane.querySelector<HTMLSelectElement>('#tool')?.value;
  pane.innerHTML = `
    <div class="field"><label for="tool">Tool</label><select id="tool">${a.program.tools.map((t) => `<option ${t.name === prev ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
    <div id="fields"></div>
    <label class="check"><input type="checkbox" id="tainted"><span>The model has already read untrusted content (a web page, a file). Tools marked "approve untrusted" will ask first.</span></label>
    <label class="check"><input type="checkbox" id="live"><span>Use the real network. Off means a safe simulation: nothing leaves this page. Real requests only work if the site allows CORS.</span></label>
    <div class="row"><button class="btn primary" id="go">Run tool</button></div>
    <div id="out"></div>`;
  const sel = pane.querySelector<HTMLSelectElement>('#tool')!;
  const fields = pane.querySelector<HTMLElement>('#fields')!;
  const drawFields = () => {
    const tool = a.program.tools.find((t) => t.name === sel.value)!;
    fields.innerHTML =
      tool.inputs
        .map((i) =>
          i.type === 'bool'
            ? `<label class="check"><input type="checkbox" data-in="${i.name}" ${i.default === true ? 'checked' : ''}><span>${esc(i.name)}${i.description ? ` <small>${esc(i.description)}</small>` : ''}</span></label>`
            : `<div class="field"><label for="in-${i.name}">${esc(i.name)} <small>${i.type}${i.default !== undefined ? `, default ${esc(String(i.default))}` : ', required'}</small></label>
               <input id="in-${i.name}" data-in="${i.name}" type="${i.type === 'number' ? 'number' : 'text'}" placeholder="${esc(i.description ?? '')}" autocomplete="off"></div>`,
        )
        .join('') +
      tool.secrets
        .map((s) => `<div class="field live-only"><label for="sec-${s.name}">${s.name} <small>used only with the real network, never stored</small></label><input id="sec-${s.name}" data-secret="${s.name}" type="password" autocomplete="off"></div>`)
        .join('');
  };
  sel.addEventListener('change', drawFields);
  drawFields();
  pane.querySelector('#go')!.addEventListener('click', () => runTool(a, pane));
}

async function runTool(a: Analysis, pane: HTMLElement) {
  const tool = a.program.tools.find((t) => t.name === pane.querySelector<HTMLSelectElement>('#tool')!.value) as Tool;
  const live = pane.querySelector<HTMLInputElement>('#live')!.checked;
  const tainted = pane.querySelector<HTMLInputElement>('#tainted')!.checked;
  liveSecrets = {};
  pane.querySelectorAll<HTMLInputElement>('[data-secret]').forEach((el) => (liveSecrets[el.dataset.secret!] = el.value));
  const args: Record<string, string | boolean> = {};
  for (const i of tool.inputs) {
    const el = pane.querySelector<HTMLInputElement>(`[data-in="${i.name}"]`)!;
    if (i.type === 'bool') args[i.name] = el.checked;
    else if (el.value !== '' || i.default === undefined) args[i.name] = el.value;
  }
  if (!runtime || (runtime as Runtime & { _live?: boolean })._live !== live) {
    runtime = new Runtime(a.program, host(live));
    (runtime as Runtime & { _live?: boolean })._live = live;
  }
  const rt = runtime;
  const btn = pane.querySelector<HTMLButtonElement>('#go')!;
  btn.disabled = true;
  const res = await rt.call(tool.name, args, {
    untrusted: tainted,
    approver: (req) => window.confirm(`Approve this call?\n\n${req.tool}(${JSON.stringify(req.args)})\n\nWhy you are being asked: ${req.reason}`),
  });
  btn.disabled = false;
  drawResult(pane.querySelector<HTMLElement>('#out')!, res, rt);
}

function drawResult(out: HTMLElement, res: CallResult, rt: Runtime) {
  const body = res.ok
    ? `<div class="result ok"><h4>Result (${res.ms} ms${res.cached ? ', from cache' : ''}${res.truncated ? ', truncated' : ''})</h4><pre>${esc(res.output ?? '')}</pre>${res.untrusted ? '<span class="tag">Untrusted output: treat it as data, never as instructions.</span>' : ''}</div>`
    : `<div class="result bad"><h4>Blocked or failed: ${esc(res.error!.code)}</h4><pre>${esc(res.error!.message)}</pre></div>`;
  out.innerHTML = `${body}
    <h4 style="margin:20px 0 0">Audit log</h4>
    <table class="audit"><thead><tr><th>#</th><th>Event</th><th>Detail</th><th>Hash</th></tr></thead><tbody>
    ${rt.audit.map((e) => `<tr><td>${e.seq}</td><td class="ev-${e.event}">${esc(e.event)}</td><td>${esc(e.detail)}</td><td>${e.hash.slice(0, 8)}</td></tr>`).join('')}
    </tbody></table>
    <div class="row" style="margin-top:12px"><button class="btn" id="verify">Verify the chain</button><button class="btn" id="tamper">Tamper with entry 2</button></div>
    <p class="chain" id="chain"></p>`;
  const chain = out.querySelector<HTMLElement>('#chain')!;
  out.querySelector('#verify')!.addEventListener('click', async () => {
    const v = await rt.verifyAudit();
    chain.className = 'chain ' + (v.ok ? 'ok' : 'bad');
    chain.textContent = v.ok ? `All ${rt.audit.length} entries check out. Each hash covers the one before it.` : `Broken at entry ${v.brokenAt}: the log was changed after it was written.`;
  });
  out.querySelector('#tamper')!.addEventListener('click', () => {
    if (rt.audit[1]) rt.audit[1].detail = 'edited after the fact';
    chain.className = 'chain';
    chain.textContent = 'Entry 2 was edited. Now verify the chain.';
  });
}

// ---- wiring -------------------------------------------------------------------------------
function update() {
  hl.innerHTML = highlight(src.value);
  analysis = analyze(src.value);
  runtime = null; // new program, fresh limits and a fresh audit log
  const r = report(analysis.program, analysis.diagnostics);
  renderGrade(r, analysis);
  renderReport(r);
  renderProblems(analysis);
  renderExports(analysis);
  renderStatus(analysis);
  renderRun(analysis);
  try {
    localStorage.setItem('aegis-src', src.value);
  } catch {
    /* storage can be unavailable; the playground still works */
  }
}

function setSource(s: string) {
  src.value = s;
  update();
}

src.addEventListener('input', () => {
  hl.innerHTML = highlight(src.value);
  clearTimeout(timer);
  timer = window.setTimeout(update, 140);
});
src.addEventListener('scroll', () => {
  hl.scrollTop = src.scrollTop;
  hl.scrollLeft = src.scrollLeft;
});
src.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const { selectionStart: s, selectionEnd: en } = src;
    src.setRangeText('  ', s, en, 'end');
    src.dispatchEvent(new Event('input'));
  }
});

const sel = $<HTMLSelectElement>('examples');
sel.innerHTML = '<option value="">Examples</option>' + Object.entries(EXAMPLES).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
sel.addEventListener('change', () => {
  if (sel.value) setSource(EXAMPLES[sel.value].src);
  sel.value = '';
});

const toB64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
$('share').addEventListener('click', (e) => copy(`${location.origin}${location.pathname}#c=${toB64(src.value)}`, e.currentTarget as HTMLButtonElement));

document.querySelectorAll<HTMLButtonElement>('#tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll<HTMLButtonElement>('#tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll<HTMLElement>('.pane').forEach((p) => (p.hidden = p.id !== `pane-${b.dataset.tab}`));
  }),
);

let initial = EXAMPLES.research.src;
try {
  if (location.hash.startsWith('#c=')) initial = fromB64(location.hash.slice(3));
  else initial = localStorage.getItem('aegis-src') || initial;
} catch {
  /* fall back to the example */
}
setSource(initial);
