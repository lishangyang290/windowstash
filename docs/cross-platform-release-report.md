# 双平台发布工具开发与测试报告

日期：2026-10-13。开发分支：`feat/cross-platform-release`。源码正式版本保持 `0.5.0`。

## 开发结果

- 新增根目录 `WindowStash Release.cmd`，通过文件自身位置进入项目，检查 Node/npm/Git 和项目依赖，调用原有 `scripts/release.mjs`，传递参数，保留退出码并暂停窗口。使用 UTF-8 无 BOM、CRLF，`.gitattributes` 固定检出换行；不需要管理员权限，不修改系统环境。
- 保留原有 `WindowStash Release.command` 的全部内容及 Git 记录的 `100755` 权限。两平台仍共用解析、版本校验、Git/远端检查、二次人工确认、版本提交、Tag、失败记录和恢复逻辑；`--dry-run`、`--restore`、中文交互均保留。
- Windows npm 调用改为当前 Node 直接执行 npm 的 JS 入口，保留参数数组和 `shell: false`；Git、Node、gh 使用直接进程调用。
- `.github/workflows/release.yml` 增加 Windows x64 / macOS arm64 构建矩阵，复用现有 Extension、Companion、Native Host 和 NSIS 构建脚本。两个平台保留质量、生产隐私和桥接检查；统一声明 Native Host 目标路径。
- `assemble-release.mjs` 负责共享的扩展、教程与 README 组装；平台差异限于应用/安装程序复制和 ZIP 工具。现有产物验证器继续检查最终目录与解压内容，并补充 macOS arm64 架构及 Windows NSIS 内的 x64 Companion / Native Host 检查。Bundle ID 未修改。
- 单一 `publish` 任务依赖全部平台成功，仅正式版本 Tag 事件能获得写权限。发布脚本再次检查事件、仓库及 Tag 提交，拒绝任何已有同名 Release；先创建草稿，上传三个附件，重新下载逐一核对大小与 SHA-256，最后公开。失败保持草稿，禁止覆盖和盲目重试。
- 终端分别展示两个平台的真实任务状态，只查询 `push` 触发的发布工作流。正式成功要求 macOS ZIP、Windows ZIP、Windows 安装程序全部非空，显示各自下载链接。
- 手动 `workflow_dispatch` 复用同样的双平台构建，只读权限，仅上传保留 7 天的 `validation-*` 临时产物，不能进入正式发布任务。
- 使用文档及安装教程已补充 Windows 入口、安装、通知区域与安全 CI 验证说明。

## 本轮明确问题与修复

1. `.cmd` 原文件是 LF 换行，CMD 执行时出现命令截断及乱码。改为 UTF-8 无 BOM、CRLF 后，真实 CMD 子进程回归通过。路径使用 `pushd "%~dp0"`，禁用延迟展开；没有把主流程放入括号块，避免提前展开退出码。
2. 测试夹具把 Windows 绝对路径直接传给 Node `--import`，被 ESM 解析为 `c:` 协议。两个调用点使用 `pathToFileURL(...).href`；增加中文、空格、`#`、`%` 文件名回归。
3. 生命周期测试暴露 Git `core.autocrlf=true` 下的误拦截：提交内容为 LF，准备内容含 CRLF。比较时仅统一 CRLF/LF，继续核对完整文本，未跳过提交核验；没有修改 Git 配置。

## 已执行的验证

本地环境为 Windows x64、Node.js `v24.13.0`；Actions 设置 Node.js 22。未安装额外本地软件或工具链。

| 验证 | 结果 |
| --- | --- |
| Windows 入口、严格 dry-run、完整交互生命周期针对性测试 | 9 项通过 |
| ESM 特殊路径、模拟统一发布流程、Actions 进度针对性测试 | 9 项通过 |
| 最终 `node --test scripts/release-tests.mjs` | 121 项通过，0 失败，0 跳过 |
| 7 个修改/新增发布脚本的现有 ESLint | 通过 |
| 用现有 confbox 依赖解析工作流 YAML，检查矩阵、权限、依赖和 Native Host 目标声明 | 通过 |
| `node scripts/validate-release-version.mjs 0.5.0` | 九处正式版本声明一致 |
| `node scripts/release.mjs --help` | 中文双平台入口及原有参数说明正常 |
| `git diff --check` | 通过 |
| 原 macOS 入口、版本文件、锁文件及 Tauri 配置相对 main 的差异检查 | 无变化 |

回归覆盖入口无参数/help/dry-run/restore/verbose、带中文/空格/括号/`&`/`!` 路径、参数传递、错误退出码、暂停提示和缺少依赖。共享测试覆盖版本与远端检查、取消与恢复、测试失败、提交和推送失败、恢复记录竞争，以及不完整/空附件/草稿/预发布/失败工作流禁止误报成功。

统一发布测试完全替换 gh 进程调用，覆盖成功顺序、已有 Release、上传失败、缺少附件、下载内容损坏、错误 Tag 和手动验证事件。生命周期测试只在隔离临时 Git 仓库内创建夹具提交与 Tag，所有远端推送均模拟；真实项目及 GitHub 未执行任何 Tag 或 Release 创建。

## 尚未执行的验收

- 未推送开发分支，未触发 GitHub Actions，因此尚无真实 Windows NSIS / macOS `.app` 及 ZIP 构建成功证据。工作流和验证脚本已准备，但本地测试不替代 Runner 验收。
- 未在 macOS 上实际运行本轮测试，也未验证真实 Finder 或资源管理器双击后的图形窗口行为；Windows CMD 入口的自动化执行已通过。
- 未执行本地 Rust/Companion 原生全量构建及安装验收，以避免无意义重复构建。相关构建、Native Host、隐私和产物检查均保留在两平台 Actions 中。
- 手动验证入口需工作流先进入 GitHub 默认分支后才可从 Actions 页面运行。后续同步/合并和 CI 验证须由用户另行确认；不能用正式 Tag 测试替代。

完整使用及安全验证步骤见 [release-cli.md](release-cli.md)。本轮只创建本地开发提交，不推送或合并 main，不修改正式版本、现有 Tag、Release、Stash 或系统设置。

官方能力核实：[GitHub CLI 的事件过滤参数](https://cli.github.com/manual/gh_run_list)、[Windows 2022 Runner 预装工具清单（包含 7zip、NSIS 与 Rust）](https://github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md)。
