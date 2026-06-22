import { describe, expect, it } from 'vitest';

import { createSerialQueue } from '../serial-queue.ts';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('createSerialQueue', () => {
  it('runs jobs one at a time — no two overlap (the worker concurrency fix, P0)', async () => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const q = createSerialQueue<number>(async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick();
      await tick();
      order.push(n);
      active--;
    });

    // Enqueue while the first is still in its async section — the bug scenario.
    q.enqueue(1);
    q.enqueue(2);
    q.enqueue(3);

    await tick();
    await tick();
    await tick();
    await tick();
    await tick();
    await tick();

    expect(maxActive).toBe(1); // never two jobs in flight at once
    expect(order).toEqual([1, 2, 3]); // FIFO
  });

  it('does not start a later job until the active job settles', async () => {
    const gate = defer();
    const ran: string[] = [];
    const q = createSerialQueue<string>(async (id) => {
      ran.push(`start:${id}`);
      if (id === 'a') await gate.promise;
      ran.push(`end:${id}`);
    });

    q.enqueue('a');
    q.enqueue('b');
    await tick();

    // 'a' is blocked on the gate; 'b' must not have started.
    expect(ran).toEqual(['start:a']);

    gate.resolve();
    await tick();
    await tick();
    expect(ran).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('skips a still-queued job that is cancelled', async () => {
    const gate = defer();
    const ran: string[] = [];
    const q = createSerialQueue<{ id: string }>(async (job) => {
      ran.push(job.id);
      if (job.id === 'a') await gate.promise;
    });

    q.enqueue({ id: 'a' }); // starts, blocks on gate
    q.enqueue({ id: 'b' }); // queued
    q.enqueue({ id: 'c' }); // queued
    await tick();

    q.cancel((job) => job.id === 'b'); // cancel while still queued
    gate.resolve();
    await tick();
    await tick();

    expect(ran).toEqual(['a', 'c']); // 'b' skipped
  });

  it('does not cancel the actively-running job', async () => {
    const gate = defer();
    const ran: string[] = [];
    const q = createSerialQueue<{ id: string }>(async (job) => {
      ran.push(`run:${job.id}`);
      if (job.id === 'a') await gate.promise;
    });

    q.enqueue({ id: 'a' });
    await tick();
    q.cancel((job) => job.id === 'a'); // a is already active — cancel is a no-op
    gate.resolve();
    await tick();

    expect(ran).toContain('run:a');
  });

  it('keeps draining after a job throws', async () => {
    const ran: string[] = [];
    const q = createSerialQueue<string>(async (id) => {
      ran.push(id);
      if (id === 'boom') throw new Error('job failed');
    });

    q.enqueue('boom');
    q.enqueue('next');
    await tick();
    await tick();

    expect(ran).toEqual(['boom', 'next']);
  });
});
