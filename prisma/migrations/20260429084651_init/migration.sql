-- CreateEnum
CREATE TYPE "KittyType" AS ENUM ('BASE', 'NEW');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'TERMINATED', 'PENDING');

-- CreateEnum
CREATE TYPE "CommercialChangeType" AS ENUM ('UPGRADE', 'DOWNGRADE', 'RATE_REVISION', 'TERMINATION');

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "client_name" TEXT NOT NULL,
    "kitty_type" "KittyType" NOT NULL,
    "sam_owner_id" UUID,
    "current_mrr" DECIMAL(12,2) NOT NULL,
    "contract_status" "ContractStatus" NOT NULL,
    "last_mom_date" DATE,
    "last_meeting_date" DATE,
    "onboarding_date" DATE NOT NULL,
    "external_crm_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commercial_changes" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "change_type" "CommercialChangeType" NOT NULL,
    "old_mrr" DECIMAL(12,2) NOT NULL,
    "new_mrr" DECIMAL(12,2) NOT NULL,
    "effective_date" DATE NOT NULL,
    "client_approval_attached" BOOLEAN NOT NULL,
    "approval_file_url" TEXT,
    "accounts_notified_date" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commercial_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetings" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "meeting_date" DATE NOT NULL,
    "mom_sent" BOOLEAN NOT NULL DEFAULT false,
    "mom_sent_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "performed_by" UUID NOT NULL,
    "payload" JSONB,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_external_crm_id_key" ON "accounts"("external_crm_id");

-- CreateIndex
CREATE INDEX "accounts_kitty_type_idx" ON "accounts"("kitty_type");

-- CreateIndex
CREATE INDEX "accounts_sam_owner_id_idx" ON "accounts"("sam_owner_id");

-- CreateIndex
CREATE INDEX "commercial_changes_account_id_idx" ON "commercial_changes"("account_id");

-- CreateIndex
CREATE INDEX "commercial_changes_effective_date_idx" ON "commercial_changes"("effective_date");

-- CreateIndex
CREATE INDEX "meetings_account_id_idx" ON "meetings"("account_id");

-- CreateIndex
CREATE INDEX "meetings_meeting_date_idx" ON "meetings"("meeting_date");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_performed_by_idx" ON "audit_logs"("performed_by");

-- AddForeignKey
ALTER TABLE "commercial_changes" ADD CONSTRAINT "commercial_changes_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
