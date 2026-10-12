/** In-memory HTTP boundary for the real Supabase SDK. Never forwards to a network. */
export const projects = ['https://project-a.supabase.test', 'https://project-b.supabase.test'] as const;
export const identities = [
  { url: projects[0], userId: 'user-1', token: 'A1-token' },
  { url: projects[0], userId: 'user-2', token: 'A2-token' },
  { url: projects[1], userId: 'user-1', token: 'B1-token' },
] as const;
export const ownerOf = (url: string, userId: string) => JSON.stringify([url, userId]);
export interface RequestTrace { owner: string; method: string; id: string | null; body: Record<string, unknown> | null }
type Row = { id: string; user_id: string; [key: string]: unknown };
export class SupabaseMemory {
  readonly rows = new Map<string, Map<string, Row>>();
  readonly requests: RequestTrace[] = [];
  offline = false;
  beforeRequest: ((request: RequestTrace) => Promise<void> | void) | null = null;
  account(url: string, userId: string) {
    const owner = ownerOf(url, userId);
    if (!this.rows.has(owner)) this.rows.set(owner, new Map());
    return this.rows.get(owner)!;
  }
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (!projects.some((project) => url.origin === project) || url.pathname !== '/rest/v1/workspaces') throw new Error('Unmocked network request blocked');
    const headers = new Headers(init?.headers);
    const identity = identities.find((item) => item.url === url.origin && headers.get('authorization') === `Bearer ${item.token}`);
    if (!identity) return new Response(JSON.stringify({ message: 'Invalid project token' }), { status: 401 });
    const owner = ownerOf(identity.url, identity.userId);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
    const id = url.searchParams.get('id')?.replace(/^eq\./, '') ?? null;
    const trace = { owner, method, body, id };
    this.requests.push(trace);
    await this.beforeRequest?.(trace);
    if (this.offline) throw new Error('Simulated offline connection');
    if (method !== 'POST' && url.searchParams.get('user_id') !== `eq.${identity.userId}`) throw new Error('Missing account filter');
    const rows = this.account(identity.url, identity.userId);
    if (method === 'DELETE') { if (id) rows.delete(id); return new Response(null, { status: 204 }); }
    if (method === 'POST') {
      if (!body || body.user_id !== identity.userId) throw new Error('Cross-account upload rejected');
      const row = { ...body, id: String(body.id), user_id: identity.userId, updated_at: '2026-10-12T00:00:00.000Z' };
      rows.set(row.id, structuredClone(row));
      return Response.json(row);
    }
    const items = [...rows.values()].filter((row) => (!id || row.id === id) && (url.searchParams.get('status') !== 'neq.archived' || row.status !== 'archived'));
    return Response.json(headers.get('accept')?.includes('vnd.pgrst.object') ? items[0] ?? null : items);
  };
}
