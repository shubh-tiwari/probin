/**
 * Command-line harness: send one request to the agent and print the draft
 * panel spec.
 *
 *   pnpm ask "latency graph of checkout service in last 5 hr"
 *   pnpm ask "<request>" --answer "POST /checkout/pay" --answer 95
 *   pnpm ask "<request>" --save            save the draft once it is ready
 *   pnpm ask "<request>" --json            print the whole reply, trace included
 *
 * Questions are asked on the terminal unless answered with --answer, in order.
 * Talks to the running agent service (`make dev`), for the dev workspace
 * unless --workspace says otherwise.
 */
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { loadEnv } from '@app/config';
import { AgentApiError, createAgentClient, type AgentReply } from '../client.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    answer: { type: 'string', multiple: true, default: [] },
    save: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    workspace: { type: 'string' },
    user: { type: 'string', default: 'cli' },
  },
});

const text = positionals.join(' ').trim();
if (text === '') {
  console.error('Usage: pnpm ask "<request>" [--answer <value>]... [--save] [--json]');
  process.exit(2);
}

const env = loadEnv(['AGENT_URL', 'INTERNAL_API_TOKEN', 'DEV_WORKSPACE_ID']);
const agent = createAgentClient({
  url: env.AGENT_URL,
  internalToken: env.INTERNAL_API_TOKEN,
  workspaceId: values.workspace ?? env.DEV_WORKSPACE_ID,
  userId: values.user,
});

const answers = [...values.answer];
const say = (line = '') => {
  if (!values.json) console.error(line);
};

async function askOnTerminal(reply: AgentReply): Promise<string> {
  if (reply.output.kind !== 'question') throw new Error('not a question');
  const { question } = reply.output;
  say(`\n${question.text}`);
  question.options.forEach((option, index) => {
    const tags = option.tags?.length ? `  [${option.tags.join(', ')}]` : '';
    say(`  ${index + 1}. ${option.label}${tags}`);
  });
  const scripted = answers.shift();
  if (scripted !== undefined) {
    // Accept the option's value, its label, or its number.
    const chosen =
      question.options.find((o) => o.value === scripted || o.label === scripted) ??
      question.options[Number(scripted) - 1];
    say(`> ${chosen?.label ?? scripted}`);
    return chosen?.value ?? scripted;
  }
  if (!process.stdin.isTTY) {
    console.error('A question needs an answer. Pass it with --answer, or run in a terminal.');
    process.exit(2);
  }
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const typed = (await terminal.question('> ')).trim();
      const chosen =
        question.options[Number(typed) - 1] ?? question.options.find((o) => o.value === typed);
      if (chosen) return chosen.value;
      say(`Type a number from 1 to ${question.options.length}.`);
    }
  } finally {
    terminal.close();
  }
}

try {
  let reply = await agent.ask(text);
  while (reply.output.kind === 'question') {
    reply = await agent.answer(reply.requestId, await askOnTerminal(reply));
  }

  const { output } = reply;
  if (output.kind === 'draft') {
    for (const attempt of reply.trace.attempts) {
      say(
        `attempt ${attempt.number} (${attempt.model}): ` +
          (attempt.failure
            ? `failed: ${attempt.failure}`
            : `passed the dry run, ${attempt.lineCount} line(s)`),
      );
    }
    say('\nDraft panel (not saved):');
    if (values.save) {
      const saved = await agent.confirm(reply.requestId);
      if (values.json) console.log(JSON.stringify({ ...reply, saved: saved.output }, null, 2));
      else {
        console.log(JSON.stringify(output.panel, null, 2));
        if (saved.output.kind === 'saved') {
          say(
            `\nSaved as panel ${saved.output.panelId} v${saved.output.version} on dashboard ${saved.output.dashboardId}.`,
          );
        }
      }
    } else {
      console.log(JSON.stringify(values.json ? reply : output.panel, null, 2));
    }
  } else {
    if (values.json) console.log(JSON.stringify(reply, null, 2));
    else if (output.kind === 'no_match' || output.kind === 'failed')
      console.error(`\n${output.message}`);
    process.exitCode = output.kind === 'no_match' ? 3 : 1;
  }
} catch (error) {
  if (error instanceof AgentApiError) {
    console.error(`The agent service refused the request (HTTP ${error.status}): ${error.message}`);
  } else if (error instanceof TypeError) {
    console.error(
      `Cannot reach the agent service at ${env.AGENT_URL}. Is the stack up? (make dev)`,
    );
  } else {
    throw error;
  }
  process.exitCode = 1;
}
