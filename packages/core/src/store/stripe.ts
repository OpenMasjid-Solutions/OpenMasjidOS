// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Stripe account vault. The admin configures one or more NAMED Stripe accounts
 * here ONCE; apps that opt into the Fabric `stripe` capability fetch a named
 * account's keys at runtime via GET /api/fabric/stripe — so the donations page,
 * a kiosk, etc. can all share one account without re-entering keys.
 *
 * Secrets (secret key + webhook signing secret) live ONLY in stripe.json under the
 * config dir (chmod 600) — never in settings.json and never in the admin-facing
 * API (which returns a sanitized view: label + publishable key + "is set" flags).
 * The full keys leave the platform only over the secret-gated Fabric endpoint to
 * an installed app that holds the capability.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../config';
import { readJson, writeJson } from '../util/json-store';
import { slugify } from '../util/slug';

export interface StripeAccount {
  id: string;
  label: string;
  publishableKey: string;
  secretKey: string;
  webhookSecret: string;
}

interface StripeFile {
  accounts: StripeAccount[];
}

const STRIPE_PATH = path.join(CONFIG_DIR, 'stripe.json');
let cache: StripeFile = readJson(STRIPE_PATH, { accounts: [] });

/** Re-read the Stripe accounts from disk — for a restore, which replaces it under this process. */
export function reloadStripeConfig(): void {
  cache = readJson(STRIPE_PATH, { accounts: [] });
}

function persist(): void {
  writeJson(STRIPE_PATH, cache);
  try {
    fs.chmodSync(STRIPE_PATH, 0o600);
  } catch {
    /* best effort (non-POSIX dev) */
  }
}

/** Non-secret view for the admin UI: the publishable key (public anyway) plus
 *  flags for whether the secret/webhook are set — never the secret values. */
export interface StripeAccountPublic {
  id: string;
  label: string;
  publishableKey: string;
  hasSecret: boolean;
  hasWebhook: boolean;
}

function toPublic(a: StripeAccount): StripeAccountPublic {
  return {
    id: a.id,
    label: a.label,
    publishableKey: a.publishableKey,
    hasSecret: Boolean(a.secretKey),
    hasWebhook: Boolean(a.webhookSecret),
  };
}

export function listAccountsPublic(): StripeAccountPublic[] {
  return cache.accounts.map(toPublic);
}

/** Internal: full accounts (incl. secrets) for server-side checks only (e.g. the
 *  online/offline status probe). Never expose this over the admin API. */
export function listAccountsInternal(): StripeAccount[] {
  return cache.accounts;
}

/** Full account incl. secrets — ONLY for the Fabric endpoint to hand an authed app. */
export function getAccountFull(idOrLabel: string): StripeAccount | null {
  const k = idOrLabel.trim().toLowerCase();
  return cache.accounts.find((a) => a.id === k || a.label.toLowerCase() === k) ?? null;
}

export interface UpsertInput {
  id?: string;
  label: string;
  publishableKey: string;
  secretKey?: string;
  webhookSecret?: string;
}

/** Add a new account or update an existing one (by id). On update, a blank secret key
 *  keeps the existing one so the admin needn't re-paste it; an omitted webhook secret
 *  keeps the existing one too, and an empty one clears it (it is optional). */
export function upsertAccount(input: UpsertInput): StripeAccountPublic {
  const label = input.label.trim();
  if (!label) throw new Error('Give this Stripe account a name.');

  const existing = input.id ? cache.accounts.find((a) => a.id === input.id) : undefined;
  if (existing) {
    existing.label = label;
    if (input.publishableKey.trim()) existing.publishableKey = input.publishableKey.trim();
    if (input.secretKey && input.secretKey.trim()) existing.secretKey = input.secretKey.trim();
    if (input.webhookSecret !== undefined) existing.webhookSecret = input.webhookSecret.trim();
    persist();
    return toPublic(existing);
  }

  // New account — needs at least the publishable + secret key to be usable.
  if (!input.publishableKey.trim()) throw new Error('Paste the publishable key.');
  if (!input.secretKey || !input.secretKey.trim()) throw new Error('Paste the secret key.');
  const base = slugify(label) || 'account';
  let id = base;
  let n = 2;
  while (cache.accounts.some((a) => a.id === id)) id = `${base}-${n++}`;
  const acc: StripeAccount = {
    id,
    label,
    publishableKey: input.publishableKey.trim(),
    secretKey: input.secretKey.trim(),
    webhookSecret: (input.webhookSecret ?? '').trim(),
  };
  cache.accounts.push(acc);
  persist();
  return toPublic(acc);
}

export function removeAccount(id: string): void {
  cache.accounts = cache.accounts.filter((a) => a.id !== id);
  persist();
}
