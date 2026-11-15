import { createTestDb, type Database } from '@mathpath/db';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Kysely } from 'kysely';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { Clock } from '../src/common/clock';
import { DB } from '../src/database/database.module';
import { SmsSender } from '../src/identity/sms/sms-sender';

/** A clock that tests move forward by hand. */
export class FakeClock extends Clock {
  private current = new Date('2026-11-15T10:00:00Z');
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Records SMS instead of sending them. */
export class FakeSmsSender extends SmsSender {
  readonly sent: { phone: string; text: string }[] = [];
  async send(phone: string, text: string): Promise<{ messageId: null }> {
    this.sent.push({ phone, text });
    return Promise.resolve({ messageId: null });
  }
  /** The digits of the last code sent to `phone`. */
  lastCode(phone: string): string {
    const message = [...this.sent].reverse().find((m) => m.phone === phone);
    const code = /(\d{6})/.exec(message?.text ?? '')?.[1];
    if (!code) throw new Error(`no code was sent to ${phone}`);
    return code;
  }
}

export interface TestApp {
  app: NestExpressApplication;
  db: Kysely<Database>;
  clock: FakeClock;
  sms: FakeSmsSender;
  close(): Promise<void>;
}

/** Boots the whole API on an in-memory database with fake SMS and a fake clock. */
export async function createTestApp(): Promise<TestApp> {
  const db = await createTestDb();
  const clock = new FakeClock();
  const sms = new FakeSmsSender();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(Clock)
    .useValue(clock)
    .overrideProvider(SmsSender)
    .useValue(sms)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  await app.init();
  // The DatabaseModule closes the database on shutdown.
  return { app, db, clock, sms, close: () => app.close() };
}
