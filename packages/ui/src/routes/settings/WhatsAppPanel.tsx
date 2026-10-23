// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, RefreshCw, Check, ExternalLink, ScrollText } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Toggle } from '../../components/Toggle';
import { Modal } from '../../components/Modal';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PhoneField } from '../../components/PhoneField';
import { formatPhone } from '../../lib/phone';
import { AppLogs } from '../../components/AppLogs';
import { isRemoteSession, openApp } from '../../lib/apps';
import { useWindows } from '../../components/Windows';
import { useToast } from '../../components/ToastProvider';
import { cn } from '../../lib/cn';
import { CheckboxField } from '../../components/CheckboxField';
import { errorText } from '../../lib/errors';
import { StatusDot, Field } from './shared';
import { WhatsAppGroups } from './WhatsAppGroups';
import { WhatsAppCommands } from './WhatsAppCommands';

/** WhatsApp gateway (OpenWA). The admin installs OpenWA from the App Store, pastes the
 *  API key + session id it was configured with, links the phone with a pairing code, and
 *  every alert/app message then flows through the platform's paced queue. The API key is
 *  write-only here: the server returns an "is set" flag, never the value. */
export function WhatsAppPanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const windows = useWindows();
  const cfg = trpc.whatsapp.get.useQuery();
  const [pairing, setPairing] = useState<string | null>(null);
  // While a pairing code is on screen the admin is standing at their phone typing it
  // in, and the only thing they want to know is whether it worked. A one-minute poll
  // meant reloading the page to find out. Fast only during that window — every poll is
  // an HTTP call to the gateway.
  const status = trpc.whatsapp.status.useQuery(undefined, {
    refetchInterval: pairing ? 3_000 : 60_000,
  });

  const [provider, setProvider] = useState<'none' | 'openwa'>('none');
  const [baseUrl, setBaseUrl] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [linkPhone, setLinkPhone] = useState('');
  const [askEnable, setAskEnable] = useState(false);
  // Turning it OFF now asks a question rather than acting, because there are two
  // different "off"s and only the admin knows which they mean (see the dialog below).
  const [askDisable, setAskDisable] = useState(false);
  const [deleteAll, setDeleteAll] = useState(false);
  const [askUnlink, setAskUnlink] = useState(false);
  /**
   * Set whenever we did NOT get a positive confirmation that WhatsApp released the device.
   *
   * Note this is `!unlinked`, not `stillLinked`. There are two ways to fail — the gateway
   * answered 502 (it tried and could not confirm), and the gateway could not be reached at
   * all — and only the first sets `stillLinked`. Branching on `stillLinked` therefore
   * treated "we never even asked" as success, which is the worst of the three outcomes:
   * the container is about to be deleted, so after that nothing in this dashboard can ever
   * revoke the device sitting in the masjid's WhatsApp → Linked devices list.
   */
  const [unlinkWarning, setUnlinkWarning] = useState(false);
  // Setup / Groups / Commands. Local state rather than the URL: these are three views of
  // one connection, not three places — and the section itself is already addressable as
  // /settings/whatsapp, which is the link anything outside this panel actually wants.
  const [waTab, setWaTab] = useState<'setup' | 'groups' | 'commands'>('setup');
  // What is waiting in the queue — during an outage, the number the admin is watching.
  // Only while WhatsApp is on: off, nothing is held and there is no box to show it in.
  const held = trpc.whatsapp.held.useQuery(undefined, { refetchInterval: 60_000, enabled: provider !== 'none' });
  const [askDiscard, setAskDiscard] = useState(false);
  /** The gateway's own last words when a start attempt did not stick. */
  const [gatewayCrash, setGatewayCrash] = useState<string | null>(null);
  // A code nobody typed in is dead within a couple of minutes, and while one is on screen
  // the gateway is asked for news every three seconds — so it does not stay up for ever.
  useEffect(() => {
    if (!pairing) return;
    const timer = setTimeout(() => setPairing(null), 3 * 60_000);
    return () => clearTimeout(timer);
  }, [pairing]);
  // The pairing code stops being useful the instant the phone is linked, and leaving
  // it on screen is what made "did that work?" a page reload.
  useEffect(() => {
    if (pairing && status.data?.state === 'ready') {
      setPairing(null);
      // A fresh link supersedes any earlier "we could not confirm the unlink" notice —
      // whatever was or was not released before, this phone is the one attached now.
      setUnlinkWarning(false);
      toast(t('settings.whatsappLinkedNow'), 'success');
      void utils.whatsapp.get.invalidate();
    }
    // `toast`/`utils`/`t` are stable for the life of the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairing, status.data?.state]);

  // What the boxes were filled with, or null before they have been. Save sends only what
  // differs from it, so a change made on another device since is not put back.
  const seededWa = useRef<{ baseUrl: string; sessionName: string } | null>(null);
  const fillWa = (d: { provider: 'none' | 'openwa'; baseUrl: string; sessionName: string }) => {
    seededWa.current = { baseUrl: d.baseUrl, sessionName: d.sessionName };
    setProvider(d.provider);
    setBaseUrl(d.baseUrl);
    setSessionName(d.sessionName);
  };
  useEffect(() => {
    if (cfg.data && !seededWa.current) fillWa(cfg.data);
  }, [cfg.data]);

  const save = trpc.whatsapp.save.useMutation({
    onSuccess: (r) => {
      setApiKey('');
      // What is stored now — the switch included, so it is on only once turning it on
      // has actually been accepted.
      fillWa(r);
      utils.whatsapp.get.invalidate();
      utils.whatsapp.status.invalidate();
      // Turning the feature on or off changes whether the gateway app is listed at all,
      // so the store's cached catalog is now stale.
      utils.store.catalog.invalidate();
      toast(t('settings.whatsappSaved'), 'success');
    },
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });
  const link = trpc.whatsapp.link.useMutation({
    onSuccess: (r) => {
      setPairing(r.code ?? null);
      utils.whatsapp.get.invalidate();
      utils.whatsapp.status.invalidate();
    },
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });
  const test = trpc.whatsapp.test.useMutation({
    onSuccess: () => toast(t('settings.whatsappTestSent'), 'success'),
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });
  const disable = trpc.whatsapp.disable.useMutation({
    onSuccess: (r) => {
      setAskDisable(false);
      setDeleteAll(false);
      setProvider('none');
      if (r.deleted) {
        // The panel's inputs are seeded from the server ONCE and then owned locally, so
        // after a delete they still hold the old address and session name — and one press
        // of Save would write them straight back. Clearing them (and re-arming the seed)
        // is what makes the delete actually stick.
        seededWa.current = null;
        setApiKey('');
        setBaseUrl('');
        setSessionName('');
        setLinkPhone('');
        setPairing(null);
        setGatewayCrash(null);
        // Said plainly rather than as a success tick: unless WhatsApp positively confirmed
        // it released the device, the masjid has to go and remove it on the phone itself.
        //
        // Keyed on `!r.unlinked`, NOT on `r.stillLinked`. Only a 502 sets `stillLinked`;
        // an unreachable gateway — which is a common reason to be deleting in the first
        // place — sets neither, and used to fall through to the clean success message. The
        // container is gone by then, so that was the one outcome where the admin most
        // needed telling and was told the opposite.
        const confirmed = r.unlinked;
        toast(
          confirmed ? t('settings.whatsappDeleted') : t('settings.whatsappDeletedStillLinked'),
          confirmed ? 'success' : 'error',
        );
        // The toast is transient and this instruction is the only way back to a clean
        // phone, so it also stays on the panel until they link something again.
        setUnlinkWarning(!confirmed);
      } else {
        toast(t('settings.whatsappTurnedOff'), 'success');
      }
      utils.whatsapp.get.invalidate();
      utils.whatsapp.status.invalidate();
      // The trustee list and the gateway's App Store visibility both change on a delete.
      utils.commands.invalidate();
      utils.store.catalog.invalidate();
      utils.apps.invalidate();
    },
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });
  const unlink = trpc.whatsapp.unlink.useMutation({
    onSuccess: (r) => {
      setAskUnlink(false);
      // `!r.unlinked`, not `r.stillLinked` — see the state declaration. A 502 is not the
      // only way to end up still linked; not reaching the gateway at all is the other.
      const confirmed = r.unlinked;
      setUnlinkWarning(!confirmed);
      setLinkPhone('');
      // A failure gets the banner rather than a toast, because a toast is gone in seconds
      // and the instruction it carries is the only route back to a clean phone.
      if (confirmed) toast(t('settings.whatsappUnlinked'), 'success');
      utils.whatsapp.get.invalidate();
      utils.whatsapp.status.invalidate();
    },
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });
  const releaseHeld = trpc.whatsapp.releaseHeld.useMutation({
    onSuccess: (r) => {
      toast(t('settings.whatsappHeldReleased', { count: r.released }), 'success');
      utils.whatsapp.held.invalidate();
      utils.whatsapp.status.invalidate();
    },
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });
  const discardHeld = trpc.whatsapp.discardHeld.useMutation({
    onSuccess: (r) => {
      setAskDiscard(false);
      toast(t('settings.whatsappHeldDiscarded', { count: r.discarded }), 'success');
      utils.whatsapp.held.invalidate();
    },
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });
  const restartGateway = trpc.whatsapp.restartGateway.useMutation({
    onSuccess: (r) => {
      // Only clear the previous failure when this attempt actually held — otherwise
      // the panel would flash back to looking healthy while the container restarts.
      setGatewayCrash(r.ok ? null : (r.output ?? null));
      if (r.unchecked) toast(t('settings.whatsappGatewayUnchecked'), 'info');
      else if (r.ok) toast(t('settings.whatsappGatewayStarted'), 'success');
      utils.whatsapp.get.invalidate();
      utils.whatsapp.status.invalidate();
    },
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });

  if (!cfg.data) return null;
  const s = status.data;
  const gw = cfg.data.gateway;
  const hasApiKey = cfg.data.hasApiKey;
  const on = provider !== 'none';

  /** Which phone the gateway is actually attached to right now, if any. Deliberately
   *  `state === 'ready'` AND a number: `pending` and `problem` can also carry a phone (a
   *  linked-then-disconnected handset), and calling that "linked and sending" would be a
   *  lie on the one panel an admin checks when messages stop. */
  const linkedPhone = s?.state === 'ready' && s.phone ? s.phone : null;

  /**
   * Groups and Commands only exist once a phone is linked, so the tabs only appear then.
   *
   * Showing three tabs where two of them error is worse than showing none: it presents
   * setup steps as though they were optional, when linking is the thing that has to
   * happen first. Before that, this panel is just its setup, with no strip at all.
   */
  const waLinked = s?.state === 'ready';
  const showSetup = !waLinked || waTab === 'setup';

  /**
   * Turning it ON is gated on the ban-risk warning; turning it OFF now asks WHICH off.
   *
   * It used to switch off silently, which was fine as far as it went — but it left the
   * key, the session, the approved groups and the trustee phone list on disk with nothing
   * saying so. An admin who believed they had removed WhatsApp had not, and an admin who
   * only wanted a pause had no way to know their setup was safe. The dialog answers both.
   */
  function setEnabled(next: boolean) {
    if (next) return setAskEnable(true);
    setDeleteAll(false);
    setAskDisable(true);
  }

  return (
    <section className="glass-raised panel">
      <h2 className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
        <StatusDot online={status.isLoading ? undefined : Boolean(s?.connected)} /> {t('settings.whatsapp')}
      </h2>
      <p className="setting-row__hint" style={{ marginBlockEnd: '0.6rem' }}>{t('settings.whatsappHint')}</p>

      {/* One switch owns the whole feature. Off, the gateway app is not even listed in
          the App Store — nobody can install a WhatsApp client from OpenMasjidOS without
          first reading, here, what it risks. */}
      <Toggle checked={on} onChange={setEnabled} label={t('settings.whatsappEnable')} />

      {/* This dialog is the exception to "no confirmation on reversible switches"
          (ConfirmDialog's own rule): what it risks is not a platform setting but the
          masjid's phone number, and a banned number does not come back. */}
      <ConfirmDialog
        open={askEnable}
        onClose={() => setAskEnable(false)}
        // The switch follows the server (the save's own success sets it), so a refused
        // turn-on does not leave it showing ON. The dialog stays up, working, until then.
        onConfirm={() => save.mutate({ provider: 'openwa' }, { onSettled: () => setAskEnable(false) })}
        title={t('settings.whatsappRiskTitle')}
        body={t('settings.whatsappRiskBody')}
        cost={t('settings.whatsappRiskCost')}
        confirmLabel={t('settings.whatsappRiskAccept')}
        pending={save.isPending}
      />

      {/* Turning it off: a checkbox, not a second switch, because the two outcomes are a
          choice made ONCE at the moment of turning it off — not an ongoing setting.
          Modelled on the app-removal dialog, which asks the same question about data.
          Closing must clear the tick: leaving it on from a previous visit would put
          permanent destruction one click away in a dialog that looks freshly opened. */}
      <Modal
        open={askDisable}
        onClose={() => {
          setAskDisable(false);
          setDeleteAll(false);
        }}
        title={t('settings.whatsappOffTitle')}
      >
        <p style={{ margin: 0 }}>{t('settings.whatsappOffBody')}</p>
        <CheckboxField id="wa-delete-all" checked={deleteAll} onChange={setDeleteAll} align="start">
          <span>
            {t('settings.whatsappOffDelete')}
            <span className="hint" style={{ display: 'block' }}>
              {t('settings.whatsappOffDeleteHint')}
            </span>
          </span>
        </CheckboxField>
        {/* Only when it is actually about to happen. A permanent warning next to an
            unticked box is noise; next to a ticked one it is the last thing read. */}
        {deleteAll && (
          <p className="setting-row__hint" style={{ color: 'var(--color-gold, #F59E0B)' }}>
            {t('settings.whatsappOffDeleteCost')}
          </p>
        )}
        {disable.isPending ? (
          <p style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBlockStart: '1.2rem' }}>
            <span className="spinner" /> {t('common.working')}
          </p>
        ) : (
          <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginBlockStart: '1.4rem' }}>
            <button
              className="btn"
              onClick={() => {
                setAskDisable(false);
                setDeleteAll(false);
              }}
            >
              {t('common.cancel')}
            </button>
            <button
              className={cn('btn', deleteAll ? 'btn--danger' : undefined)}
              onClick={() => disable.mutate({ deleteEverything: deleteAll })}
            >
              {deleteAll ? t('settings.whatsappOffDeleteConfirm') : t('settings.whatsappOffConfirm')}
            </button>
          </div>
        )}
      </Modal>

      {/* Unlinking is its own action, separate from turning the feature off: changing
          handsets should not mean re-pasting a key and re-approving every group. */}
      <ConfirmDialog
        open={askUnlink}
        onClose={() => setAskUnlink(false)}
        onConfirm={() => unlink.mutate()}
        title={t('settings.whatsappUnlinkTitle')}
        body={t('settings.whatsappUnlinkBody')}
        cost={t('settings.whatsappUnlinkCost')}
        confirmLabel={t('settings.whatsappUnlinkConfirm')}
        pending={unlink.isPending}
      />

      {/* Setup / Groups / Commands. Reuses the `segmented` control the theme picker
          uses, so this reads as the same kind of choice rather than a new pattern. */}
      {/* The wrapper is load-bearing, not decoration. `.segmented` is `display:inline-flex`
          and `Toggle` renders a bare <button>, which is inline-block — both inline-level,
          so they shared a LINE and the strip sat jammed against the on/off switch. The
          `marginBlock` was applied (it does take effect on an inline-flex box) but moved
          the whole line rather than separating the two, which is why it looked ignored.
          Every other `.segmented` in this file already sits in a block container; this one
          was the exception. */}
      {on && waLinked && (
        <div style={{ marginBlock: '0.9rem' }}>
        <div className="segmented glass-inset" role="tablist">
          {/* Literal keys, for the same reason as the section nav above. */}
          {(
            [
              { id: 'setup', label: t('settings.whatsappTab.setup') },
              { id: 'groups', label: t('settings.whatsappTab.groups') },
              { id: 'commands', label: t('settings.whatsappTab.commands') },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={waTab === tab.id}
              className={cn(waTab === tab.id && 'is-active')}
              onClick={() => setWaTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        </div>
      )}

      {on && showSetup && (
        <>
          {/* Step one is the gateway app itself. It is hidden from the dashboard and the
              store on purpose, so this is the only place it can be installed or opened. */}
          <div
            className="glass-inset panel"
            style={{ marginBlock: '0.8rem', borderInlineStart: '3px solid var(--color-accent)' }}
          >
            <div className="setting-row__title">{t('settings.whatsappGatewayStep')}</div>
            {!gw.installed ? (
              <>
                <div className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>
                  {t('settings.whatsappGatewayInstallHint')}
                </div>
                <Link className="btn btn--primary" to={`/store?install=${gw.id}`}>
                  <Download size={15} /> {t('settings.whatsappGatewayInstall')}
                </Link>
              </>
            ) : (
              <>
                <div className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>
                  {/* Said plainly, because doing it the other way silently breaks the
                      platform's ownership of the session and its pacing. */}
                  {t('settings.whatsappGatewayOpenHint')}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {/* The gateway is hidden from the dashboard grid and the dock, which
                      also took away the only Start button in the product — so a masjid
                      whose gateway stopped had no way to start it again short of a root
                      terminal, exactly when they can least afford one. */}
                  <button
                    className="btn"
                    disabled={restartGateway.isPending}
                    onClick={() => restartGateway.mutate()}
                  >
                    <RefreshCw size={15} />{' '}
                    {restartGateway.isPending
                      ? t('settings.whatsappGatewayStarting')
                      : gw.running
                        ? t('settings.whatsappGatewayRestart')
                        : t('settings.whatsappGatewayStart')}
                  </button>
                  {/* Not from outside: the gateway is someone else's software and its own
                      screen does not work under a path, which is how the tunnel serves an
                      app — so the button would open a broken page. It says so instead. */}
                  <button
                    className="btn"
                    disabled={!gw.running || gw.openPort == null || isRemoteSession()}
                    title={isRemoteSession() ? t('settings.whatsappGatewayOpenRemote') : undefined}
                    onClick={() => {
                      if (!openApp(gw)) toast(t('errors.openApp'), 'error');
                    }}
                  >
                    <ExternalLink size={15} /> {t('settings.whatsappGatewayOpen')}
                  </button>
                  {/* Hiding the app took its logs away with it, and the gateway's own log
                      is the only place some failures are visible (an engine that won't
                      start says nothing over the API). So the button comes here. */}
                  <button
                    className="btn"
                    onClick={() =>
                      windows.open({
                        title: `${t('appDetail.logs')} — OpenWA`,
                        dedupeKey: `logs:${gw.id}`,
                        wide: true,
                        icon: <ScrollText size={15} />,
                        node: <AppLogs id={gw.id} />,
                      })
                    }
                  >
                    <ScrollText size={15} /> {t('settings.whatsappLogs')}
                  </button>
                </div>
                {!gw.running && !gatewayCrash && (
                  <span className="hint" style={{ marginInlineStart: '0.5rem' }}>
                    {t('settings.whatsappGatewayStopped')}
                  </span>
                )}
                {isRemoteSession() && gw.running && (
                  <div className="setting-row__hint" style={{ marginBlockStart: '0.4rem' }}>
                    {t('settings.whatsappGatewayOpenRemote')}
                  </div>
                )}
                {/* When it starts and dies, the reason is already in hand — putting it
                    on screen beats sending the admin to the logs button to find the one
                    line that matters. */}
                {gatewayCrash && (
                  <div style={{ marginBlockStart: '0.6rem' }}>
                    <div className="setting-row__hint" style={{ color: 'var(--color-danger)' }}>
                      {t('settings.whatsappGatewayCrashed')}
                    </div>
                    <pre
                      style={{
                        marginBlockStart: '0.4rem',
                        maxHeight: '11rem',
                        overflow: 'auto',
                        fontSize: '0.76rem',
                        lineHeight: 1.5,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        padding: '0.6rem 0.75rem',
                        borderRadius: '4px',
                        background: 'var(--color-surface-sunken, rgba(0,0,0,0.25))',
                      }}
                    >
                      {gatewayCrash}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {on && showSetup && (
        <>
          <Field label={t('settings.whatsappSession')} hint={t('settings.whatsappSessionHint')} style={{ maxWidth: '22rem' }}>
            {(id) => (
              <input
                id={id}
                className="input glass-inset"
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                placeholder="openmasjid"
              />
            )}
          </Field>
          <Field label={t('settings.whatsappKey')} hint={t('settings.whatsappKeyHint')} style={{ maxWidth: '22rem' }}>
            {(id) => (
              <input
                id={id}
                className="input glass-inset"
                type="password"
                autoComplete="off"
                placeholder={hasApiKey ? t('settings.emailSecretKept') : ''}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('settings.whatsappUrl')} hint={t('settings.whatsappUrlHint')} style={{ maxWidth: '22rem' }}>
            {(id) => (
              <input
                id={id}
                className="input glass-inset"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={t('settings.whatsappUrlAuto')}
              />
            )}
          </Field>
        </>
      )}

      {/* With the setup, not on every tab: a lone Save under Groups — or with WhatsApp
          off — re-sent the settings and said "saved" over nothing. */}
      {showSetup && (on || cfg.data.configured) && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBlockStart: '0.3rem' }}>
          {on && (
            <button
              className="btn"
              disabled={save.isPending}
              onClick={() => {
                // Only what was edited; `undefined` leaves a field as the server has it, so
                // an address changed on another device is not put back. The switch above
                // owns on/off, so that is never sent from here.
                const was = seededWa.current;
                save.mutate({
                  baseUrl: was && baseUrl.trim() === was.baseUrl ? undefined : baseUrl.trim(),
                  sessionName: was && sessionName.trim() === was.sessionName ? undefined : sessionName.trim() || undefined,
                  apiKey: apiKey.trim() || undefined,
                });
              }}
            >
              <Check size={15} /> {t('common.save')}
            </button>
          )}
          {cfg.data.configured && (
            <button className="btn" disabled={test.isPending} onClick={() => test.mutate({})}>
              {test.isPending ? t('settings.whatsappTesting') : t('settings.whatsappTest')}
            </button>
          )}
        </div>
      )}

      {/* Linking by pairing code, not QR: there is no screen on a headless box to
          photograph, and the admin may be nowhere near the machine.

          Hidden once a phone IS linked. It used to show regardless, so a masjid with a
          working connection was still looking at an empty "Link your phone" box and a
          "Get a code" button — which reads as "this didn't work", and invites linking a
          second handset over a working one. Only one number can be attached, so when
          there is one the panel states it instead of asking for it. */}
      {cfg.data.configured && !linkedPhone && showSetup && (
        <div style={{ marginBlockStart: '0.9rem' }}>
          <div className="setting-row__title">{t('settings.whatsappLink')}</div>
          <div className="setting-row__hint" style={{ marginBlockEnd: '0.4rem' }}>
            {t('settings.whatsappLinkHint')}
          </div>
          {/* The button rides INSIDE the field's input row, so it lines up with the
              number rather than with the bottom of the hint beneath it. */}
          <PhoneField
            value={linkPhone}
            onChange={setLinkPhone}
            hint={t('settings.whatsappLinkNumberHint')}
            trailing={
              <button
                className="btn"
                style={{ flex: '0 0 auto' }}
                disabled={link.isPending || linkPhone.length < 8}
                onClick={() => link.mutate({ phone: linkPhone })}
              >
                {link.isPending ? t('common.working') : t('settings.whatsappGetCode')}
              </button>
            }
          />
          {/* The code is typed into a phone held in the other hand, from a screen that
              may be across the room — so it is the biggest thing on the panel, spaced
              like a code rather than set as body text. */}
          {pairing && (
            <div
              className="glass-inset panel"
              style={{ marginBlockStart: '0.7rem', textAlign: 'center', padding: '1rem 1.2rem' }}
            >
              <div className="setting-row__hint" style={{ marginBlockEnd: '0.35rem' }}>
                {t('settings.whatsappCode')}
              </div>
              <code
                style={{
                  fontSize: '2.1rem',
                  fontWeight: 700,
                  letterSpacing: '0.35em',
                  // The trailing letter-space would otherwise push the code off-centre.
                  textIndent: '0.35em',
                  lineHeight: 1.25,
                  display: 'block',
                  userSelect: 'all',
                }}
              >
                {pairing}
              </code>
              <div className="setting-row__hint" style={{ marginBlockStart: '0.35rem' }}>
                {t('settings.whatsappCodeExpires')}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Which phone is actually linked — the answer to the question this whole panel
          exists to answer, so it is stated, not tucked into a hint line. On a masjid's
          spare handset "is that the right number?" is exactly the thing worth
          double-checking, and a run of bare digits is not something anyone checks. */}
      {linkedPhone && showSetup && (
        <div
          className="glass-inset panel"
          style={{ marginBlockStart: '0.9rem', borderInlineStart: '3px solid var(--color-accent)' }}
        >
          <div className="setting-row" style={{ gap: '0.9rem', flexWrap: 'wrap' }}>
            <div className="setting-row__text" style={{ flex: '1 1 14rem', minWidth: 0 }}>
              <div className="setting-row__hint">{t('settings.whatsappLinkedTo')}</div>
              <div
                style={{
                  fontSize: '1.45rem',
                  fontWeight: 650,
                  lineHeight: 1.3,
                  marginBlockStart: '0.15rem',
                  userSelect: 'all',
                }}
              >
                {formatPhone(linkedPhone)}
              </div>
            </div>
            <button className="btn" disabled={unlink.isPending} onClick={() => setAskUnlink(true)}>
              {unlink.isPending ? t('common.working') : t('settings.whatsappUnlink')}
            </button>
          </div>
        </div>
      )}

      {/* Held messages, and the honest account of what happened.

          Ungated on the tab, like the unlink warning below, because it must survive a
          switch to Groups or Commands — an admin dealing with an outage should not lose
          the count by clicking around. Shown whenever anything is held, not only during a
          declared incident, so a backlog is never invisible. */}
      {on && (held.data?.total ?? 0) > 0 && (
        <div
          className="glass-inset panel"
          style={{
            marginBlockStart: '0.9rem',
            borderInlineStart: `3px solid var(--color-${held.data?.health.down ? 'danger' : 'gold, #F59E0B'})`,
          }}
        >
          <div className="setting-row__title">
            {held.data?.health.down
              ? t('settings.whatsappHeldTitleDown')
              : t('settings.whatsappHeldTitle')}
          </div>
          <div className="setting-row__hint" style={{ marginBlockStart: '0.2rem' }}>
            {t('settings.whatsappHeldBody', { count: held.data?.total ?? 0 })}
          </div>

          {/* Per app, so an admin can see at a glance whose messages are waiting. Counts
              only — no recipient and no message text is sent to the browser. */}
          {(held.data?.bySource.length ?? 0) > 0 && (
            <div className="setting-row__hint" style={{ marginBlockStart: '0.5rem' }}>
              {held.data?.bySource.map((b) => (
                <div key={b.source}>
                  {b.source} — {b.count}
                </div>
              ))}
            </div>
          )}

          {/* The uncomfortable half. These went out into a dead link and were recorded as
              sent; OpenMasjidOS does not keep their contents, so it cannot resend them and
              must not imply it can. */}
          {(held.data?.suspect.length ?? 0) > 0 && (
            <p className="setting-row__hint" style={{ marginBlockStart: '0.6rem', color: 'var(--color-danger)' }}>
              {t('settings.whatsappHeldSuspect', {
                count: held.data?.suspect.reduce((n, x) => n + x.count, 0) ?? 0,
              })}
            </p>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBlockStart: '0.7rem' }}>
            <button
              className="btn btn--primary"
              disabled={releaseHeld.isPending || held.data?.health.down === true}
              onClick={() => releaseHeld.mutate()}
            >
              {releaseHeld.isPending ? t('common.working') : t('settings.whatsappHeldResend')}
            </button>
            <button className="btn" disabled={discardHeld.isPending} onClick={() => setAskDiscard(true)}>
              {t('settings.whatsappHeldDiscard')}
            </button>
          </div>
          {/* Resending into a link that is still down would just refill the queue, so the
              button waits for the connection rather than failing loudly. */}
          {held.data?.health.down && (
            <p className="setting-row__hint" style={{ marginBlockStart: '0.5rem' }}>
              {t('settings.whatsappHeldRelinkFirst')}
            </p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={askDiscard}
        onClose={() => setAskDiscard(false)}
        onConfirm={() => discardHeld.mutate()}
        title={t('settings.whatsappHeldDiscardTitle')}
        body={t('settings.whatsappHeldDiscardBody', { count: held.data?.total ?? 0 })}
        cost={t('settings.whatsappHeldDiscardCost')}
        confirmLabel={t('settings.whatsappHeldDiscard')}
        pending={discardHeld.isPending}
      />

      {/* An unconfirmed unlink, said where it can actually be read.

          This deliberately sits OUTSIDE the linked-number block above and is gated on
          nothing but `unlinkWarning`. It used to live inside that block, which is the one
          place it could not survive: unlinking clears `linkedPhone`, so the very action
          that raises this warning unmounted it a moment later. The admin got a closed
          dialog, no toast (the toast is suppressed precisely because this was meant to
          carry the message), and a paragraph that flashed for under a second — for the
          outcome where their phone may still be carrying a device they can no longer
          revoke from here.

          A 200 from the gateway is an acknowledgement, not a look at the handset, so this
          is also the honest wording for "we could not confirm", not just for a failure. */}
      {unlinkWarning && (
        <div
          className="glass-inset panel"
          style={{ marginBlockStart: '0.9rem', borderInlineStart: '3px solid var(--color-danger)' }}
        >
          <div className="setting-row" style={{ gap: '0.9rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div className="setting-row__text" style={{ flex: '1 1 16rem', minWidth: 0 }}>
              <div className="setting-row__title">{t('settings.whatsappUnlinkUnconfirmedTitle')}</div>
              <div className="setting-row__hint">{t('settings.whatsappUnlinkUnconfirmed')}</div>
            </div>
            {/* Dismissible, because it cannot clear itself: once the gateway is deleted
                there is no status to re-check, so nothing else would ever take it down. */}
            <button className="btn btn--sm" onClick={() => setUnlinkWarning(false)}>
              {t('settings.whatsappUnlinkUnconfirmedDone')}
            </button>
          </div>
        </div>
      )}

      {/* Groups. Only once a phone is actually linked — there is nothing to list before
          that, and offering the section would just produce an error. */}
      {waLinked && waTab === 'groups' && <WhatsAppGroups approved={cfg.data.groups} />}

      {/* Commands. Same gate as Groups: there is nothing to configure before a phone
          is linked, and offering it would only produce an error. */}
      {waLinked && waTab === 'commands' && <WhatsAppCommands />}

      {/* The risk we warned about, actually happening. WhatsApp told the gateway it has
          limited this number, so the admin hears it here rather than wondering why
          messages stopped. */}
      {s?.restriction && (
        <div
          className="glass-inset panel"
          style={{ marginBlockStart: '0.8rem', borderInlineStart: '3px solid var(--color-danger)' }}
        >
          <div className="setting-row__hint">
            {t('settings.whatsappStateRestricted', { detail: s.restriction })}
          </div>
        </div>
      )}

      {/* Live state plus the queue depth, which is the honest answer to "why has my
          message not arrived?" — it is paced, so it may still be waiting its turn. */}
      {s && (
        <p className="setting-row__hint" style={{ marginBlockStart: '0.8rem' }}>
          {/* One line per distinct state. "Gateway down", "nothing created yet" and
              "created but not linked" have different fixes, so they must read differently. */}
          {/* The queue depth is part of the "ready" sentence only. In every other state
              a backlog is counted in the held-messages box above, which shows whenever
              anything at all is waiting in the queue. */}
          {s.state === 'ready'
            ? t('settings.whatsappStateReady', { queued: s.queued })
            : s.state === 'pending'
              ? t('settings.whatsappStateNotLinked')
              : s.state === 'no-session'
                ? t('settings.whatsappStateNoSession')
                : s.state === 'problem'
                  ? t('settings.whatsappStateProblem', { detail: s.detail })
                  : s.state === 'bad-key'
                    ? t('settings.whatsappStateBadKey')
                    : s.state === 'unreachable'
                      ? // The reason is the whole message here: "OpenWA is not installed"
                        // and "nothing is listening at the gateway address" have different
                        // fixes, and a single generic line gave the admin nothing to act on.
                        t('settings.whatsappStateUnreachable', { detail: s.detail })
                      : t('settings.whatsappStateOff')}
        </p>
      )}
    </section>
  );
}
