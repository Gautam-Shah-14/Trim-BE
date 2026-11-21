import type { MailMessage } from './mailer.js';
import { layout, escapeHtml, PRIVACY_POLICY_URL } from './emailLayout.js';

/** Build the OTP verification email. */
export function otpEmail(to: string, otp: string): MailMessage {
  const subject = `${otp} is your Trim verification code`;
  const text = [
    `Your verification code is: ${otp}`,
    '',
    'It expires in 5 minutes. If you didn\'t request this, ignore this email.',
    '',
    '--',
    'Trim by TokenBurners - A TokenBurners product',
    `Privacy policy: ${PRIVACY_POLICY_URL}`,
    '',
  ].join('\n');
  const html = layout(
    `<p style="margin:0 0 16px;">Your verification code is:</p>
<p style="margin:0 0 16px;font-size:32px;font-weight:bold;letter-spacing:4px;text-align:center;">${escapeHtml(otp)}</p>
<p style="margin:0;color:#444;">It expires in 5 minutes. If you didn’t request this, ignore this email.</p>`,
  );
  return { to, subject, text, html };
}
