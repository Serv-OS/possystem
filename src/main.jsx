// Runtime APIs missing from the PAX terminal's Chrome 80 WebView. These are
// FUNCTIONS, not syntax, so the build target cannot supply them — without these
// the app parses fine and then throws the first time a stock/PO screen clones a
// draft. Cheap, standards-shaped, and inert on modern browsers.
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
}
if (!Array.prototype.at) {
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(Array.prototype, 'at', {
    value(n) { n = Math.trunc(n) || 0; if (n < 0) n += this.length; return (n < 0 || n >= this.length) ? undefined : this[n]; },
    writable: true, configurable: true,
  });
}
if (!String.prototype.at) {
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(String.prototype, 'at', {
    value(n) { n = Math.trunc(n) || 0; if (n < 0) n += this.length; return (n < 0 || n >= this.length) ? undefined : this[n]; },
    writable: true, configurable: true,
  });
}

import { StrictMode, Component } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import UpdateGuard from './components/UpdateGuard.jsx'

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('App crashed:', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{padding:40,fontFamily:'monospace',background:'#fff',color:'#dc2626'}}>
          <h2>App Error</h2>
          <pre style={{whiteSpace:'pre-wrap',fontSize:12}}>{String(this.state.error)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* Mounted OUTSIDE the ErrorBoundary on purpose: if a bad deploy makes App throw, the guard
        keeps polling and auto-updates the device once a fix ships — self-healing a bricked build. */}
    <UpdateGuard />
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
