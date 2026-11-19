import type { Question } from '@app/agent-client';
import type { PanelSpec } from '@app/specs';

/**
 * Block Kit messages. Plain functions from data to JSON, so every message the
 * app sends can be read and tested on its own.
 */

/** Action ids. The value carries what the handler needs. */
export const ACTIONS = {
  answer: 'answer',
  pick: 'answer_pick',
  save: 'save_panel',
  alert: 'alert_me',
  openWeb: 'open_web',
  remember: 'remember_answers',
} as const;

export interface AnswerValue {
  /** The agent request. */
  r: string;
  /** The option chosen. */
  v: string;
}

const MAX_OPTION_TEXT = 75;
const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;
const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A question: buttons for a short choice, a searchable menu for the endpoint picker. */
export function questionMessage(requestId: string, question: Question, questionsLeft: number) {
  const control =
    question.kind === 'endpoint'
      ? {
          type: 'actions',
          block_id: `q:${requestId}`,
          elements: [
            {
              // A static menu filters as you type, which is the picker's filter box.
              type: 'static_select',
              action_id: ACTIONS.pick,
              placeholder: { type: 'plain_text', text: 'Choose an endpoint' },
              options: question.options.slice(0, 100).map((option) => ({
                text: {
                  type: 'plain_text',
                  text: clip(
                    option.tags?.length
                      ? `${option.label} · ${option.tags.join(', ')}`
                      : option.label,
                    MAX_OPTION_TEXT,
                  ),
                },
                value: option.value,
              })),
            },
          ],
        }
      : {
          type: 'actions',
          block_id: `q:${requestId}`,
          elements: question.options.map((option, index) => ({
            type: 'button',
            action_id: `${ACTIONS.answer}:${index}`,
            text: { type: 'plain_text', text: clip(option.label, MAX_OPTION_TEXT) },
            value: JSON.stringify({ r: requestId, v: option.value } satisfies AnswerValue),
          })),
        };
  const hint =
    questionsLeft === 0
      ? 'Last question. Anything else will be a stated assumption you can change.'
      : 'At most one more question after this.';
  return {
    text: question.text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${escape(question.text)}*` } },
      control,
      { type: 'context', elements: [{ type: 'mrkdwn', text: hint }] },
    ],
  };
}

/** The question once answered: the controls are replaced by the answer and who gave it. */
export function answeredMessage(question: Question, value: string, user: string) {
  const label = question.options.find((option) => option.value === value)?.label ?? value;
  return {
    text: `${question.text} ${label}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${escape(question.text)}*\n${escape(label)}  ·  <@${user}>`,
        },
      },
    ],
  };
}

/** Under the chart image: the assumptions, the query, and what to do next. */
export function draftMessage(input: {
  requestId: string;
  panel: PanelSpec;
  webUrl: string;
  canRemember: boolean;
  /** Set when the chart could not be drawn. */
  chartProblem?: string;
}) {
  const { panel, requestId } = input;
  const assumptions =
    panel.assumptions.length > 0
      ? `Assumed: ${panel.assumptions.map(escape).join(' · ')}`
      : 'No assumptions.';
  const actions: unknown[] = [
    {
      type: 'button',
      action_id: ACTIONS.save,
      style: 'primary',
      text: { type: 'plain_text', text: 'Save to dashboard' },
      value: requestId,
    },
    {
      type: 'button',
      action_id: ACTIONS.alert,
      text: { type: 'plain_text', text: 'Alert me on this' },
      value: requestId,
    },
    {
      type: 'button',
      action_id: ACTIONS.openWeb,
      text: { type: 'plain_text', text: 'Open in web' },
      url: `${input.webUrl}/requests/${requestId}`,
      value: requestId,
    },
  ];
  if (input.canRemember) {
    actions.push({
      type: 'button',
      action_id: ACTIONS.remember,
      text: { type: 'plain_text', text: 'Skip questions next time' },
      value: requestId,
    });
  }
  return {
    text: `${panel.title} (draft, not saved)`,
    blocks: [
      ...(input.chartProblem
        ? [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `:warning: ${escape(input.chartProblem)}` },
            },
          ]
        : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: assumptions }] },
      // Show the work: the query behind the chart, always.
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `\`\`\`${panel.query.replace(/```/g, "'''")}\`\`\`` },
      },
      { type: 'actions', block_id: `draft:${requestId}`, elements: actions },
    ],
  };
}

/** The draft's buttons once saved. */
export function savedMessage(input: {
  panel: PanelSpec;
  webUrl: string;
  dashboardId: string;
  user: string;
}) {
  const link = `${input.webUrl}/dashboards/${input.dashboardId}`;
  return {
    text: `${input.panel.title} saved`,
    blocks: [
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Assumed: ${input.panel.assumptions.map(escape).join(' · ') || 'nothing'}`,
          },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `\`\`\`${input.panel.query.replace(/```/g, "'''")}\`\`\`` },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:white_check_mark: Saved to the <${link}|dashboard> by <@${input.user}>.`,
        },
      },
    ],
  };
}

export function plainMessage(text: string) {
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: escape(text) } }] };
}
