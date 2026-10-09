/**
 * API 路由注册 —— 把编排函数映射为具体 HTTP 端点
 *
 * 端点总览：
 *   GET  /api/health
 *   GET  /api/projects/recent
 *   POST /api/projects/create
 *   POST /api/projects/open
 *
 *   POST /api/architecture/config      一句话创意 → 全局配置
 *   POST /api/architecture/premise
 *   POST /api/architecture/characters
 *   POST /api/architecture/worldbuilding
 *   POST /api/architecture/synopsis
 *
 *   POST /api/directory                生成章节蓝图（细纲）
 *
 *   POST /api/chapters/generate        流式生成正文
 *   GET  /api/chapters/finalized       已定稿章节列表
 *
 *   POST /api/drafts/:id/review
 *   POST /api/drafts/:id/refine
 *   POST /api/revisions/:id/merge
 *   POST /api/drafts/:id/finalize
 *
 *   GET  /api/drafts?chapter=N         草稿列表
 *
 * 所有 POST 工作流端点支持：
 *   - Accept: text/event-stream 或 ?stream=true → SSE 实时输出
 *   - 默认 → 缓冲后返回 JSON（含 logs/text/result）
 *
 * 可在 body 传入 modelId / temperature / maxTokens 覆盖模型与采样参数。
 */
import {
  route,
  runWorkflow,
  sendJson,
  type ApiContext,
} from './http-server'
import {
  createProject,
  openProject,
  listRecentProjects,
} from './project-manager'
import {
  generateGlobalConfig,
  generatePremise,
  generateCharacters,
  generateWorldbuilding,
  generateSynopsis,
} from './architecture-orchestrator'
import { generateDirectory } from './directory-orchestrator'
import { generateChapter } from './chapter-orchestrator'
import { reviewChapter, refineChapter, mergeRevision } from './review-refine-orchestrator'
import { finalizeChapter } from './finalize-orchestrator'
import { DraftRepository } from '../repositories/draft-repository'
import type { GenerateParams } from './llm-service'

/** 从请求体提取模型覆盖参数 */
function llmParams(body: Record<string, unknown>): GenerateParams {
  const params: GenerateParams = {}
  if (typeof body.modelId === 'string') params.modelId = body.modelId
  if (typeof body.temperature === 'number') params.temperature = body.temperature
  if (typeof body.maxTokens === 'number') params.maxTokens = body.maxTokens
  return params
}

/** 注册全部 API 路由 */
export function registerApiRoutes(): void {
  // -------- 健康检查 --------
  route('GET', '/api/health', async (ctx: ApiContext) => {
    sendJson(ctx.res, 200, { ok: true, service: 'vela-local-api', time: new Date().toISOString() })
  })

  // -------- 项目 --------
  route('GET', '/api/projects/recent', async (ctx: ApiContext) => {
    sendJson(ctx.res, 200, { ok: true, projects: listRecentProjects() })
  })

  route('POST', '/api/projects/create', async (ctx: ApiContext) => {
    const body = ctx.body
    const result = createProject({
      name: String(body.name ?? ''),
      basePath: String(body.basePath ?? body.path ?? ''),
      genre: String(body.genre ?? ''),
      targetAudience: String(body.targetAudience ?? ''),
    })
    sendJson(ctx.res, 201, { ok: true, project: result })
  })

  route('POST', '/api/projects/open', async (ctx: ApiContext) => {
    const result = openProject(String(ctx.body.path ?? ''))
    sendJson(ctx.res, 200, { ok: true, project: result })
  })

  // -------- 架构 --------
  route('POST', '/api/architecture/config', (ctx) =>
    runWorkflow(ctx, (sink) =>
      generateGlobalConfig(String(ctx.body.idea ?? ''), sink, llmParams(ctx.body)),
    ),
  )

  route('POST', '/api/architecture/premise', (ctx) =>
    runWorkflow(ctx, (sink) =>
      generatePremise(sink, optional(ctx.body.guidance), llmParams(ctx.body)),
    ),
  )

  route('POST', '/api/architecture/characters', (ctx) =>
    runWorkflow(ctx, (sink) =>
      generateCharacters(
        sink,
        optional(ctx.body.guidance),
        llmParams(ctx.body),
      ),
    ),
  )

  route('POST', '/api/architecture/worldbuilding', (ctx) =>
    runWorkflow(ctx, (sink) =>
      generateWorldbuilding(sink, optional(ctx.body.guidance), llmParams(ctx.body)),
    ),
  )

  route('POST', '/api/architecture/synopsis', (ctx) =>
    runWorkflow(ctx, (sink) =>
      generateSynopsis(sink, optional(ctx.body.guidance), llmParams(ctx.body)),
    ),
  )

  // -------- 目录 --------
  route('POST', '/api/directory', (ctx) =>
    runWorkflow(ctx, (sink) =>
      generateDirectory(
        sink,
        {
          mode: ctx.body.mode === 'append' ? 'append' : 'full',
          startChapter: num(ctx.body.startChapter),
          count: num(ctx.body.count),
          pacingGuidance: optional(ctx.body.pacingGuidance),
        },
        llmParams(ctx.body),
      ),
    ),
  )

  // -------- 章节正文 --------
  route('POST', '/api/chapters/generate', (ctx) =>
    runWorkflow(ctx, (sink, signal) =>
      generateChapter(
        {
          chapterNumber: Number(ctx.body.chapterNumber),
          title: optional(ctx.body.title),
          userGuidance: optional(ctx.body.userGuidance),
          knowledgeQueryHint: optional(ctx.body.knowledgeQueryHint),
        },
        sink,
        llmParams(ctx.body),
        signal,
      ),
    ),
  )

  route('GET', '/api/chapters/finalized', async (ctx: ApiContext) => {
    const max = DraftRepository.getMaxFinalizedChapter()
    const chapters = []
    for (let i = 1; i <= max; i++) {
      const meta = DraftRepository.getFinalizedByChapter(i)
      if (meta) chapters.push({ chapterNumber: i, draftId: meta.id, wordCount: meta.wordCount })
    }
    sendJson(ctx.res, 200, { ok: true, chapters })
  })

  // -------- 草稿列表 --------
  route('GET', '/api/drafts', async (ctx: ApiContext) => {
    const chapter = Number(ctx.query.get('chapter'))
    if (!Number.isInteger(chapter) || chapter < 1) {
      sendJson(ctx.res, 400, { ok: false, error: '缺少 query 参数 chapter' })
      return
    }
    sendJson(ctx.res, 200, { ok: true, drafts: DraftRepository.listByChapter(chapter) })
  })

  // -------- 审阅 / 精修 / 合并 / 定稿 --------
  route('POST', '/api/drafts/:id/review', (ctx) =>
    runWorkflow(ctx, (sink) =>
      reviewChapter(
        {
          draftId: Number(ctx.params.id),
          reviewFocus: optional(ctx.body.reviewFocus),
        },
        sink,
        llmParams(ctx.body),
      ),
    ),
  )

  route('POST', '/api/drafts/:id/refine', (ctx) =>
    runWorkflow(ctx, (sink, signal) =>
      refineChapter(
        { draftId: Number(ctx.params.id), userRefinePrompt: optional(ctx.body.userRefinePrompt) },
        sink,
        llmParams(ctx.body),
        signal,
      ),
    ),
  )

  route('POST', '/api/revisions/:id/merge', async (ctx: ApiContext) => {
    const result = await mergeRevision(Number(ctx.params.id))
    sendJson(ctx.res, 200, { ok: true, result })
  })

  route('POST', '/api/drafts/:id/finalize', (ctx) =>
    runWorkflow(ctx, (sink) =>
      finalizeChapter({ draftId: Number(ctx.params.id) }, sink, llmParams(ctx.body)),
    ),
  )

  console.log('[Vela API] 路由注册完成')
}

function optional(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
