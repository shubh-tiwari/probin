import { loadEnv } from '@app/config';
import { runMigrations } from '../migrate.js';

const { DATABASE_URL } = loadEnv(['DATABASE_URL']);
const target = new URL(DATABASE_URL);

try {
  await runMigrations(DATABASE_URL);
  console.log(`Migrations applied to ${target.host}${target.pathname}`);
} catch (error) {
  console.error(`Migration failed on ${target.host}${target.pathname}`);
  console.error(error);
  process.exitCode = 1;
}
