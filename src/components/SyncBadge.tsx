import { SYNC_LABELS, type SyncStatus } from '@/types/workspace';

export function SyncBadge({ status }: { status: SyncStatus }) {
  const symbol = status === 'synced' ? '●' : status === 'pending' ? '↻' : '!';
  return (
    <span className={`sync-badge sync-${status}`}>
      <span aria-hidden="true">{symbol}</span>
      {SYNC_LABELS[status]}
    </span>
  );
}
