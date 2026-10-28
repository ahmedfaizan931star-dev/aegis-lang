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

/** Every error code a call can fail with. Tests (`expect error CODE`) use this list too. */
export const ERROR_CODES = ['UNKNOWN_TOOL', 'BAD_INPUT', 'RATE_LIMITED', 'DENIED', 'NEEDS_APPROVAL', 'TIMEOUT', 'HTTP_ERROR', 'MISSING_SECRET', 'FAILED'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** A tool may have at most this many run steps. */
export const MAX_STEPS = 10;

export type Transform =
  | { kind: 'json'; line: number }
  | { kind: 'pick'; path: string; line: number }
  | { kind: 'trim'; chars: number; line: number };

export interface DenyEntry extends Located {
  cap: string;
}

/**
 * One `run` line plus the `then` lines that follow it.
 * `run let page = get "..."` gives the step a name; later steps read it as {page}.
 */
export interface Step {
  name?: string;
  nameAt?: Located;
  action: Action;
  transforms: Transform[];
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
  /** Run steps in order. The result of the last step is the tool's result. */
  steps: Step[];
  output: 'text' | 'json' | 'number';
}

// ---- built-in tests (`test "name"` blocks) -------------------------------------------

export interface MockDef extends Located {
  /** A request whose URL starts with this text gets the mocked response. */
  url: Str;
  status: number;
  body: string;
  headers: Record<string, string>;
}

export interface CallArg extends Located {
  name: string;
  value: Scalar;
}

export type Expectation = Located &
  (
    | { kind: 'ok' }
    | { kind: 'denied' }
    | { kind: 'error'; code?: ErrorCode }
    | { kind: 'output'; mode: 'equals' | 'contains' | 'not-contains'; text: string }
  );

export interface TestCall extends Located {
  tool: string;
  args: CallArg[];
  /** Pretend the model has already seen untrusted content. */
  untrusted: boolean;
  /** Pretend a human approved the call. */
  approved: boolean;
  expects: Expectation[];
}

export interface TestCase extends Located {
  name: string;
  mocks: MockDef[];
  calls: TestCall[];
}

export interface Program {
  tools: Tool[];
  tests: TestCase[];
}
