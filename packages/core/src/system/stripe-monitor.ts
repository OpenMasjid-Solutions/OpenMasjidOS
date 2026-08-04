// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Chargeback monitor. Polls each configured Stripe account for new disputes and
 * raises the OS `stripe-chargeback` alert, gated by the admin's per-alert ×
 * per-channel matrix like every other OS alert.
 *
 * Why the platform does this rather than a donations app: see the note at the top of
 * `stripe/disputes.ts`. Short version — a chargeback belongs to the ACCOUNT, which
 * several apps deliberately share, and it lands days or weeks after the payment when
 * the app may be stopped. Doing it here also means it works with whatever apps a
 * masjid already has installed, with no app change and no new public route.
 *
 * State is PERSISTED (unlike the update monitor's in-memory tracking, which is fine
 * for "an update is pending" because that stays true). A chargeback is a one-shot
 * event, so in-memory tracking would re-alert about every open dispute on each
 * restart. The file lives in `config/`, which the File Explorer refuses to touch.
 */
import path from 'node:path';
import { CONFIG_DIR } from '../config';
import { readJson, writeJson } from '../util/json-store';
import { listAccountsInternal } from '../store/stripe';
import { deliverAlert } from '../notify/alerts';
import { stripeChargeback, stripeChargebacksMany } from '../notify/alert-copy';
import {
  fetchDisputes,
  needsResponse,
  formatAmount,
  formatDueBy,
  reasonText,
  type Dispute,
} from '../stripe/disputes';
import { log } from '../logger';

const CHECK_MS = 30 * 60_000; // every 30 minutes — a dispute deadline is days away
const FIRST_CHECK_MS = 45_000; // shortly after boot, staggered behind the update monitor
/** Above this many new disputes in one poll, send one grouped alert, not a flood. */
const INDIVIDUAL_ALERT_LIMIT = 5;
/** Keep the seen list bounded; far more than any masjid will ever accumulate. */
const MAX_SEEN = 500;

const STATE_PATH = path.join(CONFIG_DIR, 'stripe-disputes.json');

interface AccountState {
  /** Dispute ids already alerted about (or absorbed on first run). */
  seen: string[];
  /** True once this account has completed one poll, so we know history is absorbed. */
  initialised: boolean;
}
interface StateFile {
  accounts?: Record<string, AccountState>;
}

function loadState(): StateFile {
  const f = readJson<StateFile>(STATE_PATH, {});
  return f && typeof f === 'object' ? f : {};
}

/**
 * Which of the fetched disputes to alert about, and the seen-set to persist.
 *
 * Pure, so the awkward first-run rule can be tested without touching Stripe or disk.
 *
 * **The first-run rule.** On the very first poll for an account we must not email a
 * masjid about disputes that are months old and already dealt with — but we also must
 * not silently swallow one that is still open with a deadline attached, because that
 * is real money the masjid can still lose by doing nothing. So: absorb history
 * quietly, EXCEPT disputes that still need a response, which alert.
 */
export function selectNewDisputes(
  fetched: Dispute[],
  state: AccountState | undefined,
): { toAlert: Dispute[]; seen: string[]; firstRun: boolean } {
  const prior = new Set(state?.seen ?? []);
  const firstRun = !state?.initialised;
  const fresh = fetched.filter((d) => !prior.has(d.id));
  const toAlert = firstRun ? fresh.filter((d) => needsResponse(d.status)) : fresh;
  // Newest first from Stripe; keep the newest ids and cap the list.
  const seen = [...fetched.map((d) => d.id), ...(state?.seen ?? [])];
  const deduped = [...new Set(seen)].slice(0, MAX_SEEN);
  return { toAlert, seen: deduped, firstRun };
}

/** Sum amounts that share a currency; null if they don't (mixed → no total shown). */
function combinedTotal(disputes: Dispute[]): string | null {
  const withAmount = disputes.filter((d) => d.amount != null);
  if (withAmount.length === 0) return null;
  const currencies = new Set(withAmount.map((d) => (d.currency ?? '').toLowerCase()));
  if (currencies.size !== 1) return null; // adding GBP to JPY would be nonsense
  // Same currency, so the minor units add up directly — they're whole numbers of
  // pence/cents/fils, which is exactly why Stripe quotes them that way.
  const total = withAmount.reduce((sum, d) => sum + (d.amount ?? 0), 0);
  return formatAmount(total, withAmount[0]!.currency);
}

/** The earliest reply deadline across a batch, in words. */
function soonestDueBy(disputes: Dispute[]): string | null {
  const dues = disputes.map((d) => d.dueBy).filter((v): v is number => v != null);
  if (dues.length === 0) return null;
  return formatDueBy(Math.min(...dues));
}

async function alertOne(accountLabel: string, d: Dispute): Promise<void> {
  const copy = stripeChargeback({
    accountLabel,
    amount: formatAmount(d.amount, d.currency),
    reason: reasonText(d.reason),
    dueBy: formatDueBy(d.dueBy),
    needsResponse: needsResponse(d.status),
    reference: d.id,
  });
  // The webhook channel is text-only — `facts` reach the email but not Slack/Discord.
  // So the account name is appended HERE rather than folded into `summary`: a masjid
  // running two Stripe accounts (donations and a bookshop, say) has to be able to
  // tell which one was hit, and `summary` is also the email's inbox snippet, which
  // has to stay short enough to survive untruncated.
  await deliverAlert({
    source: 'os',
    text: `${copy.summary} (Stripe account: ${accountLabel})`,
    ...copy,
  });
}

async function alertMany(accountLabel: string, disputes: Dispute[]): Promise<void> {
  const copy = stripeChargebacksMany({
    count: disputes.length,
    accountLabel,
    total: combinedTotal(disputes),
    soonest: soonestDueBy(disputes),
  });
  // This summary already names the account, so no need to append it for the webhook.
  await deliverAlert({ source: 'os', text: copy.summary, ...copy });
}

async function checkAccount(
  account: { id: string; label: string; secretKey: string },
  state: StateFile,
): Promise<void> {
  const res = await fetchDisputes(account.secretKey);
  if (!res.ok) {
    // Could not ASK Stripe. Record NOTHING — treating an unreachable API as "no
    // disputes" would mark unseen chargebacks as seen and lose them permanently.
    // Never alert about this either: a flaky network must not page the admin.
    log.warn(`Stripe dispute check failed for "${account.label}": ${res.error ?? 'unknown error'}`);
    return;
  }

  const before = state.accounts?.[account.id];
  const { toAlert, seen, firstRun } = selectNewDisputes(res.disputes, before);

  // Persist BEFORE alerting: a crash mid-send should not re-alert the whole batch on
  // the next boot. Losing one notification is recoverable (Stripe still shows the
  // dispute); emailing a volunteer the same chargeback repeatedly is not.
  state.accounts = { ...(state.accounts ?? {}), [account.id]: { seen, initialised: true } };
  writeJson(STATE_PATH, state);

  if (firstRun) {
    const absorbed = res.disputes.length - toAlert.length;
    if (absorbed > 0) {
      log.info(
        `Stripe "${account.label}": ${absorbed} existing dispute(s) recorded without alerting (first check). ` +
          `${toAlert.length} still awaiting a reply will be alerted.`,
      );
    }
  }
  if (toAlert.length === 0) return;

  if (toAlert.length > INDIVIDUAL_ALERT_LIMIT) {
    log.warn(`Stripe "${account.label}": ${toAlert.length} new disputes — sending one grouped alert.`);
    await alertMany(account.label, toAlert);
    return;
  }
  for (const d of toAlert) await alertOne(account.label, d);
}

async function tick(): Promise<void> {
  const accounts = listAccountsInternal().filter((a) => a.secretKey);
  if (accounts.length === 0) return; // no Stripe configured — nothing to do
  const state = loadState();
  for (const a of accounts) {
    try {
      await checkAccount(a, state);
    } catch (err) {
      // One bad account must not stop the others being checked.
      log.warn(`Stripe dispute check errored for "${a.label}": ${(err as Error).message}`);
    }
  }
}

export function startStripeMonitor(): void {
  const first = setTimeout(() => void tick(), FIRST_CHECK_MS);
  first.unref?.();
  const timer = setInterval(() => void tick(), CHECK_MS);
  timer.unref?.();
  log.info('Stripe chargeback alert monitor started.');
}

/** Run one check immediately, rather than waiting for the next interval. */
export async function checkStripeDisputesNow(): Promise<void> {
  await tick();
}
