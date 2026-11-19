/**
 * Prints the Slack app manifest for creating the real Slack app.
 *
 *   pnpm slack:manifest https://slack.example.com [https://web.example.com]
 *
 * Paste the output at https://api.slack.com/apps → Create New App → From a manifest.
 * The first argument is where the Slack service is reachable from the internet.
 * The second, if given, is the web tool's address: "Sign in with Slack" there
 * needs its callback listed and the openid and profile scopes.
 */
import { PRODUCT_NAME, PRODUCT_SLUG } from '@app/config';
import { BOT_SCOPES } from '@app/slack';

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
const web = (process.argv[3] ?? '').replace(/\/+$/, '');
if (!/^https:\/\//.test(base) || (web && !/^https:\/\//.test(web))) {
  console.error(
    'Usage: pnpm slack:manifest https://<public address of the Slack service> [https://<web tool>]',
  );
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
    redirect_urls: [`${base}/slack/oauth/callback`, ...(web ? [`${web}/auth/slack/callback`] : [])],
    scopes: { bot: BOT_SCOPES, ...(web ? { user: ['openid', 'profile'] } : {}) },
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
