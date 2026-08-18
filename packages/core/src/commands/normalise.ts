// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Read an inbound message off whatever shape the gateway emits.
 *
 * OpenWA's real-time event payload is not in its public API docs, and the gateways in
 * this space (whatsapp-web.js, Baileys, and wrappers over both) disagree about nearly
 * every field name — `body` vs `text` vs `message.conversation`, `chatId` vs `from` vs
 * `key.remoteJid`, seconds vs milliseconds. So this reads defensively across the
 * plausible spellings rather than betting on one.
 *
 * THE FAIL-CLOSED DEFAULTS ARE THE ENTIRE SAFETY VALUE OF THIS FILE:
 *
 *   fromMe   unknown => TRUE   (drop). Some engines omit it for messages typed on the
 *                              linked phone. Absent-means-false would let our own
 *                              replies loop back in as commands.
 *   isDirect unknown => FALSE  (drop). Requires a POSITIVE `<digits>@c.us` match; a
 *                              negative "not @g.us" test admits @lid, @newsletter,
 *                              @broadcast and status@broadcast. And if the payload
 *                              carries a separate author, it must be the same person
 *                              as the chat — a differing author is a group shape,
 *                              whatever the chat id looks like.
 *   hasMedia any hint => TRUE  (drop). Note the asymmetry: a plain text message
 *                              legitimately carries no media field at all, so
 *                              "no hint" cannot mean media or nothing would ever get
 *                              through. The strictness lives with `type` in the gate,
 *                              which allows only known TEXT types through.
 *
 * A partially parseable message is dropped, never guessed at.
 */
import { jidDigits, isDirectJid, isPersonalChatJid, toDigits } from '../util/phone';

export interface InboundMessage {
  /** '' when the gateway sent none — the gate then derives a dedupe key. */
  id: string;
  chatId: string;
  /** The individual sender. In a group this is `author`, not `chatId`. */
  authorId: string | null;
  /** The sender's phone digits, or null when the JID is not a phone (e.g. @lid). */
  fromDigits: string | null;
  fromMe: boolean;
  isDirect: boolean;
  timestampMs: number | null;
  /** NEVER logged. */
  body: string;
  type: string | null;
  hasMedia: boolean;
  /**
   * The address space the chat used — `c.us`, `lid`, `g.us`, … Diagnostics only, and
   * safe to surface: it is the domain half of the JID, never the number.
   *
   * Earns its place because "we rejected this" and "we could not tell who sent it"
   * were the same drop reason on a real install, and the difference is the whole fix.
   */
  shape: string;
  /**
   * The sender's JID when we could not get a phone number out of it — i.e. a `@lid`
   * privacy id. Set only when `isDirect` is true and `fromDigits` is null, so it reads
   * as "this is a real one-to-one chat whose sender we cannot yet name". The gateway
   * can resolve it over REST; see `resolveLidPhone`.
   */
  senderJid: string | null;
}

export type NormaliseResult =
  | { ok: true; msg: InboundMessage }
  | {
      ok: false;
      reason: 'not-an-object' | 'no-chat' | 'no-body' | 'unknown-shape';
      /** Top-level KEY NAMES only, for the log. Key names are schema, not content. */
      keys: string[];
    };

type Bag = Record<string, unknown>;

const isBag = (v: unknown): v is Bag => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Follow a dotted path, tolerating anything missing along the way. */
function at(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split('.')) {
    if (!isBag(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function firstString(root: unknown, paths: string[]): string | null {
  for (const p of paths) {
    const v = at(root, p);
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function firstBool(root: unknown, paths: string[]): boolean | null {
  for (const p of paths) {
    const v = at(root, p);
    if (typeof v === 'boolean') return v;
  }
  return null;
}

/** Unwrap the envelope. Gateways variously send the message itself, `{data}`,
 *  `{message}`, `{payload}`, or a single-element array. */
function unwrap(args: unknown[]): unknown {
  let cur: unknown = args.length === 1 ? args[0] : args.find((a) => isBag(a));
  if (Array.isArray(cur) && cur.length === 1) cur = cur[0];
  if (!isBag(cur)) return cur;
  for (const key of ['data', 'message', 'msg', 'payload']) {
    const inner = cur[key];
    // Only descend when the inner object looks more like a message than the outer —
    // Baileys nests the CONTENT under `message`, which must not be mistaken for the
    // envelope.
    if (isBag(inner) && ('body' in inner || 'chatId' in inner || 'from' in inner || 'key' in inner)) {
      return inner;
    }
  }
  const evData = at(cur, 'event.data');
  if (isBag(evData)) return evData;
  return cur;
}

export function normaliseInbound(args: unknown[]): NormaliseResult {
  const root = unwrap(args);
  if (!isBag(root)) return { ok: false, reason: 'not-an-object', keys: [] };
  const keys = Object.keys(root).sort().slice(0, 12);

  const chatId = firstString(root, ['chatId', 'from', 'chat.id._serialized', 'chat.id', 'key.remoteJid']);
  if (!chatId) return { ok: false, reason: 'no-chat', keys };

  const body =
    firstString(root, [
      'body',
      'text',
      'text.body',
      'content',
      'caption',
      'message.conversation',
      'message.extendedTextMessage.text',
    ]) ?? '';

  const id = firstString(root, ['id._serialized', 'id', 'messageId', 'key.id', '_data.id._serialized']) ?? '';
  const authorId = firstString(root, ['author', 'participant', 'key.participant', 'sender.id', 'sender']);
  const type = firstString(root, ['type', 'messageType', 'kind']);

  // fromMe: unknown means ours, so a reply can never loop back in as a command.
  const fromMe = firstBool(root, ['fromMe', 'key.fromMe', 'isFromMe', 'self']) ?? true;

  // Prefer the gateway's OWN answer when it gives one. `isGroup` is engine-neutral and
  // authoritative; inferring it from the JID was guesswork that got this wrong on the
  // first real install, because WhatsApp is migrating chats to `@lid` privacy ids and
  // a LID chat is not a group but does not look like `@c.us` either.
  const isGroupFlag = firstBool(root, ['isGroup']);
  const isStatusBroadcast = firstBool(root, ['isStatusBroadcast']) === true;
  const isDirect = isStatusBroadcast
    ? false
    : isGroupFlag !== null
      ? // The flag settles GROUP-ness, but "not a group" is not "a person": @newsletter
        // (Channels), @broadcast and status@broadcast are all not-groups too, and
        // trusting the flag alone let one of those become a direct chat whose author
        // was then matched against the whitelist. Still require the chat to be a
        // personal address space — which allows @lid, so the privacy-id fix that made
        // this branch necessary keeps working.
        !isGroupFlag && isPersonalChatJid(chatId)
      : // No flag: fall back to positive proof, and keep the old belt-and-braces that
        // any author present names the same person as the chat. A gateway that put the
        // group in `author` and the sender in `chatId` would otherwise look direct.
        isDirectJid(chatId) && (!authorId || jidDigits(authorId) === jidDigits(chatId));

  // Who sent it, in order of authority. A `@lid` sender has NO phone number in its
  // JID — that is the point of a privacy id — so the gateway's resolved number is the
  // only way to identify them, and the contact cache is the last resort.
  const fromDigits = isDirect
    ? (toDigits(firstString(root, ['senderPhone']) ?? '') ??
      jidDigits(authorId) ??
      jidDigits(chatId) ??
      jidDigits(firstString(root, ['from'])) ??
      toDigits(firstString(root, ['contact.number']) ?? ''))
    : null;

  // Any hint of media counts as media. Absence does NOT: a plain text message carries
  // no media field, so treating "no hint" as media would drop every real command.
  const hasMedia =
    firstBool(root, ['hasMedia', 'isMedia']) ??
    (at(root, 'mimetype') != null ||
      at(root, 'mediaKey') != null ||
      at(root, 'media') != null ||
      at(root, 'message.imageMessage') != null);

  const timestampMs = readTimestamp(root);

  if (!body && !hasMedia) return { ok: false, reason: 'no-body', keys };

  // The domain half only. Safe to surface, and the one fact that tells an admin
  // whether the address space is the problem.
  // NOT `at` — that is the path-reader helper above, and shadowing it here broke every
  // field lookup in this function.
  const domainAt = chatId.lastIndexOf('@');
  const shape = domainAt >= 0 ? chatId.slice(domainAt + 1).toLowerCase().slice(0, 20) : 'no-domain';

  // Only worth resolving when the chat is genuinely one-to-one and the sender has no
  // number in their address. `author` first: in any shape where both exist, that is
  // the person rather than the conversation.
  const senderJid = isDirect && !fromDigits ? (authorId ?? firstString(root, ['from']) ?? chatId) : null;

  return {
    ok: true,
    msg: {
      id,
      chatId,
      authorId,
      fromDigits,
      fromMe,
      isDirect,
      timestampMs,
      body,
      type,
      hasMedia,
      shape,
      senderJid,
    },
  };
}

function readTimestamp(root: unknown): number | null {
  for (const p of ['timestamp', 't', 'messageTimestamp', '_data.t']) {
    const v = at(root, p);
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      // Seconds or milliseconds — anything below ~2001 in ms is really seconds.
      return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
    }
  }
  for (const p of ['createdAt', 'timestamp']) {
    const v = at(root, p);
    if (typeof v === 'string') {
      const parsed = Date.parse(v);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}
