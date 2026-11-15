/**
 * Route scan (security plan C-09): every route declares its access level, and
 * that level matches `x-permission` in docs/api/openapi.yaml. This keeps the
 * code and the contract from drifting apart and catches a route that was
 * added without thinking about who may call it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ACCESS_METADATA, PERMISSIONS, type RouteAccess } from '../src/identity/permissions';
import { createTestApp, type TestApp } from './helpers';

interface ScannedRoute {
  key: string;
  access: RouteAccess | undefined;
}

type OpenApi = { paths: Record<string, Record<string, { 'x-permission'?: string }>> };

const spec = parse(
  readFileSync(resolve(__dirname, '../../../docs/api/openapi.yaml'), 'utf8'),
) as OpenApi;

let t: TestApp;
let routes: ScannedRoute[];

beforeAll(async () => {
  t = await createTestApp();
  const discovery = t.app.get(DiscoveryService);
  const scanner = t.app.get(MetadataScanner);
  const reflector = t.app.get(Reflector);
  routes = [];
  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as object;
    const controllerPath = String(
      Reflect.getMetadata(PATH_METADATA, wrapper.metatype as object) ?? '',
    );
    const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[name] as () => unknown;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      const path = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
      const full = `/${[controllerPath, path].filter((p) => p && p !== '/').join('/')}`
        .replace(/\/+/g, '/')
        .replace(/:(\w+)/g, '{$1}');
      routes.push({
        key: `${RequestMethod[method].toLowerCase()} ${full}`,
        access: reflector.getAllAndOverride<RouteAccess>(ACCESS_METADATA, [
          handler,
          wrapper.metatype as object,
        ] as never),
      });
    }
  }
});

afterAll(async () => {
  await t.close();
});

describe('route access declarations (C-09)', () => {
  it('finds the routes', () => {
    expect(routes.map((r) => r.key)).toContain('post /auth/login');
  });

  it('declares access on every route', () => {
    expect(routes.filter((r) => r.access === undefined).map((r) => r.key)).toEqual([]);
  });

  it('uses only known access levels', () => {
    const known = new Set<string>(['public', 'authenticated', ...PERMISSIONS]);
    expect(routes.filter((r) => !known.has(r.access!)).map((r) => r.key)).toEqual([]);
  });

  it('matches x-permission in the OpenAPI contract for every route', () => {
    const mismatches = routes
      .map((r) => {
        const [method, path] = r.key.split(' ') as [string, string];
        const documented = spec.paths[path]?.[method]?.['x-permission'];
        return documented === r.access ? null : `${r.key}: code=${r.access} openapi=${documented}`;
      })
      .filter(Boolean);
    expect(mismatches).toEqual([]);
  });

  it('documents every permission used in the contract in code', () => {
    const used = new Set<string>();
    for (const operations of Object.values(spec.paths)) {
      for (const op of Object.values(operations)) {
        if (op?.['x-permission']) used.add(op['x-permission']);
      }
    }
    const known = new Set<string>(['public', 'authenticated', ...PERMISSIONS]);
    expect([...used].filter((p) => !known.has(p))).toEqual([]);
  });
});
