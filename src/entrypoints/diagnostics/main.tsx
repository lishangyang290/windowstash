import React from 'react';
import { createRoot } from 'react-dom/client';
import { DiagnosticCenter } from '../../../shared/DiagnosticCenter';
import { makeBundle, type DiagnosticEvent } from '../../../shared/diagnostics';
import { extensionDiagnostics, detailedDiagnostics, initializeDiagnostics } from '@/lib/storage/diagnostics';
import { accountStorageKey } from '@/lib/storage/accountScope';
import { nativeLibraryExchange } from '@/lib/companion/workspaces';

initializeDiagnostics();
async function load() {
  const local = await extensionDiagnostics();
  const native: DiagnosticEvent[] = [];
  const coverage = { ...local.coverage };
  try {
    const exchange = await nativeLibraryExchange(await accountStorageKey('workspaces'));
    if (!exchange) coverage['native-host'] = '组件不可用；未配对或未授权';
    else {
      let chunks = 1;
      for (let index = 0; index < chunks; index++) {
        const reply = await exchange('diagnostics', { index }) as { status: string; chunks: number; index: number; events: DiagnosticEvent[] };
        if (reply.status !== 'diagnostics' || reply.index !== index || !Number.isSafeInteger(reply.chunks) || reply.chunks < 1 || reply.chunks > 500 || !Array.isArray(reply.events)) throw new Error('invalid diagnostics');
        chunks = reply.chunks; native.push(...reply.events);
      }
      coverage['native-host'] = '已读取本账号 Native Host / Companion 文件；受轮转与采集边界限制';
      coverage.companion = '已合并当前账号可访问的持久化记录；运行状态未知';
    }
  } catch { coverage['native-host'] = '组件不可用或授权失败；Native Host 和 Companion 文件未完整读取'; }
  const deviceId = native.find(e => /^[a-f0-9]{64}$/.test(e.deviceId))?.deviceId;
  return makeBundle([...local.events.map(e => deviceId ? { ...e, deviceId, deviceSource: 'native' as const } : e), ...native], coverage);
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><DiagnosticCenter load={load} enableDetails={detailedDiagnostics} /></React.StrictMode>);
