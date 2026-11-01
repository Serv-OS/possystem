// src/surfaces/website/blocks/nested.js
//
// 5.12.9 Row block plumbing shared by the React components. Plain JS (no component) so fast
// refresh stays happy and nothing here imports the components: LayoutBlocks.jsx renders the
// blocks dropped into a Row's columns through BLOCK_REGISTRY, which components/index.jsx fills
// once the COMPONENTS map exists (a direct import would be a cycle: index → LayoutBlocks → index).
//
// NestedContext is true inside a Row column, so a block's Section wrapper paints
// data-nested="true" exactly like the SSR string renderer (ssr/renderBlocks.js section()).

import { createContext, useContext } from 'react';

export const NestedContext = createContext(false);

/** True when the component is being painted inside a Row column. */
export function useNested() { return useContext(NestedContext) === true; }

/** { components } is set by components/index.jsx; null until then (a Row then renders empty columns). */
export const BLOCK_REGISTRY = { components: null };
