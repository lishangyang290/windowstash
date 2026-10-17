# WindowStash 交互式发布

发布入口：Windows 双击根目录的 **WindowStash Release.cmd**，macOS 在 Finder 双击 **WindowStash Release.command**，或在终端运行 `npm run release`。粘贴发布信息，以单独一行 `:end` 结束，检查解析结果，最后输入提示要求的完整确认文字。程序只在本次终端会话内运行，结束后保留结果供查看。

## 首次准备

需要 Node.js 22.12+、npm、Git，以及对发布仓库的推送权限。首次在根目录和 companion 目录分别运行 `npm ci` 安装项目依赖；工具不会自动安装。GitHub CLI 已安装并认证时可自动查询构建和附件状态；不可用时须通过显示的网页确认 Release 是否完成。桌面构建环境见[根 README](../README.md#开发环境)。

macOS 启动文件兼容 Homebrew（Apple Silicon / Intel）、Volta、fnm 默认别名、nvm 与 asdf 常见路径，须保留 `.command` 的 Git 可执行模式 100755。Windows 入口调用 Node 脚本；使用自定义安装目录时，应自行确认当前终端能找到 Node/npm/Git，不由发布工具修改系统环境。

正式发布前必须位于干净的 main，本地 main、origin/main 和实时远端 main 均一致。工具不自动 pull、merge、rebase，也不清理用户文件。如果 tracking 引用过期，请自行检查并同步。网络、权限、Tag 或 Release 检查失败会停止。

## 推荐粘贴格式

以下仅为版本升级示例，不表示已批准发布 v0.6.0；实际版本、HEAD 和测试结果必须重新核对。

```text
当前版本：v0.5.0
目标版本：0.6.0

更新说明：
- 增加 Windows Companion 安装支持
- 完善共享工作区同步及冲突保护

main HEAD：
填写本次核对的 main 提交

测试：
填写本次实际检查结果
:end
```

目标版本也可写成 `版本：v0.6.0`、`WindowStash v0.6.0`、Markdown 标题或明确的版本升级描述。支持 Markdown 列表、常见粘贴文案和开发总结；测试、文件、合并报告与代码日志会尽量排除。text / markdown 围栏中的发布文本也可识别。文字不会被当作 Shell 命令执行，不使用 AI API，不联网识别。

版本依上下文识别，多个候选会要求人工选择；缺少版本或说明会要求补充。菜单可修改版本、说明或重新粘贴。不确定的自然语言应使用标准格式，并人工检查结果。Git 提交和测试信息仅作参考，工具会重新读取 Git 状态并执行项目检查。

## 发布步骤

1. 只读检查 main、工作区、冲突、远端地址与提交、递增版本、本地/远端 Tag、GitHub Release。
2. 生成七个版本文件的更新（九处正式声明），只改 JSON 版本键和 Cargo 对应包的版本；生成新 Release Notes，更新教程中的 `WindowStash-vX.Y.Z` 安装包名称。
3. 执行既有版本一致性检查、发布工具测试、Extension 与 Companion 的 Test / Lint / Typecheck / Build、git diff --check。各端 Build 已包含正式隐私检查，避免重复运行。不在本地构建 macOS .app。
4. 展示修改、说明、检查与 Commit / Tag，要求明确输入 `发布 vX.Y.Z`。确认后再次检查文件与远端，才暂存本次文件、提交、推送 main，在准确的发布提交上创建和推送 Tag。
5. 使用现有 [release.yml](../.github/workflows/release.yml) 构建 Windows x64 与 macOS arm64 附件；两端均成功后才发布，不创建空 Release。gh 可用时等待最多 15 分钟，每约 12 秒查询匹配 Tag 和提交的真实 Job/Step，显示当前任务及成功、跳过、未成功数量。支持终端原地进度更新；重定向、`TERM=dumb` 或 `NO_COLOR` 使用纯文本摘要。单次查询超过 30 秒会停止等待并保留最后确认状态。仅 Workflow 成功且所需 ZIP 非空才报告成功。等待超时或状态无法确认时给出网页，不把 Tag 推送等同于 Release 成功。Ctrl+C 可结束等待。

## 当前附件与教程

[assemble-release.mjs](../scripts/assemble-release.mjs) 生成 `WindowStash-vX.Y.Z-Windows-x64.zip`、`WindowStash-vX.Y.Z-macOS-arm64.zip`，Windows 另附独立 `WindowStash-vX.Y.Z-Windows-x64-setup.exe`。ZIP 根文件夹内为：

- `Chrome Extension/`。
- Windows 中文 NSIS 安装器，或 macOS `WindowStash Companion.app`。
- `开始使用.html` 和只引导打开 HTML 的 `README.txt`。

macOS 当前打包 `.app`，未配置 Apple 公证；`.pkg` 尚待实机验收，不在现有附件中。Windows 中文安装与 Host 自动覆盖已验证，但发布仍须完成对应版本检查。

教程包名由现有版本替换机制更新，不提前修改开发版本声明。WXT 构建先由 [generate-extension-guide.ts](../scripts/generate-extension-guide.ts) 注入 `schema.sql` 和项目设置并外置脚本；Release 根教程再从同一生成结果内联脚本，保持可独立双击。产物校验同时核对两份教程的 SQL 与仓库 schema。数据库行为不由发布脚本修改，旧库升级按[受控流程](../README.md#supabase-初始化与升级)另行确认。

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

## 解析能力

文本解析使用 [Marked](https://github.com/markedjs/marked) lexer，依赖锁定在 package-lock 中，不渲染 HTML。上下文规则处理版本候选和元数据排除；进程、交互、文件读写与发布工具测试使用 Node.js 内置能力。

## 验证边界

不要为文档或入口验收运行正式发布。可运行发布工具测试，并在明确允许联网查询时使用 `--dry-run`；开发分支会被正式发布前提拦截。版本准备、取消恢复、测试及推送失败等路径使用临时 Git 仓库验证，无需改动真实 main。

真实 Finder / Windows 双击体验与 macOS `.pkg` 安装验收属于人工平台检查，不能由 CLI 自动化结果代替。是否合并 main、推送或正式发布均需单独授权；文档维护不触发 Actions，也不创建 Tag 或 Release。
