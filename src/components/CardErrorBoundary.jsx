import { Component } from 'react';

// Granular error boundary for a single card / detail panel. Without this, one malformed
// order (e.g. an object rendered as a React child → React #31) throws during render, the
// TOP-LEVEL ErrorBoundary swaps the whole app for the "App Error" screen, and that unmounts
// realtime + print orchestration until the app is force-quit. Wrapping each order card means a
// bad order shows a small fallback instead of taking the entire surface (and printing) down.
export default class CardErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err, info) { console.warn('[CardErrorBoundary]', this.props.label || '', err?.message || err, info?.componentStack); }
  render() {
    if (this.state.failed) {
      return this.props.fallback ?? (
        <div style={{ padding: 12, borderRadius: 10, background: 'var(--red-d, #fee2e2)', border: '1px solid var(--red-b, #fca5a5)', color: 'var(--red, #b91c1c)', fontSize: 12, fontWeight: 700 }}>
          {this.props.label || 'This item'} couldn’t be displayed.
        </div>
      );
    }
    return this.props.children;
  }
}
