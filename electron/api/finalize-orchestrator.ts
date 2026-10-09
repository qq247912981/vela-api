/**
 * 定稿编排
 *
 * 复刻 FinalizeChapterCommand 主路径：
 * 一致性门禁 → 草稿置 finalized → 写根目录投影 →
 * 后处理（KB 导入 / 章节要点 / Canon 写回 / 角色状态更新）。
 *
 * Canon 写回直接复用 extractAndWriteback（内部经垫片走主进程事务）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { getPromptTemplate } from '../../src/services/prompt-templates'
import {
  PostProcessPromptBuilder,
} from '../../src/services/prompts/prompt-builder'
import { generate, stripThinkingTags, type GenerateParams } from './llm-service'
import { DraftRepository } from '../repositories/draft-repository'
import { CharacterRepository, type CharacterStateData } from '../repositories/character-repository'
import { BlueprintRepository } from '../repositories/blueprint-repository'
import {
  getActiveProjectPath,
  importTextToKB,
  looseParseObject,
  requireCore,
  WorkflowError,
  type WorkflowSink,
} from './workflow-helpers'
import {
  buildCanonContext,
  extractAndWriteback,
  runConsistencyGate,
} from '../../src/services/narrative-consistency'

export interface FinalizeRequest {
  draftId: number
}

/** 将指定草稿定稿并执行全部后处理 */
export async function finalizeChapter(
  req: FinalizeRequest,
  sink: WorkflowSink,
  llmParams?: GenerateParams,
): Promise<{ chapterNumber: number; content: string; physicalPath: string }> {
  const core = requireCore()
  const projectPath = getActiveProjectPath()

  const draft = DraftRepository.getFull(req.draftId)
  if (!draft) throw new WorkflowError(`未找到草稿 #${req.draftId}`, 404)
  if (!draft.content.trim()) throw new WorkflowError('草稿内容为空，无法定稿', 400)

  // 1. 一致性门禁（定稿前强制）
  sink.log('执行定稿前一致性门禁…')
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
    chapterGoal: `第${draft.chapterNumber}章定稿`,
    previousEnding: '',
    ragContext: '',
    writingStyle: core.writingStyle,
    globalGuidance: core.globalGuidance,
  })
  const gate = await runConsistencyGate({
    chapterNumber: draft.chapterNumber,
    chapterContent: draft.content,
    canon,
    isRewrite: false,
  })
  sink.log(`门禁结果：${gate.verdict} — ${gate.report}`)
  if (gate.verdict === 'BLOCK') {
    throw new WorkflowError(`定稿被门禁阻止：${gate.blockingReasons.join('；')}`, 422)
  }
  const gatedContent = gate.verdict === 'REPAIR' && gate.repairedContent ? gate.repairedContent : draft.content

  // 2. 置为 finalized
  DraftRepository.updateContent(req.draftId, gatedContent, gatedContent.length)
  DraftRepository.updateStatus(req.draftId, 'finalized', gatedContent.length)

  // 3. 写根目录物理投影
  const title = resolveTitle(draft.chapterNumber)
  const physicalPath = path.join(projectPath, `第${draft.chapterNumber}章${title ? ` ${title.replace(/[/\\]/g, '_')}` : ''}.txt`)
  const titleLine = title ? `第${draft.chapterNumber}章 ${title}\n\n` : `第${draft.chapterNumber}章\n\n`
  await fs.writeFile(physicalPath, titleLine + gatedContent.replace(/^#+ .*\n*/, ''), 'utf-8')
  sink.log(`定稿投影已写入：${physicalPath}`)

  // 4a. 导入知识库
  sink.log('将本章导入知识库…')
  const kbName = title ? `第${draft.chapterNumber}章 ${title}.txt` : `chapter_${draft.chapterNumber}.txt`
  const importRes = await importTextToKB(gatedContent, kbName, projectPath)
  if (importRes.success) sink.log(`知识库导入完成，${importRes.chunkCount ?? 0} 个切片`)
  else sink.log(`知识库导入失败：${importRes.error}`)

  // 4b. 章节要点提取 → 蓝图 notes + canon 摘要
  sink.log('提取章节要点…')
  const notesText = await extractChapterNotes(draft.chapterNumber, title, gatedContent, sink, llmParams)
  if (notesText) {
    const { BlueprintRepository } = await import('../repositories/blueprint-repository')
    BlueprintRepository.updateNotes(draft.chapterNumber, notesText)
  }

  // 4c. Canon 写回（时间线 / 角色状态 / 事实 / 剧情线）
  sink.log('写回 Canon 正史库…')
  const bp = BlueprintRepository.getByChapter(draft.chapterNumber)
  const writeback = await extractAndWriteback({
    chapterNumber: draft.chapterNumber,
    chapterTitle: title,
    chapterContent: gatedContent,
    characters: allCharacters.map((c) => ({ name: c.name, role: c.role, currentState: c.currentState })),
    chapterBlueprint: bp
      ? { keyEvents: bp.keyEvents, characters: bp.characters, suspenseHook: bp.suspenseHook }
      : undefined,
    existingNotes: notesText,
  })
  if (writeback.ok) sink.log('Canon 写回完成')
  else sink.log(`Canon 写回部分失败（${writeback.errors.length} 项）：${writeback.errors.slice(0, 3).join('；')}`)

  // 4d. 角色状态更新
  sink.log('更新角色动态状态…')
  await updateCharacterStates(gatedContent, draft.chapterNumber, sink, llmParams)

  sink.log(`第${draft.chapterNumber}章定稿完成`)
  return { chapterNumber: draft.chapterNumber, content: gatedContent, physicalPath }
}

/** 章节要点提取（generate_chapter_notes 模板） */
async function extractChapterNotes(
  chapterNumber: number,
  title: string,
  content: string,
  sink: WorkflowSink,
  llmParams?: GenerateParams,
): Promise<string> {
  const template = getPromptTemplate('generate_chapter_notes')
  if (!template) {
    sink.log('未配置章节要点模板，跳过')
    return ''
  }
  const builder = new PostProcessPromptBuilder(template)
    .withChapterContent(content)
    .withChapterNumber(chapterNumber)
    .withChapterTitle(title)
  const { content: out } = await generate(
    [
      { role: 'system', content: template.systemRole || '' },
      { role: 'user', content: builder.build() },
    ],
    llmParams,
  )
  const notes = stripThinkingTags(out)
  sink.log('章节要点已提取')
  return notes
}

/** 根据正文更新角色当前状态（update_character_cards 模板） */
async function updateCharacterStates(
  content: string,
  chapterNumber: number,
  sink: WorkflowSink,
  llmParams?: GenerateParams,
): Promise<void> {
  const template = getPromptTemplate('update_character_cards')
  if (!template) {
    sink.log('未配置角色状态模板，跳过')
    return
  }
  const existingChars = CharacterRepository.getAll()
  const simpleCards = existingChars.map((c) => ({ name: c.name, role: c.role }))

  const builder = new PostProcessPromptBuilder(template)
    .withChapterContent(content.slice(0, 5000))
    .withChapterNumber(chapterNumber)
    .withExistingCardsJson(simpleCards)

  const { content: out } = await generate(
    [
      { role: 'system', content: template.systemRole || '' },
      { role: 'user', content: builder.build() },
    ],
    { ...llmParams, responseFormat: { type: 'json_object' } },
  )

  let parsed: {
    updates?: Array<{ name: string; currentState: Partial<CharacterStateData> }>
    newCharacters?: Array<{ name: string; role: string; currentState: Partial<CharacterStateData> }>
  }
  try {
    parsed = looseParseObject<typeof parsed>(stripThinkingTags(out))
  } catch {
    sink.log('角色状态返回解析失败，跳过')
    return
  }

  // 更新已有角色
  for (const upd of parsed.updates ?? []) {
    const dbChar = existingChars.find((c) => c.name === upd.name)
    if (!dbChar || !upd.currentState) continue
    const old = dbChar.currentState
    const next: CharacterStateData = {
      location: upd.currentState.location || old?.location || '',
      powerLevel: upd.currentState.powerLevel || old?.powerLevel || '',
      physicalState: upd.currentState.physicalState || old?.physicalState || '',
      mentalState: upd.currentState.mentalState || old?.mentalState || '',
      keyItems: upd.currentState.keyItems || old?.keyItems || '',
      recentEvents: upd.currentState.recentEvents || old?.recentEvents || '',
      updatedAtChapter: chapterNumber,
    }
    CharacterRepository.updateState(upd.name, next)
  }

  // 注册新角色
  let added = 0
  for (const nc of parsed.newCharacters ?? []) {
    if (!nc.name || existingChars.some((c) => c.name === nc.name)) continue
    const cs = nc.currentState ?? {}
    CharacterRepository.upsert({
      name: nc.name,
      role: nc.role || 'supporting',
      gender: '', age: '', appearance: '', personality: '', background: '',
      abilities: '', motivation: '', relationships: '', arc: '', notes: '',
      currentState: {
        location: cs.location || '',
        powerLevel: cs.powerLevel || '',
        physicalState: cs.physicalState || '',
        mentalState: cs.mentalState || '',
        keyItems: cs.keyItems || '',
        recentEvents: cs.recentEvents || '',
        updatedAtChapter: chapterNumber,
      },
    })
    added++
  }
  sink.log(`角色状态已更新${added ? `，新注册 ${added} 个角色` : ''}`)
}

/** 读取章节正式标题（优先蓝图） */
function resolveTitle(chapterNumber: number): string {
  return BlueprintRepository.getByChapter(chapterNumber)?.title || ''
}
