/**
 * demo.ts
 *
 * A small program for understanding Reciprocal Rank Fusion (RRF).
 *
 * Run:
 *     node demo.ts
 */

interface Doc {
  id: string;
  text: string;
}

const DOCUMENTS: Record<string, Doc> = {
  A: { id: 'A', text: 'Button component with primary and secondary variants' },
  B: { id: 'B', text: 'Form input component with validation' },
  C: { id: 'C', text: 'Primary button used for important actions' },
  D: { id: 'D', text: 'Navigation menu and sidebar' },
  E: { id: 'E', text: 'CTA component for submitting forms' },
};

// Imagine these came from two completely different retrieval systems.
//
// BM25 cares about lexical/token overlap.
// Vector search cares about semantic similarity.

const bm25Ranking = [
  'A', // rank 1
  'C', // rank 2
  'B', // rank 3
  'D', // rank 4
];

const vectorRanking = [
  'C', // rank 1
  'E', // rank 2
  'A', // rank 3
  'B', // rank 4
];

/**
 * Contribution produced by one ranking.
 *
 * rank=1 -> 1 / (k + 1)
 * rank=2 -> 1 / (k + 2)
 */
function reciprocalRank(rank: number, k: number = 60): number {
  return 1 / (k + rank);
}

function rrf(rankings: Record<string, string[]>, k: number = 60): Record<string, number> {
  const scores: Record<string, number> = {};

  for (const [rankingName, ranking] of Object.entries(rankings)) {
    console.log(`\n--- ${rankingName} ---`);

    for (const [index, documentId] of ranking.entries()) {
      const rank = index + 1;
      const contribution = reciprocalRank(rank, k);

      console.log(`${documentId}: rank=${rank} => 1 / (${k} + ${rank}) = ${contribution.toFixed(6)}`);

      scores[documentId] = (scores[documentId] ?? 0) + contribution;
    }
  }

  return scores;
}

function printRanking(title: string, ranking: string[]): void {
  console.log(`\n${title}`);

  for (const [index, documentId] of ranking.entries()) {
    const document = DOCUMENTS[documentId];
    console.log(`${index + 1}. ${documentId}: ${document.text}`);
  }
}

function main(): void {
  console.log('='.repeat(70));
  console.log('RECIPROCAL RANK FUSION');
  console.log('='.repeat(70));

  printRanking('BM25 ranking', bm25Ranking);
  printRanking('Vector ranking', vectorRanking);

  const rankings = {
    BM25: bm25Ranking,
    Vector: vectorRanking,
  };

  console.log('\n\nCalculating RRF contributions...');

  const scores = rrf(rankings, 60);

  const fusedRanking = Object.entries(scores).sort((a, b) => b[1] - a[1]);

  console.log('\n');
  console.log('='.repeat(70));
  console.log('FINAL RRF RANKING');
  console.log('='.repeat(70));

  for (const [index, [documentId, score]] of fusedRanking.entries()) {
    const document = DOCUMENTS[documentId];
    console.log(`${index + 1}. ${documentId} RRF=${score.toFixed(6)}`);
    console.log(`   ${document.text}`);
  }

  console.log('\n');
  console.log('='.repeat(70));
  console.log('WHY DID EACH DOCUMENT GET THAT SCORE?');
  console.log('='.repeat(70));

  const allDocuments = new Set<string>();

  for (const ranking of Object.values(rankings)) {
    for (const documentId of ranking) allDocuments.add(documentId);
  }

  for (const documentId of [...allDocuments].sort()) {
    console.log(`\nDocument ${documentId}`);

    let total = 0;

    for (const [rankingName, ranking] of Object.entries(rankings)) {
      if (!ranking.includes(documentId)) {
        console.log(`  ${rankingName.padEnd(10)}: not retrieved -> +0`);
        continue;
      }

      const rank = ranking.indexOf(documentId) + 1;
      const contribution = reciprocalRank(rank, 60);

      total += contribution;

      console.log(`  ${rankingName.padEnd(10)}: rank ${rank} -> 1/(60+${rank}) = ${contribution.toFixed(6)}`);
    }

    console.log(`  ${'TOTAL'.padEnd(10)}: ${total.toFixed(6)}`);
  }
}

main();
