import type { Allocation } from "./schemas";

export type SiteStock = {
  siteId: string;
  siteName?: string;
  acuity: 1 | 2 | 3;
  onHand: number;
  inbound: number;
  dailyDemand: number;
};

// Higher-acuity sites are filled to proportionally more days of cover.
export const ACUITY_WEIGHT = { 1: 1.5, 2: 1.2, 3: 1.0 } as const;

// Below this many days of cover after the split, a substitute should be considered.
export const MIN_COVER_DAYS = 5;

export type SplitResult = {
  allocations: Allocation[];
  coverAfter: Record<string, number>;
  minCoverAfter: number;
  shortfall: boolean;
};

const supply = (s: SiteStock) => s.onHand + s.inbound;

/**
 * Deterministic water-fill: raise every site to the same weighted days of cover,
 * where weighted cover = (onHand + inbound + alloc) / (dailyDemand * acuityWeight).
 * Integer units; leftovers go one at a time to the lowest weighted cover (ties by siteId).
 */
export function computeSplit(quantity: number, sites: SiteStock[]): SplitResult {
  if (!Number.isInteger(quantity) || quantity < 0) throw new Error("quantity must be a non-negative integer");
  const eligible = sites.filter((s) => s.dailyDemand > 0).sort((a, b) => a.siteId.localeCompare(b.siteId));
  const scale = (s: SiteStock) => s.dailyDemand * ACUITY_WEIGHT[s.acuity];
  const alloc = new Map<string, number>(eligible.map((s) => [s.siteId, 0]));

  if (eligible.length > 0 && quantity > 0) {
    const needAt = (level: number) =>
      eligible.reduce((sum, s) => sum + Math.max(0, level * scale(s) - supply(s)), 0);

    let lo = 0;
    let hi = Math.max(...eligible.map((s) => (supply(s) + quantity) / scale(s))) + 1;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      if (needAt(mid) <= quantity) lo = mid;
      else hi = mid;
    }

    let given = 0;
    for (const s of eligible) {
      const a = Math.floor(Math.max(0, lo * scale(s) - supply(s)));
      alloc.set(s.siteId, a);
      given += a;
    }

    const weighted = (s: SiteStock) => (supply(s) + alloc.get(s.siteId)!) / scale(s);
    for (let left = quantity - given; left > 0; left--) {
      let best = eligible[0]!;
      for (const s of eligible) if (weighted(s) < weighted(best)) best = s;
      alloc.set(best.siteId, alloc.get(best.siteId)! + 1);
    }
  }

  const coverAfter: Record<string, number> = {};
  for (const s of eligible) coverAfter[s.siteId] = round1((supply(s) + alloc.get(s.siteId)!) / s.dailyDemand);
  const covers = Object.values(coverAfter);
  const minCoverAfter = covers.length ? Math.min(...covers) : Infinity;

  return {
    allocations: eligible
      .map((s) => ({ siteId: s.siteId, quantity: alloc.get(s.siteId)! }))
      .filter((a) => a.quantity > 0),
    coverAfter,
    minCoverAfter,
    shortfall: minCoverAfter < MIN_COVER_DAYS,
  };
}

export function explainSplit(quantity: number, unit: string, sites: SiteStock[], split: SplitResult): string {
  if (split.allocations.length === 0) return `No site has demand for this drug; nothing to allocate.`;
  const name = (id: string) => sites.find((s) => s.siteId === id)?.siteName ?? id;
  const top = [...split.allocations].sort((a, b) => b.quantity - a.quantity)[0]!;
  const lowest = Object.entries(split.coverAfter).sort((a, b) => a[1] - b[1])[0]!;
  const parts = [
    `${quantity} ${unit}s split across ${split.allocations.length} sites to even out days of cover, weighted toward higher-acuity sites.`,
    `Largest share: ${name(top.siteId)} (${top.quantity}).`,
    `Lowest cover after split: ${name(lowest[0])} at ${lowest[1]} days.`,
  ];
  if (split.shortfall) parts.push(`Below the ${MIN_COVER_DAYS}-day floor, so a substitute is suggested.`);
  return parts.join(" ");
}

const round1 = (n: number) => Math.round(n * 10) / 10;
