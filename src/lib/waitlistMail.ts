import type { MailMessage } from './mailer.js';
import { headerSafe } from './mailer.js';
import { layout, escapeHtml, PRIVACY_POLICY_URL } from './emailLayout.js';


/** The confirmation sentence is product copy agreed with the owner: keep it byte-for-byte (curly apostrophes). */
export const WAITLIST_CONFIRMATION = 'You’re on the list. You’ll get a 2-month free trial from your first login after launch. We’ll notify you when Trim is ready.';
export const WAITLIST_CONSENT_REMINDER = 'We’ll message you when Trim is ready. Nothing else.';
export const WAITLIST_SUBJECT = "You're on the Trim waitlist";

// Re-export for backwards compatibility (other modules import from here)
export { escapeHtml, PRIVACY_POLICY_URL };

const AMBER = '#FFB808';
const INK = '#1A1A1A';


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
<p style="margin:0 0 16px;">The free trial is on the <strong>Starter</strong> plan. <a href="${escapeHtml(terms)}" style="color:#1A1A1A;">Read the trial terms</a>.</p>
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
