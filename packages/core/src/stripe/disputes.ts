// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Stripe disputes (chargebacks) — the API call and the parsing, kept apart from the
 * monitor that schedules it so the awkward parts are testable without a network.
 *
 * **Why the platform polls instead of receiving webhooks.** A chargeback is
 * account-level, not app-level: the whole point of the Stripe vault
 * (`store/stripe.ts`) is that several apps share ONE account, so an app-raised alert
 * would either double-fire or, if that app happened to be stopped, never fire at all
 * — and chargebacks arrive days or weeks after the payment, when the app may well be
 * off. A webhook would also need a publicly reachable platform route, and
 * `CLAUDE.md §15` allows exactly two public routes over the tunnel
 * (`/api/public/appearance`, `/api/public/logo`); adding a third would breach that,
 * and would still leave every LAN-only masjid with no alerts at all. Polling is
 * outbound-only, needs no new attack surface, works on a box with no remote access,
 * and requires no change to any app. The cost is latency — up to one poll interval —
 * which is immaterial against a dispute response window measured in days.
 *
 * Nothing here trusts the response shape. This is an external API we cannot
 * integration-test in CI (it needs live credentials), so every field is treated as
 * unknown: a missing or wrongly-typed value drops that detail from the alert rather
 * than throwing, or printing "undefined" at a volunteer.
 */

/** Stripe's dispute states. Kept as a plain string too — Stripe may add more. */
export type DisputeStatus =
  | 'warning_needs_response'
  | 'warning_under_review'
  | 'warning_closed'
  | 'needs_response'
  | 'under_review'
  | 'won'
  | 'lost'
  | (string & {});

export interface Dispute {
  id: string;
  /** Minor units (e.g. pence). Null when Stripe didn't give us a usable number. */
  amount: number | null;
  currency: string | null;
  reason: string | null;
  status: DisputeStatus | null;
  /** Unix seconds. */
  created: number | null;
  /** Unix seconds by which evidence must be submitted, when Stripe supplies it. */
  dueBy: number | null;
}

/** The two states that mean the masjid still has to do something, and a deadline. */
export function needsResponse(status: string | null): boolean {
  return status === 'needs_response' || status === 'warning_needs_response';
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Parse one entry of Stripe's `data` array. Returns null if it has no usable id. */
export function parseDispute(raw: unknown): Dispute | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id);
  if (!id) return null;
  const evidence = o.evidence_details;
  const dueBy =
    evidence && typeof evidence === 'object' ? num((evidence as Record<string, unknown>).due_by) : null;
  return {
    id,
    amount: num(o.amount),
    currency: str(o.currency),
    reason: str(o.reason),
    status: str(o.status),
    created: num(o.created),
    dueBy,
  };
}

/** Parse a whole `GET /v1/disputes` body, skipping anything unusable. */
export function parseDisputeList(body: unknown): Dispute[] {
  if (!body || typeof body !== 'object') return [];
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  const out: Dispute[] = [];
  for (const entry of data) {
    const d = parseDispute(entry);
    if (d) out.push(d);
  }
  return out;
}

// Stripe quotes amounts in the currency's smallest unit. Most currencies have two
// decimal places, but not all — and dividing by 100 regardless would misreport a
// Gulf masjid's KWD by 10x and a JPY amount by 100x. Getting money wrong in an alert
// about money is not a detail.
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);
const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

export function currencyDecimals(currency: string | null): number {
  const c = (currency ?? '').toLowerCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

/** "£45.00" style, or null when Stripe gave us nothing to format. */
export function formatAmount(amount: number | null, currency: string | null): string | null {
  if (amount == null) return null;
  const decimals = currencyDecimals(currency);
  const value = amount / 10 ** decimals;
  const code = (currency ?? '').toUpperCase();
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: code || 'USD',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  } catch {
    // Unknown/blank currency code — still show the number rather than nothing.
    return `${value.toFixed(decimals)}${code ? ` ${code}` : ''}`;
  }
}

/**
 * Stripe's reason codes in words a volunteer treasurer can act on. An unrecognised
 * code falls back to the code itself tidied up, so a new Stripe reason still reads
 * as something rather than disappearing.
 */
const REASONS: Record<string, string> = {
  fraudulent: "The cardholder says they didn't recognise or authorise this payment.",
  general: 'The cardholder disputed this payment without giving a specific reason.',
  duplicate: 'The cardholder says they were charged more than once for the same thing.',
  credit_not_processed: 'The cardholder says a refund they were promised never arrived.',
  product_not_received: "The cardholder says they didn't receive what they paid for.",
  product_unacceptable: "The cardholder says what they received wasn't as described.",
  subscription_canceled: 'The cardholder says this was a cancelled recurring payment.',
  unrecognized: "The cardholder doesn't recognise this payment on their statement.",
  incorrect_account_details: 'The account details on the payment were incorrect.',
  insufficient_funds: "The cardholder's account didn't have enough funds.",
  bank_cannot_process: "The cardholder's bank could not process the payment.",
  debit_not_authorized: 'The cardholder says this debit was not authorised.',
  customer_initiated: 'The cardholder raised this with their bank directly.',
  check_returned: 'A cheque used for this payment was returned.',
  noncompliant: "The payment didn't meet the card network's rules.",
};

export function reasonText(reason: string | null): string {
  if (!reason) return 'The cardholder disputed this payment with their bank.';
  return REASONS[reason] ?? `The reason given was "${reason.replace(/_/g, ' ')}".`;
}

/** A deadline in plain words: "by 14 August 2026". Null when there isn't one. */
export function formatDueBy(dueBy: number | null): string | null {
  if (dueBy == null) return null;
  const ms = dueBy * 1000;
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export interface FetchResult {
  /** False means we could not ASK Stripe — very different from "there are none",
   *  and the caller must NOT treat it as "nothing new" or record any state. */
  ok: boolean;
  disputes: Dispute[];
  error?: string;
}

const API = 'https://api.stripe.com/v1/disputes';
const TIMEOUT_MS = 10_000;
/** One page is plenty: a masjid will not open 100 new disputes between polls. */
const PAGE_SIZE = 100;

/**
 * Fetch the most recent disputes for one account. Never throws, and never logs or
 * returns the secret key.
 */
export async function fetchDisputes(secretKey: string): Promise<FetchResult> {
  if (!secretKey) return { ok: false, disputes: [], error: 'no secret key configured' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}?limit=${PAGE_SIZE}`, {
      headers: { authorization: `Bearer ${secretKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // Stripe puts a human-readable reason in error.message. It never contains the
      // key (Stripe masks it), but read it defensively and cap the length.
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { message?: unknown } };
        const msg = str(body?.error?.message);
        if (msg) detail = msg.slice(0, 200);
      } catch {
        /* non-JSON error body — the status is enough */
      }
      return { ok: false, disputes: [], error: detail };
    }
    return { ok: true, disputes: parseDisputeList(await res.json()) };
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    return { ok: false, disputes: [], error: aborted ? 'Stripe did not respond in time' : (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
