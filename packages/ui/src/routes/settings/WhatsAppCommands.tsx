// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../../lib/trpc';
import { Toggle } from '../../components/Toggle';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PhoneField } from '../../components/PhoneField';
import { formatPhone } from '../../lib/phone';
import { useToast } from '../../components/ToastProvider';
import { errorText } from '../../lib/errors';
import { StatusDot } from './shared';

/**
 * Admin commands over WhatsApp.
 *
 * The matrix is TRANSPOSED relative to the alerts one: rows are scopes, columns are
 * people. The person axis is the small stable one (a masjid trusts a handful of
 * numbers); the scope axis grows with every app installed. Rows = people × columns =
 * a dozen apps is unusable at panel width.
 *
 * Each row lists the commands it grants, because "allow Yusuf !notice-board" is not
 * legible on its own — and an app can add a command in an update, so the admin should
 * be able to see what a grant currently covers.
 */
export function WhatsAppCommands() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const cfg = trpc.commands.get.useQuery();
  const status = trpc.commands.status.useQuery(undefined, { refetchInterval: 30_000 });

  const [askEnable, setAskEnable] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<{ phone: string; label: string } | null>(null);
  const [newPhone, setNewPhone] = useState('');
  const [newName, setNewName] = useState('');

  const refresh = () => {
    void utils.commands.get.invalidate();
    void utils.commands.status.invalidate();
  };
  const onError = (e: unknown) => toast(errorText(e, t('errors.generic')), 'error');

  const setEnabled = trpc.commands.setEnabled.useMutation({ onSuccess: refresh, onError });
  const addPerson = trpc.commands.addPerson.useMutation({
    onSuccess: () => {
      setNewPhone('');
      setNewName('');
      refresh();
    },
    onError,
  });
  // A whole number, not just the country code the phone field starts with (as linking asks).
  const canAdd = !addPerson.isPending && newPhone.length >= 8 && newName.trim() !== '';
  const removePerson = trpc.commands.removePerson.useMutation({
    onSuccess: () => {
      setConfirmRemove(null);
      refresh();
    },
    onError,
  });
  const setScope = trpc.commands.setScope.useMutation({ onSuccess: refresh, onError });

  // The probe's verdict, in words. The raw counts are the evidence; the sentence is
  // what tells an admin whose problem it is.
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const probe = trpc.commands.probe.useMutation({
    onSuccess: (r) => {
      const g = r.gateway;
      // A dead page reads as "no activity" unless it is reported separately — and
      // that is exactly the failure being looked for.
      if (g.chatsError) {
        setProbeResult(t('settings.commandsProbeFailed', { reason: g.chatsError }));
        return;
      }
      if (!g.ok) {
        setProbeResult(t('settings.commandsProbeFailed', { reason: g.error ?? '' }));
        return;
      }
      const heard = g.incoming;
      const when = g.newestIncomingAt ? new Date(g.newestIncomingAt).toLocaleString() : '';
      const chatAt = g.newestChatActivityAt ? Date.parse(g.newestChatActivityAt) : 0;
      const msgAt = g.newestIncomingAt ? Date.parse(g.newestIncomingAt) : 0;
      // THE signature of an alive-but-deaf engine: WhatsApp shows a conversation more
      // recent than anything the gateway managed to record. It can see the chat and
      // cannot hear the message.
      const deaf = g.chatsOk && chatAt > 0 && chatAt > msgAt + 60_000;

      if (deaf) {
        setProbeResult(
          t('settings.commandsProbeBridgeDead', { when: new Date(chatAt).toLocaleString() }),
        );
      } else if (heard === 0) {
        setProbeResult(t('settings.commandsProbeDeaf'));
      } else if (r.inbound.counters.seen === 0 && Object.keys(r.inbound.dropped).length === 0) {
        setProbeResult(t('settings.commandsProbeNotPassedOn', { count: heard, when }));
      } else {
        setProbeResult(t('settings.commandsProbeReaching', { count: heard, when }));
      }
    },
    onError,
  });

  if (!cfg.data) return null;
  const { enabled, people, grants, adminPhone, adminName } = cfg.data;
  const s = status.data;

  // Group the rows the way the alerts matrix does, so OpenMasjidOS's two halves sit
  // under one heading.
  const groups = new Map<string, typeof grants>();
  for (const g of grants) groups.set(g.group, [...(groups.get(g.group) ?? []), g]);

  const colHead = {
    width: '5rem',
    textAlign: 'center' as const,
    color: 'var(--color-ink-muted)',
    fontSize: '0.8rem',
    paddingInlineStart: '0.4rem',
  };
  const cell = { width: '5rem', display: 'flex', justifyContent: 'center', paddingInlineStart: '0.4rem' };

  const alreadyListed = people.some((p) => p.phone === adminPhone);

  return (
    <div style={{ marginBlockStart: '1rem' }}>
      <div className="setting-row__title" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        {t('settings.commands')}
        {enabled && (
          <StatusDot
            online={s?.state === 'connected'}
            label={s?.state === 'silent' ? t('settings.commandsDotSilent') : undefined}
          />
        )}
      </div>
      <div className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.commandsHint')}</div>

      <div className="setting-row">
        <div className="setting-row__text" style={{ flex: 1 }}>
          <div className="setting-row__title">{t('settings.commandsEnable')}</div>
          <div className="setting-row__hint">{t('settings.commandsEnableHint')}</div>
        </div>
        <Toggle
          checked={enabled}
          onChange={(v) => (v ? setAskEnable(true) : setEnabled.mutate({ enabled: false }))}
          label={t('settings.commandsEnable')}
        />
      </div>

      {enabled && (
        <>
          {/* People. Kept visible even with the switch off would be pointless here —
              but turning it off never DELETES the list, which would be surprising loss. */}
          <div className="setting-row__title" style={{ marginBlockStart: '0.8rem' }}>
            {t('settings.commandsPeople')}
          </div>
          <div className="setting-row__hint">{t('settings.commandsPeopleHint')}</div>

          {people.length > 0 && (
            <div className="glass-inset panel" style={{ marginBlock: '0.6rem', padding: '0.6rem 0.9rem' }}>
              {people.map((p) => (
                <div className="setting-row" key={p.phone}>
                  <div className="setting-row__text" style={{ flex: 1, minWidth: 0 }}>
                    <div className="setting-row__title">{p.label}</div>
                    <div className="setting-row__hint">
                      {formatPhone(p.phone)}
                      {p.scopes.length === 0 && ` · ${t('settings.commandsNoGrants')}`}
                    </div>
                  </div>
                  <button
                    className="btn btn--sm"
                    disabled={removePerson.isPending}
                    onClick={() => setConfirmRemove({ phone: p.phone, label: p.label })}
                  >
                    {t('actions.remove')}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Aligned at the TOP, not the bottom. PhoneField carries its own hint under
              the inputs, so bottom-aligning made every sibling hang two lines lower
              than the number field it sits beside. Both blocks are label + control row,
              so their labels and their inputs line up on their own. The Add button
              lives INSIDE the name field's control row for the same reason — as a
              third flex child it had no label above it and nothing to align to. */}
          <div style={{ display: 'flex', gap: '0.9rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <PhoneField
              id="cmd-phone"
              label={t('settings.commandsPhone')}
              value={newPhone}
              onChange={setNewPhone}
              disabled={addPerson.isPending}
            />
            <div className="field" style={{ flex: '1 1 16rem', minInlineSize: '13rem' }}>
              <label className="label" htmlFor="cmd-name">{t('settings.commandsName')}</label>
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                <input
                  id="cmd-name"
                  className="input glass-inset"
                  style={{ flex: '1 1 auto', minInlineSize: '8rem' }}
                  value={newName}
                  maxLength={60}
                  placeholder={t('settings.commandsNamePlaceholder')}
                  disabled={addPerson.isPending}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canAdd) {
                      addPerson.mutate({ phone: newPhone, label: newName });
                    }
                  }}
                />
                <button
                  className="btn btn--primary"
                  style={{ flex: '0 0 auto' }}
                  disabled={!canAdd}
                  onClick={() => addPerson.mutate({ phone: newPhone, label: newName })}
                >
                  {t('settings.commandsAdd')}
                </button>
              </div>
            </div>
          </div>
          {/* Offered, never automatic: the admin's number was collected as a place to
              send alerts, not as a way to authorise changes. No scopes are ticked.
              On its own line so it cannot disturb the alignment above. */}
          {adminPhone && !alreadyListed && (
            <button
              className="btn btn--sm"
              style={{ marginBlockStart: '0.4rem' }}
              onClick={() => addPerson.mutate({ phone: adminPhone, label: adminName || t('settings.commandsMe') })}
            >
              {t('settings.commandsAddMe')}
            </button>
          )}

          {people.length > 0 && (
            <>
              <div className="setting-row__title" style={{ marginBlockStart: '1rem' }}>
                {t('settings.commandsWhoCan')}
              </div>
              {/* Physical on purpose: `overflow-inline` is barely supported, and a
                  horizontal scroller flips correctly in RTL on its own. */}
              <div style={{ overflowX: 'auto' }}>
                {[...groups.entries()].map(([group, rows]) => (
                  <div key={group} style={{ marginBlockStart: '0.7rem' }}>
                    <div style={{ display: 'flex', alignItems: 'end', marginBlockEnd: '0.15rem' }}>
                      <div className="setting-row__title" style={{ flex: 1, color: 'var(--color-ink-muted)' }}>
                        {group}
                      </div>
                      {people.map((p) => (
                        <div key={p.phone} style={colHead}>{p.label}</div>
                      ))}
                    </div>
                    {rows.map((r) => (
                      <div className="setting-row" key={r.key}>
                        <div className="setting-row__text" style={{ flex: 1, minWidth: 0 }}>
                          <div className="setting-row__title">{r.label || `!${r.word}`}</div>
                          <div className="setting-row__hint">
                            {r.available
                              ? r.commands.map((c) => c.label).join(' · ')
                              : t('settings.commandsAppNone')}
                          </div>
                        </div>
                        {people.map((p) =>
                          r.available ? (
                            <div key={p.phone} style={cell}>
                              <Toggle
                                checked={p.scopes.includes(r.key)}
                                onChange={(v) => setScope.mutate({ phone: p.phone, scope: r.key, allowed: v })}
                                label={`${p.label} — ${r.group} ${r.label}`}
                              />
                            </div>
                          ) : (
                            // A third state, not a dead switch: there is nothing to grant.
                            <div key={p.phone} style={{ ...cell, alignItems: 'center' }}>
                              <span className="hint">—</span>
                            </div>
                          ),
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}

          {s && (
            <>
              <p className="setting-row__hint" style={{ marginBlockStart: '0.8rem' }}>
                {s.state === 'connected'
                  ? t('settings.commandsStateConnected')
                  : s.state === 'silent'
                    ? s.detail
                    : s.state === 'no-senders'
                      ? t('settings.commandsStateNoSenders')
                      : s.state === 'not-linked'
                        ? t('settings.commandsStateNotLinked')
                        : s.state === 'off'
                          ? t('settings.commandsStateOff')
                          : t('settings.commandsStateProblem', { detail: s.detail })}
              </p>
              {/* ALWAYS shown, not just when the platform thinks something is wrong.
                  The case that matters most is precisely the one where it thinks all is
                  well — connected, subscribed, acked — and no message ever arrives. On
                  the first real install this box was hidden behind a 'silent' state
                  that the ack fix had just stopped it from reaching, so the admin was
                  left staring at "Listening for commands." with no way to look further.

                  It is the difference between "it doesn't work" and a fact somebody can
                  act on: an empty list means the gateway has said nothing at all to us,
                  a non-empty one names exactly what it did say. Event names only —
                  never a payload, never a body. */}
              <div className="glass-inset panel" style={{ marginBlockStart: '0.5rem', padding: '0.6rem 0.9rem' }}>
                <div className="setting-row__hint">
                  {t('settings.commandsDiagHeard')}{' '}
                  {s.eventNames.length === 0 ? (
                    <strong>{t('settings.commandsDiagNothing')}</strong>
                  ) : (
                    <code style={{ userSelect: 'all' }}>{s.eventNames.join(', ')}</code>
                  )}
                </div>
                <div className="setting-row__hint">
                  {t('settings.commandsDiagCounts', {
                    seen: s.counters.seen,
                    ignored: s.counters.ignoredUnknown,
                    unreadable: s.counters.unparseable,
                  })}
                </div>
                {/* The reason a message that DID arrive was thrown away. Without
                    this, "it arrived and we discarded it" and "nothing arrived" look
                    identical from here — which is exactly the ambiguity that cost a
                    round trip. Reason words and counts; no content. */}
                {Object.keys(s.dropped).length > 0 && (
                  <div className="setting-row__hint">
                    {t('settings.commandsDiagDropped')}{' '}
                    <code style={{ userSelect: 'all' }}>
                      {Object.entries(s.dropped)
                        .sort((a, b) => b[1] - a[1])
                        .map(([reason, n]) => `${reason} ×${n}`)
                        .join(', ')}
                    </code>
                  </div>
                )}
                <div className="setting-row__hint">
                  {t('settings.commandsDiagAck', {
                    ack: s.subscribeAck + (s.subscribeAckCode ? ` (${s.subscribeAckCode})` : ''),
                  })}
                </div>
                {/* Raw transport activity vs application events. Traffic with no
                    events means the gateway is not emitting to us; no traffic at all
                    means the socket is not really carrying anything despite saying
                    connected. Opposite fixes, identical symptoms without this. */}
                <div className="setting-row__hint">
                  {t('settings.commandsDiagWire', {
                    packet: s.lastPacketAt ? new Date(s.lastPacketAt).toLocaleTimeString() : '—',
                    event: s.lastEventAt ? new Date(s.lastEventAt).toLocaleTimeString() : '—',
                  })}
                </div>
                {/* The one question that splits the problem in half: has the GATEWAY
                    itself heard anything from WhatsApp? If not, nothing on our side
                    matters. Read-only, and it reads counts and times — never a body. */}
                <div style={{ marginBlockStart: '0.6rem' }}>
                  <button className="btn btn--sm" disabled={probe.isPending} onClick={() => probe.mutate()}>
                    {probe.isPending ? t('common.working') : t('settings.commandsProbe')}
                  </button>
                  {probeResult && (
                    <div className="setting-row__hint" style={{ marginBlockStart: '0.4rem' }}>
                      {probeResult}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </>
      )}

      <ConfirmDialog
        open={askEnable}
        onClose={() => setAskEnable(false)}
        onConfirm={() => {
          setAskEnable(false);
          setEnabled.mutate({ enabled: true });
        }}
        title={t('settings.commandsRiskTitle')}
        body={t('settings.commandsRiskBody')}
        cost={t('settings.commandsRiskCost')}
        confirmLabel={t('settings.commandsRiskAccept')}
        pending={setEnabled.isPending}
      />
      <ConfirmDialog
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        onConfirm={() => confirmRemove && removePerson.mutate({ phone: confirmRemove.phone })}
        title={t('settings.commandsRemoveTitle', { name: confirmRemove?.label ?? '' })}
        body={t('settings.commandsRemoveBody')}
        confirmLabel={t('actions.remove')}
        pending={removePerson.isPending}
      />
    </div>
  );
}
