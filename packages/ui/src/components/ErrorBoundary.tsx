// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Minimal error boundary. Used to wrap window content (terminals, logs, file
 * viewers) so a failure in one window — including a failed lazy-chunk load —
 * shows a tidy message instead of taking down the whole dashboard.
 */
import { Component, type ReactNode } from 'react';
import i18n from '../lib/i18n';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        this.props.fallback ?? (
          <div className="hint" style={{ padding: '1rem' }}>{i18n.t('errors.boundary')}</div>
        )
      );
    }
    return this.props.children;
  }
}
