/**
 * Auth gate + routing. auth.me decides: first-run setup, login, or the shell.
 * Because the shell only renders when authenticated, every route is guarded.
 */
import { Routes, Route } from 'react-router-dom';
import { trpc } from './lib/trpc';
import { getCsrf } from './lib/session';
import { AuthScreen } from './components/AuthScreen';
import { AppShell } from './components/AppShell';
import { Splash } from './components/Splash';
import { Dashboard } from './routes/Dashboard';
import { Store } from './routes/Store';
import { StoreCustom } from './routes/StoreCustom';
import { AppDetail } from './routes/AppDetail';
import { Files } from './routes/Files';
import { Settings } from './routes/Settings';
import { NotFound } from './routes/NotFound';

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
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/store" element={<Store />} />
        <Route path="/store/custom" element={<StoreCustom />} />
        <Route path="/apps/:id" element={<AppDetail />} />
        <Route path="/files" element={<Files />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AppShell>
  );
}
