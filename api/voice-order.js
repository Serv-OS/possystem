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
the location's full menu (items, modifier groups, allergens). Your job is to
return a structured list of items that match the transcript.

You must call the add_items_to_order tool exactly once with the parsed items.
If the transcript is ambiguous (e.g. "burger" but there are three burgers on
the menu), put your clarifying question in the clarification field of the tool
call and return zero items so the server can re-record.

Rules:
1. Only return items that exist in the provided menu — never invent items.
2. Map quantities correctly ("a couple of beers" → 2, "three" → 3, "another" → +1).
3. Map modifiers / sizes if the transcript implies them ("large fries" → fries
   variant where size matches, "no pickle" → modifier with negative flag in notes).
4. Map cooking preferences ("medium rare", "well done") to instruction notes.
5. If the transcript mentions allergies ("they're allergic to nuts"), put it in
   the order_note field — DO NOT silently swap items.
6. Be tolerant of speech-to-text errors: "ling-uine" → "linguine".
7. If something can't be confidently mapped, skip it and add a note in clarification.

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

  // Compact menu representation — only the fields the parser needs. Keeps
  // tokens down so latency stays under ~1.5s.
  const compactMenu = menu.slice(0, 200).map(m => ({
    id: m.id,
    name: m.name,
    cat: m.cat || (Array.isArray(m.cats) ? m.cats[0] : null),
    price: m.price ?? m.pricing?.base ?? 0,
    parent_id: m.parentId || null,
    type: m.type || 'simple',
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
