// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Discovers OpenMasjidOS apps that are actually present in Docker, keyed by
 * their compose project (`omos-<id>`). This is the safety net behind the golden
 * rule (CLAUDE.md §8.1): even if an app's on-disk metadata is lost, a running
 * container is rediscovered here so the app is never silently dropped from the
 * dashboard.
 */
import type Dockerode from 'dockerode';
import { docker } from './client';

const PROJECT_LABEL = 'com.docker.compose.project';
const PROJECT_PREFIX = 'omos-';
// OpenMasjidOS's OWN infrastructure also runs as omos-* compose projects (e.g. the
// Cloudflare tunnel), but those are NOT user apps — exclude them so they never show
// on the dashboard or count toward "apps running".
const RESERVED_PROJECTS = new Set(['omos-cloudflared']);

export interface DiscoveredApp {
  /** Compose project, e.g. "omos-prayer-times". */
  project: string;
  /** App id (project without the omos- prefix). */
  id: string;
  /** True if any container in the project is running. */
  running: boolean;
  /** Published host ports across the project's containers. */
  ports: number[];
  /** com.openmasjid.kind label if present ("catalog" | "custom"). */
  kind?: string;
  /** com.openmasjid.name label if present (display name). */
  name?: string;
}

/** Map of project → discovered app, built from live Docker state. */
export async function discoverApps(): Promise<Map<string, DiscoveredApp>> {
  const result = new Map<string, DiscoveredApp>();
  let containers: Dockerode.ContainerInfo[];
  try {
    containers = await docker.listContainers({ all: true });
  } catch {
    return result; // Docker unreachable — return nothing rather than throwing.
  }

  for (const c of containers) {
    const labels = c.Labels ?? {};
    const project = labels[PROJECT_LABEL];
    if (!project || !project.startsWith(PROJECT_PREFIX) || RESERVED_PROJECTS.has(project)) continue;

    const id = project.slice(PROJECT_PREFIX.length);
    const existing = result.get(project) ?? {
      project,
      id,
      running: false,
      ports: [] as number[],
      kind: labels['com.openmasjid.kind'],
      name: labels['com.openmasjid.name'],
    };

    if (c.State === 'running') existing.running = true;
    for (const p of c.Ports ?? []) {
      if (p.PublicPort && !existing.ports.includes(p.PublicPort)) {
        existing.ports.push(p.PublicPort);
      }
    }
    result.set(project, existing);
  }

  for (const app of result.values()) app.ports.sort((a, b) => a - b);
  return result;
}

/** The set of running app project names — used by the "apps running" stat. */
export async function runningProjectCount(): Promise<number> {
  const apps = await discoverApps();
  let n = 0;
  for (const a of apps.values()) if (a.running) n++;
  return n;
}
