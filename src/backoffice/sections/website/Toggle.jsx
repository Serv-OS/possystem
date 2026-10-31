// src/backoffice/sections/website/Toggle.jsx
// The on/off switch used on the Overview's "Connected to your ServOS" card. Its own file so
// ui.js stays constants only (fast refresh rule).
import { W } from './ui.js';

export default function Toggle({ on, onChange, label }) {
  return (
    <button type="button" aria-label={label} aria-pressed={!!on} style={W.toggle(on)} onClick={() => onChange?.(!on)}>
      <span style={W.knob(on)} />
    </button>
  );
}
