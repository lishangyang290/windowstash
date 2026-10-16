import { makeBundle, type DiagnosticBundle, type DiagnosticEvent } from './diagnostics';
import { diagnosticTiming } from './diagnosticTiming';

self.onmessage = ({ data }: MessageEvent<{ bundle: DiagnosticBundle; imported: DiagnosticEvent[] }>) => {
  try {
    const bundle = data.imported.length ? makeBundle([...data.bundle.events, ...data.imported], data.bundle.coverage) : data.bundle;
    const start = performance.now();
    const json = JSON.stringify(bundle, null, 2);
    diagnosticTiming('serialize', start);
    self.postMessage({ bundle, json });
  } catch { self.postMessage({ error: '诊断数据整理或序列化失败' }); }
};
