/*
  Warnings:

  - You are about to drop the column `meeting_date` on the `meetings` table. All the data in the column will be lost.
  - You are about to drop the column `mom_sent` on the `meetings` table. All the data in the column will be lost.
  - Added the required column `scheduled_at` to the `meetings` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "meetings_meeting_date_idx";

-- AlterTable
ALTER TABLE "meetings" DROP COLUMN "meeting_date",
DROP COLUMN "mom_sent",
ADD COLUMN     "agenda" TEXT,
ADD COLUMN     "held_at" TIMESTAMPTZ(6),
ADD COLUMN     "mom_content" TEXT,
ADD COLUMN     "scheduled_at" TIMESTAMPTZ(6) NOT NULL;

-- CreateIndex
CREATE INDEX "meetings_scheduled_at_idx" ON "meetings"("scheduled_at");
