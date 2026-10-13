# WindowStash Companion

macOS 菜单栏和 Windows 系统托盘工作区启动器。恢复、窗口绑定和 Lazy Restore 仍由 Chrome 扩展负责。

首次使用点击「在浏览器中登录」，在 Chrome Options 配置 Supabase 和登录。Chrome 已登录时复用已有 Session，不重复输入。授权后 Companion 查询工作区；关闭 Chrome 或重启 Companion 后仍可继续使用。账号管理在 Chrome Options 中进行。

多个 Chrome 用户环境无法自动确定时选择一次，之后保留关联。正式应用包含 Native Host，启动和发起登录时自动注册当前用户的 Chrome 通信组件，无需终端配置。登录请求 URL 仅包含一次性请求标识，不包含凭据。

Refresh Token 由本机组件在文件锁下集中轮换，Chrome 的刷新请求也交给该组件。Companion WebView 只收到短期 Access Token。认证文件使用用户私有目录和权限；按产品约定接受同一系统用户恶意替换组件的残余风险，不声称抵御此类冒充。

`.env` 只在开发模式中使用。`npm run build` 是唯一前端正式构建，并会自动扫描产物，防止 Supabase URL 或 Publishable Key 泄漏。`npm run tauri:build:mac` 打包 macOS 应用（原有 `npm run tauri:build` 仍指向该命令），`npm run tauri:build:windows` 在 Windows x64 上生成 NSIS 安装包。

旧版已登录用户保留原有入口，可在设置中选择「改用浏览器登录」迁移；原配置及数据不自动删除。新登录用户只有浏览器登录入口。新链路已完成隔离联动验收，真实 macOS / Supabase 验收仍待用户执行。

## 开发与验收

- `npm run dev`：前端开发。
- `npm run tauri dev`：本机开发运行，会执行用户级 Host 注册。
- `npm run tauri:build`：构建 macOS 应用；Windows x64 使用 `npm run tauri:build:windows`。构建不启动应用、不注册 Host。
- 根目录运行 `node scripts/build-native-host.mjs` 后运行 `node scripts/verify-browser-auth.mjs`：正式 Host 对接临时模拟服务，验证凭据交接、并发刷新、持久化、退出和切换账号，不修改系统注册。

正式构建继续扫描产物中的私人 Supabase 配置。`.env` 仅用于开发。默认开机启动仍可在应用设置中关闭。
