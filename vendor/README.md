Drop local-only assets here if you want to replace the heuristic fallbacks:

- `tiktoken-opus47.js`
  - Expose `self.createOpus47Tokenizer()`.
  - The returned tokenizer should provide either `count(text)` or `encode(text)`.

- `transformers-similarity.js`
  - Expose `self.createSimilarityModel({ device })`.
  - The returned model should provide `compare(text, reference)` or `compareBatch(text, references)`.

The extension already runs without these files. When they are present, the worker hooks in
`workers/tokenizer.worker.js` and `workers/similarity.worker.js` will use them locally.
