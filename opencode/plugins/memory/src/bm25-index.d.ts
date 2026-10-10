// Type declarations for the plain-JS BM25 index in ./bm25-index.js.
// Kept as .d.ts so the implementation stays JavaScript on purpose.

/** One indexed document — in this plugin, a single memory bullet line. */
export interface BM25Document {
  name: string
  description: string
  content: string
  dir: string
}

export interface BM25Options {
  /** Term frequency saturation (default 1.2) */
  k1?: number
  /** Length normalization (default 0.75) */
  b?: number
  /** Custom stop-word list (defaults to a built-in English list) */
  stopWords?: string[]
}

export interface BM25Hit {
  name: string
  score: number
  snippet: string
}

export declare class BM25Index {
  constructor(options?: BM25Options)
  build(skills: Map<string, BM25Document>): void
  /** Alias for build(). */
  update(skills: Map<string, BM25Document>): void
  search(query: string, topK?: number): BM25Hit[]
}
