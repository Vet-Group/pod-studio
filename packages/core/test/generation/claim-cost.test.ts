import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { eq, generationJobs, providerAccounts, sql } from '@pod-studio/db';
import { claimCandidateQuery, claimJob } from '../../src/generation/scheduler';
import { harness, now } from './harness';

it('claims from 2000 queued jobs without scanning 50000 completed jobs for turns', async () => {
  const { db, client, accountId, workerId } = await harness();
  await db.update(providerAccounts).set({ maxConcurrency: 1000 }).where(eq(providerAccounts.id, accountId));
  await db.execute(sql`insert into users (id, name, email)
    select 'cost_user_' || n, 'Cost user ' || n, 'cost' || n || '@example.test' from generate_series(0, 4) n`);
  await db.execute(sql`insert into stores (id, name, domain)
    select 'cost_store_' || n, 'Cost store ' || n, 'cost' || n || '.myshopify.com' from generate_series(0, 39) n`);
  await db.execute(sql`insert into generation_jobs (id, store_id, requester_id, type, provider, created_at, available_at)
    select 'cost_queue_' || n, 'cost_store_' || (n % 40), 'cost_user_' || ((n / 40) % 5), 'generate', 'chatgpt',
      ${now.toISOString()}::timestamptz - n * interval '1 second', ${now.toISOString()}::timestamptz from generate_series(1, 2000) n`);
  // Seed durable cursor state once, holding the same active queue and cursor cardinality in both runs.
  await db.execute(sql`insert into generation_store_turns (id, priority, store_id, last_dispatch)
    select 'cost_store_turn_' || n, 'normal', 'cost_store_' || n, n + 1 from generate_series(0, 39) n`);
  await db.execute(sql`insert into generation_requester_turns (id, priority, store_id, requester_id, last_dispatch)
    select 'cost_requester_turn_' || s || '_' || u, 'normal', 'cost_store_' || s, 'cost_user_' || u, s * 5 + u + 1
      from generate_series(0, 39) s cross join generate_series(0, 4) u`);
  await db.execute(sql`select setval('generation_dispatch_order_seq', 50000, true)`);

  async function measure() {
    await db.execute(sql`analyze generation_jobs`);
    await db.execute(sql`analyze generation_store_turns`);
    await db.execute(sql`analyze generation_requester_turns`);
    const timings: number[] = [];
    for (let i = 0; i < 35; i++) {
      const start = performance.now();
      const job = await claimJob(db, { accountId, workerId }, now);
      const elapsed = performance.now() - start;
      expect(job).not.toBeNull();
      if (i >= 10) timings.push(elapsed);
      await db.update(generationJobs).set({ status: 'queued', accountId: null, workerId: null, leaseToken: null, leaseExpiresAt: null })
        .where(eq(generationJobs.id, job!.id));
    }
    timings.sort((a, b) => a - b);
    return { medianMs: timings[12]!, p95Ms: timings[23]!, samples: timings.length };
  }

  const small = await measure();
  await db.execute(sql`insert into generation_jobs (id, store_id, requester_id, type, provider, status, dispatch_order, finished_at)
    select 'cost_history_' || n, 'cost_store_' || (n % 40), 'cost_user_' || ((n / 40) % 5),
      'generate', 'chatgpt', 'completed', n, ${now.toISOString()}::timestamptz from generate_series(1, 50000) n`);
  const large = await measure();
  const [account] = await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
  const query = claimCandidateQuery(db, account!, now).toSQL();
  const plan = await client.begin(async (tx) => {
    await tx`set local plan_cache_mode = force_generic_plan`;
    await tx.unsafe('PREPARE generation_candidate AS ' + query.sql);
    try {
      const args = query.params.map((p) => "'" + String(p instanceof Date ? p.toISOString() : p).replaceAll("'", "''") + "'").join(', ');
      const rows = await tx.unsafe('EXPLAIN (ANALYZE, BUFFERS) EXECUTE generation_candidate(' + args + ')');
      return rows.map((row) => row['QUERY PLAN'] as string).join('\n');
    } finally {
      await tx.unsafe('DEALLOCATE generation_candidate');
    }
  });
  expect(plan).not.toMatch(/Seq Scan on generation_jobs/);
  expect(plan).toContain('Index Scan using generation_jobs_claimable_idx');
  expect(plan).toContain('generation_store_turns');
  expect(plan).toContain('generation_requester_turns');
  expect(query.sql.match(/from "generation_jobs"/g)).toHaveLength(1);
  expect(query.sql).not.toMatch(/max\(/i);
  expect(query.sql).toContain("= 'queued'");
  expect(query.sql).toContain('= false');
  console.info('CLAIM_COST ' + JSON.stringify({ queued: 2000, stores: 40, requesters: 5, small: { history: 0, ...small }, large: { history: 50000, ...large } }));
  console.info('CLAIM_EXPLAIN\n' + plan);
}, 60_000);
