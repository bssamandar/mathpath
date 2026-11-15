import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { BUSINESS_RULES, WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('boots and exposes the validated business rules', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    const rules = moduleRef.get(BUSINESS_RULES);
    expect(rules.learning.masteryThreshold).toBe(0.8);
    await moduleRef.close();
  });
});
