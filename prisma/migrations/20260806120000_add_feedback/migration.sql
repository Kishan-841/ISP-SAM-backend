-- CreateTable
CREATE TABLE "feedbacks" (
    "id" UUID NOT NULL,
    "customer_name" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "sam_id" UUID NOT NULL,
    "responses" JSONB NOT NULL,
    "overall_score" DOUBLE PRECISION,
    "interest_level" TEXT,
    "nps_score" INTEGER,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "feedbacks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feedbacks_sam_id_idx" ON "feedbacks"("sam_id");

-- CreateIndex
CREATE INDEX "feedbacks_submitted_at_idx" ON "feedbacks"("submitted_at");

-- AddForeignKey
ALTER TABLE "feedbacks" ADD CONSTRAINT "feedbacks_sam_id_fkey" FOREIGN KEY ("sam_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
