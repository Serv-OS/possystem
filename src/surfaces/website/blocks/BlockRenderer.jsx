// src/surfaces/website/blocks/BlockRenderer.jsx
//
// Renders a Puck layout ({root, content:[{type, props}]}) with our own components, not Puck's
// <Render>, so Puck stays out of the public bundle (ARCHITECTURE.md section 6). Props are
// normalised against the schema first (missing keys defaulted, wrong types replaced), the channel
// switches hide blocks the venue turned off, and a component that throws renders nothing: a
// customer page never crashes because of one block.

import { Component } from 'react';
import { layoutBlocks } from './schema.js';
import { blockVisible } from '../routes.js';
import { COMPONENTS } from './components/index.jsx';

class BlockBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) { if (typeof console !== 'undefined') console.warn('[website] block failed:', this.props.type, err && err.message); }
  render() { return this.state.failed ? null : this.props.children; }
}

export function BlockRenderer({ layout, settings, firstHeroIsH1 = true }) {
  const blocks = layoutBlocks(layout);
  let heroSeen = false;
  return blocks.map((b, i) => {
    const Comp = COMPONENTS[b.type];
    if (!Comp || !blockVisible(b, settings)) return null;
    const extra = {};
    if (b.type === 'Hero') { extra.isFirst = firstHeroIsH1 && !heroSeen; heroSeen = true; }
    return (
      <BlockBoundary key={b.props.id || `${b.type}-${i}`} type={b.type}>
        <Comp {...b.props} {...extra} />
      </BlockBoundary>
    );
  });
}
