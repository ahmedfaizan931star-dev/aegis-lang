import type { Host } from './host.js';

/** A host that never touches the network or disk. Great for demos and tests. */
export function dryRunHost(overrides: Partial<Host> = {}): Host {
  const files = new Map<string, string>();
  return {
    now: () => Date.now(),
    sleep: () => Promise.resolve(),
    async fetch(url, init) {
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({ dry_run: true, method: init.method, url, sent_headers: init.headers, body: init.body ?? null, note: 'This is a simulated response.' }),
      };
    },
    async readFile(path) {
      return files.get(path) ?? `[dry run] pretend contents of ${path}`;
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    env: (name) => `dryrun-${name}-secret`,
    ...overrides,
  };
}
