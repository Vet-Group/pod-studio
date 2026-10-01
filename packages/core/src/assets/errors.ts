export const ASSET_ERROR_MESSAGES = {
  INVALID_INPUT: 'The asset details are invalid.',
  NOT_FOUND: 'The asset, upload or design does not exist in this store.',
  CHECKSUM_MISMATCH: 'The uploaded file does not match its declared SHA-256.',
  SIZE_MISMATCH: 'The uploaded file does not match its declared size.',
  CONTENT_TYPE_MISMATCH: 'The uploaded file does not match its declared content type.',
  UPLOAD_EXPIRED: 'The upload has expired. Request a new upload URL.',
  UPLOAD_REJECTED: 'This upload was rejected. Request a new upload URL.',
} as const;
export class AssetError extends Error {
  constructor(public readonly code: keyof typeof ASSET_ERROR_MESSAGES) {
    super(ASSET_ERROR_MESSAGES[code]);
    this.name = 'AssetError';
  }
}
