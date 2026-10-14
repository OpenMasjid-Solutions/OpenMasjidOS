// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Where an authorised message becomes real work, and the only place that replies.
 *
 * The single seam the transport calls. Everything above it (normalise → gate) decides
 * whether a message may be considered; everything below (parse → registry → reply) is
 * pure. This file is the impure middle: it drives the per-sender state, runs the OS
 * verbs, calls apps, and sends at most two messages back.
 *
 * THE REPLY RULE, which several other safeguards depend on:
 *   `reply()` closes over the digits of whoever just messaged us. No command may take
 *   a phone number as an argument, and nothing here can address anyone else. That is
 *   what keeps this the lowest-risk traffic the number emits — a solicited answer to a
 *   known contact — rather than a spam gateway with an authorisation check bolted on.
 *   test/command-execute.test.ts pins it structurally.
 */
import crypto from 'node:crypto';
import { log } from '../logger';
import { maskDigits } from '../util/phone';
import { collectStats } from '../stats/collector';
import {
  AppNeedsReviewError,
  checkCatalogUpdate,
  listInstalled,
  restartApp,
  startApp,
  stopApp,
  updateCatalogApp,
  verifyStayedUp,
} from '../apps/manager';
import { isPlatformManaged } from '../apps/managed';
import { UpdateBusyError } from '../system/update-lock';
import { deliverAlert } from '../notify/alerts';
import { replyTo } from '../notify/whatsapp';
import { COMMAND_PREFIX, OS_CONTROL, OS_SCOPE_WORD, recordCommandUse } from '../store/commands';
import { grantedNamespaces, listNamespaces } from './registry';
import { parseCommand } from './parse';
import { runAppCommand } from '../fabric/appCommands';
import * as convo from './conversation';
import {
  appFailureText,
  appListText,
  confirmText,
  helpText,
  menuText,
  pickAppText,
  say,
  statsText,
  updatesText,
  cap,
  MAX_REPLY_CHARS,
  type AppRow,
  type UpdateRow,
} from './reply';
import type { GateOutcome } from './gate';
import type { InstalledApp } from '../apps/types';
import type { CommandEntry, CommandNamespace } from './types';

/** More than this from one message is a bug loop, not a conversation. */
const MAX_REPLIES = 2;

interface Ctx {
  digits: string;
  name: string;
  now: number;
  sent: number;
  /** What this sender may run, read once for this message. */
  namespaces: CommandNamespace[];
  /** This message, being a fresh command, ended an app's exchange with them. */
  endedSession: boolean;
  reply: (text: string) => Promise<void>;
}

/** Build the bound reply function. It can only ever address `digits`. */
function makeCtx(digits: string, name: string, now: number, namespaces: CommandNamespace[] = []): Ctx {
  // Structural guard: even a bug that passed the wrong digits cannot message someone
  // who did not just message us. Decided as the message arrives, so the answer to a
  // long update is not refused for the time the update took.
  const repliable = convo.recentlyInbound(digits, now);
  const ctx: Ctx = {
    digits,
    name,
    now,
    sent: 0,
    namespaces,
    endedSession: false,
    reply: async (text: string) => {
      if (ctx.sent >= MAX_REPLIES) {
        log.warn('WhatsApp commands: refusing a third reply to one message.');
        return;
      }
      if (!repliable) {
        log.warn('WhatsApp commands: refusing to message a number that did not just message us.');
        return;
      }
      ctx.sent += 1;
      const out = await replyTo(digits, cap(text));
      if (!out.ok) {
        // A reply is prompt or it is nothing. Never re-queue it: a `!os stats` answer
        // arriving forty minutes later is confusing, not helpful.
        log.warn(`WhatsApp commands: could not reply to ${maskDigits(digits)} (${out.error ?? 'unknown'}).`);
      }
    },
  };
  return ctx;
}

/** The transport's handler. Never throws. */
export async function handleInboundCommand(outcome: GateOutcome): Promise<void> {
  if (!outcome.pass) {
    if (outcome.drop === 'rate-limited' && outcome.notice && outcome.digits) {
      const ctx = makeCtx(outcome.digits, '', Date.now());
      await ctx.reply(say.throttled());
    }
    return;
  }

  const { person, msg, digits } = outcome;
  const now = Date.now();
  // Every app's commands are read once per message, here, then narrowed to this sender.
  const all = listNamespaces();
  const ctx = makeCtx(digits, person.label, now, grantedNamespaces(person, all));
  recordCommandUse(digits, now);

  // A message with no prefix only reached the gate because we are waiting on an
  // answer. Deal with that before parsing: it is a reply, not a command.
  const body = msg.body.trim();
  if (!body.startsWith(COMMAND_PREFIX)) {
    try {
      await handleBareReply(body, ctx);
    } catch (err) {
      log.error(`WhatsApp commands: a reply from ${maskDigits(digits)} failed — ${(err as Error).message}`);
      await ctx.reply('Something went wrong at my end. Nothing was changed.');
    }
    return;
  }
  // Starting a fresh command abandons whatever was being asked.
  if (convo.getSession(digits, now)) {
    convo.clearSession(digits);
    ctx.endedSession = true;
  }

  const result = parseCommand(msg.body, {
    now,
    namespaces: ctx.namespaces,
    all,
    menu: convo.getMenu(digits),
  });
  // A held confirmation answers its own prompt only. Any other command abandons it, so
  // a reflexive "ok" later cannot run it.
  if (result.kind !== 'confirm' && result.kind !== 'cancel') convo.clearPending(digits);

  try {
    await dispatch(result, ctx);
  } catch (err) {
    // The MESSAGE only. Passing the error object as `extra` would print whatever it
    // closed over, which is how a body leaks into a log that ends up in a backup.
    log.error(`WhatsApp commands: "${result.kind}" from ${maskDigits(digits)} failed — ${(err as Error).message}`);
    await ctx.reply('Something went wrong at my end. Nothing was changed.');
  }
}

/** Words that end an exchange. Bare, because typing `!exit` mid-conversation is the
 *  friction this whole feature exists to remove. */
const EXIT_WORDS = new Set(['exit', 'quit', 'done', 'cancel', 'stop', 'nevermind', 'never mind']);
/** Plain answers to a held confirmation — wider than the prefixed `!yes`/`!no` the
 *  parser knows, because these only count while the platform is asking. */
const BARE_YES_WORDS = new Set(['yes', 'y', 'yeah', 'yep', 'ok', 'okay']);
const BARE_NO_WORDS = new Set(['no', 'n', 'nope']);

/**
 * A message with no prefix, which the gate only let through because we are waiting on
 * an answer. Two things can be waiting: an app mid-question, or a confirmation.
 */
async function handleBareReply(body: string, ctx: Ctx): Promise<void> {
  const word = body.toLowerCase().replace(/[.!?]+$/, '');

  if (EXIT_WORDS.has(word)) {
    const hadPending = convo.hasPending(ctx.digits, ctx.now);
    const hadSession = convo.getSession(ctx.digits, ctx.now) !== null;
    convo.clearSession(ctx.digits);
    convo.clearPending(ctx.digits);
    // "stop" said to "Stop Donations?" must read as "left alone", never as "done".
    if (hadPending) return ctx.reply(say.cancelled());
    return ctx.reply(hadSession ? say.sessionEnded() : say.nothingToCancel());
  }

  // A held confirmation takes precedence: it is the more consequential thing waiting,
  // and inside an exchange the platform has just asked THIS question, so a plain yes
  // is unambiguous — which was the only reason the code existed.
  if (convo.hasPending(ctx.digits, ctx.now)) {
    if (BARE_YES_WORDS.has(word)) {
      const taken = convo.takeConfirmed(ctx.digits, ctx.now);
      if (!taken.ok) return ctx.reply(say.expiredConfirm());
      return runConfirmed(taken.action, ctx);
    }
    if (BARE_NO_WORDS.has(word)) {
      convo.clearPending(ctx.digits);
      return ctx.reply(say.cancelled());
    }
    return ctx.reply(say.answerYesOrNo());
  }

  const session = convo.getSession(ctx.digits, ctx.now);
  if (!session) return; // expired between the gate and here; silence is right

  // Re-authorise on EVERY turn. A grant removed mid-conversation must take effect
  // immediately, not when the session happens to expire.
  const ns = ctx.namespaces.find((n) => n.word === session.word);
  const command = ns?.commands.find((c) => c.id === session.commandId);
  if (!ns || !command) {
    convo.clearSession(ctx.digits);
    return ctx.reply(say.sessionLost(session.appLabel));
  }
  return runAppVerb(ns.word, ns.label, command, body, ctx, session.token);
}

async function dispatch(r: ReturnType<typeof parseCommand>, ctx: Ctx): Promise<void> {
  switch (r.kind) {
    case 'ignore':
      return;

    case 'help':
      log.info(`WhatsApp commands: "help" from ${maskDigits(ctx.digits)}.`);
      return ctx.reply(helpText(ctx.name || 'there', ctx.namespaces));

    case 'menu': {
      convo.setMenu(ctx.digits, r.ns.word, r.ns.commands.map((c) => c.id), ctx.now);
      log.info(`WhatsApp commands: "menu" from ${maskDigits(ctx.digits)} (${r.ns.word}).`);
      return ctx.reply(menuText(r.ns));
    }

    case 'not-allowed':
      log.warn(`WhatsApp commands: ${maskDigits(ctx.digits)} asked for !${r.word}, which they do not have.`);
      return ctx.reply(say.notAllowed(r.word));

    case 'unknown-namespace':
      // `!exit` mid-exchange: no such namespace, but the exchange did just end.
      if (ctx.endedSession && EXIT_WORDS.has(r.word)) return ctx.reply(say.sessionEnded());
      return ctx.reply(say.unknownNamespace(r.word, r.suggestion));

    case 'unknown-command':
      return ctx.reply(say.unknownCommand(r.ns, r.word, r.suggestion));

    case 'bad-number':
      return ctx.reply(say.badNumber(r.ns, r.max));

    case 'missing-argument':
      return ctx.reply(say.missingArgument(r.ns, r.command));

    case 'unwanted-argument':
      return ctx.reply(say.unwantedArgument(r.ns, r.command));

    case 'cancel': {
      if (convo.hasPending(ctx.digits, ctx.now)) {
        convo.clearPending(ctx.digits);
        return ctx.reply(say.cancelled());
      }
      return ctx.reply(ctx.endedSession ? say.sessionEnded() : say.nothingToCancel());
    }

    case 'confirm': {
      const taken = convo.takePending(ctx.digits, r.code, ctx.now);
      if (!taken.ok) {
        if (taken.why === 'expired') return ctx.reply(say.expiredConfirm());
        if (taken.why === 'none') return ctx.reply(say.nothingToCancel());
        // No code at all is not a wrong one: the prompt is still waiting for an answer.
        if (!r.code) return ctx.reply(say.needCode());
        return ctx.reply('That code does not match what I asked. Send the command again.');
      }
      return runConfirmed(taken.action, ctx);
    }

    case 'need-app': {
      const apps = await appRows();
      convo.setAppList(ctx.digits, apps.map((a) => a.id), ctx.now);
      return ctx.reply(pickAppText(r.command, apps));
    }

    case 'run':
      return runResolved(r.ns, r.command, r.text, ctx);
  }
}

// ── running things ───────────────────────────────────────────────────────────────

async function runResolved(
  ns: CommandNamespace,
  command: CommandEntry,
  text: string | undefined,
  ctx: Ctx,
): Promise<void> {
  // The OS namespace is handled here, never sent over the Fabric — there is no app
  // called "os" and (RESERVED_ID_WORDS) there never can be.
  if (ns.word === OS_SCOPE_WORD) {
    if (command.argKind === 'none') {
      const canControl = ns.commands.some((c) => c.scope === OS_CONTROL);
      switch (command.id) {
        case 'stats':
          return ctx.reply(await osStats());
        case 'apps':
          return ctx.reply(await osApps(ctx, canControl));
        case 'updates':
          return ctx.reply(await osUpdates(ctx, canControl));
        default:
          return ctx.reply('I know that command but not how to run it. Have a look on the dashboard.');
      }
    }

    const target = await resolveApp(text ?? '', ctx);
    if (!target) return; // resolveApp already replied
    if (isPlatformManaged(target.id)) {
      // Updating, stopping or restarting the gateway would sever the connection
      // carrying this very conversation — the admin would see "starting…" and then
      // nothing, forever. Same class of problem as updating the OS itself.
      return ctx.reply(say.managedApp(target.name));
    }
    if (command.confirm) {
      const code = convo.setPending(
        ctx.digits,
        { kind: 'os', command, appId: target.id, appName: target.name },
        ctx.now,
      );
      log.info(`WhatsApp commands: "${command.id}" from ${maskDigits(ctx.digits)} — asked to confirm.`);
      return ctx.reply(confirmText(...osConfirmWords(command.id, target.name), code));
    }
    return runOsVerb(command, target, ctx);
  }

  if (command.confirm) {
    const code = convo.setPending(ctx.digits, { kind: 'app', word: ns.word, appLabel: ns.label, command, text }, ctx.now);
    log.info(`WhatsApp commands: "${command.id}" from ${maskDigits(ctx.digits)} — asked to confirm.`);
    return ctx.reply(confirmText(`${command.label} — ${ns.label}?`, 'This changes what people see.', code));
  }
  return runAppVerb(ns.word, ns.label, command, text, ctx);
}

async function runConfirmed(action: convo.PendingAction, ctx: Ctx): Promise<void> {
  // Re-authorise now, as every app turn does: a grant removed since the prompt must not
  // still run, and a restore replaces the list without firing the change hook.
  const word = action.kind === 'os' ? OS_SCOPE_WORD : action.word;
  const granted = ctx.namespaces.find((n) => n.word === word)?.commands.some((c) => c.id === action.command.id);
  if (!granted) {
    log.warn(`WhatsApp commands: ${maskDigits(ctx.digits)} confirmed !${word} ${action.command.id}, which they no longer have.`);
    return ctx.reply(say.notAllowed(`${word} ${action.command.id}`));
  }
  if (action.kind === 'os') {
    return runOsVerb(action.command, { id: action.appId, name: action.appName }, ctx);
  }
  return runAppVerb(action.word, action.appLabel, action.command, action.text, ctx);
}

function osConfirmWords(id: string, appName: string): [string, string] {
  switch (id) {
    case 'stop':
      return [`Stop "${appName}"?`, 'It stays off until someone starts it again.'];
    case 'restart':
      return [`Restart "${appName}"?`, 'It will be unavailable for a moment.'];
    case 'update':
      return [`Update "${appName}"?`, 'It restarts while the new version is applied, and this cannot be undone from here.'];
    default:
      return [`Run "${id}" on "${appName}"?`, ''];
  }
}

/*
 * There is deliberately NO sending-allowance check on a mutating command; don't
 * reintroduce one. One used to refuse commands once an hourly or daily cap was spent,
 * but a reply goes out through `replyTo`, which never applied those caps, so it
 * protected nothing and only locked admins out of the commands they were testing. What
 * bounds commands is the INBOUND rate limit in commands/gate.ts.
 */

async function runOsVerb(command: CommandEntry, target: { id: string; name: string }, ctx: Ctx): Promise<void> {
  // "Is there anything to do?" is a read, answered before any work starts.
  if (command.id === 'update') {
    try {
      const check = await checkCatalogUpdate(target.id);
      // No store version to compare against — not from the store, gone from it, or the
      // store can't be reached. Couldn't ask is not "up to date".
      if (check.latest === null) {
        return ctx.reply(
          `I couldn't check ${target.name} for an update from here, so nothing was changed. Have a look on the dashboard.`,
        );
      }
      if (!check.updateAvailable) return ctx.reply(`${target.name} is already up to date.`);
    } catch {
      // Couldn't ask: the update checks again for itself and changes nothing when it shouldn't.
    }
  }

  const started = Date.now();
  try {
    switch (command.id) {
      case 'start':
        await startApp(target.id);
        break;
      case 'stop':
        await stopApp(target.id);
        break;
      case 'restart':
        await restartApp(target.id);
        break;
      case 'update': {
        await ctx.reply(`Updating ${target.name} now. I'll message you when it's finished.`);
        // The progress lines have nowhere to go in a chat; only the real outcome is
        // reported. updateCatalogApp has already checked that the new version stayed up.
        const outcome = await updateCatalogApp(target.id, () => undefined);
        if (outcome === 'unchanged') {
          log.warn(`WhatsApp commands: "${command.id}" on ${target.id} — nothing was changed.`);
          audit(command, target.name, ctx);
          return ctx.reply(`${target.name} wasn't updated, so nothing was changed. Have a look on the dashboard to see why.`);
        }
        if (outcome === 'not-running') {
          log.warn(`WhatsApp commands: "${command.id}" on ${target.id} — updated, but it did not stay running.`);
          audit(command, target.name, ctx);
          return ctx.reply(
            `${target.name} was updated, but it isn't staying running. Have a look at its logs on the dashboard.`,
          );
        }
        break;
      }
      default:
        return ctx.reply(say.unknownCommand({ word: 'os', label: 'OpenMasjidOS', commands: [] }, command.id));
    }
  } catch (err) {
    if (err instanceof UpdateBusyError) {
      // Information, not a failure. Calling a refusal a failure is what pushes an
      // admin into retrying the very thing that is already running.
      log.warn(`WhatsApp commands: "${command.id}" from ${maskDigits(ctx.digits)} — refused (already running).`);
      return ctx.reply(say.busy(err.message));
    }
    if (err instanceof AppNeedsReviewError) {
      // Deliberately NOT offerable over WhatsApp. Consenting to a compose that
      // asked for powerful permissions is a decision someone has to read first,
      // and the core runs as root with the Docker socket — so possession of a
      // phone must not be enough to make it. Say what is wrong and where to go.
      log.warn(`WhatsApp commands: "${command.id}" on ${target.id} — held for review.`);
      return ctx.reply(
        `I can't start ${target.name} yet. It asks for powerful permissions, so someone ` +
          'needs to look at it and agree on the dashboard first.',
      );
    }
    log.warn(`WhatsApp commands: "${command.id}" on ${target.id} failed — ${(err as Error).message}`);
    return ctx.reply(`I couldn't ${command.id} ${target.name}. Have a look on the dashboard.`);
  }

  // Don't claim it worked until it has stayed up. `compose up` exits 0 the moment a
  // container starts, so a crash-loop would otherwise get "Prayer Times is running
  // again" — and the admin, who cannot see the dashboard, would believe it. An update
  // was already checked inside updateCatalogApp.
  if (command.id !== 'stop' && command.id !== 'update') {
    const stayed = await verifyStayedUp(target.id);
    if (stayed.result === 'down') {
      log.warn(`WhatsApp commands: "${command.id}" on ${target.id} did not stay running.`);
      audit(command, target.name, ctx);
      return ctx.reply(
        `${target.name} started and then stopped again. Something is wrong with it — ` +
          'have a look at its logs on the dashboard.',
      );
    }
    // Docker could not be asked: it was started, and whether it stayed up is not known.
    if (stayed.result === 'unknown') {
      log.warn(`WhatsApp commands: "${command.id}" on ${target.id} — could not check it stayed running.`);
      audit(command, target.name, ctx);
      return ctx.reply(`${target.name} was started, but I couldn't check that it stayed running. Have a look on the dashboard.`);
    }
  }

  log.info(
    `WhatsApp commands: "${command.id}" from ${maskDigits(ctx.digits)} — done (${target.id}, ${Date.now() - started}ms).`,
  );
  audit(command, target.name, ctx);
  return ctx.reply(doneWords(command.id, target.name));
}

function doneWords(id: string, name: string): string {
  switch (id) {
    case 'start':
      return `${name} is running again.`;
    case 'stop':
      return `${name} is stopped.`;
    case 'restart':
      return `${name} is running again.`;
    case 'update':
      return `${name} is updated and running.`;
    default:
      return 'Done.';
  }
}

/**
 * An out-of-band record of every mutating command.
 *
 * With exactly one admin there is no second pair of eyes and no approval flow, so the
 * compensating control is that "the Donations app was stopped from WhatsApp at 02:14"
 * also reaches the admin's email or webhook. A stolen phone does not have the inbox.
 */
function audit(command: CommandEntry, appName: string, ctx: Ctx): void {
  // Only things that CHANGED something. For OS verbs that is the control scope; for an
  // app command it is `confirm: true`, which is the app author's own signal that this
  // one matters. Read-only commands would just be noise.
  const mutating = command.scope === OS_CONTROL || command.confirm === true;
  if (!mutating) return;
  void deliverAlert({
    source: 'os',
    alertId: 'command-run',
    title: `"${command.label}" was run from WhatsApp`,
    text: `${ctx.name || 'Someone on your list'} (${maskDigits(ctx.digits)}) ran "${command.label}" on ${appName}.`,
  }).catch(() => undefined);
}

async function runAppVerb(
  word: string,
  nsLabel: string,
  command: CommandEntry,
  text: string | undefined,
  ctx: Ctx,
  followUpToken?: string,
): Promise<void> {
  const out = await runAppCommand({
    appId: word,
    commandId: command.id,
    text,
    requestId: crypto.randomUUID(),
    followUpToken,
  });
  if (out.ok) {
    if (out.followUpToken) {
      // The app is asking for more. Hold the exchange open so their next message
      // needs no prefix — and only theirs, only for this app.
      convo.openSession(
        ctx.digits,
        { word, appLabel: nsLabel, commandId: command.id, token: out.followUpToken },
        ctx.now,
      );
      // At the turn or time cap the exchange closes at once, so no answer could ever
      // reach the app. Say so rather than leave the question hanging.
      if (!convo.getSession(ctx.digits, ctx.now)) {
        log.info(`WhatsApp commands: "${command.id}" from ${maskDigits(ctx.digits)} — exchange too long (${word}).`);
        const note = say.finishOnDashboard();
        return ctx.reply(`${cap(out.text, MAX_REPLY_CHARS - note.length - 2)}\n\n${note}`);
      }
      log.info(`WhatsApp commands: "${command.id}" from ${maskDigits(ctx.digits)} — awaiting a reply (${word}).`);
      return ctx.reply(out.text);
    }
    convo.clearSession(ctx.digits);
    log.info(`WhatsApp commands: "${command.id}" from ${maskDigits(ctx.digits)} — done (${word}).`);
    audit(command, nsLabel, ctx);
    return ctx.reply(out.text);
  }
  // A failure ends the exchange: continuing to capture bare replies for something
  // that is not listening any more is how ordinary chat gets read as input.
  convo.clearSession(ctx.digits);
  log.warn(`WhatsApp commands: "${command.id}" from ${maskDigits(ctx.digits)} — ${out.code} (${word}).`);
  // When the app explained itself, its own words beat anything we could substitute.
  return ctx.reply(out.code === 'app_error' && out.text ? out.text : appFailureText(nsLabel, out.code, word));
}

// ── app resolution ───────────────────────────────────────────────────────────────

/** The apps a sender sees and numbers. The platform-managed gateway is left out. */
function visibleRows(installed: InstalledApp[]): AppRow[] {
  return installed.filter((a) => !a.managed).map((a) => ({ id: a.id, name: a.name, running: a.running }));
}

async function appRows(): Promise<AppRow[]> {
  return visibleRows(await listInstalled());
}

/** Resolve an OS verb's app argument: an id, or a number from the app list we showed. */
async function resolveApp(token: string, ctx: Ctx): Promise<{ id: string; name: string } | null> {
  const installed = await listInstalled();
  const apps = visibleRows(installed);
  if (/^\d{1,3}$/.test(token)) {
    const n = Number.parseInt(token, 10);
    const snapshot = convo.getAppList(ctx.digits, ctx.now);
    const ids = snapshot ? snapshot.ids : apps.map((a) => a.id);
    const id = ids[n - 1];
    const found = id ? apps.find((a) => a.id === id) : undefined;
    if (!found) {
      await ctx.reply(say.unknownApp(token));
      return null;
    }
    return { id: found.id, name: found.name };
  }
  // A name or id is matched against EVERY installed app, the managed gateway included,
  // so naming it gets the managed-app refusal rather than "I can't find it".
  const lower = token.toLowerCase();
  const found = installed.find((a) => a.id === lower) ?? installed.find((a) => a.name.toLowerCase() === lower);
  if (!found) {
    await ctx.reply(say.unknownApp(token));
    return null;
  }
  return { id: found.id, name: found.name };
}

// ── read-only OS verbs ───────────────────────────────────────────────────────────

async function osStats(): Promise<string> {
  return statsText(await collectStats());
}

async function osApps(ctx: Ctx, canControl: boolean): Promise<string> {
  const apps = await appRows();
  convo.setAppList(ctx.digits, apps.map((a) => a.id), ctx.now);
  return appListText(apps, canControl);
}

async function osUpdates(ctx: Ctx, canControl: boolean): Promise<string> {
  const installed = await listInstalled();
  const rows: UpdateRow[] = [];
  let unchecked = 0;
  for (const a of installed) {
    if (a.managed || a.kind !== 'catalog') continue;
    try {
      const u = await checkCatalogUpdate(a.id);
      // No store version was read, so this app is unknown, never "up to date".
      if (u.latest === null) unchecked += 1;
      else if (u.updateAvailable && u.reason) {
        rows.push({ id: a.id, name: a.name, from: u.current, to: u.latest, reason: u.reason, channel: u.channel });
      }
    } catch {
      unchecked += 1; // one app that cannot be checked must not hide the rest
    }
  }
  // These rows are numbered, so "!os update 1" must mean the first one shown HERE.
  if (rows.length > 0) convo.setAppList(ctx.digits, rows.map((r) => r.id), ctx.now);
  return updatesText(rows, { unchecked, canControl });
}
