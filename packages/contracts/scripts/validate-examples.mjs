// Validates every example against the contract and proves that invalid fixtures are rejected.
// Usage: node scripts/validate-examples.mjs   (exit code 1 on any mismatch)
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://pod-studio.internal/contracts/v2';
const readJson = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

// strictRequired is off only because `oneOf: [{required:[images]}, {required:[payload]}]` is valid
// JSON Schema that Ajv's strict mode flags; every other strict check stays on.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
for (const f of ['common', 'job', 'skill-manifest']) ajv.addSchema(readJson(`schemas/${f}.schema.json`));

// OpenAPI components -> a JSON Schema document. `discriminator` is an OpenAPI annotation that Ajv
// does not support with `mapping`; oneOf + const type already enforces the same rule.
const openapi = parse(readFileSync(join(root, 'openapi/worker-api.yaml'), 'utf8'));
const rewrite = (node) => {
  if (Array.isArray(node)) return node.map(rewrite);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'discriminator') continue;
      if (k === '$ref' && typeof v === 'string' && v.startsWith('#/components/schemas/')) {
        out[k] = v.replace('#/components/schemas/', '#/$defs/');
      } else out[k] = rewrite(v);
    }
    return out;
  }
  return node;
};
const OPENAPI_ID = `${BASE}/openapi/worker-api.json`;
ajv.addSchema({ $id: OPENAPI_ID, $defs: rewrite(openapi.components.schemas) });

const validator = (target) =>
  target === 'skill-manifest'
    ? ajv.getSchema(`${BASE}/schemas/skill-manifest.schema.json`)
    : target.includes('#')
      ? ajv.getSchema(`${BASE}/schemas/${target}`)
      : ajv.getSchema(`${OPENAPI_ID}#/$defs/${target}`);

const workerTargets = [
  [/^register\.request/, 'RegisterRequest'],
  [/^register\.response/, 'RegisterResponse'],
  [/^claim\.request/, 'ClaimRequest'],
  [/^claim\..+\.response/, 'ClaimResponse'],
  [/^heartbeat\.request/, 'HeartbeatRequest'],
  [/^heartbeat\.response/, 'HeartbeatResponse'],
  [/^uploads\.request/, 'UploadsRequest'],
  [/^uploads\.response/, 'UploadsResponse'],
  [/^complete\..+\.request/, 'CompleteRequest'],
  [/^complete\.response/, 'CompleteResponse'],
  [/^fail\..+\.request/, 'FailRequest'],
  [/^fail\.response/, 'FailResponse'],
  [/^account-status\.request/, 'AccountStatusRequest'],
  [/^account-status\.response/, 'AccountStatusResponse'],
  [/^skill-version\.response/, 'SkillVersionResponse'],
];

let failures = 0;
let passes = 0;
const report = (ok, label, errors) => {
  if (ok) {
    passes++;
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}`);
    for (const e of errors ?? []) console.log(`        ${e.instancePath || '/'} ${e.message}`);
  }
};

// Semantic rule JSON Schema cannot express: template placeholders and declared variables must match.
const checkTemplateVariables = (manifest) => {
  const pt = manifest.promptTemplate;
  if (!pt) return [];
  const text = `${pt.systemPrompt ?? ''}\n${pt.template}`;
  const used = new Set([...text.matchAll(/\{\{\s*([A-Za-z0-9]+)\s*\}\}/g)].map((m) => m[1]));
  const declared = new Set(pt.variables.map((v) => v.name));
  const errs = [];
  for (const u of used) if (!declared.has(u)) errs.push({ instancePath: '/promptTemplate/template', message: `uses undeclared variable {{${u}}}` });
  for (const d of declared) if (!used.has(d)) errs.push({ instancePath: '/promptTemplate/variables', message: `declares unused variable ${d}` });
  return errs;
};

console.log('Valid worker examples');
for (const file of readdirSync(join(root, 'examples/worker')).sort()) {
  const hit = workerTargets.find(([re]) => re.test(file));
  if (!hit) {
    report(false, `worker/${file}`, [{ message: 'no schema mapping for this file name' }]);
    continue;
  }
  const doc = readJson(`examples/worker/${file}`);
  const v = validator(hit[1]);
  let ok = v(doc);
  let errors = v.errors;
  if (ok && file.startsWith('complete.listing-content')) {
    const p = validator('job.schema.json#/$defs/ListingContentPayload');
    ok = p(doc.payload);
    errors = p.errors;
  }
  report(ok, `worker/${file} -> ${hit[1]}`, errors);
}

console.log('Valid skill manifests');
for (const file of readdirSync(join(root, 'examples/skills')).sort()) {
  const doc = readJson(`examples/skills/${file}`);
  const v = validator('skill-manifest');
  const ok = v(doc);
  const semantic = ok ? checkTemplateVariables(doc) : [];
  report(ok && semantic.length === 0, `skills/${file}`, ok ? semantic : v.errors);
}

console.log('Invalid fixtures (must be rejected)');
for (const file of readdirSync(join(root, 'examples/invalid')).sort()) {
  const { target, doc, semantic } = readJson(`examples/invalid/${file}`);
  const v = validator(target);
  // `semantic: true` fixtures are schema-valid on purpose and must be caught by the semantic check.
  const accepted = v(doc) && (!semantic || checkTemplateVariables(doc).length === 0);
  report(!accepted, `invalid/${file} rejected by ${target}`, accepted ? [{ message: 'was accepted but should fail' }] : undefined);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
