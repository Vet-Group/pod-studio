// Compile-time check that generated types keep the contract's key guarantees.
import type { components } from '../generated/worker-api';

type Fail = components['schemas']['FailRequest'];
const ok: Fail = { leaseToken: 'x', errorClass: 'account_rate_limited', message: 'm', retryAfterSeconds: 60 };
// @ts-expect-error unknown error class must not type-check
const bad: Fail = { leaseToken: 'x', errorClass: 'timeout', message: 'm' };

type Claimed = components['schemas']['ClaimedJob'];
export function countFor(j: Claimed): number | undefined {
  if (j.type === 'mockup') return j.params.count;
  if (j.type === 'listing_content') return j.params.locale.length;
  return undefined;
}
void ok;
void bad;
