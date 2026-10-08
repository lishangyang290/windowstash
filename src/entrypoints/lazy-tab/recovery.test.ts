import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderLazyRecovery } from './recovery';

describe('lazy tab recovery', () => {
  let recovery: HTMLElement;
  let onRetry: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    const { document, window } = parseHTML('<main id="recovery"></main>');
    Object.assign(globalThis, { document, Event: window.Event });
    recovery = document.getElementById('recovery') as unknown as HTMLElement;
    onRetry = vi.fn<() => void>();
  });

  it('shows the saved http URL and navigates the current page when clicked', () => {
    const navigate = vi.fn<(url: string) => void>();
    renderLazyRecovery(recovery, {
      unavailable: false,
      originalUrl: 'https://example.com/long/path',
      onRetry,
      onClose: vi.fn<() => void>(),
      navigate,
    });

    const link = recovery.querySelector('a')!;
    expect(recovery.textContent).not.toContain('原网站地址');
    expect(link.textContent).toBe('https://example.com/long/path');
    expect(link.getAttribute('href')).toBe('https://example.com/long/path');
    expect(link.hasAttribute('target')).toBe(false);
    expect(link.parentElement?.previousElementSibling?.tagName).toBe('STRONG');
    expect(link.parentElement?.nextElementSibling?.tagName).toBe('P');
    expect(recovery.lastElementChild?.tagName).toBe('BUTTON');
    link.click();
    expect(navigate).toHaveBeenCalledWith('https://example.com/long/path');
  });

  it('keeps the failure state usable when the registry is missing', () => {
    expect(() => renderLazyRecovery(recovery, {
      unavailable: true,
      onRetry,
      onClose: vi.fn<() => void>(),
    })).not.toThrow();
    expect(recovery.textContent).toContain('无法恢复此标签页');
    expect(recovery.querySelector('a')).toBeNull();
  });

  it('does not render a link when originalUrl is missing', () => {
    renderLazyRecovery(recovery, { unavailable: false, onRetry, onClose: vi.fn<() => void>() });

    expect(recovery.querySelector('.original-site')).toBeNull();
  });

  it.each(['javascript:alert(1)', 'chrome://settings', 'not a URL'])(
    'does not render a link for %s',
    (originalUrl) => {
      renderLazyRecovery(recovery, { unavailable: false, originalUrl, onRetry, onClose: vi.fn<() => void>() });

      expect(recovery.querySelector('a')).toBeNull();
    },
  );

  it('keeps the existing retry action', () => {
    renderLazyRecovery(recovery, {
      unavailable: false,
      originalUrl: 'http://example.com',
      onRetry,
      onClose: vi.fn<() => void>(),
    });

    const button = recovery.querySelector('button')!;
    expect(button.textContent).toBe('重新加载原页面');
    button.click();
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
