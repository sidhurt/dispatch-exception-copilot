// Failures injected on purpose. docs/SPEC.md §6.
// Rules are counted ("times: 1"), not random, so an eval run gives the same result every time.
// Rules live in memory: /sim/reset and a restart both clear them.
import { z } from 'zod';

export const ACTION_NAMES = [
  'AssignTruck',
  'AdjustQuantity',
  'PostGoodsIssue',
  'ReverseGoodsIssue',
  'RequestCreditRelease',
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

const ruleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('timeout_after_commit'), action: z.enum(ACTION_NAMES), times: z.int().positive() }).strict(),
  z.object({ kind: z.literal('lock_conflict'), action: z.enum(ACTION_NAMES), times: z.int().positive() }).strict(),
  z
    .object({ kind: z.literal('outage'), startAfterRequests: z.int().nonnegative(), durationSeconds: z.number().positive() })
    .strict(),
]);
export const chaosConfigSchema = z.object({ rules: z.array(ruleSchema) }).strict();
export type ChaosRule = z.infer<typeof ruleSchema>;

type LiveRule = ChaosRule & { remaining?: number; requestsSeen?: number; startedAt?: number };

export class Chaos {
  private rules: LiveRule[] = [];

  set(rules: ChaosRule[]) {
    this.rules = rules.map((r) => ({ ...r, ...('times' in r ? { remaining: r.times } : { requestsSeen: 0 }) }));
  }

  clear() {
    this.rules = [];
  }

  /** What's configured, and how much of it is left. */
  describe() {
    return this.rules.map(({ startedAt, ...r }) => ({ ...r, active: startedAt !== undefined }));
  }

  /**
   * Called for every /odata request. Returns the seconds until the outage ends,
   * or null if there is no outage right now.
   */
  outageRetryAfter(now = Date.now()): number | null {
    for (const r of this.rules) {
      if (r.kind !== 'outage') continue;
      if (r.startedAt === undefined) {
        r.requestsSeen = (r.requestsSeen ?? 0) + 1;
        if (r.requestsSeen <= r.startAfterRequests) continue;
        r.startedAt = now;
      }
      const endsAt = r.startedAt + r.durationSeconds * 1000;
      if (now < endsAt) return Math.ceil((endsAt - now) / 1000);
      this.rules = this.rules.filter((x) => x !== r); // window over
    }
    return null;
  }

  /** True if a counted rule of this kind fires for this action (and uses up one of its "times"). */
  take(kind: 'timeout_after_commit' | 'lock_conflict', action: ActionName): boolean {
    const r = this.rules.find((x) => x.kind === kind && 'action' in x && x.action === action && (x.remaining ?? 0) > 0);
    if (!r) return false;
    r.remaining! -= 1;
    return true;
  }
}
