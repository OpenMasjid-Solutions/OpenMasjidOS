// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Two-step sign-in — Settings → Account.
 *
 * WHAT THIS SCREEN HAS TO GET RIGHT, in the order it matters:
 *
 *  1. The backup codes are shown ONCE. They are stored hashed, so this dialog is
 *     the only moment they exist in readable form anywhere. Its step is `locked`
 *     — no Escape, no click-away, no close button — until the admin ticks that
 *     they have them. A dialog an admin can dismiss by reflex is, here, a
 *     lockout waiting for the day they change phone.
 *  2. Nothing is armed until a code proves it. An admin who scans the QR and
 *     walks away has changed nothing about signing in.
 *  3. Every change re-proves the admin — password, plus the current code once a
 *     factor is active. The server enforces that (`routers/twofactor.ts` says
 *     why at length); this screen asks for it in the same breath as the action
 *     rather than as a surprise error afterwards.
 *
 * On the QR: the grid is encoded on the SERVER and arrives as data, so nothing
 * here parses a URI or draws HTML from a string. The manual key is always shown
 * beside it — a camera is not always an option, and a code nobody can type in
 * is a dead end on a desktop with no webcam.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Download, KeyRound, ShieldCheck, ShieldOff, Smartphone } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { useToast } from './ToastProvider';
import { Modal } from './Modal';
import { CheckboxField } from './CheckboxField';
import { QrCode, type QrGrid } from './QrCode';
import { Switch } from './ui/switch';

/** What `begin` handed back: enough to enrol, and nothing that outlives the dialog. */
interface Enrolment {
  secret: string;
  uri: string;
  account: string;
  qr: QrGrid;
}

/** The secret, grouped in fours so it can be read aloud or typed without losing place. */
const groupKey = (s: string): string => (s.match(/.{1,4}/g) ?? [s]).join(' ');

export function TwoFactorPanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const status = trpc.auth.twoFactor.status.useQuery();
  const refresh = () => utils.auth.twoFactor.status.invalidate();
  const s = status.data;

  /** Which dialog is open. One at a time, so the sudo fields are never ambiguous. */
  const [flow, setFlow] = useState<'enrol' | 'disable' | 'regen' | 'email' | null>(null);
  /** Codes waiting to be written down. Set by enrolment OR by regenerating. */
  const [codes, setCodes] = useState<string[] | null>(null);
  /**
   * Whether the set on screen REPLACED an earlier one — which the dialog has to
   * say, because it silently does. Confirming a new authenticator app reissues
   * the backup codes, so an admin swapping phones would otherwise keep a card in
   * their wallet that stopped working the moment they scanned the new QR.
   * Captured when the flow opens, not read at display time: by then the status
   * query has refetched and says "yes, TOTP is on" either way.
   */
  const [replacing, setReplacing] = useState(false);

  // The three destructive mutations live HERE, above any conditional return, and
  // are handed to `SudoDialog` as a plain function. A hook inside the dialog
  // would be created and torn down as it opens and closes — and a mutation
  // unmounted mid-flight is one whose result nobody is listening for.
  const disable = trpc.auth.twoFactor.disable.useMutation();
  const regen = trpc.auth.twoFactor.regenerateBackupCodes.useMutation();
  const setEmailFactor = trpc.auth.twoFactor.setEmailFactor.useMutation();

  const close = () => setFlow(null);

  if (!s) return null;

  return (
    <section className="glass-raised panel">
      <h2 className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
        <ShieldCheck size={18} /> {t('settings.twoFactor.title')}
      </h2>
      <p className="setting-row__hint" style={{ marginBlockEnd: '0.75rem' }}>
        {t('settings.twoFactor.intro')}
      </p>

      {!s.totp ? (
        <>
          <p className="setting-row__hint" style={{ marginBlockEnd: '0.9rem' }}>
            {t('settings.twoFactor.notSetUp')}
          </p>
          <button className="btn btn--primary" onClick={() => { setReplacing(false); setFlow('enrol'); }}>
            <Smartphone size={15} /> {t('settings.twoFactor.setUp')}
          </button>
        </>
      ) : (
        <>
          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__title">{t('settings.twoFactor.appTitle')}</div>
              <div className="setting-row__hint">{t('settings.twoFactor.appOn')}</div>
            </div>
            <button className="btn" onClick={() => { setReplacing(true); setFlow('enrol'); }}>
              {t('settings.twoFactor.replace')}
            </button>
          </div>

          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__title">{t('settings.twoFactor.backupTitle')}</div>
              <div className="setting-row__hint">
                {t('settings.twoFactor.backupLeft', {
                  count: s.backupCodesRemaining,
                  total: s.backupCodeCount,
                })}
              </div>
            </div>
            <button className="btn" onClick={() => { setReplacing(true); setFlow('regen'); }}>
              {t('settings.twoFactor.newCodes')}
            </button>
          </div>

          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__title">{t('settings.twoFactor.emailTitle')}</div>
              <div className="setting-row__hint">
                {s.emailPossible ? t('settings.twoFactor.emailHint') : t('settings.twoFactor.emailUnavailable')}
              </div>
            </div>
            <Switch
              checked={s.email}
              disabled={!s.emailPossible && !s.email}
              onCheckedChange={() => setFlow('email')}
              aria-label={t('settings.twoFactor.emailTitle')}
            />
          </div>

          <button className="btn btn--danger" style={{ marginBlockStart: '1rem' }} onClick={() => setFlow('disable')}>
            <ShieldOff size={15} /> {t('settings.twoFactor.turnOff')}
          </button>
        </>
      )}

      {/* ── dialogs ────────────────────────────────────────────────────── */}

      <EnrolDialog
        open={flow === 'enrol'}
        active={s.active}
        onClose={close}
        onEnrolled={(c) => {
          setFlow(null);
          setCodes(c);
          refresh();
        }}
      />

      <SudoDialog
        open={flow === 'disable'}
        active={s.active}
        danger
        title={t('settings.twoFactor.turnOffTitle')}
        body={t('settings.twoFactor.turnOffBody')}
        confirmLabel={t('common.turnOff')}
        onClose={close}
        run={(vars) => disable.mutateAsync(vars)}
        onDone={() => {
          close();
          refresh();
          toast(t('settings.twoFactor.turnedOff'), 'success');
        }}
      />

      <SudoDialog
        open={flow === 'regen'}
        active={s.active}
        title={t('settings.twoFactor.newCodesTitle')}
        body={t('settings.twoFactor.newCodesBody')}
        confirmLabel={t('settings.twoFactor.newCodes')}
        onClose={close}
        run={(vars) => regen.mutateAsync(vars)}
        onDone={(res) => {
          close();
          setCodes((res as { backupCodes: string[] }).backupCodes);
          refresh();
        }}
      />

      <SudoDialog
        open={flow === 'email'}
        active={s.active}
        title={s.email ? t('settings.twoFactor.emailOffTitle') : t('settings.twoFactor.emailOnTitle')}
        body={s.email ? t('settings.twoFactor.emailOffBody') : t('settings.twoFactor.emailOnBody')}
        confirmLabel={s.email ? t('common.turnOff') : t('common.turnOn')}
        onClose={close}
        run={(vars) => setEmailFactor.mutateAsync({ ...vars, enabled: !s.email })}
        onDone={() => {
          close();
          refresh();
        }}
      />

      <BackupCodesDialog codes={codes} replacing={replacing} onDone={() => setCodes(null)} />
    </section>
  );
}

interface SudoVars {
  password: string;
  code?: string;
}

/* ── enrolment ─────────────────────────────────────────────────────────── */

function EnrolDialog({
  open,
  active,
  onClose,
  onEnrolled,
}: {
  open: boolean;
  active: boolean;
  onClose: () => void;
  onEnrolled: (codes: string[]) => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [sudoCode, setSudoCode] = useState('');
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const begin = trpc.auth.twoFactor.begin.useMutation();
  const confirm = trpc.auth.twoFactor.confirm.useMutation();

  function reset() {
    setPassword('');
    setSudoCode('');
    setEnrolment(null);
    setCode('');
    setError('');
  }

  async function doBegin() {
    setError('');
    try {
      setEnrolment(await begin.mutateAsync({ password, code: sudoCode || undefined }));
      // The password is not needed again in this flow, so it stops being held.
      setPassword('');
      setSudoCode('');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function doConfirm() {
    setError('');
    try {
      const { backupCodes } = await confirm.mutateAsync({ code });
      reset();
      onEnrolled(backupCodes);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={t('settings.twoFactor.setUpTitle')}
    >
      {!enrolment ? (
        <>
          <p>{t('settings.twoFactor.setUpIntro')}</p>
          <div className="field" style={{ marginBlockStart: '0.9rem' }}>
            <label className="label" htmlFor="tf-pw">
              {t('settings.currentPassword')}
            </label>
            <input
              id="tf-pw"
              className="input glass-inset"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {active && (
            <div className="field">
              <label className="label" htmlFor="tf-sudo">
                {t('settings.twoFactor.currentCode')}
              </label>
              <input
                id="tf-sudo"
                className="input glass-inset"
                inputMode="text"
                autoComplete="one-time-code"
                value={sudoCode}
                onChange={(e) => setSudoCode(e.target.value)}
              />
              <span className="hint">{t('settings.twoFactor.currentCodeHint')}</span>
            </div>
          )}
          {error && <p className="form-error">{error}</p>}
          <button
            className="btn btn--primary"
            style={{ marginBlockStart: '0.5rem' }}
            disabled={begin.isPending || !password}
            onClick={doBegin}
          >
            {begin.isPending ? t('auth.working') : t('common.continue')}
          </button>
        </>
      ) : (
        <>
          <p>{t('settings.twoFactor.scanIntro')}</p>
          <div style={{ display: 'flex', justifyContent: 'center', margin: '1rem 0' }}>
            <QrCode grid={enrolment.qr} label={t('settings.twoFactor.qrLabel')} />
          </div>
          <div className="field">
            <label className="label">{t('settings.twoFactor.manualKey')}</label>
            <pre className="logs glass-inset" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {groupKey(enrolment.secret)}
            </pre>
            <span className="hint">{t('settings.twoFactor.manualKeyHint', { account: enrolment.account })}</span>
          </div>
          <div className="field">
            <label className="label" htmlFor="tf-confirm">
              {t('settings.twoFactor.enterCode')}
            </label>
            <input
              id="tf-confirm"
              className="input glass-inset"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </div>
          {error && <p className="form-error">{error}</p>}
          <button
            className="btn btn--primary"
            disabled={confirm.isPending || code.length < 6}
            onClick={doConfirm}
          >
            <Check size={15} /> {confirm.isPending ? t('auth.working') : t('settings.twoFactor.turnOn')}
          </button>
        </>
      )}
    </Modal>
  );
}

/* ── the shared "prove it's you" dialog ────────────────────────────────── */

function SudoDialog({
  open,
  active,
  danger,
  title,
  body,
  confirmLabel,
  onClose,
  run,
  onDone,
}: {
  open: boolean;
  active: boolean;
  danger?: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onClose: () => void;
  run: (v: SudoVars) => Promise<unknown>;
  onDone: (result: unknown) => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function reset() {
    setPassword('');
    setCode('');
    setError('');
    setBusy(false);
  }

  async function go() {
    setError('');
    setBusy(true);
    try {
      const res = await run({ password, code: code || undefined });
      reset();
      onDone(res);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={title}
    >
      <p>{body}</p>
      <div className="field" style={{ marginBlockStart: '0.9rem' }}>
        <label className="label">{t('settings.currentPassword')}</label>
        <input
          className="input glass-inset"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {active && (
        <div className="field">
          <label className="label">{t('settings.twoFactor.currentCode')}</label>
          <input
            className="input glass-inset"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <span className="hint">{t('settings.twoFactor.currentCodeHint')}</span>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      <button
        className={danger ? 'btn btn--danger' : 'btn btn--primary'}
        disabled={busy || !password || (active && !code)}
        onClick={go}
      >
        {busy ? t('auth.working') : confirmLabel}
      </button>
    </Modal>
  );
}

/* ── backup codes, shown once ──────────────────────────────────────────── */

function BackupCodesDialog({
  codes,
  replacing,
  onDone,
}: {
  codes: string[] | null;
  /** True when an earlier set has just stopped working — say so, don't imply it. */
  replacing: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [saved, setSaved] = useState(false);
  const text = (codes ?? []).join('\n');

  function copy() {
    navigator.clipboard?.writeText(text).then(
      () => toast(t('settings.twoFactor.copied'), 'success'),
      () => toast(t('errors.generic'), 'error'),
    );
  }

  function download() {
    // A Blob and an anchor — no dependency, and the file never touches a server.
    const blob = new Blob([`${t('settings.twoFactor.fileHeader')}\n\n${text}\n`], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'openmasjidos-backup-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Modal
      open={codes !== null}
      /* LOCKED. These exist nowhere else — not on the server in readable form,
         not in this dialog once it closes. Escape or a stray click here is a
         lockout on the day the admin changes phone. */
      locked={!saved}
      onClose={() => {
        setSaved(false);
        onDone();
      }}
      title={t('settings.twoFactor.codesTitle')}
    >
      <p>{t('settings.twoFactor.codesIntro')}</p>
      {replacing && <p className="hint">{t('settings.twoFactor.codesReplaced')}</p>}
      <div
        className="logs glass-inset"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(7.5rem, 1fr))',
          gap: '0.35rem 1rem',
          margin: '0.9rem 0',
          textAlign: 'center',
        }}
      >
        {(codes ?? []).map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button className="btn" onClick={copy}>
          <Copy size={15} /> {t('common.copy')}
        </button>
        <button className="btn" onClick={download}>
          <Download size={15} /> {t('settings.twoFactor.download')}
        </button>
      </div>
      <div style={{ marginBlockStart: '1rem' }}>
        <CheckboxField checked={saved} onChange={setSaved} align="start">
          {t('settings.twoFactor.codesSaved')}
        </CheckboxField>
      </div>
      <button
        className="btn btn--primary"
        style={{ marginBlockStart: '0.9rem' }}
        disabled={!saved}
        onClick={() => {
          setSaved(false);
          onDone();
        }}
      >
        <KeyRound size={15} /> {t('common.done')}
      </button>
    </Modal>
  );
}
