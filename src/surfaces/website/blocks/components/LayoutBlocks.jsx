// src/surfaces/website/blocks/components/LayoutBlocks.jsx
//
// 5.12.9 Row block in React (Peter, 1 Nov: "create columns and rows, set background images and
// colours on rows and columns, drag and drop things into columns"). Same class names, data
// attributes and style variables as the server string renderer (ssr/renderBlocks.js R.Row) via
// rowPlan.js, so React replaces the server markup without a visual jump.
//
// Two shapes of a column prop:
//   on the public site   col1 = [{ type, props }]      rendered here through the block registry
//   in the Puck editor   col1 = Puck's drop zone component (a function): <Col /> paints the zone and
//                        Puck renders the dropped blocks itself (the same components, via puckConfig)
// A Row inside a Row never renders (one level deep; the validator refuses it on save anyway).

import { Component } from 'react';
import { CN } from '../classNames.js';
import { normaliseProps } from '../schema.js';
import { rowPlan } from '../rowPlan.js';
import { blockVisible } from '../../routes.js';
import { useSite } from '../../siteContext.js';
import { NestedContext, useNested, BLOCK_REGISTRY } from '../nested.js';

const cls = (...xs) => xs.filter(Boolean).join(' ');

class NestedBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) { if (typeof console !== 'undefined') console.warn('[website] nested block failed:', this.props.type, err && err.message); }
  render() { return this.state.failed ? null : this.props.children; }
}

/** The blocks dropped into one column, painted with the same components as the page. */
function NestedBlocks({ items }) {
  const site = useSite();
  const settings = (site && site.ctx && site.ctx.settings) || {};
  const list = Array.isArray(items) ? items : [];
  const registry = BLOCK_REGISTRY.components || {};
  return (
    <NestedContext.Provider value={true}>
      {list.map((c, i) => {
        if (!c || typeof c !== 'object' || c.type === 'Row') return null;
        const Comp = registry[c.type];
        if (!Comp) return null;
        const props = normaliseProps(c.type, c.props);
        if (!blockVisible({ type: c.type, props }, settings)) return null;
        return (
          <NestedBoundary key={props.id || `${c.type}-${i}`} type={c.type}>
            <Comp {...props} isFirst={false} />
          </NestedBoundary>
        );
      })}
    </NestedContext.Provider>
  );
}

export function Row(props) {
  const nested = useNested();
  if (nested) return null;
  const plan = rowPlan(props);
  const cols = [];
  for (let i = 1; i <= plan.cols; i++) {
    const slot = props[`col${i}`];
    const bg = plan.colBg[i - 1];
    let content = null;
    if (typeof slot === 'function') { const Col = slot; content = <Col />; }
    else content = <NestedBlocks items={slot} />;
    cols.push(
      <div key={i} className={CN.rowCol} data-col={i} data-bg={bg ? 'true' : 'false'} style={bg ? { '--w-col-bg': bg } : undefined}>{content}</div>,
    );
  }
  return (
    <section
      className={cls(CN.block, CN.row)} data-block="Row" data-id={props.id}
      data-cols={plan.cols} data-full={plan.full ? 'true' : 'false'} data-tone={plan.tone || undefined}
      data-gap={plan.gap} data-pad={plan.pad} data-align={plan.align} data-bg={plan.hasBg ? 'true' : 'false'} data-darken={plan.darken ? 'true' : 'false'}
      style={plan.style}
    >
      <div className={cls(CN.inner, CN.rowGrid)}>{cols}</div>
    </section>
  );
}
