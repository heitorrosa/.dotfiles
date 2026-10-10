/**
 * BM25/Keyword Search Index for skill search.
 * Pure JavaScript, no external dependencies. ESM module.
 */

const DEFAULT_STOP_WORDS = [
  'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but',
  'in', 'with', 'to', 'for', 'of', 'not', 'no', 'can', 'had', 'has',
  'have', 'will', 'would', 'could', 'should', 'may', 'might', 'do',
  'does', 'did', 'that', 'this', 'these', 'those', 'it', 'its', 'be',
  'been', 'being', 'are', 'was', 'were', 'from', 'by', 'as', 'into',
  'if', 'than', 'then', 'so', 'such', 'what', 'when', 'where', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'any', 'only', 'very', 'also', 'just', 'about', 'above',
  'after', 'again', 'between', 'here', 'there', 'too', 'own', 'same',
];

/**
 * Suffixes ordered by length (longest first) to prevent partial matches.
 * FIXED (BUG-012): Previously 'ization' was split into 'ization' then 'tion',
 * but 'ization' wasn't in the list — it would strip 'tion' leaving 'izat'.
 * Now: longer suffixes are checked first.
 */
const STEM_SUFFIXES = [
  'ization', 'ising', 'izing', 'ation', 'tion', 'ment', 'ness',
  'able', 'ible', 'ful', 'less', 'ize', 'ise', 'ity', 'ing',
  'ly', 'ed', 'er', 'est',
];

/**
 * Tokenize text into stemmed, lowercased terms with stop-word removal.
 */
function tokenize(text, stopWords) {
  if (!text) return [];
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0);

  const result = [];
  for (let word of words) {
    if (stopWords.has(word)) continue;
    word = stem(word);
    if (word.length >= 3) result.push(word);
  }
  return result;
}

/**
 * Simple suffix-stripping stemmer.
 */
function stem(word) {
  for (const suffix of STEM_SUFFIXES) {
    if (word.length - suffix.length >= 3 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/**
 * Strip YAML frontmatter from content (everything between first --- pair).
 */
function stripFrontmatter(content) {
  if (!content) return '';
  const match = content.match(/^---\s*\n[\s\S]*?\n---\s*\n/);
  if (match) return content.slice(match[0].length);
  return content;
}

export class BM25Index {
  /**
   * @param {object} [options]
   * @param {number} [options.k1=1.2] - Term frequency saturation
   * @param {number} [options.b=0.75] - Length normalization
   * @param {string[]} [options.stopWords] - Custom stop words list
   */
  constructor(options = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;

    const sw = options.stopWords ?? DEFAULT_STOP_WORDS;
    this.stopWords = new Set(sw);

    // Internal state populated by build()
    this._docs = new Map();        // name → { tokens: string[], raw: string, description: string }
    this._df = new Map();          // term → document frequency
    this._totalDocLength = 0;
    this._avgDocLength = 0;
    this._docCount = 0;
  }

  /**
   * Build (or rebuild) the index from a skill cache.
   * @param {Map<string, {name: string, description: string, content: string, dir: string}>} skills
   */
  build(skills) {
    this._docs.clear();
    this._df.clear();
    this._totalDocLength = 0;
    this._docCount = 0;

    const docTermCounts = new Map(); // name → Map<term, count>

    // --- Pass 1: tokenize every document, record raw for snippet extraction ---
    for (const [name, skill] of skills) {
      const nameTokens = tokenize(skill.name, this.stopWords);
      const descTokens = tokenize(skill.description, this.stopWords);
      const rawBody = stripFrontmatter(skill.content || '');
      const bodyTokens = tokenize(rawBody, this.stopWords);

      const allTokens = [...nameTokens, ...descTokens, ...bodyTokens];

      // Build per-doc term frequency map
      const tf = new Map();
      for (const t of allTokens) {
        tf.set(t, (tf.get(t) || 0) + 1);
      }

      docTermCounts.set(name, tf);
      this._docs.set(name, {
        tokens: allTokens,
        raw: rawBody,
        description: skill.description || '',
      });

      this._totalDocLength += allTokens.length;
      this._docCount++;
    }

    // --- Pass 2: compute document frequency ---
    for (const [, tf] of docTermCounts) {
      for (const term of tf.keys()) {
        this._df.set(term, (this._df.get(term) || 0) + 1);
      }
    }

    this._avgDocLength = this._docCount > 0 ? this._totalDocLength / this._docCount : 0;
    this._docTermCounts = docTermCounts;
  }

  /**
   * Rebuild index (alias for build).
   */
  update(skills) {
    this.build(skills);
  }

  /**
   * Compute IDF for a term.
   * IDF(t) = ln((N - df(t) + 0.5) / (df(t) + 0.5) + 1)
   */
  _idf(term) {
    const df = this._df.get(term) || 0;
    const N = this._docCount;
    return Math.log((N - df + 0.5) / (df + 0.5) + 1);
  }

  /**
   * BM25 score between a query and a single document.
   */
  _scoreDoc(queryTokens, docName) {
    const tf = this._docTermCounts.get(docName);
    if (!tf) return 0;

    const docLength = this._docs.get(docName).tokens.length;
    const avgdl = this._avgDocLength || 1;

    let score = 0;
    for (const qt of queryTokens) {
      const f = tf.get(qt) || 0;
      if (f === 0) continue;

      const idf = this._idf(qt);
      const numerator = f * (this.k1 + 1);
      const denominator = f + this.k1 * (1 - this.b + this.b * (docLength / avgdl));
      score += idf * (numerator / denominator);
    }
    return score;
  }

  /**
   * Extract a snippet from content around the first occurrence of any query term.
   * @param {string} content
   * @param {string[]} queryTerms
   * @param {number} maxLen
   */
  _snippet(content, queryTerms, maxLen = 200) {
    if (!content || !queryTerms.length) return '';

    // Find earliest occurrence of any query term
    let bestIdx = -1;
    for (const qt of queryTerms) {
      const idx = content.toLowerCase().indexOf(qt);
      if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
        bestIdx = idx;
      }
    }

    if (bestIdx === -1) {
      // No query term found in raw content — just take the start
      return content.slice(0, maxLen).trim();
    }

    const start = Math.max(0, bestIdx - 40);
    let snippet = content.slice(start, start + maxLen).trim();

    if (start > 0) snippet = '…' + snippet;
    if (start + maxLen < content.length) snippet = snippet + '…';

    return snippet;
  }

  /**
   * Search the index with a BM25 query.
   * @param {string} query
   * @param {number} [topK=10]
   * @returns {{ name: string, score: number, snippet: string }[]}
   */
  search(query, topK = 10) {
    if (!query || this._docCount === 0) return [];

    const queryTokens = tokenize(query, this.stopWords);
    if (queryTokens.length === 0) return [];

    const results = [];
    for (const [name] of this._docs) {
      const score = this._scoreDoc(queryTokens, name);
      if (score <= 0) continue;

      const doc = this._docs.get(name);
      const snippet = this._snippet(doc.raw || doc.description, queryTokens);
      results.push({ name, score, snippet });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }
}
