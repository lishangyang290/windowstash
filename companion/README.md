# WindowStash Companion

macOS 菜单栏启动器。它复用现有 Supabase 账号读取工作区，仅通过受限的 Tauri 命令唤起 Chrome 扩展；恢复、窗口绑定和去重仍由扩展负责。

## 开发

1. 将 `.env.example` 复制为 `.env`，填写与扩展相同的 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_PUBLISHABLE_KEY`。
2. 运行 `npm install`。
3. 运行 `npm run tauri dev`。

默认启用开机启动，可在设置中关闭。扩展 ID 会从 Chrome 配置目录自动识别，失败时可在设置中手动粘贴。
