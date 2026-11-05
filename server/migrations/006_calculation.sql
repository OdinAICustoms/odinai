-- 006_calculation.sql — duty and tax calculation (phase 2b).
-- Carried over from ODIN LINK 2.37 (src/duty-calc.js, taxes.js, saeravgift.js, tilleggstoll.js, box12.js).
--
--  * Box 47 levies come from Tolletaten's "Avgifter ved innførsel" (innfoerselsavgift): per commodity code
--    every levy type (MV = VAT, FA = research levy, SU, OL, BV, TO ...) with its group, rate and unit.
--    MV and FA are calculated automatically; for the others the specialist chooses a group and quantity
--    per goods item, or "not applicable" (as in Proteria and ODIN LINK).
--  * Additional customs duty (tilleggstollavgift) applies when the origin is in the rate's country group.
--  * Box 12 value details (freight, insurance, discounts ...) are kept on the declaration and spread over
--    the goods items when calculating; nothing is written back onto the items.

CREATE TABLE ref_import_levy (               -- innfoerselsavgift
  id                bigserial PRIMARY KEY,
  code              text NOT NULL,
  landgruppe        text,
  levy_type         text NOT NULL,           -- MV, FA, SU, OL, BV, TO, ...
  levy_type_text    text,
  levy_group        integer,
  levy_group_text   text,
  rate              numeric,                 -- kroner (øre already divided) or per cent
  unit              text,                    -- P = per cent of the value, otherwise a quantity unit
  unit_text         text,
  valid_from        date,
  valid_to          date
);
CREATE INDEX ref_import_levy_code ON ref_import_levy (code, levy_type);

CREATE TABLE ref_additional_duty (           -- tilleggstollavgiftssats
  id          bigserial PRIMARY KEY,
  code        text NOT NULL,
  landgruppe  text NOT NULL,
  rate        numeric NOT NULL,
  unit        text,                          -- P = per cent of the customs value, K = per kg
  unit_text   text,
  valid_from  date,
  valid_to    date
);
CREATE INDEX ref_additional_duty_code ON ref_additional_duty (code);

-- Levies chosen per goods item: [{type, group | 'NA', qty}].
ALTER TABLE declaration_item ADD COLUMN levies jsonb NOT NULL DEFAULT '[]';

-- Box 12 lines: [{kind: ADD|DED, type, amount, currency: INV|NOK, basis: GROSS|NET|VALUE, text}].
ALTER TABLE declaration ALTER COLUMN value_details SET DEFAULT '[]';
UPDATE declaration SET value_details = '[]' WHERE value_details = '{}'::jsonb;
