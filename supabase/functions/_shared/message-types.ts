// supabase/functions/_shared/message-types.ts
//
// Registry of all transactional message types with their default templates
// and available merge tags. Used by:
//   - message-templates edge function (CRUD + preview)
//   - template-resolver (send-time resolution)
//   - MessageTemplates.jsx (back office UI)

export interface MergeTag {
  tag: string;
  label: string;
  example: string;
}

export interface ChannelDefault {
  subject?: string;
  body: string;
}

export interface MessageTypeDef {
  type: string;
  label: string;
  description: string;
  category: string;
  channels: ('email' | 'sms')[];
  mergeTags: MergeTag[];
  defaults: {
    email?: ChannelDefault;
    sms?: ChannelDefault;
  };
}

// ── Merge tag libraries ─────────────────────────────────────────────────────

const TAG_CUSTOMER_NAME: MergeTag = { tag: 'customer_name', label: 'Customer Name', example: 'Sarah' };
const TAG_ORDER_NUMBER: MergeTag = { tag: 'order_number', label: 'Order Number', example: '1042' };
const TAG_VENUE_NAME: MergeTag = { tag: 'venue_name', label: 'Venue Name', example: 'The Red Lion' };
const TAG_ORDER_TOTAL: MergeTag = { tag: 'order_total', label: 'Order Total', example: '£27.50' };
const TAG_ESTIMATED_TIME: MergeTag = { tag: 'estimated_time', label: 'Est. Time (mins)', example: '15' };
const TAG_TABLE_NUMBER: MergeTag = { tag: 'table_number', label: 'Table Number', example: '12' };
const TAG_DATE: MergeTag = { tag: 'date', label: 'Date', example: '24 May 2026' };
const TAG_TIME: MergeTag = { tag: 'time', label: 'Time', example: '7:30 PM' };
const TAG_PARTY_SIZE: MergeTag = { tag: 'party_size', label: 'Party Size', example: '4' };
const TAG_CONFIRMATION_NUMBER: MergeTag = { tag: 'confirmation_number', label: 'Confirmation #', example: 'RES-4821' };
const TAG_PAYMENT_METHOD: MergeTag = { tag: 'payment_method', label: 'Payment Method', example: 'Visa ****6411' };
const TAG_SERVER_NAME: MergeTag = { tag: 'server_name', label: 'Server Name', example: 'Alex' };
const TAG_ORDER_ITEMS: MergeTag = { tag: 'order_items', label: 'Order Items', example: '2x Margherita, 1x Caesar Salad, 3x House Lager' };
const TAG_SENDER_NAME: MergeTag = { tag: 'sender_name', label: 'Sender Name', example: 'James' };
const TAG_RECIPIENT_NAME: MergeTag = { tag: 'recipient_name', label: 'Recipient Name', example: 'Emma' };
const TAG_RECIPIENT_EMAIL: MergeTag = { tag: 'recipient_email', label: 'Recipient Email', example: 'emma@example.com' };
const TAG_AMOUNT: MergeTag = { tag: 'amount', label: 'Amount', example: '£25.00' };
const TAG_CODE: MergeTag = { tag: 'code', label: 'Gift Card Code', example: 'ABCD EFGH JKLM NPQR' };
const TAG_CODE_LAST4: MergeTag = { tag: 'code_last4', label: 'Code Last 4', example: 'NPQR' };
const TAG_EXPIRY_DATE: MergeTag = { tag: 'expiry_date', label: 'Expiry Date', example: 'May 2027' };
const TAG_BALANCE_URL: MergeTag = { tag: 'balance_url', label: 'Balance Check URL', example: 'https://venue.serv-os.app/gift/balance' };
const TAG_MESSAGE: MergeTag = { tag: 'message', label: 'Personal Message', example: 'Happy Birthday! Enjoy a meal on us.' };
const TAG_COLLECTION_POINT: MergeTag = { tag: 'collection_point', label: 'Collection Point', example: 'the counter' };

// ── Message type definitions ────────────────────────────────────────────────

export const MESSAGE_TYPES: MessageTypeDef[] = [
  // ── Orders ──────────────────────────────────────────────────────────────
  {
    type: 'order_ready',
    label: 'Order Ready',
    description: 'Sent when a takeaway or collection order is ready to pick up',
    category: 'Orders',
    channels: ['sms'],
    mergeTags: [TAG_CUSTOMER_NAME, TAG_ORDER_NUMBER, TAG_VENUE_NAME, TAG_COLLECTION_POINT],
    defaults: {
      sms: {
        body: `Hi {{customer_name}}, your order #{{order_number}} is ready for collection at {{venue_name}}!`,
      },
    },
  },
  {
    type: 'order_confirmation',
    label: 'Order Confirmation',
    description: 'Sent when a new order is placed (online or in-venue)',
    category: 'Orders',
    channels: ['email', 'sms'],
    mergeTags: [TAG_CUSTOMER_NAME, TAG_ORDER_NUMBER, TAG_VENUE_NAME, TAG_ORDER_TOTAL, TAG_ESTIMATED_TIME, TAG_ORDER_ITEMS],
    defaults: {
      sms: {
        body: `Thanks {{customer_name}}! Order #{{order_number}} confirmed at {{venue_name}}. Total: {{order_total}}.`,
      },
      email: {
        subject: `Order #{{order_number}} confirmed — {{venue_name}}`,
        body: `Hi {{customer_name}},

Your order #{{order_number}} at {{venue_name}} has been confirmed.

{{order_items}}

Order total: {{order_total}}
Estimated time: {{estimated_time}} minutes

Thank you for your order!`,
      },
    },
  },
  {
    type: 'order_status',
    label: 'Order Status Update',
    description: 'Sent when an order status changes (e.g. preparing, dispatched)',
    category: 'Orders',
    channels: ['sms'],
    mergeTags: [TAG_CUSTOMER_NAME, TAG_ORDER_NUMBER, TAG_VENUE_NAME],
    defaults: {
      sms: {
        body: `Hi {{customer_name}}, update on your order #{{order_number}} at {{venue_name}}: your order is now being prepared.`,
      },
    },
  },

  // ── Gift Cards ──────────────────────────────────────────────────────────
  {
    type: 'gift_card_delivery',
    label: 'Gift Card Delivery',
    description: 'Sent to the recipient when a gift card is purchased and fulfilled',
    category: 'Gift Cards',
    channels: ['email', 'sms'],
    mergeTags: [TAG_SENDER_NAME, TAG_RECIPIENT_NAME, TAG_AMOUNT, TAG_CODE, TAG_VENUE_NAME, TAG_MESSAGE, TAG_EXPIRY_DATE, TAG_BALANCE_URL],
    defaults: {
      email: {
        subject: `{{sender_name}} sent you a {{amount}} gift card for {{venue_name}}!`,
        body: `You've received a gift card!

From {{sender_name}} at {{venue_name}}

{{message}}

Gift Card Value: {{amount}}

Your Gift Card Code: {{code}}
Present this code when ordering.

Valid until {{expiry_date}}

Check your balance: {{balance_url}}`,
      },
      sms: {
        body: `{{sender_name}} sent you a {{amount}} gift card for {{venue_name}}! Your code: {{code}}. Present this when ordering.`,
      },
    },
  },
  {
    type: 'gift_card_sender_confirmation',
    label: 'Gift Card Sender Confirmation',
    description: 'Sent to the buyer confirming their gift card has been delivered',
    category: 'Gift Cards',
    channels: ['email'],
    mergeTags: [TAG_SENDER_NAME, TAG_RECIPIENT_NAME, TAG_RECIPIENT_EMAIL, TAG_AMOUNT, TAG_VENUE_NAME, TAG_CODE_LAST4],
    defaults: {
      email: {
        subject: `Your gift card for {{recipient_name}} at {{venue_name}} is on its way!`,
        body: `Gift card sent!

Your {{amount}} gift card for {{venue_name}} has been emailed to {{recipient_name}} at {{recipient_email}}.

Card ending in {{code_last4}}`,
      },
    },
  },

  // ── Tables & Reservations ───────────────────────────────────────────────
  {
    type: 'table_ready',
    label: 'Table Ready',
    description: 'Sent when a table becomes available for a waiting customer',
    category: 'Tables',
    channels: ['sms'],
    mergeTags: [TAG_CUSTOMER_NAME, TAG_VENUE_NAME, TAG_TABLE_NUMBER],
    defaults: {
      sms: {
        body: `Hi {{customer_name}}, your table is ready at {{venue_name}}! Please make your way to the host stand.`,
      },
    },
  },
  {
    type: 'reservation_confirmation',
    label: 'Reservation Confirmation',
    description: 'Sent when a table reservation is confirmed',
    category: 'Tables',
    channels: ['email', 'sms'],
    mergeTags: [TAG_CUSTOMER_NAME, TAG_VENUE_NAME, TAG_DATE, TAG_TIME, TAG_PARTY_SIZE, TAG_CONFIRMATION_NUMBER],
    defaults: {
      sms: {
        body: `Hi {{customer_name}}, reservation confirmed at {{venue_name}} for {{date}} at {{time}}, party of {{party_size}}. Ref: {{confirmation_number}}`,
      },
      email: {
        subject: `Reservation confirmed — {{venue_name}}`,
        body: `Hi {{customer_name}},

Your reservation is confirmed!

Venue: {{venue_name}}
Date: {{date}}
Time: {{time}}
Party size: {{party_size}}
Confirmation: {{confirmation_number}}

We look forward to seeing you!`,
      },
    },
  },

  // ── Receipts ────────────────────────────────────────────────────────────
  {
    type: 'receipt',
    label: 'Digital Receipt',
    description: 'Email receipt sent after payment',
    category: 'Receipts',
    channels: ['email'],
    mergeTags: [TAG_CUSTOMER_NAME, TAG_VENUE_NAME, TAG_ORDER_NUMBER, TAG_ORDER_TOTAL, TAG_ORDER_ITEMS, TAG_DATE, TAG_PAYMENT_METHOD, TAG_SERVER_NAME],
    defaults: {
      email: {
        subject: `Your receipt from {{venue_name}}`,
        body: `Hi {{customer_name}},

Thank you for visiting {{venue_name}}.

Order: #{{order_number}}
Date: {{date}}
Served by: {{server_name}}

{{order_items}}

Total: {{order_total}}
Payment: {{payment_method}}

Thank you for your visit!`,
      },
    },
  },
];

// ── Lookup helpers ──────────────────────────────────────────────────────────

export function getMessageType(type: string): MessageTypeDef | undefined {
  return MESSAGE_TYPES.find(t => t.type === type);
}

export function getDefaultTemplate(type: string, channel: 'email' | 'sms'): ChannelDefault | null {
  const mt = getMessageType(type);
  if (!mt) return null;
  return mt.defaults[channel] || null;
}

/** Build sample data from merge tag examples — used for template preview */
export function buildSampleData(tags: MergeTag[]): Record<string, string> {
  const data: Record<string, string> = {};
  for (const t of tags) data[t.tag] = t.example;
  return data;
}

/** Categories in display order */
export const CATEGORIES = ['Orders', 'Gift Cards', 'Tables', 'Receipts'];
