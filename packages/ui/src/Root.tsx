// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Auth gate + routing. auth.me decides: first-run setup, login, or the shell.
 * Because the shell only renders when authenticated, every route is guarded.
 */
import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import { trpc } from './lib/trpc';
import { getCsrf } from './lib/session';
import { AuthScreen } from './components/AuthScreen';
import { AppShell } from './components/AppShell';
import { Splash } from './components/Splash';
import { Dashboard } from './routes/Dashboard';

// The dashboard is the landing page, so it stays in the main bundle. The rest
// load on demand, splitting them (and their deps) out of the initial download.
const Store = lazy(() => import('./routes/Store').then((m) => ({ default: m.Store })));
const StoreCustom = lazy(() => import('./routes/StoreCustom').then((m) => ({ default: m.StoreCustom })));
const AppDetail = lazy(() => import('./routes/AppDetail').then((m) => ({ default: m.AppDetail })));
const Files = lazy(() => import('./routes/Files').then((m) => ({ default: m.Files })));
const Settings = lazy(() => import('./routes/Settings').then((m) => ({ default: m.Settings })));
const NotFound = lazy(() => import('./routes/NotFound').then((m) => ({ default: m.NotFound })));

export function Root() {
  const me = trpc.auth.me.useQuery(undefined, { retry: false });
  const utils = trpc.useUtils();
  const reload = () => utils.auth.me.invalidate();

  if (me.isLoading) return <Splash />;

  const data = me.data;
  // Also require the dashboard key: a valid cookie without it (e.g. storage was
  // cleared) can't make authenticated calls, so send them through login to mint
  // a fresh key rather than into a shell whose every request would fail.
  if (!data || data.setupRequired || !data.authenticated || !getCsrf()) {
    return <AuthScreen setupRequired={data?.setupRequired ?? true} onAuthed={reload} />;
  }

  return (
    <AppShell onSignedOut={reload}>
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
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
