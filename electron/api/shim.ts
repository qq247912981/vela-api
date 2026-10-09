/**
 * 主进程 IPC 垫片 —— 在主进程 Node 环境模拟渲染进程的 window.velaAPI
 *
 * 背景：叙事一致性模块（canonStore / consistency-gate / fact-extractor 等）
 * 是平台无关的纯逻辑，但内部通过 `ipc.invoke('db:canon-*', ...)` 读写数据。
 * 在渲染进程里它走 window.velaAPI → ipcRenderer；在主进程没有 window。
 *
 * 本垫片把这些通道直接转发到主进程已有的 Repository，从而让同一套
 * 一致性逻辑（含原子写回）在 API 服务中零修改复用。
 */
import {
  safeValidate,
  validateCanonTimelineEventInput,
  validateCanonFactInput,
  validateCanonPlotLineInput,
  validateCanonCharacterStateSnapshot,
  validateCanonChapterSummary,
  validateCanonWritebackPayload,
} from '../ipc-validation'
import { CanonRepository } from '../repositories/canon-repository'

type InvokeHandler = (...args: unknown[]) => unknown

/** 通道 → 主进程实现 的分发表 */
const channels: Record<string, InvokeHandler> = {
  // -------- 时间线 --------
  'db:canon-timeline-get': (maxChapter, includeFlashback) =>
    CanonRepository.getTimelineUpTo(Number(maxChapter), includeFlashback !== false),
  'db:canon-timeline-get-chapter': (chapterNumber) =>
    CanonRepository.getTimelineByChapter(Number(chapterNumber)),
  'db:canon-timeline-append': (event) => {
    const v = safeValidate(validateCanonTimelineEventInput, event)
    if (!v.ok) return { success: false, error: v.error }
    const id = CanonRepository.appendTimelineEvent(v.data)
    return { success: true, id }
  },
  'db:canon-timeline-clear-chapter': (chapterNumber) => {
    CanonRepository.clearChapterTimeline(Number(chapterNumber))
    return { success: true }
  },

  // -------- 角色状态 --------
  'db:canon-character-state-get-all': () => CanonRepository.getAllCharacterStates(),
  'db:canon-character-state-get': (character) =>
    CanonRepository.getCharacterState(String(character)),
  'db:canon-character-state-upsert': (snapshot) => {
    const v = safeValidate(validateCanonCharacterStateSnapshot, snapshot)
    if (!v.ok) return { success: false, error: v.error }
    CanonRepository.upsertCharacterState(v.data)
    return { success: true }
  },

  // -------- 剧情线 --------
  'db:canon-plot-list': (status) =>
    CanonRepository.getPlotLines(status ? { status: status as never } : undefined),
  'db:canon-plot-add': (line) => {
    const v = safeValidate(validateCanonPlotLineInput, line)
    if (!v.ok) return { success: false, error: v.error }
    const id = CanonRepository.addPlotLine(v.data)
    return { success: true, id }
  },
  'db:canon-plot-advance': (id, currentState, lastAdvancedAt) => {
    CanonRepository.advancePlotLine(Number(id), String(currentState), Number(lastAdvancedAt))
    return { success: true }
  },
  'db:canon-plot-resolve': (id, chapterNumber) => {
    CanonRepository.resolvePlotLine(Number(id), Number(chapterNumber))
    return { success: true }
  },

  // -------- 事实 --------
  'db:canon-fact-list': () => CanonRepository.getFacts(),
  'db:canon-fact-add': (fact) => {
    const v = safeValidate(validateCanonFactInput, fact)
    if (!v.ok) return { success: false, error: v.error }
    const id = CanonRepository.addFact(v.data)
    return { success: true, id }
  },
  'db:canon-fact-clear-chapter': (chapterNumber) => {
    CanonRepository.clearChapterFacts(Number(chapterNumber))
    return { success: true }
  },

  // -------- 章节摘要 --------
  'db:canon-summary-get': (chapterNumber) =>
    CanonRepository.getSummary(Number(chapterNumber)),
  'db:canon-summary-list-recent': (limit) =>
    CanonRepository.getRecentSummaries(limit === undefined ? 5 : Number(limit)),
  'db:canon-summary-upsert': (summary) => {
    const v = safeValidate(validateCanonChapterSummary, summary)
    if (!v.ok) return { success: false, error: v.error }
    CanonRepository.upsertSummary(v.data)
    return { success: true }
  },

  // -------- 原子写回 --------
  'db:canon-writeback-atomic': (payload) => {
    const v = safeValidate(validateCanonWritebackPayload, payload)
    if (!v.ok) return { success: false, error: v.error }
    const result = CanonRepository.writebackAtomically(v.data)
    return { success: true, ...result }
  },
}

/** 垫片暴露的 invoke：与渲染进程 velaAPI.invoke 同构 */
const shimInvoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = channels[channel]
  if (!handler) {
    throw new Error(`[API Shim] 不支持的通道: ${channel}`)
  }
  return handler(...args)
}

let installed = false

/** 在主进程安装 window.velaAPI 垫片（幂等，必须在调用一致性模块前执行） */
export function installMainProcessShim(): void {
  if (installed) return
  const global_ = globalThis as unknown as Record<string, unknown>
  global_.window = {
    ...((global_.window as Record<string, unknown> | undefined) ?? {}),
    velaAPI: { invoke: shimInvoke },
  }
  installed = true
  console.log('[Vela API] 主进程 IPC 垫片已安装')
}
