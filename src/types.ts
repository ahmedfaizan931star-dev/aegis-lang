export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  line: number; // 1-based
  col: number; // 1-based
  endCol: number; // 1-based, exclusive
  hint?: string;
}

export type InputType = 'text' | 'number' | 'bool';
export type Scalar = string | number | boolean;

export interface Located {
  line: number;
  col: number;
  endCol: number;
}

/** A string literal with its position (used for templates, paths, URLs). */
export interface Str extends Located {
  value: string;
}

export interface InputDef extends Located {
  name: string;
  type: InputType;
  description?: string;
  default?: Scalar;
}

export interface SecretDef extends Located {
  name: string;
}

export interface Header {
  name: string;
  value: Str;
  line: number;
  col: number;
  endCol: number;
}

export interface GetAction extends Located {
  kind: 'get';
  url: Str;
  headers: Header[];
}
export interface PostAction extends Located {
  kind: 'post';
  url: Str;
  body?: Str;
  headers: Header[];
}
export interface ReadAction extends Located {
  kind: 'read';
  path: Str;
}
export interface WriteAction extends Located {
  kind: 'write';
  path: Str;
  content: Str;
}
export interface EchoAction extends Located {
  kind: 'echo';
  text: Str;
}
export type Action = GetAction | PostAction | ReadAction | WriteAction | EchoAction;

export type Transform =
  | { kind: 'json'; line: number }
  | { kind: 'pick'; path: string; line: number }
  | { kind: 'trim'; chars: number; line: number };

export interface DenyEntry extends Located {
  cap: string;
}

export interface Tool extends Located {
  name: string;
  description?: Str;
  inputs: InputDef[];
  network: Str[];
  read: Str[];
  write: Str[];
  deny: DenyEntry[];
  secrets: SecretDef[];
  timeMs?: number;
  timeLabel?: string;
  calls?: { max: number; perMs: number; label: string };
  outputBytes?: number;
  cacheMs?: number;
  retry: number;
  approve?: 'never' | 'always' | 'untrusted';
  approveLine?: number;
  action?: Action;
  transforms: Transform[];
  output: 'text' | 'json' | 'number';
}

export interface Program {
  tools: Tool[];
}
