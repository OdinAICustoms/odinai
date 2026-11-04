/* Norwegian is the base language: screen texts are written in Norwegian and T() returns the
 * English text from en.ts when the user has chosen English. Missing translations stay Norwegian. */
import { EN } from './en';

export type Lang = 'no' | 'en';
let lang: Lang = (() => { try { return (localStorage.getItem('odinai_lang') as Lang) || 'no'; } catch { return 'no'; } })();

export const getLang = () => lang;
export function setLang(l: Lang) {
  lang = l;
  try { localStorage.setItem('odinai_lang', l); } catch { /* private window */ }
  document.documentElement.lang = l === 'en' ? 'en' : 'no';
}
export const T = (s: string): string => (lang === 'en' ? EN[s] ?? s : s);
export const locale = () => (lang === 'en' ? 'en-GB' : 'nb-NO');
export const fmtDateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' }) : '';
