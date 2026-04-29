import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

config({ path: '.env' });
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

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
