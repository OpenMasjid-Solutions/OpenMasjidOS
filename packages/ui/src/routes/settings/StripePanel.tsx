// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, ExternalLink, CreditCard, Pencil } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useWindows } from '../../components/Windows';
import { useToast } from '../../components/ToastProvider';
import { errorText } from '../../lib/errors';
import { StatusDot, Field } from './shared';

interface StripeAccountPublic {
  id: string;
  label: string;
  publishableKey: string;
  hasSecret: boolean;
  hasWebhook: boolean;
}

/** Stripe account vault. The admin stores named accounts here once; apps with the
 *  Fabric `stripe` capability fetch them at runtime — no re-entering keys per app. */
export function StripePanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const accounts = trpc.stripe.list.useQuery();
  // Per-account online/offline (green/red dot). Re-checks ~every 60s.
  const stripeStatus = trpc.stripe.status.useQuery(undefined, { refetchInterval: 60_000 });
  const onlineById = new Map((stripeStatus.data ?? []).map((s) => [s.id, s.online]));
  const refresh = () => utils.stripe.list.invalidate();
  const windows = useWindows();
  /** The account pending removal, or null. Drives the confirmation dialog. */
  const [confirmRemove, setConfirmRemove] = useState<StripeAccountPublic | null>(null);

  // Open the add/edit form as a managed traffic-light window (like the rest of the OS).
  function openForm(account: StripeAccountPublic | null) {
    let id = -1;
    id = windows.open({
      title: account ? t('settings.stripeEditTitle') : t('settings.stripeAddTitle'),
      icon: <CreditCard size={15} />,
      dedupeKey: account ? `stripe-${account.id}` : 'stripe-new',
      node: (
        <StripeAccountForm
          account={account}
          onClose={() => windows.close(id)}
          onSaved={() => { windows.close(id); refresh(); }}
        />
      ),
    });
  }

  const remove = trpc.stripe.remove.useMutation({
    onSuccess: () => { refresh(); toast(t('settings.stripeRemoved'), 'success'); },
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });

  const list = accounts.data ?? [];
  return (
    <section className="glass-raised panel">
      <h2 className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
        <CreditCard size={18} /> {t('settings.payments')}
      </h2>
      <p className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.paymentsHint')}</p>

      <details style={{ marginBlockEnd: '0.6rem' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{t('settings.stripeGuideTitle')}</summary>
        <ul style={{ margin: '0.5rem 0 0', paddingInlineStart: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', lineHeight: 1.55, color: 'var(--color-ink)' }}>
          <li>
            {t('settings.stripeGuideKeys')}{' '}
            <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)', whiteSpace: 'nowrap' }}>
              dashboard.stripe.com/apikeys <ExternalLink size={12} style={{ verticalAlign: 'middle' }} />
            </a>{' '}
            {t('settings.stripeGuideKeysAfter')}
          </li>
          <li>{t('settings.stripeGuideWebhook')}</li>
          <li style={{ color: 'var(--color-ink-muted)' }}>{t('settings.stripeGuideTest')}</li>
        </ul>
      </details>

      {list.length === 0 && <p className="setting-row__hint">{t('settings.stripeNone')}</p>}
      {list.map((a) => (
        <div className="setting-row" key={a.id}>
          <div className="setting-row__text">
            <div className="setting-row__title" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
              <StatusDot online={stripeStatus.isLoading ? undefined : onlineById.get(a.id)} />
              {a.label}
            </div>
            <div className="setting-row__hint" style={{ fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>
              {a.publishableKey || '—'} · {a.hasSecret ? t('settings.stripeSecretSet') : t('settings.stripeSecretMissing')}
              {a.hasWebhook ? ` · ${t('settings.stripeWebhookSet')}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn btn--sm" onClick={() => openForm(a)}><Pencil size={14} /> {t('settings.stripeEdit')}</button>
            {/* Confirmed, not immediate: this button used to sit 8px from Edit with
                identical styling, and one misclick dropped a secret key the
                dashboard can never show back — recovery means re-issuing it in
                Stripe and re-entering the webhook secret. */}
            <button className="btn btn--sm" disabled={remove.isPending} onClick={() => setConfirmRemove(a)}>
              <Trash2 size={14} /> {t('settings.backupRemove')}
            </button>
          </div>
        </div>
      ))}

      <button className="btn btn--primary" style={{ marginBlockStart: '0.6rem' }} onClick={() => openForm(null)}>
        <CreditCard size={15} /> {t('settings.stripeAdd')}
      </button>

      <ConfirmDialog
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        pending={remove.isPending}
        title={t('confirm.stripeRemoveTitle', { name: confirmRemove?.label ?? '' })}
        body={t('confirm.stripeRemoveBody')}
        cost={t('confirm.stripeRemoveCost')}
        confirmLabel={t('confirm.stripeRemoveConfirm')}
        onConfirm={() => {
          if (confirmRemove) {
            remove.mutate({ id: confirmRemove.id }, { onSuccess: () => setConfirmRemove(null) });
          }
        }}
      />
    </section>
  );
}

function StripeAccountForm({ account, onClose, onSaved }: { account: StripeAccountPublic | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const isEdit = account !== null;
  const [label, setLabel] = useState(account?.label ?? '');
  const [publishableKey, setPublishableKey] = useState(account?.publishableKey ?? '');
  const [secretKey, setSecretKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [error, setError] = useState('');

  const save = trpc.stripe.save.useMutation({
    onSuccess: onSaved,
    onError: (e) => setError(errorText(e, t('errors.generic'))),
  });

  function submit() {
    setError('');
    save.mutate({
      id: account?.id,
      label: label.trim(),
      publishableKey: publishableKey.trim(),
      secretKey: secretKey.trim() || undefined,
      webhookSecret: webhookSecret.trim() || undefined,
    });
  }

  return (
    <>
      <Field label={t('settings.stripeLabel')}>
        {(id) => (
          <input id={id} className="input glass-inset" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('settings.stripeLabelPlaceholder')} />
        )}
      </Field>
      <Field label={t('settings.stripePublishable')}>
        {(id) => (
          <input
            id={id}
            className="input glass-inset"
            style={{ fontFamily: 'ui-monospace, monospace' }}
            value={publishableKey}
            onChange={(e) => setPublishableKey(e.target.value)}
            placeholder="pk_live_…"
            autoComplete="off"
          />
        )}
      </Field>
      <Field label={t('settings.stripeSecret')}>
        {(id) => (
          <input
            id={id}
            className="input glass-inset"
            type="password"
            style={{ fontFamily: 'ui-monospace, monospace' }}
            value={secretKey}
            onChange={(e) => setSecretKey(e.target.value)}
            placeholder={isEdit ? t('settings.stripeKeepBlank') : 'sk_live_…'}
            autoComplete="off"
          />
        )}
      </Field>
      <Field label={t('settings.stripeWebhook')}>
        {(id) => (
          <>
            <input
              id={id}
              className="input glass-inset"
              type="password"
              style={{ fontFamily: 'ui-monospace, monospace' }}
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              placeholder={isEdit ? t('settings.stripeKeepBlank') : 'whsec_…'}
              autoComplete="off"
            />
            <div className="setting-row__hint">{t('settings.stripeWebhookHint')}</div>
          </>
        )}
      </Field>
      {error && <p className="form-error">{error}</p>}
      <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginBlockStart: '1rem' }}>
        <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn--primary" disabled={save.isPending || !label.trim()} onClick={submit}>
          {save.isPending ? t('settings.stripeSaving') : t('settings.stripeSave')}
        </button>
      </div>
    </>
  );
}
