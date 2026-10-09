/**
 * 架构工作流编排 —— 全局配置生成 + 故事前提 / 角色图谱 / 世界观 / 情节大纲
 *
 * 复用 prompt 模板、ArchitecturePromptBuilder、一致性角色卡抽取，
 * 行为与渲染进程 architecture.command 对齐。
 */
import { ProjectCoreRepository } from '../repositories/project-core-repository'
import {
  getPromptTemplate,
} from '../../src/services/prompt-templates'
import { ArchitecturePromptBuilder } from '../../src/services/prompts/prompt-builder'
import { generate, generateStream, stripThinkingTags, type GenerateParams } from './llm-service'
import {
  extractCharacterCards,
  requireCore,
  WorkflowError,
  type WorkflowSink,
} from './workflow-helpers'
import {
  getPlotStructureGuide,
  getNarrativePOVLabel,
} from '../../src/services/workflows/architecture-workflow'

/** 生成全局配置（由一句话创意 → NovelConfig） */
export async function generateGlobalConfig(
  idea: string,
  sink: WorkflowSink,
  llmParams?: GenerateParams,
): Promise<Record<string, unknown>> {
  if (!idea?.trim()) throw new WorkflowError('缺少创意 idea', 400)
  const core = requireCore()

  sink.log('正在根据你的创意生成全局写作配置…')
  const template = getPromptTemplate('generate_global_config')
  if (!template) throw new WorkflowError('缺少模板 generate_global_config', 500)

  const prompt = new ArchitecturePromptBuilder(template)
    .withUserIdea(idea)
    .withNumberOfChapters(core.totalChapters)
    .withWordNumber(core.wordsPerChapter)
    .build()

  const { content } = await generate(
    [
      { role: 'system', content: template.systemRole || '' },
      { role: 'user', content: prompt },
    ],
    { ...llmParams, responseFormat: { type: 'json_object' }, thinking: true },
  )

  const parsed = JSON.parse(stripThinkingTags(content).replace(/```json?\n?/g, '').replace(/```/g, '')) as Record<string, unknown>

  // 映射并写回核心字段
  const asInt = (v: unknown, fallback: number) => {
    const n = parseInt(String(v), 10)
    return Number.isFinite(n) ? n : fallback
  }
  ProjectCoreRepository.update({
    genre: str(parsed.genre) || core.genre,
    subGenre: str(parsed.subGenre),
    targetAudience: str(parsed.targetAudience) || core.targetAudience,
    totalChapters: asInt(parsed.totalChapters, core.totalChapters),
    wordsPerChapter: asInt(parsed.wordsPerChapter, core.wordsPerChapter),
    plotStructure: str(parsed.plotStructure) || core.plotStructure,
    narrativePov: str(parsed.narrativePOV) || core.narrativePov,
    goldenFinger: str(parsed.goldenFinger),
    globalGuidance: str(parsed.globalGuidance),
    writingStyle: str(parsed.writingStyle),
    referenceWorks: str(parsed.referenceWorks),
  })

  sink.log('全局配置已生成并保存')
  return parsed
}

/** 生成故事前提 */
export async function generatePremise(
  sink: WorkflowSink,
  guidance?: string,
  llmParams?: GenerateParams,
): Promise<string> {
  const core = requireCore()
  sink.log('正在生成故事前提…')
  const template = getPromptTemplate('premise')
  if (!template) throw new WorkflowError('缺少模板 premise', 500)

  const builder = new ArchitecturePromptBuilder(template)
    .withGenre(core.genre)
    .withSubGenre(core.subGenre || core.genre)
    .withTopic(core.synopsis || '（待生成）')
    .withTargetAudience(core.targetAudience)
    .withNumberOfChapters(core.totalChapters)
    .withWordNumber(core.wordsPerChapter)
    .withCoreSetting(core.worldbuilding || '（待生成）')
    .withGoldenFinger(core.goldenFinger || '（待生成）')
    .withProtagonistProfile('（待生成）')
    .withGlobalGuidance(core.globalGuidance || '（待生成）')
    .withStepGuidance(guidance || '')

  const result = await singleGenerate(builder, template.systemRole, sink, llmParams)
  ProjectCoreRepository.update({ premise: `# 故事前提\n\n${result}\n` })
  sink.log('故事前提已保存')
  return result
}

/** 生成角色动态图谱 + 抽取角色卡 */
export async function generateCharacters(
  sink: WorkflowSink,
  guidance?: string,
  llmParams?: GenerateParams,
): Promise<string> {
  const core = requireCore()
  if (!core.premise || core.premise.length < 50 || core.premise.includes('待生成')) {
    throw new WorkflowError('请先生成故事前提', 400)
  }
  sink.log('正在生成角色动态图谱…')
  const template = getPromptTemplate('character_dynamics')
  if (!template) throw new WorkflowError('缺少模板 character_dynamics', 500)

  const builder = new ArchitecturePromptBuilder(template)
    .withCoreSeed(core.premise)
    .withGenre(core.genre)
    .withProtagonistProfile('（待生成）')
    .withGoldenFinger(core.goldenFinger || '（待生成）')
    .withWorldBuilding(core.worldbuilding || '（待生成）')
    .withNumberOfChapters(core.totalChapters)
    .withGlobalGuidance(core.globalGuidance || '（待生成）')
    .withStepGuidance(guidance || '')
    .withReferenceWorks(core.referenceWorks || '')

  const result = await singleGenerate(builder, template.systemRole, sink, llmParams)
  ProjectCoreRepository.update({ charactersArch: `# 角色图谱\n\n${result}\n` })
  sink.log('角色图谱已保存，开始抽取角色卡')
  await extractCharacterCards(result, core.genre, sink, llmParams)
  return result
}

/** 生成世界观 */
export async function generateWorldbuilding(
  sink: WorkflowSink,
  guidance?: string,
  llmParams?: GenerateParams,
): Promise<string> {
  const core = requireCore()
  if (!core.premise || core.premise.length < 50 || core.premise.includes('待生成')) {
    throw new WorkflowError('请先生成故事前提', 400)
  }
  sink.log('正在生成世界观…')
  const template = getPromptTemplate('world_building')
  if (!template) throw new WorkflowError('缺少模板 world_building', 500)

  const builder = new ArchitecturePromptBuilder(template)
    .withCoreSeed(core.premise)
    .withGenre(core.genre)
    .withCoreSetting(core.worldbuilding || '（待生成）')
    .withGoldenFinger(core.goldenFinger || '（待生成）')
    .withProtagonistProfile('（待生成）')
    .withGlobalGuidance(core.globalGuidance || '（待生成）')
    .withStepGuidance(guidance || '')

  const result = await singleGenerate(builder, template.systemRole, sink, llmParams)
  ProjectCoreRepository.update({ worldbuilding: `# 世界观\n\n${result}\n` })
  sink.log('世界观已保存')
  return result
}

/** 生成情节总大纲 */
export async function generateSynopsis(
  sink: WorkflowSink,
  guidance?: string,
  llmParams?: GenerateParams,
): Promise<string> {
  const core = requireCore()
  if (!core.premise || core.premise.includes('待生成')) throw new WorkflowError('请先生成故事前提', 400)
  if (!core.charactersArch || core.charactersArch.includes('待生成')) throw new WorkflowError('请先生成角色图谱', 400)
  if (!core.worldbuilding || core.worldbuilding.includes('待生成')) throw new WorkflowError('请先生成世界观', 400)

  sink.log('正在生成情节总大纲…')
  const template = getPromptTemplate('synopsis')
  if (!template) throw new WorkflowError('缺少模板 synopsis', 500)

  const guide = getPlotStructureGuide(core.plotStructure, core.totalChapters)
  const pov = getNarrativePOVLabel(core.narrativePov)

  const builder = new ArchitecturePromptBuilder(template)
    .withCoreSeed(core.premise)
    .withCharacterDynamics(core.charactersArch)
    .withWorldBuilding(core.worldbuilding)
    .withGenre(core.genre)
    .withNumberOfChapters(core.totalChapters)
    .withWordNumber(core.wordsPerChapter)
    .withPlotStructureGuide(guide)
    .withNarrativePov(pov)
    .withGlobalGuidance(core.globalGuidance || '（待生成）')
    .withStepGuidance(guidance || '')

  const result = await singleGenerate(builder, template.systemRole, sink, llmParams)
  ProjectCoreRepository.update({ synopsis: `# 情节大纲\n\n${result}\n` })
  sink.log('情节总大纲已保存')
  return result
}

/** 通用：非流式单次生成（经 builder 构建 prompt） */
async function singleGenerate(
  builder: { build: () => string },
  systemRole: string | undefined,
  sink: WorkflowSink,
  llmParams?: GenerateParams,
): Promise<string> {
  const { content } = await generate(
    [
      { role: 'system', content: systemRole || '' },
      { role: 'user', content: builder.build() },
    ],
    llmParams,
  )
  const clean = stripThinkingTags(content)
  if (!clean.trim()) throw new WorkflowError('模型返回内容为空', 502)
  sink.text(clean)
  return clean
}

/** 保留流式 API（供未来需要打字机输出的架构步骤使用） */
export async function streamGenerate(
  builder: { build: () => string },
  systemRole: string,
  sink: WorkflowSink,
  llmParams?: GenerateParams,
  signal?: AbortSignal,
): Promise<string> {
  const raw = await generateStream(
    [
      { role: 'system', content: systemRole },
      { role: 'user', content: builder.build() },
    ],
    { onChunk: (c) => sink.text(c) },
    llmParams,
    signal,
  )
  return stripThinkingTags(raw)
}

function str(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.join('\n')
  if (typeof v === 'object') return JSON.stringify(v, null, 2)
  return String(v)
}
