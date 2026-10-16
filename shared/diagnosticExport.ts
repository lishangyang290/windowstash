import type { DiagnosticBundle, DiagnosticEvent } from './diagnostics';

/** Keep large JSON work away from the diagnostic page's event loop. */
export function prepareDiagnosticExport(bundle: DiagnosticBundle, imported: DiagnosticEvent[]) {
  return new Promise<{ bundle: DiagnosticBundle; json: string }>((resolve, reject) => {
    const worker = new Worker(new URL('./diagnosticExport.worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('诊断数据整理超时，请重试')); }, 30_000);
    const stop = () => { clearTimeout(timer); worker.terminate(); };
    worker.onmessage = ({ data }) => { stop(); if (data.error) reject(new Error(data.error)); else resolve(data); };
    worker.onerror = () => { stop(); reject(new Error('诊断文件生成线程不可用，请重试')); };
    try { worker.postMessage({ bundle, imported }); }
    catch (error) { stop(); reject(error); }
  });
}
