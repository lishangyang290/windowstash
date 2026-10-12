import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
vi.mock('wxt/browser', () => ({ browser: {} }));
import { transferSession } from '../auth';
const session = { access_token: 'fresh', refresh_token: 'fresh-refresh', expires_at: 200, user: { id: 'A' } } as Session;
describe('browser session handoff snapshot', () => {
  it('does not replace the SDK session with an expired storage snapshot', () => {
    expect(transferSession(session, JSON.stringify({ ...session, access_token: 'expired', expires_at: 100 }))).toBe(session);
  });
  it('uses a concurrent completed refresh only for the same account', () => {
    const refreshed = { ...session, expires_at: 300, refresh_token: 'rotated' };
    expect(transferSession(session, JSON.stringify(refreshed))).toEqual(refreshed);
    expect(transferSession(session, JSON.stringify({ ...refreshed, user: { id: 'B' } }))).toBe(session);
  });
  it('ignores corrupt storage', () => {
    expect(transferSession(session, 'broken')).toBe(session);
  });
});
