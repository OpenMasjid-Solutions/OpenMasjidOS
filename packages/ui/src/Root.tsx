// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Auth gate + routing. auth.me decides: first-run setup, login, or the shell.
 * Because the shell only renders when authenticated, every route is guarded.
 */
import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { trpc } from './lib/trpc';
import { getCsrf } from './lib/session';
import { errorText } from './lib/errors';
import { setRemoteOpener, setRemoteSession } from './lib/apps';
import { useToast } from './components/ToastProvider';
import { AuthScreen } from './components/AuthScreen';
import { AppShell } from './components/AppShell';
import { Splash } from './components/Splash';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MasjidMark } from './components/Glyphs';
import { Dashboard } from './routes/Dashboard';

// The dashboard is the landing page, so it stays in the main bundle. The rest
// load on demand, splitting them (and their deps) out of the initial download.
const Store = lazy(() => import('./routes/Store').then((m) => ({ default: m.Store })));
const StoreCustom = lazy(() => import('./routes/StoreCustom').then((m) => ({ default: m.StoreCustom })));
const AppDetail = lazy(() => import('./routes/AppDetail').then((m) => ({ default: m.AppDetail })));
const Files = lazy(() => import('./routes/Files').then((m) => ({ default: m.Files })));
const Settings = lazy(() => import('./routes/Settings').then((m) => ({ default: m.Settings })));
const NotFound = lazy(() => import('./routes/NotFound').then((m) => ({ default: m.NotFound })));
// The primitive gallery. Lazy like every other non-Dashboard route, so it costs
// nothing on the path a masjid actually uses.
const DesignSystem = lazy(() => import('./routes/DesignSystem').then((m) => ({ default: m.DesignSystem })));

export function Root() {
  /**
   * Re-checked whenever the admin comes back to this tab, and every minute while
   * they are on it. It used to be fetched ONCE, on mount — `refetchOnWindowFocus`
   * is off globally (App.tsx) — so a tab left open went on drawing the signed-in
   * shell long after the server had forgotten the session. Every Open button on it
   * then handed the app a dead cookie; the app said "sign in through your
   * dashboard"; the admin came back here, saw themselves signed in, pressed Open
   * again, and got the same answer. A loop with no way out from inside it.
   *
   * `'always'`, not `true`. `true` honours the global 30s `staleTime`, so coming
   * back within half a minute — which is exactly what someone does after an app
   * tells them to "press Open from the dashboard" — would skip the check and send
   * the same dead cookie again. A refetch with data already present does not show
   * the splash or remount the sign-in screen, so a two-step sign-in in progress
   * (with the admin away in their authenticator app) keeps its place.
   */
  const me = trpc.auth.me.useQuery(undefined, {
    // A blip — the core restarting, a 502 through Cloudflare — must not end the first
    // check: with no answer at all, the screen below took it for "no account yet" and
    // showed an existing install the create-your-admin-account page.
    retry: 2,
    refetchOnWindowFocus: 'always',
    refetchInterval: 60_000,
  });
  const utils = trpc.useUtils();
  const reload = () => utils.auth.me.invalidate();
  const { toast } = useToast();
  const { t } = useTranslation();
  const location = useLocation();

  if (me.isLoading) return <Splash />;
  if (!me.data && me.isError) {
    return <Unreachable retrying={me.isFetching} onRetry={() => void me.refetch()} />;
  }

  const data = me.data;
  // Also require the dashboard key: a valid cookie without it (e.g. storage was
  // cleared) can't make authenticated calls, so send them through login to mint
  // a fresh key rather than into a shell whose every request would fail.
  if (!data || data.setupRequired || !data.authenticated || !getCsrf()) {
    return <AuthScreen setupRequired={data?.setupRequired ?? true} onAuthed={reload} />;
  }

  // Before the shell renders, so no Open button can be pressed with the wrong idea of
  // where apps are: from outside, they open on the apps' own hostname, through a
  // one-use address the platform hands out (lib/apps.ts says why).
  setRemoteSession(data.remote === true, data.appOrigin ?? null);
  setRemoteOpener(
    async (id) => (await utils.client.apps.openRemote.mutate({ id })).url,
    // Our own server's message only when it IS one (it carries a tRPC code). Anything
    // else is the transport's — "Unable to transform response from server" for a
    // closed door, a JSON parse error for Cloudflare's 502 page while the core
    // restarts — and is no use to an admin.
    (err) => toast(errorText(err, t('errors.openApp')), 'error'),
  );

  return (
    <AppShell onSignedOut={reload}>
      {/* A page's code is fetched when it is first opened. After an update the old
          file is gone, and that failure used to blank the whole dashboard; now it is
          caught here, for that page alone, and says what to do. Keyed on the page, so
          going to another page tries again — and every Settings section is ONE page:
          keyed on the full address, each section click remounted Settings, and with it
          the restore upload, a restore's progress and the update dialog (§13.5). */}
      <ErrorBoundary
        key={location.pathname.startsWith('/settings') ? '/settings' : location.pathname}
        fallback={<PageLoadFailed />}
      >
        <Suspense fallback={<Splash />}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/store" element={<Store />} />
            <Route path="/store/custom" element={<StoreCustom />} />
            <Route path="/apps/:id" element={<AppDetail />} />
            <Route path="/files" element={<Files />} />
            <Route path="/settings" element={<Settings />} />
            {/* Each settings section has its own address, so the dashboard, an app's page
                and an error message can all send someone straight to the right place
                instead of to the top of a long page. */}
            <Route path="/settings/:section" element={<Settings />} />
            <Route path="/design-system" element={<DesignSystem />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </AppShell>
  );
}

/** A page whose code could not be fetched — usually a dashboard updated since this tab loaded. */
function PageLoadFailed() {
  const { t } = useTranslation();
  return (
    <div className="glass panel">
      <div className="empty-state">
        <p>{t('errors.pageLoad')}</p>
        <button className="btn btn--primary" style={{ marginBlockStart: '1rem' }} onClick={() => window.location.reload()}>
          {t('errors.reload')}
        </button>
      </div>
    </div>
  );
}

/**
 * The first sign-in check got no answer at all. Said as it is, and retried by itself —
 * never the sign-in or first-run screen, which would be a guess about an install this
 * page has not heard from.
 */
function Unreachable({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  const { t } = useTranslation();
  // Asks again every few seconds, so the page carries on by itself the moment the
  // server answers — the minute-long check above is for a page that is already up.
  useEffect(() => {
    const id = setInterval(onRetry, 5_000);
    return () => clearInterval(id);
  }, [onRetry]);
  return (
    <div className="auth-wrap">
      <div className="auth-card glass-raised" role="status">
        <div className="auth-logo">
          <MasjidMark size={48} />
        </div>
        <h1 className="page-title" style={{ textAlign: 'center', fontSize: '1.5rem' }}>
          {t('auth.unreachableTitle')}
        </h1>
        <p className="page-sub" style={{ textAlign: 'center', marginBlockEnd: '1.25rem' }}>
          {t('auth.unreachableBody')}
        </p>
        <button className="btn btn--primary btn--block" disabled={retrying} onClick={onRetry}>
          {retrying ? t('auth.working') : t('auth.retryNow')}
        </button>
      </div>
    </div>
  );
}
