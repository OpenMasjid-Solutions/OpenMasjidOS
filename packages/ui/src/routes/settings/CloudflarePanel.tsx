// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, ShieldCheck, Trash2, ExternalLink, Globe } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Toggle } from '../../components/Toggle';
import { Modal } from '../../components/Modal';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { isRemoteSession } from '../../lib/apps';
import { useToast } from '../../components/ToastProvider';
import { errorText } from '../../lib/errors';
import { StatusDot, Field } from './shared';

/**
 * Why the tunnel turned recent requests away.
 *
 * This is the panel that answers "my public page says Not found and I cannot tell why".
 * Every one of those 404s is identical from outside on purpose, so this is the only place
 * the difference is visible — and it is behind a sign-in (from outside, one that passed the
 * second factor), which is what makes being specific here safe.
 */
function TunnelRefusals({ port }: { port: number }) {
  const { t } = useTranslation();
  // Only while someone is looking at this panel; it is a diagnostic, not a monitor.
  const q = trpc.cloudflare.refusals.useQuery(undefined, { refetchInterval: 15_000 });
  const rows = q.data ?? [];
  if (rows.length === 0) return null;
  return (
    <div className="glass-inset panel" style={{ marginBlockStart: '0.9rem' }}>
      <div className="setting-row__title">{t('settings.cfRefusalsTitle')}</div>
      <div className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>
        {t('settings.cfRefusalsHint')}
      </div>
      {rows.map((r) => (
        <div
          key={r.ref}
          className="setting-row__hint"
          style={{ paddingBlock: '0.4rem', borderBlockStart: '1px solid var(--glass-border, rgba(255,255,255,0.08))' }}
        >
          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
            <code style={{ flex: '1 1 16rem', minWidth: 0, wordBreak: 'break-all' }}>
              {r.host}
              {r.path}
            </code>
            <span style={{ flex: '0 0 auto' }}>
              {r.reason === 'plain-http-no-host'
                ? t('settings.cfRefusalPlainHttp')
                : r.reason === 'app-not-shared'
                ? t('settings.cfRefusalAppNotShared')
                : r.reason === 'wrong-port'
                ? t('settings.cfRefusalWrongPort', { port })
                : r.reason === 'worker-at-bare-address'
                ? t('settings.cfRefusalWorker')
                : r.reason === 'no-app-at-path'
                ? t('settings.cfRefusalNoApp')
                : r.reason === 'app-fabric-lan-only'
                  ? t('settings.cfRefusalAppFabric')
                  : t('settings.cfRefusalLanOnly')}
              {r.count > 1 ? ` \u00d7${r.count}` : ''}
            </span>
          </div>
          {/* The reference is what someone seeing the error can read back to you, and the
              Cloudflare ray is what ties this to Cloudflare's own record of the request —
              including which of its locations served it, which is the obvious suspect when
              the same page works for one visitor and not another. */}
          <div style={{ display: 'flex', gap: '0.9rem', flexWrap: 'wrap', opacity: 0.75, marginBlockStart: '0.15rem' }}>
            <span>
              {t('settings.cfRefusalRef')} <code>{r.ref}</code>
            </span>
            <span>{r.method}</span>
            <span>{r.wantsHtml ? t('settings.cfRefusalPage') : t('settings.cfRefusalData')}</span>
            {r.cfRay ? (
              <span>
                {t('settings.cfRefusalRay')} <code>{r.cfRay}</code>
              </span>
            ) : null}
          </div>
          {r.agent ? (
            <div style={{ opacity: 0.6, wordBreak: 'break-all', marginBlockStart: '0.1rem' }}>{r.agent}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Cloudflare Tunnel — paste a token + domain once; the OS runs cloudflared so the
 *  masjid's apps are reachable from the internet. Apps read their public URL via the
 *  Fabric (`GET /api/fabric/site`). */
export function CloudflarePanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const status = trpc.cloudflare.status.useQuery();
  const routes = trpc.cloudflare.routes.useQuery();
  const refresh = () => utils.cloudflare.status.invalidate();
  const cf = status.data;

  const [domain, setDomain] = useState('');
  const [token, setToken] = useState('');
  // The apps' address is sent only when edited: sending what the field held since the
  // page loaded put back an address another device had changed — every shared app's
  // public links with it.
  const [domainEdited, setDomainEdited] = useState(false);
  // From outside, the actions below that close remote access close it on THIS window
  // too, and only someone at the masjid can open it again: those get asked first.
  // At the masjid they are reversible with the control beside them, so they do not
  // (ConfirmDialog's own rule).
  const remote = isRemoteSession();
  const [cutOff, setCutOff] = useState<null | 'tunnel' | 'remoteAdmin' | 'clear'>(null);
  const seeded = useRef(false);
  useEffect(() => {
    if (cf && !seeded.current) {
      setDomain(cf.domain);
      seeded.current = true;
    }
  }, [cf]);

  const save = trpc.cloudflare.save.useMutation({
    onSuccess: (r) => {
      setToken('');
      // Show what is stored now, as the server normalised it.
      setDomain(r.domain);
      setDomainEdited(false);
      refresh();
      // The shared-apps table and the setup guide print the apps' address too.
      utils.cloudflare.routes.invalidate();
      toast(t('settings.cfSaved'), 'success');
    },
    // Refresh the status on a refusal too, so it says what is actually stored. The fields
    // keep what was typed, so a mistyped address can be corrected rather than retyped.
    onError: (e) => { refresh(); toast(errorText(e, t('errors.generic')), 'error'); },
  });
  // A cut-off confirmed from outside takes down the very connection its answer would come
  // back on, so the answer never arrives: Cloudflare sends its own error page instead.
  // That is the action having WORKED — say so, rather than toast a parse error and leave
  // the dialog armed to do it again.
  const cutOffEnded = (e: { data?: { code?: string } | null }) => {
    if (!remote || cutOff === null || e.data?.code) return false;
    setCutOff(null);
    toast(t('settings.cfCutOffDone'), 'info');
    return true;
  };
  const setEnabled = trpc.cloudflare.setEnabled.useMutation({
    onSuccess: () => { setCutOff(null); refresh(); },
    onError: (e) => {
      if (!cutOffEnded(e)) toast(errorText(e, t('errors.generic')), 'error');
    },
  });
  const clear = trpc.cloudflare.clear.useMutation({
    onSuccess: () => { setCutOff(null); setToken(''); refresh(); toast(t('settings.cfCleared'), 'success'); },
    onError: (e) => {
      if (!cutOffEnded(e)) toast(errorText(e, t('errors.generic')), 'error');
    },
  });
  const setPath = trpc.cloudflare.setPath.useMutation({
    onSuccess: (r) => { utils.cloudflare.routes.invalidate(); toast(t('settings.cfPathSaved', { path: r.path }), 'success'); },
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });
  // Publishing the DASHBOARD, as opposed to an app. Turning it on opens a
  // confirmation first — this is the one switch on the page whose effect is
  // outside the masjid's building, so it must not happen on a single stray click.
  const [remoteAdminAsk, setRemoteAdminAsk] = useState(false);
  const setRemoteAdmin = trpc.cloudflare.setRemoteAdmin.useMutation({
    onSuccess: (r) => {
      refresh();
      setRemoteAdminAsk(false);
      setCutOff(null);
      toast(r.remoteAdminActive ? t('settings.cfRemoteAdminOn') : t('settings.cfRemoteAdminOff'), 'success');
    },
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });
  const setExposed = trpc.cloudflare.setExposed.useMutation({
    onSuccess: (r) => {
      utils.cloudflare.routes.invalidate();
      toast(r.exposed ? t('settings.cfExposedOn') : t('settings.cfExposedOff'), 'success');
    },
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });

  if (!cf) return null;
  const tokenSet = cf.hasToken;

  return (
    <section className="glass-raised panel">
      <h2 className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
        <Globe size={18} /> {t('settings.remoteAccess')}
      </h2>
      <p className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.remoteAccessHint')}</p>

      <div className="setting-row">
        <div className="setting-row__text">
          <div className="setting-row__title" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
            <StatusDot online={cf.enabled ? cf.running : undefined} />
            {t('settings.cfEnable')}
          </div>
          <div className="setting-row__hint">
            {cf.running
              ? t('settings.cfRunning')
              : !cf.hasToken
                ? t('settings.cfNoToken')
                : cf.enabled
                  ? t('settings.cfNotConnecting')
                  : t('settings.cfStopped')}
          </div>
        </div>
        <Toggle
          checked={cf.enabled}
          onChange={(v) => (!v && remote ? setCutOff('tunnel') : setEnabled.mutate({ enabled: v }))}
          label={t('settings.cfEnable')}
        />
      </div>

      <div className="setting-row">
        <div className="setting-row__text">
          <div className="setting-row__title">{t('settings.cfDomain')}</div>
          <div className="setting-row__hint">{t('settings.cfDomainHint')}</div>
        </div>
        <input
          className="input glass-inset"
          style={{ maxWidth: '16rem' }}
          placeholder="omos.example.org"
          aria-label={t('settings.cfDomain')}
          value={domain}
          onChange={(e) => {
            setDomain(e.target.value);
            setDomainEdited(true);
          }}
        />
      </div>

      <Field label={t('settings.cfToken')}>
        {(id) => (
          <>
            <input
              id={id}
              className="input glass-inset"
              type="password"
              style={{ fontFamily: 'ui-monospace, monospace' }}
              placeholder={tokenSet ? t('settings.cfTokenSet') : 'eyJ…'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              // From outside the server refuses a new token (a wrong one would cut this
              // window off), so the field says so instead of letting someone paste one.
              disabled={remote}
              title={remote ? t('settings.cfTokenRemote') : undefined}
            />
            <div className="setting-row__hint">{remote ? t('settings.cfTokenRemote') : t('settings.cfTokenHint')}</div>
          </>
        )}
      </Field>

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBlockStart: '0.6rem' }}>
        <button
          className="btn btn--primary"
          disabled={save.isPending}
          onClick={() =>
            save.mutate({
              domain: domainEdited ? domain.trim() : undefined,
              token: token.trim() || undefined,
            })
          }
        >
          <Check size={15} /> {save.isPending ? t('settings.cfSaving') : t('settings.cfSave')}
        </button>
        {cf.hasToken && (
          <button className="btn" disabled={clear.isPending} onClick={() => (remote ? setCutOff('clear') : clear.mutate())}>
            <Trash2 size={15} /> {t('settings.cfClear')}
          </button>
        )}
      </div>

      {/* Managing OpenMasjidOS itself from outside — a much bigger step than sharing
          an app, so it says what it means and refuses until two-step sign-in exists.
          `remoteAdminActive` rather than the switch: the two disagree when the second
          factor is removed, and the screen must not claim the dashboard is published
          when the platform has already closed it. */}
      <div style={{ marginBlockStart: '0.9rem', borderBlockStart: '1px solid var(--color-border)', paddingBlockStart: '0.8rem' }}>
        <div className="setting-row">
          <div className="setting-row__text">
            <div className="setting-row__title" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
              <StatusDot online={cf.remoteAdmin ? cf.remoteAdminActive : undefined} />
              {t('settings.cfRemoteAdmin')}
            </div>
            <div className="setting-row__hint">
              {/* Switched on, then two-step sign-in turned off: say THAT, rather than
                  "set it up first" to someone who had it on a moment ago. The button to
                  set it up again is below either way. */}
              {cf.remoteAdmin && cf.remoteAdminBlocked === 'no-two-factor'
                ? t('settings.cfRemoteAdminStalled')
                : cf.remoteAdminBlocked === 'no-two-factor'
                  ? t('settings.cfRemoteAdminNeeds2fa')
                  : cf.remoteAdminBlocked === 'no-tunnel'
                    ? t('settings.cfRemoteAdminNeedsTunnel')
                    : t('settings.cfRemoteAdminHint')}
            </div>
          </div>
          <Toggle
            checked={cf.remoteAdmin}
            disabled={setRemoteAdmin.isPending || (!cf.remoteAdmin && cf.remoteAdminBlocked !== null)}
            onChange={(v) =>
              v ? setRemoteAdminAsk(true) : remote ? setCutOff('remoteAdmin') : setRemoteAdmin.mutate({ enabled: false })
            }
            label={t('settings.cfRemoteAdmin')}
          />
        </div>
        {cf.remoteAdminBlocked === 'no-two-factor' && (
          <NavLink to="/settings/account" className="btn" style={{ marginBlockStart: '0.5rem' }}>
            <ShieldCheck size={15} /> {t('settings.cfRemoteAdminSetUp2fa')}
          </NavLink>
        )}
        {cf.remoteAdminActive && cf.domain && (
          <p className="setting-row__hint" style={{ marginBlockStart: '0.5rem' }}>
            {t('settings.cfRemoteAdminAt', { url: `https://${cf.domain}/` })}
          </p>
        )}
      </div>

      {/* Which apps are shared, and where. This is the per-app consent switch — it
          lives OUTSIDE the collapsed setup guide on purpose: an admin who declined
          (or never saw) the question at install has to be able to find it here, and
          a control hidden behind "How to set this up" is a control nobody finds. */}
      {(routes.data?.apps.length ?? 0) > 0 && (
        <div style={{ marginBlockStart: '0.9rem', borderBlockStart: '1px solid var(--color-border)', paddingBlockStart: '0.8rem' }}>
          <div className="setting-row__title" style={{ marginBlockEnd: '0.3rem' }}>{t('settings.cfRoutesTitle')}</div>
          <div style={{ overflowX: 'auto' }}>
            <table className="cf-routes" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ textAlign: 'start', color: 'var(--color-ink-muted)' }}>
                  <th style={{ textAlign: 'start', paddingBlock: '0.25rem', paddingInlineEnd: '0.6rem' }}>{t('settings.cfColApp')}</th>
                  <th style={{ textAlign: 'start', paddingBlock: '0.25rem', paddingInlineEnd: '0.6rem' }}>{t('settings.cfColShared')}</th>
                  <th style={{ textAlign: 'start', padding: '0.25rem 0' }}>{t('settings.cfColUrl')}</th>
                </tr>
              </thead>
              <tbody>
                {routes.data?.apps.map((r) => (
                  <tr key={r.id} style={{ borderBlockStart: '1px solid var(--color-border)' }}>
                    <td style={{ paddingBlock: '0.3rem', paddingInlineEnd: '0.6rem' }}>{r.name}</td>
                    <td style={{ paddingBlock: '0.3rem', paddingInlineEnd: '0.6rem' }}>
                      <Toggle
                        checked={r.exposed}
                        onChange={(v) => setExposed.mutate({ id: r.id, exposed: v })}
                        label={`${r.name} — ${t('settings.cfColShared')}`}
                      />
                    </td>
                    <td style={{ padding: '0.3rem 0', fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>
                      {r.exposed ? (
                        <>
                          https://{routes.data?.host || t('settings.cfHostUnset')}/
                          <input
                            className="input glass-inset"
                            style={{ width: '7rem', padding: '0.12rem 0.4rem', fontFamily: 'ui-monospace, monospace' }}
                            defaultValue={r.path.replace(/^\//, '')}
                            aria-label={`${r.name} — ${t('settings.cfColPath')}`}
                            // The box always ends up saying what is stored: the address as
                            // the server tidied it, or the old one back after a refusal. An
                            // emptied box asks for the default (the app's own name).
                            onBlur={(e) => {
                              const box = e.currentTarget;
                              const stored = r.path.replace(/^\//, '');
                              const v = box.value.trim();
                              if (v === stored) return;
                              setPath.mutate(
                                { id: r.id, path: v },
                                {
                                  onSuccess: (res) => { box.value = res.path.replace(/^\//, ''); },
                                  onError: () => { box.value = stored; },
                                },
                              );
                            }}
                          />
                        </>
                      ) : (
                        // A sentence, not an address: it wraps, in the body face. The cell's
                        // nowrap monospace is for the address branch above, and this text
                        // under it forced the whole table to scroll sideways on a phone.
                        <span style={{ color: 'var(--color-ink-muted)', fontFamily: 'var(--font-sans)', whiteSpace: 'normal' }}>
                          {t('settings.cfNotShared')}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="setting-row__hint" style={{ marginBlockStart: '0.4rem' }}>{t('settings.cfRoutesHint')}</div>
        </div>
      )}

      {/* Guided, step-by-step setup with the exact Cloudflare fields. */}
      <details className="cf-guide" style={{ marginBlockStart: '0.9rem', borderBlockStart: '1px solid var(--color-border)', paddingBlockStart: '0.8rem' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{t('settings.cfGuideTitle')}</summary>
        <ol style={{ margin: '0.6rem 0 0', paddingInlineStart: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.6rem', lineHeight: 1.55, color: 'var(--color-ink)' }}>
          <li>
            {t('settings.cfStep1')}{' '}
            <a href="https://one.dash.cloudflare.com/" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)', whiteSpace: 'nowrap' }}>
              Cloudflare Zero Trust <ExternalLink size={12} style={{ verticalAlign: 'middle' }} />
            </a>{' '}
            {t('settings.cfStep1b')}
          </li>
          <li>{t('settings.cfStep2')}</li>
          <li>
            {t('settings.cfStep3')}
            <ul style={{ margin: '0.35rem 0 0', paddingInlineStart: '1.1rem', color: 'var(--color-ink-muted)' }}>
              <li>{t('settings.cfStep3Host')} <code>{routes.data?.host || domain || t('settings.cfHostnameUnset')}</code></li>
              <li>{t('settings.cfStep3Service', { port: routes.data?.ingressPort ?? 80 })}</li>
            </ul>
          </li>
          <li>{t('settings.cfStep4')}</li>
        </ol>

        <p
          className="setting-row__hint"
          style={{ marginBlockStart: '0.5rem', color: 'var(--color-gold, #F59E0B)', fontWeight: 600 }}
        >
          {t('settings.cfHttpWarn', { port: routes.data?.ingressPort ?? 80 })}
        </p>

      </details>
      <TunnelRefusals port={routes.data?.ingressPort ?? 80} />

      {/* From outside: turning remote access off, managing from outside off, or removing
          the tunnel ends this window's connection, and only the masjid can undo it. */}
      <ConfirmDialog
        open={cutOff !== null}
        onClose={() => setCutOff(null)}
        onConfirm={() =>
          cutOff === 'tunnel'
            ? setEnabled.mutate({ enabled: false })
            : cutOff === 'remoteAdmin'
              ? setRemoteAdmin.mutate({ enabled: false })
              : clear.mutate()
        }
        title={
          cutOff === 'tunnel'
            ? t('settings.cfCutOffTunnelTitle')
            : cutOff === 'remoteAdmin'
              ? t('settings.cfCutOffAdminTitle')
              : t('settings.cfCutOffClearTitle')
        }
        body={
          cutOff === 'tunnel'
            ? t('settings.cfCutOffTunnelBody')
            : cutOff === 'remoteAdmin'
              ? t('settings.cfCutOffAdminBody')
              : t('settings.cfCutOffClearBody')
        }
        cost={t('settings.cfCutOffCost')}
        confirmLabel={cutOff === 'clear' ? t('settings.cfClear') : t('common.turnOff')}
        pending={setEnabled.isPending || setRemoteAdmin.isPending || clear.isPending}
      />

      {/* Turning remote administration ON. A dialog rather than a toggle that just
          fires, because the effect is outside the building: after this, the
          masjid's sign-in page answers to anyone on the internet who knows the
          address. It says that plainly, and it says what two-step sign-in is
          actually protecting, rather than listing reassurances. */}
      <Modal
        open={remoteAdminAsk}
        onClose={() => setRemoteAdminAsk(false)}
        title={t('settings.cfRemoteAdminAskTitle')}
      >
        <p>
          {t('settings.cfRemoteAdminAskBody', {
            url: cf.domain ? `https://${cf.domain}/` : t('settings.cfRemoteAdminYourAddress'),
          })}
        </p>
        <ul style={{ margin: '0.85rem 0', paddingInlineStart: '1.1rem', display: 'grid', gap: '0.4rem' }}>
          <li>{t('settings.cfRemoteAdminAsk1')}</li>
          <li>{t('settings.cfRemoteAdminAsk2')}</li>
          <li>{t('settings.cfRemoteAdminAsk3')}</li>
        </ul>
        <p className="setting-row__hint">{t('settings.cfRemoteAdminAskLan')}</p>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBlockStart: '1rem' }}>
          <button
            className="btn btn--primary"
            disabled={setRemoteAdmin.isPending}
            onClick={() => setRemoteAdmin.mutate({ enabled: true })}
          >
            <Globe size={15} />{' '}
            {setRemoteAdmin.isPending ? t('common.working') : t('settings.cfRemoteAdminAskConfirm')}
          </button>
          <button className="btn" onClick={() => setRemoteAdminAsk(false)}>{t('common.cancel')}</button>
        </div>
      </Modal>
    </section>
  );
}
