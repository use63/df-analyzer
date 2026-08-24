/**
 * Tools module -- private module (starts with _), not mapped as a route.
 *
 * Extracts EdgeOne platform tools from context.tools and passes them through
 * directly to the chat/completions API.
 *
 * EdgeOne provides sandbox tools: commands, files, code_interpreter, browser.
 */

type ToolSchema = Record<string, unknown>;

/**
 * Registry holding tool schemas and handlers extracted from context.tools.
 */
export class ToolRegistry {
  tools: ToolSchema[] = [];
  private handlers: Map<string, (args: Record<string, unknown>) => unknown> = new Map();

  hasTools(): boolean {
    return this.tools.length > 0;
  }

  register(name: string, schema: ToolSchema, handler: (args: Record<string, unknown>) => unknown): void {
    if (this.handlers.has(name)) return;
    this.tools.push(schema);
    this.handlers.set(name, handler);
  }

  async execute(name: string, arguments_: string): Promise<string> {
    const raw = await this.executeRaw(name, arguments_);
    return stringifyResult(raw);
  }

  /**
   * Like `execute`, but returns the raw handler value (or a structured error
   * object) without stringification. The chat handler uses this to inspect
   * the result for embedded base64 images BEFORE serialization, so they can
   * be lifted out of the tool message and emitted as separate SSE events.
   */
  async executeRaw(name: string, arguments_: string): Promise<unknown> {
    const handler = this.handlers.get(name);
    if (!handler) {
      return { error: `Unknown tool: ${name}` };
    }

    let args: Record<string, unknown> = {};
    try {
      args = arguments_ ? JSON.parse(arguments_) : {};
    } catch {
      args = {};
    }

    try {
      let result = handler(args);
      if (result && typeof result === 'object' && 'then' in result) {
        result = await (result as Promise<unknown>);
      }
      return result;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { error: `Tool execution failed: ${message}` };
    }
  }
}

/**
 * Build a ToolRegistry from EdgeOne's context.tools.
 */
export function buildTools(context: any, logger?: any): ToolRegistry {
  const registry = new ToolRegistry();

  const runtimeTools = context.tools;
  if (logger) {
    logger.log(`[tools] context.tools = ${runtimeTools}`);
    logger.log(`[tools] context.tools type = ${typeof runtimeTools}`);
  }

  if (typeof runtimeTools.all !== 'function') {
    if (logger) {
      logger.log(`[tools] no EdgeOne platform tools available`);
    }
    return registry;
  }

  const rawTools = runtimeTools.all();
  if (logger) {
    logger.log(`[tools] raw_tools count: ${rawTools?.length ?? 0}`);
  }

  for (const item of rawTools || []) {
    const name: string | undefined = item?.name ?? item?.function?.name;
    const handler = item?.execute ?? item?.handler ?? item?.invoke;

    if (logger) {
      logger.log(`[tools] inspecting: name=${name}, callable=${typeof handler === 'function'}`);
    }

    if (!name || typeof handler !== 'function') {
      if (logger) {
        logger.log(`[tools] skipped: ${name || '<unknown>'}`);
      }
      continue;
    }

    // Build a clean OpenAI function-tool schema. Do NOT spread the raw item —
    // EdgeOne tool items carry extra fields (execute, inputSchema, type='tool', etc.)
    // that strict upstream gateways may reject, causing the whole `tools` array to be
    // silently ignored and the model to answer without ever calling a tool.
    const description: string =
      item?.function?.description ?? item?.description ?? '';
    const parameters: Record<string, unknown> =
      item?.function?.parameters ??
      item?.parameters ??
      item?.inputSchema ??
      item?.input_schema ??
      { type: 'object', properties: {} };

    registry.register(
      name,
      {
        type: 'function',
        function: {
          name,
          description,
          parameters,
        },
      },
      handler,
    );
    if (logger) {
      logger.log(`[tools] registered: ${name}`);
    }
  }

  return registry;
}

export function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
