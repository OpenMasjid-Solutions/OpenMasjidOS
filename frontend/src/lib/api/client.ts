// Base URL is empty — requests go to the same origin (Go serves both API and UI)
const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? 'Unknown error');
  }

  const json = await res.json();
  // API returns the payload directly or wrapped in { data: ... }
  return (json.data ?? json) as T;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface HealthResponse {
  status: string;
  version: string;
}

export interface AuthState {
  setup_required: boolean;
  authenticated: boolean;
  username?: string;
}

export const api = {
  health: () => request<HealthResponse>('/health'),
  ready: () => request<{ ready: boolean }>('/ready'),

  auth: {
    /** Whether the platform needs setup and whether the caller is signed in. */
    me: () => request<AuthState>('/auth/me'),
    /** First-run: create the admin account (also starts a session). */
    setup: (username: string, password: string) =>
      request<{ authenticated: boolean; username: string }>('/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
    /** Sign in with the admin credentials. */
    login: (username: string, password: string) =>
      request<{ authenticated: boolean; username: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
    /** Sign out and clear the session cookie. */
    logout: () => request<{ authenticated: boolean }>('/auth/logout', { method: 'POST' }),
  },
};
