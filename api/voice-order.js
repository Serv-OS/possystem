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

Rules:
- Only reference items that exist in the provided menu — never invent items.
- Match against item.name. Names include size / variant (e.g. "Latte — Large").
  "large latte" should match the item whose name contains BOTH words.
- NEVER pick a child by partial size match alone. If the customer asked for a
  size that doesn't exist, treat it as PARTIAL MATCH (case 2 above) rather
  than silently substituting.
- Map quantities ("a couple of beers" → 2, "three" → 3, "another" → +1).
- Map modifiers if implied ("no pickle" → mod_label).
- Map cooking preferences ("medium rare") to instruction labels.
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
            mod_labels: { type: 'array',   description: 'Modifier or instruction labels to attach.', items: { type: 'string' } },
            notes:      { type: 'string',  description: 'Item-level notes (e.g. "no onion", "well done").' },
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

  const { transcript, menu } = req.body || {};
  if (!transcript || typeof transcript !== 'string') {
    return res.status(400).json({ error: 'Missing transcript' });
  }
  if (!Array.isArray(menu) || menu.length === 0) {
    return res.status(400).json({ error: 'Missing menu' });
  }

  // Filter to SELLABLE LEAVES only. Parent variant items (type === 'variants')
  // exist on the menu as containers — they have price 0 and aren't sold
  // directly; their sellable forms are children with parentId set. If we let
  // Claude see the parent, it sometimes picks the parent ID for "large latte"
  // because the parent name matched, even though the variant child is what
  // the customer wanted. Drop parents here so Claude can only choose among
  // sellable items.
  const ids = new Set(menu.map(m => m.id));
  const parentIds = new Set(menu.filter(m => (m.type || 'simple') === 'variants').map(m => m.id));
  const sellable = menu.filter(m => {
    const t = m.type || 'simple';
    if (t === 'variants') return false;          // never sell the parent
    if (m.parentId && !ids.has(m.parentId)) {
      // orphaned variant — keep, defensive
      return true;
    }
    return true;
  });

  // Compact menu representation — only the fields the parser needs. Keeps
  // tokens down so latency stays under ~1.5s.
  const compactMenu = sellable.slice(0, 250).map(m => ({
    id: m.id,
    name: m.name,
    cat: m.cat || (Array.isArray(m.cats) ? m.cats[0] : null),
    price: m.price ?? m.pricing?.base ?? 0,
    allergens: m.allergens || [],
  }));

  const userMessage = `Transcript: "${transcript}"\n\nMenu (${compactMenu.length} items):\n${JSON.stringify(compactMenu)}`;

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
