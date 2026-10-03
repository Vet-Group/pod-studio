/**
 * Peak-RSS probe for synthetic image output (P1-08 Gate A).
 *
 * Every case runs in a fresh Node process, so the OS peak reported by `process.resourceUsage().maxRSS`
 * belongs to that case alone. Nothing touches the network: the Worker API client and presigned storage
 * are in-process stubs, and the storage stub drains each PUT body chunk by chunk like a socket would.
 *
 *   pnpm --filter @pod-studio/fake-worker measure:rss
 *   pnpm --filter @pod-studio/fake-worker measure:rss -- --counts 1,20 --edges 2048,8192 --ratio 1:1 --json
 *   pnpm --filter @pod-studio/fake-worker measure:rss -- --counts 20 --edges 8192 --max-staged-mib 1
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ClaimedJob, CompleteRequest, RegisterResponse, UploadsRequest, WorkerClient } from '../src/client';
import { runScenario } from '../src/scenarios';

const ratios = ['1:1', '3:4', '4:3', '2:3', '3:2', '4:5', '9:16', '16:9'] as const;
type Ratio = (typeof ratios)[number];
interface ProbeCase { count: number; minLongEdge: number; ratio: Ratio }
interface Measurement extends ProbeCase {
  width: number; height: number; baselineMiB: number; peakMiB: number; deltaMiB: number;
  stagedMiB: number; batches: number; uploadedMiB: number; ms: number;
}

const MiB = 1024 * 1024;
const round = (bytes: number) => Math.round((bytes / MiB) * 10) / 10;

/** `count:minLongEdge:rw:rh`, for example `20:8192:1:1`. */
function parseCase(spec: string): ProbeCase {
  const [count, edge, rw, rh] = spec.split(':');
  const parsed = { count: Number(count), minLongEdge: Number(edge), ratio: `${rw}:${rh}` as Ratio };
  if (!Number.isInteger(parsed.count) || parsed.count < 1 || parsed.count > 20) throw new Error('count must be 1..20');
  if (!Number.isInteger(parsed.minLongEdge) || parsed.minLongEdge < 512 || parsed.minLongEdge > 8192) throw new Error('minLongEdge must be 512..8192');
  if (!ratios.includes(parsed.ratio)) throw new Error('unknown ratio');
  return parsed;
}

async function drain(body: RequestInit['body']): Promise<number> {
  const reader = new Response(body).body?.getReader();
  let bytes = 0;
  if (!reader) return 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return bytes;
    bytes += value.length;
  }
}

async function measure(probe: ProbeCase, maxStagedBytes: number | undefined): Promise<Measurement> {
  const input = Buffer.from('rss probe input');
  const registration: RegisterResponse = {
    workerId: 'worker_rss', accounts: [{ accountKey: 'fake-account', accountId: 'account_rss', state: 'available' }],
    storageOrigins: ['https://storage.example'], heartbeatIntervalSeconds: 1, leaseSeconds: 30, maxClaimWaitSeconds: 20,
  };
  const job: ClaimedJob = {
    id: 'job_rss_probe', type: 'mockup', provider: 'gemini', model: 'imagen-4', attempt: 1, maxAttempts: 3,
    leaseToken: 'rss-probe-lease-token', leaseExpiresAt: '2099-01-01T00:00:00Z', prompt: 'RSS probe',
    inputs: [{
      role: 'design', assetId: 'asset_rss', url: 'https://storage.example/input', urlExpiresAt: '2099-01-01T00:00:00Z',
      sha256: createHash('sha256').update(input).digest('hex'), contentType: 'image/png', bytes: input.length, filename: 'input.png',
    }],
    params: { productType: 'poster', count: probe.count, ratio: probe.ratio, minLongEdge: probe.minLongEdge, mode: 'generate' },
  };
  let staged = 0, uploaded = 0, declared = 0, batches = 0, width = 0, height = 0;
  const client = {
    heartbeat: async () => ({ leaseExpiresAt: '2099-01-01T00:00:00Z', cancelRequested: false }),
    uploads: async (_id: string, request: UploadsRequest) => {
      // Largest single declaration: the bytes the worker held compressed at once before uploading them.
      staged = Math.max(staged, request.files.reduce((sum, file) => sum + file.bytes, 0));
      batches++;
      return {
        uploads: request.files.map(() => {
          const i = declared++;
          return {
            uploadKey: `upload-key-${i}`, url: `https://storage.example/output-${i}`, method: 'PUT' as const,
            headers: { 'Content-Type': 'image/png' }, expiresAt: '2099-01-01T00:00:00Z',
          };
        }),
      };
    },
    complete: async (_id: string, body: CompleteRequest) => {
      if ('images' in body) ({ width, height } = body.images[0]!);
      return { status: 'succeeded' as const, resultIds: ['result_rss'] };
    },
    fail: async () => ({ jobStatus: 'failed' as const, willRetry: false }),
  };
  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      uploaded += await drain(init.body);
      return new Response(null, { status: 200 });
    }
    return new Response(input, { status: 200 });
  };
  const baseline = process.memoryUsage().rss;
  const started = performance.now();
  const result = await runScenario(client as unknown as WorkerClient, job, registration, 'success', { maxStagedBytes });
  const ms = Math.round(performance.now() - started);
  if (result.outcome !== 'completed') throw new Error(`Probe did not complete: ${result.outcome}`);
  const peak = process.resourceUsage().maxRSS * 1024;
  return {
    ...probe, width, height, baselineMiB: round(baseline), peakMiB: round(peak), deltaMiB: round(peak - baseline),
    stagedMiB: round(staged), batches, uploadedMiB: round(uploaded), ms,
  };
}

function list(value: string | undefined, fallback: number[]): number[] {
  return value ? value.split(',').map(Number) : fallback;
}

function parent(argv: string[]): number {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const counts = list(flag('--counts'), [1, 4, 20]);
  const edges = list(flag('--edges'), [512, 2048, 4096, 8192]);
  const ratio = flag('--ratio') ?? '1:1';
  const json = argv.includes('--json');
  const maxStagedMiB = flag('--max-staged-mib');
  const stagedArgs = maxStagedMiB ? ['--max-staged-mib', maxStagedMiB] : [];
  const script = fileURLToPath(import.meta.url);
  let failed = 0;
  if (!json) console.log('count\tedge\tratio\twidth\theight\tbaseMiB\tpeakMiB\tdeltaMiB\tstagedMiB\tbatches\tuploadMiB\tms');
  for (const minLongEdge of edges) {
    for (const count of counts) {
      const spec = `${count}:${minLongEdge}:${ratio}`;
      parseCase(spec);
      // Re-use the current loader flags (tsx) without a shell, so the probe runs the same way on Windows and POSIX.
      const child = spawnSync(process.execPath, [...process.execArgv, script, '--child', spec, ...stagedArgs], { encoding: 'utf8', timeout: 15 * 60_000 });
      const line = child.stdout.trim().split('\n').pop() ?? '';
      if (child.status !== 0 || !line.startsWith('{')) {
        failed++;
        console.error(`case ${spec} failed (status ${child.status ?? child.signal}): ${child.stderr.trim().split('\n').slice(-3).join(' | ')}`);
        continue;
      }
      const m = JSON.parse(line) as Measurement;
      console.log(json ? line : [m.count, m.minLongEdge, m.ratio, m.width, m.height, m.baselineMiB, m.peakMiB, m.deltaMiB, m.stagedMiB, m.batches, m.uploadedMiB, m.ms].join('\t'));
    }
  }
  return failed ? 1 : 0;
}

const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === '--'));
const childIndex = argv.indexOf('--child');
if (childIndex >= 0) {
  const mib = argv.indexOf('--max-staged-mib');
  const maxStagedBytes = mib >= 0 ? Math.round(Number(argv[mib + 1]) * MiB) : undefined;
  measure(parseCase(argv[childIndex + 1] ?? ''), maxStagedBytes).then(
    (m) => { console.log(JSON.stringify(m)); },
    (error: unknown) => { console.error(error instanceof Error ? error.message : 'probe failed'); process.exitCode = 1; },
  );
} else {
  process.exitCode = parent(argv);
}
