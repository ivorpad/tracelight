/** Reciprocal Rank Fusion, the same arithmetic as demo.ts, as a module the API imports. */

/** One ranking's contribution for a document at `rank` (1-based). */
export function reciprocalRank(rank: number, k: number = 60): number {
  return 1 / (k + rank);
}

/** Fuse several rankings into one score per document. */
export function rrf(rankings: Record<string, string[]>, k: number = 60): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const ranking of Object.values(rankings)) {
    for (const [index, documentId] of ranking.entries()) {
      const contribution = reciprocalRank(index + 1, k);
      scores[documentId] = (scores[documentId] ?? 0) + contribution;
    }
  }
  return scores;
}

/** Documents from the best score down; ties keep their first appearance. */
export function fusedOrder(scores: Record<string, number>): Array<[string, number]> {
  return Object.entries(scores).sort((a, b) => b[1] - a[1]);
}
