/**
 * Templates are the strings inside a tool: "https://x.com/?q={query}".
 *   {name}          -> an input
 *   {secret.NAME}   -> a declared secret
 *   {{  and  }}     -> literal braces
 */
export type Part = { lit: string } | { ref: string };

export interface ParsedTemplate {
  parts: Part[];
  errors: string[];
}

const REF = /^(secret\.[A-Z][A-Z0-9_]*|[a-z][a-z0-9_]*)$/;

export function parseTemplate(s: string): ParsedTemplate {
  const parts: Part[] = [];
  const errors: string[] = [];
  let lit = '';
  const flush = () => {
    if (lit) {
      parts.push({ lit });
      lit = '';
    }
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '{') {
      if (s[i + 1] === '{') {
        lit += '{';
        i += 2;
        continue;
      }
      const close = s.indexOf('}', i + 1);
      if (close < 0) {
        errors.push('Unclosed "{". Write {{ for a literal brace.');
        lit += c;
        i++;
        continue;
      }
      const name = s.slice(i + 1, close);
      if (!REF.test(name)) {
        errors.push(`"{${name}}" is not a valid placeholder. Use {input_name} or {secret.NAME}; write {{ for a literal brace.`);
        lit += s.slice(i, close + 1);
      } else {
        flush();
        parts.push({ ref: name });
      }
      i = close + 1;
      continue;
    }
    if (c === '}') {
      if (s[i + 1] === '}') {
        lit += '}';
        i += 2;
        continue;
      }
      errors.push('Unmatched "}". Write }} for a literal brace.');
      lit += c;
      i++;
      continue;
    }
    lit += c;
    i++;
  }
  flush();
  return { parts, errors };
}

export function refsOf(t: ParsedTemplate): string[] {
  return t.parts.flatMap((p) => ('ref' in p ? [p.ref] : []));
}
