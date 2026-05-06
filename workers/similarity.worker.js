"use strict";

var localComparator = null;
var localComparatorPromise = null;

function tryLoadLocalComparator() {
  if (localComparatorPromise) {
    return localComparatorPromise;
  }

  localComparatorPromise = Promise.resolve().then(function initialize() {
    try {
      importScripts("../vendor/transformers-similarity.js");
      if (typeof self.createSimilarityModel === "function") {
        return Promise.resolve(self.createSimilarityModel({
          device: "webgpu"
        })).then(function onModel(model) {
          localComparator = model;
          return localComparator;
        });
      }
    } catch (error) {
      localComparator = null;
    }

    return localComparator;
  });

  return localComparatorPromise;
}

function tokenize(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9_\s]/g, " ")
      .split(/\s+/)
      .filter(function keep(token) {
        return token.length > 2;
      })
      .slice(0, 256)
  );
}

function compare(left, right) {
  var leftTokens = tokenize(left);
  var rightTokens = tokenize(right);
  var smaller = leftTokens.size < rightTokens.size ? leftTokens : rightTokens;
  var overlap = 0;

  if (!leftTokens.size || !rightTokens.size) {
    return 0;
  }

  smaller.forEach(function eachToken(token) {
    if (leftTokens.has(token) && rightTokens.has(token)) {
      overlap += 1;
    }
  });

  return overlap / (leftTokens.size + rightTokens.size - overlap);
}

self.onmessage = async function onMessage(event) {
  var data = event.data || {};
  var payload = data.payload || {};
  var references = Array.isArray(payload.references) ? payload.references : [];
  var bestScore = 0;

  await tryLoadLocalComparator();

  if (localComparator) {
    try {
      if (typeof localComparator.compareBatch === "function") {
        bestScore = await localComparator.compareBatch(payload.text, references);
      } else if (typeof localComparator.compare === "function") {
        references.forEach(function eachReference(referenceText) {
          bestScore = Math.max(bestScore, Number(localComparator.compare(payload.text, referenceText)) || 0);
        });
      }
    } catch (error) {
      bestScore = 0;
    }
  }

  if (!bestScore) {
    references.forEach(function eachReference(referenceText) {
      bestScore = Math.max(bestScore, compare(payload.text, referenceText));
    });
  }

  self.postMessage({
    id: data.id,
    score: Number(bestScore.toFixed(3)),
    backend: localComparator ? "transformers-local" : "heuristic"
  });
};
