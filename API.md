# Vela 本地 HTTP API 文档

将 Vela 的创作工作流（架构 → 目录 → 章节 → 审阅 → 精修 → 定稿）通过本地 HTTP 接口对外提供。桌面 GUI 运行期间，服务在同一进程内自动启动；也可使用无头（headless）模式单独运行。

## 通用约定

- **Base URL**：`http://127.0.0.1:18787`
- **绑定地址**：仅 `127.0.0.1`，只允许本机访问，**免鉴权**，不对外暴露
- **请求格式**：POST 请求体为 JSON（`Content-Type: application/json`），请求体上限 10MB
- **CORS**：已开放（`Access-Control-Allow-Origin: *`），本机网页 / 脚本可直接调用
- **模型参数覆盖**：任意工作流端点都可在 body 中传入以下字段覆盖默认采样配置：
  - `modelId`（string）：模型 ID
  - `temperature`（number）：采样温度
  - `maxTokens`（number）：最大生成 token 数
- **前置条件**：所有工作流端点（架构 / 目录 / 章节 / 审阅等）需要**先打开一个项目**，否则会返回错误

## 两种响应模式

所有 `POST` 工作流端点支持两种获取结果的方式。

### 1. 缓冲模式（默认）

执行完成后一次性返回 JSON：

```json
{
  "ok": true,
  "result": {},
  "logs": ["过程日志..."],
  "text": "聚合的文本输出"
}
```

### 2. SSE 流式模式

满足以下任一条件即启用：

- URL 增加查询参数 `?stream=true`
- 请求头 `Accept: text/event-stream`

事件（event）类型：

| event      | data 含义                                   |
| ---------- | ------------------------------------------- |
| `log`      | 过程日志（字符串）                          |
| `text`     | 增量文本片段（字符串）                      |
| `progress` | 进度信息                                    |
| `done`     | `{ "ok": true, "result": {...} }，正常结束  |
| `error`    | `{ "ok": false, "statusCode": N, "error": "..." }` |

SSE 数据帧格式：

```
event: text
data: {"..."}

```

### 统一错误格式

非 SSE 响应：

```json
{ "ok": false, "error": "错误信息" }
```

常见状态码：`400`（参数错误）、`404`（路由不存在）、`413`（请求体过大）、`500`（服务端错误）。

---

## 一、系统与项目

### GET /api/health

健康检查。

**响应示例**

```json
{
  "ok": true,
  "service": "vela-local-api",
  "time": "2026-10-09T06:16:03.495Z"
}
```

### GET /api/projects/recent

获取最近打开的项目列表。

**响应示例**

```json
{
  "ok": true,
  "projects": [
    {
      "name": "荒年：我靠爆改村庄成了天下粮仓",
      "path": "/Users/guodongjun/Documents/xs/荒年：我靠爆改村庄成了天下粮仓",
      "updatedAt": "2026-10-09T02:58:38.873Z"
    }
  ]
}
```

### POST /api/projects/create

创建新项目。

**请求体**

| 字段             | 类型   | 必填 | 说明                         |
| ---------------- | ------ | ---- | ---------------------------- |
| `name`           | string | 是   | 项目名称                     |
| `basePath` / `path` | string | 否   | 项目存放的父目录             |
| `genre`          | string | 否   | 题材类型（如「历史」）       |
| `targetAudience` | string | 否   | 目标读者                     |

**请求示例**

```bash
curl -X POST http://127.0.0.1:18787/api/projects/create \
  -H "Content-Type: application/json" \
  -d '{"name":"我的小说","basePath":"/Users/guodongjun/Documents/xs","genre":"历史","targetAudience":""}'
```

**响应**：`201`，`{ "ok": true, "project": {...} }`

### POST /api/projects/open

打开项目（后续所有工作流端点的前置步骤）。

**请求体**

| 字段   | 类型   | 必填 | 说明           |
| ------ | ------ | ---- | -------------- |
| `path` | string | 是   | 项目绝对路径   |

**响应示例**

```json
{
  "ok": true,
  "project": {
    "name": "荒年：我靠爆改村庄成了天下粮仓",
    "path": "/Users/guodongjun/Documents/xs/荒年：我靠爆改村庄成了天下粮仓",
    "genre": "历史",
    "targetAudience": "",
    "totalChapters": 100,
    "wordsPerChapter": 3000
  }
}
```

---

## 二、世界观架构

按顺序调用，逐步构建作品设定。均为 POST；body 可传 `guidance`（可选引导语）以及模型覆盖参数。

| 端点                             | 作用                       | 关键入参        |
| -------------------------------- | -------------------------- | --------------- |
| `/api/architecture/config`       | 一句话创意 → 全局配置      | `idea`（必填）  |
| `/api/architecture/premise`      | 生成故事主线 / 前提        | `guidance?`     |
| `/api/architecture/characters`   | 生成人物设定               | `guidance?`     |
| `/api/architecture/worldbuilding`| 生成世界观设定             | `guidance?`     |
| `/api/architecture/synopsis`     | 生成总纲 / 剧情梗概        | `guidance?`     |

**示例：根据一句话创意生成全局配置**

```bash
curl -X POST http://127.0.0.1:18787/api/architecture/config \
  -H "Content-Type: application/json" \
  -d '{"idea":"少年穿越荒年，靠改造村庄成为天下粮仓","temperature":0.8}'
```

---

## 三、章节目录

### POST /api/directory

生成章节蓝图（细纲）。

**请求体**

| 字段             | 类型   | 必填 | 说明                                      |
| ---------------- | ------ | ---- | ----------------------------------------- |
| `mode`           | string | 否   | `full`（默认，全量）或 `append`（追加）   |
| `startChapter`   | number | 否   | 起始章节号                                |
| `count`          | number | 否   | 生成章节数量                              |
| `pacingGuidance` | string | 否   | 节奏要求 / 引导语                         |

**请求示例**

```json
{
  "mode": "full",
  "startChapter": 1,
  "count": 20,
  "pacingGuidance": "前期节奏快，快速建立荒年困境"
}
```

---

## 四、章节正文

### POST /api/chapters/generate

生成某一章正文（建议配合 SSE 使用以获得实时输出）。

**请求体**

| 字段                 | 类型   | 必填 | 说明                 |
| -------------------- | ------ | ---- | -------------------- |
| `chapterNumber`      | number | 是   | 章节号               |
| `title`              | string | 否   | 章节标题             |
| `userGuidance`       | string | 否   | 写作要求 / 引导语    |
| `knowledgeQueryHint` | string | 否   | 知识库检索提示       |

客户端断开连接时，会通过 `AbortSignal` 中止生成。

**SSE 请求示例**

```bash
curl -N -X POST "http://127.0.0.1:18787/api/chapters/generate?stream=true" \
  -H "Content-Type: application/json" \
  -d '{"chapterNumber":1,"title":"第一章 旱"}'
```

### GET /api/chapters/finalized

获取已定稿章节列表。

**响应示例**

```json
{
  "ok": true,
  "chapters": [
    { "chapterNumber": 1, "draftId": 12, "wordCount": 3200 }
  ]
}
```

### GET /api/drafts?chapter=N

获取某一章的草稿列表。

- Query 参数 `chapter`（必填，正整数）

**响应**：`{ "ok": true, "drafts": [...] }`

缺少或非法 `chapter` 时返回 `400`。

---

## 五、审阅 / 精修 / 合并 / 定稿

路径参数 `:id` 为草稿 ID（draftId）。

| 端点                           | 方法 | 作用                              | 请求体                                       |
| ------------------------------ | ---- | --------------------------------- | -------------------------------------------- |
| `/api/drafts/:id/review`       | POST | AI 审阅，产出修改意见             | `{ "reviewFocus": "可选审阅重点" }`          |
| `/api/drafts/:id/refine`       | POST | 按意见精修，产出修订稿            | `{ "userRefinePrompt": "可选修改指令" }`     |
| `/api/revisions/:id/merge`     | POST | 合并修订（直接返回 JSON，非 SSE） | 无                                           |
| `/api/drafts/:id/finalize`     | POST | 定稿该章节                        | 无                                           |

**示例：审阅 12 号草稿**

```bash
curl -X POST http://127.0.0.1:18787/api/drafts/12/review \
  -H "Content-Type: application/json" \
  -d '{"reviewFocus":"重点检查人物动机是否合理"}'
```

---

## 典型调用链路

```
POST /api/projects/create   （或 /open）
  └─ POST /api/architecture/config
       └─ /api/architecture/premise
            └─ /api/architecture/characters
                 └─ /api/architecture/worldbuilding
                      └─ /api/architecture/synopsis
                           └─ POST /api/directory
                                └─ POST /api/chapters/generate        （每章）
                                     └─ POST /api/drafts/:id/review
                                          └─ POST /api/drafts/:id/refine
                                               └─ POST /api/revisions/:id/merge
                                                    └─ POST /api/drafts/:id/finalize
```

## 运行方式

- **带 GUI（开发模式）**：`pnpm dev`，启动桌面窗口的同时自动在 `127.0.0.1:18787` 起服务。
- **无头模式**：运行 standalone 入口 `node dist-api/standalone.mjs`，仅启动 HTTP 服务而不打开窗口。
- **打包正式应用**：`pnpm build`，产物位于 `release/`（macOS 为 `.dmg` / `.app`）。

> 提示：若升级 / 切换了 Electron 版本或重新安装依赖后出现
> `NODE_MODULE_VERSION ... requires ...` 错误，请重新执行 `pnpm rebuild`
> （即 `electron-rebuild -f -w better-sqlite3`）以针对 Electron 重编译原生模块。
