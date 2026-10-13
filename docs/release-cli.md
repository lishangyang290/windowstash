# WindowStash 交互式发布

验收并合并这套工具后，日常发布只需要：macOS 在 Finder 双击项目根目录的 **WindowStash Release.command**，Windows 在资源管理器双击 **WindowStash Release.cmd**。两个入口共用同一发布逻辑。粘贴发布信息，以单独一行 `:end` 结束，检查解析结果，最后输入提示要求的完整确认文字。无需再使用 Codex。程序只在这次终端会话内运行，结束后保留结果供查看。

## 首次准备

需要 Node.js 22 或更新的 LTS、npm、Git，以及对 `lishangyang290/windowstash` 的推送权限。首次在根目录和 companion 目录分别运行 `npm ci` 安装项目依赖；工具不会自动安装。建议安装 GitHub CLI 并执行 `gh auth login`，以自动查询构建和附件状态。未安装或未认证 gh 时仍可发布，但须通过显示的网页确认 Release 是否完成。

启动文件兼容 Homebrew（Apple Silicon / Intel）、Volta、fnm 默认别名、nvm 与 asdf 常见路径。使用自定义 Node 安装目录时，请使 Node/npm 位于终端 PATH 内。文件必须保留可执行权限（755）；Git 添加该文件时会记录为 100755。

Windows 入口用启动文件所在位置定位项目，支持带空格、中文和括号的路径，不需要管理员权限。缺少 Node/npm/Git 或项目依赖时给出中文提示，不自动安装，也不修改系统 PATH、注册表或代理。`.cmd` 保存为 UTF-8 无 BOM、CRLF；`.gitattributes` 固定检出换行，避免批处理解析异常。参数原样传给 Node，例如：

```bat
"WindowStash Release.cmd" --dry-run
"WindowStash Release.cmd" --restore
"WindowStash Release.cmd" --verbose
```

Windows 上工具直接用当前 Node 执行 npm 的 `npm-cli.js`，从 npm 提供的入口、Node 安装目录或已有 PATH 目录定位，不将参数拼接为 shell 命令。Git、Node 和 gh 继续直接执行。程序失败后保留退出码并暂停窗口，便于查看恢复提示。

正式发布前必须位于干净的 main，本地 main、origin/main 和实时远端 main 均一致。工具不自动 pull、merge、rebase，也不清理用户文件。如果 tracking 引用过期，请自行检查并同步。网络、权限、Tag 或 Release 检查失败会停止。

## 推荐粘贴格式

```text
当前版本：v0.3.0
目标版本：0.4.0

更新说明：
- 修复 Chrome 重启后的工作区关联问题
- 新增教程入口，优化复制体验

main HEAD：
56b8e2fe30517972e54cfe9a5ba4befd822f924c

测试：
224 项通过
:end
```

目标版本也可写成 `版本：v0.4.0`、`WindowStash v0.4.0`、Markdown 标题或明确的版本升级描述。支持 Markdown 列表、常见 ChatGPT 文案和 Codex 开发总结；测试、文件、合并报告与代码日志会尽量排除。text / markdown 围栏中的发布文本也可识别。文字不会被当作 Shell 命令执行，不使用 AI API，不联网识别。

版本依上下文识别，多个候选会要求人工选择；缺少版本或说明会要求补充。菜单可修改版本、说明或重新粘贴。不确定的自然语言应使用标准格式，并人工检查结果。Git 提交和测试信息仅作参考，工具会重新读取 Git 状态并执行项目检查。

## 发布步骤

1. 只读检查 main、工作区、冲突、远端地址与提交、递增版本、本地/远端 Tag、GitHub Release。
2. 生成七个版本文件的更新（九处正式声明），只改 JSON 版本键和 Cargo 对应包的版本；生成新 Release Notes，更新教程中的 `WindowStash-vX.Y.Z` 安装包名称。
3. 执行既有版本一致性检查、发布工具测试、Extension 与 Companion 的 Test / Lint / Typecheck / Build、git diff --check。各端 Build 已包含正式隐私检查，避免重复运行。不在本地构建 macOS .app。
4. 展示修改、说明、检查与 Commit / Tag，要求明确输入 `发布 vX.Y.Z`。确认后再次检查文件与远端，才暂存本次文件、提交、推送 main，在准确的发布提交上创建和推送 Tag。
5. 继续使用 `.github/workflows/release.yml`，同一 Tag 在 macOS Apple Silicon 和 Windows x64 Runner 分别构建。两平台均成功后，由唯一发布任务创建草稿、上传全部附件、重新下载并核对 SHA-256，最后才转为正式 Release。gh 可用时等待最多 15 分钟，每约 12 秒查询匹配 Tag 和发布提交的真实 Job/Step，分别显示平台任务状态、已结束/总步骤数及成功、跳过、未成功数量。支持刷新的终端原地更新四行进度，等待耗时每秒刷新；重定向输出、`TERM=dumb` 或 `NO_COLOR` 使用纯文本查询摘要。单次查询超过 30 秒会停止等待并保留最后确认的状态。只有 Workflow 成功且正式 Release 的三个预期附件均非空才报告成功，并显示双平台下载链接。等待超时或状态无法确认时给出网页，不把 Tag 推送等同于 Release 成功。Ctrl+C 可结束等待。

## 双平台产物与安全构建验证

同一个版本 `vX.Y.Z` 的正式 Release 包含以下三个附件，Chrome 扩展仅嵌入各平台完整 ZIP，不重复上传同名扩展附件：

- `WindowStash-vX.Y.Z-macOS-arm64.zip`：原有正式 `.app`、Chrome Extension、教程和 README。
- `WindowStash-vX.Y.Z-Windows-x64.zip`：x64 NSIS 安装程序、Chrome Extension、教程和 README。
- `WindowStash-vX.Y.Z-Windows-x64-setup.exe`：便于已有用户独立更新 Companion。

macOS 使用 `macos-15` arm64 Runner，保留应用签名、隐私扫描和解压验证，并检查 Companion 与 Native Host 为 arm64。Windows 使用 `windows-2022` x64 Runner、Rust MSVC 和现有 `tauri:build:windows` 脚本。验证 NSIS 内确实包含 x64 Companion 和 Native Host，再扫描其内容及最终 ZIP。教程保留 macOS 原步骤，并补充 Windows 安装和通知区域说明。应用 Bundle ID 保持 `app.windowstash.companion`。

不创建真实版本的安全 CI 验证入口是同一工作流的 `workflow_dispatch`。工作流进入默认分支后，可在 GitHub Actions 的 **Release Windows and macOS → Run workflow** 中选择需要验证的分支。使用源码声明的现有版本，运行同样的双平台检查与打包；只上传 `validation-macOS-arm64` 和 `validation-Windows-x64` 临时 Actions artifacts，保留 7 天。此模式不创建 Commit、Tag 或 Release。它独立于本地 `--dry-run`：预演仅检查发布计划，手动 CI 验证会实际构建安装包。

全局及构建任务只授予 `contents: read`，关闭 checkout 凭据持久化。唯一 `publish` 任务需要整个构建矩阵成功，且仅在 `push` 版本 Tag 时获得 `contents: write`；手动验证不会进入它。发布脚本再次核实事件、仓库、版本 Tag 和准确提交。Tag 提交必须位于 main 历史中，版本声明和对应更新说明必须一致。已有同名 Release（包括草稿）均拒绝覆盖；重跑不会使用 `--clobber`。上传或校验失败留下草稿，需要人工检查，不会自动重试或正式公开。

本地回归测试用临时仓库及完全模拟的远端/gh 进程验证 dry-run、取消恢复、失败记录、附件完整性和草稿转正式顺序。ESM 预加载路径通过 `pathToFileURL()` 转换；Git 提交内容核验只统一 CRLF/LF，仍比较完整文本。平台专属入口测试在对应系统执行；其他业务与安全回归测试两平台共用。

## 终端入口和预演

```sh
npm run release
npm run release -- --dry-run
npm run release -- --verbose
npm run test:release
```

`--verbose` 显示底层命令与完整检查输出；默认仅显示步骤和状态。终端使用少量状态颜色，重定向、`NO_COLOR` 或 `TERM=dumb` 时输出纯文本。

`--dry-run` 只解析、查询与展示计划，必须满足同样的 Git 发布前提。它不写版本、Notes 或恢复记录，不运行会生成文件的测试/构建，不创建 Commit/Tag、不推送，也不触发 Actions。它不能代替正式模式的构建验证。当前开发分支上会明确停止，因为正式发布必须在 main。

`--verbose` 保留查询命令日志，Actions 进度使用追加式纯文本摘要，避免原地刷新覆盖诊断输出。

## 取消与恢复

准备前取消没有改动。准备后取消或检查失败，会仅恢复工具自己准备的文件；若发现其他操作改动同一文件，拒绝覆盖。

准备前以独占方式保存 `.windowstash-release.json`（已被 Git 忽略），其中包括原文件、预期内容、原 HEAD、所属进程和成功步骤。记录以 600 权限原子创建和更新，中断不会留下半截 JSON；并发启动不会覆盖或删除另一会话的记录。临时记录文件也被 Git 忽略。进程异常结束后，可检查记录并运行：

```sh
npm run release -- --restore
```

仅原进程已结束、仍在 main、HEAD 未变、尚未提交、暂存区为空且文件仍是原内容/工具准备内容时允许恢复。自动恢复同样检查 HEAD 和暂存区。恢复记录只允许包含规定的版本文件和对应版本 Notes，拒绝越界或重复路径。它不会清理构建目录或用户其他文件。已有记录会阻止下一次发布；请勿同时运行两个发布会话。

已提交或推送阶段失败时，不自动回退、不自动重新提交或重试。按终端提供的记录核实本地 HEAD、Tag 与远端实际引用；网络报错也可能已经完成远端推送。如果提交失败而留下暂存文件，请先核实暂存内容，仅撤销本次发布文件的暂存，再使用 --restore。

main 已推送但 Tag 未推送时，核实发布提交与现有本地 Tag；如果远端确实缺少 Tag，在记录的发布提交上创建/核实本地 Tag，然后仅推送该 Tag。若 Tag 已存在，禁止覆盖。构建失败时查看 Actions 日志，禁止删除/覆盖历史版本。问题处理完成并核实记录后，再手动删除恢复记录。

## 开源解析能力

调查了 [remark/unified](https://github.com/remarkjs/remark)、[mdast-util-from-markdown](https://github.com/syntax-tree/mdast-util-from-markdown) 和 [Marked](https://github.com/markedjs/marked)。前两者适合 AST 插件管线；本工具只需要标题、段落、列表与代码块，因此选用仍在维护、MIT 许可且没有运行时依赖的 Marked，锁定在 package-lock 中。仅使用 lexer，不渲染 HTML。上下文版本判断与元数据排除使用少量规则，不引入完整 Markdown 转换管线。进程、交互、文件读写与自动测试使用 Node.js 自带能力。

## 手动验收

不要为验收运行正式发布。双击对应系统的入口，确认当前版本、路径和中文提示，粘贴示例并用 :end 结束，尝试菜单修改和取消。也可运行 --dry-run，确认开发分支被安全拦截。成功的 main 预演、版本更新、取消恢复、测试失败、推送失败均通过临时 Git 仓库自动测试，无需改动真实 main。

自动化测试通过 CMD 执行 Windows 入口，覆盖无参数启动、help、dry-run、restore、verbose、错误退出、缺少依赖和带空格/中文/括号的路径。真实资源管理器和 Finder 双击的窗口行为仍需人工确认。GitHub Runner 的正式安装包构建与安装验收以手动验证工作流的实际结果为准；本地静态检查不能代替它。合并 main、推送 Tag 和正式发布由用户另行决定。
