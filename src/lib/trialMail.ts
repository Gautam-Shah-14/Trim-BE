import type { MailMessage } from './mailer.js';
import { layout, escapeHtml, PRIVACY_POLICY_URL } from './emailLayout.js';

export function trialEndingEmail(to: string, salonName: string, daysLeft: number, websiteUrl: string): MailMessage {
  const portalUrl = `${websiteUrl}/portal`;
  const subject = `Your Trim trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
  const text = [
    `Your free trial for ${salonName} on Trim ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`,
    '',
    'To keep using Trim, add a payment method in your salon portal before the trial ends.',
    `Portal: ${portalUrl}`,
    '',
    'If you have questions, reply to this email.',
    '',
    '--',
    'Trim by TokenBurners - A TokenBurners product',
    `Privacy policy: ${PRIVACY_POLICY_URL}`,
    '',
  ].join('\n');
  const html = layout(
    `<p style="margin:0 0 16px;font-size:18px;font-weight:bold;">Your trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}</p>
<p style="margin:0 0 16px;">Your free trial for <strong>${escapeHtml(salonName)}</strong> on Trim ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.</p>
<p style="margin:0 0 16px;">To keep using Trim, <a href="${escapeHtml(portalUrl)}" style="color:#1A1A1A;font-weight:bold;">add a payment method</a> in your salon portal before the trial ends.</p>
<p style="margin:0;color:#444;">If you have questions, reply to this email.</p>`,
  );
  return { to, subject, text, html };
}
