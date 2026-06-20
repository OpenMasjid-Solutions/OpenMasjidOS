/**
 * Minimal error boundary. Used to wrap window content (terminals, logs, file
 * viewers) so a failure in one window — including a failed lazy-chunk load —
 * shows a tidy message instead of taking down the whole dashboard.
 */
import { Component, type ReactNode } from 'react';

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
          <div className="hint" style={{ padding: '1rem' }}>Something went wrong here. Try closing and reopening this window.</div>
        )
      );
    }
    return this.props.children;
  }
}
