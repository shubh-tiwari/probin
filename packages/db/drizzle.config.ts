import { defineConfig } from 'drizzle-kit';

// `pnpm db:generate` turns changes in src/schema.ts into a new SQL file in
// migrations/. It does not connect to a database. Commit the generated files.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
});
