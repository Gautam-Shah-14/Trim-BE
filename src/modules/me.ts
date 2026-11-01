import { Api, send } from '../http/api.js';
import { parse, z, str, uuid } from '../http/validate.js';
import { E } from '../errors.js';
import { withTx } from '../db.js';
import { auditReq } from '../lib/audit.js';
import { loadMemberships, userDto } from './auth.js';

const patchSchema = z.strictObject({
  fullName: str(120).optional(),
  avatarMediaId: uuid.nullable().optional(),
});
const tokenSchema = z.strictObject({ token: str(4096), platform: z.enum(['android', 'ios', 'web']).default('android') });

const COLS = 'id, phone_e164, email, full_name, platform_role, avatar_media_id, must_change_password, is_active';

export function register(api: Api) {
  const { deps } = api;

  api.get('/me', { summary: 'Current user profile and salon memberships', tag: 'Profile', auth: 'user', returns: 'MeResult' }, async (req, res) => {
    const u = await deps.pool.query(`SELECT ${COLS} FROM users WHERE id = $1`, [req.auth!.userId]);
    send(res, { user: userDto(u.rows[0]), memberships: await loadMemberships(deps.pool, req.auth!.userId) });
  });

  api.patch('/me', { summary: 'Update profile (name, avatar via media id)', tag: 'Profile', auth: 'user', body: patchSchema, returns: 'User' }, async (req, res) => {
    const b = parse(patchSchema, req.body);
    if (b.avatarMediaId) {
      const m = await deps.pool.query("SELECT 1 FROM media WHERE id = $1 AND owner_user_id = $2 AND kind = 'avatar'", [b.avatarMediaId, req.auth!.userId]);
      if (!m.rowCount) throw E.validation('avatarMediaId must be one of your avatar uploads', [{ field: 'avatarMediaId', issue: 'unknown media' }]);
    }
    const u = await deps.pool.query(
      `UPDATE users SET full_name = COALESCE($2, full_name),
              avatar_media_id = CASE WHEN $3::boolean THEN $4::uuid ELSE avatar_media_id END, updated_at = now()
        WHERE id = $1 RETURNING ${COLS}`,
      [req.auth!.userId, b.fullName ?? null, b.avatarMediaId !== undefined, b.avatarMediaId ?? null],
    );
    send(res, userDto(u.rows[0]));
  });

  api.post('/me/device-token', { summary: 'Store an FCM device token', tag: 'Profile', auth: 'user', body: tokenSchema }, async (req, res) => {
    const b = parse(tokenSchema, req.body);
    await deps.pool.query(
      'INSERT INTO device_tokens (user_id, token, platform) VALUES ($1,$2,$3) ON CONFLICT (user_id, token) DO NOTHING',
      [req.auth!.userId, b.token, b.platform],
    );
    send(res, { ok: true });
  });

  api.delete('/me', { summary: 'Delete (anonymise) a customer account', tag: 'Profile', auth: 'customer' }, async (req, res) => {
    const id = req.auth!.userId;
    const randomHash = await deps.hasher.hash(`deleted-${id}-${Date.now()}`);
    await withTx(deps.pool, async (c) => {
      await c.query(
        `UPDATE users SET full_name = 'Deleted user', phone_e164 = NULL, email = $2, password_hash = $3, avatar_media_id = NULL,
                is_active = false, updated_at = now() WHERE id = $1`,
        [id, `deleted+${id}@trim.invalid`, randomHash],
      );
      await c.query("UPDATE bookings SET customer_name = 'Deleted user', customer_phone = NULL WHERE customer_id = $1", [id]);
      await c.query("UPDATE bookings SET status = 'cancelled', cancelled_reason = 'account deleted', version = version + 1, updated_at = now() WHERE customer_id = $1 AND status IN ('held','confirmed') AND starts_at > now()", [id]);
      await c.query("UPDATE reviews SET comment = NULL WHERE customer_id = $1", [id]);
      await c.query('DELETE FROM device_tokens WHERE user_id = $1', [id]);
      await c.query('DELETE FROM media WHERE owner_user_id = $1 AND kind = \'avatar\'', [id]);
      await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    });
    await auditReq(req, { action: 'user.deleted', entity: 'user', entityId: id });
    send(res, { ok: true });
  });
}
