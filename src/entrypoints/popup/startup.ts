import { browser, type Browser } from 'wxt/browser';
import { resolveWorkspaceStateForWindow } from '@/features/workspaces/workspaceService';
import { LazyTabResolutionError, resolveLogicalTabs } from '@/features/workspaces/lazyRestore';
import type { CurrentTabSnapshot } from '@/features/workspaces/tabDiff';
import { measurePopupStage } from '@/lib/popupPerformance';

export type PopupSnapshot = Awaited<ReturnType<typeof loadPopupWindow>>;
export function readPopupWindow(windowId?: number) {
  return measurePopupStage('current-window', () => windowId == null
    ? browser.windows.getCurrent({ populate: true })
    : browser.windows.get(windowId, { populate: true }));
}
export async function loadPopupWindow(accountKey: string, current: Browser.windows.Window) {
  if (current.id == null) throw new Error('无法识别当前 Chrome 窗口');
  const rawTabs = [...(current.tabs ?? [])].sort((a, b) => a.index - b.index);
  let tabs: CurrentTabSnapshot[] = rawTabs;
  let logicalTabsReady = false, error = '';
  try { tabs = await measurePopupStage('logical-tabs', () => resolveLogicalTabs(rawTabs, accountKey.replace(/^workspaces/, 'lazyRestoreEntries'))); logicalTabsReady = true; }
  catch (reason) { error = reason instanceof LazyTabResolutionError ? reason.message : '暂时无法读取当前窗口'; }
  const resolution = await measurePopupStage('workspace-resolution', () => resolveWorkspaceStateForWindow(current.id!, tabs, accountKey, logicalTabsReady));
  return { windowId: current.id, tabs, resolution, logicalTabsReady, error };
}
