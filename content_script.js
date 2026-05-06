(function bootstrapClaudeSmartGuard() {
  "use strict";

  var BRIDGE_READY_EVENT = "csg:bridge:ready";
  var INJECT_CONTEXT_EVENT = "csg:bridge:inject-context";
  var ROOT_ATTR = "data-csg-root";
  var TTL_COLD_MS = 300000;
  var DAILY_PRO_BUDGET_TOKENS = 240000;
  var PANEL_ID = "csg-panel";
  var TOKENIZER_WORKER_PATH = "workers/tokenizer.worker.js";
  var SIMILARITY_WORKER_PATH = "workers/similarity.worker.js";
  var STORAGE_KEYS = {
    intent: "csgIntent",
    pruneMode: "csgPruneMode"
  };
  var INTENTS = {
    debug: {
      label: "Debug",
      threshold: 6800
    },
    write: {
      label: "Write",
      threshold: 9600
    },
    research: {
      label: "Research",
      threshold: 7600
    },
    general: {
      label: "General",
      threshold: 8400
    }
  };
  var SELECTORS = {
    editor: [
      'div[contenteditable="true"][data-testid]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]'
    ],
    sendButton: [
      'button[data-testid*="send"]',
      'button[aria-label*="Send"]',
      'form button[type="submit"]'
    ],
    chatRoot: [
      "main",
      '[data-testid*="conversation"]',
      '[class*="conversation"]'
    ]
  };
  var state = {
    bridgeReady: false,
    routeKey: location.pathname,
    editor: null,
    sendButton: null,
    chatRoot: null,
    panelHost: null,
    shadowRoot: null,
    pruneHosts: new Map(),
    intent: "general",
    pruneMode: false,
    pinnedIds: new Set(),
    selectedPruneIds: new Set(),
    lastActivityAt: Date.now(),
    hiddenAt: 0,
    cacheCold: false,
    lastSentAt: Date.now(),
    lastObservedTurnAt: Date.now(),
    lastCapturedSendAt: 0,
    lastCapturedDraft: "",
    todayTokenTotal: 0,
    contextCache: {
      signature: "",
      messages: [],
      tokens: 0
    },
    analysisSeq: 0,
    analysisTimer: 0,
    refreshScheduled: 0,
    pendingDraftRequested: false,
    pendingDraftInjected: false,
    handlers: {
      input: null,
      keydown: null,
      click: null
    }
  };

  var tokenizerClient = createWorkerClient(
    TOKENIZER_WORKER_PATH,
    fallbackTokenizerResponse
  );
  var similarityClient = createWorkerClient(
    SIMILARITY_WORKER_PATH,
    fallbackSimilarityResponse
  );

  bootstrap();

  function bootstrap() {
    window.addEventListener(BRIDGE_READY_EVENT, function onBridgeReady() {
      state.bridgeReady = true;
      maybeInjectPendingDraft();
    });

    ensurePanel();
    bindActivityEvents();
    observeDOM();
    loadPreferences().then(function afterPreferences() {
      return Promise.all([
        refreshTodayTotals(),
        restoreChatSessionState()
      ]);
    }).finally(function finishBootstrap() {
      scheduleRefresh();
      window.setInterval(checkIdleState, 30000);
    });
  }

  function storageLocalGet(key) {
    return new Promise(function executor(resolve) {
      chrome.storage.local.get(key, resolve);
    });
  }

  function storageLocalSet(payload) {
    return new Promise(function executor(resolve) {
      chrome.storage.local.set(payload, resolve);
    });
  }

  function storageSessionGet(key) {
    return new Promise(function executor(resolve) {
      chrome.storage.session.get(key, resolve);
    });
  }

  function storageSessionSet(payload) {
    return new Promise(function executor(resolve) {
      chrome.storage.session.set(payload, resolve);
    });
  }

  function runtimeMessage(message) {
    return new Promise(function executor(resolve) {
      chrome.runtime.sendMessage(message, function onResponse(response) {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error: chrome.runtime.lastError.message
          });
          return;
        }

        resolve(response || { ok: true });
      });
    });
  }

  async function loadPreferences() {
    var stored = await storageLocalGet([
      STORAGE_KEYS.intent,
      STORAGE_KEYS.pruneMode,
      globalThis.ClaudeSmartGuard.PruneEngine.PIN_STORAGE_KEY
    ]);

    state.intent = INTENTS[stored[STORAGE_KEYS.intent]] ? stored[STORAGE_KEYS.intent] : "general";
    state.pruneMode = Boolean(stored[STORAGE_KEYS.pruneMode]);
    state.pinnedIds = new Set(
      Array.isArray(stored[globalThis.ClaudeSmartGuard.PruneEngine.PIN_STORAGE_KEY]) ?
        stored[globalThis.ClaudeSmartGuard.PruneEngine.PIN_STORAGE_KEY] :
        []
    );
    state.selectedPruneIds = new Set(state.pinnedIds);
  }

  function getChatTimestampKey() {
    return "csgLastSent:" + location.pathname;
  }

  async function restoreChatSessionState() {
    var stored = await storageSessionGet(getChatTimestampKey());
    var timestamp = stored[getChatTimestampKey()];

    if (typeof timestamp === "number" && timestamp > 0) {
      state.lastSentAt = timestamp;
      state.lastObservedTurnAt = timestamp;
    } else {
      state.lastSentAt = Date.now();
      state.lastObservedTurnAt = Date.now();
    }
  }

  async function persistChatSessionState() {
    var payload = {};
    payload[getChatTimestampKey()] = state.lastSentAt;
    await storageSessionSet(payload);
  }

  function createWorkerClient(path, fallbackHandler) {
    var worker = null;
    var sequence = 0;
    var pending = new Map();

    try {
      worker = new Worker(chrome.runtime.getURL(path));
      worker.onmessage = function onMessage(event) {
        var data = event.data || {};
        var deferred = pending.get(data.id);

        if (!deferred) {
          return;
        }

        pending.delete(data.id);
        deferred.resolve(data);
      };

      worker.onerror = function onError() {
        pending.forEach(function eachPending(record) {
          record.resolve(fallbackHandler(record.payload));
        });
        pending.clear();
        worker.terminate();
        worker = null;
      };
    } catch (error) {
      worker = null;
    }

    return {
      request: function request(type, payload) {
        var packet = {
          type: type,
          payload: payload || {}
        };

        if (!worker) {
          return Promise.resolve(fallbackHandler(packet));
        }

        return new Promise(function executor(resolve) {
          var id = (sequence += 1);
          var timeout = window.setTimeout(function onTimeout() {
            if (!pending.has(id)) {
              return;
            }
            pending.delete(id);
            resolve(fallbackHandler(packet));
          }, 1500);

          pending.set(id, {
            payload: packet,
            resolve: function wrappedResolve(result) {
              window.clearTimeout(timeout);
              resolve(result);
            }
          });

          worker.postMessage({
            id: id,
            type: packet.type,
            payload: packet.payload
          });
        });
      }
    };
  }

  function fallbackTokenizerResponse(request) {
    var text = String((request.payload && request.payload.text) || "");
    var base = Math.ceil(text.length / 4);
    var specialCount = (text.match(/[{}\[\]();=<>`$\\/_-]/g) || []).length;
    var urlPenalty = (text.match(/https?:\/\/\S{25,}/g) || []).length * 20;
    var whitespacePenalty = (text.match(/(?:\n{3,}| {4,})/g) || []).length * 6;
    var densityMultiplier = 1 + Math.min(0.35, specialCount / Math.max(text.length, 1) * 6);

    return {
      tokens: Math.max(1, Math.ceil((base + urlPenalty + whitespacePenalty) * densityMultiplier)),
      densityMultiplier: Number(densityMultiplier.toFixed(2)),
      backend: "heuristic"
    };
  }

  function fallbackSimilarityResponse(request) {
    var text = String((request.payload && request.payload.text) || "");
    var references = Array.isArray(request.payload && request.payload.references) ?
      request.payload.references :
      [];
    var bestScore = 0;

    references.forEach(function eachReference(referenceText) {
      bestScore = Math.max(bestScore, lexicalSimilarity(text, String(referenceText || "")));
    });

    return {
      score: Number(bestScore.toFixed(3)),
      backend: "heuristic"
    };
  }

  function lexicalSimilarity(left, right) {
    var leftTokens = tokenizeForSimilarity(left);
    var rightTokens = tokenizeForSimilarity(right);
    var overlap = 0;
    var smaller;

    if (!leftTokens.size || !rightTokens.size) {
      return 0;
    }

    smaller = leftTokens.size < rightTokens.size ? leftTokens : rightTokens;
    smaller.forEach(function eachToken(token) {
      if (leftTokens.has(token) && rightTokens.has(token)) {
        overlap += 1;
      }
    });

    return overlap / (leftTokens.size + rightTokens.size - overlap);
  }

  function tokenizeForSimilarity(text) {
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

  function observeDOM() {
    var observer = new MutationObserver(function onMutation() {
      scheduleRefresh();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true
    });

    window.addEventListener("resize", scheduleRefresh);
    window.addEventListener("scroll", scheduleRefresh, true);
  }

  function bindActivityEvents() {
    ["pointerdown", "keydown", "mousemove"].forEach(function eachEvent(type) {
      window.addEventListener(type, touchActivity, { passive: true });
    });

    document.addEventListener("visibilitychange", function onVisibilityChange() {
      if (document.hidden) {
        state.hiddenAt = Date.now();
        return;
      }

      if (state.hiddenAt && (Date.now() - state.hiddenAt) > TTL_COLD_MS) {
        state.cacheCold = true;
      }

      state.hiddenAt = 0;
      touchActivity();
      scheduleRefresh();
    });
  }

  function touchActivity() {
    state.lastActivityAt = Date.now();
  }

  function scheduleRefresh() {
    if (state.refreshScheduled) {
      return;
    }

    state.refreshScheduled = window.requestAnimationFrame(function onFrame() {
      state.refreshScheduled = 0;
      refreshBindings();
    });
  }

  async function refreshBindings() {
    var routeChanged = state.routeKey !== location.pathname;
    var editor = findFirst(SELECTORS.editor);
    var sendButton = findFirst(SELECTORS.sendButton);
    var chatRoot = findFirst(SELECTORS.chatRoot);

    if (routeChanged) {
      state.routeKey = location.pathname;
      state.pendingDraftRequested = false;
      state.pendingDraftInjected = false;
      state.selectedPruneIds = new Set(state.pinnedIds);
      await restoreChatSessionState();
    }

    if (editor !== state.editor) {
      rebindEditor(editor);
    }

    if (sendButton !== state.sendButton) {
      rebindSendButton(sendButton);
    }

    state.chatRoot = chatRoot;
    updateContextCache();
    syncPanel();
    syncPruneControls();
    maybeInjectPendingDraft();
    checkIdleState();
  }

  function findFirst(selectorList) {
    return document.querySelector(selectorList.join(", "));
  }

  function rebindEditor(editor) {
    if (state.editor && state.handlers.input) {
      state.editor.removeEventListener("input", state.handlers.input);
      state.editor.removeEventListener("keydown", state.handlers.keydown);
    }

    state.editor = editor;
    if (!editor) {
      syncPanel();
      return;
    }

    state.handlers.input = function onEditorInput() {
      touchActivity();
      scheduleDraftAnalysis();
      syncPanel();
    };

    state.handlers.keydown = function onEditorKeydown(event) {
      touchActivity();
      if (event.key === "Enter" && !event.shiftKey) {
        captureSendAnalytics("enter");
      }
    };

    editor.addEventListener("input", state.handlers.input);
    editor.addEventListener("keydown", state.handlers.keydown);
    scheduleDraftAnalysis();
  }

  function rebindSendButton(button) {
    if (state.sendButton && state.handlers.click) {
      state.sendButton.removeEventListener("click", state.handlers.click);
    }

    state.sendButton = button;

    if (!button) {
      syncTooltip(null);
      return;
    }

    state.handlers.click = function onSendClick() {
      touchActivity();
      captureSendAnalytics("button");
    };

    button.addEventListener("click", state.handlers.click);
  }

  function ensurePanel() {
    var host;
    var shadow;

    if (state.panelHost) {
      return;
    }

    host = document.createElement("div");
    host.setAttribute(ROOT_ATTR, "1");
    host.id = PANEL_ID;
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = [
      "<style>",
      ":host { all: initial; }",
      ".layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }",
      ".panel { position: fixed; width: min(420px, calc(100vw - 24px)); background: rgba(17, 20, 26, 0.96); color: #f5f1e7; border: 1px solid rgba(255, 197, 111, 0.28); border-radius: 16px; box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28); backdrop-filter: blur(12px); padding: 12px; font: 12px/1.4 'IBM Plex Sans', 'Segoe UI', sans-serif; pointer-events: auto; }",
      ".panel[hidden] { display: none; }",
      ".row { display: flex; gap: 8px; align-items: center; }",
      ".row + .row { margin-top: 10px; }",
      ".grow { flex: 1; min-width: 0; }",
      ".select, .button { appearance: none; border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 10px; background: rgba(255, 255, 255, 0.06); color: inherit; padding: 8px 10px; font: inherit; }",
      ".select { min-width: 130px; }",
      ".button { cursor: pointer; }",
      ".button:disabled { opacity: 0.45; cursor: default; }",
      ".toggle { display: inline-flex; align-items: center; gap: 6px; color: #e6dfcf; }",
      ".meta { color: #d0c6b0; font-size: 11px; }",
      ".meter { height: 8px; border-radius: 999px; background: rgba(255, 255, 255, 0.08); overflow: hidden; margin-top: 4px; }",
      ".meter-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #f5d37b, #f59f63, #f36b4f); }",
      ".warning { border-radius: 12px; padding: 10px; background: rgba(245, 159, 99, 0.14); color: #ffe1ba; }",
      ".warning[hidden] { display: none; }",
      ".warning.critical { background: rgba(243, 107, 79, 0.16); color: #ffd2c7; }",
      ".tooltip { position: fixed; max-width: 260px; border-radius: 12px; padding: 10px 12px; background: rgba(255, 195, 94, 0.97); color: #2c1804; font: 12px/1.35 'IBM Plex Sans', 'Segoe UI', sans-serif; box-shadow: 0 12px 32px rgba(85, 41, 0, 0.28); }",
      ".tooltip[hidden] { display: none; }",
      ".idle-card { position: fixed; top: 18px; right: 18px; width: min(320px, calc(100vw - 36px)); padding: 14px; border-radius: 14px; background: rgba(32, 24, 17, 0.94); color: #f5ede1; border: 1px solid rgba(255, 195, 94, 0.24); box-shadow: 0 16px 44px rgba(0, 0, 0, 0.22); font: 12px/1.45 'IBM Plex Sans', 'Segoe UI', sans-serif; pointer-events: auto; }",
      ".idle-card[hidden] { display: none; }",
      ".idle-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #f8c777; margin-bottom: 6px; }",
      ".dim { position: fixed; inset: 0; background: rgba(53, 37, 24, 0.08); }",
      ".dim[hidden] { display: none; }",
      ".overlay { position: fixed; pointer-events: none; overflow: hidden; }",
      ".overlay[hidden] { display: none; }",
      ".overlay-content { white-space: pre-wrap; color: transparent; }",
      ".overlay-content mark { background: rgba(215, 61, 61, 0.18); color: transparent; border-radius: 3px; }",
      "</style>",
      '<div class="layer">',
      '  <div id="cold-dim" class="dim" hidden></div>',
      '  <div id="token-overlay" class="overlay" hidden><div id="token-overlay-content" class="overlay-content"></div></div>',
      '  <div id="panel" class="panel" hidden>',
      '    <div class="row">',
      '      <select id="intent-select" class="select">',
      '        <option value="debug">🛠️ Debug</option>',
      '        <option value="write">📝 Write</option>',
      '        <option value="research">🔍 Research</option>',
      '        <option value="general">⚙️ General</option>',
      '      </select>',
      '      <label class="toggle"><input id="prune-toggle" type="checkbox"> Prune Mode</label>',
      '      <button id="prune-button" class="button">Prune &amp; Move</button>',
      "    </div>",
      '    <div class="row"><div class="grow"><div id="quota-label" class="meta">Projected quota hit: 0%</div><div class="meter"><div id="quota-fill" class="meter-fill"></div></div></div></div>',
      '    <div class="row"><div id="wp-summary" class="meta">Context Tax engine standing by.</div></div>',
      '    <div id="warning-box" class="warning" hidden></div>',
      '    <div id="density-box" class="warning" hidden></div>',
      "  </div>",
      '  <div id="tooltip" class="tooltip" hidden></div>',
      '  <div id="idle-card" class="idle-card" hidden><div class="idle-title">Cold Cache</div><div>Cache is now cold. Consider starting a fresh session for this next turn to save your quota.</div></div>',
      "</div>"
    ].join("");

    document.documentElement.appendChild(host);
    state.panelHost = host;
    state.shadowRoot = shadow;

    shadow.getElementById("intent-select").value = state.intent;
    shadow.getElementById("prune-toggle").checked = state.pruneMode;

    shadow.getElementById("intent-select").addEventListener("change", function onIntentChange(event) {
      state.intent = INTENTS[event.target.value] ? event.target.value : "general";
      storageLocalSet((function buildPayload() {
        var payload = {};
        payload[STORAGE_KEYS.intent] = state.intent;
        return payload;
      }()));
      scheduleDraftAnalysis();
    });

    shadow.getElementById("prune-toggle").addEventListener("change", function onPruneToggle(event) {
      state.pruneMode = Boolean(event.target.checked);
      if (state.pruneMode && state.selectedPruneIds.size === 0) {
        state.selectedPruneIds = new Set(state.pinnedIds);
      }
      storageLocalSet((function buildPayload() {
        var payload = {};
        payload[STORAGE_KEYS.pruneMode] = state.pruneMode;
        return payload;
      }()));
      syncPruneControls();
      syncPanel();
    });

    shadow.getElementById("prune-button").addEventListener("click", function onPruneMove() {
      handlePruneMove();
    });
  }

  function syncPanel() {
    var shadow = state.shadowRoot;
    var panel;
    var editorRect;
    var top;
    var left;

    if (!shadow) {
      return;
    }

    panel = shadow.getElementById("panel");
    if (!state.editor) {
      panel.hidden = true;
      renderTokenOverlay("", []);
      return;
    }

    editorRect = state.editor.getBoundingClientRect();
    left = Math.max(12, Math.min(editorRect.left, window.innerWidth - Math.min(420, window.innerWidth - 24) - 12));
    top = Math.max(12, editorRect.top - 152);

    panel.hidden = false;
    panel.style.left = left + "px";
    panel.style.top = top + "px";

    shadow.getElementById("intent-select").value = state.intent;
    shadow.getElementById("prune-toggle").checked = state.pruneMode;
    shadow.getElementById("prune-button").disabled = !state.pruneMode;
  }

  function getConversationMessages() {
    return globalThis.ClaudeSmartGuard.PruneEngine.scanMessages({
      pinnedIds: Array.from(state.pinnedIds)
    });
  }

  function buildContextSignature(messages) {
    return messages.map(function toSignature(message) {
      return message.id + ":" + message.text.length;
    }).join("|");
  }

  function updateContextCache() {
    var messages = getConversationMessages();
    var signature = buildContextSignature(messages);

    if (!signature || signature === state.contextCache.signature) {
      return;
    }

    state.contextCache.signature = signature;
    state.contextCache.messages = messages;

    tokenizerClient.request("count", {
      text: messages.map(function toText(message) {
        return message.text;
      }).join("\n\n"),
      intent: "context"
    }).then(function onCount(result) {
      if (state.contextCache.signature !== signature) {
        return;
      }
      state.contextCache.tokens = Number(result.tokens) || 0;
      state.lastObservedTurnAt = Date.now();
      scheduleDraftAnalysis();
    });
  }

  function scheduleDraftAnalysis() {
    state.analysisSeq += 1;
    window.clearTimeout(state.analysisTimer);
    state.analysisTimer = window.setTimeout(function onTimer() {
      analyzeDraft(state.analysisSeq);
    }, 180);
  }

  async function analyzeDraft(sequence) {
    var draft = getEditorText();
    var contextMessages = state.contextCache.messages.slice(-16);
    var references = contextMessages.map(function toText(message) {
      return message.text;
    }).filter(Boolean);
    var denseSpans = collectDenseSpans(draft);
    var tokenResult;
    var similarityResult;
    var metrics;

    if (sequence !== state.analysisSeq) {
      return;
    }

    if (!draft.trim()) {
      updateQuotaMeter(0, 0, 0);
      updateWarnings(null);
      renderTokenOverlay(draft, denseSpans);
      return;
    }

    tokenResult = await tokenizerClient.request("count", {
      text: draft,
      intent: state.intent
    });

    similarityResult = await similarityClient.request("compare", {
      text: draft,
      references: references
    });

    if (sequence !== state.analysisSeq) {
      return;
    }

    metrics = buildMetrics(draft, tokenResult, similarityResult);
    updateQuotaMeter(metrics.projectedQuotaHit, metrics.draftTokens, metrics.contextTokens);
    updateWarnings(metrics);
    renderTokenOverlay(draft, denseSpans);
    syncTooltip(metrics);
  }

  function buildMetrics(draft, tokenResult, similarityResult) {
    var draftTokens = Number(tokenResult.tokens) || 0;
    var densityMultiplier = Number(tokenResult.densityMultiplier) || 1;
    var contextTokens = Number(state.contextCache.tokens) || 0;
    var similarity = Math.max(0, Math.min(1, Number(similarityResult.score) || 0));
    var ttlPenalty = resolveTtlPenalty();
    var threshold = INTENTS[state.intent].threshold;
    var wastePotential = Math.round((contextTokens * 10) * (1 - similarity) * ttlPenalty);
    var wastedTokens = Math.round(contextTokens * (1 - similarity) * (ttlPenalty > 1 ? 1.35 : 0.75));
    var productiveTokens = Math.max(0, draftTokens - Math.round(draftTokens * (1 - similarity) * 0.15));
    var projectedQuotaHit = Math.min(
      100,
      ((state.todayTokenTotal + draftTokens + contextTokens) / DAILY_PRO_BUDGET_TOKENS) * 100
    );
    var draftHasCode = detectCodeDraft(draft);

    return {
      draftTokens: draftTokens,
      densityMultiplier: densityMultiplier,
      contextTokens: contextTokens,
      similarity: similarity,
      ttlPenalty: ttlPenalty,
      threshold: threshold,
      wastePotential: wastePotential,
      wastedTokens: wastedTokens,
      productiveTokens: productiveTokens,
      projectedQuotaHit: projectedQuotaHit,
      draftHasCode: draftHasCode,
      shouldWarn: wastePotential > threshold
    };
  }

  function resolveTtlPenalty() {
    var baseline = Math.max(state.lastSentAt, state.lastObservedTurnAt);
    return (Date.now() - baseline) > TTL_COLD_MS ? 3.5 : 1.0;
  }

  function updateQuotaMeter(percent, draftTokens, contextTokens) {
    var shadow = state.shadowRoot;
    var fill;
    var label;

    if (!shadow) {
      return;
    }

    fill = shadow.getElementById("quota-fill");
    label = shadow.getElementById("quota-label");

    fill.style.width = Math.max(0, Math.min(100, percent)) + "%";
    label.textContent = "Projected quota hit: " +
      percent.toFixed(1) + "% · draft " + formatNumber(draftTokens) +
      " tok · context " + formatNumber(contextTokens) + " tok";
  }

  function updateWarnings(metrics) {
    var shadow = state.shadowRoot;
    var warningBox;
    var densityBox;
    var summary;
    var densityText = "";

    if (!shadow) {
      return;
    }

    warningBox = shadow.getElementById("warning-box");
    densityBox = shadow.getElementById("density-box");
    summary = shadow.getElementById("wp-summary");

    if (!metrics) {
      warningBox.hidden = true;
      densityBox.hidden = true;
      summary.textContent = "Context Tax engine standing by.";
      if (state.sendButton) {
        state.sendButton.style.boxShadow = "";
      }
      return;
    }

    summary.textContent = [
      "WP " + formatNumber(metrics.wastePotential),
      "similarity " + Math.round(metrics.similarity * 100) + "%",
      metrics.ttlPenalty > 1 ? "cold cache" : "warm cache"
    ].join(" · ");

    if (metrics.shouldWarn) {
      warningBox.hidden = false;
      warningBox.className = "warning critical";
      warningBox.textContent = "Context Tax Warning: this turn looks expensive relative to the current chat history. Consider pruning or starting fresh.";
      if (state.sendButton) {
        state.sendButton.style.boxShadow = "0 0 0 3px rgba(255, 190, 90, 0.42), 0 0 24px rgba(255, 157, 68, 0.28)";
      }
    } else {
      warningBox.hidden = true;
      warningBox.className = "warning";
      if (state.sendButton) {
        state.sendButton.style.boxShadow = "";
      }
    }

    if (state.intent === "debug" && metrics.draftHasCode) {
      densityText = "Opus 4.7 Density Alert: Special characters in this code block are costing " +
        metrics.densityMultiplier.toFixed(2) + "x more than standard text.";
      densityBox.hidden = false;
      densityBox.textContent = densityText;
    } else if (metrics.densityMultiplier > 1.18) {
      densityBox.hidden = false;
      densityBox.textContent = "Token-heavy draft detected: logs, whitespace runs, or long URLs are inflating the projected token load.";
    } else {
      densityBox.hidden = true;
    }
  }

  function syncTooltip(metrics) {
    var shadow = state.shadowRoot;
    var tooltip;
    var rect;

    if (!shadow) {
      return;
    }

    tooltip = shadow.getElementById("tooltip");
    if (!metrics || !metrics.shouldWarn || !state.sendButton) {
      tooltip.hidden = true;
      return;
    }

    rect = state.sendButton.getBoundingClientRect();
    tooltip.hidden = false;
    tooltip.textContent = "Context Tax Warning";
    tooltip.style.left = Math.max(12, rect.left - 130) + "px";
    tooltip.style.top = Math.max(12, rect.top - 52) + "px";
  }

  function checkIdleState() {
    var shadow = state.shadowRoot;
    var idleCard;
    var dim;
    var idleDuration = Date.now() - Math.max(state.lastActivityAt, state.lastSentAt);

    if (!shadow) {
      return;
    }

    idleCard = shadow.getElementById("idle-card");
    dim = shadow.getElementById("cold-dim");

    if (document.hidden) {
      idleCard.hidden = true;
      dim.hidden = true;
      return;
    }

    if (state.cacheCold || idleDuration > TTL_COLD_MS) {
      state.cacheCold = true;
      idleCard.hidden = false;
      dim.hidden = false;
      return;
    }

    idleCard.hidden = true;
    dim.hidden = true;
  }

  function getEditorText() {
    return state.editor ? String(state.editor.innerText || "").trim() : "";
  }

  async function captureSendAnalytics(source) {
    var draft = getEditorText();
    var now = Date.now();
    var tokenResult;
    var similarityResult;
    var metrics;
    var response;

    if (!draft) {
      return;
    }

    if (draft === state.lastCapturedDraft && (now - state.lastCapturedSendAt) < 1200) {
      return;
    }

    state.lastCapturedDraft = draft;
    state.lastCapturedSendAt = now;

    tokenResult = await tokenizerClient.request("count", {
      text: draft,
      intent: state.intent
    });

    similarityResult = await similarityClient.request("compare", {
      text: draft,
      references: state.contextCache.messages.slice(-16).map(function toText(message) {
        return message.text;
      })
    });

    metrics = buildMetrics(draft, tokenResult, similarityResult);
    state.lastSentAt = Date.now();
    state.cacheCold = false;
    state.todayTokenTotal += metrics.draftTokens + metrics.contextTokens;
    persistChatSessionState();
    response = await runtimeMessage({
      type: "CSD_LOG_ANALYTICS",
      entry: {
        timestamp: Date.now(),
        intent_category: state.intent,
        estimated_tokens: metrics.draftTokens,
        context_size: metrics.contextTokens,
        waste_potential: metrics.wastePotential,
        ttl_penalty: metrics.ttlPenalty,
        similarity: metrics.similarity,
        wasted_tokens: metrics.wastedTokens,
        productive_tokens: metrics.productiveTokens,
        density_multiplier: metrics.densityMultiplier,
        source: source
      }
    });

    if (!response || !response.ok) {
      return;
    }

    scheduleDraftAnalysis();
    checkIdleState();
  }

  async function refreshTodayTotals() {
    var response = await runtimeMessage({
      type: "CSD_GET_DAILY_SUMMARY"
    });

    if (!response || !response.ok || !response.summary) {
      return;
    }

    state.todayTokenTotal = (Number(response.summary.estimated_tokens) || 0) +
      (Number(response.summary.context_size) || 0);
  }

  async function maybeInjectPendingDraft() {
    var response;
    var payload;

    if (!state.editor || !state.bridgeReady || state.pendingDraftRequested || state.pendingDraftInjected) {
      return;
    }

    state.pendingDraftRequested = true;
    response = await runtimeMessage({
      type: "CSD_REQUEST_PENDING_DRAFT"
    });

    if (!response || !response.ok || !response.payload) {
      return;
    }

    payload = response.payload;
    window.dispatchEvent(new CustomEvent(INJECT_CONTEXT_EVENT, {
      detail: {
        text: String(payload.text || "")
      }
    }));
    state.pendingDraftInjected = true;
    scheduleDraftAnalysis();
  }

  async function handlePruneMove() {
    var messages;
    var selected;
    var contextText;

    if (!state.pruneMode) {
      return;
    }

    messages = getConversationMessages();
    selected = messages.filter(function keepMessage(message) {
      return state.selectedPruneIds.has(message.id);
    });

    if (!selected.length) {
      showInlineMessage("Select at least one message before pruning.", false);
      return;
    }

    contextText = globalThis.ClaudeSmartGuard.PruneEngine.buildContextReference(selected);
    await runtimeMessage({
      type: "CSD_OPEN_PRUNED_SESSION",
      payload: {
        createdAt: Date.now(),
        sourcePath: location.pathname,
        text: contextText
      }
    });
    showInlineMessage("Opening a fresh Claude session with the selected context block.", true);
  }

  function showInlineMessage(text, isSuccess) {
    var warningBox = state.shadowRoot.getElementById("warning-box");
    warningBox.hidden = false;
    warningBox.className = isSuccess ? "warning" : "warning critical";
    warningBox.textContent = text;
  }

  function syncPruneControls() {
    var messages = getConversationMessages();
    var activeIds = new Set();

    if (!state.pruneMode) {
      state.pruneHosts.forEach(function eachHost(host) {
        host.remove();
      });
      state.pruneHosts.clear();
      return;
    }

    if (state.selectedPruneIds.size === 0 && state.pinnedIds.size > 0) {
      state.selectedPruneIds = new Set(state.pinnedIds);
    }

    messages.forEach(function eachMessage(message) {
      var host = state.pruneHosts.get(message.id);

      activeIds.add(message.id);
      if (!host || !host.isConnected) {
        host = createPruneHost(message);
        state.pruneHosts.set(message.id, host);
        message.element.prepend(host);
      }

      syncPruneHost(host, message);
    });

    state.pruneHosts.forEach(function eachHost(host, messageId) {
      if (activeIds.has(messageId)) {
        return;
      }
      host.remove();
      state.pruneHosts.delete(messageId);
    });
  }

  function createPruneHost(message) {
    var host = document.createElement("div");
    var shadow = host.attachShadow({ mode: "open" });
    var checkbox;
    var pinButton;

    host.setAttribute("data-csg-prune-host", "1");
    shadow.innerHTML = [
      "<style>",
      ":host { display: block; margin-bottom: 6px; }",
      ".wrap { display: inline-flex; gap: 6px; align-items: center; padding: 6px 8px; border-radius: 999px; background: rgba(16, 19, 26, 0.88); color: #f3eddc; font: 11px/1 'IBM Plex Sans', 'Segoe UI', sans-serif; border: 1px solid rgba(255, 197, 111, 0.22); }",
      ".pin { border: 0; border-radius: 999px; background: rgba(255, 255, 255, 0.08); color: inherit; padding: 4px 8px; font: inherit; cursor: pointer; }",
      ".pin.active { background: rgba(255, 195, 94, 0.22); color: #ffdca3; }",
      "label { display: inline-flex; gap: 4px; align-items: center; }",
      "</style>",
      '<div class="wrap">',
      '  <label><input id="pick" type="checkbox"> include</label>',
      '  <button id="pin" class="pin" type="button">Pin</button>',
      "</div>"
    ].join("");

    checkbox = shadow.getElementById("pick");
    pinButton = shadow.getElementById("pin");

    checkbox.addEventListener("change", function onCheck(event) {
      if (event.target.checked) {
        state.selectedPruneIds.add(message.id);
      } else {
        state.selectedPruneIds.delete(message.id);
      }
    });

    pinButton.addEventListener("click", function onPin() {
      var shouldPin = !state.pinnedIds.has(message.id);
      globalThis.ClaudeSmartGuard.PruneEngine.setPinnedState(message.id, shouldPin).then(function onSaved(ids) {
        state.pinnedIds = new Set(ids);
        if (shouldPin) {
          state.selectedPruneIds.add(message.id);
        }
        syncPruneControls();
      });
    });

    return host;
  }

  function syncPruneHost(host, message) {
    var shadow = host.shadowRoot;
    var checkbox = shadow.getElementById("pick");
    var pinButton = shadow.getElementById("pin");

    checkbox.checked = state.selectedPruneIds.has(message.id);
    pinButton.className = state.pinnedIds.has(message.id) ? "pin active" : "pin";
  }

  function detectCodeDraft(text) {
    return /```[\s\S]*?```/.test(text) ||
      /\b(function|const|let|class|return|import|export|SELECT|FROM|def)\b/.test(text) ||
      /[{}[\];<>]/.test(text);
  }

  function collectDenseSpans(text) {
    var spans = [];
    var patterns = [
      /(?:\n{3,}| {4,})/g,
      /https?:\/\/\S{30,}/g,
      /(?:^(?:INFO|DEBUG|WARN|ERROR).{0,220}$\n?){3,}/gim
    ];

    patterns.forEach(function eachPattern(pattern) {
      var match;
      while ((match = pattern.exec(text))) {
        spans.push([match.index, match.index + match[0].length]);
        if (!match[0].length) {
          pattern.lastIndex += 1;
        }
      }
    });

    detectRepeatedLines(text).forEach(function eachSpan(span) {
      spans.push(span);
    });

    return mergeSpans(spans);
  }

  function detectRepeatedLines(text) {
    var lines = text.split("\n");
    var spans = [];
    var cursor = 0;
    var previous = "";
    var runStart = null;
    var runCount = 1;

    lines.forEach(function eachLine(line, index) {
      var normalized = line.trim();
      var lineStart = cursor;

      if (index > 0 && normalized && normalized === previous) {
        runCount += 1;
        if (runStart === null) {
          runStart = lineStart - (lines[index - 1].length + 1);
        }
      } else {
        if (runStart !== null && runCount >= 3) {
          spans.push([runStart, lineStart - 1]);
        }
        runStart = null;
        runCount = 1;
      }

      previous = normalized;
      cursor += line.length + 1;
    });

    if (runStart !== null && runCount >= 3) {
      spans.push([runStart, Math.max(runStart, cursor - 1)]);
    }

    return spans;
  }

  function mergeSpans(spans) {
    var sorted = spans.slice().sort(function byStart(left, right) {
      return left[0] - right[0];
    });
    var merged = [];

    sorted.forEach(function eachSpan(span) {
      var last = merged[merged.length - 1];
      if (!last || span[0] > last[1]) {
        merged.push(span.slice());
        return;
      }
      last[1] = Math.max(last[1], span[1]);
    });

    return merged;
  }

  function renderTokenOverlay(text, spans) {
    var overlay;
    var content;
    var rect;
    var styles;

    if (!state.shadowRoot) {
      return;
    }

    overlay = state.shadowRoot.getElementById("token-overlay");
    content = state.shadowRoot.getElementById("token-overlay-content");

    if (!state.editor || !text || !spans.length) {
      overlay.hidden = true;
      content.innerHTML = "";
      return;
    }

    rect = state.editor.getBoundingClientRect();
    styles = window.getComputedStyle(state.editor);

    overlay.hidden = false;
    overlay.style.left = rect.left + "px";
    overlay.style.top = rect.top + "px";
    overlay.style.width = rect.width + "px";
    overlay.style.height = rect.height + "px";

    content.style.padding = styles.padding;
    content.style.fontFamily = styles.fontFamily;
    content.style.fontSize = styles.fontSize;
    content.style.lineHeight = styles.lineHeight;
    content.style.letterSpacing = styles.letterSpacing;
    content.style.width = "100%";
    content.style.height = "100%";
    content.style.boxSizing = "border-box";
    content.style.overflow = "hidden";
    content.innerHTML = buildHighlightHTML(text, spans);
  }

  function buildHighlightHTML(text, spans) {
    var html = "";
    var cursor = 0;

    spans.forEach(function eachSpan(span) {
      html += escapeHTML(text.slice(cursor, span[0]));
      html += "<mark>" + escapeHTML(text.slice(span[0], span[1])) + "</mark>";
      cursor = span[1];
    });

    html += escapeHTML(text.slice(cursor));
    return html.replace(/\n/g, "<br>");
  }

  function escapeHTML(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(Math.round(Number(value) || 0));
  }
}());
