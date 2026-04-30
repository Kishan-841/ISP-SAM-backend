-- AlterTable
ALTER TABLE "users" ADD COLUMN     "sam_head_id" UUID;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_sam_head_id_fkey" FOREIGN KEY ("sam_head_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
