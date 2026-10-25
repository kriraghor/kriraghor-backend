'use strict';

/**
 * One-process mode (ADR-003 amendment, 25 Oct 2026): JOBS_IN_API=true makes the API start what
 * src/worker.js starts, and close it in the same order on shutdown.
 */
jest.mock('../../src/jobs/runtime', () => ({ registerSchedules: jest.fn(), startWorkers: jest.fn() }));
jest.mock('../../src/jobs/queues', () => ({ closeQueues: jest.fn() }));

const runtime = require('../../src/jobs/runtime');
const queues = require('../../src/jobs/queues');
const lifecycle = require('../../src/common/lifecycle');
const config = require('../../src/config');
const { startJobsInApi } = require('../../src/jobs/in-api');

describe('JOBS_IN_API', () => {
  afterEach(() => {
    lifecycle._reset();
    jest.clearAllMocks();
  });

  it('is off unless the environment turns it on', () => {
    expect(config.jobsInApi).toBe(false);
  });

  it('registers the schedules, starts the workers and closes workers before queues', async () => {
    const order = [];
    const workers = [{ name: 'events', close: jest.fn(async () => order.push('worker:events')) }, { name: 'notify', close: jest.fn(async () => order.push('worker:notify')) }];
    runtime.registerSchedules.mockResolvedValue(12);
    runtime.startWorkers.mockReturnValue(workers);
    queues.closeQueues.mockImplementation(async () => order.push('queues'));

    expect(await startJobsInApi()).toEqual({ schedules: 12, workers });
    expect(runtime.registerSchedules).toHaveBeenCalledTimes(1);
    expect(runtime.startWorkers).toHaveBeenCalledTimes(1);

    await lifecycle.shutdown('test', { exit: false });
    expect(order).toEqual(['worker:events', 'worker:notify', 'queues']);
  });
});
