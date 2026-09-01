/**
 * Restaurant OS — AI API Proxy
 * Keeps the Anthropic API key server-side.
 * Validates requests so only allowed tools can be called.
 */

const ALLOWED_TOOLS_FOH = [
  'get_pos_health',
  'get_sales_summary',
  'get_top_items',
  'search_item_sales',
  'get_hourly_breakdown',
  'get_floor_status',
  'get_open_tables',
  'get_printer_status',
  'get_allergen_info',
  'get_item_detail',
  'get_current_order',
  'get_server_performance',
  'add_to_order',
  'remove_from_order',
  'apply_order_discount',
  'eighty_six_item',
  'get_shift_summary',
  'get_86_status',
  'get_stock_status',
  'lookup_item',
  'get_order_queue',
  'search_activity',
  'get_waitlist',
  'get_menu_overview',
];

const ALLOWED_TOOLS_BOH = [
  'get_pos_health',
  'get_sales_summary',
  'get_top_items',
  'search_item_sales',
  'get_hourly_breakdown',
  'get_payment_breakdown',
  'get_server_performance',
  'get_covers_report',
  'get_order_history',
  'get_open_tables',
  'get_floor_status',
  'get_printer_status',
  'get_allergen_info',
  'get_item_detail',
  'get_menu_items',
  'get_shift_summary',
  'add_menu_item',
  'update_item_price',
  'eighty_six_item',
  'get_86_status',
  'get_stock_status',
  'lookup_item',
  'get_order_queue',
  'search_activity',
  'get_waitlist',
  'get_menu_overview',
];

const TOOL_DEFINITIONS = {

  // ── Read tools ────────────────────────────────────────────────────────────

  get_sales_summary: {
    name: 'get_sales_summary',
    description: 'Get a summary of sales for today: total revenue, cover count, check count, average check value, tips, and card vs cash split.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  get_shift_summary: {
    name: 'get_shift_summary',
    description: 'Get a comprehensive shift overview combining sales, floor status, open tables, and top items in one call. Use for "how is the shift going" type questions.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  get_top_items: {
    name: 'get_top_items',
    description: 'Get the top-selling menu items by quantity sold today. Use for "what\'s selling well", "top sellers", "best performing items" questions.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Number of items to return (default 5, max 20)' } },
      required: [],
    },
  },

  search_item_sales: {
    name: 'search_item_sales',
    description: 'Look up how many of a specific item or category have been sold today. Use for questions like "how many lattes have I sold", "how many pints of lager", "how much have I made on burgers". Searches by item name (partial match).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Item name or partial name to search for (e.g. "latte", "lager", "burger")' },
      },
      required: ['query'],
    },
  },

  get_hourly_breakdown: {
    name: 'get_hourly_breakdown',
    description: 'Get revenue and cover counts broken down by hour for today. Use for "what\'s been my busiest hour", "when did we peak", "hourly sales".',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  get_payment_breakdown: {
    name: 'get_payment_breakdown',
    description: 'Get detailed payment method breakdown: card, cash, split, and any tips. Also shows average check value per payment type.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  get_server_performance: {
    name: 'get_server_performance',
    description: 'Get sales performance per server/staff member for today: covers, checks, revenue, and average check value per person. Use for "who\'s sold the most", "server stats", "staff performance".',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  get_covers_report: {
    name: 'get_covers_report',
    description: 'Get cover count breakdown by hour and by server for today.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  get_floor_status: {
    name: 'get_floor_status',
    description: 'Get current table and floor status — how many tables are occupied, available, seated (open but no order yet).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  get_open_tables: {
    name: 'get_open_tables',
    description: 'Get details of all currently open/occupied tables: table number, covers, server, items ordered, running total, and how long they\'ve been seated. Use for "what tables are open", "who has been waiting longest", "what does table 3 owe".',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  get_pos_health: {
    name: 'get_pos_health',
    description: "What is currently wrong with this POS: printers that cannot be reached (including the device's own error text), a print agent that has stopped checking in, unacknowledged ops alerts such as temperature breaches, and orders stuck in the queue. Use this for questions like \"what is broken\", \"why is nothing printing\", \"is anything wrong\", and before suggesting a fix, so the advice can be specific rather than generic.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  get_printer_status: {
    name: 'get_printer_status',
    description: 'Check the current status of all printers. Returns online/offline status, last success, and any error messages.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  get_allergen_info: {
    name: 'get_allergen_info',
    description: 'Get allergen information for a specific menu item. Use when a customer asks about allergens or dietary requirements.',
    input_schema: {
      type: 'object',
      properties: { item_name: { type: 'string', description: 'The name of the menu item' } },
      required: ['item_name'],
    },
  },

  get_item_detail: {
    name: 'get_item_detail',
    description: 'Get full details for a menu item: price, description, allergens, modifiers, and availability. Use for "tell me about X", "what comes with Y", "how much is Z".',
    input_schema: {
      type: 'object',
      properties: { item_name: { type: 'string', description: 'The name of the menu item (partial match)' } },
      required: ['item_name'],
    },
  },

  get_menu_items: {
    name: 'get_menu_items',
    description: 'List all menu items with prices, categories, and availability status. Optionally filter by category.',
    input_schema: {
      type: 'object',
      properties: { category: { type: 'string', description: 'Filter by category name (optional)' } },
      required: [],
    },
  },

  get_order_history: {
    name: 'get_order_history',
    description: 'Get recent closed checks with totals, items ordered, server, table, and payment method.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Number of recent orders to return (default 10, max 50)' } },
      required: [],
    },
  },

  get_current_order: {
    name: 'get_current_order',
    description: 'Get the items currently in the active order on this terminal. Always call this before adding or removing items.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ── Write tools (require confirmation) ────────────────────────────────────

  add_to_order: {
    name: 'add_to_order',
    description: 'Propose adding a menu item to the current active order. Always call get_current_order first. Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        item_name: { type: 'string', description: 'The name of the item to add' },
        qty:       { type: 'number', description: 'Quantity to add (default 1)' },
        notes:     { type: 'string', description: 'Special instructions (optional)' },
      },
      required: ['item_name'],
    },
  },

  remove_from_order: {
    name: 'remove_from_order',
    description: 'Propose removing or voiding an item from the current active order. Always call get_current_order first to confirm the item is there. Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        item_name: { type: 'string', description: 'The name of the item to remove' },
        qty:       { type: 'number', description: 'Quantity to remove (default 1)' },
        reason:    { type: 'string', description: 'Reason for removal (optional)' },
      },
      required: ['item_name'],
    },
  },

  apply_order_discount: {
    name: 'apply_order_discount',
    description: 'Propose applying a discount to the current order. Requires confirmation and a reason. Flag anything over 50% as unusual.',
    input_schema: {
      type: 'object',
      properties: {
        type:   { type: 'string', enum: ['percent', 'fixed'], description: 'percent or fixed amount' },
        value:  { type: 'number', description: 'Percentage (0-100) or fixed GBP amount' },
        reason: { type: 'string', description: 'Reason for the discount' },
      },
      required: ['type', 'value', 'reason'],
    },
  },

  eighty_six_item: {
    name: 'eighty_six_item',
    description: 'Propose marking a menu item as sold out (86\'d). Requires confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        item_id:   { type: 'string', description: 'The menu item ID' },
        item_name: { type: 'string', description: 'The menu item name' },
      },
      required: ['item_id', 'item_name'],
    },
  },

  add_menu_item: {
    name: 'add_menu_item',
    description: 'Propose adding a new menu item. Always show a preview and wait for confirmation. Never call without explicit user request.',
    input_schema: {
      type: 'object',
      properties: {
        name:        { type: 'string',  description: 'Item name' },
        price:       { type: 'number',  description: 'Price in GBP' },
        category_id: { type: 'string',  description: 'Category ID' },
        description: { type: 'string',  description: 'Brief description (optional)' },
      },
      required: ['name', 'price', 'category_id'],
    },
  },

  update_item_price: {
    name: 'update_item_price',
    description: 'Propose updating an item price. Always show a preview and wait for confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        item_id:   { type: 'string', description: 'The menu item ID' },
        item_name: { type: 'string', description: 'The menu item name' },
        new_price: { type: 'number', description: 'New price in GBP' },
      },
      required: ['item_id', 'new_price'],
    },
  },

  // ── v5.5.735: broad read tools ──────────────────────────────────────────────

  get_86_status: {
    name: 'get_86_status',
    description: "List items currently 86'd (sold out / manually turned off), with when each went 86 and any stock remaining. Pass item_name to check a SPECIFIC item, e.g. \"is the donut 86'd?\" — it will say whether that item is off and since when.",
    input_schema: { type: 'object', properties: { item_name: { type: 'string', description: 'Optional: check one item by name' } }, required: [] },
  },

  get_stock_status: {
    name: 'get_stock_status',
    description: "Show items that are low or out of stock (daily count remaining vs par). Pass item_name to check one item's stock level. Use for \"what's running low\" / \"how many donuts left\".",
    input_schema: { type: 'object', properties: { item_name: { type: 'string', description: 'Optional: check one item by name' } }, required: [] },
  },

  lookup_item: {
    name: 'lookup_item',
    description: 'Full detail for a menu item by name: price, category, allergens, whether it is 86’d, stock remaining, its sizes/variants and modifier groups. Best tool for a detailed question about a specific product (e.g. "tell me about the glazed donut").',
    input_schema: { type: 'object', properties: { item_name: { type: 'string', description: 'The item name (partial ok)' } }, required: ['item_name'] },
  },

  get_order_queue: {
    name: 'get_order_queue',
    description: 'Live kitchen / collection / delivery queue — orders awaiting fulfilment (kiosk, online, catering), grouped by status. Use for "what\'s pending?", "any orders waiting?", "what\'s the queue like?".',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  search_activity: {
    name: 'search_activity',
    description: "Search the operational activity timeline: orders, menu & price changes, 86 / stock changes, ops/temperature, and staff nudges — each with who did it and when. THE tool for \"when/who did X happen\" questions (e.g. \"when did the donut get 86'd?\", \"what changed today?\").",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional text to match in the event (e.g. an item name like "donut")' },
        kind: { type: 'string', enum: ['order', 'menu', 'stock', 'ops', 'nudge', 'system'], description: 'Optional event kind filter' },
        hours_back: { type: 'number', description: 'How far back to look, in hours (default 24, max 168)' },
      },
      required: [],
    },
  },

  get_waitlist: {
    name: 'get_waitlist',
    description: 'Current walk-in waitlist / table queue: parties waiting, party size, quoted wait time, and status. Use for "how long is the wait?", "who\'s in the queue?".',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  get_menu_overview: {
    name: 'get_menu_overview',
    description: 'High-level overview of the menu: each category with its item count and how many are 86’d, plus totals. Use for "what\'s on the menu?", "how many items are off?".',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
};

const SYSTEM_FOH = `You are an AI shift assistant built into a restaurant POS system. You help front-of-house staff during live service.

PERSONALITY: Brief, practical, direct. Staff are busy — no waffle. Use short sentences.

YOU CAN ANSWER QUESTIONS LIKE:
- "How many lattes have I sold?" → use search_item_sales
- "What's my top seller?" → use get_top_items
- "How's the shift going?" → use get_shift_summary
- "What tables are open?" → use get_open_tables
- "What's table 3 ordered?" → use get_open_tables
- "Who's been seated longest?" → use get_open_tables
- "What's my total revenue?" → use get_sales_summary
- "Add a pint of Lager to this table" → use get_current_order first, then add_to_order
- "Does the burger have gluten?" → use get_allergen_info
- "What's the busiest hour been?" → use get_hourly_breakdown
- "Who's sold the most today?" → get_server_performance
- "Is the donut 86'd?" / "What's sold out right now?" → get_86_status
- "How many donuts left?" / "What's running low?" → get_stock_status
- "Tell me about the glazed donut" / "What's in the burger?" → lookup_item
- "When did the donut get 86'd?" / "Who changed that?" / "What's happened today?" → search_activity
- "Any orders waiting?" / "What's in the queue?" → get_order_queue
- "How long is the wait?" / "Who's in the queue?" → get_waitlist
- "What's on the menu?" / "How many items are off?" → get_menu_overview

You have broad read access to this venue's live data — sales, floor, orders, the menu, stock, what's
86'd, the fulfilment queue, the waitlist, and the operational activity timeline (who did what, when).
Pick the tool that fits. If a first tool comes back empty, TRY ANOTHER before saying you can't help —
e.g. if asked about a 86'd item, use get_86_status AND search_activity (kind:'stock') for the history.
Never answer "I couldn't find any info" without having tried the relevant read tools.

RULES:
- Always call get_current_order BEFORE adding or removing anything from an order
- Never add more than 5 items in one go without confirming
- Discounts over 50%: flag as unusual and ask for manager confirmation
- For item searches, be helpful — if "latte" matches "Oat Latte" and "Latte", list both
- Keep answers to 1-3 lines unless data requires more
- Always use £ for currency

NEVER: delete data, change prices, modify the menu, discuss non-restaurant topics
DIAGNOSING FAULTS:
When someone reports something not working — "the printer isn't working", "nothing is
printing", "orders aren't coming through", "is anything wrong" — call get_pos_health
FIRST, then answer from what it returns.

- Name the specific thing. "Kitchen printer, not reachable on the network since 14:02"
  beats "there is a printer problem".
- Quote what the device actually said if it helps them act on it.
- Give the next physical step, in order of what is most likely and easiest to check.
- If get_pos_health reports healthy, say so plainly and ask what they saw. Do NOT
  invent a cause. The POS keeps no crash log, so a fault can be real and leave no
  trace here, and guessing during service sends someone to fix the wrong thing.
- Never claim you have fixed anything. You can only look and advise.
`;

const SYSTEM_BOH = `You are an AI assistant for restaurant managers in the back office. You help with reporting, menu management, and operational insight.

PERSONALITY: Professional, data-driven, clear. Present numbers in a way that's easy to act on.

YOU CAN ANSWER QUESTIONS LIKE:
- "How many lattes have I sold today?" → search_item_sales
- "What's my top selling item?" → get_top_items
- "Give me a full shift summary" → get_shift_summary
- "What's the payment breakdown?" → get_payment_breakdown
- "Which server has done the most covers?" → get_server_performance
- "What's been our busiest hour?" → get_hourly_breakdown
- "Show me recent orders" → get_order_history
- "What tables are still open?" → get_open_tables
- "What's 86'd right now?" / "Is the donut off?" → get_86_status
- "What's low on stock?" / "How many donuts left?" → get_stock_status
- "Tell me everything about the glazed donut" → lookup_item
- "When did the donut get 86'd, and who by?" / "What's changed today?" → search_activity
- "What's in the fulfilment queue?" → get_order_queue
- "How's the waitlist?" → get_waitlist
- "Give me a menu overview / what's off?" → get_menu_overview

You have broad read access to this venue's live data. Pick the tool that fits; if a first tool comes
back empty, try another (e.g. an item's 86 history → get_86_status AND search_activity kind:'stock')
before saying you can't help. Never reply "I couldn't find any info" without trying the read tools.
- "Update the price of the burger to £14" → update_item_price (with confirmation)
- "Add a new item: Truffle Fries, £8" → add_menu_item (with confirmation)

FOR ALL WRITE ACTIONS:
- Use the tool to generate a preview
- STOP and explicitly ask "Shall I go ahead?" before proceeding
- Never assume confirmation from a previous message

Always use £ for currency. Format data tables clearly when comparing multiple values.

NEVER: delete anything, make bulk changes, modify floor plans or printer configs, access staff PINs
DIAGNOSING FAULTS:
When someone reports something not working — "the printer isn't working", "nothing is
printing", "orders aren't coming through", "is anything wrong" — call get_pos_health
FIRST, then answer from what it returns.

- Name the specific thing. "Kitchen printer, not reachable on the network since 14:02"
  beats "there is a printer problem".
- Quote what the device actually said if it helps them act on it.
- Give the next physical step, in order of what is most likely and easiest to check.
- If get_pos_health reports healthy, say so plainly and ask what they saw. Do NOT
  invent a cause. The POS keeps no crash log, so a fault can be real and leave no
  trace here, and guessing during service sends someone to fix the wrong thing.
- Never claim you have fixed anything. You can only look and advise.
`;

const SYSTEM_ROTA = `You are an expert hospitality workforce scheduler. Given staff (with availability + pay rates), section coverage minimums, the week's sales forecast and a target labour-cost %, produce a one-week staff rota.

RULES:
- Only schedule a person on days/times they are available. If a person has no availability listed, treat them as flexible.
- Meet each section's minimum coverage during likely trading hours; weight more staff onto higher-forecast days.
- Keep each day's wage cost close to but not over the target % of that day's forecast sales (wage = hours × that person's rate). If forecast for a day is 0/unknown, schedule only minimum coverage.
- Typical shifts 4–10h; include a 30-minute unpaid break when a shift exceeds 6h.
- Spread hours fairly and respect any max weekly hours.

Return ONLY a JSON array — no prose, no explanation, no markdown code fences:
[{"staffId":"<id>","date":"YYYY-MM-DD","start":"HH:MM","finish":"HH:MM","breakMins":30,"section":"<name>"}]`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'AI not configured' });

  const { messages, mode = 'foh' } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Invalid request' });

  const isRota = mode === 'rota';
  const allowedTools = mode === 'boh' ? ALLOWED_TOOLS_BOH : ALLOWED_TOOLS_FOH;
  const tools = isRota ? [] : allowedTools.map(name => TOOL_DEFINITIONS[name]).filter(Boolean);
  const systemPrompt = isRota ? SYSTEM_ROTA : (mode === 'boh' ? SYSTEM_BOH : SYSTEM_FOH);
  const maxTokens = isRota ? 4000 : 1500;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: maxTokens,
        system: systemPrompt,
        ...(tools.length ? { tools } : {}),
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.error?.message || 'Anthropic API error' });
    }

    return res.status(200).json(await response.json());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
