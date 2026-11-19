/**
 * The connector for Claude Code, run on a developer's machine:
 *
 *   claude mcp add <name> -e METRICS_API_URL=https://<web tool> -e METRICS_API_TOKEN=<token> \
 *     -- node --import tsx apps/connector/src/main.ts
 *
 * The token is a read-only API token from Settings in the web tool.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createReadApi } from './api.js';
import { createConnector } from './server.js';

const url = process.env.METRICS_API_URL;
const token = process.env.METRICS_API_TOKEN;
if (!url || !token) {
  console.error(
    'Set METRICS_API_URL (the web tool) and METRICS_API_TOKEN (a read-only API token from Settings).',
  );
  process.exit(2);
}
await createConnector(createReadApi({ url, token })).connect(new StdioServerTransport());
