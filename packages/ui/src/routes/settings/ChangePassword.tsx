// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { setCsrf } from '../../lib/session';
import { PhoneField } from '../../components/PhoneField';
import { useToast } from '../../components/ToastProvider';
import { MIN_PW } from '../../components/AuthScreen';
import { errorText } from '../../lib/errors';
import { Field } from './shared';

export function ChangePassword() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');

  // Admin profile (name + email + WhatsApp number). Email is where OS alerts are sent;
  // a pre-email install sets it here for the first time. The phone is the same idea for
  // the WhatsApp channel — a destination, never a sign-in.
  const me = trpc.auth.me.useQuery();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const seeded = useRef(false);
  useEffect(() => {
    if (me.data && !seeded.current) {
      setName(me.data.name ?? '');
      setEmail(me.data.email ?? '');
      setPhone(me.data.phone ?? '');
      seeded.current = true;
    }
  }, [me.data]);
  const saveProfile = trpc.auth.updateProfile.useMutation({
    onSuccess: async () => {
      // A new address pauses emailed sign-in codes (core auth/twofactor.ts), and the
      // two-step panel sits just below this form: without this it went on showing
      // them as on until its cache ran out.
      void utils.auth.twoFactor.status.invalidate();
      // Then show what the server now HOLDS rather than what was typed: a cleared email
      // keeps the old one, and a number it could not use is not stored — the boxes must
      // not go on showing either as saved.
      await utils.auth.me.invalidate();
      const stored = utils.auth.me.getData();
      if (stored) {
        setName(stored.name ?? '');
        setEmail(stored.email ?? '');
        setPhone(stored.phone ?? '');
      }
      toast(t('settings.profileSaved'), 'success');
    },
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });

  const change = trpc.auth.changePassword.useMutation({
    onSuccess: (res) => {
      // Changing the password rotates the session (and its dashboard key).
      setCsrf(res.csrf);
      setCurrent('');
      setNext('');
      setError('');
      toast(t('settings.passwordChanged'), 'success');
    },
    onError: (e) => setError(errorText(e, t('errors.generic'))),
  });

  return (
    <section className="glass-raised panel">
      <h2 className="panel-title">{t('settings.account')}</h2>
      <Field label={t('settings.accountName')} style={{ maxWidth: '20rem' }}>
        {(id) => <input id={id} className="input glass-inset" value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label={t('settings.accountEmail')} hint={t('settings.accountEmailHint')} style={{ maxWidth: '20rem' }}>
        {(id) => (
          <input id={id} className="input glass-inset" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        )}
      </Field>
      <PhoneField
        value={phone}
        onChange={setPhone}
        label={t('settings.accountPhone')}
        hint={t('settings.accountPhoneHint')}
      />
      <button
        className="btn"
        style={{ marginBlockEnd: '1rem' }}
        disabled={saveProfile.isPending || (!name.trim() && !email.trim() && !phone.trim())}
        onClick={() =>
          saveProfile.mutate({
            name: name.trim() || undefined,
            email: email.trim() || undefined,
            // Sent even when blank, so clearing the box actually removes the number —
            // `undefined` would mean "leave it alone" and the field would look cleared
            // while alerts kept going to the old phone.
            phone: phone.trim(),
          })
        }
      >
        <Check size={15} /> {t('settings.saveProfile')}
      </button>
      <Field label={t('settings.currentPassword')} style={{ maxWidth: '20rem' }}>
        {(id) => (
          <input id={id} className="input glass-inset" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        )}
      </Field>
      {/* The rule is said up front: the button below stays greyed until it is met, and a
          button that will not press without saying why reads as broken. */}
      <Field label={t('settings.newPassword')} hint={t('auth.passwordHint')} style={{ maxWidth: '20rem' }}>
        {(id) => (
          <input id={id} className="input glass-inset" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        )}
      </Field>
      {error && <p className="form-error">{error}</p>}
      <button
        className="btn btn--primary"
        disabled={change.isPending || !current || next.length < MIN_PW}
        onClick={() => change.mutate({ currentPassword: current, newPassword: next })}
      >
        <Check size={15} /> {t('settings.changePassword')}
      </button>
    </section>
  );
}
