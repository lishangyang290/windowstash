# WindowStash Companion

macOS 菜单栏启动器。它复用现有 Supabase 账号读取工作区，仅通过受限的 Tauri 命令唤起 Chrome 扩展；恢复、窗口绑定和去重仍由扩展负责。

## 开发

1. 首次打开后填写与扩展相同的 Supabase Project URL 和 Publishable Key；开发时也可以在 `.env` 中预填连接表单。
2. 运行 `npm install`。
3. 运行 `npm run tauri dev`。

`.env` 只在开发模式中使用。`npm run build` 是唯一前端正式构建，并会自动扫描产物，防止 Supabase URL 或 Publishable Key 泄漏；`npm run tauri:build` 使用同一正式前端构建打包 macOS 应用。

默认启用开机启动，可在设置中关闭。扩展 ID 会从 Chrome 配置目录自动识别，失败时可在设置中手动粘贴。
