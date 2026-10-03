import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeBaseUrl, WorkerApiProblem, WorkerClient, type JobType } from './client';
import { runScenario, scenarios, type Scenario } from './scenarios';

const jobTypes: JobType[] = ['mockup', 'redesign', 'listing_content', 'product_analysis'];
const help = `POD Studio fake worker (one registration, one claim, one scenario)

Usage:
  pnpm --filter @pod-studio/fake-worker start -- [options]

Required environment:
  WORKER_TOKEN                  Per-worker token issued by an admin; never a CLI flag

Options:
  --help                        Show this help without authentication
  --base-url URL                Worker API base (default: http://127.0.0.1:3000/api/worker/v2)
  --worker-key KEY              Required stable key matching the admin-provisioned worker
  --account-key KEY             Local account identity (default: fake-account)
  --scenario NAME               ${scenarios.join(', ')} (default: success)
  --provider KEY                Account provider (default: gemini)
  --channel NAME                Account channel: browser or api (default: browser)
  --wait-seconds N              Claim wait, capped by registration and 25 seconds (default: 0)
  --slow-duration-ms N           Slow scenario delay (default: three heartbeat intervals)
  --heartbeat-interval-ms N      Test-only cadence override (default: registered cadence)

checksum_mismatch is image-only; text jobs have no image checksum.
lease_timeout returns without heartbeats or final writes; the server reaper must expire the lease.
SIGINT/SIGTERM stop heartbeats, retries and storage I/O and skip complete/fail (exit 130); the reaper owns the lease.
`;

export interface CliOptions {
  help: boolean;
  baseUrl: string;
  workerKey?: string;
  accountKey: string;
  scenario: Scenario;
  provider: string;
  channel: 'browser' | 'api';
  waitSeconds: number;
  slowDurationMs?: number;
  heartbeatIntervalMs?: number;
}

/** A leading `--` is passed through by some pnpm versions. Never echo option values in errors. */
export function parseArgs(argv: string[]): CliOptions {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const options: CliOptions = {
    help: false, baseUrl: 'http://127.0.0.1:3000/api/worker/v2', accountKey: 'fake-account',
    scenario: 'success', provider: 'gemini', channel: 'browser', waitSeconds: 0,
  };
  const seen = new Set<string>();
  const valueFlags = new Set(['--base-url', '--worker-key', '--account-key', '--scenario', '--provider', '--channel', '--wait-seconds', '--slow-duration-ms', '--heartbeat-interval-ms']);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) throw new Error('Duplicate CLI option');
    seen.add(flag);
    if (flag === '--help' || flag === '-h') { options.help = true; continue; }
    if (!valueFlags.has(flag)) throw new Error('Unknown CLI option');
    const value = args[++i];
    if (value === undefined || !value.length || value.startsWith('--')) throw new Error('CLI option requires a value');
    switch (flag) {
      case '--base-url': options.baseUrl = value; break;
      case '--worker-key': options.workerKey = value; break;
      case '--account-key': options.accountKey = value; break;
      case '--provider': options.provider = value; break;
      case '--scenario':
        if (!scenarios.includes(value as Scenario)) throw new Error('Invalid scenario');
        options.scenario = value as Scenario; break;
      case '--channel':
        if (value !== 'browser' && value !== 'api') throw new Error('Invalid account channel');
        options.channel = value; break;
      default: {
        const number = /^\d+$/.test(value) ? Number(value) : NaN;
        if (!Number.isSafeInteger(number) || number > 2_147_483_647) throw new Error('Timing options must be non-negative timer-safe integers');
        if (flag === '--wait-seconds') {
          if (number > 25) throw new Error('wait-seconds must be between 0 and 25');
          options.waitSeconds = number;
        } else if (flag === '--slow-duration-ms') options.slowDurationMs = number;
        else {
          if (number === 0) throw new Error('heartbeat-interval-ms must be positive');
          options.heartbeatIntervalMs = number;
        }
      }
    }
  }
  if (!options.help) {
    if (!options.workerKey) throw new Error('--worker-key is required and must match admin provisioning');
    if (!/^[a-z0-9][a-z0-9_.@-]{1,99}$/.test(options.workerKey)) throw new Error('Invalid worker key');
    if (options.accountKey.length > 100) throw new Error('Invalid account key');
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(options.provider)) throw new Error('Invalid provider key');
    // Same guard as the WorkerClient constructor; the client enforces it for every library consumer too.
    try { options.baseUrl = normalizeBaseUrl(options.baseUrl); }
    catch { throw new Error('base-url must be an http(s) URL without credentials, query or fragment'); }
  }
  return options;
}

/** Exit code for a run stopped by SIGINT/SIGTERM (128 + SIGINT). */
export const INTERRUPTED_EXIT_CODE = 130;

export async function main(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) { console.log(help); return 0; }
  const token = env.WORKER_TOKEN;
  if (!token) throw new Error('Set WORKER_TOKEN to the admin-issued worker token');
  const client = new WorkerClient({ baseUrl: options.baseUrl, token });
  try {
    const registration = await client.register({
      workerKey: options.workerKey!, host: hostname(), version: 'fake-worker/0.0.0',
      accounts: [{ accountKey: options.accountKey, provider: options.provider, channel: options.channel, jobTypes, maxConcurrency: 1 }],
    });
    const account = registration.accounts.find((registered) => registered.accountKey === options.accountKey);
    if (!account) throw new Error('Registration did not return the requested account');
    signal?.throwIfAborted();
    const job = await client.claim({
      workerId: registration.workerId, accountId: account.accountId,
      waitSeconds: Math.min(options.waitSeconds, registration.maxClaimWaitSeconds, 25), jobTypes,
    }, signal);
    if (!job) { console.log('No job available; claim finished.'); return 0; }
    const result = await runScenario(client, job, registration, options.scenario, {
      slowDurationMs: options.slowDurationMs, heartbeatIntervalMs: options.heartbeatIntervalMs, signal,
    });
    console.log(`Scenario ${options.scenario}: ${result.outcome}; heartbeats=${result.heartbeatCount}`);
    return signal?.aborted && result.outcome === 'abandoned' ? INTERRUPTED_EXIT_CODE : 0;
  } catch (error) {
    if (!signal?.aborted) throw error;
    console.log('Interrupted; any claimed lease is left to the server reaper.');
    return INTERRUPTED_EXIT_CODE;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const shutdown = new AbortController();
  const interrupt = () => {
    // A second signal falls back to the default immediate exit.
    if (shutdown.signal.aborted) process.exit(INTERRUPTED_EXIT_CODE);
    shutdown.abort(new Error('Fake worker interrupted'));
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  main(process.argv.slice(2), process.env, shutdown.signal).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    // Never log remote problem details, fetch errors, argv, credentials or presigned URLs.
    if (error instanceof WorkerApiProblem) console.error(`Fake worker failed: Worker API status ${error.status}`);
    else console.error('Fake worker failed. Check CLI options, WORKER_TOKEN, provisioning and server availability; use --help.');
    process.exitCode = 1;
  }).finally(() => {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  });
}
