import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '@/lib/constants';

type Bindings = Record<string, string>;

async function read(): Promise<Bindings> {
  const result = await browser.storage.session.get(STORAGE_KEYS.windowBindings);
  return (result[STORAGE_KEYS.windowBindings] as Bindings | undefined) ?? {};
}

export const bindingRepository = {
  async get(windowId: number): Promise<string | null> {
    return (await read())[String(windowId)] ?? null;
  },
  async set(windowId: number, workspaceId: string): Promise<void> {
    const bindings = await read();
    bindings[String(windowId)] = workspaceId;
    await browser.storage.session.set({ [STORAGE_KEYS.windowBindings]: bindings });
  },
  async remove(windowId: number): Promise<void> {
    const bindings = await read();
    delete bindings[String(windowId)];
    await browser.storage.session.set({ [STORAGE_KEYS.windowBindings]: bindings });
  },
};
