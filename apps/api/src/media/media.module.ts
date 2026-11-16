/**
 * Media (docs/architecture.md §4 `media`): uploads, transcoding jobs, HLS
 * keys and signed playback. Storage and the key vault come from the
 * environment, shared with the worker through @mathpath/media.
 */
import type { AppConfig } from '@mathpath/config';
import type { Database } from '@mathpath/db';
import {
  MediaKeyVault,
  MemoryObjectStore,
  type ObjectStore,
  objectStoreFromEnv,
  S3ObjectStore,
  vaultFromEnv,
} from '@mathpath/media';
import {
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { Clock } from '../common/clock';
import { RateLimiter } from '../common/rate-limiter';
import type { Env } from '../config/env';
import { BUSINESS_RULES, ENV } from '../config/tokens';
import { Entitlements } from '../content/catalogue.service';
import { ContentModule } from '../content/content.module';
import { DB } from '../database/database.module';
import { IdentityModule } from '../identity/identity.module';
import { AuthKeys } from '../identity/keys';
import { MediaController, StudioMediaController } from './media.controller';
import { MediaService } from './media.service';
import { PlaybackTokens } from './playback-token';
import { BullTranscodeQueue, NoTranscodeQueue, TranscodeQueue } from './transcode-queue';

/** Injection token for the object store. */
export const OBJECT_STORE = Symbol('OBJECT_STORE');

@Module({
  imports: [ContentModule, IdentityModule],
  controllers: [StudioMediaController, MediaController],
  providers: [
    {
      provide: OBJECT_STORE,
      inject: [ENV],
      useFactory: (env: Env): ObjectStore => {
        const store = objectStoreFromEnv(env);
        if (store) return store;
        // Production refuses to start without S3 settings (config/env.ts).
        new Logger('Media').warn(
          'S3_ENDPOINT is not set: media is kept in memory (development only).',
        );
        return new MemoryObjectStore();
      },
    },
    {
      provide: MediaKeyVault,
      inject: [ENV],
      useFactory: (env: Env) => vaultFromEnv(env, (m) => new Logger('Media').warn(m)),
    },
    {
      provide: TranscodeQueue,
      inject: [ENV],
      useFactory: (env: Env): TranscodeQueue =>
        env.REDIS_URL ? new BullTranscodeQueue(env.REDIS_URL) : new NoTranscodeQueue(),
    },
    {
      provide: PlaybackTokens,
      inject: [AuthKeys],
      useFactory: (k: AuthKeys) => new PlaybackTokens(k),
    },
    {
      provide: MediaService,
      inject: [
        DB,
        OBJECT_STORE,
        MediaKeyVault,
        TranscodeQueue,
        PlaybackTokens,
        Entitlements,
        RateLimiter,
        AuditService,
        Clock,
        BUSINESS_RULES,
      ],
      useFactory: (
        db: Kysely<Database>,
        store: ObjectStore,
        vault: MediaKeyVault,
        queue: TranscodeQueue,
        tokens: PlaybackTokens,
        entitlements: Entitlements,
        limiter: RateLimiter,
        audit: AuditService,
        clock: Clock,
        rules: AppConfig,
      ) =>
        new MediaService(
          db,
          store,
          vault,
          queue,
          tokens,
          entitlements,
          limiter,
          audit,
          clock,
          rules.content,
        ),
    },
  ],
})
export class MediaModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(TranscodeQueue) private readonly queue: TranscodeQueue,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Locally the bucket is created on start; in production it is provisioned (Phase 7). */
  async onApplicationBootstrap(): Promise<void> {
    if (this.env.NODE_ENV !== 'production' && this.store instanceof S3ObjectStore) {
      await this.store.ensureBucket(this.env.MEDIA_BROWSER_ORIGINS);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
    if (this.store instanceof S3ObjectStore) this.store.destroy();
  }
}
