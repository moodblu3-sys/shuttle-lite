import { z } from 'zod';

// Application budgets, not Box API limits. Parts share one budget across all files.
export const MAX_FILE_CONCURRENCY = 5;
export const MAX_CHUNK_CONCURRENCY = 4;
const identifier = z
  .string()
  .trim()
  .max(255)
  .regex(/^([A-Za-z_][A-Za-z0-9_$]*)?$/);
export const RuntimeSettingsSchema = z.strictObject({
  aiEnabled: z.boolean(),
  fileConcurrency: z.number().int().min(1).max(MAX_FILE_CONCURRENCY),
  chunkConcurrency: z.number().int().min(1).max(MAX_CHUNK_CONCURRENCY),
  logSink: z.enum(['jsonl', 'snowflake']),
  logFolder: z
    .string()
    .min(1)
    .max(4096)
    .refine((v) => !v.includes('\0')),
  snowflake: z.strictObject({
    account: z
      .string()
      .trim()
      .max(255)
      .regex(/^([A-Za-z0-9][A-Za-z0-9_.-]*)?$/),
    username: identifier,
    warehouse: identifier,
    database: identifier,
    schema: identifier,
    role: identifier,
    table: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z_][A-Za-z0-9_$]*$/),
  }),
});
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;
