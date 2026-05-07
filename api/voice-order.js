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

Your job is to return a structured list of items that match the transcript.

You must call the add_items_to_order tool exactly once with the parsed items.
If the transcript is ambiguous (e.g. "burger" but there are three burgers on
the menu), put your clarifying question in the clarification field of the tool
call and return zero items so the server can re-record.

Rules:
1. Only return items that exist in the provided menu — never invent items.
   Match the spoken phrase against item.name. The names already include the
   size / variant (e.g. "Latte — Large", "Lager — Pint"), so "large latte"
   should match the item whose name CONTAINS BOTH "latte" AND "large".
2. NEVER pick an item by partial size match alone. If the transcript says
   "large latte" and you find "Latte — Large", return that. If you can only
   find "Latte — Regular" and "Espresso", set clarification asking for the
   right size — DO NOT silently substitute.
3. Map quantities correctly ("a couple of beers" → 2, "three" → 3, "another" → +1).
4. Map modifiers if the transcript implies them ("no pickle" → mod_label).
5. Map cooking preferences ("medium rare", "well done") to instruction labels.
6. If the transcript mentions allergies ("they're allergic to nuts"), put it in
   order_note — DO NOT silently swap items.
7. Be tolerant of speech-to-text errors: "ling-uine" → "linguine".
8. If something can't be confidently mapped, skip it and explain in clarification.

Return only the tool call. No prose.`;

const TOOL = {
  name: 'add_items_to_order',
  description: 'Submit the parsed items to add to the order. Always call this exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Parsed line items. Empty array if the transcript is unparseable.',
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
      order_note: {
        type: 'string',
        description: 'Whole-order note — used for allergens, table-wide preferences, urgency. Empty if none.',
      },
      clarification: {
        type: 'string',
        description: 'If the transcript is ambiguous, ask the server one short question. Empty if all items are confidently mapped.',
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
      order_note:    toolUse.input.order_note || '',
      clarification: toolUse.input.clarification || '',
      usage:         data.usage || null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
