// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Phone numbers and WhatsApp addresses, in one place.
 *
 * These used to live in `notify/whatsapp.ts`. They moved here so a STORE can
 * canonicalise a number without importing the sender — `store/commands.ts` keys its
 * whitelist on `toDigits` output, and `notify/whatsapp.ts` already imports
 * `store/whatsapp.ts`, so the other direction would be a cycle waiting to happen.
 * `notify/whatsapp.ts` re-exports `toDigits`/`chatIdFor` so existing callers are
 * unaffected.
 */

/**
 * Reduce a human-typed number to the digits WhatsApp wants.
 *
 * Deliberately strict about what it will NOT do: it never guesses a country code. A
 * number stored as "555 0123" could be in any country, and quietly prefixing the
 * platform's guess would send a masjid's fee reminder to a stranger. No country code
 * (fewer than 8 digits) is a refusal, not a repair.
 */
export function toDigits(raw: string): string | null {
  const digits = String(raw ?? '').replace(/[^0-9]/g, '');
  if (digits.length < 8 || digits.length > 15) return null; // E.164 allows max 15
  return digits;
}

/** OpenWA addresses individuals as `<digits>@c.us`. */
export function chatIdFor(digits: string): string {
  return `${digits}@c.us`;
}

/**
 * A one-to-one chat id, positively identified.
 *
 * Deliberately an allow-list, not `!== '@g.us'`. WhatsApp has more address spaces than
 * "person" and "group": `@lid` (a privacy identifier, increasingly the default for
 * group participants), `@newsletter` (Channels), `@broadcast` and `status@broadcast`.
 * A negative test admits all of them, and every one of them would then be treated as a
 * person whose "number" is not a number.
 *
 * The `:NN` device suffix is stripped first — the same account on a second linked
 * device shows up as `447700900123:12@c.us`.
 */
const DIRECT_JID_RE = /^[0-9]{8,15}@c\.us$/;

export function isDirectJid(jid: unknown): jid is string {
  return typeof jid === 'string' && DIRECT_JID_RE.test(stripDevice(jid));
}

/**
 * A chat that addresses ONE PERSON — `@c.us` or `@lid` — as an allow-list.
 *
 * Separate from `isDirectJid` because a `@lid` chat is a person but carries no phone
 * number, so it can be a legitimate 1:1 chat while being useless as an identity. The
 * caller still has to obtain the number some other way (the gateway's resolved
 * `senderPhone`, or `contacts/:id/phone`).
 *
 * This exists because `commands/normalise.ts` trusted the gateway's `isGroup: false`
 * on its own once the `@lid` support landed, and "not a group" is not the same claim as
 * "a person": `@newsletter` (Channels), `@broadcast` and `status@broadcast` are all
 * not-groups, and each would then have been treated as a direct chat whose author
 * became a whitelist-checkable identity. Same negative-test mistake this file's own
 * header warns about, reintroduced one level up.
 */
const PERSONAL_JID_DOMAINS = new Set(['c.us', 'lid']);

export function isPersonalChatJid(jid: unknown): jid is string {
  if (typeof jid !== 'string') return false;
  const at = jid.lastIndexOf('@');
  if (at < 0) return false;
  return PERSONAL_JID_DOMAINS.has(jid.slice(at + 1).toLowerCase());
}

function stripDevice(jid: string): string {
  const at = jid.indexOf('@');
  if (at < 0) return jid;
  const user = jid.slice(0, at);
  const colon = user.indexOf(':');
  return (colon < 0 ? user : user.slice(0, colon)) + jid.slice(at);
}

/**
 * The phone number behind a chat/participant JID, or null.
 *
 * Returns null for anything that is not a real `@c.us` number — notably `@lid`, which
 * CANNOT be mapped back to a phone. Best-effort matching a LID against the command
 * whitelist would be inventing an identity, so it is a refusal.
 */
export function jidDigits(jid: unknown): string | null {
  if (typeof jid !== 'string') return null;
  const stripped = stripDevice(jid);
  if (!DIRECT_JID_RE.test(stripped)) return null;
  return toDigits(stripped.slice(0, stripped.indexOf('@')));
}

/**
 * A phone number as it may appear in a log: `44…23`.
 *
 * Never the whole number. Container logs are readable from the dashboard's log window
 * and ride along in backups, and a masjid's list of trustees is personal data. Enough
 * to tell two senders apart, not enough to dial.
 */
export function maskDigits(digits: string): string {
  return digits.length <= 4 ? '••' : `${digits.slice(0, 2)}…${digits.slice(-2)}`;
}
