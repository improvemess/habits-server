import { type z } from 'zod';
import { badRequest } from './errors.js';

/** Validates `input` against `schema`; throws a 400 with a readable message. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
  throw badRequest(`Invalid request: ${path}${issue?.message ?? 'invalid input'}`);
}
