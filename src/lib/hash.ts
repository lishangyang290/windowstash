import type { WorkspaceContent } from '@/types/workspace';

function stableContent(content: WorkspaceContent) {
  return {
    name: content.name,
    status: content.status,
    tabs: [...content.tabs]
      .sort((a, b) => a.position - b.position)
      .map(({ title, url, position, pinned }) => ({ title, url, position, pinned })),
    activeTabIndex: content.activeTabIndex,
  };
}

export async function contentHash(content: WorkspaceContent): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(stableContent(content)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
