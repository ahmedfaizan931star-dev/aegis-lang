import type { Diagnostic } from './types.js';

export interface Tok {
  t: 'word' | 'str' | 'sym';
  v: string;
  col: number; // 1-based
  end: number; // 1-based, exclusive
}

const SYMS = new Set([':', ',', '=']);
const WORD_STOP = /[\s",:=#]/;

/** Tokenise a single line. Comments (#) run to the end of the line. */
export function lexLine(text: string, line: number, diags: Diagnostic[]): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '#') break;
    if (SYMS.has(c)) {
      toks.push({ t: 'sym', v: c, col: i + 1, end: i + 2 });
      i++;
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      let out = '';
      let closed = false;
      while (i < text.length) {
        const ch = text[i];
        if (ch === '\\' && i + 1 < text.length) {
          const n = text[i + 1];
          out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          i += 2;
          continue;
        }
        if (ch === '"') {
          closed = true;
          i++;
          break;
        }
        out += ch;
        i++;
      }
      if (!closed) {
        diags.push({
          severity: 'error',
          code: 'unterminated-string',
          message: 'This string is missing its closing quote.',
          line,
          col: start + 1,
          endCol: text.length + 1,
          hint: 'Add a " at the end of the string.',
        });
      }
      toks.push({ t: 'str', v: out, col: start + 1, end: i + 1 });
      continue;
    }
    const start = i;
    while (i < text.length && !WORD_STOP.test(text[i])) i++;
    toks.push({ t: 'word', v: text.slice(start, i), col: start + 1, end: i + 1 });
  }
  return toks;
}
