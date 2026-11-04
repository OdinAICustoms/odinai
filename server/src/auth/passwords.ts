import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { config } from '../config.js';

export const hash = (pw: string) => bcrypt.hash(pw, 12);
export const verify = (pw: string, h: string) => bcrypt.compare(pw, h);

/** Rules for a new password; returns the Norwegian message for the first rule broken, or null. */
export function weakness(pw: string, email = ''): string | null {
  if (pw.length < config.login.minPasswordLength) return `Passordet må ha minst ${config.login.minPasswordLength} tegn.`;
  if (!/[A-Za-zÆØÅæøå]/.test(pw) || !/\d/.test(pw)) return 'Passordet må ha både bokstaver og tall.';
  const local = email.split('@')[0]?.toLowerCase();
  if (local && local.length >= 3 && pw.toLowerCase().includes(local)) return 'Passordet kan ikke inneholde e-postadressen.';
  return null;
}

/** A temporary password for a new or reset user: 16 characters, letters and digits. */
export function temporary(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (const b of crypto.randomBytes(16)) s += abc[b % abc.length];
  return /\d/.test(s) ? s : s.slice(0, 15) + '7';
}
