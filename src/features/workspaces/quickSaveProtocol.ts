import type { CurrentTabSnapshot, TabChange } from './tabDiff';
import type { WorkspaceContent } from '@/types/workspace';
import { contentHash } from '@/lib/hash';

export class QuickSavePreviewChangedError extends Error {}
export function workspaceSaveFingerprint(content: WorkspaceContent | null) {
  return content ? contentHash(content) : Promise.resolve('null');
}

export const QUICK_SAVE_COMMAND = 'quick-save-workspace';
export interface QuickSavePreview {
  token: string;
  name: string;
  existing: boolean;
  tabCount: number;
  counts: { added: number; removed: number; updated: number };
  changes: TabChange[];
  reordered: boolean;
}
export type QuickSaveMessage =
  | { type: 'QUICK_SAVE_PREVIEW' }
  | { type: 'QUICK_SAVE_CONFIRM'; token: string; name: string }
  | { type: 'QUICK_SAVE_OPEN'; token: string; index: number }
  | { type: 'QUICK_SAVE_CLOSE' };
export interface QuickSavePageContext { tabId: number; windowId: number; token: string }
export type QuickSavePageMessage = QuickSaveMessage & { pageContext?: QuickSavePageContext };
export type QuickSaveShowMessage = QuickSavePageContext & { type: 'QUICK_SAVE_SHOW' };
export type QuickSaveReply = { preview: QuickSavePreview; error?: string } | { saved: true } | { opened: true } | { error: string };

// Exact preview guard, independent of the fuzzy matching used by the existing Diff.
export function windowSaveFingerprint(tabs: (CurrentTabSnapshot & { pendingUrl?: string; active?: boolean })[]) {
  return JSON.stringify([...tabs].sort((a, b) => a.index - b.index).map(tab =>
    [tab.id, tab.index, tab.url, tab.pendingUrl, tab.title, Boolean(tab.pinned), Boolean(tab.active)]));
}
