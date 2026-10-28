import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Host } from './host.js';

/** The real host for Node 20+: global fetch (no automatic redirects), the local disk, process.env. */
export function nodeHost(env: Record<string, string | undefined> = process.env): Host {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async fetch(url, init) {
      const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal, redirect: 'manual' });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > 2 * 1024 * 1024) throw new Error('Response is larger than the 2 MB safety limit.');
      return { status: res.status, headers, text: await res.text() };
    },
    readFile: (p) => readFile(p, 'utf8'),
    async writeFile(p, c) {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, c, 'utf8');
    },
    env: (n) => env[n],
  };
}
