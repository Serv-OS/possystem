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
  // When true, the message BODY is fixed by an external provider (e.g. Twilio Verify)
  // and cannot be freely edited. The BO editor shows `providerNote` + a read-only preview
  // built from the `defaults` body instead of a dead free-text field.
  providerManaged?: boolean;
  providerNote?: string;
  // When true (only meaningful with providerManaged), the operator CAN still edit the one
  // part that varies — the business/venue name shown inside the fixed body. The editor
  // renders a single-line name input; the stored value goes in message_templates.body_text
  // and is read at send time as the Twilio Verify friendlyName. Empty = use the venue name.
  nameEditable?: boolean;
  nameLabel?: string;
  namePlaceholder?: string;
}

// ── Merge tag libraries ─────────────────────────────────────────────────────

const TAG_CUSTOMER_NAME: MergeTag = { tag: 'customer_name', label: 'Customer Name', example: 'Sarah' };
const TAG_ORDER_NUMBER: MergeTag = { tag: 'order_number', label: 'Order Number', example: '1042' };
const TAG_VENUE_NAME: MergeTag = { tag: 'venue_name', label: 'Venue Name', example: 'The Red Lion' };
const TAG_ORDER_TOTAL: MergeTag = { tag: 'order_total', label: 'Order Total', example: '£27.50' };
// Two tags, two fixed units, because one tag carrying both was unusable: the
// send path put "15-20" in it for ASAP orders and a clock time like "18:15" in
// it for pre-orders, so every email read "Estimated time: 18:15 minutes" and no
// operator could write a sentence that was right for both.
const TAG_ESTIMATED_TIME: MergeTag = { tag: 'estimated_time', label: 'Est. wait (minutes)', example: '35' };
const TAG_COLLECTION_TIME: MergeTag = { tag: 'collection_time', label: 'Ready at (venue clock)', example: '18:15' };
const TAG_TABLE_NUMBER: MergeTag = { tag: 'table_number', label: 'Table Number', example: '12' };
const TAG_DATE: MergeTag = { tag: 'date', label: 'Date', example: '24 May 2026' };
const TAG_TIME: MergeTag = { tag: 'time', label: 'Time', example: '7:30 PM' };
const TAG_PARTY_SIZE: MergeTag = { tag: 'party_size', label: 'Party Size', example: '4' };
const TAG_CONFIRMATION_NUMBER: MergeTag = { tag: 'confirmation_number', label: 'Confirmation #', example: 'RES-4821' };
const TAG_PAYMENT_METHOD: MergeTag = { tag: 'payment_method', label: 'Payment Method', example: 'Visa ****6411' };
const TAG_SERVER_NAME: MergeTag = { tag: 'server_name', label: 'Server Name', example: 'Alex' };
const TAG_ORDER_ITEMS: MergeTag = { tag: 'order_items', label: 'Order Items', example: '2x Margherita Pizza  £24.00\n  £12.00 each\n  + Extra cheese\n1x Caesar Salad  £8.50\n1x House Lager  £5.50\n\nSubtotal: £38.00\nService charge: £4.75\n\nStandard VAT (20%): Net £31.67 — VAT £6.33' };
const TAG_SENDER_NAME: MergeTag = { tag: 'sender_name', label: 'Sender Name', example: 'James' };
const TAG_RECIPIENT_NAME: MergeTag = { tag: 'recipient_name', label: 'Recipient Name', example: 'Emma' };
const TAG_RECIPIENT_EMAIL: MergeTag = { tag: 'recipient_email', label: 'Recipient Email', example: 'emma@example.com' };
const TAG_AMOUNT: MergeTag = { tag: 'amount', label: 'Amount', example: '£25.00' };
const TAG_CODE: MergeTag = { tag: 'code', label: 'Gift Card Code', example: 'ABCD EFGH JKLM NPQR' };
const TAG_CODE_LAST4: MergeTag = { tag: 'code_last4', label: 'Code Last 4', example: 'NPQR' };
const TAG_EXPIRY_DATE: MergeTag = { tag: 'expiry_date', label: 'Expiry Date', example: 'May 2027' };
const TAG_BALANCE_URL: MergeTag = { tag: 'balance_url', label: 'Balance Check URL', example: 'https://venue.app.serv-os.app/gift/balance' };
const TAG_MESSAGE: MergeTag = { tag: 'message', label: 'Personal Message', example: 'Happy Birthday! Enjoy a meal on us.' };
const TAG_COLLECTION_POINT: MergeTag = { tag: 'collection_point', label: 'Collection Point', example: 'the counter' };
const TAG_PORTAL_URL: MergeTag = { tag: 'portal_url', label: 'Loyalty Portal URL', example: 'https://venue.serv-os.app/account' };
const TAG_OTP_CODE: MergeTag = { tag: 'otp_code', label: 'Verification Code', example: '482917' };

// Booking tags. The *_line tags are composite sentences the sender builds and
// leaves EMPTY when they don't apply (no package / no choices needed), so one
// template reads correctly for every booking.
const TAG_PACKAGE_NAME: MergeTag = { tag: 'package_name', label: 'Package Name', example: 'Tasting Menu · 7 course' };
const TAG_PACKAGE_LINE: MergeTag = { tag: 'package_line', label: 'Package Clause (auto, empty if no package)', example: 'with Tasting Menu · 7 course ' };
const TAG_PREORDER_LINK: MergeTag = { tag: 'preorder_link', label: 'Choose-menu Link', example: 'https://venue.serv-os.app/book?preorder=abc123' };
const TAG_PREORDER_LINK_LINE: MergeTag = { tag: 'preorder_link_line', label: 'Choose-menu Sentence (auto, empty if no choices needed)', example: 'Choose your menu: https://venue.serv-os.app/book?preorder=abc123 ' };

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
    mergeTags: [TAG_CUSTOMER_NAME, TAG_ORDER_NUMBER, TAG_VENUE_NAME, TAG_ORDER_TOTAL, TAG_ESTIMATED_TIME, TAG_COLLECTION_TIME, TAG_ORDER_ITEMS],
    defaults: {
      sms: {
        body: `Thanks {{customer_name}}! Order #{{order_number}} confirmed at {{venue_name}}. Ready around {{collection_time}}. Total: {{order_total}}.`,
      },
      email: {
        subject: `Order #{{order_number}} confirmed — {{venue_name}}`,
        body: `Hi {{customer_name}},

Your order #{{order_number}} at {{venue_name}} has been confirmed.

{{order_items}}

Order total: {{order_total}}
Ready around {{collection_time}} (about {{estimated_time}} minutes)

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
    description: 'VAT-compliant email receipt sent after payment. The receipt body (items, prices, VAT breakdown) is auto-generated — customise the greeting and subject line here.',
    category: 'Receipts',
    channels: ['email'],
    mergeTags: [TAG_CUSTOMER_NAME, TAG_VENUE_NAME, TAG_ORDER_NUMBER, TAG_ORDER_TOTAL, TAG_ORDER_ITEMS, TAG_DATE, TAG_PAYMENT_METHOD, TAG_SERVER_NAME],
    defaults: {
      email: {
        subject: `Your receipt from {{venue_name}} — #{{order_number}}`,
        body: `Hi {{customer_name}},

Thank you for visiting {{venue_name}}. Here is your receipt.

Order #{{order_number}}
Date: {{date}}
Served by: {{server_name}}

{{order_items}}

Total: {{order_total}}
Payment: {{payment_method}}

Thank you for your visit!`,
      },
    },
  },

  // ── Loyalty ────────────────────────────────────────────────────────────
  {
    type: 'loyalty_welcome',
    label: 'Loyalty Welcome',
    description: 'Sent when a customer first joins your loyalty programme (first OTP login or first online order)',
    category: 'Loyalty',
    channels: ['sms', 'email'],
    mergeTags: [TAG_CUSTOMER_NAME, TAG_VENUE_NAME, TAG_PORTAL_URL],
    defaults: {
      sms: {
        body: `Hi {{customer_name}}! Welcome to {{venue_name}}! You're now earning loyalty points on every order. Earn rewards, track gift cards, and more.\n\nView your account: {{portal_url}}`,
      },
      email: {
        subject: `Welcome to {{venue_name}}!`,
        body: `Hi {{customer_name}},

Thanks for joining the {{venue_name}} loyalty programme! You can now earn points every time you order, unlock exclusive rewards, and track your gift cards — all in one place.

View your loyalty account: {{portal_url}}

Earn points on every order · Redeem rewards · Birthday treats · Gift card balance`,
      },
    },
  },
  {
    type: 'loyalty_otp',
    label: 'Verification Code',
    description: 'One-time verification code sent when a customer logs in via phone number',
    category: 'Loyalty',
    channels: ['sms'],
    mergeTags: [TAG_VENUE_NAME, TAG_OTP_CODE],
    providerManaged: true,
    nameEditable: true,
    nameLabel: 'Business name shown in the verification text',
    namePlaceholder: 'Leave blank to use your venue name',
    providerNote: 'For security and reliable delivery, verification codes are sent by our '
      + 'trusted SMS verification service, so the wording and expiry are fixed. You can still '
      + 'set the business name that appears in the text below — leave it blank to use your venue name.',
    defaults: {
      sms: {
        body: `Your {{venue_name}} verification code is: {{otp_code}}. Valid for 5 minutes.`,
      },
    },
  },

  // ── Bookings ────────────────────────────────────────────────────────────
  {
    type: 'booking_confirmation',
    label: 'Booking Confirmation',
    description: 'Sent by SMS and email the moment a table booking is made (widget or host stand)',
    category: 'Bookings',
    channels: ['email', 'sms'],
    mergeTags: [TAG_CUSTOMER_NAME, TAG_VENUE_NAME, TAG_DATE, TAG_TIME, TAG_PARTY_SIZE, TAG_PACKAGE_NAME, TAG_PACKAGE_LINE, TAG_PREORDER_LINK, TAG_PREORDER_LINK_LINE],
    defaults: {
      sms: {
        body: `{{venue_name}}: table for {{party_size}} booked {{package_line}}on {{date}} at {{time}}. {{preorder_link_line}}Need to change it? Call the venue.`,
      },
      email: {
        subject: `Booking confirmed: {{venue_name}}, {{date}}`,
        body: `Hi {{customer_name}},

Your table for {{party_size}} at {{venue_name}} is booked {{package_line}}for {{date}} at {{time}}.

{{preorder_link_line}}

Need to change anything? Just call the venue.`,
      },
    },
  },
  {
    type: 'booking_preorder_reminder',
    label: 'Pre-order Reminder',
    description: 'Nudges a guest to complete their menu choices once the package deadline window opens',
    category: 'Bookings',
    channels: ['email', 'sms'],
    mergeTags: [TAG_CUSTOMER_NAME, TAG_VENUE_NAME, TAG_DATE, TAG_TIME, TAG_PARTY_SIZE, TAG_PACKAGE_NAME, TAG_PREORDER_LINK],
    defaults: {
      sms: {
        body: `{{venue_name}}: your {{package_name}} on {{date}} needs everyone's menu choices. Pick here: {{preorder_link}}`,
      },
      email: {
        subject: `Choose your menu: {{venue_name}}, {{date}}`,
        body: `Hi {{customer_name}},

Your table for {{party_size}} at {{venue_name}} on {{date}} at {{time}} includes {{package_name}}. The kitchen needs everyone's choices.

Choose your menu: {{preorder_link}}

It takes a minute per guest.`,
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
export const CATEGORIES = ['Orders', 'Gift Cards', 'Tables', 'Bookings', 'Receipts', 'Loyalty'];
