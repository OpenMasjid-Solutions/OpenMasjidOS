// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, ShieldCheck, AlertTriangle } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Modal } from '../../components/Modal';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/ToastProvider';
import { errorText } from '../../lib/errors';

export function SslSection() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const tls = trpc.system.tlsInfo.useQuery();
  const [uploadOpen, setUploadOpen] = useState(false);
  // Asked first: a new certificate replaces an uploaded one with no copy kept, and on a
  // self-signed box it brings the browser's warning back on every device.
  const [askRegenerate, setAskRegenerate] = useState(false);
  const [cert, setCert] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const certId = useId();
  const keyId = useId();

  const refresh = () => utils.system.tlsInfo.invalidate();
  const regenerate = trpc.system.regenerateCert.useMutation({
    onSuccess: () => { setAskRegenerate(false); refresh(); toast(t('settings.sslRegenerated'), 'success'); },
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });
  const setCustom = trpc.system.setCustomCert.useMutation({
    onSuccess: () => {
      refresh();
      setUploadOpen(false);
      setCert('');
      setKey('');
      setError('');
      toast(t('settings.sslSaved'), 'success');
    },
    onError: (e) => setError(errorText(e, t('errors.generic'))),
  });

  const info = tls.data;
  const validTo = info?.validTo ? new Date(info.validTo).toLocaleDateString() : '—';
  // Set when the platform had to replace a damaged certificate at boot to keep the
  // dashboard reachable. Without saying so, an admin whose own certificate was
  // replaced would just meet an unexplained browser warning one morning.
  const recovered = info?.recovered;

  return (
    <div style={{ paddingBlock: '0.9rem', borderBlockStart: '1px solid var(--color-border)' }}>
      <div className="setting-row__title" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <ShieldCheck size={16} /> {t('settings.ssl')}
      </div>
      <div className="setting-row__hint" style={{ marginBlock: '0.2rem 0.6rem' }}>
        {info
          ? info.type === 'custom'
            ? t('settings.sslCustomNote', { date: validTo })
            : t('settings.sslSelfSignedNote', { date: validTo })
          : t('settings.sslHint')}
      </div>
      {recovered && (
        <div
          className="glass-inset panel"
          style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', marginBlockEnd: '0.6rem', borderInlineStart: '3px solid var(--color-warning)' }}
        >
          <AlertTriangle size={18} style={{ color: 'var(--color-warning)', flexShrink: 0, marginBlockStart: 2 }} />
          <div className="setting-row__hint">
            {t(recovered.replaced === 'custom' ? 'settings.sslRecoveredCustom' : 'settings.sslRecoveredSelfSigned', {
              date: new Date(recovered.at).toLocaleDateString(),
              reason: recovered.reason,
            })}
          </div>
        </div>
      )}
      {info && (
        <pre className="logs glass-inset" style={{ maxHeight: 'none', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {`${t('settings.sslFingerprint')}: ${info.fingerprint}`}
        </pre>
      )}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBlockStart: '0.6rem' }}>
        <button className="btn btn--sm" disabled={regenerate.isPending} onClick={() => setAskRegenerate(true)}>
          <RefreshCw size={14} /> {regenerate.isPending ? t('settings.sslRegenerating') : t('settings.sslRegenerate')}
        </button>
        <button className="btn btn--sm" onClick={() => { setError(''); setUploadOpen(true); }}>
          <ShieldCheck size={14} /> {t('settings.sslUseOwn')}
        </button>
      </div>

      <ConfirmDialog
        open={askRegenerate}
        onClose={() => setAskRegenerate(false)}
        onConfirm={() => regenerate.mutate()}
        title={t('confirm.sslRegenerateTitle')}
        body={t('confirm.sslRegenerateBody')}
        cost={info?.type === 'custom' ? t('confirm.sslRegenerateCostCustom') : t('confirm.sslRegenerateCost')}
        confirmLabel={t('confirm.sslRegenerateConfirm')}
        pending={regenerate.isPending}
      />

      <Modal open={uploadOpen} onClose={() => !setCustom.isPending && setUploadOpen(false)} title={t('settings.sslUploadTitle')}>
        <p className="setting-row__hint">{t('settings.sslUploadBody')}</p>
        <label className="label" htmlFor={certId} style={{ marginBlockStart: '0.6rem' }}>{t('settings.sslCertLabel')}</label>
        <textarea
          id={certId}
          className="textarea glass-inset"
          style={{ minHeight: '6rem', fontFamily: 'ui-monospace, monospace' }}
          placeholder="-----BEGIN CERTIFICATE-----"
          value={cert}
          onChange={(e) => setCert(e.target.value)}
        />
        <label className="label" htmlFor={keyId} style={{ marginBlockStart: '0.6rem' }}>{t('settings.sslKeyLabel')}</label>
        <textarea
          id={keyId}
          className="textarea glass-inset"
          style={{ minHeight: '6rem', fontFamily: 'ui-monospace, monospace' }}
          placeholder="-----BEGIN PRIVATE KEY-----"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        {error && <p className="form-error">{error}</p>}
        <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginBlockStart: '1rem' }}>
          <button className="btn" onClick={() => setUploadOpen(false)}>{t('common.cancel')}</button>
          <button
            className="btn btn--primary"
            disabled={setCustom.isPending || !cert.trim() || !key.trim()}
            onClick={() => setCustom.mutate({ cert: cert.trim() + '\n', key: key.trim() + '\n' })}
          >
            {setCustom.isPending ? t('settings.sslSaving') : t('settings.sslSave')}
          </button>
        </div>
      </Modal>
    </div>
  );
}
