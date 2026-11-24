import type { OpenAPIV3_1 } from 'openapi-types';
import { z } from 'zod';

type JsonSchema = OpenAPIV3_1.SchemaObject;

/** Which credential an operation accepts. */
type OperationAuth = 'none' | 'device' | 'reader' | 'deviceOrReader';

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 429;

interface ResponseSpec {
  description: string;
  /** JSON body; omit for responses without body (e.g. 204). */
  schema?: z.ZodType;
  /** Non-JSON body, e.g. `text/html`. */
  contentType?: string;
}

export interface OperationSpec {
  method: 'get' | 'post' | 'put' | 'delete';
  /** Full path in OpenAPI notation, e.g. `/api/v1/shares/{shareId}`. */
  path: string;
  tag: string;
  summary: string;
  description: string;
  auth: OperationAuth;
  /** Description per `{param}` in the path. All path params are strings. */
  pathParams?: Record<string, string>;
  query?: z.ZodObject;
  body?: z.ZodType;
  responses: Record<number, ResponseSpec>;
  /** Possible error responses with a description of when they happen. */
  errors?: Partial<Record<ErrorStatus, string>>;
}

const SECURITY: Record<OperationAuth, OpenAPIV3_1.SecurityRequirementObject[]> = {
  none: [],
  device: [{ DeviceToken: [] }],
  reader: [{ ReaderToken: [] }],
  deviceOrReader: [{ DeviceToken: [] }, { ReaderToken: [] }],
};

/** Converts a zod schema to JSON Schema 2020-12, as used by OpenAPI 3.1. */
export function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const json = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as JsonSchema & {
    $schema?: string;
  };
  delete json.$schema;
  return json;
}

function firstExample(schema: JsonSchema): unknown {
  const examples = (schema as { examples?: unknown[] }).examples;
  return Array.isArray(examples) ? examples[0] : undefined;
}

function jsonContent(schema: z.ZodType, io: 'input' | 'output'): OpenAPIV3_1.MediaTypeObject {
  const json = toJsonSchema(schema, io);
  const example = firstExample(json);
  return example === undefined ? { schema: json } : { schema: json, example };
}

const errorContent: Record<string, OpenAPIV3_1.MediaTypeObject> = {
  'application/json': { schema: { $ref: '#/components/schemas/Error' } },
};

/** Builds an OpenAPI path item for one operation. */
export function operation(spec: OperationSpec): OpenAPIV3_1.PathsObject {
  const parameters: OpenAPIV3_1.ParameterObject[] = [];
  for (const [name, description] of Object.entries(spec.pathParams ?? {})) {
    parameters.push({ name, in: 'path', required: true, description, schema: { type: 'string' } });
  }
  if (spec.query !== undefined) {
    const json = toJsonSchema(spec.query, 'input');
    const required = new Set(json.required ?? []);
    for (const [name, schema] of Object.entries(json.properties ?? {})) {
      const { description, ...rest } = schema as JsonSchema;
      // openapi-types reuses the 3.0 parameter type; the schema is valid 3.1.
      parameters.push({
        name,
        in: 'query',
        required: required.has(name),
        ...(description === undefined ? {} : { description }),
        schema: rest,
      } as unknown as OpenAPIV3_1.ParameterObject);
    }
  }

  const responses: OpenAPIV3_1.ResponsesObject = {};
  for (const [status, response] of Object.entries(spec.responses)) {
    if (response.schema !== undefined) {
      responses[status] = {
        description: response.description,
        content: { 'application/json': jsonContent(response.schema, 'output') },
      };
    } else if (response.contentType !== undefined) {
      responses[status] = {
        description: response.description,
        content: { [response.contentType]: { schema: { type: 'string' } } },
      };
    } else {
      responses[status] = { description: response.description };
    }
  }

  const errors: Partial<Record<ErrorStatus, string>> = { ...spec.errors };
  if (spec.path.startsWith('/api/')) errors[429] ??= 'Too many requests from this client';
  for (const [status, description] of Object.entries(errors)) {
    responses[status] = { description, content: errorContent };
  }

  const op: OpenAPIV3_1.OperationObject = {
    tags: [spec.tag],
    summary: spec.summary,
    description: spec.description,
    operationId: operationId(spec.method, spec.path),
    security: SECURITY[spec.auth],
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(spec.body !== undefined
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': jsonContent(spec.body, 'input') },
          },
        }
      : {}),
    responses,
  };
  return { [spec.path]: { [spec.method]: op } };
}

function operationId(method: string, path: string): string {
  const words = path
    .replace(/^\/api\/v1/, '')
    .split(/[/{}.\-_]+/)
    .filter((word) => word !== '');
  return [method, ...words.map((word) => word.charAt(0).toUpperCase() + word.slice(1))].join('');
}

/** Merges path items; operations on the same path are combined. */
export function mergePaths(...items: OpenAPIV3_1.PathsObject[]): OpenAPIV3_1.PathsObject {
  const merged: OpenAPIV3_1.PathsObject = {};
  for (const item of items) {
    for (const [path, pathItem] of Object.entries(item)) {
      merged[path] = { ...merged[path], ...pathItem };
    }
  }
  return merged;
}
