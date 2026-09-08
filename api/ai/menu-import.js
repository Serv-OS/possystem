/**
 * Restaurant OS — AI Menu Import endpoint
 *
 * POST /api/ai/menu-import
 *
 * Accepts a menu file (PDF, DOCX, XLSX, JPG, PNG) and returns a structured
 * draft menu parsed by Claude. The draft is NOT written to the database —
 * the Back Office renders it for human review before publishing.
 *
 * Body: JSON { filename, mimeType, base64 }
 *   filename   - original filename (for logging)
 *   mimeType   - one of: application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document,
 *                application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, image/jpeg, image/png
 *   base64     - file contents as base64 string (max ~7MB decoded to fit Vercel 10MB body limit)
 *
 * Response: { categories: [...], items: [...], notes: "..." }
 */

import ExcelJS from 'exceljs';
import mammoth from 'mammoth';

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
  },
  maxDuration: 60,
};

// ── Allowed MIME types ───────────────────────────────────────────────────────
const ALLOWED_MIME = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
};

const MAX_FILE_BYTES = 7 * 1024 * 1024; // 7MB decoded

// ── Tool schema — what Claude returns ─────────────────────────────────────────
const SUBMIT_DRAFT_MENU = {
  name: 'submit_draft_menu',
  description: 'Submit the parsed menu as a structured draft. Call this exactly once at the end of the parse, with all categories and items included. The user will review and edit before publishing.',
  input_schema: {
    type: 'object',
    properties: {
      categories: {
        type: 'array',
        description: 'Menu categories/sections in the order they appear on the original menu.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'A unique identifier like "cat-starters" or "cat-mains"' },
            label: { type: 'string', description: 'The display name of the category' },
            icon: { type: 'string', description: 'A single emoji that represents the category (pick an appropriate one: 🍽 🥗 🍖 🍕 🍸 ☕ 🎂 🥤 🌿 🔥 ❄️ ⭐ 🌮 🦞 🍜 🥩 🍤 🥚 🥐)' },
            sortOrder: { type: 'integer', description: 'Order within the menu (0-based)' },
          },
          required: ['id', 'label', 'icon', 'sortOrder'],
        },
      },
      items: {
        type: 'array',
        description: 'All menu items across all categories.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'A unique identifier' },
            name: { type: 'string', description: 'The dish name as on the menu' },
            description: { type: 'string', description: 'Full item description, exactly as on the menu. Empty string if none.' },
            categoryId: { type: 'string', description: 'ID of the parent category' },
            price: { type: 'number', description: 'Base price as a decimal. 0 if unclear, market-price, or "ask staff".' },
            allergens: {
              type: 'array',
              description: 'Allergens detected from symbols (V, VG/VE, GF, DF), asterisks, or footnotes. Only include if clearly indicated — do not guess.',
              items: {
                type: 'string',
                enum: ['gluten','milk','eggs','fish','shellfish','peanuts','treenuts','soy','sesame','mustard','celery','lupin','sulphites','molluscs'],
              },
            },
            variants: {
              type: 'array',
              description: 'Sizes or variations with different prices (e.g. Small/Medium/Large, 8oz/12oz, Glass/Bottle). Empty array if only one size.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  price: { type: 'number' },
                },
                required: ['name', 'price'],
              },
            },
            confidence: {
              type: 'string',
              enum: ['high','medium','low'],
              description: 'High = name + price clear and unambiguous. Medium = minor uncertainty. Low = price missing, multiple interpretations, OCR artifacts, or unclear.',
            },
            notes: { type: 'string', description: 'Any caveats or info worth flagging to the reviewer (e.g. "price shown as MP", "V symbol unclear"). Empty string if none.' },
          },
          required: ['id', 'name', 'categoryId', 'price', 'confidence'],
        },
      },
      notes: {
        type: 'string',
        description: 'Any global observations for the reviewer (e.g. "Prices in USD", "Menu has combo deals that need manual setup", "Legend unclear").',
      },
    },
    required: ['categories', 'items'],
  },
};

const SYSTEM_PROMPT = `You are parsing a restaurant menu into structured data for a POS system. The restaurant owner will review your parse before publishing — your job is to be faithful and flag uncertainty, not to be creative.

RULES:
- Extract every category and every item you see
- Preserve original item names exactly (don't rephrase "Fish & Chips" as "Fish and Chips")
- Preserve original descriptions exactly; empty string if none
- Parse prices as numbers — strip currency symbols (£ $ € ¥), commas, "from" prefixes
- For items with sizes (Small/Medium/Large, 8oz/10oz/12oz, pizza 10"/12"/16", wine Glass/Bottle 175ml/250ml):
    → create variants[], each with its own price
    → the base "price" field should be the smallest variant's price
- Detect allergens ONLY when clearly indicated (V, VG/VE, GF, DF symbols, asterisks with footnotes)
    → Map: V/Vegan → no animal allergens (empty unless other allergens shown). GF → no gluten listed. DF → no milk listed. Don't guess ingredients.
- For each item, set confidence:
    → high: name + price crystal clear
    → medium: minor ambiguity (slight OCR issue, abbreviation)
    → low: missing price, unclear if one item or two, multiple possible interpretations
- Add item "notes" for anything the reviewer should know ("MP", "seasonal", "ask staff")
- If the menu has combo deals or meal bundles, create them as items at their combo price and add a note "combo — modifiers may need manual setup"
- Pick category icons from: 🍽 🥗 🍖 🍕 🍸 ☕ 🎂 🥤 🌿 🔥 ❄️ ⭐ 🌮 🦞 🍜 🥩 🍤 🥚 🥐

OUTPUT: Call submit_draft_menu exactly once with everything. Do not respond with text. Do not ask clarifying questions.

If you genuinely cannot extract any menu structure (e.g. the document is blank or not a menu), call submit_draft_menu with empty arrays and a clear explanation in "notes".`;

// ── Request handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'AI not configured — missing ANTHROPIC_API_KEY' });

  const { filename, mimeType, base64 } = req.body || {};
  if (!filename || !mimeType || !base64) {
    return res.status(400).json({ error: 'Missing filename, mimeType, or base64 in request body' });
  }

  const kind = ALLOWED_MIME[mimeType];
  if (!kind) {
    return res.status(400).json({ error: `Unsupported file type: ${mimeType}. Accepted: PDF, DOCX, XLSX, JPG, PNG.` });
  }

  // Decode + size check
  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    return res.status(400).json({ error: 'Invalid base64 data' });
  }
  if (buffer.length > MAX_FILE_BYTES) {
    return res.status(413).json({ error: `File too large (${Math.round(buffer.length/1024/1024)}MB). Max 7MB.` });
  }
  if (buffer.length < 100) {
    return res.status(400).json({ error: 'File appears empty or corrupted' });
  }

  // Build the user-message content block based on file kind
  let userContent;
  try {
    userContent = await buildUserContent(kind, mimeType, buffer, filename);
  } catch (err) {
    return res.status(400).json({ error: `Failed to process ${kind} file: ${err.message}` });
  }

  // Call Claude with the tool
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        tools: [SUBMIT_DRAFT_MENU],
        tool_choice: { type: 'tool', name: 'submit_draft_menu' },
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      console.error('Anthropic error:', claudeRes.status, errBody);
      return res.status(claudeRes.status).json({ error: `Anthropic API error: ${errBody.slice(0, 500)}` });
    }

    const data = await claudeRes.json();

    // Find the tool_use block in the response
    const toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_draft_menu');
    if (!toolUse) {
      return res.status(502).json({ error: 'AI did not return a structured menu. Try again or use a clearer file.', raw: data });
    }

    const draft = toolUse.input || {};
    const usage = data.usage || {};

    return res.status(200).json({
      draft: {
        categories: Array.isArray(draft.categories) ? draft.categories : [],
        items: Array.isArray(draft.items) ? draft.items : [],
        notes: draft.notes || '',
      },
      meta: {
        filename,
        mimeType,
        kind,
        inputSize: buffer.length,
        tokensIn: usage.input_tokens || 0,
        tokensOut: usage.output_tokens || 0,
      },
    });
  } catch (err) {
    console.error('menu-import error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}

// ── Build Claude content block based on file kind ────────────────────────────
async function buildUserContent(kind, mimeType, buffer, filename) {
  if (kind === 'pdf') {
    // Claude supports PDFs natively
    return [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
      },
      {
        type: 'text',
        text: `Parse the menu in the attached PDF. Filename: ${filename}`,
      },
    ];
  }

  if (kind === 'image') {
    return [
      {
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') },
      },
      {
        type: 'text',
        text: `Parse the menu in the attached image. Filename: ${filename}. If the image is unclear or not a menu, say so in notes.`,
      },
    ];
  }

  if (kind === 'docx') {
    // Extract text server-side with mammoth, then send as text
    const result = await mammoth.extractRawText({ buffer });
    const text = (result.value || '').trim();
    if (!text) throw new Error('Document contains no extractable text');
    return [{
      type: 'text',
      text: `Parse the menu in the following Word document (${filename}):\n\n---BEGIN DOCUMENT---\n${text}\n---END DOCUMENT---`,
    }];
  }

  if (kind === 'xlsx') {
    // Parse each worksheet to a CSV-like table using exceljs, then send as text.
    // exceljs loadFromBuffer returns a workbook; iterate sheets and rows.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const parts = [];
    wb.eachSheet((ws) => {
      const rows = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        // values[0] is always null in exceljs; slice to get real cells
        const cells = (row.values || []).slice(1).map(v => {
          if (v === null || v === undefined) return '';
          if (typeof v === 'object' && 'result' in v) return String(v.result); // formula
          if (typeof v === 'object' && 'text' in v) return String(v.text);     // richtext
          if (v instanceof Date) return v.toISOString().slice(0,10);
          return String(v);
        });
        // Skip fully-empty rows
        if (cells.some(c => c.trim() !== '')) {
          // CSV-escape: wrap in quotes if contains comma/quote/newline, double-up embedded quotes
          const csvCells = cells.map(c => {
            if (/[,"\n\r]/.test(c)) return '"' + c.replace(/"/g, '""') + '"';
            return c;
          });
          rows.push(csvCells.join(','));
        }
      });
      if (rows.length) parts.push(`### Sheet: ${ws.name}\n${rows.join('\n')}`);
    });
    if (!parts.length) throw new Error('Spreadsheet contains no data');
    return [{
      type: 'text',
      text: `Parse the menu in the following spreadsheet (${filename}). It contains ${parts.length} sheet(s) with data.\n\n---BEGIN SPREADSHEET---\n${parts.join('\n\n')}\n---END SPREADSHEET---`,
    }];
  }

  throw new Error(`Unhandled file kind: ${kind}`);
}
