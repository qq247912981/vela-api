/**
 * 审阅与精修编排
 *
 * reviewChapter：对某版草稿做编辑视角自评审，产出结构化 JSON 报告，写 reviews 表。
 * refineChapter：在不破坏既有事实的前提下精修草稿（isRewrite 门禁），写 revisions 表。
 *
 * 复用 ReviewPromptBuilder / ChapterPromptBuilder、模板与一致性纯逻辑。
 */
import { getPromptTemplate } from '../../src/services/prompt-templates'
import {
  ReviewPromptBuilder,
  ChapterPromptBuilder,
} from '../../src/services/prompts/prompt-builder'
import { generate, generateStream, stripThinkingTags, type GenerateParams } from './llm-service'
import { DraftRepository } from '../repositories/draft-repository'
import { ReviewRepository } from '../repositories/review-repository'
import { RevisionRepository } from '../repositories/revision-repository'
import { CharacterRepository } from '../repositories/character-repository'
import {
  formatCharacterStates,
  formatKBResults,
  getActiveProjectPath,
  looseParseObject,
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

// ---------------------------------------------------------------
// 审阅
// ---------------------------------------------------------------

export interface ReviewRequest {
  draftId: number
  /** 审阅侧重维度（角色一致性 / 剧情逻辑 / 节奏等），可选 */
  reviewFocus?: string
}

/** 对指定草稿执行 AI 审阅，返回报告对象并持久化 */
export async function reviewChapter(
  req: ReviewRequest,
  sink: WorkflowSink,
  llmParams?: GenerateParams,
): Promise<{ reviewId: number; reviewIndex: number; report: Record<string, unknown> }> {
  const core = requireCore()
  const projectPath = getActiveProjectPath()

  const draft = DraftRepository.getFull(req.draftId)
  if (!draft) throw new WorkflowError(`未找到草稿 #${req.draftId}`, 404)
  if (!draft.content.trim()) throw new WorkflowError('草稿内容为空', 400)

  sink.log('正在准备审阅上下文…')
  const kbResults = await searchKB(draft.content.slice(0, 200), projectPath, 5)
  const contextSummary = formatKBResults(kbResults)
  const characterState = formatCharacterStates()

  // Canon 交叉验证基线
  const allCharacters = CharacterRepository.getAll()
  let canon
  try {
    canon = await buildCanonContext({
      chapterNumber: draft.chapterNumber,
      architecture: {
        premise: core.premise,
        charactersArch: core.charactersArch,
        worldbuilding: core.worldbuilding,
        synopsis: core.synopsis,
      },
      characters: allCharacters.map((c) => ({ name: c.name, role: c.role, currentState: c.currentState })),
      chapterGoal: `第${draft.chapterNumber}章审阅`,
      previousEnding: '',
      ragContext: '',
      writingStyle: core.writingStyle,
      globalGuidance: core.globalGuidance,
    })
  } catch (e) {
    sink.log(`Canon 上下文构建失败，将不注入：${String(e)}`)
  }

  const template = getPromptTemplate('consistency_check')
  if (!template) throw new WorkflowError('缺少模板 consistency_check', 500)

  const builder = new ReviewPromptBuilder(template)
  builder
    .withChapterContent(draft.content)
    .withCharacterStates(characterState)
    .withGlobalSummary(contextSummary || '（无参考上下文）')
    .withWorldBuilding(core.worldbuilding || '（无）')
    .withReviewFocus(req.reviewFocus || '')
  if (canon) builder.withCanonContext(renderCanonContext(canon))

  sink.log('调用审阅模型…')
  const { content } = await generate(
    [
      { role: 'system', content: template.systemRole || '' },
      { role: 'user', content: builder.build() },
    ],
    { ...llmParams, responseFormat: { type: 'json_object' } },
  )
  const clean = stripThinkingTags(content)

  let report: Record<string, unknown>
  try {
    report = looseParseObject<Record<string, unknown>>(clean)
  } catch {
    sink.log('审阅结果非合法 JSON，按原始文本保存')
    report = { summary: clean, items: [] }
  }

  const reviewIndex = ReviewRepository.getNextIndex(req.draftId)
  const serialized = JSON.stringify(report, null, 2)
  const reviewId = ReviewRepository.create({
    baseDraftId: req.draftId,
    reviewIndex,
    content: serialized,
  })

  sink.log(`审阅完成，报告 #${reviewId}（第 ${reviewIndex} 次）`)
  return { reviewId, reviewIndex, report }
}

// ---------------------------------------------------------------
// 精修
// ---------------------------------------------------------------

export interface RefineRequest {
  draftId: number
  /** 用户额外修稿指导，可选 */
  userRefinePrompt?: string
}

/** 精修指定草稿，产出 revision（pending），返回修订内容 */
export async function refineChapter(
  req: RefineRequest,
  sink: WorkflowSink,
  llmParams?: GenerateParams,
  signal?: AbortSignal,
): Promise<{ revisionId: number; revisionIndex: number; content: string }> {
  const core = requireCore()

  const draft = DraftRepository.getFull(req.draftId)
  if (!draft) throw new WorkflowError(`未找到草稿 #${req.draftId}`, 404)
  if (!draft.content.trim()) throw new WorkflowError('草稿内容为空', 400)

  sink.log('正在精修…')
  const userBlock = req.userRefinePrompt?.trim()
    ? `★【用户额外修稿指导（绝对优先级）】★：\n${req.userRefinePrompt.trim()}`
    : ''

  const allCharacters = CharacterRepository.getAll()
  const canon = await buildCanonContext({
    chapterNumber: draft.chapterNumber,
    architecture: {
      premise: core.premise,
      charactersArch: core.charactersArch,
      worldbuilding: core.worldbuilding,
      synopsis: core.synopsis,
    },
    characters: allCharacters.map((c) => ({ name: c.name, role: c.role, currentState: c.currentState })),
    chapterGoal: `第${draft.chapterNumber}章精修`,
    previousEnding: '',
    ragContext: '',
    writingStyle: core.writingStyle,
    globalGuidance: core.globalGuidance,
  })

  const template = getPromptTemplate('refine_chapter')
  if (!template) throw new WorkflowError('缺少模板 refine_chapter', 500)

  const chapterInfo = {
    chapterNumber: draft.chapterNumber,
    title: '',
    role: '',
    purpose: '',
    characters: [],
    keyEvents: '',
  }

  const builder = new ChapterPromptBuilder(template)
    .withDraftContent(draft.content)
    .withChapterInfo(chapterInfo)
    .withGlobalGuidance(core.globalGuidance)
    .withWordNumber(core.wordsPerChapter)
    .withUserRefinePrompt(userBlock)
    .withCanonContext(renderCanonContext(canon))

  sink.log('调用精修模型…')
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

  // 精修后门禁（isRewrite=true，禁止破坏既有事实）
  sink.log('执行一致性检查…')
  const gate = await runConsistencyGate({
    chapterNumber: draft.chapterNumber,
    chapterContent: clean,
    canon,
    isRewrite: true,
  })
  sink.log(`门禁结果：${gate.verdict} — ${gate.report}`)
  if (gate.verdict === 'BLOCK') {
    throw new WorkflowError(`精修未通过门禁：${gate.blockingReasons.join('；')}`, 422)
  }
  const finalContent = gate.verdict === 'REPAIR' && gate.repairedContent ? gate.repairedContent : clean

  // 清理旧的 pending，只保留最新一条
  const revisionIndex = RevisionRepository.getNextIndex(req.draftId)
  for (const old of RevisionRepository.getPending(req.draftId)) {
    RevisionRepository.markDiscarded(old.id)
  }
  const revisionId = RevisionRepository.create({
    baseDraftId: req.draftId,
    revisionIndex,
    revisionType: 'refine',
    content: finalContent,
    wordCount: finalContent.length,
  })

  sink.log(`精修完成，revision #${revisionId}（${finalContent.length} 字）`)
  return { revisionId, revisionIndex, content: finalContent }
}

/** 合并 revision：将修订内容作为新草稿版本入库，并标记 revision 为 merged */
export function mergeRevision(
  revisionId: number,
): Promise<{ newDraftId: number; version: number }> {
  const rev = RevisionRepository.getFull(revisionId)
  if (!rev) throw new WorkflowError(`未找到 revision #${revisionId}`, 404)
  if (rev.status === 'discarded') throw new WorkflowError('该 revision 已弃用，无法合并', 400)

  const baseDraft = DraftRepository.getMeta(rev.baseDraftId)
  if (!baseDraft) throw new WorkflowError('原始草稿不存在', 404)

  const version = DraftRepository.getNextVersion(baseDraft.chapterNumber)
  const newDraftId = DraftRepository.create({
    chapterNumber: baseDraft.chapterNumber,
    version,
    source: 'rewrite',
    content: rev.content,
    wordCount: rev.content.length,
  })
  RevisionRepository.markMerged(revisionId, newDraftId)
  return Promise.resolve({ newDraftId, version })
}
