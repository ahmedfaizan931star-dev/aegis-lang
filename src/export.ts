import type { Program, Tool } from './types.js';

export function toolDescription(tool: Tool): string {
  return tool.description?.value ?? `Run the ${tool.name} tool.`;
}

export function inputSchema(tool: Tool): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const i of tool.inputs) {
    const prop: Record<string, unknown> = { type: i.type === 'text' ? 'string' : i.type === 'number' ? 'number' : 'boolean' };
    if (i.description) prop.description = i.description;
    if (i.default !== undefined) prop.default = i.default;
    else required.push(i.name);
    properties[i.name] = prop;
  }
  const schema: Record<string, unknown> = { type: 'object', properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return schema;
}

function traits(tool: Tool) {
  const k = tool.action?.kind;
  const sideEffects = k === 'post' || k === 'write';
  return { sideEffects, idempotent: k === 'get' || k === 'read' || k === 'echo', openWorld: k === 'get' || k === 'post' };
}

const title = (name: string) => name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Model Context Protocol tool definitions (tools/list). */
export function toMCP(program: Program): object[] {
  return program.tools.map((t) => {
    const x = traits(t);
    return {
      name: t.name,
      title: title(t.name),
      description: toolDescription(t),
      inputSchema: inputSchema(t),
      annotations: {
        title: title(t.name),
        readOnlyHint: !x.sideEffects,
        destructiveHint: x.sideEffects,
        idempotentHint: x.idempotent,
        openWorldHint: x.openWorld,
      },
    };
  });
}

/** OpenAI function-calling format. */
export function toOpenAI(program: Program): object[] {
  return program.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: toolDescription(t), parameters: inputSchema(t) },
  }));
}

/** Anthropic tool-use format. */
export function toAnthropic(program: Program): object[] {
  return program.tools.map((t) => ({ name: t.name, description: toolDescription(t), input_schema: inputSchema(t) }));
}

export type ExportFormat = 'mcp' | 'openai' | 'anthropic' | 'schema';

export function exportAs(program: Program, format: ExportFormat): object {
  switch (format) {
    case 'mcp':
      return { tools: toMCP(program) };
    case 'openai':
      return toOpenAI(program);
    case 'anthropic':
      return toAnthropic(program);
    case 'schema':
      return Object.fromEntries(program.tools.map((t) => [t.name, inputSchema(t)]));
  }
}
