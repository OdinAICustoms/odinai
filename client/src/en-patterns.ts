/**
 * English for server messages that carry values (box, goods item, amount, name). T() tries the exact
 * text in en.ts first, then these patterns in order; `t` translates a part again (e.g. the rest of
 * "Varepost 3: …"). Keep a pattern next to the rule that writes the message (server/src/declarations/rules.ts).
 */
type Tr = (s: string) => string;
export const EN_PATTERNS: [RegExp, (m: RegExpMatchArray, t: Tr) => string][] = [
  [/^Varepost (\d+): (.+)$/s, (m, t) => `Goods item ${m[1]}: ${t(m[2])}`],
  [/^Rubrikk (\S+) \((.+)\) er obligatorisk\.$/, (m, t) => `Box ${m[1]} (${t(m[2])}) is mandatory.`],
  [/^Valuta (\w+) finnes ikke i Tolletatens valutaliste\.$/, m => `Currency ${m[1]} is not in Norwegian Customs' currency list.`],
  [/^Rubrikk (\d+): (.+) er inaktiv og kan ikke brukes i en ny deklarasjon\.$/, m => `Box ${m[1]}: ${m[2]} is inactive and cannot be used in a new declaration.`],
  [/^Rubrikk (\d+): (.+) har ingen (.+)-rolle per (.+)\. Legg til rollen i Forretningspartner\.$/,
    m => `Box ${m[1]}: ${m[2]} has no ${m[3].replace(' eller ', ' or ')} role on ${m[4]}. Add the role in Business partners.`],
  [/^Rubrikk (\d+): (.+) har ingen standardadresse gyldig per (.+)\.$/, m => `Box ${m[1]}: ${m[2]} has no standard address valid on ${m[3]}.`],
  [/^Rubrikk (\d+): (.+) er (.+) ifølge Brønnøysund \(kontrollert (.+)\)\.$/, m => `Box ${m[1]}: ${m[2]} is ${m[3].replace('slettet fra Enhetsregisteret', 'deleted from the Register of Business Enterprises')
    .replace('under tvangsavvikling', 'in compulsory dissolution').replace('under avvikling', 'being wound up').replace('konkurs', 'bankrupt')} according to Brønnøysund (checked ${m[4]}).`],
  [/^Rubrikk 8: (.+) er ikke registrert i Merverdiavgiftsregisteret ifølge Brønnøysund\. (.+)$/,
    m => `Box 8: ${m[1]} is not in the VAT Register according to Brønnøysund. Check how the import VAT is to be settled.`],
  [/^Rubrikk (\d+): EORI (\S+) for (.+) er ikke gyldig ifølge EUs EORI-tjeneste\.$/, m => `Box ${m[1]}: EORI ${m[2]} for ${m[3]} is not valid according to the EU EORI service.`],
  [/^Rubrikk 8: (.+) mangler organisasjonsnummer eller fødselsnummer\.$/, m => `Box 8: ${m[1]} has no organisation number or national identity number.`],
  [/^Rubrikk 14: fullmakten fra (.+) til (.+) utløp (.+)\.$/, m => `Box 14: the power of attorney from ${m[1]} to ${m[2]} expired ${m[3]}.`],
  [/^Rubrikk 14: ingen gyldig fullmakt fra (.+) til (.+) per (.+)\. Registrer den (.+)$/,
    m => `Box 14: no valid power of attorney from ${m[1]} to ${m[2]} on ${m[3]}. Register it on the partner card (Links and power of attorney tab).`],
  [/^Rubrikk 14: fullmakten fra (.+) gjelder bare utførsel\.$/, m => `Box 14: the power of attorney from ${m[1]} covers export only.`],
  [/^Rubrikk A: (.+) finnes ikke i Tolletatens liste over ekspedisjonsenheter\. Velg tollstedet på nytt\.$/, m => `Box A: ${m[1]} is not in Norwegian Customs' list of customs offices. Choose the office again.`],
  [/^Rubrikk A: (.+) er en ekspedisjonsenhet for utførsel\.$/, m => `Box A: ${m[1]} is a customs office for export.`],
  [/^Rubrikk A: (.+) er ikke gyldig på deklarasjonsdatoen\.$/, m => `Box A: ${m[1]} is not valid on the declaration date.`],
  [/^Rubrikk 44-kode (\S+) mangler referanse\.$/, m => `Box 44 code ${m[1]} has no reference.`],
  [/^Rubrikk 22 \((.+)\) avviker fra summen av varenes pris \((.+)\) med (.+)\.$/, m => `Box 22 (${m[1]}) differs from the sum of the item prices (${m[2]}) by ${m[3]}.`],
  [/^Deklarasjonsdatoen er (\d+) dager gammel\. TVINN avviser deklarasjonsdato eldre enn (\d+) dager \((\d+)\)\.$/,
    m => `The declaration date is ${m[1]} days old. TVINN rejects a declaration date older than ${m[2]} days (${m[3]}).`],
  [/^Ingen publisert tollkurs for (\w+) på (.+)\.$/, m => `No published customs rate for ${m[1]} on ${m[2]}.`],
  [/^Rubrikk 48: velg konto for (tollkreditt|dagsoppgjør)\.$/, m => `Box 48: choose the account for ${m[1] === 'tollkreditt' ? 'customs credit' : 'daily settlement'}.`],
  [/^Kredittkonto (\d+) er ikke registrert\. (.+)$/, m => `Credit account ${m[1]} is not registered. TVINN rejects with 9110 when the declarant does not hold the stated agreement.`],
  [/^Kredittkonto (\d+) er ikke aktiv\.$/, m => `Credit account ${m[1]} is not active.`],
  [/^Kredittavtale (\d+) utløp (.+)\.$/, m => `Credit agreement ${m[1]} expired ${m[2]}.`],
  [/^Rubrikk 48: konto (\d+) er registrert for (\S+), ikke (\S+)\.$/, m => {
    const k = (s: string) => (s === 'tollkreditt' ? 'customs credit' : 'daily settlement');
    return `Box 48: account ${m[1]} is registered for ${k(m[2])}, not ${k(m[3])}.`;
  }],
  [/^Rubrikk 37: varepost (.+) har en prosedyre som ikke er midlertidig innførsel\. (.+)$/, m => `Box 37: goods item ${m[1]} has a procedure that is not temporary import. Choose a 5xxx procedure (e.g. 5000).`],
  [/^Rubrikk 44: varepost (.+) mangler TXT (.+)$/, m => `Box 44: goods item ${m[1]} has no TXT with the purpose/legal basis for temporary import.`],
  [/^Rubrikk 37: varepost (.+) har midlertidig innførsel \(5xxx\), (.+)$/, m => `Box 37: goods item ${m[1]} has temporary import (5xxx), but box 1 is 4 (free circulation). Check box 1.`],
  // Goods item rules (after "Varepost n: ").
  [/^varenummer (\d+) finnes ikke i tolltariffen\.$/, m => `commodity code ${m[1]} is not in the customs tariff.`],
  [/^(\d+) er ikke et deklarerbart åttesifret varenummer\.$/, m => `${m[1]} is not a declarable eight-digit commodity code.`],
  [/^varenummeret krever mengde i annen enhet \((.+)\)\.$/, m => `the commodity code requires a quantity in another unit (${m[1]}).`],
  [/^varenummer (\d+) er ikke gyldig på deklarasjonsdatoen\.$/, m => `commodity code ${m[1]} is not valid on the declaration date.`],
  [/^prosedyrekode (\d+) finnes ikke i TVINN\.$/, m => `procedure code ${m[1]} does not exist in TVINN.`],
  [/^tollkvote (\S+) finnes ikke\.$/, m => `tariff quota ${m[1]} does not exist.`],
  [/^varenummeret er ikke omfattet av tollkvote (\S+)\.$/, m => `the commodity code is not covered by tariff quota ${m[1]}.`],
  [/^tollkvote (\S+) gjelder (.*)\.$/, m => `tariff quota ${m[1]} applies ${m[2]}.`],
  [/^preferansekode (\w) kreves, (.+)$/, m => `preference code ${m[1]} is claimed, but no proof of origin (SER) is entered in box 44.`],
  [/^rubrikk 44-kode (\S+) mangler referanse\.$/, m => `box 44 code ${m[1]} has no reference.`],
  [/^rubrikk 44 (\S+) (.*) utløp (\S+) \(før deklarasjonsdatoen\)\.$/, m => `box 44 ${m[1]} ${m[2]} expired ${m[3]} (before the declaration date).`],
  [/^produkt (\S+) er ikke kontrollert i produktregisteret \((\w+)\)\.$/, m => `product ${m[1]} is not checked in the product register (${m[2]}).`],
  [/^mulig duplikat av varepost (\d+)\.$/, m => `possible duplicate of goods item ${m[1]}.`],
  // Format errors on save.
  [/^(Rubrikk \S+) (må ha seks siffer|må ha 8 siffer|har fire siffer|må være en landkode med to bokstaver|må være en valutakode med tre bokstaver)\.$/, m => `${m[1].replace('Rubrikk', 'Box')} ${{
    'må ha seks siffer': 'must have six digits', 'må ha 8 siffer': 'must have 8 digits', 'har fire siffer': 'has four digits',
    'må være en landkode med to bokstaver': 'must be a two-letter country code', 'må være en valutakode med tre bokstaver': 'must be a three-letter currency code' }[m[2]]}.`],
  [/^(.+): ukjent verdi «(.+)»\.$/, m => `${m[1].replace('Rubrikk', 'Box')}: unknown value "${m[2]}".`],
  [/^(.+): må være et tall som er null eller større\.$/, m => `${m[1].replace('Rubrikk', 'Box')}: must be a number of zero or more.`],
  [/^(.+): må være et helt tall\.$/, m => `${m[1].replace('Rubrikk', 'Box')}: must be a whole number.`],
  [/^(.+): ugyldig dato\.$/, m => `${m[1].replace('Rubrikk', 'Box')}: invalid date.`],
  [/^Deklarasjonen har status (\w+) og kan ikke endres\.$/, m => `The declaration has status ${m[1]} and cannot be changed.`],
  [/^(Klienten|Avsenderen|Mottakeren|Deklaranten) finnes ikke i Forretningspartner\.$/, m => `The ${{ Klienten: 'client', Avsenderen: 'consignor', Mottakeren: 'consignee', Deklaranten: 'declarant' }[m[1]]} is not in Business partners.`]
];
