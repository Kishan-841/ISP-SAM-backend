-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('PROCESSED', 'DUPLICATE', 'REJECTED', 'FAILED');

-- CreateTable
CREATE TABLE "integration_events" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "IntegrationStatus" NOT NULL,
    "status_reason" TEXT,
    "account_id" UUID,
    "payload" JSONB NOT NULL,
    "signature_header" TEXT,
    "timestamp_header" TEXT,
    "remote_addr" TEXT,

    CONSTRAINT "integration_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integration_events_external_event_id_key" ON "integration_events"("external_event_id");

-- CreateIndex
CREATE INDEX "integration_events_source_event_type_idx" ON "integration_events"("source", "event_type");

-- CreateIndex
CREATE INDEX "integration_events_received_at_idx" ON "integration_events"("received_at");

-- CreateIndex
CREATE INDEX "integration_events_status_idx" ON "integration_events"("status");

-- CreateIndex
CREATE INDEX "integration_events_account_id_idx" ON "integration_events"("account_id");
