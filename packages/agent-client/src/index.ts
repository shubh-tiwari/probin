/**
 * The agent's HTTP contract: its client, and the shapes of what it returns.
 * Slack, the web tool and the command line talk to the agent through this
 * package only, whatever language the agent is written in.
 */
export * from './client.js';
