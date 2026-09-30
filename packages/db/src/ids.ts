import { nanoid } from 'nanoid';

/**
 * Primary keys are opaque text ids (PRD §4 convention). The pattern is the `Id` definition in
 * packages/contracts/schemas/common.schema.json; test/ids.test.ts reads it from there so the two
 * cannot drift apart.
 */
export const ID_PATTERN = /^[A-Za-z0-9_-]{8,40}$/;

/** A new 21-character nanoid (URL-safe alphabet, ~126 bits of randomness). */
export function newId(): string {
  return nanoid();
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}
