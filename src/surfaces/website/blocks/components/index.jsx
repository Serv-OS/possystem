// src/surfaces/website/blocks/components/index.jsx
// Every block type → its React component. The public site's BlockRenderer and the Back Office
// Puck config both read this map, so a block looks the same in the editor and on the live site.

import { Hero } from './HeroBlock.jsx';
import { LiveMenu, Specials } from './MenuBlocks.jsx';
import { OrderBar, OrderEmbed, LoyaltyJoin, GiftCards, BookTable, Waitlist } from './EmbedBlocks.jsx';
import { Hours, FindUs } from './PlaceBlocks.jsx';
import { Text, Columns, Gallery, Button, FAQ, Instagram, Divider, Spacer, CustomHtml, Reviews, BlogList } from './ContentBlocks.jsx';
import { Row } from './LayoutBlocks.jsx';
import { BLOCK_REGISTRY } from '../nested.js';

export const COMPONENTS = Object.freeze({
  Hero, OrderBar, LiveMenu, Specials, OrderEmbed, LoyaltyJoin, GiftCards, BookTable, Waitlist, Hours, FindUs, Reviews, BlogList,
  Text, Columns, Row, Gallery, Button, FAQ, Instagram, Divider, Spacer, CustomHtml,
});

// 5.12.9: a Row paints the blocks in its columns through this registry (nested.js), filled here so
// LayoutBlocks.jsx never imports this file back (no import cycle).
BLOCK_REGISTRY.components = COMPONENTS;
