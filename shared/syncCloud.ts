import type { TraceContext } from './diagnostics';
import type { SyncCloud } from './workspaceSync';
import { syncTrace } from './syncDiagnostics';

interface RpcClient { rpc(name: string, args?: Record<string, unknown>): { abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null; status?: number }> } }
export function syncCloud(client: RpcClient): SyncCloud {
  async function rpc(name: string, args?: Record<string, unknown>, trace?: TraceContext): Promise<unknown> {
    const action = name === 'windowstash_snapshot_v1' ? 'snapshot' : name === 'windowstash_put_v1' ? 'put' : 'remove';
    const id = action === 'put' ? (args?.workspace as { id?: unknown })?.id : args?.workspace_id;
    const workspace = typeof id === 'string' ? id : undefined;
    const started = performance.now();
    trace = syncTrace('cloud.start', { trace, action, workspace });
    try {
      const { data, error, status } = await client.rpc(name, args).abortSignal(AbortSignal.timeout(10_000));
      if (error) throw new Error(`云端同步暂未完成：${error.message}`, { cause: { ...error, status } });
      syncTrace('cloud.done', { trace, action, workspace, httpStatus: status, elapsedMs: performance.now() - started });
      return data;
    } catch (error) {
      syncTrace('cloud.failed', { trace, httpStatus: (error as { cause?: { status?: number } })?.cause?.status, errorCode: typeof (error as { cause?: { code?: unknown } })?.cause?.code === 'string' ? (error as { cause: { code: string } }).cause.code : (error as { name?: string })?.name === 'TimeoutError' ? 'timeout' : 'other', action, workspace, elapsedMs: performance.now() - started });
      throw error;
    }
  }
  return {
    snapshot: trace => rpc('windowstash_snapshot_v1', undefined, trace),
    put: (record, hash, trace) => rpc('windowstash_put_v1', {
      workspace: { id: record.content.id, name: record.content.name, status: record.content.status, tabs: record.content.tabs,
        active_tab_index: record.content.activeTabIndex, content_hash: hash, created_at: record.content.createdAt },
      expected_updated_at: record.sync.lastSyncedCloudUpdatedAt,
    }, trace),
    remove: async (id, trace) => { await rpc('windowstash_delete_v1', { workspace_id: id }, trace); },
  };
}
