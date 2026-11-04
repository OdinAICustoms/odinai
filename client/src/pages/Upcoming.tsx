import { T } from '../i18n';

const WHAT: Record<number, string[]> = {
  1: ['Produktregister med identifikatorer, klassifisering og RT-tillatelser', 'RT-tillatelser tilgjengelige fra både klientkortet og produktkortet', 'Alle data flyttet fra ODIN LINK'],
  2: ['Dokumenter inn: faktura, pakkliste, eksportdeklarasjon, T1', 'AI fyller ut deklarasjonen fra registrene', 'Kontroll, godkjenning med fire øyne og sending til TVINN-simulatoren'],
  4: ['Faktura per deklarasjon eller per måned med KID', 'Betalinger avstemt via bankens API', 'Overføring til Fiken']
};

/** A module that comes in a later phase: says what it will contain. */
export function Upcoming({ title, phase }: { title: string; phase: number }) {
  return (
    <section>
      <div className="pagehead"><h2>{T(title)}</h2></div>
      <div className="panelbox">
        <h3>{T('Kommer i fase')} {phase}</h3>
        <ul className="req">{(WHAT[phase] ?? []).map(w => <li key={w}>{T(w)}</li>)}</ul>
      </div>
    </section>
  );
}
