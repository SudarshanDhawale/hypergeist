import { describe, expect, it } from 'vitest';

import { createMemoryReminderRepository } from './memory-reminder-repository.ts';
import { makeReminder, runReminderRepositoryContract } from './reminder-repository.contract.ts';

runReminderRepositoryContract('memory repository', () => {
  const repository = createMemoryReminderRepository();
  return { repository, testing: repository.testing, close: () => undefined };
});

describe('createMemoryReminderRepository', () => {
  it('keeps each repository separate', async () => {
    const one = createMemoryReminderRepository();
    const two = createMemoryReminderRepository();
    await one.put(makeReminder('a'));
    expect(await two.list()).toEqual({ ok: true, value: [] });
  });

  it('rejects a raw record without a string id in the test hook', () => {
    const repository = createMemoryReminderRepository();
    expect(() => {
      repository.testing.putRaw({ message: 'no id' });
    }).toThrow();
  });
});
