-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'SAM_HEAD', 'SAM');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_sam_owner_id_fkey" FOREIGN KEY ("sam_owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
