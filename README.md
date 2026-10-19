# WindowStash

WindowStash 是一个 Chrome 工作区管理工具，可将窗口中的标签页保存为工作区，稍后恢复。Chrome 扩展负责浏览器操作，Companion 提供 Windows 托盘和 macOS 菜单栏入口，数据通过用户自己的 Supabase 项目同步。

安装步骤见安装包中的「开始使用.html」，或查看[教程源文件](public/开始使用.html)。

## 核心功能

- 保存或保存并关闭当前窗口，记录标题、URL、顺序、固定状态及活动标签页。
- 恢复工作区、关联已打开窗口，并延迟加载暂未使用的标签页。
- Windows 系统托盘、macOS 菜单栏提供工作区入口；浏览器窗口操作由扩展执行。
- 先保存到本地，再同步到云端；支持离线重试、账号隔离和冲突副本保护。
- 在浏览器中授权 Companion 使用已有账号，通过诊断中心查看及导入、导出同步记录。

工作区只记录标签页及其元数据，不保存 Cookie、密码、表单、网页正文或网页运行时 Session。网站登录状态仍由浏览器和网站管理。

## 整体架构

| 组件 | 职责 |
| --- | --- |
| Chrome 扩展 | MV3 service worker、弹窗和管理页；保存、恢复及关联窗口，维护浏览器本地数据，触发同步 |
| Companion | Tauri 桌面应用；托盘或菜单栏界面、账号授权入口、独立后台同步及工作区缓存 |
| Native Host / Rust 库 | Chrome Native Messaging、授权路由、集中 Token 刷新、账号分区的本地工作区库与同步租约；Companion 也直接调用同一 Rust 库 |
| Supabase | Email/Password Auth、Postgres、RLS、同步 RPC 与 Realtime；每个用户连接自己的项目 |

扩展通过 Native Messaging 与 Host 通信，Companion 通过 Tauri 命令调用 Rust。两端关联后共享本机工作区库，由同步租约协调并发访问，并使用 [shared/](shared/) 中的协议访问 Supabase。

Realtime 事件触发一次同步检查；启动和重连时也会读取完整快照，核对工作区及删除标记。客户端不直接使用事件载荷更新工作区，也不将云端列表中缺失的记录视为已删除。

扩展未关联 Companion 时使用独立的本地存储和云同步流程。完成关联后，Companion 可在 Chrome 关闭时继续同步；恢复工作区仍需要 Chrome 和已启用的扩展。

## 技术栈

- 扩展：WXT 0.21、Chrome Manifest V3、React 19、TypeScript 5.9。
- 桌面：Tauri 2、Rust 2021 edition、React、Vite 8、系统 WebView。
- 数据：`chrome.storage.local`、Companion 本地缓存、Rust 文件存储和文件锁、Supabase JS 2。
- 验证：Vitest、ESLint、TypeScript、Rust tests、Node.js 测试脚本。

依赖范围见 [package.json](package.json)、[companion/package.json](companion/package.json) 和 Native Host 的 [Cargo.toml](companion/native-host/Cargo.toml)，安装版本由各自 lockfile 锁定。

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

需要 Node.js 22.12+、npm、Git 和 Chrome。该 Node 版本同时满足 WXT 与 Vite 8 的要求。桌面开发还需要 Rust/Cargo 及对应平台的原生工具链。

| 平台 | 桌面开发要求 | 安装包 |
| --- | --- | --- |
| Windows x64 | MSVC x64 Rust 工具链、Visual Studio C++ Build Tools / Windows SDK、WebView2 Runtime | 中文 NSIS 安装器，安装到当前用户；须在 Windows x64 主机构建 |
| macOS | Xcode Command Line Tools、Rust、系统 WebView | Apple Silicon arm64 `.pkg` 安装器，内含完整 `.app`；Tauri 配置最低 macOS 12.0 |

Windows 构建脚本会选择已安装的 `*-x86_64-pc-windows-msvc` 工具链。单独运行 Cargo 或 Host 脚本时也应选择该工具链，避免生成 GNU 目标文件。macOS 应用使用 ad-hoc 签名，`.pkg` 未使用 Apple 开发者签名，也未完成 Apple 公证，仍可能被 Gatekeeper 阻止。`.pkg` 覆盖旧版 `.app`、重复安装及主要功能已通过本机实机验收；这不代表已解决公开分发的系统安全限制。

## 本地开发与运行

以下命令除注明外均在仓库根目录执行：

```sh
npm ci
npm --prefix companion ci
npm run dev
```

扩展开发输出位于 `.output/chrome-mv3-dev/`。在 `chrome://extensions` 开启开发者模式，选择「加载已解压的扩展程序」并加载该目录。生产构建目录为 `.output/chrome-mv3/`。后续重建时保持加载目录不变，刷新原扩展即可保留扩展身份。

仅调试桌面前端时运行第一个命令；需要原生命令时运行第二个：

```sh
npm --prefix companion run dev
npm --prefix companion run tauri -- dev
```

`tauri dev` 会准备 Host 并启动桌面应用。应用启动或登录时注册当前用户的 Chrome Native Messaging 组件，因此运行开发版会更新该用户的组件注册路径。

可参照 [.env.example](.env.example) 在根目录创建 `.env`，使用 `VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY` 预填开发连接表单。正式版本通过界面保存连接配置，不读取这些开发环境变量；构建脚本会扫描私人配置是否混入产物。不要提交真实项目地址、密钥或 Session，客户端只能使用 publishable key 或兼容的 anon key，不能使用 secret / service_role key。

## 构建

```sh
# Chrome 扩展，含教程生成及正式产物隐私检查
npm run build

# Windows x64，在 Windows 执行
npm --prefix companion run tauri:build:windows

# macOS，在 macOS 执行
npm --prefix companion run tauri:build:mac
npm --prefix companion run pkg:build:mac
```

Windows 安装器输出在 `companion/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`，macOS `.app` 输出在 `companion/src-tauri/target/release/bundle/macos/`。`pkg:build:mac` 使用系统 `pkgbuild`、`productbuild` 将已构建的 `.app` 打包到 `companion/src-tauri/target/release/bundle/pkg/`；macOS 发行 ZIP 包含 `.pkg`。Tauri 构建前会自动编译 Host，将其复制到应用打包目录，并构建前端。

`npm --prefix companion run build` 只构建前端。`tauri:build` 是 macOS 构建命令的别名；Windows 使用 `tauri:build:windows`。

单独构建 Host 时，在根目录执行 `node scripts/build-native-host.mjs`，输出位于 `companion/native-host/target/<target>/release/`。目标由 `TAURI_ENV_TARGET_TRIPLE` 指定，未设置时从 `rustc -vV` 获取。运行前需自行准备对应工具链。

## Supabase 初始化与升级

| 场景 | 流程 |
| --- | --- |
| 新项目 | 在 SQL Editor 一次完整执行 [schema.sql](supabase/schema.sql)，再用 [verify_workspace_sync_v1.sql](supabase/verify_workspace_sync_v1.sql) 只读核验；启用 Email 登录，邮件确认按项目设置完成 |
| 已有旧版数据库 | 先检查、备份并在隔离项目验证，经明确批准后执行增量迁移，最后只读核验；不要用完整初始化替代升级 |

### 旧版本升级说明

已有数据库按以下顺序升级。软件更新不会自动执行数据库迁移，请保留原项目和账号，不要重复运行新项目的初始化脚本。

1. 使用 [inspect_workspace_sync.sql](supabase/inspect_workspace_sync.sql) 检查现有结构、权限与发布配置。
2. 按 [export_workspace_data.sql](supabase/export_workspace_data.sql) 导出并保存备份；暂停编辑，避免升级期间新旧客户端同时写入。
3. 在隔离项目验证后，经项目所有者确认，完整执行 [20261014_workspace_sync_v1.sql](supabase/migrations/20261014_workspace_sync_v1.sql)。
4. 执行 [verify_workspace_sync_v1.sql](supabase/verify_workspace_sync_v1.sql)，所有检查均应为 `true`；若有失败项，使用 [check_workspace_sync_state.sql](supabase/check_workspace_sync_state.sql) 核对当前状态，再排查原因，不要清空重建。

导出查询返回的 `data_sql` 内容应完整保存为 UTF-8 `.sql` 文件。它只备份工作区数据，不包含 Auth 用户、数据库结构或权限，不能代替完整项目备份。恢复只能在经批准的独立、空白且结构兼容的表中进行，并保留匹配的用户 ID；不能用它覆盖原库或作为原地回滚脚本。

初始化脚本包含增量迁移的完整定义，两者均使用事务及超时控制。升级保留已有工作区，但无法为升级前已删除的记录补建删除标记。静态 SQL 检查之外，仍需在隔离数据库验证 PostgreSQL 执行、RLS、并发和 Realtime 行为。

当前协议使用 `workspaces` 和 `workspace_tombstones`，以及 `windowstash_snapshot_v1`、`windowstash_put_v1`、`windowstash_delete_v1` 三个 RPC。RLS 按 `auth.uid()` 限定归属；客户端只能读取自己的删除标记，写入由受控删除函数及触发器完成。旧客户端直接写入也受工作区保护触发器约束。Realtime 发布工作区 INSERT/UPDATE 和删除标记 INSERT，客户端不依赖 DELETE 载荷恢复状态。

## 授权、本地数据与同步

在扩展中配置项目并登录后，Companion 可发起浏览器授权。用户确认账号后，Companion 复用其项目配置和登录状态。授权 URL 只传一次性请求标识，凭据通过 Native Messaging 传递。关联后的 Refresh Token 由 Rust 组件在独立文件锁保护下轮换，Companion WebView 仅接收短期 Access Token。Windows 下的 curl 子进程设置 `CREATE_NO_WINDOW`，避免后台认证时弹出控制台。

数据空间使用规范化项目 URL 与用户 ID，浏览器 Profile 只负责路由。切换账号隐藏旧空间，不删除其本地数据；后台迟到响应仍受账号及修订检查约束。旧版无明确归属的数据只通过用户确认的恢复入口迁移，详见 [账号隔离说明](docs/account-isolation.md)。

Host 数据根目录为 Windows `%LOCALAPPDATA%/app.windowstash.companion/bridge/`、macOS `~/Library/Application Support/app.windowstash.companion/bridge/`，其中 `accounts/` 为授权存储，`workspace-library/` 为账号分区工作区库。测试可用 `WINDOWSTASH_BRIDGE_DIR` 指向临时根目录，禁止指向真实用户目录进行破坏性测试。

保存先写浏览器本地存储，再等待云端同步；云端请求失败不影响已经保存的本地数据。上传时比较服务器 `updated_at` 与上次同步基线，内容 SHA-256 不包含同步状态和时间戳。并发修改会保留冲突及版本副本，交由用户选择；离线删除进入队列，云端删除标记阻止旧副本重新上传。网络错误保留本地数据，稍后重试。

## 恢复与数据安全

- 保存、关闭仅针对用户操作的 Chrome 窗口；恢复优先激活有效关联，否则重建标签页现场。
- 懒加载记录和窗口关联按账号存储，启动时重新核对。修改恢复逻辑时，应保留占位页对应的原网页信息。
- 本地副本采用 30 天到期时间；清理规则只允许清理已同步的到期副本，待同步、失败、冲突数据不自动删除。清理本地副本不等于删除云端记录。
- 不清理用户工作区、冲突副本或删除队列来修复同步问题。卸载扩展会失去其本地存储，未同步数据不能依赖云端找回。
- 授权文件属于本机用户私有数据；当前信任模型接受同一系统用户恶意替换组件的残余风险，不声称抵御该类攻击。

## 测试、诊断与排查

常用检查命令如下，按修改范围选择执行：

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

Rust 测试需要对应平台工具链。构建 Host 后，可运行 `node scripts/verify-browser-auth.mjs`，通过临时 HTTP 服务验证认证流程；`node scripts/verify-native-host-production.mjs` 检查正式 Host 的安全限制。在 Windows 设置进程环境变量 `WINDOWSTASH_VERIFY_WINDOWS_CONSOLE=1`，可在测试认证及刷新请求期间检查 curl 的 PID、父进程、路径和窗口可见性，测试结束后不保留监控。

诊断中心支持查看、导入及导出结构化记录，包含操作关联、组件、构建标识、租约和错误码；导出内容经过字段筛选。排查时先核对账号、实际运行路径、Native Messaging 注册和最近同步记录，保留原始数据。

Windows 安装器会覆盖并校验 Companion 和 Host 文件。旧 Host 进程可继续处理原连接，连接结束后退出；确认更新时需要同时核对文件和运行进程。

macOS 双击 `.pkg`，按系统向导安装或覆盖更新到 `/Applications/WindowStash Companion.app`，完成后打开应用。安装器处理该安装目录内的 Companion 和 Host 进程，无需手动退出 Companion，保留用户数据及自启动偏好；进程无法正常退出时停止安装，不强制结束。安装失败不能保证自动恢复旧版，应保留原安装包及已有备份。

更新时先安装新版 Companion，再用新版扩展文件覆盖原加载目录，最后在 `chrome://extensions` 刷新原扩展。刷新后重新建立连接，无需停用扩展、退出 Chrome 或重新配置账号。

## 开发约定与发布

修改同步逻辑时，同时检查 `shared/`、Rust 工作区库和独立扩展的兼容流程，保留账号隔离、锁、租约、服务器基线、删除标记及冲突副本保护。数据库变更应提供增量迁移并验证兼容性。开发测试使用模拟服务或明确授权的隔离项目。

用户教程的 SQL 和项目设置分别来自 `supabase/schema.sql`、`supabase/setup-guide.json`。[教程生成器](scripts/generate-extension-guide.ts) 为扩展注入资源并外置脚本以适配 CSP；[Release 教程生成器](scripts/generate-release-guide.mjs) 从同一生成结果内联脚本，形成可直接双击的独立 HTML。修改源教程内嵌内容时运行对应一致性测试。

正式发布流程见 [发布工具说明](docs/release-cli.md)，桌面细节见 [Companion 开发说明](companion/README.md)。Windows 入口为 `WindowStash Release.cmd`，macOS 为 `WindowStash Release.command`。发布工具检查干净且与远端一致的 main，更新版本与教程包名，经明确确认才提交及推送 Tag；CI 按平台构建和校验完整附件后发布。开发分支不可直接用于正式发布。

发布压缩包包含 Chrome 扩展、对应平台的 Companion 和「开始使用.html」；根目录的 `README.txt` 提供教程入口。
