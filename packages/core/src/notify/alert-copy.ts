// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The words in every OS alert, in one place.
 *
 * Pulled out of the monitors so they hold logic only, and so all the copy a masjid
 * volunteer actually reads can be reviewed together against CLAUDE.md §14 (plain,
 * warm, non-technical). It also gives the strings a single home for the day emails
 * get translated — today they are hardcoded English, because packages/core has no
 * i18n at all (that is a real §17 gap for email, not an oversight here).
 *
 * Rules that come from a real bug report, not taste:
 *   - NO UI-chrome glyphs. The old app-update text contained `⋯` (U+22EF MIDLINE
 *     HORIZONTAL ELLIPSIS) and `→`; most email font stacks lack U+22EF, so it
 *     arrived as a tofu box. Name buttons in words instead.
 *   - `summary` is the FIRST line of the plain-text body, and the plain-text part
 *     is what a mail client shows as the inbox snippet. So it must lead with the
 *     news and stay short enough to survive un-truncated (~90 chars).
 *   - `title` is short and version-free: it is both the H1 and the subject.
 */

/** One row of the scannable label/value block in the email. */
export interface AlertFact {
  label: string;
  value: string;
}

/** Where to send the reader, and what to press when they arrive. */
export interface AlertAction {
  /** Button text, e.g. "Open OpenMasjidOS". */
  label: string;
  /** What to do once there, in words — never a menu path. */
  note: string;
  /** Dashboard-relative path, e.g. "/" or "/apps/<id>". */
  path: string;
}

export interface AlertCopy {
  alertId: 'app-offline' | 'core-update' | 'app-update' | 'stripe-chargeback';
  level: 'info' | 'warning' | 'error';
  /** The H1 and the subject. One short phrase. */
  title: string;
  /** First body line = the inbox snippet. Lead with the news. */
  summary: string;
  /** Reassurance / what happens next. */
  detail?: string;
  facts?: AlertFact[];
  action?: AlertAction;
}

/** An installed app stopped running. */
export function appOffline(name: string, id: string): AlertCopy {
  return {
    alertId: 'app-offline',
    level: 'error',
    title: `${name} has stopped`,
    summary: `${name} has stopped running, so nobody can use it right now.`,
    // Deliberately does NOT repeat the instruction — the action note below carries
    // it, and saying it twice reads as nagging.
    detail: 'Apps sometimes stop after a power cut or a restart. It may come back on its own.',
    facts: [
      { label: 'App', value: name },
      { label: 'Status', value: 'Stopped' },
    ],
    // Start lives on the app's own page.
    action: { label: 'Open OpenMasjidOS', note: 'Then press Start.', path: `/apps/${id}` },
  };
}

/** A newer OpenMasjidOS release is available. */
export function coreUpdate(current: string, latest: string): AlertCopy {
  return {
    alertId: 'core-update',
    level: 'info',
    title: `OpenMasjidOS ${latest} is ready to install`,
    summary: `OpenMasjidOS ${latest} is ready to install — you have ${current}.`,
    detail:
      'Updating takes a couple of minutes. Your apps and everything in them are left exactly as they are.',
    facts: [
      { label: 'You have', value: current },
      { label: 'Available', value: latest },
    ],
    action: {
      label: 'Open OpenMasjidOS',
      note: 'Then go to Settings, open Advanced, and press Update now.',
      path: '/settings',
    },
  };
}

/** A newer version of an installed catalog app is available. */
export function appUpdate(name: string, current: string, latest: string): AlertCopy {
  return {
    alertId: 'app-update',
    level: 'info',
    title: `${name} can be updated`,
    summary: current
      ? `${name} can be updated to version ${latest} — you have ${current}.`
      : `${name} can be updated to version ${latest}.`,
    detail: 'The app restarts while it updates. Its settings and everything in it are kept.',
    facts: [
      { label: 'App', value: name },
      ...(current ? [{ label: 'You have', value: current }] : []),
      { label: 'Available', value: latest },
    ],
    // The update control is on the app's card on the dashboard, not its detail page.
    action: {
      label: 'Open OpenMasjidOS',
      note: 'Then press Update on the app.',
      path: '/',
    },
  };
}

/**
 * Someone disputed a card payment (a chargeback).
 *
 * Deliberately avoids the word "chargeback" in the lead line — a volunteer treasurer
 * meets "disputed" in their bank's language far more often. The money and the
 * deadline come first because those are the two things that decide what they do next.
 *
 * There is NO action button on this one, unlike every other OS alert. The thing they
 * must do happens in Stripe, not in our dashboard, and the email's button builds a
 * URL relative to the OpenMasjidOS address — so a button here would send them
 * somewhere that cannot help. The instruction goes in words instead. (A deep link
 * into Stripe's own dashboard was considered and left out: every dashboard.stripe.com
 * path answers 303-to-login, including nonsense ones, so the URL shape could not be
 * verified — and a dead button in an alert about money is worse than a sentence.)
 */
export function stripeChargeback(opts: {
  accountLabel: string;
  amount: string | null;
  reason: string;
  dueBy: string | null;
  needsResponse: boolean;
  reference: string;
}): AlertCopy {
  const { accountLabel, amount, reason, dueBy, needsResponse, reference } = opts;
  const money = amount ? ` of ${amount}` : '';
  return {
    alertId: 'stripe-chargeback',
    level: 'error',
    // Version-free and short: this is both the H1 and the subject line.
    title: amount ? `A payment of ${amount} has been disputed` : 'A payment has been disputed',
    summary: needsResponse
      ? `A card payment${money} has been disputed and the bank needs a reply${dueBy ? ` by ${dueBy}` : ' soon'}.`
      : `A card payment${money} has been disputed by the cardholder.`,
    detail: needsResponse
      ? `${reason} The money has already been held back from your Stripe balance. To keep it you need to reply through Stripe with evidence before the deadline — if nobody replies, the dispute is lost automatically.`
      : `${reason} The money has been held back from your Stripe balance while the bank decides. Stripe will show you whether anything is needed from you.`,
    facts: [
      { label: 'Stripe account', value: accountLabel },
      ...(amount ? [{ label: 'Amount', value: amount }] : []),
      ...(dueBy ? [{ label: 'Reply by', value: dueBy }] : []),
      { label: 'Stripe reference', value: reference },
    ],
  };
}

/**
 * Several disputes appeared at once — one alert instead of a flooded inbox.
 *
 * Not hypothetical: a run of card-testing fraud can open many disputes in a single
 * batch, and sending one email each would bury the news it is trying to deliver.
 */
export function stripeChargebacksMany(opts: {
  count: number;
  accountLabel: string;
  total: string | null;
  soonest: string | null;
}): AlertCopy {
  const { count, accountLabel, total, soonest } = opts;
  const money = total ? ` totalling ${total}` : '';
  return {
    alertId: 'stripe-chargeback',
    level: 'error',
    title: `${count} card payments have been disputed`,
    summary: `${count} card payments${money} have been disputed on your ${accountLabel} account.`,
    detail:
      'Several disputes arrived together, which can happen when a stolen card is used repeatedly. The money for each has been held back from your Stripe balance. Open Stripe to see them all and reply to any that need evidence.',
    facts: [
      { label: 'Stripe account', value: accountLabel },
      { label: 'Disputes', value: String(count) },
      ...(total ? [{ label: 'Total held back', value: total }] : []),
      ...(soonest ? [{ label: 'Earliest reply date', value: soonest }] : []),
    ],
  };
}
