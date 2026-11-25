'use strict';

// M19-FR-29: the one rule every "Needs your action" queue follows (src/common/actions.js), every branch.
const { queueItem } = require('../../src/common/actions');

describe('queueItem', () => {
  it('gives nothing for an empty queue', () => {
    expect(queueItem({ key: 'k', count: 0, href: '/x' })).toEqual([]);
    expect(queueItem({ key: 'k', count: null, href: '/x' })).toEqual([]);
  });

  it('is normal with no time limit by default', () => {
    expect(queueItem({ key: 'k', count: 3, href: '/x' })).toEqual([{ key: 'k', count: 3, severity: 'normal', dueAt: null, href: '/x' }]);
  });

  it('is high when something is overdue, and shows the earliest time limit', () => {
    const [item] = queueItem({ key: 'k', count: 2, overdue: 1, dueAt: '2026-11-25T04:00:00Z', href: '/x' });
    expect(item).toMatchObject({ severity: 'high', dueAt: '2026-11-25T04:00:00.000Z' });
  });

  it('is high when the owner says the queue is urgent', () => {
    expect(queueItem({ key: 'k', count: 1, urgent: true, href: '/x' })[0].severity).toBe('high');
  });
});
