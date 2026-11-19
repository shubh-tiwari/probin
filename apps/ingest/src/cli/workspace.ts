/**
 * Workspace and ingestion key administration.
 *
 *   pnpm ws:create <name> [plan]     create a workspace and print its ingestion key
 *   pnpm ws:rotate-key <workspace>   replace the key; the old one stops working at once
 *
 * A key is printed once and never stored. Keep it in the service's environment,
 * never in a repository.
 */
import { loadEnv, loadPlans } from '@app/config';
import { connect, createWorkspace, getWorkspace, setIngestionKeyHash } from '@app/db';
import { generateIngestionKey, hashIngestionKey } from '../keys.js';

const [command, argument, planArgument] = process.argv.slice(2);
const env = loadEnv(['DATABASE_URL', 'PLANS_FILE', 'INGEST_URL']);
const { db, close } = connect(env.DATABASE_URL);

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

try {
  if (command === 'create') {
    if (!argument) fail('Usage: pnpm ws:create <name> [plan]');
    const plans = loadPlans(env.PLANS_FILE);
    const plan = planArgument ?? plans.trial.plan;
    if (!plans.plans.some((one) => one.id === plan)) {
      fail(`Unknown plan "${plan}". Plans: ${plans.plans.map((one) => one.id).join(', ')}`);
    }
    const key = generateIngestionKey();
    const workspace = await createWorkspace(db, {
      name: argument!,
      plan,
      ingestionKeyHash: hashIngestionKey(key),
    });
    console.log(`Workspace:      ${workspace.id} (${workspace.name}, plan ${workspace.plan})`);
    console.log(`Ingestion URL:  ${env.INGEST_URL}`);
    console.log(`Ingestion key:  ${key}`);
    console.log('The key is shown once. Store it in the service environment, not in a repository.');
  } else if (command === 'rotate-key') {
    if (!argument) fail('Usage: pnpm ws:rotate-key <workspace id>');
    const workspace = await getWorkspace(db, argument!).catch(() => undefined);
    if (!workspace) fail(`No workspace ${argument}.`);
    const key = generateIngestionKey();
    await setIngestionKeyHash(db, workspace!.id, hashIngestionKey(key));
    console.log(`Workspace:      ${workspace!.id} (${workspace!.name})`);
    console.log(`New key:        ${key}`);
    console.log('The previous key no longer works. The new key is shown once.');
  } else {
    fail('Usage: pnpm ws:create <name> [plan] | pnpm ws:rotate-key <workspace id>');
  }
} finally {
  await close();
}
