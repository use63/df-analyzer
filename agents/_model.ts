/**
 * Private module (filename starts with _) -- not mapped as a public route.
 * Used to configure the LLM model from EdgeOne runtime context.env.
 *
 * Imported by chat/index.ts via `import { getModelConfig } from '../_model'`
 *
 * Configure via environment variables:
 *   AI_GATEWAY_API_KEY / AI_GATEWAY_BASE_URL / AI_GATEWAY_MODEL
 */

type RuntimeEnv = Record<string, string | undefined>;

export interface ModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function getModelConfig(env: RuntimeEnv): ModelConfig {
  return {
    apiKey: env.AI_GATEWAY_API_KEY || '',
    baseUrl: env.AI_GATEWAY_BASE_URL || '',
    model: env.AI_GATEWAY_MODEL || '@makers/deepseek-v4-flash',
  };
}
