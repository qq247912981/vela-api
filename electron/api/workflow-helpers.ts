/**
 * 工作流辅助函数 —— 编排层共用的数据读取 / KB 检索 / 角色卡抽取 / 容错解析
 *
 * 这些逻辑与渲染进程各 Command 中的私有 helper 行为对齐，
 * 但直接运行在主进程，复用 Repository 与 node:fs。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { ProjectCoreRepository, type ProjectCoreData } from '../repositories/project-core-repository'
import { BlueprintRepository } from '../repositories/blueprint-repository'
import { CharacterRepository, type CharacterData } from '../repositories/character-repository'
import {
  readJsonFile,
  GLOBAL_CONFIG_PATH,
  MODELS_CONFIG_PATH,
  DEFAULT_GLOBAL_CONFIG,
  RECENT_PROJECTS_PATH,
} from '../utils/config-utils'
import type { GlobalConfig, ModelProfile } from '../../src/shared/ipc-channels'
import { DIR_PROMPTS } from '../../src/shared/project-paths'
import {
  searchKnowledge,
  searchKnowledgeFTS,
} from '../knowledge-base'
import { generate, stripThinkingTags, type GenerateParams } from './llm-service'

/** 编排过程的事件输出口（由 HTTP/SSE 层实现） */
export interface WorkflowSink {
  log: (msg: string) => void
  /** 正文增量（打字机） */
  text: (chunk: string) => void
  progress: (p: number) => void
}

// ---------------------------------------------------------------
// 项目 / 架构
// ---------------------------------------------------------------

/** 读取项目主台账；不存在则抛错 */
export function requireCore(): ProjectCoreData {
  const core = ProjectCoreRepository.get()
  if (!core) throw new WorkflowError('项目未初始化，请先创建或打开项目', 400)
  return core
}

// ---------------------------------------------------------------
// 当前项目路径（HTTP 无状态，KB 检索 / 定稿投影需要）
// ---------------------------------------------------------------

let activeProjectPath: string | null = null

/** 记录当前打开/创建的项目路径 */
export function setActiveProjectPath(projectPath: string): void {
  activeProjectPath = projectPath
}

/** 获取当前项目路径：优先内存值，否则回退到最近项目列表第一项 */
export function getActiveProjectPath(): string {
  if (activeProjectPath) return activeProjectPath
  const recent = readJsonFile<Array<{ path: string }>>(RECENT_PROJECTS_PATH, [])
  if (recent[0]?.path) {
    activeProjectPath = recent[0].path
    return activeProjectPath
  }
  throw new WorkflowError('当前没有打开的项目，请先创建或打开项目', 400)
}

/** 拼装架构四大件字符串（与 generate-draft.readArchitecture 一致） */
export function buildArchitectureString(core: ProjectCoreData): string {
  return [core.premise, core.charactersArch, core.worldbuilding, core.synopsis]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join('\n\n---\n\n')
}

/** 读取项目级自定义 prompts（.vela/prompts/*.md）并拼装 */
export async function readProjectPrompts(projectPath: string): Promise<string> {
  try {
    const dir = path.join(projectPath, DIR_PROMPTS)
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const parts: string[] = []
    for (const entry of entries) {
      if (entry.isDirectory() || !entry.name.endsWith('.md')) continue
      const content = (await fs.readFile(path.join(dir, entry.name), 'utf-8')).trim()
      if (content) parts.push(`【${entry.name.replace(/\.md$/, '')}】\n${content}`)
    }
    return parts.join('\n\n')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------
// 角色
// ---------------------------------------------------------------

/** 渲染角色动态状态文本 */
export function formatCharacterStates(): string {
  const chars = CharacterRepository.getAll()
  const states: string[] = []
  for (const card of chars) {
    const cs = card.currentState
    if (card.name && cs) {
      states.push(
        `- ${card.name}（${card.role}）：境界 ${cs.powerLevel || '未知'}｜位置 ${cs.location || '未知'}｜` +
          `身体 ${cs.physicalState || '正常'}｜心理 ${cs.mentalState || '正常'}｜` +
          `道具 ${cs.keyItems || '无'}｜第${cs.updatedAtChapter}章 ${cs.recentEvents || ''}`,
      )
    }
  }
  return states.join('\n')
}

/**
 * 从「角色动态图谱」文本抽取结构化角色卡并入库。
 * 复刻 architecture-workflow.createCharacterExtractSteps 的容错解析逻辑。
 */
export async function extractCharacterCards(
  characterDynamics: string,
  genre: string,
  sink: WorkflowSink,
  llmParams?: GenerateParams,
): Promise<number> {
  const { getPromptTemplate } = await import('../../src/services/prompt-templates')
  const { ArchitecturePromptBuilder } = await import('../../src/services/prompts/prompt-builder')

  const template = getPromptTemplate('extract_initial_characters')
  if (!template) throw new WorkflowError('缺少角色卡抽取模板 extract_initial_characters', 500)

  const prompt = new ArchitecturePromptBuilder(template)
    .withCharacterDynamics(characterDynamics)
    .withGenre(genre)
    .build()
  const systemRole = template.systemRole || '你是一个专业的角色设定分析师。'

  sink.log('正在从角色图谱抽取角色卡…')
  const { content } = await generate(
    [
      { role: 'system', content: systemRole },
      { role: 'user', content: prompt },
    ],
    { ...llmParams, responseFormat: { type: 'json_object' } },
  )

  const parsedCards = parseLooseCardArray(stripThinkingTags(content))
  if (parsedCards.length === 0) {
    throw new WorkflowError('角色卡抽取失败：未能解析出有效角色', 502)
  }

  const validRoles = ['protagonist', 'antagonist', 'supporting', 'minor']
  const cards: CharacterData[] = parsedCards
    .filter((c) => c && c.name)
    .map((c) => ({
      name: String(c.name),
      role: validRoles.includes(String(c.role)) ? String(c.role) : 'supporting',
      gender: str(c.gender),
      age: str(c.age),
      appearance: str(c.appearance),
      personality: str(c.personality),
      background: str(c.background),
      abilities: str(c.abilities),
      motivation: str(c.motivation),
      relationships: str(c.relationships),
      arc: str(c.arc),
      notes: str(c.notes),
    }))

  CharacterRepository.saveAll(cards)
  sink.log(`已写入 ${cards.length} 张角色卡`)
  return cards.length
}

// ---------------------------------------------------------------
// 章节时间线 / 上一章结尾
// ---------------------------------------------------------------

/**
 * 读取章节要点时间线（近 5 章完整，更早仅标题），≤3000 字。
 * 复刻 generate-draft.readChapterNotesTimeline。
 */
export function readChapterNotesTimeline(currentChapter: number): string {
  const FULL_WINDOW = 5
  const MAX_CHARS = 3000
  const lines: string[] = []

  for (let i = 1; i < currentChapter; i++) {
    const bp = BlueprintRepository.getByChapter(i)
    if (!bp) continue
    const header = `第${i}章 ${bp.title || ''}`
    const isRecent = i >= currentChapter - FULL_WINDOW
    if (isRecent && bp.notes?.trim()) lines.push(`${header}\n${bp.notes.trim()}`)
    else lines.push(header)
  }

  const result = lines.join('\n\n')
  return result.length > MAX_CHARS ? result.slice(-MAX_CHARS) : result
}

/** 读取上一章定稿结尾（末 1000 字符） */
export function readPreviousEnding(chapterNumber: number): string {
  const { DraftRepository } = require('../repositories/draft-repository')
  if (chapterNumber <= 1) return ''
  const meta = DraftRepository.getFinalizedByChapter(chapterNumber - 1)
  if (!meta) return ''
  const full = DraftRepository.getFull(meta.id)
  return full?.content.slice(-1000) ?? ''
}

// ---------------------------------------------------------------
// 知识库检索
// ---------------------------------------------------------------

function getEmbeddingConfig(): {
  protocol: 'openai' | 'gemini'
  model: { baseUrl: string; apiKey: string; modelName: string }
} | null {
  const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
  const targetId = config.defaultEmbeddingModelId || config.defaultModelId
  if (!targetId) return null
  const model = readJsonFile<ModelProfile[]>(MODELS_CONFIG_PATH, []).find((m) => m.id === targetId)
  if (!model) return null
  return {
    protocol: model.protocol as 'openai' | 'gemini',
    model: { baseUrl: model.baseUrl, apiKey: model.apiKey, modelName: model.modelName },
  }
}

/** 语义检索（无 embedding 配置时回退全文检索） */
export async function searchKB(
  query: string,
  projectPath: string,
  topK = 5,
): Promise<Array<{ fileName: string; score: number; text: string }>> {
  const emb = getEmbeddingConfig()
  if (emb) {
    return (await searchKnowledge(query, projectPath, emb.protocol, emb.model, topK)) as Array<{
      fileName: string
      score: number
      text: string
    }>
  }
  return (await searchKnowledgeFTS(query, projectPath, topK)) as Array<{
    fileName: string
    score: number
    text: string
  }>
}

/** 格式化 KB 检索结果为 prompt 文本 */
export function formatKBResults(
  results: Array<{ fileName: string; score: number; text: string }>,
): string {
  if (!results.length) return ''
  return results
    .map((r, i) => `[${i + 1}] 来源《${r.fileName}》相关度${(r.score * 100).toFixed(0)}%\n${r.text}`)
    .join('\n\n')
}

/** 将一段正文以指定文件名导入项目知识库（返回导入结果） */
export async function importTextToKB(
  text: string,
  fileName: string,
  projectPath: string,
): Promise<{ success: boolean; error?: string; chunkCount?: number }> {
  const emb = getEmbeddingConfig()
  const protocol = emb?.protocol ?? 'openai'
  const model = emb?.model ?? { baseUrl: '', apiKey: '', modelName: '' }
  const { importText } = await import('../knowledge-base')
  return (await importText(text, fileName, projectPath, protocol, model)) as {
    success: boolean
    error?: string
    chunkCount?: number
  }
}

// ---------------------------------------------------------------
// 容错解析
// ---------------------------------------------------------------

/** 宽松解析角色卡数组（兼容全角标点 / 单引号 / 无引号键 / ```json 包裹） */
function parseLooseCardArray(raw: string): Array<Record<string, unknown>> {
  let json = raw.replace(/```json?\n?/gi, '').replace(/```/g, '').trim()
  json = json
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/：/g, ':')
    .replace(/，/g, ',')
    .replace(/,(\s*[}\]])/g, '$1')

  const slice = (open: string, close: string) => {
    const s = json.indexOf(open)
    const e = json.lastIndexOf(close)
    return s >= 0 && e > s ? json.substring(s, e + 1) : null
  }

  const candidates = [
    slice('[', ']'),
    slice('{', '}'),
    json,
    json.replace(/'/g, '"'),
    json.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":'),
  ]

  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const data = JSON.parse(candidate)
      if (Array.isArray(data)) return data
      if (Array.isArray(data?.characters)) return data.characters
      for (const value of Object.values(data)) {
        if (Array.isArray(value) && value.length && typeof value[0] === 'object') return value
      }
    } catch {
      /* 尝试下一种 */
    }
  }
  return []
}

/** 容错 JSON 对象解析（剥离代码块，截取最外层括号） */
export function looseParseObject<T>(raw: string): T {
  let text = raw.replace(/```json?\n?/gi, '').replace(/```/g, '').trim()
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) text = text.substring(first, last + 1)
  return JSON.parse(text) as T
}

function str(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.join('\n')
  if (typeof v === 'object') return JSON.stringify(v, null, 2)
  return String(v)
}

// ---------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------

/** 带 HTTP 状态码的工作流错误 */
export class WorkflowError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message)
    this.name = 'WorkflowError'
  }
}
