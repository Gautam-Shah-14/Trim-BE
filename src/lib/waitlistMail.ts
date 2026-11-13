import type { MailMessage } from './mailer.js';
import { headerSafe } from './mailer.js';

/** TokenBurners legal pages (workspace rule: link, never copy). */
export const PRIVACY_POLICY_URL = 'https://tokenburners.co.in/legal/privacy-policy';

/** The confirmation sentence is product copy agreed with the owner: keep it byte-for-byte (curly apostrophes). */
export const WAITLIST_CONFIRMATION = 'You’re on the list. You’ll get a 2-month free trial from your first login after launch. We’ll notify you when Trim is ready.';
export const WAITLIST_CONSENT_REMINDER = 'We’ll message you when Trim is ready. Nothing else.';
export const WAITLIST_SUBJECT = "You're on the Trim waitlist";

export const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!);

const AMBER = '#FFB808';
const INK = '#1A1A1A';

/** minimal, table-based, inline-styled HTML (no images, no tracking pixels, no external resources) */
function layout(bodyHtml: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trim</title></head>
<body style="margin:0;padding:0;background:#F6F4EF;font-family:Arial,Helvetica,sans-serif;color:${INK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F4EF;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:12px;overflow:hidden;">
<tr><td style="background:${AMBER};color:${INK};padding:20px 24px;font-size:24px;font-weight:bold;letter-spacing:0.5px;">Trim</td></tr>
<tr><td style="padding:24px;font-size:16px;line-height:1.5;color:${INK};">${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #EEE;font-size:12px;line-height:1.5;color:#666;">Trim by TokenBurners &middot; A TokenBurners product<br><a href="${escapeHtml(PRIVACY_POLICY_URL)}" style="color:#666;">Privacy policy</a></td></tr>
</table></td></tr></table>
</body></html>`;
}

/**
 * E-mail to the applicant. Deliberately contains NO user-supplied text (names etc.): anyone can type any address into a public form,
 * so echoing input would let the form be used to send arbitrary text to third parties.
 */
export function applicantEmail(to: string, websiteUrl: string): MailMessage {
  const terms = `${websiteUrl}/waitlist#terms`;
  const text = [
    WAITLIST_CONFIRMATION,
    '',
    'The free trial is on the Starter plan.',
    `Trial terms: ${terms}`,
    '',
    WAITLIST_CONSENT_REMINDER,
    '',
    '--',
    'Trim by TokenBurners - A TokenBurners product',
    `Privacy policy: ${PRIVACY_POLICY_URL}`,
    '',
  ].join('\n');
  const html = layout(
    `<p style="margin:0 0 16px;font-size:18px;font-weight:bold;">${escapeHtml(WAITLIST_CONFIRMATION)}</p>
<p style="margin:0 0 16px;">The free trial is on the <strong>Starter</strong> plan. <a href="${escapeHtml(terms)}" style="color:${INK};">Read the trial terms</a>.</p>
<p style="margin:0;color:#444;">${escapeHtml(WAITLIST_CONSENT_REMINDER)}</p>`,
  );
  return { to, subject: WAITLIST_SUBJECT, text, html };
}

export interface WaitlistRow {
  id: string;
  salon_name: string;
  owner_name: string;
  email: string;
  phone: string | null;
  founding: boolean;
  source: string | null;
  consent_at: Date | string;
  created_at: Date | string;
}

/** dd Mon yyyy, hh:mm IST */
export const istStamp = (d: Date | string) =>
  `${new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} IST`;

/** copy to the TokenBurners inbox (WAITLIST_NOTIFY_TO) */
export function ownerCopyEmail(to: string, r: WaitlistRow): MailMessage {
  const fields: [string, string][] = [
    ['Salon', r.salon_name],
    ['Owner', r.owner_name],
    ['Email', r.email],
    ['Phone', r.phone ?? '-'],
    ['Founding', r.founding ? 'yes' : 'no'],
    ['Source', r.source ?? '-'],
    ['Consent at', istStamp(r.consent_at)],
    ['Signed up at', istStamp(r.created_at)],
    ['Signup id', r.id],
  ];
  const text = [`New Trim waitlist signup`, '', ...fields.map(([k, v]) => `${k}: ${v}`), ''].join('\n');
  const html = layout(
    `<p style="margin:0 0 16px;font-weight:bold;">New Trim waitlist signup</p>
<table role="presentation" cellpadding="4" cellspacing="0" style="font-size:14px;">${fields
      .map(([k, v]) => `<tr><td style="color:#666;padding-right:12px;">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
      .join('')}</table>`,
  );
  return { to, subject: `New Trim waitlist signup: ${headerSafe(r.salon_name, 80)}`, text, html };
}
