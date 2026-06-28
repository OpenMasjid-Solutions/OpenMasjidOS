// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * First-run admin creation + login. No part of the app is reachable without
 * passing through here (CLAUDE.md §9). No masjid/prayer details are collected.
 */
import { useState, useRef, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../lib/trpc';
import { setCsrf, getCsrf } from '../lib/session';
import { MasjidMark } from './Glyphs';
import { Modal } from './Modal';
import { RestoreModal } from './RestoreModal';
import { fadeRise } from '../lib/motion';

// Keep in step with MIN_PASSWORD_LENGTH on the server (packages/core/src/auth/passwords.ts).
const MIN_PW = 12;
const STRENGTH_COLORS = ['#ef4444', '#f59e0b', '#eab308', '#22c55e'];
const STRENGTH_KEYS = ['auth.pwWeak', 'auth.pwFair', 'auth.pwGood', 'auth.pwStrong'];

/** A rough 0–4 strength score: length tiers + character variety. */
function passwordScore(pw: string): number {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= MIN_PW) s += 1;
  if (pw.length >= 16) s += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s += 1;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s += 1;
  return Math.min(s, 4);
}

export function AuthScreen({
  setupRequired,
  onAuthed,
}: {
  setupRequired: boolean;
  onAuthed: () => void;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [showReset, setShowReset] = useState(false);
  const [restoreUploading, setRestoreUploading] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const restoreInput = useRef<HTMLInputElement>(null);
  const pwScore = passwordScore(password);

  // First-run restore: a fresh box can restore a backup directly — no account to
  // create first (the backup brings the admin account, settings and all app data).
  async function uploadAndRestore(file: File) {
    setRestoreUploading(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/restore/upload', {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-omos-csrf': getCsrf() }, // empty on first run; the server skips the key check then
        body: fd,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || t('auth.genericError'));
      }
      setRestoreOpen(true);
    } catch (err) {
      setError((err as Error).message || t('auth.genericError'));
    } finally {
      setRestoreUploading(false);
    }
  }

  const setup = trpc.auth.setup.useMutation();
  const login = trpc.auth.login.useMutation();
  const busy = setup.isPending || login.isPending;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      let res;
      if (setupRequired) {
        if (password.length < MIN_PW) return setError(t('auth.passwordTooShort'));
        if (password !== confirm) return setError(t('auth.passwordsMismatch'));
        res = await setup.mutateAsync({ username, password });
      } else {
        res = await login.mutateAsync({ username, password });
      }
      // Persist the dashboard key BEFORE the gate re-renders, so the first
      // authenticated calls carry it.
      setCsrf(res.csrf);
      onAuthed();
    } catch (err) {
      setError((err as Error).message || t('auth.genericError'));
    }
  }

  return (
    <div className="auth-wrap">
      <motion.div className="auth-card glass-raised" variants={fadeRise} initial="initial" animate="animate">
        <div className="auth-logo">
          <MasjidMark size={48} />
        </div>
        <h1 className="page-title" style={{ textAlign: 'center', fontSize: '1.5rem' }}>
          {setupRequired ? t('auth.setupTitle') : t('auth.loginTitle')}
        </h1>
        <p className="page-sub" style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
          {setupRequired ? t('auth.setupSubtitle') : t('auth.loginSubtitle')}
        </p>

        <form onSubmit={submit}>
          <div className="field">
            <label className="label" htmlFor="username">
              {t('auth.username')}
            </label>
            <input
              id="username"
              className="input glass-inset"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="password">
              {t('auth.password')}
            </label>
            <input
              id="password"
              type="password"
              className="input glass-inset"
              autoComplete={setupRequired ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {setupRequired && password.length > 0 && (
              <div style={{ marginBlockStart: '0.45rem' }} aria-hidden="true">
                <div style={{ display: 'flex', gap: '0.25rem' }}>
                  {[0, 1, 2, 3].map((i) => (
                    <span
                      key={i}
                      style={{
                        flex: 1,
                        height: '4px',
                        borderRadius: '2px',
                        background: i < pwScore ? STRENGTH_COLORS[pwScore - 1] : 'var(--glass-border)',
                        transition: 'background var(--dur-micro) ease',
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
            {setupRequired && (
              <span className="hint">
                {password.length > 0 && pwScore > 0 ? t(STRENGTH_KEYS[pwScore - 1]) : t('auth.passwordHint')}
              </span>
            )}
          </div>

          {setupRequired && (
            <div className="field">
              <label className="label" htmlFor="confirm">
                {t('auth.confirmPassword')}
              </label>
              <input
                id="confirm"
                type="password"
                className="input glass-inset"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </div>
          )}

          {error && <p className="form-error">{error}</p>}

          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? t('auth.working') : setupRequired ? t('auth.createAccount') : t('auth.signIn')}
          </button>
        </form>

        {setupRequired && (
          <>
            <div className="auth-or" style={{ textAlign: 'center', color: 'var(--color-ink-muted)', margin: '0.85rem 0 0.5rem', fontSize: '0.85rem' }}>
              {t('auth.or')}
            </div>
            <button
              type="button"
              className="btn btn--ghost btn--block"
              disabled={restoreUploading}
              onClick={() => restoreInput.current?.click()}
            >
              {restoreUploading ? t('auth.restoreUploading') : t('auth.restore')}
            </button>
            <input
              ref={restoreInput}
              type="file"
              accept=".gz,.tgz,application/gzip"
              className="visually-hidden"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                if (f) uploadAndRestore(f);
                e.target.value = '';
              }}
            />
            <p className="hint" style={{ textAlign: 'center', marginTop: '0.45rem' }}>{t('auth.restoreHint')}</p>
          </>
        )}

        {!setupRequired && (
          <button
            type="button"
            className="btn btn--ghost btn--block"
            style={{ marginTop: '0.6rem', border: 'none', color: 'var(--color-ink-muted)' }}
            onClick={() => setShowReset(true)}
          >
            {t('auth.forgotPassword')}
          </button>
        )}
      </motion.div>

      <Modal open={showReset} onClose={() => setShowReset(false)} title={t('auth.resetTitle')}>
        <p>{t('auth.resetIntro')}</p>
        <pre className="logs glass-inset" style={{ marginTop: '0.75rem' }}>
          {t('auth.resetCmd')}
        </pre>
        <p style={{ marginTop: '0.75rem' }}>{t('auth.resetOutro')}</p>
        <button className="btn btn--primary" style={{ marginTop: '1rem' }} onClick={() => setShowReset(false)}>
          {t('auth.resetClose')}
        </button>
      </Modal>

      <RestoreModal open={restoreOpen} onClose={() => setRestoreOpen(false)} />
    </div>
  );
}
