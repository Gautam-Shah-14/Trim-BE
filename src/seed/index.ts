import type pg from 'pg';
import { HAIRSTYLES } from './hairstyles.js';
import { SERVICE_TEMPLATES } from './serviceTemplates.js';

/** Idempotent: safe to run repeatedly (upserts by natural key). Plans are seeded by migration 0003. */
export async function seedReference(pool: pg.Pool): Promise<{ templates: number; hairstyles: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [i, [category, name, audience, dur, price]] of SERVICE_TEMPLATES.entries()) {
      await client.query(
        `INSERT INTO service_templates (category, name, audience, default_duration_min, suggested_price_paise, sort)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (category, name) DO UPDATE SET audience = EXCLUDED.audience, default_duration_min = EXCLUDED.default_duration_min,
           suggested_price_paise = EXCLUDED.suggested_price_paise, sort = EXCLUDED.sort`,
        [category, name, audience, dur, price, (i + 1) * 10],
      );
    }
    const tpl = new Map((await client.query<{ id: string; name: string }>('SELECT id, name FROM service_templates')).rows.map((r) => [r.name, r.id]));
    for (const h of HAIRSTYLES) {
      const r = await client.query<{ id: string }>(
        `INSERT INTO hairstyle_catalog (name, audience, face_shapes, length, description, tags, maintenance)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (name) DO UPDATE SET audience = EXCLUDED.audience, face_shapes = EXCLUDED.face_shapes, length = EXCLUDED.length,
           description = EXCLUDED.description, tags = EXCLUDED.tags, maintenance = EXCLUDED.maintenance
         RETURNING id`,
        [h.name, h.audience, h.shapes, h.length, h.description, h.tags, h.maintenance],
      );
      for (const sv of h.services) {
        const tid = tpl.get(sv);
        if (!tid) throw new Error(`Hairstyle "${h.name}" references unknown service template "${sv}"`);
        await client.query('INSERT INTO hairstyle_service_map (hairstyle_id, template_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [r.rows[0]!.id, tid]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { templates: SERVICE_TEMPLATES.length, hairstyles: HAIRSTYLES.length };
}
