import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: {
  runtime: { getURL: (path: string) => `chrome-extension://test${path}`, sendMessage: mocks.send },
} }));
vi.mock('@/lib/storage/lazyRestoreRepository', () => ({ lazyRestoreRepository: { get: mocks.get } }));
let doc: Document;
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers();
  const { document } = parseHTML('<html><head><link id="lazy-tab-favicon"></head><body><main id="recovery"></main></body></html>');
  doc = document as unknown as Document;
  Object.defineProperty(doc, 'visibilityState', { value: 'hidden', configurable: true });
  vi.stubGlobal('document', doc); vi.stubGlobal('location', { search: '?id=saved' });
  mocks.get.mockResolvedValue({ title: 'Saved', originalUrl: 'https://example.com/saved', favIconUrl: 'https://example.com/favicon.ico' });
  mocks.send.mockResolvedValue('waiting');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('restores the original inactive blank page, title and icon initialization', async () => {
  await import('./main');
  await vi.advanceTimersByTimeAsync(3000);
  expect(doc.title).toBe('Saved');
  expect(doc.querySelector('link')!.getAttribute('href')).toBe('https://example.com/favicon.ico');
  expect(doc.querySelector('main')!.textContent).toBe('');
  expect(mocks.get).toHaveBeenCalledExactlyOnceWith('saved');
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith({ type: 'LAZY_TAB_READY', lazyId: 'saved' });
});

it('requests original activation recovery when the tab becomes visible', async () => {
  await import('./main');
  await vi.advanceTimersByTimeAsync(0);
  Object.defineProperty(doc, 'visibilityState', { value: 'visible' });
  doc.dispatchEvent(new (doc.defaultView!.Event)('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(doc.querySelector('main')!.textContent).toBe('');
});

it('uses the original close action when no record is readable and never deletes data', async () => {
  mocks.get.mockResolvedValue(null);
  await import('./main');
  await vi.advanceTimersByTimeAsync(0);
  expect(doc.querySelector('main')!.textContent).toContain('无法恢复此标签页');
  expect(doc.querySelector('button')!.textContent).toBe('关闭此标签页');
  expect(mocks.send).not.toHaveBeenCalled();
});
