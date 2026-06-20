/**
 * App tile icon. Prefers an explicit icon, else pulls the running app's favicon
 * from its own port, else falls back to a colourful initial.
 */
import { useState } from 'react';
import { appFaviconUrl, appInitial, appColor } from '../lib/apps';

interface IconApp {
  id: string;
  name: string;
  icon?: string;
  ports: number[];
  running: boolean;
}

export function AppIcon({ app, size = 48 }: { app: IconApp; size?: number }) {
  const [failed, setFailed] = useState(false);
  const favicon = !app.icon && app.running ? appFaviconUrl(app) : null;
  const src = app.icon ?? (failed ? null : favicon);

  return (
    <div
      className="app-icon"
      style={{
        width: size,
        height: size,
        background: src ? 'var(--color-surface-overlay)' : appColor(app.id),
      }}
    >
      {src ? <img src={src} alt="" onError={() => setFailed(true)} /> : appInitial(app.name)}
    </div>
  );
}
