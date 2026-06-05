-- Fix the customer_code / circuit_id auto-assign triggers.
--
-- The original triggers used `LPAD(nextval(...)::text, 4, '0')`. PostgreSQL's
-- LPAD function *truncates* (from the right) when the input is longer than
-- the target width. So once the sequence crosses 9999:
--   LPAD('10000', 4, '0')  → '1000'   collides with row #1000
--   LPAD('10001', 4, '0')  → '1000'   ← same string
--
-- Naive replacement using `to_char(n, 'FM0000')` ALSO fails — it returns
-- '####' on overflow (the format pattern has only 4 digit slots).
--
-- Correct fix: branch on the sequence value. Below 10000, keep zero-padded
-- 4-digit format for visual continuity with existing GAZ-XXXX codes. Above,
-- emit the raw number (so GAZ-10000, GAZ-10001, … grow naturally with no
-- collisions).

CREATE OR REPLACE FUNCTION assign_customer_code() RETURNS trigger AS $$
DECLARE
  seq_val bigint;
BEGIN
  IF NEW.customer_code IS NULL THEN
    seq_val := nextval('gaz_customer_code_seq');
    IF seq_val < 10000 THEN
      NEW.customer_code := 'GAZ-' || LPAD(seq_val::text, 4, '0');
    ELSE
      NEW.customer_code := 'GAZ-' || seq_val::text;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION assign_circuit_id() RETURNS trigger AS $$
DECLARE
  seq_val bigint;
BEGIN
  IF NEW.circuit_id IS NULL THEN
    seq_val := nextval('gaz_circuit_id_seq');
    IF seq_val < 10000 THEN
      NEW.circuit_id := 'CKT-' || LPAD(seq_val::text, 4, '0');
    ELSE
      NEW.circuit_id := 'CKT-' || seq_val::text;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
