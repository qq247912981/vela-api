/**
 * 章节正文编排 —— 单章流式草稿生成
 *
 * 复刻 GenerateDraftCommand 的核心编排：架构 / 全局指导 / 角色状态 /
 * 未来蓝图 / 上一章结尾 / 章节要点时间线 / KB 检索，强制经过 Canon
 * 一致性上下文与生成后门禁。复用 ChapterPromptBuilder、模板与一致性纯逻辑。
 */
import { ChapterPromptBuilder } from '../../src/services/prompts/prompt-builder'
import { getPromptTemplate } from '../../src/services/prompt-templates'
import { generateStream, stripThinkingTags, type GenerateParams } from './llm-service'
import { DraftRepository } from '../repositories/draft-repository'
import { CharacterRepository } from '../repositories/character-repository'
import { BlueprintRepository } from '../repositories/blueprint-repository'
import {
  formatCharacterStates,
  formatKBResults,
  getActiveProjectPath,
  readChapterNotesTimeline,
  readProjectPrompts,
  requireCore,
  searchKB,
  WorkflowError,
  type WorkflowSink,
} from './workflow-helpers'
import {
  buildCanonContext,
  renderCanonContext,
  runConsistencyGate,
} from '../../src/services/narrative-consistency'

export interface ChapterRequest {
  chapterNumber: number
  /** 标题（蓝图已存在时可省略，以蓝图为准） */
  title?: string
  /** 本章额外用户指导 */
  userGuidance?: string
  /** KB 检索追加关键词 */
  knowledgeQueryHint?: string
}

/** 流式生成一章草稿并入库 */
export async function generateChapter(
  req: ChapterRequest,
  sink: WorkflowSink,
  llmParams?: GenerateParams,
  signal?: AbortSignal,
): Promise<{ draftId: number; version: number; content: string }> {
  if (!Number.isInteger(req.chapterNumber) || req.chapterNumber < 1) {
    throw new WorkflowError('chapterNumber 必须是 ≥1 的整数', 400)
  }
  const core = requireCore()
  const projectPath = getActiveProjectPath()

  // 以蓝图为准组装章节信息；蓝图缺失时用请求字段兜底
  const bp = BlueprintRepository.getByChapter(req.chapterNumber)
  const chapterInfo = {
    chapterNumber: req.chapterNumber,
    title: bp?.title || req.title || `第${req.chapterNumber}章`,
    role: bp?.role || '',
    purpose: bp?.purpose || '',
    characters: bp?.characters || [],
    keyEvents: bp?.keyEvents || '',
    suspenseHook: bp?.suspenseHook || '',
    userGuidance: req.userGuidance || bp?.userGuidance || '',
    knowledgeQueryHint: req.knowledgeQueryHint || '',
  }
  if (!bp && !req.title) {
    sink.log('提示：未找到该章蓝图，将仅依据请求参数生成')
  }

  sink.log('正在组装上下文…')
  const projectPrompts = await readProjectPrompts(projectPath)
  const mergedGuidance = [core.globalGuidance, projectPrompts].filter(Boolean).join('\n\n')
  const characterState = formatCharacterStates()
  const allCharacters = CharacterRepository.getAll()

  // 未来 5 章蓝图
  const futureBlueprintsStr = BlueprintRepository.getAll()
    .filter((b) => b.chapterNumber > req.chapterNumber && b.chapterNumber <= req.chapterNumber + 5)
    .map((b) => `第${b.chapterNumber}章 ${b.title}：${b.keyEvents}`)
    .join('\n')

  // Canon 上下文（先构建，previousEnding/rag 在非首章分支补全）
  const canon = await buildCanonContext({
    chapterNumber: req.chapterNumber,
    architecture: {
      premise: core.premise,
      charactersArch: core.charactersArch,
      worldbuilding: core.worldbuilding,
      synopsis: core.synopsis,
    },
    characters: allCharacters.map((c) => ({ name: c.name, role: c.role, currentState: c.currentState })),
    chapterGoal: JSON.stringify(chapterInfo),
    previousEnding: '',
    ragContext: '',
    writingStyle: core.writingStyle,
    globalGuidance: mergedGuidance,
  })

  const isFirst = req.chapterNumber === 1
  const templateKey = isFirst ? 'first_chapter_draft' : 'next_chapter_draft'
  const template = getPromptTemplate(templateKey)
  if (!template) throw new WorkflowError(`缺少模板 ${templateKey}`, 500)

  const builder = new ChapterPromptBuilder(template)
    .withArchitecture([core.premise, core.charactersArch, core.worldbuilding, core.synopsis].filter(Boolean).join('\n\n---\n\n'))
    .withGlobalGuidance(mergedGuidance)
    .withWritingStyle(core.writingStyle)
    .withNovelConfig({
      genre: core.genre,
      targetAudience: core.targetAudience,
      narrativePOV: core.narrativePov,
      plotStructure: core.plotStructure,
    })
    .withWordNumber(core.wordsPerChapter)

  if (!isFirst) {
    const timeline = readChapterNotesTimeline(req.chapterNumber)
    const prevMeta = DraftRepository.getFinalizedByChapter(req.chapterNumber - 1)
    let previousEnding = ''
    if (prevMeta) previousEnding = DraftRepository.getFull(prevMeta.id)?.content.slice(-1000) ?? ''

    sink.log('正在检索知识库…')
    const searchQuery = [chapterInfo.title, chapterInfo.keyEvents, chapterInfo.characters.join(' '), req.knowledgeQueryHint]
      .filter(Boolean)
      .join(' ')
    const kbResults = await searchKB(searchQuery, projectPath, 5)
    const filteredContext = formatKBResults(kbResults)

    builder
      .withGlobalSummary(timeline)
      .withCharacterStates(characterState)
      .withPreviousEnding(previousEnding || '（无上一章结尾）')
      .withChapterInfo(chapterInfo)
      .withFutureBlueprints(futureBlueprintsStr || '（无后续蓝图）')
      .withFilteredContext(filteredContext || '（无检索结果）')
      .withShortSummary('')
      .withUserGuidance(chapterInfo.userGuidance || '（无额外指导）')

    canon.previousEnding = previousEnding || '（无上一章结尾）'
    canon.ragContext = filteredContext || '（无检索结果）'
  }

  builder.withCanonContext(renderCanonContext(canon))

  sink.log('开始调用模型生成正文…')
  const raw = await generateStream(
    [
      { role: 'system', content: template.systemRole || '' },
      { role: 'user', content: builder.build() },
    ],
    { onChunk: (c) => sink.text(c) },
    llmParams,
    signal,
  )
  const clean = stripThinkingTags(raw)

  // 生成后一致性门禁
  sink.log('正在执行一致性检查…')
  const gate = await runConsistencyGate({ chapterNumber: req.chapterNumber, chapterContent: clean, canon })
  sink.log(`门禁结果：${gate.verdict} — ${gate.report}`)
  if (gate.verdict === 'BLOCK') {
    throw new WorkflowError(`一致性门禁未通过：${gate.blockingReasons.join('；')}`, 422)
  }
  const finalDraft = gate.verdict === 'REPAIR' && gate.repairedContent ? gate.repairedContent : clean

  // 入库
  const version = DraftRepository.getNextVersion(req.chapterNumber)
  const draftId = DraftRepository.create({
    chapterNumber: req.chapterNumber,
    version,
    source: 'write',
    content: finalDraft,
    wordCount: finalDraft.length,
  })

  sink.log(`草稿已保存：第${req.chapterNumber}章 v${version}（${finalDraft.length} 字）`)
  return { draftId, version, content: finalDraft }
}
