# WindowStash

WindowStash 以一个 Chrome 窗口为一个工作区，保存标签页现场，并通过 Chrome 扩展、桌面 Companion 与用户自己的 Supabase 项目在本机及设备间同步。

本文面向开发者和二次开发者，描述 v0.6.0 开发分支的当前实现；正式版本声明仍由各包配置及发布工具管理。普通用户请阅读安装包中的「开始使用.html」，仓库源文件为 [public/开始使用.html](public/开始使用.html)。

## 核心功能

- 保存或保存并关闭当前窗口，记录标题、URL、顺序、固定状态及活动标签页。
- 恢复工作区、关联已打开窗口，并延迟加载暂未使用的标签页。
- Windows 系统托盘、macOS 菜单栏提供工作区入口；浏览器窗口操作由扩展执行。
- 本地优先保存、云端同步、离线重试、账号隔离和冲突副本保护。
- 通过浏览器授权关联 Companion，提供同步诊断记录及导入、导出入口。

保存不包含 Cookie、密码、表单、网页正文或网页运行时 Session，恢复不等于恢复网站登录状态。

## 整体架构

| 组件 | 职责与边界 |
| --- | --- |
| Chrome 扩展 | MV3 service worker、弹窗和管理页；保存、恢复及关联窗口，维护浏览器本地数据，触发同步 |
| Companion | Tauri 桌面应用；托盘或菜单栏界面、账号授权入口、独立后台同步及工作区缓存 |
| Native Host / Rust 库 | Chrome Native Messaging、授权路由、集中 Token 刷新、账号分区的本地工作区库与同步租约；Companion 也直接调用同一 Rust 库 |
| Supabase | Email/Password Auth、Postgres、RLS、同步 RPC 与 Realtime；每个用户连接自己的项目 |

扩展通过 Native Messaging 与 Host 通信；Companion 通过 Tauri 命令调用 Rust。两端关联后共享本机工作区库与同步租约，使用 [shared/](shared/) 中的同步协议访问 Supabase。Realtime 事件用于提示重新校准，启动及重连也执行完整校准，不把事件载荷或云端列表中缺失的记录直接当作删除依据。

未关联 Companion 的扩展保留独立本地与云同步路径。已关联的 Companion 可在 Chrome 关闭时继续同步；恢复浏览器工作区时仍需 Chrome 和已启用的扩展。

## 技术栈

- 扩展：WXT 0.21、Chrome Manifest V3、React 19、TypeScript 5.9。
- 桌面：Tauri 2、Rust 2021 edition、React、Vite 8、系统 WebView。
- 数据：`chrome.storage.local`、Companion 本地缓存、Rust 文件存储和文件锁、Supabase JS 2。
- 验证：Vitest、ESLint、TypeScript、Rust tests、Node.js 测试脚本。

准确依赖范围与锁定版本以 [package.json](package.json)、[companion/package.json](companion/package.json)、各自 lockfile 及 [Cargo.toml](companion/native-host/Cargo.toml) 为准。

## 目录结构

```text
src/
  entrypoints/             # background、popup、options、延迟恢复页面
  features/workspaces/     # 保存、恢复、关联及懒加载
  lib/companion/           # 扩展侧 Native Messaging 与授权
  lib/storage/            # 按账号分区的浏览器存储
  lib/supabase/           # 配置、Auth 与独立扩展云端访问
  lib/sync/               # 同步调度及 Native Host 工作区投影
companion/
  src/                    # 桌面 React 界面与同步
  src-tauri/              # Tauri 命令、平台注册与 Windows NSIS hooks
  native-host/            # Host 可执行文件及两端复用的 Rust 库
shared/                   # 同步、Realtime、诊断协议与测试
supabase/                 # 初始化 SQL、增量迁移及只读核验
scripts/                  # 构建、教程生成、验证与发布
public/开始使用.html       # 独立用户教程源文件
docs/                     # 账号隔离及发布工具说明
.github/workflows/        # 跨平台构建与发布工作流
```

## 开发环境

通用要求：Node.js 22.12+、npm、Git、Chrome；桌面开发还需要 Rust/Cargo 和系统原生工具链。WXT 要求 Node 22+，Vite 8 的 Node 22 分支最低为 22.12。

| 平台 | 桌面开发要求 | 当前打包范围 |
| --- | --- | --- |
| Windows x64 | MSVC x64 Rust 工具链、Visual Studio C++ Build Tools / Windows SDK、WebView2 Runtime | 中文 NSIS 当前用户安装器；构建脚本拒绝非 Windows x64 主机 |
| macOS | Xcode Command Line Tools、Rust、系统 WebView | CI 构建 Apple Silicon arm64 `.app`；Tauri 配置最低 macOS 12.0 |

Windows 构建脚本会选择已安装的 `*-x86_64-pc-windows-msvc` 工具链；单独运行 Cargo 或 Host 脚本时也应选择该工具链，避免默认 GNU 目标混入产物。macOS 当前配置使用 ad-hoc 签名，未配置 Apple 公证；`.pkg` 尚未完成实机验收，不属于当前已确认的分发方式。

## 本地开发与运行

以下命令除注明外均在仓库根目录执行：

```sh
npm ci
npm --prefix companion ci
npm run dev
```

扩展开发输出位于 `.output/chrome-mv3-dev/`；可在 `chrome://extensions` 开启开发者模式，加载生成目录。生产构建目录为 `.output/chrome-mv3/`。保持同一加载目录，在重建后刷新原扩展，避免意外创建新扩展身份。

桌面前端与完整桌面开发分别为：

```sh
npm --prefix companion run dev
npm --prefix companion run tauri -- dev
```

前者只启动 Vite，不能代替原生 Tauri 运行；后者会准备 Host 并启动桌面应用。应用启动或登录时会注册当前用户的 Chrome Native Messaging 组件，开发运行会影响该用户当前注册路径。

可参照 [.env.example](.env.example) 在根目录创建本地 `.env`，使用 `VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY` 预填开发连接表单。日常配置通过界面保存；正式前端代码不读取开发环境配置，构建脚本会扫描产物。不得提交真实项目地址、密钥或 Session；客户端禁止使用 secret / service_role key。

## 构建

```sh
# Chrome 扩展，含教程生成及正式产物隐私检查
npm run build

# Windows x64，在 Windows 执行
npm --prefix companion run tauri:build:windows

# macOS，在 macOS 执行
npm --prefix companion run tauri:build:mac
```

Windows NSIS 输出在 `companion/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`；macOS `.app` 输出在 `companion/src-tauri/target/release/bundle/macos/`。Tauri 的构建 hook 会自动构建 Host、复制 sidecar 并构建前端。`npm --prefix companion run build` 只构建前端；`tauri:build` 是 macOS 命令的别名，Windows 应使用明确的平台命令。

单独准备 Host 可在根目录执行 `node scripts/build-native-host.mjs`，输出为 `companion/native-host/target/<target>/release/`。`TAURI_ENV_TARGET_TRIPLE` 可指定目标，未设置时从 `rustc -vV` 获取；不是自动安装工具链或跨平台打包入口。

## Supabase 初始化与升级

| 场景 | 流程 |
| --- | --- |
| 新项目 | 在 SQL Editor 一次完整执行 [schema.sql](supabase/schema.sql)，再用 [verify_workspace_sync_v1.sql](supabase/verify_workspace_sync_v1.sql) 只读核验；启用 Email 登录，邮件确认按项目设置完成 |
| 已有旧版数据库 | 先检查、备份并在隔离项目验证，经明确批准后执行增量迁移，最后只读核验；不要用完整初始化替代升级 |

旧库受控升级顺序：

1. 使用 [inspect_workspace_sync.sql](supabase/inspect_workspace_sync.sql) 检查现有结构、权限与发布配置。
2. 按 [export_workspace_data.sql](supabase/export_workspace_data.sql) 导出并保存备份；暂停编辑，避免升级期间新旧客户端同时写入。
3. 在隔离项目验证后，经项目所有者确认，完整执行 [20261014_workspace_sync_v1.sql](supabase/migrations/20261014_workspace_sync_v1.sql)。
4. 执行 [verify_workspace_sync_v1.sql](supabase/verify_workspace_sync_v1.sql)，所有检查均应为 `true`；失败时通过 [check_workspace_sync_state.sql](supabase/check_workspace_sync_state.sql) 核对状态，不猜测执行结果或清空重建。

初始化包含完整迁移正文，均使用事务及超时控制。升级保留已有工作区，但无法推断升级前已被删除的历史记录。静态 SQL 测试不等于 PostgreSQL 编译、RLS、并发及 Realtime 实测。

当前协议使用 `workspaces` 和 `workspace_tombstones`，以及 `windowstash_snapshot_v1`、`windowstash_put_v1`、`windowstash_delete_v1` 三个 RPC。RLS 按 `auth.uid()` 限定归属；客户端只能读取自己的删除标记，写入由受控删除函数及触发器完成。旧客户端直接写入也受工作区保护触发器约束。Realtime 发布工作区 INSERT/UPDATE 和删除标记 INSERT，客户端不依赖 DELETE 载荷恢复状态。

## 授权、本地数据与同步

首次在扩展配置项目并登录；Companion 发起浏览器授权，用户确认同一账号后复用其配置。授权 URL 只传一次性请求标识，凭据经 Native Messaging 交接。关联后 Rust 组件在独立刷新文件锁内轮换 Refresh Token，Companion WebView 仅接收短期 Access Token；Windows curl 子进程设置 `CREATE_NO_WINDOW`。

数据空间使用规范化项目 URL 与用户 ID，浏览器 Profile 只负责路由。切换账号隐藏旧空间，不删除其本地数据；后台迟到响应仍受账号及修订检查约束。旧版无明确归属的数据只通过用户确认的恢复入口迁移，详见 [账号隔离说明](docs/account-isolation.md)。

Host 数据根目录为 Windows `%LOCALAPPDATA%/app.windowstash.companion/bridge/`、macOS `~/Library/Application Support/app.windowstash.companion/bridge/`，其中 `accounts/` 为授权存储，`workspace-library/` 为账号分区工作区库。测试可用 `WINDOWSTASH_BRIDGE_DIR` 指向临时根目录，禁止指向真实用户目录进行破坏性测试。

保存先写浏览器本地存储，再标记待同步；本地保存成功不依赖云端请求成功。关联后的扩展与 Companion 共享本机库、同步租约及 RPC 协议；独立扩展仍有兼容同步路径。上传比较服务器 `updated_at` 基线，内容 SHA-256 不含同步状态和时间戳。并发修改保留冲突及版本副本，不静默合并；离线删除排队，云端持久删除标记阻止旧副本重新上传。网络错误保留本地副本并重试。

## 恢复与数据安全

- 保存、关闭仅针对用户操作的 Chrome 窗口；恢复优先激活有效关联，否则重建标签页现场。
- 懒加载记录和窗口关联按账号存储，启动时执行关联与延迟恢复校准。不要把占位页当成原网页内容保存。
- 本地副本采用 30 天到期时间；清理规则只允许清理已同步的到期副本，待同步、失败、冲突数据不自动删除。清理本地副本不等于删除云端记录。
- 不清理用户工作区、冲突副本或删除队列来修复同步问题。卸载扩展会失去其本地存储，未同步数据不能依赖云端找回。
- 授权文件属于本机用户私有数据；当前信任模型接受同一系统用户恶意替换组件的残余风险，不声称抵御该类攻击。

## 测试、诊断与排查

按修改范围选择检查，文档修改不需要完整桌面构建：

```sh
npm test -- scripts/generate-extension-guide.test.ts
node --test scripts/sync-migration-tests.mjs
npm run test:release
npm run typecheck
npm run lint -- --ignore-pattern 'companion/**'
npm --prefix companion test
npm --prefix companion run typecheck
npm --prefix companion run lint
cargo test --locked --manifest-path companion/native-host/Cargo.toml
cargo test --locked --manifest-path companion/src-tauri/Cargo.toml
```

Rust 检查需对应平台工具链。已构建 Host 后，可运行 `node scripts/verify-browser-auth.mjs`（临时认证服务）及 `node scripts/verify-native-host-production.mjs`（生产 Host 安全边界）。Windows 设置进程环境变量 `WINDOWSTASH_VERIFY_WINDOWS_CONSOLE=1` 后，前者会在受控验证和刷新请求中短时探测 curl 的 PID、父进程、路径及窗口可见性；它不是长期监控。

诊断中心可查看、导入及导出结构化记录，使用操作链、组件、构建标识、租约与错误码定位问题，导出经过字段筛选。排查时先核对账号、实际运行路径、Native Messaging 注册及最近同步记录，保留现场数据。安装器会覆盖并核验 Windows 两个程序文件；仍在运行的旧 Host 映像可保留到原连接正常结束，不能仅凭安装器成功断言所有运行进程已更新。

普通更新顺序：先更新 Companion，再覆盖原 Chrome 扩展目录，最后在 `chrome://extensions` 刷新原有扩展；无需停用扩展、退出 Chrome或重配账号。刷新会重新建立扩展连接。

## 二次开发与发布

修改两端同步时同时检查 `shared/`、Rust 工作区库和独立扩展兼容路径；保持账号隔离、锁、租约、服务器基线、删除标记及冲突副本语义。数据库变更使用受控迁移，禁止仅为修改文档改变 SQL 行为。开发测试使用模拟服务或明确授权的隔离项目。

用户教程的 SQL 和项目设置分别来自 `supabase/schema.sql`、`supabase/setup-guide.json`。[教程生成器](scripts/generate-extension-guide.ts) 为扩展注入资源并外置脚本以适配 CSP；[Release 教程生成器](scripts/generate-release-guide.mjs) 从同一生成结果内联脚本，形成可直接双击的独立 HTML。修改源教程内嵌内容时运行对应一致性测试。

正式发布流程见 [发布工具说明](docs/release-cli.md)，桌面细节见 [Companion 开发说明](companion/README.md)。Windows 入口为 `WindowStash Release.cmd`，macOS 为 `WindowStash Release.command`。发布工具检查干净且与远端一致的 main，更新版本与教程包名，经明确确认才提交及推送 Tag；CI 按平台构建和校验完整附件后发布。开发分支不可直接用于正式发布。

Release 根目录只保留简短 `README.txt` 引导打开「开始使用.html」，不重复开发文档。macOS `.pkg` 的安装、升级及签名体验需实机验收后再更新对应教程平台区块；目前不将其描述为已发布功能。
