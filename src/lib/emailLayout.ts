/**
 * Shared branded email layout used by all Trim transactional emails.
 * Table-based, inline-styled, no external resources.
 */

/** TokenBurners legal pages (workspace rule: link, never copy). */
export const PRIVACY_POLICY_URL = 'https://tokenburners.co.in/legal/privacy-policy';

export const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!);

const AMBER = '#FFB808';
const INK = '#1A1A1A';

export interface LayoutOptions {
  /** URL for unsubscribe line in footer. null = hide the line. */
  unsubscribeUrl?: string | null;
}

/** Minimal, table-based, inline-styled HTML email layout (no images, no tracking pixels, no external resources). */
export function layout(bodyHtml: string, opts?: LayoutOptions): string {
  const unsubLine = opts?.unsubscribeUrl
    ? `<br><span style="font-size:11px;">You received this because you signed up on Trim. <a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:#666;">Unsubscribe</a></span>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trim</title></head>
<body style="margin:0;padding:0;background:#F6F4EF;font-family:Arial,Helvetica,sans-serif;color:${INK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F4EF;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:12px;overflow:hidden;">
<tr><td style="background:${AMBER};color:${INK};padding:20px 24px;font-size:24px;font-weight:bold;letter-spacing:0.5px;">Trim</td></tr>
<tr><td style="padding:24px;font-size:16px;line-height:1.5;color:${INK};">${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #EEE;font-size:12px;line-height:1.5;color:#666;">Trim by TokenBurners &middot; A TokenBurners product<br><a href="${escapeHtml(PRIVACY_POLICY_URL)}" style="color:#666;">Privacy policy</a>${unsubLine}</td></tr>
</table></td></tr></table>
</body></html>`;
}
