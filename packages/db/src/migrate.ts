import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { connect } from './client.js';

/** The committed SQL migrations, generated from schema.ts by `pnpm db:generate`. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/** Apply every migration that has not been applied yet. Safe to run repeatedly. */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const handle = connect(databaseUrl);
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await handle.close();
  }
}
