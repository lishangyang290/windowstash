import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DiagnosticCenter } from './DiagnosticCenter';
import { makeBundle, type DiagnosticEvent } from './diagnostics';
vi.mock('./diagnosticTiming', () => ({ diagnosticTiming: vi.fn(), yieldDiagnosticUI: async () => {} }));
vi.mock('./diagnosticExport', () => ({ prepareDiagnosticExport: vi.fn(async (latest, imported) => {
  const bundle = imported.length ? makeBundle([...latest.events, ...imported], latest.coverage) : latest;
  return { bundle, json: JSON.stringify(bundle, null, 2) };
}) }));

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
it('isolates problem evidence and restores the correctly selected page when returning to all events', async () => {
  const events = records(85);
  await act(async () => root.render(<DiagnosticCenter load={async () => makeBundle(events)} enableDetails={async () => {}} />));
  const evidence = container.querySelector<HTMLButtonElement>('.diag-evidence-link')!;
  await act(async () => evidence.click());
  expect(container.querySelector('.diag-tab-active')?.textContent).toBe('事件记录 85');
  expect(container.querySelector('.diag-pagination')?.textContent).toContain('第 1 / 1 页');
  expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  expect(container.querySelector('.diag-evidence-scope')?.textContent).toContain('仅显示这条问题的记录');
  const row = container.querySelector('.diag-current')!;
  expect(row.getAttribute('data-event-id')).toBe(events[0]!.id);
  expect(row.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  const detail = container.querySelector('[aria-label="操作追踪详情"]')!;
  expect(detail.querySelector('h2')?.textContent).toBe('云端请求失败');
  expect(detail.parentElement).toBe(container.querySelector('.diag-workspace'));
  expect(detail.closest('table')).toBeNull();
  expect(detail.querySelector('pre')?.textContent).toContain('"errorCode": "42501"');
  await click('查看全部事件');
  expect(container.querySelector('.diag-pagination')?.textContent).toContain('第 3 / 3 页');
  expect(container.querySelector('.diag-current')?.getAttribute('data-event-id')).toBe(events[0]!.id);
  expect(container.querySelector('.diag-evidence-scope')).toBeNull();
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
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="日志级别"]')!.click());
  await click('错误');
  expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  expect(container.querySelector('.diag-pagination')?.textContent).toContain('第 1 / 1 页');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="来源组件"]')!.click());
  await click('Companion');
  expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
  expect(container.querySelector('[aria-label="操作追踪详情"] h2')).toBeNull();
});
it('supports keyboard selection, Escape and outside dismissal in styled filter menus', async () => {
  await act(async () => root.render(<DiagnosticCenter load={async () => makeBundle(records(3))} enableDetails={async () => {}} />));
  await click('事件记录 3');
  expect(container.querySelector('select')).toBeNull();
  const combo = container.querySelector<HTMLButtonElement>('[aria-label="日志级别"]')!;
  const key = async (value: string) => act(async () => { const event = new window.Event('keydown', { bubbles: true }); Object.defineProperty(event, 'key', { value }); combo.dispatchEvent(event); });
  await act(async () => combo.click());
  expect(combo.getAttribute('aria-expanded')).toBe('true');
  await key('ArrowDown'); await key('Enter');
  expect(combo.textContent).toBe('信息');
  expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  await act(async () => combo.click()); await key('Escape');
  expect(combo.getAttribute('aria-expanded')).toBe('false');
  await act(async () => combo.click());
  await act(async () => document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
  expect(combo.getAttribute('aria-expanded')).toBe('false');
});
it('selects the corresponding trace from any cell or blank area of an event row', async () => {
  await act(async () => root.render(<DiagnosticCenter load={async () => makeBundle(records(3))} enableDetails={async () => {}} />));
  await click('事件记录 3');
  for (const [index, cell] of [0, 1, 2, 3, null].entries()) {
    const row = container.querySelectorAll<HTMLTableRowElement>('tbody tr')[(index + 1) % 3]!;
    await act(async () => (cell === null ? row : row.querySelectorAll<HTMLTableCellElement>('td')[cell]!).click());
    expect(container.querySelector('.diag-current')).toBe(row);
    const evidence = JSON.parse(container.querySelector('[aria-label="操作追踪详情"] pre')!.textContent!);
    expect(evidence.id).toBe(row.getAttribute('data-event-id'));
    expect(row.querySelector('button')?.getAttribute('aria-pressed')).toBe('true');
  }
});
it('distinguishes same-name same-time events within one operation and focuses the matching timeline step', async () => {
  const events = records(30).map((e, index) => ({ ...e, operationId: event.operationId, timestamp: event.timestamp,
    event: 'cloud.received', result: 'success' as const, level: 'INFO' as const, errorCode: undefined,
    workspaceRef: (index + 1).toString(16).padStart(8, '0') + 'a'.repeat(56), cloudVersion: '2026-10-15T00:00:00.123456Z' }));
  await act(async () => root.render(<DiagnosticCenter load={async () => makeBundle(events)} enableDetails={async () => {}} />));
  await click('事件记录 30');
  const pane = container.querySelector('[aria-label="操作追踪详情"]')!;
  expect(pane.querySelector('.diag-trace-meta')?.textContent).toContain('30 / 30');
  expect(pane.querySelector('[aria-label="当前选中事件详情"]')?.textContent).toContain('0000001e');
  await act(async () => container.querySelectorAll<HTMLTableRowElement>('tbody tr')[1]!.click());
  expect(pane.querySelector('.diag-trace-meta')?.textContent).toContain('29 / 30');
  expect(pane.querySelector('[aria-label="当前选中事件详情"]')?.textContent).toContain('0000001d');
  expect(JSON.parse(pane.querySelector('[aria-current="step"] pre')!.textContent!).id).toBe(events[28]!.id);
  expect(pane.querySelector('[aria-current="step"]')?.getAttribute('data-trace-event-id')).toBe(events[28]!.id);
  expect(pane.querySelectorAll('.diag-timeline li')).toHaveLength(5);
  expect(pane.querySelectorAll('.diag-timeline details')).toHaveLength(5);
  expect(pane.querySelector('.diag-selected-event details')).toBeNull();
  const order = [...pane.querySelectorAll('.diag-timeline li')].map(e => e.getAttribute('data-trace-event-id'));
  const step = pane.querySelector<HTMLLIElement>('.diag-timeline li')!;
  const target = step.getAttribute('data-trace-event-id');
  const fields = step.querySelector('details')!;
  fields.open = true;
  vi.mocked((pane as HTMLElement).scrollTo).mockClear();
  await act(async () => step.querySelector('button')!.click());
  expect(container.querySelector('.diag-current')?.getAttribute('data-event-id')).toBe(target);
  expect(JSON.parse(pane.querySelector('[aria-current="step"] pre')!.textContent!).id).toBe(target);
  expect([...pane.querySelectorAll('.diag-timeline li')].map(e => e.getAttribute('data-trace-event-id'))).toEqual(order);
  expect(fields.open).toBe(true);
  expect((pane as HTMLElement).scrollTo).not.toHaveBeenCalled();
  await click('展开全部 30 条关联事件');
  expect(pane.querySelectorAll('.diag-timeline li')).toHaveLength(30);
  await act(async () => pane.querySelector<HTMLButtonElement>(`[data-trace-event-id="${events[10]!.id}"] .diag-step-choice`)!.click());
  expect(pane.querySelectorAll('.diag-timeline li')).toHaveLength(30);
  expect(pane.querySelector('[aria-current="step"]')?.getAttribute('data-trace-event-id')).toBe(events[10]!.id);
  expect(fields.open).toBe(true);
  expect(pane.querySelector('.diag-timeline li')?.getAttribute('data-trace-event-id')).toBe(events[0]!.id);
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
it('shows export progress immediately, blocks duplicates and keeps navigation responsive', async () => {
  let finish!: (bundle: ReturnType<typeof makeBundle>) => void;
  const load = vi.fn().mockResolvedValueOnce(makeBundle([event])).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const save = vi.fn(async () => 'diagnostics.json');
  await act(async () => root.render(<DiagnosticCenter load={load} save={save} enableDetails={async () => {}} />));
  const button = container.querySelector<HTMLButtonElement>('.diag-primary')!;
  await act(async () => { button.click(); button.click(); });
  expect(button.textContent).toBe('正在导出…'); expect(button.disabled).toBe(true);
  expect(button.querySelector('.diag-spinner')).not.toBeNull(); expect(load).toHaveBeenCalledTimes(2);
  await click('采集状态'); expect(container.querySelector('.diag-status-page')).not.toBeNull();
  await act(async () => finish(makeBundle([event])));
  expect(save).toHaveBeenCalledOnce(); expect(button.disabled).toBe(false); expect(button.textContent).toBe('导出诊断文件');
  expect(container.textContent).toContain('已导出：diagnostics.json');
});
it('restores the export button and reports a safe cause after save failure', async () => {
  await act(async () => root.render(<DiagnosticCenter load={async () => makeBundle([event])} save={async () => { throw 'downloads_unavailable'; }} enableDetails={async () => {}} />));
  await click('导出诊断文件');
  expect(container.querySelector<HTMLButtonElement>('.diag-primary')!.disabled).toBe(false);
  expect(container.textContent).toContain('导出失败：downloads_unavailable');
});
it('does not save old account evidence when the account changes during export', async () => {
  let finish!: (bundle: ReturnType<typeof makeBundle>) => void;
  const load = vi.fn().mockResolvedValueOnce(makeBundle([event])).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const save = vi.fn(async () => 'diagnostics.json');
  await act(async () => root.render(<DiagnosticCenter load={load} save={save} enableDetails={async () => {}} />));
  await click('导出诊断文件');
  await act(async () => window.dispatchEvent(new window.Event('windowstash-diagnostic-account-changed')));
  await act(async () => finish(makeBundle([event])));
  expect(save).not.toHaveBeenCalled(); expect(container.querySelector('.diag-spinner')).toBeNull();
  expect(container.textContent).toContain('账号已变化');
});
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
it('renders local evidence before other components finish and keeps export disabled until collection completes', async () => {
  let publish!: (bundle: ReturnType<typeof makeBundle>) => void;
  let finish!: (bundle: ReturnType<typeof makeBundle>) => void;
  const load = (partial?: typeof publish) => { publish = partial!; return new Promise<ReturnType<typeof makeBundle>>(resolve => { finish = resolve; }); };
  await act(async () => root.render(<DiagnosticCenter load={load} enableDetails={async () => {}} />));
  expect(container.textContent).toContain('正在读取本机诊断记录');
  await act(async () => publish(makeBundle([event])));
  await click('事件记录 1');
  expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  expect(container.textContent).toContain('正在补齐其他组件');
  expect([...container.querySelectorAll('button')].find(b => b.textContent === '导出诊断文件')?.disabled).toBe(true);
  await act(async () => finish(makeBundle([event])));
  expect(container.querySelector('.diag-loading')).toBeNull();
  expect([...container.querySelectorAll('button')].find(b => b.textContent === '导出诊断文件')?.disabled).toBe(false);
});
it('restores the active view on page reload while preserving the Companion route hash', async () => {
  vi.stubGlobal('location', new URL('https://preview.invalid/diagnostics.html?view=events#diagnostics'));
  const replaceState = vi.fn(); vi.stubGlobal('history', { state: null, replaceState });
  await act(async () => root.render(<DiagnosticCenter load={async () => makeBundle([event])} enableDetails={async () => {}} />));
  expect(container.querySelector('.diag-tab-active')?.textContent).toBe('事件记录 1');
  await click('采集状态');
  const url = replaceState.mock.calls.at(-1)?.[2] as URL;
  expect(url.searchParams.get('view')).toBe('status');
  expect(url.hash).toBe('#diagnostics');
});
it('preserves the current event view and valid page during an in-page refresh', async () => {
  const load = vi.fn(async () => makeBundle(records(41)));
  await act(async () => root.render(<DiagnosticCenter load={load} enableDetails={async () => {}} />));
  await click('事件记录 41'); await click('下一页'); await click('刷新');
  expect(load).toHaveBeenCalledTimes(2);
  expect(container.querySelector('.diag-tab-active')?.textContent).toBe('事件记录 41');
  expect(container.querySelector('.diag-pagination')?.textContent).toContain('第 2 / 2 页');
});
