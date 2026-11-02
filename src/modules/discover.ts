import { Api, send } from '../http/api.js';
import { parse, z, uuid, dateStr, commaIds, pageQuery, keysetFrom, pageOf, decodeCursor, encodeCursor } from '../http/validate.js';
import { E } from '../errors.js';
import { loadSalonEnt, planBooking, sweepExpiredHolds, MAX_DAYS_AHEAD } from '../lib/booking.js';
import { addDays, computeSlots, isValidDateString, localDateOf, localDayRange, weekdayOf, workingWindows, type Interval } from '../lib/slots.js';
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
    const params: unknown[] = hasGeo ? [q.lat, q.lng] : [];
    const where: string[] = [`s.status = 'approved'`, DISCOVERABLE_SQL];
    if (hasGeo) {
      params.push(q.radiusKm ?? 25);
      where.push(`s.lat IS NOT NULL AND s.lng IS NOT NULL AND ${HAVERSINE} <= $${params.length}`);
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
    send(
      res,
      rows.map((s) => ({
        id: s.id, name: s.name, slug: s.slug, city: s.city, addressLine: s.address_line, lat: s.lat, lng: s.lng,
        logoMediaId: s.logo_media_id, ratingAvg: s.rating_avg, ratingCount: s.rating_count,
        distanceKm: s.distance_km === null ? null : Math.round(s.distance_km * 10) / 10,
        startingPricePaise: s.starting_price_paise, categories: s.categories,
      })),
      { limit: q.limit, nextCursor: hasMore ? encodeCursor({ o: offset + q.limit }) : null },
    );
  });

  api.get('/discover/salons/:salonId', { summary: 'Public salon profile', tag: 'Discover', auth: 'none', returns: 'SalonDetail' }, async (req, res) => {
    const salonId = parse(uuid, req.params['salonId']);
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
    send(res, {
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
    });
  });

  const reviewsQuery = pageQuery;
  api.get('/discover/salons/:salonId/reviews', { summary: 'Public reviews of a salon', tag: 'Discover', auth: 'none', query: reviewsQuery, returns: 'Review[]' }, async (req, res) => {
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
    send(res, items.map((x: any) => ({ id: x.id, rating: x.rating, comment: x.comment, customerName: x.first_name, replyText: x.reply_text, replyAt: x.reply_at, createdAt: x.created_at })), { limit: q.limit, nextCursor });
  });

  api.get('/salons/:salonId/availability', { summary: 'Bookable slots for services on a date', tag: 'Discover', auth: 'none', query: availabilityQuery, returns: 'Availability', note: 'Slots are on a 15-minute grid in the salon timezone; duration = Σ(duration×staff speed rounded up to 5 min)+buffers' }, async (req, res) => {
    const salonId = parse(uuid, req.params['salonId']);
    const q = parse(availabilityQuery, req.query);
    if (!isValidDateString(q.date)) throw E.validation('Invalid date', [{ field: 'date', issue: 'not a calendar date' }]);
    const salon = await loadSalonEnt(deps.pool, salonId);
    if (!salon || salon.status !== 'approved' || !salon.ent.discoverable) throw E.notFound('Salon');
    const tz = salon.timezone;
    const today = localDateOf(Date.now(), tz);
    if (q.date < today) throw E.validation('date is in the past', [{ field: 'date', issue: 'in the past' }]);
    if (q.date > addDays(today, MAX_DAYS_AHEAD)) throw E.validation(`date is more than ${MAX_DAYS_AHEAD} days ahead`, [{ field: 'date', issue: 'too far ahead' }]);

    await sweepExpiredHolds(deps.pool);

    let staffRows: { id: string }[];
    if (q.staffId) {
      staffRows = [{ id: q.staffId }];
    } else {
      staffRows = (await deps.pool.query<{ id: string }>('SELECT id FROM salon_staff WHERE salon_id = $1 AND is_active AND is_bookable ORDER BY created_at', [salonId])).rows;
    }
    const day = localDayRange(q.date, tz);
    const wd = weekdayOf(q.date);
    const [hours, closure] = await Promise.all([
      deps.pool.query<{ opens: string; closes: string; is_closed: boolean }>('SELECT opens, closes, is_closed FROM salon_hours WHERE salon_id = $1 AND weekday = $2', [salonId, wd]),
      deps.pool.query('SELECT 1 FROM salon_closures WHERE salon_id = $1 AND date = $2::date', [salonId, q.date]),
    ]);
    const ids = staffRows.map((s) => s.id);
    const [sh, off, busy] = await Promise.all([
      deps.pool.query<{ staff_id: string; start_time: string; end_time: string }>('SELECT staff_id, start_time, end_time FROM staff_hours WHERE staff_id = ANY($1::uuid[]) AND weekday = $2', [ids, wd]),
      deps.pool.query<{ staff_id: string; s: Date; e: Date }>("SELECT staff_id, lower(during) AS s, upper(during) AS e FROM staff_time_off WHERE staff_id = ANY($1::uuid[]) AND during && tstzrange($2, $3, '[)')", [ids, new Date(day.start), new Date(day.end)]),
      deps.pool.query<{ staff_id: string; s: Date; e: Date }>(
        "SELECT staff_id, starts_at AS s, ends_at AS e FROM bookings WHERE staff_id = ANY($1::uuid[]) AND status IN ('held','confirmed','checked_in') AND during && tstzrange($2, $3, '[)')",
        [ids, new Date(day.start), new Date(day.end)],
      ),
    ]);
    const hr = hours.rows[0];
    const closed = (closure.rowCount ?? 0) > 0;
    const out: { staffId: string; startsAt: string; endsAt: string }[] = [];
    for (const st of staffRows) {
      let plan;
      try {
        plan = await planBooking(deps.pool, salonId, st.id, q.serviceIds);
      } catch (err) {
        if (q.staffId) throw err; // explicit staff: surface why
        continue; // staff cannot do these services
      }
      const own = sh.rows.find((x) => x.staff_id === st.id);
      const windows = workingWindows({
        date: q.date, tz,
        salonHours: hr ? { opens: hr.opens, closes: hr.closes, isClosed: hr.is_closed } : null,
        closed,
        staffHours: own ? { start: own.start_time, end: own.end_time } : null,
      });
      const blocked: Interval[] = [
        ...off.rows.filter((x) => x.staff_id === st.id).map((x) => ({ start: x.s.getTime(), end: x.e.getTime() })),
        ...busy.rows.filter((x) => x.staff_id === st.id).map((x) => ({ start: x.s.getTime(), end: x.e.getTime() })),
      ];
      for (const sl of computeSlots({ windows, blocked, durationMin: plan.totalDurationMin, now: Date.now() })) {
        out.push({ staffId: st.id, startsAt: new Date(sl.start).toISOString(), endsAt: new Date(sl.end).toISOString() });
      }
    }
    out.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.staffId.localeCompare(b.staffId));
    send(res, { date: q.date, timezone: tz, slots: out });
  });
}
