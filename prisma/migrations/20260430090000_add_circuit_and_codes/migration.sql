-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "bandwidth_mbps" INTEGER,
ADD COLUMN     "circuit_id" TEXT,
ADD COLUMN     "customer_code" TEXT,
ADD COLUMN     "start_of_period_mrr" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "commercial_changes" ADD COLUMN     "new_bandwidth_mbps" INTEGER,
ADD COLUMN     "old_bandwidth_mbps" INTEGER,
ADD COLUMN     "reason" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "accounts_customer_code_key" ON "accounts"("customer_code");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_circuit_id_key" ON "accounts"("circuit_id");

-- Customer code sequence: GAZ-0001 onwards
CREATE SEQUENCE IF NOT EXISTS gaz_customer_code_seq START 1;

CREATE OR REPLACE FUNCTION assign_customer_code() RETURNS trigger AS $$
BEGIN
  IF NEW.customer_code IS NULL THEN
    NEW.customer_code := 'GAZ-' || LPAD(nextval('gaz_customer_code_seq')::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_account_customer_code ON accounts;
CREATE TRIGGER trg_account_customer_code
  BEFORE INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION assign_customer_code();

-- Circuit ID sequence: CKT-0001 onwards
CREATE SEQUENCE IF NOT EXISTS gaz_circuit_id_seq START 1;

CREATE OR REPLACE FUNCTION assign_circuit_id() RETURNS trigger AS $$
BEGIN
  IF NEW.circuit_id IS NULL THEN
    NEW.circuit_id := 'CKT-' || LPAD(nextval('gaz_circuit_id_seq')::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_account_circuit_id ON accounts;
CREATE TRIGGER trg_account_circuit_id
  BEFORE INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION assign_circuit_id();
