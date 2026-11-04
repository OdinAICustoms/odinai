/**
 * Roles and what they may do. A user holds one or more roles; a permission is granted
 * when any of them has it. Every write route names the permission it needs (src/auth/guard.ts).
 * Decided with Odin 2026-11-04: every role that edits products may also mark them as checked.
 */
export const PERMISSIONS = [
  'declaration.read', 'declaration.edit', 'declaration.approve',
  'partner.edit', 'partner.manage',
  'product.edit', 'product.check',
  'invoice.read', 'invoice.edit', 'invoice.issue',
  'users.manage', 'settings.edit', 'audit.read'
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES: Record<string, { label: { no: string; en: string }; perms: Permission[] }> = {
  specialist: { label: { no: 'Tollspesialist', en: 'Customs specialist' },
    perms: ['declaration.read', 'declaration.edit', 'partner.edit', 'product.edit', 'product.check', 'invoice.read'] },
  approver: { label: { no: 'Godkjenner', en: 'Approver' },
    perms: ['declaration.read', 'declaration.edit', 'declaration.approve', 'partner.edit', 'partner.manage', 'product.edit', 'product.check', 'invoice.read'] },
  finance: { label: { no: 'Økonomi', en: 'Finance' },
    perms: ['declaration.read', 'invoice.read', 'invoice.edit', 'invoice.issue', 'partner.edit'] },
  admin: { label: { no: 'Administrator', en: 'Administrator' },
    perms: ['declaration.read', 'users.manage', 'settings.edit', 'audit.read', 'partner.manage', 'invoice.read'] },
  viewer: { label: { no: 'Leser', en: 'Viewer' },
    perms: ['declaration.read', 'invoice.read', 'audit.read'] }
};

export const isRole = (r: string) => Object.prototype.hasOwnProperty.call(ROLES, r);

export function permsOf(roles: string[]): Permission[] {
  const s = new Set<Permission>();
  for (const r of roles) for (const p of ROLES[r]?.perms ?? []) s.add(p);
  return [...s].sort();
}
