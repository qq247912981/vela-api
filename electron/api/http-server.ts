/**
 * 本地 HTTP 服务器基础设施
 *
 * - 仅绑定 127.0.0.1（不对外暴露，免鉴权）
 * - JSON 请求解析（带大小限制）
 * - 简单参数路由
 * - 工作流统一执行器：支持 SSE 实时输出 或 缓冲后 JSON 返回
 * - 宽松 CORS，便于本机网页/脚本调用
 */
import http from 'node:http'
import type { WorkflowSink } from './workflow-helpers'

export const DEFAULT_PORT = 18787
const MAX_BODY = 10 * 1024 * 1024 // 10MB

export interface ApiContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  params: Record<string, string>
  body: Record<string, unknown>
  query: URLSearchParams
}

type RouteHandler = (ctx: ApiContext) => Promise<void>

interface Route {
  method: string
  /** 形如 /api/drafts/:id/review */
  pattern: string
  segments: string[]
  handler: RouteHandler
}

// ---------------------------------------------------------------
// 路由注册 / 匹配
// ---------------------------------------------------------------

const routes: Route[] = []

export function route(method: string, pattern: string, handler: RouteHandler): void {
  routes.push({ method, pattern, segments: pattern.split('/').filter(Boolean), handler })
}

function matchRoute(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
  const parts = pathname.split('/').filter(Boolean)
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== parts.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < parts.length; i++) {
      const seg = route.segments[i]
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i])
      else if (seg !== parts[i]) {
        ok = false
        break
      }
    }
    if (ok) return { handler: route.handler, params }
  }
  return null
}

// ---------------------------------------------------------------
// 请求体 / 响应工具
// ---------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new ApiError('请求体过大', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim()
      if (!raw) return resolve({})
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new ApiError('请求体不是合法 JSON', 400))
      }
    })
    req.on('error', reject)
  })
}

export function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data, null, 2)
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

function applyCORS(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept')
}

// ---------------------------------------------------------------
// 工作流执行器：SSE / 缓冲 JSON
// ---------------------------------------------------------------

function wantsSSE(ctx: ApiContext): boolean {
  return (
    ctx.query.get('stream') === 'true' ||
    String(ctx.req.headers.accept ?? '').includes('text/event-stream')
  )
}

/**
 * 运行一个工作流。
 * - SSE：实时推送 log/text/progress，结束推送 done，出错推送 error。
 * - 缓冲：收集输出，最后一次性返回 JSON。
 *
 * fn 返回结构化结果（放入 done / JSON.result）。
 */
export async function runWorkflow(
  ctx: ApiContext,
  fn: (sink: WorkflowSink, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  const { req, res } = ctx
  const abortController = new AbortController()
  const onClose = () => abortController.abort()
  req.on('close', onClose)

  try {
    if (wantsSSE(ctx)) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const emit = (event: string, data: unknown) => {
        res.write(`event: ${event}\n`)
        res.write(`data: ${JSON.stringify(data)}\n\n`)
      }
      const sink: WorkflowSink = {
        log: (m) => emit('log', m),
        text: (c) => emit('text', c),
        progress: (p) => emit('progress', p),
      }
      const result = await fn(sink, abortController.signal)
      emit('done', { ok: true, result })
      res.end()
    } else {
      const logs: string[] = []
      const textParts: string[] = []
      const sink: WorkflowSink = {
        log: (m) => logs.push(m),
        text: (c) => textParts.push(c),
        progress: () => {},
      }
      const result = await fn(sink, abortController.signal)
      sendJson(res, 200, { ok: true, result, logs, text: textParts.join('') })
    }
  } catch (err) {
    const { statusCode, message } = normalizeError(err)
    if (res.headersSent) {
      // SSE 已开始：推送 error 后关闭
      res.write(`event: error\ndata: ${JSON.stringify({ ok: false, statusCode, error: message })}\n\n`)
      res.end()
    } else {
      sendJson(res, statusCode, { ok: false, error: message })
    }
  } finally {
    req.off('close', onClose)
  }
}

// ---------------------------------------------------------------
// 错误归一化
// ---------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function normalizeError(err: unknown): { statusCode: number; message: string } {
  if (err instanceof Error) {
    const code = (err as { statusCode?: number }).statusCode
    return { statusCode: code ?? 500, message: err.message }
  }
  return { statusCode: 500, message: String(err) }
}

// ---------------------------------------------------------------
// 服务器启动
// ---------------------------------------------------------------

/** 创建并启动本地 API 服务器，返回实际监听地址 */
export function startLocalApiServer(preferredPort = DEFAULT_PORT): Promise<{ port: number }> {
  const server = http.createServer(async (req, res) => {
    applyCORS(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let body: Record<string, unknown> = {}
    try {
      if (req.method === 'POST') body = await readBody(req)
    } catch (err) {
      const { statusCode, message } = normalizeError(err)
      sendJson(res, statusCode, { ok: false, error: message })
      return
    }

    const matched = matchRoute(req.method ?? '', url.pathname)
    if (!matched) {
      sendJson(res, 404, { ok: false, error: `未找到路由: ${req.method} ${url.pathname}` })
      return
    }

    const ctx: ApiContext = {
      req,
      res,
      params: matched.params,
      body,
      query: url.searchParams,
    }
    try {
      await matched.handler(ctx)
    } catch (err) {
      if (!res.headersSent) {
        const { statusCode, message } = normalizeError(err)
        sendJson(res, statusCode, { ok: false, error: message })
      }
    }
  })

  return new Promise((resolve, reject) => {
    server.on('error', (err) => reject(err))
    server.listen(preferredPort, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : preferredPort
      console.log(`[Vela API] 本地接口已启动: http://127.0.0.1:${port}`)
      resolve({ port })
    })
  })
}
