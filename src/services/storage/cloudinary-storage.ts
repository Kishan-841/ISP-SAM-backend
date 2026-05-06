import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';

/**
 * Cloudinary-backed storage for commercial-change attachments
 * (approval files + POs — PDF / EML / MSG). Mirrors the CRM-side credentials.
 *
 * Resource type is `raw` because these are non-image documents — Cloudinary
 * stores them as-is, no transcoding. The folder structure is intentionally
 * deep so the UI / Docs reviewer can tell at a glance which commercial change
 * a file belongs to and which kind of document it is:
 *
 *   sam-software/po-and-mail-acceptance/<commercialChangeId>/<kind>/<timestamp>-<filename>
 *
 *   <kind> ∈ { 'approval', 'po' }
 */

/** Document type — determines the sub-folder under each commercial change. */
export type AttachmentKind = 'approval' | 'po';

export type UploadedApprovalFile = {
  publicId: string;
  secureUrl: string;
  bytes: number;
  format: string | null;
  originalFilename: string;
};

export type ApprovalUploadInput = {
  buffer: Buffer;
  originalName: string;
  commercialChangeId: string;
  kind: AttachmentKind;
};

/** The contract the commercial-changes service depends on. Mockable in tests. */
export interface ApprovalFileUploader {
  uploadApprovalFile(input: ApprovalUploadInput): Promise<UploadedApprovalFile>;
}

const APPROVAL_FOLDER_BASE = 'sam-software/po-and-mail-acceptance';

/**
 * Real Cloudinary uploader. Configured lazily on first call so tests that
 * never reach this code path don't need the env vars set.
 */
class CloudinaryUploader implements ApprovalFileUploader {
  private configured = false;

  private ensureConfigured(): void {
    if (this.configured) return;
    const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
    const api_key = process.env.CLOUDINARY_API_KEY;
    const api_secret = process.env.CLOUDINARY_API_SECRET;
    if (!cloud_name || !api_key || !api_secret) {
      throw new Error(
        'Cloudinary credentials not configured: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET must all be set',
      );
    }
    cloudinary.config({ cloud_name, api_key, api_secret, secure: true });
    this.configured = true;
  }

  async uploadApprovalFile(input: ApprovalUploadInput): Promise<UploadedApprovalFile> {
    this.ensureConfigured();

    const safeName = input.originalName
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 120) || input.kind;
    const folder = `${APPROVAL_FOLDER_BASE}/${input.commercialChangeId}/${input.kind}`;
    // For raw resources, Cloudinary uses the public_id verbatim — including
    // the file extension. We prefix with timestamp to avoid collisions if
    // the same change uploads multiple files in test scenarios.
    const publicId = `${Date.now()}-${safeName}`;

    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          folder,
          public_id: publicId,
          use_filename: false,
          unique_filename: false,
          overwrite: false,
        },
        (err, res) => {
          if (err) reject(err);
          else if (!res) reject(new Error('Cloudinary returned no response'));
          else resolve(res);
        },
      );
      stream.end(input.buffer);
    });

    return {
      publicId: result.public_id,
      secureUrl: result.secure_url,
      bytes: result.bytes,
      format: result.format ?? null,
      originalFilename: input.originalName,
    };
  }
}

// Module-level singleton + test seam. Same pattern as the CRM client.

let active: ApprovalFileUploader = new CloudinaryUploader();

export function getApprovalFileUploader(): ApprovalFileUploader {
  return active;
}

/** Test-only — install a stub uploader. */
export function setApprovalFileUploaderForTests(impl: ApprovalFileUploader): void {
  active = impl;
}

/** Test-only — restore the real uploader. */
export function resetApprovalFileUploaderForTests(): void {
  active = new CloudinaryUploader();
}
