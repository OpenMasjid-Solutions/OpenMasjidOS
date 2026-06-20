/**
 * First-run admin creation + login. No part of the app is reachable without
 * passing through here (CLAUDE.md §9). No masjid/prayer details are collected.
 */
import { useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../lib/trpc';
import { MasjidMark } from './Glyphs';
import { Modal } from './Modal';
import { fadeRise } from '../lib/motion';

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

  const setup = trpc.auth.setup.useMutation();
  const login = trpc.auth.login.useMutation();
  const busy = setup.isPending || login.isPending;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      if (setupRequired) {
        if (password.length < 8) return setError(t('auth.passwordTooShort'));
        if (password !== confirm) return setError(t('auth.passwordsMismatch'));
        await setup.mutateAsync({ username, password });
      } else {
        await login.mutateAsync({ username, password });
      }
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
            {setupRequired && <span className="hint">{t('auth.passwordHint')}</span>}
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
    </div>
  );
}
