import { Validator } from '@seriousme/openapi-schema-validator';
import type { OpenAPIV3_1 } from 'openapi-types';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createRouters } from './app.js';
import { createHarness } from './__tests__/harness.js';

/** Registered routes that are deliberately not part of the API description. */
const UNDOCUMENTED = new Set(['get /']);

const METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

function registeredRoutes(): Set<string> {
  const { config, services } = createHarness();
  const routes = new Set<string>();
  for (const { prefix, router } of createRouters(config, services)) {
    for (const layer of router.stack as RouteLayer[]) {
      if (layer.route === undefined) continue;
      const path = (prefix + layer.route.path).replace(/:(\w+)/g, '{$1}');
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (enabled) routes.add(`${method} ${path}`);
      }
    }
  }
  for (const route of UNDOCUMENTED) routes.delete(route);
  return routes;
}

function specOperations(spec: OpenAPIV3_1.Document): [string, OpenAPIV3_1.OperationObject][] {
  const operations: [string, OpenAPIV3_1.OperationObject][] = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method];
      if (op !== undefined) operations.push([`${method} ${path}`, op]);
    }
  }
  return operations;
}

async function fetchSpec(): Promise<OpenAPIV3_1.Document> {
  const { app } = createHarness();
  return (await request(app).get('/openapi.json').expect(200)).body as OpenAPIV3_1.Document;
}

describe('OpenAPI contract', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const spec = await fetchSpec();
    const validator = new Validator();
    const result = await validator.validate(spec);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    expect(validator.version).toBe('3.1');
  });

  it('documents exactly the registered routes', async () => {
    const documented = new Set(specOperations(await fetchSpec()).map(([key]) => key));
    expect([...registeredRoutes()].sort()).toEqual([...documented].sort());
  });

  it('routes every documented operation to a handler', async () => {
    const { app } = createHarness();
    for (const [key] of specOperations(await fetchSpec())) {
      const [method, path] = key.split(' ') as [(typeof METHODS)[number], string];
      const url = path.replace(/\{\w+\}/g, 'x');
      const res = await request(app)[method](url);
      expect({ key, body: res.body as unknown }).not.toEqual({
        key,
        body: { error: 'Route not found' },
      });
    }
  });

  it('describes every operation with examples and errors', async () => {
    const spec = await fetchSpec();
    for (const [key, op] of specOperations(spec)) {
      expect(op.description, key).toBeTruthy();
      expect(op.summary, key).toBeTruthy();
      expect(op.security, key).toBeDefined();
      const body = (op.requestBody as OpenAPIV3_1.RequestBodyObject | undefined)?.content[
        'application/json'
      ];
      if (body !== undefined) expect(body.example, `${key} request example`).toBeDefined();
      for (const [status, response] of Object.entries(op.responses ?? {})) {
        const json = (response as OpenAPIV3_1.ResponseObject).content?.['application/json'];
        if (json === undefined || Number(status) >= 400) continue;
        expect(json.example, `${key} ${status} example`).toBeDefined();
      }
      if (key.includes('/api/')) {
        expect(Object.keys(op.responses ?? {}), key).toContain('429');
      }
      const security = (op.security ?? []).flatMap((s) => Object.keys(s));
      if (security.length > 0) expect(Object.keys(op.responses ?? {}), key).toContain('401');
    }
  });

  it('declares both token schemes', async () => {
    const spec = await fetchSpec();
    expect(Object.keys(spec.components?.securitySchemes ?? {}).sort()).toEqual([
      'DeviceToken',
      'ReaderToken',
    ]);
    expect(spec.info.description).toContain('End-to-end encryption');
  });
});
