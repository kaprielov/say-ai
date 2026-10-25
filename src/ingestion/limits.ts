// Operator-controlled upload limits; byte counts include UTF-8 encoding.
export const uploadLimits = {
  fileBytes: 20_000_000,
  batchBytes: 50_000_000,
  textBytes: 5 * 1024 * 1024,
  items: 10,
  preparationJobs: 100,
  draftHours: 24,
  httpUploads: 2,
} as const;
