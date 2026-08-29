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

export interface DiscoveryResult {
  apps: Map<string, DiscoveredApp>;
  /**
   * Did we actually get an answer from Docker?
   *
   * `false` means the daemon could not be ASKED — which is emphatically not the same as
   * "there are no apps", even though both used to arrive as an empty map. Callers that
   * merely display a list can ignore this; callers that make DECISIONS from it must not.
   *
   * This distinction was missing and it cost a masjid their public site. An empty result
   * flowed into `listInstalled`, which reported every app with `ports: []` and
   * `running: false`; `system/ingress.ts` then rebuilt its routing table, dropped every
   * app for having no port, and answered `{"error":"Not found."}` to every visitor until
   * the next 10-second tick. The rebuild's own `catch` was written to prevent exactly
   * that and never fired, because nothing threw. Meanwhile `system/alert-monitor.ts` saw
   * every app go from running to not-running and would email an "app went offline" alert
   * for all of them.
   *
   * Same rule as CLAUDE.md §13.2d states for Stripe, and as the WhatsApp health monitor
   * follows: **"couldn't ask" is never an answer.**
   */
  ok: boolean;
}

/**
 * Live Docker state, WITH whether we actually managed to read it.
 *
 * Prefer this over `discoverApps()` anywhere the answer drives a decision.
 */
export async function discoverAppsResult(): Promise<DiscoveryResult> {
  const result = new Map<string, DiscoveredApp>();
  let containers: Dockerode.ContainerInfo[];
  try {
    containers = await docker.listContainers({ all: true });
  } catch {
    // Nothing to report AND we could not ask. The second half is the important half.
    return { apps: result, ok: false };
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
  return { apps: result, ok: true };
}

/**
 * Live Docker state, discarding whether we could read it.
 *
 * Kept for callers that only ever DISPLAY the result, where an empty list during a hiccup
 * is a cosmetic blip. Anything that routes traffic, alerts, or decides an app is gone must
 * use `discoverAppsResult` instead — see the note on `DiscoveryResult.ok`.
 */
export async function discoverApps(): Promise<Map<string, DiscoveredApp>> {
  return (await discoverAppsResult()).apps;
}

/** The set of running app project names — used by the "apps running" stat. */
export async function runningProjectCount(): Promise<number> {
  const apps = await discoverApps();
  let n = 0;
  for (const a of apps.values()) if (a.running) n++;
  return n;
}
