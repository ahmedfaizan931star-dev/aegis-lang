import type { Action, Tool } from './types.js';

/** Does this action talk to the network? */
export const isNet = (a: Action): boolean => a.kind === 'get' || a.kind === 'post';
/** Does this action change something outside (POST or file write)? */
export const isSide = (a: Action): boolean => a.kind === 'post' || a.kind === 'write';
/** Does this action bring in content from outside (web or files)? */
export const isUntrusted = (a: Action): boolean => a.kind === 'get' || a.kind === 'post' || a.kind === 'read';

/**
 * What a tool can do, looking at EVERY step. Reports, approval defaults, caching and
 * exports all use this, so one safe-looking step can never hide a risky one.
 */
export function toolTraits(tool: Tool) {
  const actions = tool.steps.map((s) => s.action);
  return {
    net: actions.some(isNet),
    side: actions.some(isSide),
    post: actions.some((a) => a.kind === 'post'),
    untrusted: actions.some(isUntrusted),
    /** Every step only reads (get, read, echo), so repeating the call is harmless. */
    readOnly: actions.every((a) => a.kind === 'get' || a.kind === 'read' || a.kind === 'echo'),
    steps: actions.length,
  };
}
