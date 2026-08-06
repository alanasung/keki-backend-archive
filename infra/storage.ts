// Configuration for the private document bucket, kept as a plain object so
// it can be asserted on directly in tests without deploying anything. This
// bucket holds signed waiver PDFs — documents identifying children — so it
// must never gain a public policy, a website configuration, or a wildcard
// CORS origin. Phase 2 serves these through presigned URLs instead.
export const DOCUMENT_BUCKET_CONFIG = {
  name: "DocumentsBucket",
  /** Neither `public` nor `access` is set: SST grants no public read policy. */
  publicAccess: false,
  /** SST creates a full `BucketPublicAccessBlock` unless explicitly disabled. */
  blockPublicAccess: true,
  versioning: true,
  /** S3 has applied default SSE-S3 encryption to all buckets account-wide since 2023. */
  encryption: true,
  websiteConfiguration: false,
  corsRules: [] as const,
  lifecycleRules: [
    {
      id: "TransitionNoncurrentVersions",
      status: "Enabled",
      noncurrentVersionTransitionDays: 30,
      storageClass: "STANDARD_IA",
    },
  ],
} as const;

export function createDocumentsBucket(): sst.aws.Bucket {
  return new sst.aws.Bucket(DOCUMENT_BUCKET_CONFIG.name, {
    versioning: DOCUMENT_BUCKET_CONFIG.versioning,
    transform: {
      lifecycle: {
        rules: DOCUMENT_BUCKET_CONFIG.lifecycleRules.map((rule) => ({
          id: rule.id,
          status: rule.status,
          noncurrentVersionTransitions: [
            { noncurrentDays: rule.noncurrentVersionTransitionDays, storageClass: rule.storageClass },
          ],
        })),
      },
    },
  });
}
