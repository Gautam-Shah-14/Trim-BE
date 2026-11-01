import { pino, type Logger } from 'pino';

export function createLogger(level: string, nodeEnv: string): Logger {
  return pino({
    level: nodeEnv === 'test' && level === 'info' ? 'silent' : level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-razorpay-signature"]',
        '*.password',
        '*.tempPassword',
        '*.refreshToken',
        '*.accessToken',
        '*.qrToken',
        '*.dataBase64',
      ],
      censor: '[redacted]',
    },
  });
}
