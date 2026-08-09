/**
 * Ingest high-signal Merkle / MMR / IMT sources into Chamber vector corpus.
 * No marketing — technical posts + Grin docs only.
 *
 *   CHAMBER_DB=/tmp/chamber.sqlite node --experimental-strip-types scripts/ingest_merkle_corpus.ts
 */

import { openChamberDb } from "../src/db.ts";
import { upsertDocument, searchVector, countDocuments } from "../src/vector.ts";
import { minilmAvailable, MINILM_MODEL } from "../src/embedder.ts";

interface Doc {
  id: string;
  title: string;
  body: string;
  sourceRef: string;
  author?: string;
}

const DOCS: Doc[] = [
  {
    id: "x_peterktodd_mmr_name",
    title: "Peter Todd: MMR name and independent invention",
    author: "peterktodd",
    sourceRef: "https://x.com/peterktodd/status/2074627647876005991",
    body: `Peter Todd (@peterktodd), OpenTimestamps founder, on Merkle Mountain Ranges (2026-07-07):

"MMR's are such a basic idea that anyone competent enough who needed one will invent it: certificate transparency post dates the publication of my MMR page, and I'm sure they independently invented it on their own. But I'm responsible for the name and gold description."

Relevance to Chamber: we use MMR-style peaks for incremental audit Merkle roots (sha256_mmr_peaks_v1). Naming and priority of append-friendly structure over full rebuilds trace to this lineage.`,
  },
  {
    id: "x_peterktodd_mmr_growing_file",
    title: "Peter Todd: MMR proofs for growing files without full reveal",
    author: "peterktodd",
    sourceRef: "https://x.com/peterktodd/status/2037509126679371798",
    body: `Peter Todd on OpenTimestamps MMR work (2026-03-27):

Working on a clean way to represent Merkle Mountain Range proofs. Rolling timestamps (otslog) worked technically but were not great for real use. MMR proofs enable: timestamp a growing file incrementally, then prove a timestamp on any subset of the file — without revealing the entire file.

Key property: selective disclosure over an append-only commitment. Chamber maps this to audit inclusion under a live bagged-peaks root without shipping the full audit log.`,
  },
  {
    id: "x_peterktodd_ots_git",
    title: "Peter Todd: OpenTimestamps + git integration is a solved integrity pattern",
    author: "peterktodd",
    sourceRef: "https://x.com/peterktodd/status/2079918586349363275",
    body: `Peter Todd (2026-07-22) pointing at OpenTimestamps git integration:
https://petertodd.org/2016/opentimestamps-git-integration

Pattern: commit hashes into a public timestamp calendar; later prove a commit existed at a time without trusting a single server. Combines hash chains (git) with calendar aggregation (Merkle). Chamber pairs local SHA-256 audit hash-chain with incremental MMR root for the same class of integrity claim.`,
  },
  {
    id: "x_tactful_imt_definition",
    title: "TactfulCipher: Incremental Merkle Tree definition",
    author: "TactfulCipher",
    sourceRef: "https://x.com/TactfulCipher/status/2076002535836688765",
    body: `Tactful Cipher ZK roadmap notes (2026-07-11):

"Incremental Merkle Trees solve a completely different problem. Instead of rebuilding a tree every time new data arrives, they let you efficiently append new leaves while updating only the affected path to the root."

Related thread points:
- Merkle tree = prove a piece belongs to a larger dataset without sending the whole set
- Root = fingerprint of the entire dataset; change one leaf → different root
- Proof = sibling hashes needed to reconstruct the root
- Sparse Merkle Trees: huge key space, most empty; membership and non-membership

Chamber appendMerkleLeaf is the MMR/peak form of this "no full rebuild on append" rule.`,
  },
  {
    id: "x_grantosan_grin_mmr",
    title: "Grant: Grin/Chia-style MMR root over finalized headers",
    author: "grantosan",
    sourceRef: "https://x.com/grantosan/status/2074341643600253438",
    body: `Grant (@grantosan), 2026-07-07:

Merkle Mountain Range merged into consensus (May 2026 hard fork path). New blocks carry an MMR root over the header hashes of every finalized block before it.
Docs: https://docs.grin.mw/wiki/chain-state/merkle-mountain-range/

Result: faster sync. Instead of downloading whole challenge slots, inclusion proofs sample individual blocks by header hash — smaller proofs, stronger guarantees.
Related PR context: Chia-Network/chia-blockchain#20340

Chamber parallel: audit events as leaves; live MMR root as continuous commitment; checkpoints publish that root without rebuilding history.`,
  },
  {
    id: "docs_grin_mmr",
    title: "Grin docs: Merkle Mountain Range structure and proofs",
    author: "grin-docs",
    sourceRef: "https://docs.grin.mw/wiki/chain-state/merkle-mountain-range/",
    body: `Grin Merkle Mountain Range (technical summary):

Structure: Append-only. Elements added left-to-right; parents created when two children exist. Represented as list of balanced subtrees (peaks). Fully described by total size N. Heights and parents navigable via binary arithmetic on position.

Peaks: Highest nodes without right siblings. Peaks hashed iteratively (bagged) to form root.

Append: Strictly append-only. Grows by filling left-to-right; no rebalancing. Structure from size N — no full reconstruction on each insert.

Inclusion proofs: leaf hash, bagged root, peak hashes, sibling hashes along path to peak, left/right flags. Verify output inclusion without full block data.

Hashing (Grin-specific): Blake2b with position prefix. Chamber uses sha256(left||right) parent and bag-hash of peaks (sha256_mmr_peaks_v1) — same peak/bag architecture, different hash function.`,
  },
  {
    id: "x_logrex_merkle_primer",
    title: "LogarithmicRex: Merkle trees and proofs CS201 primer",
    author: "LogarithmicRex",
    sourceRef: "https://x.com/LogarithmicRex/status/1567638108937801728",
    body: `Logarithmic Rex CS201 thread (2022-09-07) — durable technical primer:

A Merkle tree uses hashing so you can prove a transaction was included in a large dataset. Named after Ralph Merkle (1987).

Build: hash each data block → pair hashes and re-hash until one root. Root uniquely represents the set; any leaf change changes the root.

One-way: easy to build from data, infeasible to recover data from root — root can be published without exposing leaves.

Merkle proof: specific data + intermediate sibling hashes so verifier recomputes root. Match → inclusion. Verification scales O(log n).

Simple hash of whole file also fingerprints the set; Merkle adds efficient *partial* inclusion proofs.

Chamber: audit entry_hash leaves; inclusion under checkpoint or MMR peak bag.`,
  },
  {
    id: "x_naveen_tree_taxonomy",
    title: "0xNaveenV: Merkle variant taxonomy",
    author: "0xNaveenV",
    sourceRef: "https://x.com/0xNaveenV/status/2058229448894554550",
    body: `Naveen V (2026-05-23) taxonomy beyond basic Merkle trees:

Sparse Merkle Tree
Indexed Merkle Tree
Incremental Merkle Tree
Merkle Patricia Trie
Verkle Tree
Jellyfish Merkle Tree
Namespaced Merkle Tree
Merkle Sum Tree
Utreexo

Chamber currently: classic binary Merkle for range checkpoints + MMR peaks for live incremental root. Not SMT/Verkle/Utreexo — those are future options if we need key-addressed or accumulator-style proofs.`,
  },
  {
    id: "x_tracelane_agent_audit",
    title: "Tracelane: agent audit ledger hash chain + signed Merkle root",
    author: "xSanjeevLabs",
    sourceRef: "https://x.com/xSanjeevLabs/status/2082891932888670553",
    body: `Sanjeev Kumar Singh / Tracelane (2026-07-30) — closest product peer for agent audit:

Tracelane is an open-source (Apache 2.0) AI agent gateway that records every call and writes a hash-chained ledger you can verify offline.

Three parts: gateway (30+ providers), OTel GenAI traces (prompt, tool, latency, cost), audit ledger: SHA-256 hash chain + Ed25519-signed Merkle root.

Verify: tlane verify <trace-id> offline against your copy. Tampering means breaking SHA-256 or forging a signature — not editing a row. Verification free on all plans.

Explicit non-claims: no published unreproducible benchmarks; Rekor anchoring per-batch best-effort not per-trace.

Chamber overlap: hash chain (audit_event.prev_hash) + Merkle root (MMR live + checkpoints). Chamber adds fail-closed gates and citation debt; Tracelane emphasizes agent flight-recorder + signed root.`,
  },
  {
    id: "x_bryan_hash_chain_anchor",
    title: "Bryan Munera: hash chain ops + periodic Merkle root anchor",
    author: "BryanMuenera",
    sourceRef: "https://x.com/BryanMuenera/status/2075641318986883306",
    body: `Bryan Munera (2026-07-10):

"A hash chain audit trail costs effectively zero — SHA-256 runs at software speed. Storing every memory on-chain is enormous overhead. The right architecture: fast hash chain for daily ops, periodic Merkle root anchor to L2 for public proof."

Also (2026-07-02): Git is a Merkle tree; agent memory can be too — every commit (decision) links to parent, append-only history.

Chamber implements exactly this split: append-only hash chain for every gate event; incremental MMR root always fresh; optional published checkpoints as external anchors.`,
  },
];

function main(): void {
  const dbPath = process.env.CHAMBER_DB ?? "/tmp/chamber-corpus.sqlite";
  const db = openChamberDb(dbPath);
  const preferMinilm = minilmAvailable();
  console.log(`db=${dbPath}`);
  console.log(`embedder=${preferMinilm ? MINILM_MODEL : "local-hash-v1"}`);

  let n = 0;
  for (const d of DOCS) {
    const r = upsertDocument(db, {
      id: d.id,
      sourceKind: "x_tweet",
      sourceRef: d.sourceRef,
      title: d.title,
      body: d.body,
      metadata: {
        author: d.author,
        ingest: "merkle_corpus_v1",
        no_marketing: true,
      },
      // force hash if minilm missing for speed; auto otherwise
      model: preferMinilm ? undefined : "local-hash-v1",
    });
    n++;
    console.log(`  + ${r.id}  ${r.model}  ${d.title.slice(0, 60)}`);
  }

  console.log(`\ningested ${n} docs · corpus size ${countDocuments(db)}`);

  const queries = [
    "What is a Merkle Mountain Range and why append without rebuild?",
    "Incremental Merkle Tree path to root",
    "agent audit hash chain Merkle root",
    "OpenTimestamps selective disclosure growing file",
  ];
  for (const q of queries) {
    console.log(`\nsearch: ${q}`);
    const hits = searchVector(db, q, {
      k: 3,
      minScore: 0.05,
      model: preferMinilm ? undefined : "local-hash-v1",
    });
    for (const h of hits) {
      console.log(
        `  ${h.score.toFixed(3)}  ${h.title ?? h.documentId}  [${h.sourceKind}]`,
      );
    }
  }
}

main();
