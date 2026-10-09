/**
 * 目录工作流编排 —— 章节蓝图（细纲）分批生成
 *
 * 复用 DirectoryPromptBuilder、prompt 模板与 directory-workflow 的
 * parseTextBlueprints（平台无关），行为与渲染进程 directory.command 对齐。
 */
import {
  getPromptTemplate,
} from '../../src/services/prompt-templates'
import { DirectoryPromptBuilder } from '../../src/services/prompts/prompt-builder'
import { generate } from './llm-service'
import { resolveModel } from './llm-service'
import {
  parseTextBlueprints,
  type ChapterBlueprint,
} from '../../src/services/workflows/directory-workflow'
import { BlueprintRepository } from '../repositories/blueprint-repository'
import {
  buildArchitectureString,
  requireCore,
  WorkflowError,
  type WorkflowSink,
} from './workflow-helpers'
import type { GenerateParams } from './llm-service'

export interface DirectoryOptions {
  mode: 'full' | 'append'
  startChapter?: number
  count?: number
  pacingGuidance?: string
}

/** 生成章节蓝图，返回本次新生成的蓝图数组 */
export async function generateDirectory(
  sink: WorkflowSink,
  options: DirectoryOptions,
  llmParams?: GenerateParams,
): Promise<ChapterBlueprint[]> {
  const core = requireCore()
  const architecture = buildArchitectureString(core)
  if (!architecture.trim()) {
    throw new WorkflowError('架构内容缺失，请先生成世界观四大件', 400)
  }

  const existing = BlueprintRepository.getAll().sort((a, b) => a.chapterNumber - b.chapterNumber)

  const totalChapters = core.totalChapters
  let startChapter = 1
  let endChapter = totalChapters

  if (options.mode === 'append') {
    startChapter = options.startChapter ?? (existing.length ? Math.max(...existing.map((b) => b.chapterNumber)) + 1 : 1)
    if (options.count && options.count > 0) endChapter = startChapter + options.count - 1
  } else if (options.count && options.count > 0) {
    endChapter = Math.min(options.count, totalChapters)
  }

  if (!Number.isSafeInteger(startChapter) || !Number.isSafeInteger(endChapter) || startChapter < 1 || endChapter < startChapter) {
    throw new WorkflowError('章节范围不合法', 400)
  }

  sink.log(`开始生成第 ${startChapter}–${endChapter} 章蓝图`)

  // 根据默认模型 maxTokens 动态计算批次大小（与渲染进程一致）
  const batchSize = computeBatchSize(llmParams?.modelId)

  const newBlueprints: ChapterBlueprint[] = []
  let cursor = startChapter

  while (cursor <= endChapter) {
    const batchEnd = Math.min(cursor + batchSize - 1, endChapter)
    sink.log(`生成批次：第 ${cursor}–${batchEnd} 章`)

    let prompt: string
    if (cursor === 1 && options.mode === 'full') {
      const template = getPromptTemplate('chapter_blueprint')
      if (!template) throw new WorkflowError('缺少模板 chapter_blueprint', 500)
      prompt = new DirectoryPromptBuilder(template)
        .withNovelArchitecture(architecture)
        .withNumberOfChapters(batchEnd)
        .withGlobalGuidance(core.globalGuidance)
        .withGenre(core.genre)
        .withPacingGuidance(options.pacingGuidance || '')
        .build()
    } else {
      const template = getPromptTemplate('chapter_blueprint_chunk')
      if (!template) throw new WorkflowError('缺少模板 chapter_blueprint_chunk', 500)
      const prevAll = [...existing, ...newBlueprints]
      const chapterList = prevAll
        .slice(-100)
        .map((c) => `第${c.chapterNumber}章 ${c.title}：${c.keyEvents}`)
        .join('\n')
      prompt = new DirectoryPromptBuilder(template)
        .withNovelArchitecture(architecture)
        .withChapterList(chapterList || '（暂无前置章节）')
        .withNumberOfChapters(totalChapters)
        .withN(cursor)
        .withM(batchEnd)
        .withGlobalGuidance(core.globalGuidance)
        .withGenre(core.genre)
        .withPacingGuidance(options.pacingGuidance || '')
        .build()
    }

    const systemRole = getPromptTemplate('chapter_blueprint')?.systemRole || ''
    const { content } = await generate(
      [
        { role: 'system', content: systemRole },
        { role: 'user', content: prompt },
      ],
      { ...llmParams, responseFormat: { type: 'json_object' } },
    )

    const parsed = parseTextBlueprints(content, cursor, batchEnd)
    if (!parsed.length) {
      throw new WorkflowError(`第 ${cursor}–${batchEnd} 章蓝图返回为空`, 502)
    }
    if (parsed.some((bp, i) => bp.chapterNumber !== cursor + i)) {
      throw new WorkflowError(`第 ${cursor}–${batchEnd} 章蓝图存在缺章，请重试`, 502)
    }

    // 每批入库
    BlueprintRepository.upsertMany(parsed)
    newBlueprints.push(...parsed)
    sink.log(`批次完成，已保存 ${parsed.length} 章蓝图`)

    const actualMax = Math.max(...parsed.map((p) => p.chapterNumber))
    cursor = actualMax + 1
  }

  sink.log(`目录生成完成，共 ${newBlueprints.length} 章`)
  return newBlueprints
}

/** 依据默认模型 maxTokens 估算每批章节数（输出预算 60% / 每章约 600 token） */
function computeBatchSize(modelId?: string): number {
  try {
    const model = resolveModel(modelId)
    const outputBudget = Math.floor((model.maxTokens || 4096) * 0.6)
    return Math.min(20, Math.max(1, Math.floor(outputBudget / 600)))
  } catch {
    return 10
  }
}
