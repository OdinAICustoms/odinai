/**
 * Fetching from data.toll.no (a CKAN portal: dataset metadata first, then its JSON resource)
 * and plain files (Posten's postal code register). Read-only, so retrying is safe.
 */
const BASE = process.env.TOLL_DATA_BASE || 'https://data.toll.no';
const TIMEOUT_MS = Number(process.env.TOLL_TIMEOUT_MS || 90000);
const RETRIES = Number(process.env.TOLL_RETRIES || 2);
const UA = 'OdinAi/0.1 reference-data (ODIN CUSTOMS AS)';

/** A network failure turned into something a person can act on. */
function explain(err: any, url: string): Error {
  const all = `${err?.message ?? err} ${err?.cause?.code ?? ''}`;
  if (/CERT|unable to get local issuer|SELF_SIGNED/i.test(all))
    return new Error(`Sertifikatkontrollen stoppet ${url}. Nettverket avskjærer trolig HTTPS; sett NODE_EXTRA_CA_CERTS til bedriftens rotsertifikat.`);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET/i.test(all))
    return new Error(`Kan ikke nå ${url}. Kontroller internettforbindelsen.`);
  if (/abort|timeout|ETIMEDOUT/i.test(all))
    return new Error(`Tidsavbrudd etter ${TIMEOUT_MS / 1000} s mot ${url}. Prøv igjen senere.`);
  return new Error(`Henting feilet for ${url}: ${err?.message ?? err}`);
}

export async function get(url: string, attempt = 0): Promise<Response> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' } });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${r.statusText}`), { status: r.status });
    return r;
  } catch (e: any) {
    if (attempt < RETRIES && !(e?.status >= 400 && e?.status < 500)) {
      await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
      return get(url, attempt + 1);
    }
    throw e?.status ? e : explain(e, url);
  }
}

/** A dataset's JSON payload from data.toll.no. */
export async function ckanDataset(id: string): Promise<{ data: unknown; url: string }> {
  const metaUrl = `${BASE}/api/3/action/package_show?id=${encodeURIComponent(id)}`;
  const meta: any = await (await get(metaUrl)).json();
  if (!meta?.success || !meta.result) throw new Error(`Datasettet «${id}» ble ikke funnet på ${BASE}.`);
  const res = (meta.result.resources ?? []) as { format?: string; url?: string }[];
  const json = res.find(r => String(r.format || '').toUpperCase() === 'JSON') ?? res.find(r => /\.json(\?|$)/i.test(String(r.url || '')));
  if (!json?.url) throw new Error(`Datasettet «${id}» har ingen JSON-fil (formater: ${res.map(r => r.format).join(', ') || 'ingen'}).`);
  return { data: await (await get(json.url)).json(), url: json.url };
}

/** A text file in the given encoding (Posten publishes the postal code register in Windows-1252). */
export async function textFile(url: string, encoding = 'utf-8'): Promise<{ text: string; url: string }> {
  const buf = await (await get(url)).arrayBuffer();
  return { text: new TextDecoder(encoding).decode(buf), url };
}

export type Fetchers = { ckanDataset: typeof ckanDataset; textFile: typeof textFile };
export const liveFetchers: Fetchers = { ckanDataset, textFile };
