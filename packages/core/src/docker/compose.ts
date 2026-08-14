// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Thin wrapper around the `docker compose` plugin. This is the ONE place we
 * shell out (CLAUDE.md §15) — every app lifecycle action funnels through here.
 *
 * Project naming: each app is its own compose project `omos-<id>`. The core's
 * own project is `openmasjid` and is managed by the installer, never here — so
 * nothing in this file can ever touch the core or a user's other containers.
 *
 * Many actions (stop/start/restart/logs/down) accept just the project name and
 * operate via Docker's compose labels, so they still work for an "orphan" app
 * whose on-disk compose file was lost — see CLAUDE.md golden rule (§8.1).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { log } from '../logger';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `docker <args>` and capture output. Never rejects on non-zero exit. */
function run(args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function fileArgs(composeFile?: string): string[] {
  return composeFile && fs.existsSync(composeFile) ? ['-f', composeFile] : [];
}

/** `docker compose -p <project> [-f file] up -d` */
export async function composeUp(
  project: string,
  composeFile: string,
  envFile?: string,
): Promise<RunResult> {
  const args = ['compose', '-p', project, ...fileArgs(composeFile)];
  if (envFile && fs.existsSync(envFile)) args.push('--env-file', envFile);
  args.push('up', '-d', '--remove-orphans');
  log.info(`compose up: ${project}`);
  return run(args);
}

export async function composeStop(project: string): Promise<RunResult> {
  return run(['compose', '-p', project, 'stop']);
}

export async function composeStart(project: string): Promise<RunResult> {
  return run(['compose', '-p', project, 'start']);
}

export async function composeRestart(project: string): Promise<RunResult> {
  return run(['compose', '-p', project, 'restart']);
}

/** `docker compose -p <project> down [-v] [--rmi all]`. Removes the app's
 *  containers, and (when requested) its volumes and images so a full uninstall
 *  actually reclaims disk. Images shared with another running app are skipped by
 *  Docker, so this never breaks other apps. */
export async function composeDown(
  project: string,
  composeFile?: string,
  removeVolumes = false,
  removeImages = false,
): Promise<RunResult> {
  const args = ['compose', '-p', project, ...fileArgs(composeFile), 'down'];
  if (removeVolumes) args.push('-v');
  if (removeImages) args.push('--rmi', 'all');
  log.info(`compose down: ${project} (volumes: ${removeVolumes}, images: ${removeImages})`);
  return run(args);
}

/** Reclaim disk by removing images not used by any container (running OR
 *  stopped), plus dangling layers. Installed apps keep their containers, so
 *  their images are preserved; only leftovers from removed apps + old core
 *  images are freed. Returns the raw `docker` output (has "Total reclaimed…"). */
export async function pruneUnusedImages(): Promise<RunResult> {
  log.info('pruning unused images');
  return run(['image', 'prune', '-a', '-f']);
}

/** Like run(), but streams each output line to onLine (for live progress in the
 *  UI). Splits on \r and \n so `docker` progress redraws become clean lines. */
function runStream(args: string[], onLine: (s: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('docker', args);
    const handle = (buf: Buffer) => {
      for (const line of buf.toString().split(/[\r\n]+/)) {
        if (line.trim()) onLine(line);
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', (err) => {
      onLine(`Error: ${err.message}`);
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? -1));
  });
}

/** `docker compose -p <project> [-f file] [--env-file] pull` — streamed. */
export async function composePull(
  project: string,
  composeFile: string,
  envFile: string | undefined,
  onLine: (s: string) => void,
): Promise<number> {
  const args = ['compose', '-p', project, ...fileArgs(composeFile)];
  if (envFile && fs.existsSync(envFile)) args.push('--env-file', envFile);
  args.push('pull');
  return runStream(args, onLine);
}

/** `docker compose -p <project> [-f file] [--env-file] up -d --remove-orphans` — streamed. */
export async function composeUpStream(
  project: string,
  composeFile: string,
  envFile: string | undefined,
  onLine: (s: string) => void,
): Promise<number> {
  const args = ['compose', '-p', project, ...fileArgs(composeFile)];
  if (envFile && fs.existsSync(envFile)) args.push('--env-file', envFile);
  args.push('up', '-d', '--remove-orphans');
  return runStream(args, onLine);
}

export async function composeLogs(project: string, tail = 200): Promise<string> {
  const res = await run(['compose', '-p', project, 'logs', '--no-color', `--tail=${tail}`]);
  return (res.stdout + res.stderr).trim();
}

