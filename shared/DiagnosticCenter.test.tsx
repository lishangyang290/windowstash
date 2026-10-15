import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DiagnosticCenter } from './DiagnosticCenter';
import { makeBundle, type DiagnosticEvent } from './diagnostics';

let root: ReturnType<typeof createRoot>, container: HTMLElement;
const event: DiagnosticEvent = { id: '11111111-1111-4111-8111-111111111111', operationId: '22222222-2222-4222-8222-222222222222', timestamp: '2026-10-15T00:00:00Z', component: 'extension', level: 'ERROR', event: 'cloud.failed', result: 'failed', deviceId: 'a'.repeat(64), processId: '33333333-3333-4333-8333-333333333333', devicePlatform: 'windows', buildId: 'development', source: 'shared/syncCloud.ts:rpc', state: { action: 'remove' }, errorCode: '42501' };
beforeEach(() => {
  const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document);
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.getElementById('root')!; root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent === text)!;
  expect(button).toBeTruthy(); await act(async () => button.click());
}
it('renders an independent center, expands actual event evidence and refreshes before export', async () => {
  const load = vi.fn(async () => makeBundle([event], { 'native-host': '组件不可用' })), save = vi.fn(async (bundle: ReturnType<typeof makeBundle>) => bundle.schema + '.json');
  await act(async () => root.render(<DiagnosticCenter load={load} enableDetails={async () => {}} save={save} />));
  expect(container.textContent).toContain('组件不可用'); expect(container.querySelector('dialog')).toBeNull();
  await click('事件与追踪');
  expect(container.querySelector('tbody')?.textContent).toContain('云端请求失败');
  expect(container.querySelector('tbody')?.textContent).not.toContain('42501');
  expect(container.querySelector('pre')).toBeNull();
  await click('云端请求失败'); expect(container.textContent).toContain('未记录到 / 待确认');
  expect(container.querySelector('pre')?.textContent).toContain('shared/syncCloud.ts:rpc');
  await click('复制字段'); expect(navigator.clipboard.writeText).toHaveBeenCalled();
  await click('导出诊断日志'); expect(load).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[0]?.[0]).toMatchObject({ schema: 'windowstash.diagnostics/1', events: [expect.objectContaining({ errorCode: '42501' })] });
});
it('prevents an old account read from repopulating the screen after account change', async () => {
  let finish!: (value: ReturnType<typeof makeBundle>) => void;
  const load = () => new Promise<ReturnType<typeof makeBundle>>(resolve => { finish = resolve; });
  await act(async () => root.render(<DiagnosticCenter load={load} enableDetails={async () => {}} />));
  await act(async () => window.dispatchEvent(new window.Event('windowstash-diagnostic-account-changed')));
  await act(async () => finish(makeBundle([event])));
  await click('事件与追踪'); expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
});
