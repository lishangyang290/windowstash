# WindowStash

WindowStash 是一个“以工作任务为单位”的 Chrome 工作区管理扩展。它把当前 Chrome 窗口保存为一个 Workspace，在本地写入成功后可安全关闭这个窗口；继续工作时，再在新窗口中按原顺序恢复标签页、Pinned 状态和活动标签页。

核心边界是：**一个 Chrome Window = 一个 Workspace**。保存操作始终携带并校验用户点击扩展时所在窗口的 `windowId`，不会读取或关闭其他 Chrome 窗口。

## 核心工作流

1. 在需要暂存的 Chrome 窗口点击 WindowStash。
2. 确认标签页预览，填写 Workspace 名称与状态。
3. 选择“保存”或“保存并关闭”。
4. WindowStash 先写入 `chrome.storage.local`，成功后标记为 `pending` 并尝试同步 Supabase。
5. 即使断网，已成功本地保存的窗口仍可关闭；恢复网络后后台定时补传。
6. 在 Workspace 管理器中点击“恢复”，新 Chrome 窗口会重建标签页现场，并与原 Workspace 临时绑定。之后从该窗口再次保存时会更新原 Workspace。

V1 仅保存标签页标题、URL、顺序、Pinned 状态、活动标签页及 Workspace 元数据；不保存 Cookie、网页正文、密码、表单、LocalStorage、页面 Session 或截图。

## 技术栈

- WXT + React + TypeScript
- Chrome Manifest V3
- `chrome.storage.local`（Local First）
- Supabase Auth + Postgres + RLS
- `@supabase/supabase-js`
- Vitest + ESLint

## 开发环境

- Node.js 20+（建议使用当前 LTS）
- npm 10+
- Chrome 120+
- 可选：Supabase 项目。未配置时本地保存、恢复、管理仍可使用。

## 安装与运行

```bash
npm install
npm run dev
```

WXT 开发模式会生成并运行扩展开发构建。生产构建：

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

生产输出目录为 `.output/chrome-mv3/`。

## 加载到 Chrome

1. 执行 `npm run build`。
2. 打开 `chrome://extensions`。
3. 开启右上角 **Developer mode / 开发者模式**。
4. 点击 **Load unpacked / 加载已解压的扩展程序**。
5. 选择本项目的 `.output/chrome-mv3/` 目录。
6. 将 WindowStash 固定到浏览器工具栏。

每次重新构建后，在 `chrome://extensions` 中点击扩展卡片上的刷新按钮。

## Supabase 配置

### 1. 创建数据库结构和 RLS

在 Supabase Dashboard 打开 **SQL Editor**，完整执行 [`supabase/schema.sql`](./supabase/schema.sql)。脚本会创建：

- 单表 `public.workspaces`，其中 `tabs` 使用 `jsonb`
- `user_id` 与 `updated_at` 索引
- `updated_at` 数据库触发器
- `active / review / revision / archived` 状态约束
- 开启 RLS，并为 select / insert / update / delete 创建仅限 `auth.uid() = user_id` 的策略

### 2. 配置 Email + Password Auth

在 **Authentication → Providers → Email** 启用 Email provider。开发阶段如保留邮件确认，注册后需要先点击验证邮件；也可以仅在本地测试项目中关闭 Confirm email。

### 3. 连接 Supabase

正式版本首次打开时，在 WindowStash 的连接界面填写 Project URL 和 Publishable Key。配置仅保存在本机 `chrome.storage.local`，切换项目时会退出旧项目账号，不会删除本地 Workspace 副本。

本地开发可以复制 `.env.example` 为 `.env`，用环境变量预填连接表单：

```bash
cp .env.example .env
```

在 Supabase Dashboard 的 **Project Settings → API** 填入：

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_OR_ANON_KEY
```

`.env` 只服务于开发模式，不会成为正式版本的运行时配置。唯一正式构建命令是 `npm run build`，构建完成后会自动扫描产物，防止 Supabase 配置泄漏。扩展内打开 Workspace 管理器，点击右上角“登录”，即可注册测试账号并登录。

> 客户端只能使用 Supabase publishable key（或旧项目的 anon key）。绝对不要把 `service_role` key 写入 `.env`、源代码或扩展构建产物。

## 本地优先与云同步

每次保存严格按以下顺序执行：

1. 写入 `chrome.storage.local`。
2. 标记 `syncStatus = pending`。
3. 请求后台 Sync Engine 同步 Supabase。
4. 云端成功后标记 `synced`；失败标记 `failed`，定时任务会重试。

内容 Hash 使用 Web Crypto SHA-256，仅包含 `name`、`status`、`tabs`、`activeTabIndex`。时间戳和同步元数据不会参与 Hash。若本地有未同步修改，同时云端在上次成功同步后也有变化，则标记 `conflict`，由用户选择“使用本机版本”或“使用云端版本”，不做自动 merge。

离线删除会先在本地隐藏 Workspace，并创建 tombstone。云端删除成功前 tombstone 会阻止该记录被再次下载。

## 30 天本地保留规则

保存、修改、恢复或从云端下载时，`localExpiresAt` 都会刷新为当前时间后 30 天。后台每天检查一次：

- 仅当本地副本已经过期且 `syncStatus === synced` 时才允许清理。
- `pending`、`failed`、`conflict` 无论过期多久都不会自动删除。
- 清理本地副本不会删除 Supabase 数据；Dashboard 下次同步会从云端重建本地副本并重新开始 30 天倒计时。

## 权限与安全

扩展只固定申请 `tabs`、`storage`、`alarms` 和 `favicon`。Chrome 的 `windows` API 本身不要求声明同名权限，读取窗口内标签页标题与 URL 由 `tabs` 权限提供。连接时只为用户填写的 Supabase 域名请求可选访问权限，不会申请 history、bookmarks、cookies 或 webRequest。Supabase 配置与 session 通过扩展专用的 `chrome.storage.local` adapter 持久化，Popup、Dashboard 和 background service worker 可共享登录状态。

## 项目结构

```text
src/
├── components/              # 通用 UI
├── entrypoints/
│   ├── background.ts        # MV3 service worker、alarm 与同步触发
│   ├── popup/               # 当前窗口保存入口
│   └── options/             # Workspace 管理器、登录、日志
├── features/workspaces/     # 保存、恢复、更新、删除业务流程
├── lib/
│   ├── storage/             # chrome.storage.local repositories
│   ├── supabase/            # Auth adapter 与云端 repository
│   ├── sync/                # 独立 Sync Engine
│   ├── hash.ts              # 内容 SHA-256
│   └── syncRules.ts         # 同步决策与清理规则
├── styles/                  # 共享样式 token
└── types/                   # Workspace、同步与消息类型
supabase/schema.sql          # 数据表、trigger、index、RLS
```
