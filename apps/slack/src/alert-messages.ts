import { displayUnit, formatValue } from '@app/charts';
import type { AlertRuleSpec } from '@app/specs';

/** Block Kit for alerts. Shared by the Slack app (cards) and the alert engine (firing messages). */

export const ALERT_ACTIONS = {
  approve: 'alert_approve',
  discard: 'alert_discard',
  explain: 'alert_explain',
  snooze: 'alert_snooze',
  acknowledge: 'alert_ack',
  approveCollector: 'collector_approve',
  discardCollector: 'collector_discard',
} as const;

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** `#C0123` (a channel id) as a Slack link; `#name` as written. */
export const channelMention = (channel: string) =>
  /^#[CGD][A-Z0-9]{2,}$/.test(channel) ? `<#${channel.slice(1)}>` : escape(channel);

/** The channel to post to: a channel id without its `#`, or the name as written. */
export const postableChannel = (channel: string) =>
  /^#[CGD][A-Z0-9]{2,}$/.test(channel) ? channel.slice(1) : channel;

export function describeCondition(rule: AlertRuleSpec): string {
  if (!rule.comparison) return rule.expr;
  const unit = displayUnit(rule.unit ?? '', rule.display_unit);
  return `${rule.comparison.op === '>' ? 'above' : 'below'} ${formatValue(rule.comparison.threshold, unit)}`;
}

const minutes = (duration: string) => {
  const match = /^(\d+)(s|m|h)$/.exec(duration);
  if (!match) return duration;
  const words: Record<string, string> = { s: 'second', m: 'minute', h: 'hour' };
  return `${match[1]} ${words[match[2]!]}${match[1] === '1' ? '' : 's'}`;
};

/** The pending rule card: Approve, Edit, Discard. */
export function ruleCard(ruleId: string, rule: AlertRuleSpec, webUrl: string, footer?: string) {
  const facts = [
    `*Condition*\n${escape(rule.name)}`,
    `*For*\n${minutes(rule.for)}`,
    `*Notify*\n${channelMention(rule.channel)}`,
  ];
  const actions =
    rule.status === 'pending' && !footer
      ? [
          {
            type: 'actions',
            block_id: `rule:${ruleId}`,
            elements: [
              {
                type: 'button',
                action_id: ALERT_ACTIONS.approve,
                style: 'primary',
                text: { type: 'plain_text', text: 'Approve' },
                value: ruleId,
              },
              {
                type: 'button',
                action_id: 'alert_edit',
                text: { type: 'plain_text', text: 'Edit' },
                url: `${webUrl}/alerts/${ruleId}`,
                value: ruleId,
              },
              {
                type: 'button',
                action_id: ALERT_ACTIONS.discard,
                text: { type: 'plain_text', text: 'Discard' },
                value: ruleId,
              },
            ],
          },
        ]
      : [];
  return {
    text: `Draft alert rule: ${rule.name} (${rule.status === 'pending' ? 'pending approval' : rule.status})`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Draft alert rule*  ·  ${rule.status === 'pending' ? 'Pending approval' : rule.status === 'active' ? 'Active' : 'Discarded'}`,
        },
      },
      { type: 'section', fields: facts.map((text) => ({ type: 'mrkdwn', text })) },
      ...(rule.assumptions?.length
        ? [
            {
              type: 'context',
              elements: [
                { type: 'mrkdwn', text: `Assumed: ${rule.assumptions.map(escape).join(' · ')}` },
              ],
            },
          ]
        : []),
      ...(rule.query
        ? [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `\`\`\`${rule.expr.replace(/```/g, "'''")}\`\`\`` },
            },
          ]
        : []),
      ...actions,
      ...(footer ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: footer }] }] : []),
      ...(rule.status === 'pending' && !footer
        ? [
            {
              type: 'context',
              elements: [
                { type: 'mrkdwn', text: 'Nothing is watched until someone approves this rule.' },
              ],
            },
          ]
        : []),
    ],
  };
}

/** A rule fired. */
export function firingMessage(ruleId: string, rule: AlertRuleSpec, value: number, others?: string) {
  const unit = displayUnit(rule.unit ?? '', rule.display_unit);
  const subject = rule.name.replace(/ (above|below) .*$/, '');
  return {
    text: `Firing: ${subject} is ${formatValue(value, unit)}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Firing*  ·  *${escape(subject)} is ${formatValue(value, unit)}*`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Threshold is ${describeCondition(rule).replace(/^(above|below) /, '')} for ${minutes(rule.for)}.${others ? ` ${escape(others)}` : ''}`,
        },
      },
      {
        type: 'actions',
        block_id: `firing:${ruleId}`,
        elements: [
          {
            type: 'button',
            action_id: ALERT_ACTIONS.explain,
            style: 'primary',
            text: { type: 'plain_text', text: 'Why did this happen?' },
            value: ruleId,
          },
          {
            type: 'button',
            action_id: ALERT_ACTIONS.snooze,
            text: { type: 'plain_text', text: 'Snooze 1 hour' },
            value: ruleId,
          },
          {
            type: 'button',
            action_id: ALERT_ACTIONS.acknowledge,
            text: { type: 'plain_text', text: 'Acknowledge' },
            value: ruleId,
          },
        ],
      },
    ],
  };
}

export function resolvedMessage(rule: AlertRuleSpec) {
  const subject = rule.name.replace(/ (above|below) .*$/, '');
  return {
    text: `Resolved: ${subject} is back within its threshold.`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Resolved*  ·  ${escape(subject)} is back within its threshold.`,
        },
      },
    ],
  };
}

/** The pending collector card: Approve, Edit, Discard. */
export function collectorCard(
  collectorId: string,
  spec: {
    name: string;
    interval: string;
    metric_names: string[];
    config: Record<string, unknown>;
    status: string;
  },
  test: { ok: boolean; status: number | null; duration: number; error?: string },
  webUrl: string,
  footer?: string,
) {
  const result = test.ok
    ? `Succeeded, ${test.status} in ${Math.round(test.duration * 1000)} ms`
    : `Failed: ${test.error ?? `HTTP ${test.status}`}`;
  return {
    text: `Draft collector: ${spec.name} (pending approval)`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Draft collector*  ·  ${spec.status === 'pending' ? 'Pending approval' : spec.status === 'active' ? 'Active' : 'Discarded'}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Type*\nHTTP poll, every ${minutes(spec.interval)}` },
          { type: 'mrkdwn', text: `*URL*\n${escape(String(spec.config.url ?? ''))}` },
          { type: 'mrkdwn', text: `*Metrics*\n${spec.metric_names.join(', ')}` },
          { type: 'mrkdwn', text: `*Test fetch*\n${escape(result)}` },
        ],
      },
      ...(spec.status === 'pending' && !footer
        ? [
            {
              type: 'actions',
              block_id: `collector:${collectorId}`,
              elements: [
                {
                  type: 'button',
                  action_id: ALERT_ACTIONS.approveCollector,
                  style: 'primary',
                  text: { type: 'plain_text', text: 'Approve' },
                  value: collectorId,
                },
                {
                  type: 'button',
                  action_id: 'collector_edit',
                  text: { type: 'plain_text', text: 'Edit' },
                  url: `${webUrl}/collectors/${collectorId}`,
                  value: collectorId,
                },
                {
                  type: 'button',
                  action_id: ALERT_ACTIONS.discardCollector,
                  text: { type: 'plain_text', text: 'Discard' },
                  value: collectorId,
                },
              ],
            },
          ]
        : []),
      ...(footer ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: footer }] }] : []),
    ],
  };
}
