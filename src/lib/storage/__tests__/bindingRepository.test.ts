vi.mock('@/lib/storage/accountScope', () => ({ accountStorageKey: async (key: string) => key }));
import { beforeEach, describe, expect, it, vi } from 'vitest';

const values = vi.hoisted(() => new Map<string, unknown>());
const sessionMock = vi.hoisted(() => ({
  get: vi.fn(async (key: string | null) => key === null ? Object.fromEntries(values) : ({ [key]: values.get(key) })),
  set: vi.fn(async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) values.set(key, value);
  }),
  remove: vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
  }),
}));

vi.mock('wxt/browser', () => ({ browser: { storage: { session: sessionMock } } }));

import { bindingRepository } from '@/lib/storage/bindingRepository';

describe('bindingRepository', () => {
  beforeEach(() => {
    values.clear();
    vi.clearAllMocks();
  });

  it('keeps both bindings when two windows bind concurrently', async () => {
    await Promise.all([
      bindingRepository.set(11, 'workspace-a'),
      bindingRepository.set(22, 'workspace-b'),
    ]);

    await expect(bindingRepository.get(11)).resolves.toBe('workspace-a');
    await expect(bindingRepository.get(22)).resolves.toBe('workspace-b');
    expect(sessionMock.set).toHaveBeenCalledWith({ 'windowBinding:11': 'workspace-a' });
    expect(sessionMock.set).toHaveBeenCalledWith({ 'windowBinding:22': 'workspace-b' });
  });

  it('removes one window without changing another binding', async () => {
    await bindingRepository.set(11, 'workspace-a');
    await bindingRepository.set(22, 'workspace-b');

    await bindingRepository.remove(11);

    await expect(bindingRepository.get(11)).resolves.toBeNull();
    await expect(bindingRepository.get(22)).resolves.toBe('workspace-b');
  });

  it('suppresses matcher rebinding without exposing an explicit binding', async () => {
    await bindingRepository.set(11, 'workspace-a');

    await bindingRepository.suppress(11);

    await expect(bindingRepository.get(11)).resolves.toBeNull();
    await expect(bindingRepository.isSuppressed(11)).resolves.toBe(true);
  });

  it('clears suppression when a window is explicitly bound again', async () => {
    await bindingRepository.suppress(11);

    await bindingRepository.set(11, 'workspace-b');

    await expect(bindingRepository.get(11)).resolves.toBe('workspace-b');
    await expect(bindingRepository.isSuppressed(11)).resolves.toBe(false);
  });

  it('cleans binding and suppression when a window closes', async () => {
    await bindingRepository.suppress(11);

    await bindingRepository.remove(11);

    await expect(bindingRepository.get(11)).resolves.toBeNull();
    await expect(bindingRepository.isSuppressed(11)).resolves.toBe(false);
  });

  it('suppresses only windows belonging to the deleted workspace and account', async () => {
    await bindingRepository.set(11, 'deleted', 'workspaces:A');
    await bindingRepository.set(22, 'other', 'workspaces:A');
    await bindingRepository.set(33, 'deleted', 'workspaces:B');
    await bindingRepository.suppressWorkspace('deleted', 'workspaces:A');
    expect(await bindingRepository.get(11, 'workspaces:A')).toBeNull();
    expect(await bindingRepository.isSuppressed(11, 'workspaces:A')).toBe(true);
    expect(await bindingRepository.get(22, 'workspaces:A')).toBe('other');
    expect(await bindingRepository.get(33, 'workspaces:B')).toBe('deleted');
  });
});
