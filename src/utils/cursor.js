import { Types } from 'mongoose';
import { ApiError } from './errors.js';

/**
 * Compound cursor (timestamp, _id). Sorting by (ts desc, _id desc) is a total order, so posts that
 * share the same millisecond are never skipped or duplicated between pages.
 */
export const encodeCursor = (ms, id) => Buffer.from(`${ms}_${id}`).toString('base64url');

export function parseCursor(cursor) {
  if (!cursor) return null;
  try {
    const [ms, id] = Buffer.from(cursor, 'base64url').toString().split('_');
    if (!/^\d+$/.test(ms) || !/^[a-f0-9]{24}$/i.test(id)) throw new Error('bad');
    return { ms: Number(ms), id: id.toLowerCase() };
  } catch {
    throw new ApiError(400, 'Invalid cursor');
  }
}

export function cursorFilter(field, cur) {
  if (!cur) return null;
  const date = new Date(cur.ms);
  return {
    $or: [{ [field]: { $lt: date } }, { [field]: date, _id: { $lt: new Types.ObjectId(cur.id) } }],
  };
}

export async function paginate(Model, filter, { field = 'createdAt', cursor, limit = 10, select } = {}) {
  const cf = cursorFilter(field, parseCursor(cursor));
  const query = cf ? { $and: [filter, cf] } : filter;
  const rows = await Model.find(query).select(select).sort({ [field]: -1, _id: -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(new Date(last[field]).getTime(), last._id) : null,
  };
}
