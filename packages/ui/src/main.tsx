// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import React from 'react';
import ReactDOM from 'react-dom/client';
// The whole design system, in the one order that works. Deliberately the SAME
// entry point every other OpenMasjid app imports (`@openmasjid/ui/styles.css`),
// so the path they depend on is exercised by every build of this app rather
// than only by whoever adopts it first.
import './styles/design-system.css';
import './lib/i18n';
import { prefsStore } from './lib/prefs';
import { installCursorFx } from './lib/cursorFx';
import { App } from './App';

// Apply saved theme/accent/wallpaper/language before first paint.
prefsStore.hydrate();
// Pointer-reactive light on glass surfaces.
installCursorFx();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
