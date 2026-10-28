import assert from 'node:assert/strict';
import { analyze, Runtime, type Host, type HttpInit, type HttpResponse } from '../src/index.js';

export const codes = (src: string) => analyze(src).diagnostics.map((d) => d.code);
export const errorCodes = (src: string) => analyze(src).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);

export interface Fake extends Host {
  t: number;
  calls: { url: string; init: HttpInit }[];
  files: Map<string, string>;
  respond: (url: string, init: HttpInit, n: number) => HttpResponse | Promise<HttpResponse>;
}

/** A host that records every request and never touches the real network or disk. */
export function fake(over: Partial<Fake> = {}): Fake {
  const f: Fake = {
    t: 1_700_000_000_000,
    calls: [],
    files: new Map(),
    respond: () => ({ status: 200, headers: {}, text: '{"ok":true}' }),
    now: () => f.t,
    sleep: async () => {},
    async fetch(url, init) {
      f.calls.push({ url, init });
      return f.respond(url, init, f.calls.length);
    },
    async readFile(p) {
      const v = f.files.get(p);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    async writeFile(p, c) {
      f.files.set(p, c);
    },
    env: (n) => (n === 'API_KEY' ? 'sk-super-secret-123' : 'tok-' + n + '-value'),
    ...over,
  };
  return f;
}

export const rt = (src: string, host: Host = fake()) => {
  const a = analyze(src);
  assert.equal(a.ok, true, 'program should be valid: ' + JSON.stringify(a.diagnostics));
  return new Runtime(a.program, host);
};

export const json = (v: unknown): HttpResponse => ({ status: 200, headers: {}, text: JSON.stringify(v) });
