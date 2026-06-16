// _shared/marketing-merge.ts — merge-tag rendering for marketing messages.
// Used by marketing-send (slice 2), the email/SMS composers (slice 5) and the
// campaign engine (slice 4). Deliberately tiny + dependency-free.
//
// Syntax:  {{first_name}}            → ctx.first_name (or '' if missing)
//          {{first_name|there}}      → ctx.first_name, falling back to "there"
//          {{name}} {{venue}} ...    → any key present in the context object
// Unknown tags with no fallback render as empty string (never leak "{{x}}" to a guest).

export type MergeContext = Record<string, string | number | null | undefined>;

export function renderMergeTags(template: string, ctx: MergeContext): string {
  if (!template) return '';
  return template.replace(/\{\{\s*([a-z0-9_]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/gi, (_m, key, fallback) => {
    const raw = ctx[String(key).toLowerCase()];
    const val = (raw === null || raw === undefined || raw === '') ? undefined : String(raw);
    return val ?? (fallback !== undefined ? String(fallback) : '');
  });
}

// Build the standard merge context from a customer row + any extras (promo_code, venue, etc.).
// first_name falls back to the first token of `name`; `name` falls back to first_name.
export function buildMergeContext(customer: any, extra: MergeContext = {}): MergeContext {
  const first = customer?.first_name || (customer?.name ? String(customer.name).trim().split(/\s+/)[0] : '') || '';
  const full = customer?.name || [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || first || '';
  return {
    first_name: first,
    last_name: customer?.last_name || '',
    name: full,
    full_name: full,
    email: customer?.email || '',
    phone: customer?.phone || '',
    ...extra,
  };
}

// Returns true if the rendered text still contains an obvious unfilled tag (for preview/lint).
export function hasUnresolvedTags(text: string): boolean {
  return /\{\{\s*[a-z0-9_]+\s*(\|[^}]*)?\}\}/i.test(text || '');
}
