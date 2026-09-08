/**
 * Restaurant OS — Voice Order Parser
 * One-shot endpoint that takes a server's spoken transcript + the location's
 * menu, and returns a structured list of items ready to add to the cart.
 *
 * Why a separate endpoint from /api/ai.js?
 *   • api/ai.js is a chat-style AI assistant with permissioned tool use.
 *     This is a single transcript → structured-items parse. Different shape.
 *   • Smaller request: just the menu context the LLM needs to map names.
 *     No order history, sales tools, or full prompt.
 *   • Latency-sensitive: the server is waiting at the table, ~500-1500ms target.
 *   • Token-efficient: ~3-5K tokens per call vs 10K+ for the chat endpoint.
 */

const SYSTEM_PROMPT = `You are a voice-order parser for a restaurant POS system.

A server has just spoken an order at the table. You receive the transcript and
the location's menu — every item is a SELLABLE LEAF (parent variant items like
"Lager" or "Latte" are filtered out before reaching you; you only see the
sellable variants like "Lager — Pint" or "Latte — Large").

Each menu item also carries a list of MODIFIER GROUPS it accepts. Each group
has options with a stable id. When the customer mentions something that maps
to a modifier option (e.g. "with almond milk", "no pickle", "extra cheese",
"medium rare") you MUST return it as a structured mod_picks entry, NOT as a
free-form note. Notes are for things the modifier groups don't cover.

You must call the add_items_to_order tool exactly once.

Decision logic:
1. CONFIDENT MATCH → return the items in the items[] array, leave clarification empty.
2. PARTIAL MATCH (item exists but a size/variant the customer asked for doesn't) →
   set clarification AND populate suggestions[] with the closest 2-5 menu items
   so the server can tap one as a fallback.
3. NO MATCH AT ALL ("we don't sell lattes here") →
   set clarification explaining we don't sell what was asked for AND populate
   suggestions[] with up to 5 menu items the server might want to offer the
   customer as alternatives (similar category, similar product).
4. AMBIGUOUS ("burger" but 3 burgers on the menu) →
   set clarification asking which AND populate suggestions[] with the matching
   options.

Modifier-mapping rules:
- "with almond milk" → find the milk-choice group on the matched item, pick
  the almond option, add { group_id, option_id } to mod_picks.
- "no pickle" / "no onion" → if the item has an "Add or remove" or "Toppings"
  group, return that option_id. If no such group exists for this item, use
  notes (free-form) instead.
- "medium rare" / "well done" → if a cooking-preference instruction group
  exists, prefer option_id; else mod_labels[] (instruction-only).
- Quantity-mode picks ("3 buenos in the box of 3") → set qty on the mod_pick.
- Parent-variant disambiguation ("large latte"): pick the menu item whose
  name contains the size word — variants are SEPARATE items, not modifiers.

General rules:
- Only reference items that exist in the provided menu — never invent items.
- Match against item.name. Names include size / variant.
- NEVER pick a child by partial size match alone — treat unmatched sizes as
  PARTIAL MATCH (case 2) rather than silently substituting.
- Map quantities ("a couple of beers" → 2, "three" → 3, "another" → +1).
- Allergy mentions go in order_note — DO NOT silently swap items.
- Be tolerant of speech-to-text errors: "ling-uine" → "linguine".

Return only the tool call. No prose.`;

const TOOL = {
  name: 'add_items_to_order',
  description: 'Submit the parsed items to add to the order. Always call this exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Confidently-matched line items. Empty array when clarification is needed.',
        items: {
          type: 'object',
          properties: {
            item_id:    { type: 'string',  description: 'The item id from the provided menu.' },
            qty:        { type: 'number',  description: 'Quantity. Must be a positive integer.' },
            mod_picks: {
              type: 'array',
              description: 'Structured modifier picks resolved against the item\'s modifier groups. Use this whenever the customer\'s words map to a real modifier option (e.g. "almond milk" → the almond option in the milk-choice group). PRICING WILL BE APPLIED automatically — these are real chargeable picks, not notes.',
              items: {
                type: 'object',
                properties: {
                  group_id:  { type: 'string', description: 'Modifier group id (e.g. "mgd-milk").' },
                  option_id: { type: 'string', description: 'Option id within that group (e.g. "sub-almond").' },
                  qty:       { type: 'number', description: 'Optional. Used by quantity-mode groups (e.g. 3 of one option in a "Box of 3").' },
                },
                required: ['group_id', 'option_id'],
              },
            },
            mod_labels: { type: 'array', description: 'Free-form labels for cases the modifier groups don\'t cover (instruction-only, no price). Prefer mod_picks when an option exists.', items: { type: 'string' } },
            notes:      { type: 'string', description: 'Item-level free-text notes (e.g. customer-specific requests not in any group).' },
          },
          required: ['item_id', 'qty'],
        },
      },
      suggestions: {
        type: 'array',
        description: 'Closest menu matches when the requested item doesn\'t exist or is ambiguous. Up to 5. Server can tap one to add it as a fallback.',
        items: {
          type: 'object',
          properties: {
            item_id: { type: 'string', description: 'Item id from the provided menu.' },
            reason:  { type: 'string', description: 'Why this is a suggested fallback (e.g. "only size we have", "similar drink").' },
          },
          required: ['item_id'],
        },
      },
      order_note: {
        type: 'string',
        description: 'Whole-order note — used for allergens, table-wide preferences, urgency. Empty if none.',
      },
      clarification: {
        type: 'string',
        description: 'When items[] is empty: explain why and what the server can say to clarify. Empty when items are confidently mapped.',
      },
    },
    required: ['items'],
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'AI not configured' });

  const { transcript, menu, modifierGroups } = req.body || {};
  if (!transcript || typeof transcript !== 'string') {
    return res.status(400).json({ error: 'Missing transcript' });
  }
  if (!Array.isArray(menu) || menu.length === 0) {
    return res.status(400).json({ error: 'Missing menu' });
  }
  const groupsArr = Array.isArray(modifierGroups) ? modifierGroups : [];

  // Filter to SELLABLE LEAVES only. Parent variant items (type === 'variants')
  // exist on the menu as containers — they have price 0 and aren't sold
  // directly; their sellable forms are children with parentId set. If we let
  // Claude see the parent, it sometimes picks the parent ID for "large latte"
  // because the parent name matched, even though the variant child is what
  // the customer wanted. Drop parents here so Claude can only choose among
  // sellable items.
  const ids = new Set(menu.map(m => m.id));
  const sellable = menu.filter(m => {
    const t = m.type || 'simple';
    if (t === 'variants') return false;          // never sell the parent
    if (m.parentId && !ids.has(m.parentId)) {
      // orphaned variant — keep, defensive
      return true;
    }
    return true;
  });
  // Parent-name lookup so we can compose "Heineken — Pint" instead of sending
  // a child with name "Pint". Children store only their own variant label
  // (Pint / Half / Large / etc); without this the parser sees a sea of items
  // named just "Pint" and can't tell beers apart.
  const itemById = new Map(menu.map(m => [m.id, m]));

  // Compact menu representation — only the fields the parser needs. Keeps
  // tokens down so latency stays under ~1.5s. Per-item we surface the assigned
  // modifier-group ids so the LLM knows which groups to consider when the
  // customer mentions an add-on.
  const compactMenu = sellable.slice(0, 250).map(m => {
    const parent = m.parentId ? itemById.get(m.parentId) : null;
    const ownName = m.menuName || m.menu_name || m.name || 'Item';
    const parentName = parent ? (parent.menuName || parent.menu_name || parent.name) : null;
    // If the parent name isn't already part of the child's name, prepend it.
    // Some installs already store children as "Heineken — Pint"; don't double up.
    const composed = (parentName && !ownName.toLowerCase().includes(parentName.toLowerCase()))
      ? `${parentName} — ${ownName}`
      : ownName;
    return {
      id: m.id,
      name: composed,
      cat: m.cat || (Array.isArray(m.cats) ? m.cats[0] : null),
      price: m.price ?? m.pricing?.base ?? 0,
      allergens: m.allergens || [],
      // Inherit the parent's modifier groups when the child doesn't override —
      // milk choice etc are typically defined on the parent "Latte" and apply
      // equally to "Latte — Large" / "Latte — Small".
      mod_groups:
        m.assignedModifierGroups || m.assigned_modifier_groups ||
        parent?.assignedModifierGroups || parent?.assigned_modifier_groups || [],
    };
  });

  // Compact modifier-group representation. Only include groups any sellable
  // item actually references (keeps tokens down on locations with many groups).
  const referencedGroupIds = new Set(
    compactMenu.flatMap(m => m.mod_groups || [])
  );
  const compactGroups = groupsArr
    .filter(g => referencedGroupIds.has(g.id))
    .slice(0, 80)
    .map(g => ({
      id: g.id,
      name: g.name,
      min: g.min ?? 0,
      max: g.max ?? 1,
      selection_type: g.selectionType || 'single',
      options: (g.options || []).map(o => ({
        id: o.id,
        name: o.name || o.label,
        price: Number(o.price) || 0,
      })),
    }));

  const userMessage =
    `Transcript: "${transcript}"\n\n` +
    `Menu (${compactMenu.length} items):\n${JSON.stringify(compactMenu)}\n\n` +
    `Modifier groups (${compactGroups.length}):\n${JSON.stringify(compactGroups)}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: 'add_items_to_order' },
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.error?.message || 'Anthropic API error' });
    }

    const data = await response.json();
    // Extract the tool_use block — guaranteed by tool_choice
    const toolUse = (data.content || []).find(c => c.type === 'tool_use');
    if (!toolUse?.input) {
      return res.status(502).json({ error: 'Parser returned no items' });
    }
    return res.status(200).json({
      items:         toolUse.input.items || [],
      suggestions:   toolUse.input.suggestions || [],
      order_note:    toolUse.input.order_note || '',
      clarification: toolUse.input.clarification || '',
      usage:         data.usage || null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
