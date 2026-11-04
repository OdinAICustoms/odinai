/** Every call to the server. Writes carry X-OdinAi: 1 (the server refuses writes without it). */
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public data?: any) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method || (opts.body !== undefined ? 'POST' : 'GET');
  const r = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(method !== 'GET' ? { 'X-OdinAi': '1' } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new ApiError(r.status, d.error || `Forespørselen feilet (${r.status})`, d.code, d);
    if (r.status === 401 && path !== '/auth/login') window.dispatchEvent(new CustomEvent('odinai:signed-out'));
    if (d.code === 'PW_CHANGE') window.dispatchEvent(new CustomEvent('odinai:pw-change'));
    throw e;
  }
  return d as T;
}

export interface Me { id: string; email: string; name: string; roles: string[]; perms: string[]; lang: 'no' | 'en'; mustChange: boolean }
