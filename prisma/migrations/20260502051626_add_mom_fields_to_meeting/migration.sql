-- CreateEnum
CREATE TYPE "MeetingType" AS ENUM ('ONLINE', 'PHYSICAL');

-- AlterTable
ALTER TABLE "meetings" ADD COLUMN     "action_items" JSONB,
ADD COLUMN     "client_participants" TEXT,
ADD COLUMN     "gazon_participants" TEXT,
ADD COLUMN     "location" TEXT,
ADD COLUMN     "meeting_type" "MeetingType" NOT NULL DEFAULT 'ONLINE';
