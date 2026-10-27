export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

export function didYouMean(word: string, options: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = 3;
  for (const o of options) {
    const d = levenshtein(word.toLowerCase(), o.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

/** "5s", "250ms", "2m", "1h" -> milliseconds */
export function parseDuration(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/i.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2].toLowerCase() as 'ms' | 's' | 'm' | 'h'];
  return Math.round(n * mult);
}

/** "10kb", "2mb", "500b" -> bytes */
export function parseSize(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(b|kb|mb)$/i.exec(s);
  if (!m) return null;
  const mult = { b: 1, kb: 1024, mb: 1024 * 1024 }[m[2].toLowerCase() as 'b' | 'kb' | 'mb'];
  return Math.round(parseFloat(m[1]) * mult);
}

export function fmtMs(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

export async function sha256(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
