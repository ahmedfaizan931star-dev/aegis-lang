/** Shared allow-list logic. The checker (static) and the runtime (dynamic) both use this, so they can never disagree. */

export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return h === p;
}

export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

/** POSIX-style normalisation. Returns null for unusable paths. Leading ".." segments are kept so callers can detect escapes. */
export function normalizePath(p: string): string | null {
  if (p.includes('\0')) return null;
  const s = p.replace(/\\/g, '/');
  const abs = s.startsWith('/');
  const out: string[] = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const joined = out.join('/');
  return abs ? '/' + joined : joined;
}

export function escapesRoot(normalized: string): boolean {
  return normalized === '..' || normalized.startsWith('../');
}

/** Is `path` the directory `dir` itself or something inside it (after normalisation)? */
export function insideDir(path: string, dir: string): boolean {
  const p = normalizePath(path);
  const d = normalizePath(dir);
  if (p === null || d === null) return false;
  if (escapesRoot(p)) return false;
  if (d === '/') return false; // never allow the filesystem root
  if (d === '') return !p.startsWith('/'); // "." means the working directory
  return p === d || p.startsWith(d + '/');
}
