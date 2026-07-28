declare module "./bm25-local.js" {
  export class BM25Index {
    constructor(options?: { k1?: number; b?: number; stopWords?: string[] })
    build(skills: Map<string, { name: string; description: string; content: string; dir: string }>): void
    search(query: string, topK?: number): { name: string; score: number; snippet: string }[]
  }
}
