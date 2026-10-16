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
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.scrollTo = vi.fn();
  container = document.getElementById('root')!; root = createRoot(container);
});
function records(count: number): DiagnosticEvent[] {
  return Array.from({ length: count }, (_, index) => ({ ...event,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    operationId: `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`,
    timestamp: new Date(Date.UTC(2026, 9, 15, 0, 0, index)).toISOString(),
    event: index === 0 ? 'cloud.failed' : 'cloud.received', result: index === 0 ? 'failed' : 'success',
    level: index === 0 ? 'ERROR' : 'INFO', errorCode: index === 0 ? '42501' : undefined,
  }));
}
it('locates evidence on the correct page, selects it and renders the linked trace beside the table', async () => {
  const events = records(85);
  await act(async () => root.render(<DiagnosticCenter load={async () => makeBundle(events)} enableDetails={async () => {}} />));
  const evidence = container.querySelector<HTMLButtonElement>('.diag-evidence-link')!;
  await act(async () => evidence.click());
  expect(container.querySelector('.diag-tab-active')?.textContent).toBe('事件记录 85');
  expect(container.querySelector('.diag-pagination')?.textContent).toContain('第 3 / 3 页');
  const row = container.querySelector('.diag-current')!;
  expect(row.getAttribute('data-event-id')).toBe(events[0]!.id);
  expect(row.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  const detail = container.querySelector('[aria-label="操作追踪详情"]')!;
  expect(detail.querySelector('h2')?.textContent).toBe('云端请求失败');
  expect(detail.parentElement).toBe(container.querySelector('.diag-workspace'));
  expect(detail.closest('table')).toBeNull();
  expect(detail.querySelector('pre')?.textContent).toContain('"errorCode": "42501"');
  await act(async () => container.querySelector<HTMLButtonElement>('.diag-event-choice')!.click());
  expect(detail.querySelector('h2')?.textContent).toBe('收到云端工作区版本');
});
it('keeps the selected trace in the visible page and respects component and level filters', async () => {
  const events = records(41);
  await act(async () => root.render(<DiagnosticCenter load={async () => makeBundle(events)} enableDetails={async () => {}} />));
  await click('事件记录 41');
  await click('下一页');
  expect(container.querySelector('.diag-current')?.getAttribute('data-event-id')).toBe(events[0]!.id);
  expect(container.querySelector('[aria-label="操作追踪详情"] h2')?.textContent).toBe('云端请求失败');
  const level = container.querySelector<HTMLSelectElement>('[aria-label="日志级别"]')!;
  await act(async () => { Object.defineProperty(level, 'value', { configurable: true, value: 'ERROR' }); level.dispatchEvent(new window.Event('change', { bubbles: true })); });
  expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  expect(container.querySelector('.diag-pagination')?.textContent).toContain('第 1 / 1 页');
  const component = container.querySelector<HTMLSelectElement>('[aria-label="来源组件"]')!;
  await act(async () => { Object.defineProperty(component, 'value', { configurable: true, value: 'companion' }); component.dispatchEvent(new window.Event('change', { bubbles: true })); });
  expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
  expect(container.querySelector('[aria-label="操作追踪详情"] h2')).toBeNull();
});
it('imports actual multi-device evidence and exports the merged sanitized events', async () => {
  const remote = { ...event, id: '44444444-4444-4444-8444-444444444444', deviceId: 'b'.repeat(64), devicePlatform: 'macos', event: 'realtime.event', result: 'observed' as const, level: 'INFO' as const };
  const save = vi.fn(async (bundle: ReturnType<typeof makeBundle>) => bundle.schema + '.json');
  await act(async () => root.render(<DiagnosticCenter load={async () => makeBundle([event])} enableDetails={async () => {}} save={save} />));
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [{ size: 100, text: async () => JSON.stringify(makeBundle([remote])) }] });
  await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
  await click('事件记录 2');
  expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
  await click('导出诊断文件');
  expect(save.mock.calls[0]?.[0]).toMatchObject({ events: expect.arrayContaining([expect.objectContaining({ devicePlatform: 'windows' }), expect.objectContaining({ devicePlatform: 'macos' })]) });
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent === text)!;
  expect(button).toBeTruthy(); await act(async () => button.click());
}
it('renders an independent center, expands actual event evidence and refreshes before export', async () => {
  const load = vi.fn(async () => makeBundle([event], { 'native-host': '组件不可用' })), save = vi.fn(async (bundle: ReturnType<typeof makeBundle>) => bundle.schema + '.json');
  await act(async () => root.render(<DiagnosticCenter load={load} enableDetails={async () => {}} save={save} />));
  expect(container.querySelector('dialog')).toBeNull();
  await click('采集状态'); expect(container.textContent).toContain('组件不可用');
  await click('事件记录 1');
  expect(container.querySelector('tbody')?.textContent).toContain('云端请求失败');
  expect(container.querySelector('tbody')?.textContent).not.toContain('42501');
  expect(container.querySelector('details')?.hasAttribute('open')).toBe(false);
  await click('云端请求失败'); expect(container.textContent).toContain('关键阶段核对');
  expect(container.querySelector('pre')?.textContent).toContain('shared/syncCloud.ts:rpc');
  const summary = container.querySelector('summary')!; await act(async () => summary.click()); await click('复制这条记录'); expect(navigator.clipboard.writeText).toHaveBeenCalled();
  await click('导出诊断文件'); expect(load).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[0]?.[0]).toMatchObject({ schema: 'windowstash.diagnostics/1', events: [expect.objectContaining({ errorCode: '42501' })] });
});
it('prevents an old account read from repopulating the screen after account change', async () => {
  let finish!: (value: ReturnType<typeof makeBundle>) => void;
  const load = () => new Promise<ReturnType<typeof makeBundle>>(resolve => { finish = resolve; });
  await act(async () => root.render(<DiagnosticCenter load={load} enableDetails={async () => {}} />));
  await act(async () => window.dispatchEvent(new window.Event('windowstash-diagnostic-account-changed')));
  await act(async () => finish(makeBundle([event])));
  await click('事件记录 0'); expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
});
