/* Norwegian is the base language: screen texts are written in Norwegian and T() returns the
 * English text from en.ts when the user has chosen English. Missing translations stay Norwegian. */
import { EN } from './en';
import { EN_PATTERNS } from './en-patterns';

export type Lang = 'no' | 'en';
let lang: Lang = (() => { try { return (localStorage.getItem('odinai_lang') as Lang) || 'no'; } catch { return 'no'; } })();

export const getLang = () => lang;
export function setLang(l: Lang) {
  lang = l;
  try { localStorage.setItem('odinai_lang', l); } catch { /* private window */ }
  document.documentElement.lang = l === 'en' ? 'en' : 'no';
}
export const T = (s: string): string => {
  if (lang !== 'en') return s;
  const hit = EN[s];
  if (hit !== undefined) return hit;
  // Messages with values (box, item, name): en-patterns.ts.
  for (const [re, f] of EN_PATTERNS) { const m = s.match(re); if (m) return f(m, T); }
  return s;
};
export const locale = () => (lang === 'en' ? 'en-GB' : 'nb-NO');
export const fmtDateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' }) : '';
