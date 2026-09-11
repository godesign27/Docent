import type { Gap } from "../schema/contract.js";

export type GapInput = Omit<Gap, "id"> & {
  /** Disambiguates several gaps of the same kind on the same subject. */
  detail?: string;
};

/** Collects gaps with stable ids so runs can be diffed. */
export class GapCollector {
  private readonly gaps = new Map<string, Gap>();

  add({ detail, ...gap }: GapInput): void {
    const id = [gap.kind, gap.subject.type, gap.subject.id, detail].filter(Boolean).join(":");
    if (!this.gaps.has(id)) this.gaps.set(id, { id, ...gap });
  }

  list(): Gap[] {
    const rank = { error: 0, warning: 1, info: 2 } as const;
    return [...this.gaps.values()].sort(
      (a, b) => rank[a.severity] - rank[b.severity] || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
    );
  }
}
