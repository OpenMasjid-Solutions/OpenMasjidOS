// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Toggle } from '../../components/Toggle';
import { useToast } from '../../components/ToastProvider';
import { errorText } from '../../lib/errors';
import type { RouterOutputs } from '../../lib/types';
import { StatusDot, Field } from './shared';

/** Email provider (SMTP / Resend). Configured once; the OS sends admin alerts and
 *  apps send mail (receipts, parent notices) through it via the Fabric — no app ever
 *  handles mail credentials. */
export function EmailPanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const cfg = trpc.email.get.useQuery();
  const status = trpc.email.status.useQuery(undefined, { refetchInterval: 60_000 });

  const [provider, setProvider] = useState<'none' | 'smtp' | 'resend'>('none');
  const [fromEmail, setFromEmail] = useState('');
  const [fromName, setFromName] = useState('');
  const [host, setHost] = useState('');
  // As typed, so the box can be emptied while editing; turned into a number on save.
  const [port, setPort] = useState('587');
  const [secure, setSecure] = useState(false);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [apiKey, setApiKey] = useState('');
  // What the boxes were filled with. Only what differs from it is sent — the rest is left
  // as the server has it, so a change made on another device since is not put back.
  const loaded = useRef<RouterOutputs['email']['get'] | null>(null);
  const fill = (d: RouterOutputs['email']['get']) => {
    loaded.current = d;
    setProvider(d.provider);
    setFromEmail(d.fromEmail);
    setFromName(d.fromName);
    setHost(d.smtp.host);
    setPort(String(d.smtp.port));
    setSecure(d.smtp.secure);
    setUser(d.smtp.user);
  };
  useEffect(() => {
    if (cfg.data && !loaded.current) fill(cfg.data);
  }, [cfg.data]);

  const save = trpc.email.save.useMutation({
    onSuccess: (r) => {
      setPass('');
      setApiKey('');
      // Show what was stored, as the server tidied it.
      fill(r);
      utils.email.get.invalidate();
      utils.email.status.invalidate();
      // Another mail account pauses emailed sign-in codes too (see saveProfile).
      utils.auth.twoFactor.status.invalidate();
      toast(t('settings.emailSaved'), 'success');
    },
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });
  const test = trpc.email.test.useMutation({
    onSuccess: (r) => toast(t('settings.emailTestSent', { to: r.to }), 'success'),
    onError: (e) => toast(errorText(e, t('settings.emailTestFailed')), 'error'),
  });

  // Basic From-address validation so an invalid address is caught before Save
  // (the server also validates + verifies the provider before persisting).
  const EMAIL_OK = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;
  const fromTrimmed = fromEmail.trim();
  const fromInvalid = provider !== 'none' && fromTrimmed !== '' && !EMAIL_OK.test(fromTrimmed);
  const canSave = provider === 'none' || EMAIL_OK.test(fromTrimmed);

  function onSave() {
    const was = loaded.current;
    if (!was) return;
    // `undefined` leaves a field as the server has it (core store/email.ts).
    const edited = <T,>(now: T, then: T): T | undefined => (now === then ? undefined : now);
    save.mutate({
      provider: edited(provider, was.provider),
      fromEmail: edited(fromEmail.trim(), was.fromEmail),
      fromName: edited(fromName.trim(), was.fromName),
      smtp: {
        host: edited(host.trim(), was.smtp.host),
        // An emptied box keeps the stored port rather than sending nothing as a number.
        port: port.trim() ? edited(Number(port), was.smtp.port) : undefined,
        secure: edited(secure, was.smtp.secure),
        user: edited(user.trim(), was.smtp.user),
        pass: pass || undefined,
      },
      resend: { apiKey: apiKey || undefined },
    });
  }

  if (!cfg.data) return null;
  const stored = cfg.data;

  return (
    <section className="glass-raised panel">
      <h2 className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
        <StatusDot online={status.isLoading ? undefined : status.data?.configured} /> {t('settings.email')}
      </h2>
      <p className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.emailHint')}</p>

      <Field label={t('settings.emailProvider')} style={{ maxWidth: '22rem' }}>
        {(id) => (
          <select id={id} className="input glass-inset" value={provider} onChange={(e) => setProvider(e.target.value as 'none' | 'smtp' | 'resend')}>
            <option value="none">{t('settings.emailNone')}</option>
            <option value="smtp">SMTP</option>
            <option value="resend">Resend</option>
          </select>
        )}
      </Field>

      {provider !== 'none' && (
        <>
          <Field label={t('settings.emailFrom')} style={{ maxWidth: '22rem' }}>
            {(id) => (
              <>
                <input
                  id={id}
                  className="input glass-inset"
                  type="email"
                  placeholder="no-reply@yourmasjid.org"
                  value={fromEmail}
                  aria-invalid={fromInvalid}
                  style={fromInvalid ? { borderColor: '#ef4444' } : undefined}
                  onChange={(e) => setFromEmail(e.target.value)}
                />
                {fromInvalid && <span className="hint" style={{ color: '#ef4444' }}>{t('settings.emailFromInvalid')}</span>}
              </>
            )}
          </Field>
          <Field label={t('settings.emailFromName')} style={{ maxWidth: '22rem' }}>
            {(id) => <input id={id} className="input glass-inset" value={fromName} onChange={(e) => setFromName(e.target.value)} />}
          </Field>
        </>
      )}

      {provider === 'smtp' && (
        <>
          <Field label={t('settings.emailSmtpHost')} style={{ maxWidth: '22rem' }}>
            {(id) => <input id={id} className="input glass-inset" placeholder="smtp.example.org" value={host} onChange={(e) => setHost(e.target.value)} />}
          </Field>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <Field label={t('settings.emailSmtpPort')} style={{ maxWidth: '8rem' }}>
              {(id) => <input id={id} className="input glass-inset" type="number" value={port} onChange={(e) => setPort(e.target.value)} />}
            </Field>
            <div className="setting-row" style={{ alignItems: 'end' }}>
              <div className="setting-row__text"><div className="setting-row__title">{t('settings.emailSmtpSecure')}</div></div>
              <Toggle checked={secure} onChange={setSecure} label={t('settings.emailSmtpSecure')} />
            </div>
          </div>
          <Field label={t('settings.emailSmtpUser')} style={{ maxWidth: '22rem' }}>
            {(id) => <input id={id} className="input glass-inset" autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} />}
          </Field>
          <Field label={t('settings.emailSmtpPass')} style={{ maxWidth: '22rem' }}>
            {(id) => (
              <input
                id={id}
                className="input glass-inset"
                type="password"
                autoComplete="off"
                placeholder={stored.hasSmtpPass ? t('settings.emailSecretKept') : ''}
                value={pass}
                onChange={(e) => setPass(e.target.value)}
              />
            )}
          </Field>
        </>
      )}

      {provider === 'resend' && (
        <Field label={t('settings.emailResendKey')} style={{ maxWidth: '22rem' }}>
          {(id) => (
            <input
              id={id}
              className="input glass-inset"
              type="password"
              autoComplete="off"
              placeholder={stored.hasResendKey ? t('settings.emailSecretKept') : 're_…'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          )}
        </Field>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBlockStart: '0.6rem' }}>
        <button className="btn btn--primary" disabled={save.isPending || !canSave} onClick={onSave}>
          <Check size={15} /> {save.isPending ? t('settings.emailVerifying') : t('settings.emailSave')}
        </button>
        {status.data?.configured && (
          <button className="btn" disabled={test.isPending} onClick={() => test.mutate({})}>
            {test.isPending ? t('settings.emailTesting') : t('settings.emailTest')}
          </button>
        )}
      </div>
    </section>
  );
}
