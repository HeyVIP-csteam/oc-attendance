export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Secret: base64-encoded 32 random bytes. Encrypts bot tokens at rest and derives webhook secret tokens. */
  ENCRYPTION_KEY?: string;
  APP_ENV?: string;
  BIZ_TZ?: string;
  /** Optional: production origin, enforced on state-changing requests (in addition to SameSite=Strict cookies). */
  PUBLIC_ORIGIN?: string;
  /** Optional secrets that override a bot token stored in D1, e.g. TELEGRAM_BOT_TOKEN_LKR. */
  [key: `TELEGRAM_BOT_TOKEN_${string}`]: string | undefined;
}

export interface AdminPrincipal {
  id: number;
  username: string;
  role: 'admin' | 'viewer';
  sessionId: string;
}

export type AppBindings = { Bindings: Env; Variables: { admin: AdminPrincipal; requestIp: string } };
