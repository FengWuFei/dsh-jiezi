/**
 * Browser transport for the authenticated same-origin `/api/jiezi/*` routes.
 *
 * The page already carries its Connection credential as a same-origin cookie,
 * so a relative fetch needs no plugin-managed token. Every failure is reduced
 * to one message the panel can show.
 */

import { API_ROUTES, clientRoute } from '../shared/protocol.js';

/** Result of one Host API call. */
export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

/** A Host route, resolved against the document base. */
function route(path: string, params?: Record<string, string | number | undefined>): string {
  const relative = clientRoute(path);
  if (params === undefined) return relative;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query.length === 0 ? relative : `${relative}?${query}`;
}

async function call<T>(url: string, init: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, { credentials: 'same-origin', ...init });
    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        return { ok: false, code: 'invalid_response', message: `Host returned non-JSON (HTTP ${response.status})` };
      }
    }
    if (response.status === 401) {
      return { ok: false, code: 'unauthorized', message: '会话已失效，请刷新页面后在 DSH 中重新登录。' };
    }
    if (!response.ok) {
      const error = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as { error?: { code?: unknown; message?: unknown } }).error
        : undefined;
      return {
        ok: false,
        code: typeof error?.code === 'string' ? error.code : `http_${response.status}`,
        message: typeof error?.message === 'string' ? error.message : `Host request failed (HTTP ${response.status})`,
      };
    }
    return { ok: true, value: body as T };
  } catch (error) {
    return { ok: false, code: 'network_error', message: error instanceof Error ? error.message : String(error) };
  }
}

/** GET one panel route. */
export function apiGet<T>(path: string, params?: Record<string, string | number | undefined>): Promise<ApiResult<T>> {
  return call<T>(route(path, params), { method: 'GET', headers: { accept: 'application/json' } });
}

/** POST one panel route with a small JSON body. */
export function apiPost<T>(path: string, body: unknown = {}): Promise<ApiResult<T>> {
  return call<T>(route(path), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Route constants re-exported for the panel. */
export { API_ROUTES };
