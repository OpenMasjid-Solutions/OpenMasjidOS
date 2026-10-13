// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image as ImageIcon } from 'lucide-react';
import { getCsrf } from '../../lib/session';
import { usePrefs, prefsStore, ACCENTS, WALLPAPERS } from '../../lib/prefs';
import { Toggle } from '../../components/Toggle';
import { useToast } from '../../components/ToastProvider';
import { cn } from '../../lib/cn';
import { errorText, ShownError } from '../../lib/errors';

// IANA zones for the clock picker, when the browser exposes them.
const TIMEZONES: string[] = (() => {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    return fn ? fn('timeZone') : [];
  } catch {
    return [];
  }
})();

/** Masjid logo upload — reused across the masjid's outbound emails (alerts +
 *  receipts an app sends) and notification-webhook avatars. Presentation, not
 *  masjid/prayer config (that lives in apps). */
function BrandingPanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [present, setPresent] = useState(false);
  const [ver, setVer] = useState(0); // cache-buster so a replace/remove reloads the preview

  async function upload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/branding/logo', {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-omos-csrf': getCsrf() },
        body: fd,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new ShownError(body.error || t('errors.generic'));
      }
      setVer((v) => v + 1);
      setPresent(true);
      toast(t('settings.logoSaved'), 'success');
    } catch (e) {
      toast(errorText(e, t('errors.generic')), 'error');
    } finally {
      setUploading(false);
    }
  }

  async function remove() {
    try {
      const res = await fetch('/api/branding/logo', {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'x-omos-csrf': getCsrf() },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new ShownError(body.error || t('errors.generic'));
      }
      setVer((v) => v + 1);
      setPresent(false);
    } catch (e) {
      toast(errorText(e, t('errors.generic')), 'error');
    }
  }

  return (
    <section className="glass-raised panel">
      <h2 className="panel-title">{t('settings.logo')}</h2>
      <p className="setting-row__hint" style={{ marginBlockEnd: '0.6rem' }}>{t('settings.logoHint')}</p>
      <div className="setting-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem' }}>
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 12,
              display: 'grid',
              placeItems: 'center',
              background: 'rgba(255,255,255,0.9)',
              border: '1px solid var(--color-border, rgba(255,255,255,0.1))',
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            {/* onError hides the img + Remove button when no logo is set (404). */}
            <img
              src={`/api/public/logo?v=${ver}`}
              alt=""
              style={{ maxWidth: '100%', maxHeight: '100%', display: present ? 'block' : 'none', padding: 6 }}
              onLoad={() => setPresent(true)}
              onError={() => setPresent(false)}
            />
            {!present && <ImageIcon size={22} style={{ opacity: 0.4 }} />}
          </div>
          <div className="setting-row__text">
            <div className="setting-row__title">{present ? t('settings.logoSet') : t('settings.logoNone')}</div>
            <div className="setting-row__hint">{t('settings.logoFormats')}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = '';
            }}
          />
          <button className="btn btn--sm" disabled={uploading} onClick={() => inputRef.current?.click()}>
            {uploading ? t('settings.logoUploading') : present ? t('settings.logoReplace') : t('settings.logoUpload')}
          </button>
          {present && (
            <button className="btn btn--sm" onClick={() => void remove()} disabled={uploading}>
              {t('settings.logoRemove')}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/** Settings → Appearance: how the dashboard looks, and the masjid logo. */
export function AppearancePane() {
  const { t } = useTranslation();
  const prefs = usePrefs();

  const themes: Array<{ id: 'dark' | 'light' | 'system'; label: string }> = [
    { id: 'dark', label: t('settings.themeDark') },
    { id: 'light', label: t('settings.themeLight') },
    { id: 'system', label: t('settings.themeSystem') },
  ];

  return (
    <>
      {/* Appearance */}
      <section className="glass-raised panel">
        <h2 className="panel-title">{t('settings.appearance')}</h2>

        <div className="setting-row">
          <div className="setting-row__text"><div className="setting-row__title">{t('settings.theme')}</div></div>
          <div className="segmented glass-inset">
            {themes.map((th) => (
              <button
                key={th.id}
                className={cn(prefs.theme === th.id && 'is-active')}
                aria-pressed={prefs.theme === th.id}
                onClick={() => prefsStore.patch({ theme: th.id })}
              >
                {th.label}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-row__text"><div className="setting-row__title">{t('settings.accent')}</div></div>
          <div className="swatch-row">
            {Object.entries(ACCENTS).map(([id, a]) => (
              <button
                key={id}
                className={cn('swatch', prefs.accent === id && 'is-active')}
                style={{ background: a.primary }}
                aria-label={t(a.label)}
                aria-pressed={prefs.accent === id}
                onClick={() => prefsStore.patch({ accent: id })}
              />
            ))}
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-row__text"><div className="setting-row__title">{t('settings.wallpaper')}</div></div>
          <div className="wallpaper-row">
            {Object.entries(WALLPAPERS).map(([id, w]) => (
              <button
                key={id}
                className={cn('wallpaper', !prefs.wallpaperImage && prefs.wallpaper === id && 'is-active')}
                style={{ background: w.preview }}
                aria-label={t(w.label)}
                aria-pressed={!prefs.wallpaperImage && prefs.wallpaper === id}
                onClick={() => prefsStore.patch({ wallpaper: id, wallpaperImage: '' })}
              />
            ))}
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-row__text">
            <div className="setting-row__title">{t('settings.wallpaperImage')}</div>
            <div className="setting-row__hint">{t('settings.wallpaperImageHint')}</div>
          </div>
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <input
              className="input glass-inset"
              style={{ maxWidth: '16rem' }}
              placeholder="https://…/wallpaper.jpg"
              aria-label={t('settings.wallpaperImage')}
              value={prefs.wallpaperImage}
              onChange={(e) => prefsStore.patch({ wallpaperImage: e.target.value.trim() })}
            />
            {prefs.wallpaperImage && (
              <button className="btn btn--sm" onClick={() => prefsStore.patch({ wallpaperImage: '' })}>
                {t('common.cancel')}
              </button>
            )}
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-row__text">
            <div className="setting-row__title">{t('settings.dashboardName')}</div>
            <div className="setting-row__hint">{t('settings.dashboardNameHint')}</div>
          </div>
          <input
            className="input glass-inset"
            style={{ maxWidth: '14rem' }}
            placeholder={t('settings.dashboardNamePlaceholder')}
            aria-label={t('settings.dashboardName')}
            value={prefs.dashboardName}
            onChange={(e) => prefsStore.patch({ dashboardName: e.target.value })}
          />
        </div>

        <div className="setting-row">
          <div className="setting-row__text"><div className="setting-row__title">{t('settings.showSplash')}</div></div>
          <Toggle checked={prefs.showSplash} onChange={(v) => prefsStore.patch({ showSplash: v })} label={t('settings.showSplash')} />
        </div>

        <div className="setting-row">
          <div className="setting-row__text"><div className="setting-row__title">{t('settings.showClock')}</div></div>
          <Toggle checked={prefs.showClock} onChange={(v) => prefsStore.patch({ showClock: v })} label={t('settings.showClock')} />
        </div>

        {prefs.showClock && (
          <>
            <div className="setting-row">
              <div className="setting-row__text"><div className="setting-row__title">{t('settings.clockFormat')}</div></div>
              <div className="segmented glass-inset">
                <button
                  className={cn(!prefs.clock24h && 'is-active')}
                  aria-pressed={!prefs.clock24h}
                  onClick={() => prefsStore.patch({ clock24h: false })}
                >
                  {t('settings.clock12h')}
                </button>
                <button
                  className={cn(prefs.clock24h && 'is-active')}
                  aria-pressed={prefs.clock24h}
                  onClick={() => prefsStore.patch({ clock24h: true })}
                >
                  {t('settings.clock24h')}
                </button>
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-row__text"><div className="setting-row__title">{t('settings.timezone')}</div></div>
              <select
                className="select glass-inset"
                style={{ maxWidth: '16rem' }}
                aria-label={t('settings.timezone')}
                value={prefs.timezone}
                onChange={(e) => prefsStore.patch({ timezone: e.target.value })}
              >
                <option value="">{t('settings.timezoneAuto')}</option>
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </div>
          </>
        )}
      </section>

      {/* Masjid logo (branding for emails + webhooks). Lives with Appearance because
          that is what an admin is thinking about when they look for it. */}
      <BrandingPanel />
    </>
  );
}
