/**
 * 项目管理服务 —— 创建 / 打开 / 最近项目
 *
 * 复刻 project-controller 的逻辑（不依赖 Electron dialog），
 * 运行于主进程并同步设置 API 侧的当前项目路径。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  readJsonFile,
  writeJsonFile,
  RECENT_PROJECTS_PATH,
} from '../utils/config-utils'
import { DIR_VELA_INTERNAL, DIR_PROMPTS } from '../../src/shared/project-paths'
import { initProjectDatabase } from '../database'
import { ProjectCoreRepository } from '../repositories/project-core-repository'
import { setActiveProjectPath } from './workflow-helpers'

interface RecentProject {
  name: string
  path: string
  updatedAt: string
}

export interface ProjectSummary {
  name: string
  path: string
  genre: string
  targetAudience: string
  totalChapters: number
  wordsPerChapter: number
}

function loadRecent(): RecentProject[] {
  return readJsonFile<RecentProject[]>(RECENT_PROJECTS_PATH, [])
}

function addRecent(project: RecentProject): void {
  const list = loadRecent().filter((p) => p.path !== project.path)
  list.unshift(project)
  writeJsonFile(RECENT_PROJECTS_PATH, list.slice(0, 20))
}

/** 创建新项目 */
export function createProject(config: {
  name: string
  basePath: string
  genre: string
  targetAudience: string
}): ProjectSummary {
  if (!config.name?.trim()) throw new Error('缺少项目名称 name')
  if (!config.basePath?.trim()) throw new Error('缺少保存位置 basePath')

  const projectDir = path.join(config.basePath, config.name)
  if (fs.existsSync(path.join(projectDir, '.vela', 'vela.db'))) {
    throw new Error('该目录已存在项目，请直接打开')
  }

  fs.mkdirSync(path.join(projectDir, DIR_VELA_INTERNAL), { recursive: true })
  fs.mkdirSync(path.join(projectDir, DIR_PROMPTS), { recursive: true })

  initProjectDatabase(projectDir)
  ProjectCoreRepository.init(config.name)
  ProjectCoreRepository.update({
    genre: config.genre,
    targetAudience: config.targetAudience,
  })

  const now = new Date().toISOString()
  addRecent({ name: config.name, path: projectDir, updatedAt: now })
  setActiveProjectPath(projectDir)

  const core = ProjectCoreRepository.get()!
  return {
    name: config.name,
    path: projectDir,
    genre: core.genre,
    targetAudience: core.targetAudience,
    totalChapters: core.totalChapters,
    wordsPerChapter: core.wordsPerChapter,
  }
}

/** 打开已有项目，返回项目摘要 */
export function openProject(projectPath: string): ProjectSummary {
  if (!projectPath?.trim()) throw new Error('缺少项目路径 path')
  if (!fs.existsSync(projectPath)) throw new Error('目录不存在')
  if (!fs.existsSync(path.join(projectPath, '.vela', 'vela.db'))) {
    throw new Error('该目录不是有效的 Vela 项目（缺少 .vela/vela.db）')
  }

  initProjectDatabase(projectPath)
  let core = ProjectCoreRepository.get()
  if (!core) {
    ProjectCoreRepository.init(path.basename(projectPath))
    core = ProjectCoreRepository.get()!
  }

  const now = new Date().toISOString()
  addRecent({ name: core.projectName, path: projectPath, updatedAt: now })
  setActiveProjectPath(projectPath)

  return {
    name: core.projectName,
    path: projectPath,
    genre: core.genre,
    targetAudience: core.targetAudience,
    totalChapters: core.totalChapters,
    wordsPerChapter: core.wordsPerChapter,
  }
}

/** 列出最近项目 */
export function listRecentProjects(): RecentProject[] {
  return loadRecent()
}
