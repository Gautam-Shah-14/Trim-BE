import nodemailer, { type Transport } from 'nodemailer';
import type { Logger } from 'pino';
import type { Config } from '../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Outgoing e-mail (SMTP, Brevo in production). Built once from env. When SMTP is not configured the mailer is disabled:
 * `send` is never called by the jobs (they check `enabled`) and a single warning is logged at startup. Credentials are never logged.
 */
export interface Mailer {
  readonly enabled: boolean;
  send(msg: MailMessage): Promise<void>;
  close(): void;
}

/** remove CR/LF (header injection) and collapse whitespace for anything that ends up in a mail header */
// eslint-disable-next-line no-control-regex
export const headerSafe = (s: string, max = 200) => s.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);

/**
 * @param transport test hook: a nodemailer Transport (fake, no network). When given, the mailer is enabled even without SMTP env.
 */
export function createMailer(cfg: Config['mail'], log: Logger, transport?: Transport): Mailer {
  if (!transport && !cfg.enabled) {
    // key NAMES only, never values
    log.warn({ missing: cfg.missing }, 'mailer disabled: SMTP is not configured, waitlist e-mails will not be sent');
    return { enabled: false, async send() {}, close() {} };
  }
  const t = transport
    ? nodemailer.createTransport(transport)
    : nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure, // false on 587 = STARTTLS (required below)
        requireTLS: !cfg.secure,
        auth: { user: cfg.user, pass: cfg.pass },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
  const from = cfg.from || 'Trim by TokenBurners <no-reply@example.invalid>';
  return {
    enabled: true,
    async send(m) {
      await t.sendMail({ from, to: headerSafe(m.to, 254), subject: headerSafe(m.subject), text: m.text, html: m.html, disableFileAccess: true, disableUrlAccess: true });
    },
    close() {
      t.close();
    },
  };
}
