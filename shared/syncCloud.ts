import type { SyncCloud } from './workspaceSync';

interface RpcClient { rpc(name: string, args?: Record<string, unknown>): { abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: { message: string } | null }> } }
export function syncCloud(client: RpcClient): SyncCloud {
  async function rpc(name: string, args?: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await client.rpc(name, args).abortSignal(AbortSignal.timeout(10_000));
    if (error) throw new Error(`云端同步暂未完成：${error.message}`, { cause: error });
    return data;
  }
  return {
    snapshot: () => rpc('windowstash_snapshot_v1'),
    put: (record, hash) => rpc('windowstash_put_v1', {
      workspace: { id: record.content.id, name: record.content.name, status: record.content.status, tabs: record.content.tabs,
        active_tab_index: record.content.activeTabIndex, content_hash: hash, created_at: record.content.createdAt },
      expected_updated_at: record.sync.lastSyncedCloudUpdatedAt,
    }),
    remove: async id => { await rpc('windowstash_delete_v1', { workspace_id: id }); },
  };
}
