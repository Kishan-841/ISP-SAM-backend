/*
  Warnings:

  - A unique constraint covering the columns `[lead_id]` on the table `accounts` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "company_name" TEXT,
ADD COLUMN     "current_plan" TEXT,
ADD COLUMN     "lead_id" TEXT,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "mobile_number" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "accounts_lead_id_key" ON "accounts"("lead_id");
