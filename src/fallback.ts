import {
  calculateRateLimitBackoffMs,
  isUsageLimitOutcome,
  parseRateLimitReason,
  type RateLimitReason,
} from '@oh-my-pi/pi-ai';
import { retryResetTimezoneOffsetFor } from '@oh-my-pi/pi-catalog/compat/behavior';
import { extractRetryHint } from '@oh-my-pi/pi-utils';

/** Compactor failover: how one provider failure classifies into a fallback or a terminal lane, and the process-local
 * availability memory that lets concurrent compressions skip a provider that just failed instead of hammering it.
 * Cooldowns live inside one compressor (a profile opens exactly one), keyed by provider, and always expire, so an
 * expired candidate is tried first again. */

const REASON_LABEL: Record<RateLimitReason, string> = {
  QUOTA_EXHAUSTED: 'quota exhausted',
  INSUFFICIENT_G1_CREDITS_BALANCE: 'quota exhausted',
  RATE_LIMIT_EXCEEDED: 'rate limited',
  CONCURRENT_LIMIT: 'concurrency capped',
  MODEL_CAPACITY_EXHAUSTED: 'service overloaded',
  SERVER_ERROR: 'server error',
  UNKNOWN: 'unavailable',
};

/** Statusless transport failures: the request never reached anything that could answer it. */
const NETWORK_FAILURE_PATTERN =
  /\bfetch failed|network(?: error)?|econn(?:refused|reset|aborted|closed)|enotfound|etimedout|eai_again|epipe|socket hang.?up|premature close|unable to connect|getaddrinfo|other side closed\b/i;

/** The provider's own reset hint in ms when its message carries one — a `retry-after-ms` suffix, Google's `retryDelay`
 * field, an absolute reset stamp (ZAI's read as Beijing wall clock, offset declared by the catalog, never the host
 * zone) — so a cooldown ends exactly when the provider said, never on our guess. */
export function retryHintMs(provider: string, message: string): number | undefined {
  return extractRetryHint(undefined, message, { naiveResetTimezoneOffset: retryResetTimezoneOffsetFor(provider) });
}

/** One classified provider failure. `fallback` lanes move the compression to the next candidate and cool the provider
 * for `cooldownMs` (the provider's reset hint when it gave one, else pi-ai's per-reason backoff). Terminal lanes —
 * malformed input, bad requests, local programming failures — end the invocation unchanged: no other candidate serves
 * them better, and cooling a healthy provider for them would be wrong. */
export interface FailureLane { fallback: boolean; label: string; cooldownMs?: number }

export function classifyFailure(provider: string, status: number | undefined, message: string): FailureLane {
  const hint = retryHintMs(provider, message);
  const cooldown = (reason: RateLimitReason) => hint ?? calculateRateLimitBackoffMs(reason);
  // A 400 is about the request, not the provider: malformed input or a programming failure never improves on another model.
  if (status === 400) return { fallback: false, label: 'rejected the request' };
  // Exhausted quota, 429, 402 — pi-ai's credential-rotation verdict is exactly the move-along verdict here. The
  // cooldown honors the provider's own reset (Google's 31h `retryDelay`, ZAI's Beijing reset stamp) and otherwise
  // falls back to the conservative per-reason default, so an unknown quota waits instead of hammering.
  if (isUsageLimitOutcome(status, message)) {
    const reason = parseRateLimitReason(message);
    return { fallback: true, label: REASON_LABEL[reason], cooldownMs: cooldown(reason) };
  }
  // A bare 401/403 says the credential cannot serve this provider at all; 404 names a model it does not have. Both are
  // unusable-configuration lanes: move on conservatively until the operator or a reset changes the facts.
  if (status === 401 || status === 403) return { fallback: true, label: 'credential unavailable', cooldownMs: cooldown('QUOTA_EXHAUSTED') };
  if (status === 404) return { fallback: true, label: 'model unavailable on provider', cooldownMs: cooldown('QUOTA_EXHAUSTED') };
  // Throttled or billing-capped without quota wording (Google's "Please retry in 5s"): the provider answered, just
  // not for this call. Short backoff, not the quota lane.
  if (status === 429 || status === 402) {
    const reason = parseRateLimitReason(message);
    return { fallback: true, label: REASON_LABEL[reason], cooldownMs: cooldown(reason === 'UNKNOWN' ? 'RATE_LIMIT_EXCEEDED' : reason) };
  }
  if (status === undefined) {
    // No status and no transport wording is a local or programming failure; fallback cannot fix it.
    if (!NETWORK_FAILURE_PATTERN.test(message)) return { fallback: false, label: 'failure' };
    return { fallback: true, label: 'network unreachable', cooldownMs: cooldown('SERVER_ERROR') };
  }
  // Service outage: 5xx and 529. Capacity wording gets pi-ai's jittered capacity backoff, a bare server error the short one.
  if (status >= 500) {
    const reason = parseRateLimitReason(message);
    return { fallback: true, label: REASON_LABEL[reason], cooldownMs: cooldown(reason === 'UNKNOWN' ? 'SERVER_ERROR' : reason) };
  }
  return { fallback: false, label: 'rejected the request' };
}

/** How a compressor may proceed against one provider right now. `go`: known warm, call freely (parallel warm calls
 * never serialize). `cooled`: skip this candidate until `until`. `wait`: one probe is already in flight — await `done`
 * cancelably, then re-evaluate from the chain start. `probe`: you are the single-flight probe; call `release` exactly
 * once after the outcome (and any cooldown it sets) is recorded, so followers wake into the fresh facts. */
export type Claim =
  | { kind: 'go' }
  | { kind: 'cooled'; until: number }
  | { kind: 'wait'; done: Promise<void> }
  | { kind: 'probe'; release(outcome?: 'up' | 'down'): void };

export interface ProviderAvailability {
  /** The provider's cooldown reset instant while it is cooling; expired entries drop lazily and read as undefined. */
  cooled(provider: string): number | undefined;
  /** Enter a cooldown; returns the absolute reset instant. */
  cool(provider: string, cooldownMs: number): number;
  /** Single-flight gate for one call against `provider`. */
  claim(provider: string): Claim;
}

/** Availability memory shared by every compression call through one compressor. A provider nobody has probed yet lets
 * exactly one caller through; concurrent callers wait for that probe and only then re-check the chain. A probe that
 * answers `up` marks the provider warm so later calls never queue behind each other; a failure that sets a cooldown
 * makes every follower skip until the reset instant passes — after which the provider is unknown again and the next
 * caller probes it once more. */
export function providerAvailability(): ProviderAvailability {
  const warm = new Set<string>();
  const cooledUntil = new Map<string, number>();
  const probing = new Map<string, Promise<void>>();
  const releases = new Map<string, () => void>();
  const cooled = (provider: string): number | undefined => {
    const until = cooledUntil.get(provider);
    if (until === undefined) return undefined;
    if (Date.now() < until) return until;
    cooledUntil.delete(provider);
    return undefined;
  };
  return {
    cooled,
    cool(provider, cooldownMs) {
      const until = Date.now() + Math.max(0, cooldownMs);
      cooledUntil.set(provider, until);
      warm.delete(provider);
      return until;
    },
    claim(provider) {
      const until = cooled(provider);
      if (until !== undefined) return { kind: 'cooled', until };
      const pending = probing.get(provider);
      if (pending) return { kind: 'wait', done: pending };
      if (warm.has(provider)) return { kind: 'go' };
      const { promise: done, resolve: release } = Promise.withResolvers<void>();
      releases.set(provider, () => {
        releases.delete(provider);
        probing.delete(provider);
        release();
      });
      probing.set(provider, done);
      let released = false;
      return {
        kind: 'probe',
        release: outcome => {
          if (released) return;
          released = true;
          if (outcome === 'up') warm.add(provider);
          else if (outcome === 'down') warm.delete(provider);
          releases.get(provider)?.();
        },
      };
    },
  };
}

/** Await `pending`, but leave at once — without keeping a listener — when `signal` aborts. */
export async function waitCancelable(pending: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const { promise: aborted, resolve: wake } = Promise.withResolvers<void>();
  signal.addEventListener('abort', wake, { once: true });
  try { await Promise.race([pending, aborted]); } finally { signal.removeEventListener('abort', wake); }
  signal.throwIfAborted();
}
