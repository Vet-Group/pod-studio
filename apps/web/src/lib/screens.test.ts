// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findScreen, screens } from './screens';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const repo = (p: string) => resolve(root, p);

describe('screens', () => {
  it('matches the wireframe navigation labels and order', () => {
    const html = readFileSync(repo('design/wireframes/index.html'), 'utf8');
    const navs = /const navs=(\[.*?\]);/s.exec(html)?.[1];
    expect(navs).toBeDefined();
    const wire = JSON.parse(navs!.replaceAll("'", '"')) as [string, string][];
    expect(screens.map((s) => [s.wireframe, s.label])).toEqual(wire);
  });

  it('points every screen at a real task in tasks/tasks.json', () => {
    const tasks = JSON.parse(readFileSync(repo('tasks/tasks.json'), 'utf8')) as { tasks: { id: string }[] };
    const ids = new Set(tasks.tasks.map((t) => t.id));
    for (const s of screens) expect(ids, `${s.slug} -> ${s.task}`).toContain(s.task);
  });

  it('finds screens by slug', () => {
    expect(findScreen('duyet')?.label).toBe('Duyệt thiết kế');
    expect(findScreen('khong-co')).toBeUndefined();
  });
});
