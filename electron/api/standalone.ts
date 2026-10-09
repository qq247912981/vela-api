/**
 * 独立 API 启动入口（不依赖 Electron GUI）
 *
 * 用途：
 *   1. 直接以 Node 运行本地接口服务，无需打开桌面窗口
 *   2. 开发 / 调试 API
 *
 * 用法（打包后）：
 *   node dist-api/standalone.js [--port 18787] [--project /path/to/project]
 *
 * 注意：此入口不会初始化 Electron；所有 API 能力均来自 Node 侧的
 * Repository / LLM / KB。首次使用需先创建或打开项目。
 */
import { installMainProcessShim } from './shim'
import { registerApiRoutes } from './routes'
import { startLocalApiServer, DEFAULT_PORT } from './http-server'
import { openProject } from './project-manager'
import { ensureVelaHome } from '../utils/config-utils'

function parseArgs(argv: string[]): { port: number; project?: string } {
  let port = DEFAULT_PORT
  let project: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if ((arg === '--port' || arg === '-p') && argv[i + 1]) port = Number(argv[++i])
    if ((arg === '--project' || arg === '-P') && argv[i + 1]) project = argv[++i]
  }
  return { port, project }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  ensureVelaHome()
  installMainProcessShim()
  registerApiRoutes()

  if (args.project) {
    const project = openProject(args.project)
    console.log(`[Vela API] 已打开项目: ${project.name} (${project.path})`)
  }

  const { port } = await startLocalApiServer(args.port)
  console.log(`[Vela API] 独立模式运行中：http://127.0.0.1:${port}`)
}

main().catch((err) => {
  console.error('[Vela API] 启动失败:', err)
  process.exit(1)
})
