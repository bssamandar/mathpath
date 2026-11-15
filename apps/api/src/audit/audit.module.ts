import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/** Provides {@link AuditService} to every module. */
@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
