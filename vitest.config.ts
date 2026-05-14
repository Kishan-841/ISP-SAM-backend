import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

config({ path: '.env' });
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

// HARD GUARD: never let the test suite fire real outbound emails.
// .env in dev/prod can have ACCOUNTS_NOTIFICATIONS_ENABLED=true and live
// Resend/Netcore creds; loading those into a test process would otherwise
// blast every commit test through the real transport and burn the daily
// quota (this happened once — never again). Tests opt-in to the email
// path explicitly via setEmailClientForTests + setting the env vars at
// the test level.
delete process.env.RESEND_API_KEY;
delete process.env.resend_api_key;
delete process.env.NETCORE_API_KEY;
delete process.env.NETCORE_FROM_EMAIL;
delete process.env.ACCOUNTS_NOTIFICATIONS_ENABLED;
delete process.env.ACCOUNTS_TEAM_EMAIL;
delete process.env.ACCOUNTS_TEAM_CC_EMAILS;
delete process.env.SALES_DIRECTOR_EMAIL;
delete process.env.ADMIN_NOTIFY_EMAIL;

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 10000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
