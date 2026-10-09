/**
 * LLM 调用服务 —— API 侧统一的模型访问入口
 *
 * 复用主进程已有的 LLMFactory 与 ~/.vela 配置，提供：
 *   - 模型配置读取（默认模型 / 指定模型）
 *   - 非流式 generate
 *   - 流式 generateStream（供编排层逐块推送 SSE）
 */
import {
  readJsonFile,
  GLOBAL_CONFIG_PATH,
  MODELS_CONFIG_PATH,
  DEFAULT_GLOBAL_CONFIG,
} from '../utils/config-utils'
import type { GlobalConfig, ModelProfile } from '../../src/shared/ipc-channels'
import { LLMFactory } from '../llm/llm-factory'

/** 一次生成请求的可选项 */
export interface GenerateParams {
  /** 显式指定模型 ID；缺省使用全局默认模型 */
  modelId?: string
  temperature?: number
  maxTokens?: number
  responseFormat?: { type: string }
  thinking?: boolean
}

/** 流式回调 */
export interface StreamHandlers {
  onChunk?: (chunk: string) => void
  onDone?: (
    fullText: string,
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number },
  ) => void
  onError?: (error: string) => void
}

function loadGlobalConfig(): GlobalConfig {
  return readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
}

function loadModels(): ModelProfile[] {
  return readJsonFile<ModelProfile[]>(MODELS_CONFIG_PATH, [])
}

/** 列出全部已配置模型 */
export function listModels(): ModelProfile[] {
  return loadModels()
}

/** 读取全局默认模型 ID */
export function getDefaultModelId(): string | null {
  return loadGlobalConfig().defaultModelId ?? null
}

/**
 * 解析 ModelProfile：
 * 优先用传入 modelId，否则用全局默认模型。
 * 找不到时抛出明确错误，便于编排层转成 4xx。
 */
export function resolveModel(modelId?: string): ModelProfile {
  const targetId = modelId ?? loadGlobalConfig().defaultModelId ?? undefined
  if (!targetId) {
    throw new LLMConfigError('未配置默认模型，请在 Vela 设置中添加模型或在请求中指定 modelId')
  }
  const model = loadModels().find((m) => m.id === targetId)
  if (!model) {
    throw new LLMConfigError(`未找到模型配置: ${targetId}`)
  }
  return model
}

/** 非流式生成，返回纯文本（已剥离 think 标签由调用方决定） */
export async function generate(
  messages: Array<{ role: string; content: string }>,
  params: GenerateParams = {},
): Promise<{ content: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
  const model = resolveModel(params.modelId)
  const provider = LLMFactory.getProvider(model)
  const res = await provider.generate(model, messages, {
    temperature: params.temperature ?? model.temperature,
    maxTokens: params.maxTokens ?? model.maxTokens,
    responseFormat: params.responseFormat,
    thinking: params.thinking,
  })
  if (!res.success) {
    throw new Error(res.error || 'LLM 生成失败')
  }
  return { content: res.content, usage: res.usage }
}

/** 流式生成：逐块回调，结束时回调完整文本 */
export async function generateStream(
  messages: Array<{ role: string; content: string }>,
  handlers: StreamHandlers,
  params: GenerateParams = {},
  signal?: AbortSignal,
): Promise<string> {
  const model = resolveModel(params.modelId)
  const provider = LLMFactory.getProvider(model)

  return await new Promise<string>((resolve, reject) => {
    let settled = false
    provider
      .generateStream(
        model,
        messages,
        {
          temperature: params.temperature ?? model.temperature,
          maxTokens:params.maxTokens ?? model.maxTokens,
          responseFormat: params.responseFormat,
          thinking: params.thinking,
          signal: signal ?? new AbortController().signal,
          onChunk: (chunk) => handlers.onChunk?.(chunk),
          onDone: (fullText, usage) => {
            if (settled) return
            settled = true
            handlers.onDone?.(fullText, usage)
            resolve(fullText)
          },
          onError: (error) => {
            if (settled) return
            settled = true
            handlers.onError?.(error)
            reject(new Error(error))
          },
        },
      )
      .catch((err) => {
        if (settled) return
        settled = true
        reject(err instanceof Error ? err : new Error(String(err)))
      })
  })
}

/** 配置类错误（编排层可映射为 400/503） */
export class LLMConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LLMConfigError'
  }
}

/** 剥离 think 标签（与 base-command 行为一致） */
export function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
}
