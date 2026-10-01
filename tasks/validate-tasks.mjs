#!/usr/bin/env node
// Validates the planning catalogue only. It does not run any product test.
// Usage: node tasks/validate-tasks.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const PLANNED = 'PLANNED - not implemented, not executed';
const SCREENS = 7; // design/wireframes/index.html: 7 nav screens
const errors = [];
const fail = (m) => errors.push(m);

const { tasks } = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8'));
const ids = tasks.map((t) => t.id);
const byId = new Map(tasks.map((t) => [t.id, t]));

if (tasks.length < 30 || tasks.length > 40) fail(`task count ${tasks.length} outside 30-40`);
if (new Set(ids).size !== ids.length) fail('duplicate task ids');

for (const t of tasks) {
  if (!/^P[123]-\d{2}$/.test(t.id)) fail(`${t.id}: bad id format`);
  if (t.phase !== t.id.slice(0, 2)) fail(`${t.id}: phase mismatch`);
  if (!['web', 'worker', 'both'].includes(t.owner)) fail(`${t.id}: bad owner ${t.owner}`);
  if (!t.paths?.length) fail(`${t.id}: no proposed paths`);
  if (!t.tests?.length) fail(`${t.id}: no planned tests`);
  if (!t.done?.length) fail(`${t.id}: no done criteria`);
  for (const ts of t.tests ?? []) {
    if (ts.status !== PLANNED) fail(`${t.id}: test ${ts.file} not labelled PLANNED`);
    if (!ts.scenarios?.length) fail(`${t.id}: test ${ts.file} has no scenarios`);
  }
  for (const s of t.screens) if (!Number.isInteger(s) || s < 1 || s > SCREENS) fail(`${t.id}: bad screen ${s}`);
  for (const d of t.depends_on) {
    if (!byId.has(d)) fail(`${t.id}: missing dependency ${d}`);
    else if (d.slice(0, 2) > t.id.slice(0, 2)) fail(`${t.id}: depends on later phase ${d}`);
  }
}

// Cycle check (iterative DFS colouring).
const colour = new Map();
const visit = (id, stack) => {
  if (colour.get(id) === 2) return;
  if (colour.get(id) === 1) { fail(`cycle: ${[...stack, id].join(' -> ')}`); return; }
  colour.set(id, 1);
  for (const d of byId.get(id)?.depends_on ?? []) visit(d, [...stack, id]);
  colour.set(id, 2);
};
for (const id of ids) visit(id, []);

// Every screen of the prototype must be covered by at least one task.
for (let s = 1; s <= SCREENS; s++) if (!tasks.some((t) => t.screens.includes(s))) fail(`screen ${s} not covered`);

// Markdown files must list every task of their phase, and no smart punctuation anywhere.
const banned = /[\u2014\u2013\u201C\u201D\u2018\u2019\u2026]/;
for (const f of readdirSync(dir).filter((f) => /\.(md|json|mjs)$/.test(f))) {
  const text = readFileSync(join(dir, f), 'utf8');
  const lines = text.split('\n');
  lines.forEach((l, i) => { if (banned.test(l)) fail(`${f}:${i + 1}: smart punctuation`); });
  const m = f.match(/^(P[123])-/);
  if (m) for (const t of tasks.filter((t) => t.phase === m[1])) if (!text.includes(`## ${t.id} `)) fail(`${f}: missing section ${t.id}`);
}

const count = (p) => tasks.filter((t) => t.phase === p).length;
if (errors.length) {
  console.error(errors.map((e) => `FAIL ${e}`).join('\n'));
  process.exit(1);
}
console.log(`OK ${tasks.length} tasks (P1 ${count('P1')}, P2 ${count('P2')}, P3 ${count('P3')}), ` +
  `${tasks.reduce((n, t) => n + t.tests.length, 0)} planned test files, no cycles, all ${SCREENS} screens covered.`);
