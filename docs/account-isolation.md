# Workspace 数据隔离与回归验证

每个数据空间以 JSON 编码的 `[规范化 Supabase 项目 URL, 用户 ID]` 标识。同一个用户 ID 在不同项目中也属于不同空间。项目地址末尾的 `/` 不产生新空间，Publishable Key 更新不改变数据归属。

扩展的 Workspace、未同步状态、Tombstone、同步日志、窗口绑定、延迟恢复条目和窗口恢复关联均按空间存储。切换只改变当前空间，不删除其他空间。Companion 的 Workspace 缓存和最近使用记录使用同样的项目/用户标识；浏览器 Profile 只用于授权路由。

同步任务携带启动时的空间标识。云端请求固定项目、用户过滤条件和访问令牌；迟到的上传、下载与日志仍属于原空间。原账号任务在新账号下重新执行时被拒绝，原未同步记录保留。旧上传返回时不覆盖后来产生的离线修改。

## 旧版本升级

- 升级时仍有原项目的原登录身份：复制旧公共数据到该身份的空间，保留原副本，包括未同步记录、Tombstone 和恢复元数据。
- 已存在旧归属标记：只恢复到标记指定的项目/用户；缺失的分区可由旧副本恢复，已存在的空分区不重新导入已删除的数据。
- 登录身份及归属标记均缺失：无法仅凭 Workspace 内容推断账号。管理器显示旧副本数量和“恢复旧版数据”，不会静默当成数据已丢失，也不会自动交给新账号。用户切回原项目/账号并明确确认后才恢复。相同 ID 的现有记录优先，原副本保持不变。
- Companion 已有登录身份的公共缓存，以及旧 `[Profile, 项目, 用户]` 缓存，可恢复至对应项目/用户空间；来源副本保留。

## 模拟环境

`tests/support/supabaseMemory.ts` 提供两个项目、三个身份（A1、A2、B1）。A1 和 B1 使用相同用户 ID，三个空间使用相同 Workspace ID。测试将全局 fetch 替换为内存 HTTP 实现，任何未模拟的地址直接拒绝，不转发真实网络请求，也不读取真实 Supabase 配置。

| 自动化覆盖 | 测试 |
| --- | --- |
| A1 → A2 → B1 → A1；本地 Workspace、缓存、未同步记录、删除队列、日志、窗口与延迟恢复；模块重启 | `src/lib/sync/accountIsolation.test.ts` |
| 实际同步引擎、实际 Supabase SDK、模拟 HTTP；离线失败恢复、错误账号任务拒绝、延迟上传与删除 | `src/lib/sync/supabaseIsolation.test.ts` |
| Companion 实际 SDK、模拟 HTTP、完整切换、最近使用、旧缓存迁移、重启与延迟响应拒绝 | `companion/src/features/accountIsolation.test.ts` |
| 旧版归属识别、缺失分区恢复、匿名副本保护、同 ID 合并、恢复提示与取消 | `src/lib/storage/__tests__/accountScope.test.ts`、`src/entrypoints/__tests__/supabaseSetup.test.tsx` |
| Native Host 的临时存储、授权路由、旧事件拒绝与注销 | `cargo test --offline --manifest-path companion/native-host/Cargo.toml` |

运行：`npm test`、`npm --prefix companion test`，以及两端 `typecheck`、`lint`、`build`。

以上验证使用内存存储、模拟浏览器/原生接口与模拟认证状态。尚未验证真实 Supabase Auth/RLS 策略、真实 Chrome storage/Web Locks 多进程时序、已安装扩展与 Companion 的完整界面联动。此次不操作真实项目，不要求额外账号或数据库，不发布产物。

## 未登录保存保护

插件弹窗在未配置或未登录时统一显示首次安装的“开始设置”状态，保留已有配置；身份确认中显示等待状态。只有已登录状态展示工作区操作；退出后即时隐藏原账号内容，不删除该账号的工作区或窗口绑定。保存、更新、删除及后台工作区操作独立检查身份，写入固定项目/用户分区；保存提交与账号选择/退出共用 Web Lock，登录状态变更标记会拒绝退出前尚未提交的请求，包括退出后重新登录同一账号的情况。弹窗与管理页的写入还携带展示时的分区，防止旧界面操作同 ID 的新账号记录。

历史 `workspaces:signed-out` 等无归属记录保留在原位置，不随登录自动导入。现有“恢复旧版数据”入口汇总这些记录，由用户明确确认后复制到所选账号分区，当前同 ID 记录优先，原副本继续保留。
