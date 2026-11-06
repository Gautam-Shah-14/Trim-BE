import { Api, send } from '../http/api.js';
import { sendCached } from '../http/httpCache.js';
import { userLimiter } from '../http/rateLimit.js';
import { computeAvailability } from '../lib/availability.js';
import { parse, z, uuid, dateStr, commaIds, pageQuery, keysetFrom, pageOf, decodeCursor, encodeCursor } from '../http/validate.js';
import { E } from '../errors.js';
import { loadSalonEnt, sweepExpiredHolds, MAX_DAYS_AHEAD } from '../lib/booking.js';
import { addDays, isValidDateString, localDateOf } from '../lib/slots.js';
import { createHash } from 'node:crypto';
import { hoursDto } from './salon.js';
import { serviceDto } from './services.js';

const discoverQuery = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(0.1).max(500).optional(),
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(60).optional(),
  templateId: uuid.optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  sort: z.enum(['distance', 'rating']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(600).optional(),
});

const availabilityQuery = z.object({ serviceIds: commaIds, staffId: uuid.optional(), date: dateStr });

/** SQL mirror of entitlements().discoverable: active | trialing(in trial) | past_due(<7d) | comped */
export const DISCOVERABLE_SQL = `(sub.comp_until > now()
  OR sub.status = 'active'
  OR (sub.status = 'trialing' AND sub.trial_ends_at > now())
  OR (sub.status = 'past_due' AND COALESCE(sub.past_due_since, now()) + interval '7 days' > now()))`;

const HAVERSINE = `(6371 * 2 * asin(sqrt(LEAST(1, power(sin(radians(s.lat - $1) / 2), 2) + cos(radians($1)) * cos(radians(s.lat)) * power(sin(radians(s.lng - $2) / 2), 2)))))`;

export function register(api: Api) {
  const { deps } = api;

  api.get('/discover/salons', { summary: 'Search nearby salons', tag: 'Discover', auth: 'none', query: discoverQuery, returns: 'SalonSummary[]', note: 'Only approved salons with an active/trialing/past_due subscription. Cursor is opaque (offset based).' }, async (req, res) => {
    const q = parse(discoverQuery, req.query);
    if ((q.lat === undefined) !== (q.lng === undefined)) throw E.validation('lat and lng must be given together', [{ field: 'lat', issue: 'lat and lng go together' }]);
    const hasGeo = q.lat !== undefined;
    const sort = q.sort ?? (hasGeo ? 'distance' : 'rating');
    if (sort === 'distance' && !hasGeo) throw E.validation('sort=distance needs lat and lng', [{ field: 'sort', issue: 'requires lat/lng' }]);
    const offset = decodeCursor<{ o: number }>(q.cursor)?.o ?? 0;
    // the caller position is snapped to a ~110 m grid: shared cache cells, distances accurate to ~0.1 km
    const lat = hasGeo ? Math.round(q.lat! * 1000) / 1000 : undefined;
    const lng = hasGeo ? Math.round(q.lng! * 1000) / 1000 : undefined;
    const ver = await deps.cache.version('discover');
    const key = `disc:v${ver}:${createHash('sha1').update(JSON.stringify({ ...q, lat, lng, sort })).digest('hex')}`;
    const body = await deps.cache.getOrLoad(key, deps.config.cacheTtl.discover, async () => {
    const params: unknown[] = hasGeo ? [lat, lng] : [];
    const where: string[] = [`s.status = 'approved'`, DISCOVERABLE_SQL];
    if (hasGeo) {
      const radius = q.radiusKm ?? 25;
      // bounding-box prefilter (uses the salons_geo_idx btree) before the exact haversine check
      const dLat = radius / 111.32;
      const dLng = radius / (111.32 * Math.max(0.01, Math.cos((lat! * Math.PI) / 180)));
      params.push(radius, lat! - dLat, lat! + dLat, lng! - dLng, lng! + dLng);
      const n = params.length;
      where.push(`s.lat BETWEEN $${n - 3} AND $${n - 2} AND s.lng BETWEEN $${n - 1} AND $${n}`);
      where.push(`${HAVERSINE} <= $${n - 4}`);
    }
    if (q.q) {
      params.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`);
      const i = params.length;
      where.push(`(s.name ILIKE $${i} OR s.city ILIKE $${i} OR EXISTS (SELECT 1 FROM salon_services sv WHERE sv.salon_id = s.id AND sv.is_active AND sv.name ILIKE $${i}))`);
    }
    if (q.category) {
      params.push(q.category);
      where.push(`EXISTS (SELECT 1 FROM salon_services sv WHERE sv.salon_id = s.id AND sv.is_active AND lower(sv.category) = lower($${params.length}))`);
    }
    if (q.templateId) {
      params.push(q.templateId);
      where.push(`EXISTS (SELECT 1 FROM salon_services sv WHERE sv.salon_id = s.id AND sv.is_active AND sv.template_id = $${params.length})`);
    }
    if (q.minRating !== undefined) {
      params.push(q.minRating);
      where.push(`s.rating_avg >= $${params.length} AND s.rating_count > 0`);
    }
    params.push(q.limit + 1, offset);
    const order = sort === 'distance' ? 'distance_km ASC NULLS LAST, s.id' : 's.rating_avg DESC, s.rating_count DESC, s.id';
    const r = await deps.pool.query(
      `SELECT s.id, s.name, s.slug, s.city, s.address_line, s.lat, s.lng, s.logo_media_id, s.rating_avg, s.rating_count,
              ${hasGeo ? `${HAVERSINE}` : 'NULL::float'} AS distance_km,
              (SELECT min(sv.price_paise) FROM salon_services sv WHERE sv.salon_id = s.id AND sv.is_active) AS starting_price_paise,
              COALESCE((SELECT array_agg(DISTINCT sv.category) FROM salon_services sv WHERE sv.salon_id = s.id AND sv.is_active), '{}') AS categories
         FROM salons s JOIN subscriptions sub ON sub.salon_id = s.id
        WHERE ${where.join(' AND ')}
        ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const hasMore = r.rows.length > q.limit;
    const rows = hasMore ? r.rows.slice(0, q.limit) : r.rows;
    return {
      data: rows.map((s) => ({
        id: s.id, name: s.name, slug: s.slug, city: s.city, addressLine: s.address_line, lat: s.lat, lng: s.lng,
        logoMediaId: s.logo_media_id, ratingAvg: s.rating_avg, ratingCount: s.rating_count,
        distanceKm: s.distance_km === null ? null : Math.round(s.distance_km * 10) / 10,
        startingPricePaise: s.starting_price_paise, categories: s.categories,
      })),
      meta: { limit: q.limit, nextCursor: hasMore ? encodeCursor({ o: offset + q.limit }) : null },
    };
    });
    sendCached(req, res, body, { maxAge: 30, swr: 60 });
  });

  api.get('/discover/salons/:salonId', { summary: 'Public salon profile', tag: 'Discover', auth: 'none', returns: 'SalonDetail' }, async (req, res) => {
    const salonId = parse(uuid, req.params['salonId']);
    const sv = await deps.cache.version(`salon:${salonId}`);
    const body = await deps.cache.getOrLoad(`pub:salon:${salonId}:v${sv}`, deps.config.cacheTtl.salonPublic, async () => {
    const s = await deps.pool.query(
      `SELECT s.* FROM salons s JOIN subscriptions sub ON sub.salon_id = s.id WHERE s.id = $1 AND s.status = 'approved' AND ${DISCOVERABLE_SQL}`,
      [salonId],
    );
    const salon = s.rows[0];
    if (!salon) throw E.notFound('Salon');
    const [hours, services, staff, photos, closures] = await Promise.all([
      deps.pool.query('SELECT * FROM salon_hours WHERE salon_id = $1 ORDER BY weekday', [salonId]),
      deps.pool.query('SELECT * FROM salon_services WHERE salon_id = $1 AND is_active ORDER BY sort, category, name', [salonId]),
      deps.pool.query(
        `SELECT st.id, st.display_name, st.photo_media_id, st.speed_multiplier,
                COALESCE((SELECT array_agg(ss.service_id) FROM staff_services ss JOIN salon_services sv ON sv.id = ss.service_id AND sv.is_active WHERE ss.staff_id = st.id), '{}') AS service_ids,
                EXISTS (SELECT 1 FROM staff_services ss WHERE ss.staff_id = st.id) AS restricted
           FROM salon_staff st WHERE st.salon_id = $1 AND st.is_active AND st.is_bookable ORDER BY st.created_at`,
        [salonId],
      ),
      deps.pool.query("SELECT id FROM media WHERE salon_id = $1 AND kind = 'salon_photo' ORDER BY created_at", [salonId]),
      deps.pool.query("SELECT to_char(date,'YYYY-MM-DD') AS date, reason FROM salon_closures WHERE salon_id = $1 AND date >= current_date ORDER BY date LIMIT 30", [salonId]),
    ]);
    const allIds = services.rows.map((x) => x.id);
    return { data: {
      id: salon.id, name: salon.name, slug: salon.slug, description: salon.description, phone: salon.phone, addressLine: salon.address_line,
      city: salon.city, state: salon.state, pincode: salon.pincode, lat: salon.lat, lng: salon.lng, timezone: salon.timezone,
      logoMediaId: salon.logo_media_id, ratingAvg: salon.rating_avg, ratingCount: salon.rating_count, reviewCount: salon.rating_count,
      cancelCutoffMin: salon.cancel_cutoff_min, photoMediaIds: photos.rows.map((p) => p.id),
      hours: hours.rows.map(hoursDto), closures: closures.rows,
      services: services.rows.map(serviceDto),
      staff: staff.rows.map((st) => ({
        id: st.id, displayName: st.display_name, photoMediaId: st.photo_media_id,
        serviceIds: st.restricted ? st.service_ids : allIds,
      })),
    } };
    });
    sendCached(req, res, body, { maxAge: 60, swr: 120 });
  });

  const reviewsQuery = pageQuery;
  api.get('/discover/salons/:salonId/reviews', { summary: 'Public reviews of a salon', tag: 'Discover', auth: 'none', query: reviewsQuery, returns: 'PublicReview[]' }, async (req, res) => {
    const salonId = parse(uuid, req.params['salonId']);
    const q = parse(reviewsQuery, req.query);
    const ks = keysetFrom(q.cursor);
    const params: unknown[] = [salonId, q.limit + 1];
    if (ks) params.push(ks.t, ks.id);
    const r = await deps.pool.query(
      `SELECT r.id, r.rating, r.comment, r.reply_text, r.reply_at, r.created_at, r.created_at::text AS _ck, split_part(COALESCE(u.full_name, 'Customer'), ' ', 1) AS first_name
         FROM reviews r LEFT JOIN users u ON u.id = r.customer_id JOIN salons s ON s.id = r.salon_id
        WHERE r.salon_id = $1 AND r.status IN ('visible','reported') AND s.status = 'approved' ${ks ? 'AND (r.created_at, r.id) < ($3::timestamptz, $4::uuid)' : ''}
        ORDER BY r.created_at DESC, r.id DESC LIMIT $2`,
      params,
    );
    const { items, nextCursor } = pageOf(r.rows as { id: string; _ck: string }[], q.limit);
    sendCached(req, res, { data: items.map((x: any) => ({ id: x.id, rating: x.rating, comment: x.comment, customerName: x.first_name, replyText: x.reply_text, replyAt: x.reply_at, createdAt: x.created_at })), meta: { limit: q.limit, nextCursor } }, { maxAge: 30, swr: 60 });
  });

  api.get('/salons/:salonId/availability', { summary: 'Bookable slots for services on a date', tag: 'Discover', auth: 'none', query: availabilityQuery, returns: 'Availability', note: 'Slots are on a 15-minute grid in the salon timezone; duration = sum(duration x staff speed rounded up to 5 min) + buffers. Advisory: the hold decides. Do not poll faster than every 10 s.' }, async (req, res) => {
    const salonId = parse(uuid, req.params['salonId']);
    const q = parse(availabilityQuery, req.query);
    if (!isValidDateString(q.date)) throw E.validation('Invalid date', [{ field: 'date', issue: 'not a calendar date' }]);
    const salon = await loadSalonEnt(deps.pool, salonId);
    if (!salon || salon.status !== 'approved' || !salon.ent.discoverable) throw E.notFound('Salon');
    const tz = salon.timezone;
    const today = localDateOf(Date.now(), tz);
    if (q.date < today) throw E.validation('date is in the past', [{ field: 'date', issue: 'in the past' }]);
    if (q.date > addDays(today, MAX_DAYS_AHEAD)) throw E.validation(`date is more than ${MAX_DAYS_AHEAD} days ahead`, [{ field: 'date', issue: 'too far ahead' }]);

    const sv = await deps.cache.version(`salon:${salonId}`);
    const key = `avail:${salonId}:v${sv}:${q.date}:${[...q.serviceIds].sort().join(',')}:${q.staffId ?? '-'}`;
    const data = await deps.cache.getOrLoad(key, deps.config.cacheTtl.availability, async () => {
      await sweepExpiredHolds(deps.pool);
      const slots = await computeAvailability(deps.pool, { id: salonId, timezone: tz }, q.serviceIds, q.staffId, q.date);
      return { date: q.date, timezone: tz, slots };
    });
    send(res, data);
  }, [userLimiter('availability', deps.config.rateLimit.availabilityPerMin)]);
}
