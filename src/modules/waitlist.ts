import { Api, send } from '../http/api.js';
import { sendCached } from '../http/httpCache.js';
import { waitlistLimiter } from '../http/rateLimit.js';
import { parse, z, str, optStr, email, pageQuery, keysetFrom, pageOf } from '../http/validate.js';
import type { Deps } from '../http/types.js';
import { E } from '../errors.js';
import { csvCell } from '../lib/csv.js';
import { applicantEmail, ownerCopyEmail, type WaitlistRow } from '../lib/waitlistMail.js';

/**
 * Founding-salon waitlist (pre-launch). Rows live in `waitlist_signups`, a TEMPORARY table: after launch, founding entitlements
 * (Starter, 2 months free from first login) are copied onto salons and only then may the table be dropped. The trial logic itself,
 * Razorpay changes and trial-end reminders are Phase 2 and NOT implemented here.
 */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const name = (max: number) => str(max, 2).refine((s) => !CONTROL.test(s), 'must not contain control characters');

/** Indian mobile: accepts +91 / 91 / 0 prefixes, spaces, dashes, brackets; normalised to +91XXXXXXXXXX. Empty string = not given. */
const indianMobile = z
  .string()
  .trim()
  .max(25)
  .optional()
  .transform((s, ctx) => {
    if (!s) return undefined;
    const m = /^(?:\+91|0091|91|0)?([6-9]\d{9})$/.exec(s.replace(/[\s\-().]/g, ''));
    if (!m) {
      ctx.addIssue({ code: 'custom', message: 'must be an Indian mobile number, e.g. +919876543210' });
      return z.NEVER;
    }
    return `+91${m[1]}`;
  })
  .describe('Indian mobile number; stored as +91XXXXXXXXXX');

export const joinSchema = z.strictObject({
  salonName: name(80),
  ownerName: name(80),
  email,
  phone: indianMobile,
  consent: z.literal(true, { error: 'consent must be true' }),
  /** honeypot: real users never fill this */
  website: z.string().max(500).optional(),
  source: optStr(40),
});

const listQuery = pageQuery;

const itemDto = (r: Record<string, any>) => ({
  id: r.id, salonName: r.salon_name, ownerName: r.owner_name, email: r.email, phone: r.phone, founding: r.founding,
  createdAt: r.created_at, confirmationSentAt: r.confirmation_sent_at,
});

const CSV_HEAD = ['id', 'created_at', 'salon_name', 'owner_name', 'email', 'phone', 'founding', 'source', 'consent_at', 'confirmation_sent_at', 'owner_copy_sent_at'];

export function register(api: Api) {
  const { deps, deps: { config } } = api;

  api.get('/waitlist/status', { summary: 'Is the founding-salon waitlist open?', tag: 'Waitlist', auth: 'none', returns: 'WaitlistStatus' }, async (req, res) => {
    sendCached(req, res, { data: { open: config.waitlistOpen } }, { maxAge: 30, swr: 60 });
  });

  api.post(
    '/waitlist',
    {
      summary: 'Join the founding-salon waitlist', tag: 'Waitlist', auth: 'none', body: joinSchema, returns: 'WaitlistJoined', status: 201,
      note: 'Rate-limited per client IP (RATE_LIMIT_WAITLIST_PER_HOUR, default 10). Same e-mail again (case-insensitive) returns 201 with the ORIGINAL createdAt and sends no second e-mail. Honeypot `website` must be empty (bots get a silent 201, nothing stored). 409 CONFLICT reason WAITLIST_CLOSED when WAITLIST_OPEN=false. A confirmation e-mail is queued after the insert (skipped when SMTP is not configured).',
    },
    async (req, res) => {
      if (!config.waitlistOpen) throw E.conflict('The founding-salon waitlist is closed', 'WAITLIST_CLOSED');
      const b = parse(joinSchema, req.body);
      if (b.website && b.website.trim() !== '') {
        send(res, { status: 'joined', founding: true, createdAt: new Date().toISOString() }, undefined, 201); // pretend success, store nothing
        return;
      }
      const ins = await deps.pool.query<{ id: string; created_at: Date; founding: boolean }>(
        `INSERT INTO waitlist_signups (salon_name, owner_name, email, phone, consent_at, source)
         VALUES ($1,$2,$3,$4, now(), $5) ON CONFLICT (email) DO NOTHING RETURNING id, created_at, founding`,
        [b.salonName, b.ownerName, b.email, b.phone ?? null, b.source ?? null],
      );
      let row = ins.rows[0];
      if (row) {
        // after the insert committed (autocommit); a queue hiccup must never fail the sign-up
        await deps.queue.enqueue('waitlist.notify', { id: row.id }, { singletonKey: row.id }).catch((err) => {
          deps.log.error({ err, signupId: row!.id }, 'could not enqueue waitlist.notify');
        });
      } else {
        row = (await deps.pool.query<{ id: string; created_at: Date; founding: boolean }>('SELECT id, created_at, founding FROM waitlist_signups WHERE email = $1', [b.email])).rows[0]!;
      }
      send(res, { status: 'joined', founding: row.founding, createdAt: row.created_at }, undefined, 201);
    },
    [waitlistLimiter(config.rateLimit.waitlistPerHour)],
  );

  api.get('/admin/waitlist', { summary: 'Founding-salon waitlist, newest first', tag: 'Admin', auth: 'admin', query: listQuery, returns: 'WaitlistSignup[]' }, async (req, res) => {
    const q = parse(listQuery, req.query);
    const ks = keysetFrom(q.cursor);
    const params: unknown[] = [q.limit + 1];
    let where = '';
    if (ks) {
      params.push(ks.t, ks.id);
      where = 'WHERE (created_at, id) < ($2::timestamptz, $3::uuid)';
    }
    const r = await deps.pool.query(
      `SELECT id, salon_name, owner_name, email, phone, founding, created_at, confirmation_sent_at, created_at::text AS _ck
         FROM waitlist_signups ${where} ORDER BY created_at DESC, id DESC LIMIT $1`,
      params,
    );
    const { items, nextCursor } = pageOf(r.rows as { id: string; _ck: string }[], q.limit);
    send(res, items.map(itemDto), { limit: q.limit, nextCursor });
  });

  api.get('/admin/waitlist.csv', { summary: 'Founding-salon waitlist as CSV', tag: 'Admin', auth: 'admin', raw: 'text/csv' }, async (_req, res) => {
    const r = await deps.pool.query(
      `SELECT id, created_at, salon_name, owner_name, email, phone, founding, source, consent_at, confirmation_sent_at, owner_copy_sent_at
         FROM waitlist_signups ORDER BY created_at DESC, id DESC LIMIT 50000`,
    );
    const lines = [CSV_HEAD.join(','), ...r.rows.map((x) => CSV_HEAD.map((k) => csvCell(x[k])).join(','))];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="trim-waitlist-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(`${lines.join('\r\n')}\r\n`);
  });
}

/**
 * Job `waitlist.notify`: confirmation to the applicant + copy to WAITLIST_NOTIFY_TO. Idempotent per message via the *_sent_at
 * columns (a retry only re-sends what has not been marked sent). At-least-once: if SMTP accepted a message but the UPDATE failed,
 * a retry can send that one message twice. Both messages are attempted even if the first fails; any failure makes the job retry.
 */
export async function processWaitlistNotify(deps: Deps, id: string): Promise<void> {
  const { pool, mailer, config, log, metrics } = deps;
  if (!mailer.enabled) return; // SMTP not configured: nothing to do, never an error
  const r = await pool.query<WaitlistRow & { confirmation_sent_at: Date | null; owner_copy_sent_at: Date | null }>(
    'SELECT id, salon_name, owner_name, email, phone, founding, source, consent_at, created_at, confirmation_sent_at, owner_copy_sent_at FROM waitlist_signups WHERE id = $1',
    [id],
  );
  const row = r.rows[0];
  if (!row) return;
  const errors: unknown[] = [];
  const attempt = async (kind: 'confirmation' | 'owner_copy', fn: () => Promise<void>, column: 'confirmation_sent_at' | 'owner_copy_sent_at') => {
    try {
      await fn();
      await pool.query(`UPDATE waitlist_signups SET ${column} = now() WHERE id = $1 AND ${column} IS NULL`, [id]);
      metrics.inc('mail_sent_total', { kind });
    } catch (err) {
      metrics.inc('mail_failed_total', { kind });
      log.warn({ err: (err as Error).message, signupId: id, kind }, 'waitlist e-mail failed (will retry)');
      errors.push(err);
    }
  };
  if (!row.confirmation_sent_at) await attempt('confirmation', () => mailer.send(applicantEmail(row.email, config.websiteUrl)), 'confirmation_sent_at');
  const to = config.mail.waitlistNotifyTo;
  if (to && !row.owner_copy_sent_at) await attempt('owner_copy', () => mailer.send(ownerCopyEmail(to, row)), 'owner_copy_sent_at');
  if (errors.length) throw errors[0];
}
