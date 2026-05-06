-- PO (Purchase Order) file alongside the existing approval file.
-- Both stored in Cloudinary; URLs forwarded to CRM in the service-order POST.
ALTER TABLE "commercial_changes"
  ADD COLUMN "po_file_url" TEXT,
  ADD COLUMN "po_file_public_id" TEXT;
