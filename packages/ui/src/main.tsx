import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@xterm/xterm/css/xterm.css';
import './index.css';
import './styles/tokens.css';
import './styles/glass.css';
import './styles/app.css';
import './lib/i18n';
import { prefsStore } from './lib/prefs';
import { App } from './App';

// Apply saved theme/accent/wallpaper/language before first paint.
prefsStore.hydrate();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
