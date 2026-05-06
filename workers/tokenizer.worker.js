"use strict";

var localTokenizer = null;
var localTokenizerPromise = null;

function tryLoadLocalTokenizer() {
  if (localTokenizerPromise) {
    return localTokenizerPromise;
  }

  localTokenizerPromise = Promise.resolve().then(function initialize() {
    try {
      importScripts("../vendor/tiktoken-opus47.js");
      if (typeof self.createOpus47Tokenizer === "function") {
        localTokenizer = self.createOpus47Tokenizer();
      }
    } catch (error) {
      localTokenizer = null;
    }

    return localTokenizer;
  });

  return localTokenizerPromise;
}

function heuristicCount(text) {
  var input = String(text || "");
  var base = Math.ceil(input.length / 4);
  var specialCount = (input.match(/[{}\[\]();=<>`$\\/_-]/g) || []).length;
  var whitespacePenalty = (input.match(/(?:\n{3,}| {4,})/g) || []).length * 6;
  var urlPenalty = (input.match(/https?:\/\/\S{25,}/g) || []).length * 20;
  var densityMultiplier = 1 + Math.min(0.35, specialCount / Math.max(input.length, 1) * 6);

  return {
    tokens: Math.max(1, Math.ceil((base + whitespacePenalty + urlPenalty) * densityMultiplier)),
    densityMultiplier: Number(densityMultiplier.toFixed(2)),
    backend: "heuristic"
  };
}

self.onmessage = async function onMessage(event) {
  var data = event.data || {};
  var payload = data.payload || {};
  var result;
  var tokens;

  await tryLoadLocalTokenizer();

  if (localTokenizer) {
    try {
      if (typeof localTokenizer.count === "function") {
        result = localTokenizer.count(payload.text);
        if (typeof result === "number") {
          result = {
            tokens: result,
            densityMultiplier: 1,
            backend: "tiktoken-opus47"
          };
        }
      } else if (typeof localTokenizer.encode === "function") {
        tokens = localTokenizer.encode(String(payload.text || "")).length;
        result = {
          tokens: tokens,
          densityMultiplier: 1,
          backend: "tiktoken-opus47"
        };
      }
    } catch (error) {
      result = null;
    }
  }

  if (!result) {
    result = heuristicCount(payload.text);
  }

  self.postMessage({
    id: data.id,
    tokens: result.tokens,
    densityMultiplier: result.densityMultiplier,
    backend: result.backend
  });
};
