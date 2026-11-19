/**
 * Prints the Slack app manifest for creating the real Slack app.
 *
 *   pnpm slack:manifest https://slack.example.com
 *
 * Paste the output at https://api.slack.com/apps → Create New App → From a manifest.
 * The argument is where the Slack service is reachable from the internet.
 */
import { PRODUCT_NAME, PRODUCT_SLUG } from '@app/config';
import { BOT_SCOPES } from '@app/slack';

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!/^https:\/\//.test(base)) {
  console.error('Usage: pnpm slack:manifest https://<public address of the Slack service>');
  process.exit(2);
}

const manifest = {
  display_information: {
    name: PRODUCT_NAME,
    description: 'Charts and alerts from plain-language requests',
  },
  features: {
    bot_user: { display_name: PRODUCT_SLUG, always_online: true },
    app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
  },
  oauth_config: {
    redirect_urls: [`${base}/slack/oauth/callback`],
    scopes: { bot: BOT_SCOPES },
  },
  settings: {
    event_subscriptions: {
      request_url: `${base}/slack/events`,
      bot_events: ['app_mention', 'message.im'],
    },
    interactivity: { is_enabled: true, request_url: `${base}/slack/events` },
    org_deploy_enabled: false,
    socket_mode_enabled: false,
    token_rotation_enabled: false,
  },
};
console.log(JSON.stringify(manifest, null, 2));
