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
  return json.data as T;
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

export const api = {
  health: () => request<HealthResponse>('/health'),
  ready: () => request<{ ready: boolean }>('/ready'),
};
