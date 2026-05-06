-- Cloudinary public_id for the approval file. Kept alongside approval_file_url
-- so we can re-mint URLs (e.g. for signed/auth variants) without re-uploading.
ALTER TABLE "commercial_changes"
  ADD COLUMN "approval_file_public_id" TEXT;
