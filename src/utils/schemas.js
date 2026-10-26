import { z } from 'zod';

export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
export const idParam = z.object({ id: objectId });
export const pageQuery = z.object({
  cursor: z.string().optional().transform((v) => v || undefined),
  limit: z.coerce.number().int().min(1).max(50).default(10), // hard max page size: API can't be used to dump the DB
});
