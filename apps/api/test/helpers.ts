import request from 'supertest';
import { createTestDb, type Database } from '@mathpath/db';
import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DiscoveryModule } from '@nestjs/core';
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
export async function createTestApp(extraControllers: Type[] = []): Promise<TestApp> {
  const db = await createTestDb();
  const clock = new FakeClock();
  const sms = new FakeSmsSender();
  const moduleRef = await Test.createTestingModule({
    // DiscoveryModule lets the route-scan test list every controller.
    imports: [AppModule, DiscoveryModule],
    controllers: extraControllers,
  })
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

/** A typical phone browser; requests without a user agent look automated to the risk engine. */
export const BROWSER_UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

/** Supertest with a browser user agent on every request. */
export function browser(server: Parameters<typeof request>[0]) {
  return {
    get: (url: string) => request(server).get(url).set('User-Agent', BROWSER_UA),
    post: (url: string) => request(server).post(url).set('User-Agent', BROWSER_UA),
    patch: (url: string) => request(server).patch(url).set('User-Agent', BROWSER_UA),
    put: (url: string) => request(server).put(url).set('User-Agent', BROWSER_UA),
  };
}
