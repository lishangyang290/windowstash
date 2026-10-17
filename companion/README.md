# WindowStash Companion

Windows 系统托盘与 macOS 菜单栏工作区入口，使用 Tauri 2、React 和 Rust。恢复标签页、窗口关联与 Lazy Restore 仍由 Chrome 扩展执行。整体架构、数据库流程和数据安全边界见[根 README](../README.md)，账号分区见[隔离说明](../docs/account-isolation.md)。

## 运行与授权

首次点击「在浏览器中登录」，在 Chrome 完成 Supabase 配置、登录及授权确认，Companion 复用该账号，无需再输入项目密钥或密码。多个 Chrome Profile 无法自动确定时，用户选择一次，之后保留路由。

应用启动或发起登录时自动注册当前用户的 Native Messaging 组件。正式应用内含 Host，开发运行会把当前用户的注册路径指向开发产物；切回安装版后应核对其运行路径与注册。授权 URL 不包含凭据。

Rust 库管理账号授权、集中 Token 刷新、本地工作区库和同步租约，Companion WebView 仅接收短期 Access Token。Chrome 关闭后 Companion 仍能后台同步，恢复浏览器工作区时会使用已关联的 Chrome 和扩展。默认开机启动可在设置中关闭。

旧版独立登录用户保留原入口，可在设置中选择「改用浏览器登录」迁移，原配置和数据不自动删除。新用户使用浏览器授权入口。对同一系统用户恶意替换组件的风险边界见根 README。

## 开发与构建

先在仓库根目录执行 `npm ci`、`npm --prefix companion ci`。下表命令在 `companion/` 中执行：

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | Vite 前端服务，不提供原生命令 |
| `npm run tauri -- dev` | 准备 Host 并运行完整桌面应用，会执行用户级组件注册 |
| `npm run build` | 前端正式构建及私人配置扫描，不生成桌面安装包 |
| `npm run tauri:build:windows` | Windows x64 + MSVC 构建中文 NSIS 安装器 |
| `npm run tauri:build:mac` | macOS 构建 `.app`；`tauri:build` 是此命令的别名 |
| `npm test` / `npm run typecheck` / `npm run lint` | 前端测试及静态检查，按任务范围选择 |

Tauri hook 自动运行 [build-native-host.mjs](../scripts/build-native-host.mjs) 和前端构建。构建不会启动应用或注册 Host；运行应用才会注册。Windows 脚本要求已安装 MSVC x64 工具链；macOS CI 当前目标为 arm64，应用配置最低 macOS 12.0。不要将不同目标的 Host 混装。

开发环境配置与正式构建隐私规则见根 README；`.env` 只供开发使用，正式连接配置来自用户界面。单独调试认证可在根目录执行：

```sh
node scripts/build-native-host.mjs
node scripts/verify-browser-auth.mjs
```

该检查使用临时本机 HTTP 服务和临时存储，不读取真实账号或修改注册。Windows 可设置进程环境变量 `WINDOWSTASH_VERIFY_WINDOWS_CONSOLE=1`，短时检查验证及刷新 curl 的实际窗口；可将已安装 Host 的完整路径作为脚本第一个参数。生产 curl 已设置 Windows `CREATE_NO_WINDOW`，macOS 调用行为不变。

## 安装与更新状态

- **Windows：**中文 NSIS 当前用户安装、Companion/Host 覆盖及哈希核验已验证。安装器正常关闭 Companion，旧 Host 可保持原请求直至连接结束；后续请求使用新文件。扩展刷新后重新建立连接，避免依赖旧常驻进程。首次补装 WebView2 需要网络。
- **macOS：**当前发行脚本打包 `.app`，使用 ad-hoc 签名，未配置 Apple 公证；`.pkg` 的安装、升级及系统安全提示尚待实机验收，不能视为已发布功能。

用户更新按「更新 Companion → 覆盖原扩展目录 → 在 `chrome://extensions` 刷新原扩展」执行，无需停用扩展、退出 Chrome、手动结束 Host 或重新配置原账号。详细操作集中在[用户教程源文件](../public/开始使用.html)，不在这里重复。

Windows 最近验证已核对新运行 Host、真实账号只读认证、后台同步及既有工作区/冲突副本保留；自动化隔离认证覆盖并发刷新、断网、临时失败、退出和账号切换。此结果不替代 macOS 实机验收或所有跨设备并发场景测试。诊断中心入口及日志边界见根 README。
