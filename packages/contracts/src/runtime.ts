import Ajv2020, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = 'https://pod-studio.internal/contracts/v2';
const readJson = (name: string): AnySchema => JSON.parse(readFileSync(join(root, 'schemas', name), 'utf8')) as AnySchema;

function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === 'discriminator') continue;
      if (key === '$ref' && typeof child === 'string' && child.startsWith('#/components/schemas/')) {
        output[key] = child.replace('#/components/schemas/', '#/$defs/');
      } else output[key] = rewriteRefs(child);
    }
    return output;
  }
  return value;
}

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
ajv.addSchema(readJson('common.schema.json'));
ajv.addSchema(readJson('job.schema.json'));
ajv.addSchema(readJson('skill-manifest.schema.json'));
const openapi = parse(readFileSync(join(root, 'openapi', 'worker-api.yaml'), 'utf8')) as { components: { schemas: unknown } };
ajv.addSchema({ $id: `${base}/openapi/worker-api.json`, $defs: rewriteRefs(openapi.components.schemas) } as AnySchema);

export type ContractSchemaName =
  | 'RegisterRequest' | 'RegisterResponse' | 'ClaimRequest' | 'ClaimResponse'
  | 'HeartbeatRequest' | 'HeartbeatResponse' | 'UploadsRequest' | 'UploadsResponse'
  | 'CompleteRequest' | 'CompleteResponse' | 'FailRequest' | 'FailResponse'
  | 'AccountStatusRequest' | 'AccountStatusResponse' | 'SkillVersionResponse'
  | 'Problem' | 'ListingContentPayload' | 'ProductAnalysisPayload';

const schemaIds: Record<ContractSchemaName, string> = {
  RegisterRequest: `${base}/openapi/worker-api.json#/$defs/RegisterRequest`,
  RegisterResponse: `${base}/openapi/worker-api.json#/$defs/RegisterResponse`,
  ClaimRequest: `${base}/openapi/worker-api.json#/$defs/ClaimRequest`,
  ClaimResponse: `${base}/openapi/worker-api.json#/$defs/ClaimResponse`,
  HeartbeatRequest: `${base}/openapi/worker-api.json#/$defs/HeartbeatRequest`,
  HeartbeatResponse: `${base}/openapi/worker-api.json#/$defs/HeartbeatResponse`,
  UploadsRequest: `${base}/openapi/worker-api.json#/$defs/UploadsRequest`,
  UploadsResponse: `${base}/openapi/worker-api.json#/$defs/UploadsResponse`,
  CompleteRequest: `${base}/openapi/worker-api.json#/$defs/CompleteRequest`,
  CompleteResponse: `${base}/openapi/worker-api.json#/$defs/CompleteResponse`,
  FailRequest: `${base}/openapi/worker-api.json#/$defs/FailRequest`,
  FailResponse: `${base}/openapi/worker-api.json#/$defs/FailResponse`,
  AccountStatusRequest: `${base}/openapi/worker-api.json#/$defs/AccountStatusRequest`,
  AccountStatusResponse: `${base}/openapi/worker-api.json#/$defs/AccountStatusResponse`,
  SkillVersionResponse: `${base}/openapi/worker-api.json#/$defs/SkillVersionResponse`,
  Problem: `${base}/schemas/common.schema.json#/$defs/Problem`,
  ListingContentPayload: `${base}/schemas/job.schema.json#/$defs/ListingContentPayload`,
  ProductAnalysisPayload: `${base}/schemas/job.schema.json#/$defs/ProductAnalysisPayload`,
};

const validators = new Map<ContractSchemaName, ValidateFunction>();
for (const [name, id] of Object.entries(schemaIds) as Array<[ContractSchemaName, string]>) {
  const validator = ajv.getSchema(id);
  if (!validator) throw new Error(`Missing contract schema ${name}`);
  validators.set(name, validator);
}

export interface ContractValidationError { path: string; message: string }
export function validateContract(name: ContractSchemaName, value: unknown): ContractValidationError[] {
  const validator = validators.get(name)!;
  if (validator(value)) return [];
  return (validator.errors ?? []).map((error: ErrorObject) => ({ path: error.instancePath || '/', message: error.message ?? 'is invalid' }));
}
export function assertContract(name: ContractSchemaName, value: unknown): void {
  const errors = validateContract(name, value);
  if (errors.length) {
    const error = new Error(`Contract validation failed for ${name}`);
    Object.assign(error, { contractErrors: errors });
    throw error;
  }
}
export function contractValidator(name: ContractSchemaName): ValidateFunction { return validators.get(name)!; }
