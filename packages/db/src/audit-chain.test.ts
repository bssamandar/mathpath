import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, entryHash, type HashedFields, verifyAuditChain } from './audit-chain';
import { newId } from './ids';
import type { Database } from './schema';
import { createTestDb } from './testing';

describe('canonical JSON', () => {
  it('sorts keys, drops undefined and writes dates as ISO strings', () => {
    expect(canonicalJson({ b: 1, a: [true, null], c: undefined })).toBe('{"a":[true,null],"b":1}');
    expect(canonicalJson(new Date('2026-11-17T00:00:00Z'))).toBe('"2026-11-17T00:00:00.000Z"');
    expect(canonicalJson({ z: { y: 'x', a: 2 } })).toBe('{"z":{"a":2,"y":"x"}}');
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('audit chain', () => {
  let db: Kysely<Database>;
  let prev: Buffer | null = null;
  let at = Date.parse('2026-11-17T00:00:00Z');

  const append = async (action: string, tamper?: { hash?: Buffer; prev?: Buffer | null }) => {
    const fields: HashedFields = {
      id: newId(),
      actor_id: null,
      actor_roles: ['admin'],
      action,
      target_type: null,
      target_id: null,
      ip_prefix: null,
      request_id: null,
      metadata: { n: 1 },
      created_at: new Date((at += 1000)),
    };
    const hash = entryHash(prev, fields);
    await db
      .insertInto('audit_log')
      .values({
        ...fields,
        metadata: JSON.stringify(fields.metadata),
        prev_hash: tamper && 'prev' in tamper ? tamper.prev! : prev,
        hash: tamper?.hash ?? hash,
      } as never)
      .execute();
    prev = tamper?.hash ?? hash;
    return fields.id;
  };

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.destroy();
  });

  it('accepts an empty and an intact chain', async () => {
    expect(await verifyAuditChain(db)).toEqual({ ok: true, entries: 0 });
    await append('user.login');
    await append('user.role.grant');
    expect(await verifyAuditChain(db)).toEqual({ ok: true, entries: 2 });
  });

  it('finds the first entry whose hash does not match its content', async () => {
    const bad = await append('user.status_change', { hash: Buffer.alloc(32, 7) });
    await append('user.login');
    expect(await verifyAuditChain(db)).toEqual({ ok: false, entries: 4, brokenAt: bad });
  });
});

describe('audit chain links', () => {
  it('finds an entry that does not point at the previous hash', async () => {
    const db = await createTestDb();
    const fields: HashedFields = {
      id: newId(),
      actor_id: null,
      actor_roles: [],
      action: 'user.login',
      target_type: null,
      target_id: null,
      ip_prefix: null,
      request_id: null,
      metadata: {},
      created_at: new Date('2026-11-17T00:00:00Z'),
    };
    // The first entry claims a predecessor that does not exist.
    await db
      .insertInto('audit_log')
      .values({
        ...fields,
        metadata: '{}',
        prev_hash: Buffer.alloc(32, 1),
        hash: entryHash(null, fields),
      } as never)
      .execute();
    expect(await verifyAuditChain(db)).toEqual({ ok: false, entries: 1, brokenAt: fields.id });
    await db.destroy();
  });
});
