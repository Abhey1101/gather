import { ZodError } from 'zod';
import { ApiError } from '../utils/errors.js';

export const notFound = (req, res) => res.status(404).json({ error: 'Not found' });

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) return res.status(400).json({ error: 'Validation failed', details: err.flatten() });
  if (err instanceof ApiError) return res.status(err.status).json({ error: err.message, details: err.details });
  if (err?.code === 11000) return res.status(409).json({ error: 'Already exists' });
  if (err?.name === 'CastError') return res.status(400).json({ error: 'Invalid id' });
  if (err?.name === 'MulterError') return res.status(400).json({ error: err.message });
  req.log?.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'Internal server error' });
}
