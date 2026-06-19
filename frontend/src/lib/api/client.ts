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
    throw new ApiError(res.status, body.error ?? 'Unknown error', body.meta?.details);
  }

  const json = await res.json();
  // API returns the payload directly or wrapped in { data: ... }
  return (json.data ?? json) as T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface InstalledApp {
  id: string;
  name: string;
  custom: boolean;
  created_at: string;
  running: boolean;
  ports: number[];
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

export interface StatsSnapshot {
  cpu_percent: number;
  mem_used: number;
  mem_total: number;
  disk_used: number;
  disk_total: number;
  uptime_sec: number;
  net_rx_bytes: number;
  net_tx_bytes: number;
}

export const api = {
  health: () => request<HealthResponse>('/health'),
  ready: () => request<{ ready: boolean }>('/ready'),
  stats: () => request<StatsSnapshot>('/stats'),

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

  apps: {
    /** List installed apps with their running state. */
    list: () => request<{ apps: InstalledApp[] }>('/apps'),
    /** Install a 3rd-party app from a pasted Docker Compose file. */
    installCustom: (name: string, compose: string) =>
      request<InstalledApp>('/apps/custom', {
        method: 'POST',
        body: JSON.stringify({ name, compose }),
      }),
    /** Stop an app's containers (without removing them). */
    stop: (id: string) => request<{ ok: boolean }>(`/apps/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
    /** Start a stopped app. */
    start: (id: string) => request<{ ok: boolean }>(`/apps/${encodeURIComponent(id)}/start`, { method: 'POST' }),
    /** Restart an app. */
    restart: (id: string) => request<{ ok: boolean }>(`/apps/${encodeURIComponent(id)}/restart`, { method: 'POST' }),
    /** Stop and remove an app (optionally deleting its data). */
    remove: (id: string, data = false) =>
      request<{ removed: string }>(`/apps/${encodeURIComponent(id)}?data=${data}`, {
        method: 'DELETE',
      }),
  },
};
