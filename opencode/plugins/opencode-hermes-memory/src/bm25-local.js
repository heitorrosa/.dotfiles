// Re-export BM25Index from the hermes-skills plugin
// Uses dynamic import to resolve the cross-plugin path at runtime
import { createRequire } from "module"
const require = createRequire(import.meta.url)
const { BM25Index } = require("../../opencode-hermes-skills/bm25-index.js")
export { BM25Index }
