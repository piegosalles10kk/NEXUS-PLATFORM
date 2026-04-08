import { z } from 'zod';

export const createSecretSchema = z.object({
  keyName: z.string().min(1).regex(/^[A-Z_][A-Z0-9_]*$/, 'Key must be uppercase with underscores (e.g., DATABASE_URL)'),
  value: z.string().min(1),
});

export const updateSecretSchema = z.object({
  value: z.string().min(1),
});

export type CreateSecretInput = z.infer<typeof createSecretSchema>;
export type UpdateSecretInput = z.infer<typeof updateSecretSchema>;
