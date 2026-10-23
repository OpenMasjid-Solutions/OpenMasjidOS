// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
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
  https?: boolean;
  openPort?: number | null;
  running: boolean;
  /** Its path through the tunnel, and whether it is shared online — from outside,
   *  only a shared app's icon can be loaded (lib/app-url.ts). */
  path?: string;
  exposed?: boolean;
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
