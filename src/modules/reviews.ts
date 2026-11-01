import { Api, send } from '../http/api.js';
import { parse, z, str, uuid, pageQuery, keysetFrom, pageOf } from '../http/validate.js';
import { E } from '../errors.js';
import { isPgError, withTx } from '../db.js';
import { auditReq } from '../lib/audit.js';
import { recomputeRating } from '../lib/booking.js';

const replySchema = z.strictObject({ replyText: str(1000) });
const reportSchema = z.strictObject({ reason: str(300) });

export const reviewDto = (r: Record<string, any>) => ({
  id: r.id,
  bookingId: r.booking_id,
  rating: r.rating,
  comment: r.comment,
  status: r.status,
  customerName: r.customer_name,
  replyText: r.reply_text,
  replyAt: r.reply_at,
  createdAt: r.created_at,
});

export function register(api: Api) {
  const { deps } = api;

  api.get('/salons/:salonId/reviews', { summary: 'Reviews of this salon (any member)', tag: 'Reviews', auth: 'salon', query: pageQuery, returns: 'Review[]' }, async (req, res) => {
    const q = parse(pageQuery, req.query);
    const ks = keysetFrom(q.cursor);
    const params: unknown[] = [req.salonCtx!.salonId, q.limit + 1];
    if (ks) params.push(ks.t, ks.id);
    const r = await deps.pool.query(
      `SELECT r.*, r.created_at::text AS _ck, COALESCE(split_part(u.full_name, ' ', 1), 'Customer') AS customer_name
         FROM reviews r LEFT JOIN users u ON u.id = r.customer_id
        WHERE r.salon_id = $1 ${ks ? 'AND (r.created_at, r.id) < ($3::timestamptz, $4::uuid)' : ''}
        ORDER BY r.created_at DESC, r.id DESC LIMIT $2`,
      params,
    );
    const { items, nextCursor } = pageOf(r.rows as { id: string; _ck: string }[], q.limit);
    send(res, items.map(reviewDto), { limit: q.limit, nextCursor });
  });

  api.post('/salons/:salonId/reviews/:reviewId/reply', { summary: 'Reply to a review (replaces an earlier reply)', tag: 'Reviews', auth: 'salon', perm: 'reviews.reply', body: replySchema, returns: 'Review' }, async (req, res) => {
    const b = parse(replySchema, req.body);
    const id = parse(uuid, req.params['reviewId']);
    const r = await deps.pool.query(
      'UPDATE reviews SET reply_text = $3, reply_by = $4, reply_at = now() WHERE id = $1 AND salon_id = $2 RETURNING *',
      [id, req.salonCtx!.salonId, b.replyText, req.auth!.userId],
    );
    if (!r.rows[0]) throw E.notFound('Review');
    await auditReq(req, { action: 'review.replied', entity: 'review', entityId: id });
    send(res, reviewDto(r.rows[0]));
  });

  api.post('/reviews/:id/report', { summary: 'Report a review to the Trim team', tag: 'Reviews', auth: 'user', body: reportSchema }, async (req, res) => {
    const b = parse(reportSchema, req.body);
    const id = parse(uuid, req.params['id']);
    await withTx(deps.pool, async (c) => {
      const rv = await c.query<{ salon_id: string }>('SELECT salon_id FROM reviews WHERE id = $1', [id]);
      if (!rv.rows[0]) throw E.notFound('Review');
      try {
        await c.query('INSERT INTO review_reports (review_id, reported_by, reason) VALUES ($1,$2,$3)', [id, req.auth!.userId, b.reason]);
      } catch (err) {
        if (isPgError(err, '23505')) throw E.conflict('You already reported this review', 'ALREADY_REPORTED');
        throw err;
      }
      await c.query("UPDATE reviews SET status = 'reported' WHERE id = $1 AND status = 'visible'", [id]);
    });
    send(res, { ok: true });
  });
}

export { recomputeRating };
