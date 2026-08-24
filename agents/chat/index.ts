/**
 * Chat handler -- EdgeOne Makers
 *
 * File path agents/chat/index.ts maps to POST /chat.
 * It streams OpenAI-compatible chat/completions responses, executes EdgeOne
 * sandbox tools when requested, and stores conversation history.
 */

import { getModelConfig } from '../_model';
import { createLogger } from '../_logger';
import { ChatSession } from '../_session';
import { buildTools, stringifyResult } from '../_tools';
import { extractImagesFromToolResult } from './_images';

const logger = createLogger('chat');
const encoder = new TextEncoder();
const MAX_TOOL_ROUNDS = 3;

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
};

const SYSTEM_PROMPT = [
  'You are an EdgeOne Makers Node.js starter example: an out-of-the-box Agent template that helps developers quickly run through and validate platform capabilities. This template shows how to call an OpenAI-compatible Chat Completions API directly with raw `fetch`, no agent SDK.',
  'When introducing yourself, clearly say that you are a demo Agent built with raw Node.js (no SDK, just OpenAI-compatible fetch + function calling) on EdgeOne Makers, designed to showcase tool calling, streaming responses, and session memory for developers.',
  'The runtime exposes a set of platform tools via function calling — their exact',
  'names, descriptions, and parameter schemas are provided alongside this message.',
  'Read each tool\'s schema before calling it; do not assume names or parameters.',
  '',
  'Tool families you may see (the runtime may expose multiple fine-grained tools per family,',
  'e.g. `browser_fetch`, `files_read`, `commands_run`, `code_interpreter_python`):',
  '- commands / shell: execute shell commands in the sandbox (e.g. date, ls, uname, curl).',
  '- files / fs: read, write, list, check, remove, or create files and directories.',
  '- code_interpreter / interpreter: run code in an isolated interpreter (python, javascript, bash, ...).',
  '- browser: fetch web pages, take screenshots, click, type, evaluate scripts.',
  '',
  'Tool-use rules:',
  '1. Use a tool only when it is necessary to answer the user concretely.',
  '2. Call tools one at a time and wait for each result before deciding the next step.',
  '3. Never invent, simulate, or paraphrase tool results. If a tool result is unavailable, say so.',
  '4. If a tool call fails, do not repeat it blindly and do not switch to unrelated operations.',
  '   Briefly explain the failure, adjust the parameters only if the fix is clear, otherwise ask the user for guidance.',
  '5. Do not perform destructive file or shell operations unless the user explicitly asks for them.',
  '6. If the task can be answered without tools, answer directly and keep the response concise.',
  'Only call tools that appear in the function-calling schema provided to you.',
].join('\n');

type ChatMessage = Record<string, any>;
type ToolRegistry = ReturnType<typeof buildTools>;
type TraceSpan = {
  setAttributes?: (attributes: Record<string, unknown>) => void;
  end?: () => void;
};

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface ToolCallAcc {
  id: string;
  name: string;
  arguments: string;
}

interface StreamChunk {
  contentDelta?: string;
  toolCalls?: ToolCallAcc[];
  usage?: Usage;
}

function sseFrame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sendEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: string,
  data: Record<string, unknown>,
) {
  controller.enqueue(encoder.encode(sseFrame(event, data)));
}

function sseResponse(event: string, data: Record<string, unknown>, includeDone = false): Response {
  const body = sseFrame(event, data) + (includeDone ? sseFrame('done', {}) : '');
  return new Response(encoder.encode(body), { status: 200, headers: SSE_HEADERS });
}

function redactBase64Image(text: string): string {
  return text.replace(/"base64Image"\s*:\s*"[A-Za-z0-9+/=]{100,}"/g, '"base64Image":"[REDACTED image data]"');
}

function safeJsonPreview(value: unknown, maxLength = 1200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const redacted = redactBase64Image(text);
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...<truncated>` : redacted;
}

function buildPayload(model: string, messages: ChatMessage[], toolRegistry: ToolRegistry): ChatMessage {
  const payload: ChatMessage = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (toolRegistry.hasTools()) {
    payload.tools = toolRegistry.tools;
    payload.tool_choice = 'auto';
  }

  return payload;
}

function assistantToolMessage(content: string, toolCalls: ToolCallAcc[]): ChatMessage {
  return {
    role: 'assistant',
    content,
    tool_calls: toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    })),
  };
}

async function loadHistoryAndSaveUser(context: any, session: ChatSession, cid: string, message: string) {
  const span: TraceSpan | undefined = context.tracer?.startSpan('session.load_and_save', {
    'session.conversation_id': cid,
  });

  try {
    const [history] = await Promise.all([
      session.getHistory(cid),
      session.saveUserMessage(cid, message),
    ]);
    span?.setAttributes?.({ 'session.history_count': history.length });
    return history;
  } finally {
    span?.end?.();
  }
}

function createToolRegistry(context: any): ToolRegistry {
  const span: TraceSpan | undefined = context.tracer?.startSpan('tools.build');

  try {
    const registry = buildTools(context, logger);
    span?.setAttributes?.({
      'tools.count': registry.tools.length,
      'tools.has_tools': registry.hasTools(),
    });
    return registry;
  } finally {
    span?.end?.();
  }
}

async function* parseStreamWithTools(response: Response, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  const toolCalls = new Map<number, ToolCallAcc>();
  let buffer = '';
  let finishReason = '';
  let usage: Usage | undefined;

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let streamDone = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === 'data: [DONE]') {
          streamDone = true;
          break;
        }
        if (!trimmed.startsWith('data: ')) continue;

        const chunk = parseSseJson(trimmed.slice(6));
        if (chunk?.usage) usage = chunk.usage;

        const choice = chunk?.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta ?? {};
        if (delta.content) {
          yield { contentDelta: delta.content };
        }
        collectToolCallDeltas(toolCalls, delta.tool_calls);
      }

      if (streamDone) break;
    }
  } finally {
    reader.releaseLock();
  }

  if (toolCalls.size > 0 && finishReason === 'tool_calls') {
    yield { toolCalls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, tc]) => tc), usage };
  } else if (usage) {
    yield { usage };
  }
}

function parseSseJson(json: string): any | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function collectToolCallDeltas(toolCalls: Map<number, ToolCallAcc>, deltas: any[] | undefined) {
  if (!deltas) return;

  for (const delta of deltas) {
    const index = delta?.index ?? 0;
    const toolCall = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };

    if (delta?.id) toolCall.id = delta.id;
    if (delta?.function?.name) toolCall.name = delta.function.name;
    if (delta?.function?.arguments) toolCall.arguments += delta.function.arguments;

    toolCalls.set(index, toolCall);
  }
}

async function streamModelRound(params: {
  context: any;
  url: string;
  model: string;
  apiKey: string;
  payload: ChatMessage;
  round: number;
  signal?: AbortSignal;
  controller: ReadableStreamDefaultController<Uint8Array>;
  onTextDelta: (delta: string) => void;
}): Promise<{ content: string; toolCalls: ToolCallAcc[] | null; stopped: boolean; failed: boolean }> {
  const { context, url, model, apiKey, payload, round, signal, controller, onTextDelta } = params;
  const span: TraceSpan | undefined = context.tracer?.startSpan(`llm.request.round_${round}`, {
    'openinference.span.kind': 'LLM',
    'llm.model_name': model,
    'llm.provider': 'openai',
    'llm.request.type': 'chat',
    'llm.request.message_count': payload.messages.length,
    'llm.request.tools_included': 'tools' in payload,
    'llm.request.round': round,
  });

  let content = '';
  let toolCalls: ToolCallAcc[] | null = null;
  let stopped = false;
  let failed = false;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      logger.error(`[handler] LLM API error: ${response.status} ${errorBody}`);
      span?.setAttributes?.({ 'http.status_code': response.status, 'llm.error': true });

      // Try to parse upstream body as JSON so TracePanel can render it structured
      let detail: unknown = errorBody;
      try {
        detail = errorBody ? JSON.parse(errorBody) : '';
      } catch {
        // keep raw string
      }

      sendEvent(controller, 'error', {
        message: `LLM API error: ${response.status}`,
        status: response.status,
        statusText: response.statusText,
        round,
        model,
        detail,
      });
      return { content, toolCalls, stopped, failed: true };
    }

    span?.setAttributes?.({ 'http.status_code': 200 });

    for await (const chunk of parseStreamWithTools(response, signal)) {
      if (signal?.aborted) {
        stopped = true;
        break;
      }

      if (chunk.contentDelta) {
        content += chunk.contentDelta;
        onTextDelta(chunk.contentDelta);
      }
      if (chunk.toolCalls) {
        toolCalls = chunk.toolCalls;
      }
      if (chunk.usage) {
        span?.setAttributes?.({
          'llm.token_count.prompt': chunk.usage.prompt_tokens,
          'llm.token_count.completion': chunk.usage.completion_tokens,
          'llm.token_count.total': chunk.usage.total_tokens,
        });
      }
    }
  } finally {
    span?.setAttributes?.({
      'llm.response.content_length': content.length,
      'llm.response.has_tool_calls': !!toolCalls,
    });
    span?.end?.();
  }

  return { content, toolCalls, stopped, failed };
}

function emitToolCallEvents(
  controller: ReadableStreamDefaultController<Uint8Array>,
  toolCalls: ToolCallAcc[],
) {
  for (const tc of toolCalls) {
    sendEvent(controller, 'tool_called', { tool: tc.name });
    sendEvent(controller, 'tool_debug', {
      phase: 'call',
      tool: tc.name,
      id: tc.id,
      argumentsPreview: safeJsonPreview(tc.arguments),
    });
  }
}

async function executeToolCalls(params: {
  context: any;
  toolRegistry: ToolRegistry;
  toolCalls: ToolCallAcc[];
  controller: ReadableStreamDefaultController<Uint8Array>;
}): Promise<string[]> {
  const { context, toolRegistry, toolCalls, controller } = params;
  const spans = toolCalls.map(tc => context.tracer?.startSpan(`tool.${tc.name}`, {
    'tool.name': tc.name,
    'tool.call_id': tc.id,
    'tool.arguments_length': tc.arguments.length,
  }));

  try {
    return await Promise.all(toolCalls.map(async (tc, index) => {
      const startedAt = Date.now();

      // Pull the raw handler value so we can sniff for base64 images BEFORE
      // it gets serialized into the next-round `tool` message. Anything we
      // find is replaced with a `[image:<id>]` placeholder; the redacted
      // structure is what flows back into the model context.
      const raw = await toolRegistry.executeRaw(tc.name, tc.arguments);
      const { images, redactedResult, truncated } = extractImagesFromToolResult(raw);
      const result = stringifyResult(redactedResult);
      const durationMs = Date.now() - startedAt;
      const resultPreview = safeJsonPreview(result, 2000);
      const isError = result.includes('"error"');

      // SSE ordering contract: image events fire AFTER `tool_debug{phase:'call'}`
      // (already emitted by emitToolCallEvents) and BEFORE
      // `tool_debug{phase:'result'}`. The frontend uses this to attach images
      // to the in-flight tool row.
      for (const img of images) {
        sendEvent(controller, 'image', {
          imageId:    img.imageId,
          base64:     img.base64,
          mimeType:   img.mimeType,
          size:       img.size,
          toolName:   tc.name,
          toolCallId: tc.id,
        });
      }

      spans[index]?.setAttributes?.({
        'tool.result_length': result.length,
        'tool.images_extracted': images.length,
        'tool.images_truncated': truncated,
      });
      sendEvent(controller, 'tool_debug', {
        phase: 'result',
        tool: tc.name,
        id: tc.id,
        resultPreview,
        resultLength: result.length,
        durationMs,
        imageCount: images.length,
        ...(truncated ? { imagesTruncated: true } : {}),
        ...(isError ? { error: resultPreview } : {}),
      });

      return result;
    }));
  } finally {
    for (const span of spans) {
      span?.end?.();
    }
  }
}

function appendToolResults(messages: ChatMessage[], toolCalls: ToolCallAcc[], results: string[]) {
  for (let i = 0; i < toolCalls.length; i++) {
    logger.log(`[tool] ${toolCalls[i].name}: ${results[i].slice(0, 200)}`);
    messages.push({
      role: 'tool',
      tool_call_id: toolCalls[i].id,
      content: results[i],
    });
  }
}

export async function onRequest(context: any) {
  const cid: string = context.conversation_id ?? '';
  const rawMessage = context.request.body?.message;

  logger.log(`[handler] conversation_id: ${cid}`);
  context.tracer?.setAttributes({
    'agent.scenario': 'node_starter_chat',
    'chat.conversation_id': cid,
    'chat.has_message': !!rawMessage,
  });

  if (typeof rawMessage !== 'string' || rawMessage.trim().length === 0) {
    return sseResponse('error', { message: 'message is required' }, true);
  }

  const message = rawMessage.slice(0, 10000);
  const signal: AbortSignal | undefined = context.request.signal;
  const session = new ChatSession(context.store);
  const history = await loadHistoryAndSaveUser(context, session, cid, message);
  const toolRegistry = createToolRegistry(context);
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: message },
  ];

  const modelConfig = getModelConfig(context.env);
  const url = `${modelConfig.baseUrl.replace(/\/$/, '')}/chat/completions`;
  logger.log(`[handler] streaming from: ${url}, model: ${modelConfig.model}, tools: ${toolRegistry.hasTools()}`);

  let assistantContent = '';
  let stopped = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (!modelConfig.apiKey || !modelConfig.baseUrl) {
        sendEvent(controller, 'error', {
          message: 'AI Gateway not configured. Set AI_GATEWAY_API_KEY and AI_GATEWAY_BASE_URL.',
        });
        controller.close();
        return;
      }

      try {
        for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
          if (signal?.aborted) {
            stopped = true;
            break;
          }

          const payload = buildPayload(modelConfig.model, messages, toolRegistry);
          logger.log(`[handler] round ${round}, messages: ${messages.length}`);

          const result = await streamModelRound({
            context,
            url,
            model: modelConfig.model,
            apiKey: modelConfig.apiKey,
            payload,
            round,
            signal,
            controller,
            onTextDelta(delta) {
              assistantContent += delta;
              sendEvent(controller, 'text_delta', { delta });
            },
          });

          stopped = result.stopped;
          if (stopped || result.failed) break;
          if (!result.toolCalls?.length) break;

          messages.push(assistantToolMessage(result.content, result.toolCalls));
          emitToolCallEvents(controller, result.toolCalls);

          const toolResults = await executeToolCalls({
            context,
            toolRegistry,
            toolCalls: result.toolCalls,
            controller,
          });
          appendToolResults(messages, result.toolCalls, toolResults);
        }
      } catch (e: unknown) {
        const error = e as Error;
        if (error.name === 'AbortError' || signal?.aborted) {
          stopped = true;
          logger.log('[stream] aborted by user');
        } else {
          logger.error('[stream] error:', error.message, error.stack);
          context.tracer?.setAttributes({
            'error.type': error.name || 'Error',
            'error.message': error.message || String(e),
          });
          sendEvent(controller, 'error', {
            message: String(error.message ?? e),
            name: error.name || 'Error',
            stack: error.stack,
            cause: (error as { cause?: unknown }).cause,
          });
        }
      } finally {
        if (assistantContent) {
          const span: TraceSpan | undefined = context.tracer?.startSpan('session.save_assistant_message', {
            'session.conversation_id': cid,
            'session.content_length': assistantContent.length,
          });
          try {
            await session.saveAssistantMessage(cid, assistantContent);
          } finally {
            span?.end?.();
          }
        }

        sendEvent(controller, 'done', { stopped });
        controller.close();
      }
    },
    cancel() {
      logger.log('[stream] client disconnected');
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
