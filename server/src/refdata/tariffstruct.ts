/**
 * Tolletaten's tolltariffstruktur: a tree avsnitt > kapittel > posisjon > ... > vare.
 * Leaves: { type: 'vare', id: '01012100', hsNummer: '010121', vareslag: 'til avl', blv: false }.
 * Upper levels: { type, id, beskrivelse, <child arrays> }.
 */
export interface TariffNode {
  digits: string; type: string; text: string | null; pathText: string | null;
  hs: string | null; blv: boolean | null; section: string | null;
}

// Arrays that hold facts about a node, not child nodes.
const NOT_CHILDREN = new Set(['henvisninger']);

/** The structure still carries HTML entities (`flytende &#34;mango chutney&#34;`). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

const nodeText = (n: any): string | null => {
  const t = n?.beskrivelse ?? n?.vareslag;
  return t == null ? null : decodeEntities(String(t).trim()) || null;
};

/** Flatten the tree; each node carries its ancestors' texts below section level. */
export function flatten(sections: any[]): TariffNode[] {
  const out: TariffNode[] = [];
  const walk = (node: any, section: string | null, chain: string[]) => {
    if (!node || typeof node !== 'object' || !node.type) return;
    const id = node.id != null ? String(node.id) : null;
    const text = nodeText(node);
    const next = node.type === 'avsnitt' ? [] : [...chain, text].filter((x): x is string => !!x);
    const sec = node.type === 'avsnitt' ? id : section;
    if (id) out.push({
      digits: id.replace(/\D/g, ''), type: node.type, text, pathText: next.join(' > ') || text,
      hs: node.hsNummer != null ? String(node.hsNummer) : null,
      blv: typeof node.blv === 'boolean' ? node.blv : null, section: sec
    });
    for (const [k, v] of Object.entries(node)) {
      if (NOT_CHILDREN.has(k) || !Array.isArray(v)) continue;
      for (const child of v) walk(child, sec, next);
    }
  };
  for (const s of sections ?? []) walk(s, null, []);
  return out;
}

/** Level from the published type, falling back to the number of digits. */
export function levelOf(type: string | null | undefined, digits: string): 'Chapter' | 'Heading' | 'Subheading' | 'Code' | 'Other' {
  const t = String(type || '').toLowerCase();
  if (t === 'vare' || digits.length >= 8) return 'Code';
  if (t === 'kapittel' || digits.length === 2) return 'Chapter';
  if (t === 'posisjon' || digits.length === 4) return 'Heading';
  if (t === 'underposisjon' || t === 'oppdeling' || digits.length === 6) return 'Subheading';
  return 'Other';
}
