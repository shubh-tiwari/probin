import { describe, expect, it } from 'vitest';
import { channelMention, postableChannel, ruleCard } from './alert-messages.js';

describe('alert messages', () => {
  it('formats Slack channels', () => {
    expect(postableChannel('#C0OPS1')).toBe('C0OPS1');
    expect(postableChannel('#ops-monitoring')).toBe('#ops-monitoring');
    expect(channelMention('#C0OPS1')).toBe('<#C0OPS1>');
  });

  it('shows a pending rule with Approve, Edit, Discard, and that nothing is watched yet', () => {
    const card = ruleCard(
      'r1',
      {
        name: 'p95 above 800 ms',
        expr: '(q) > 0.8',
        for: '5m',
        severity: 'warning',
        channel: '#C0OPS1',
        status: 'pending',
        query: 'q',
      },
      'http://web',
    );
    const text = JSON.stringify(card);
    expect(text).toContain('Pending approval');
    expect(text).toContain('Nothing is watched until someone approves this rule.');
    expect(text).toContain('5 minutes');
    const buttons = (
      card.blocks.find((b) => b.type === 'actions') as { elements: { text: { text: string } }[] }
    ).elements;
    expect(buttons.map((b) => b.text.text)).toEqual(['Approve', 'Edit', 'Discard']);
  });
});
