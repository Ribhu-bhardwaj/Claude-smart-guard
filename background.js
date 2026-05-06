importScripts("db.js");

var PENDING_DRAFT_PREFIX = "pendingDraft:";

chrome.runtime.onInstalled.addListener(function onInstalled() {
  chrome.storage.local.set({
    csgIntent: "general",
    csgPruneMode: false
  });
});

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

function storageSessionRemove(key) {
  return new Promise(function executor(resolve) {
    chrome.storage.session.remove(key, resolve);
  });
}

function createClaudeTab(url) {
  return new Promise(function executor(resolve, reject) {
    chrome.tabs.create({ url: url, active: true }, function onCreated(tab) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(tab);
    });
  });
}

async function openPrunedSession(payload) {
  var tab = await createClaudeTab("https://claude.ai/new");
  var key = PENDING_DRAFT_PREFIX + tab.id;
  await storageSessionSet((function buildPayload() {
    var obj = {};
    obj[key] = payload;
    return obj;
  }()));
  return {
    ok: true,
    tabId: tab.id
  };
}

async function consumePendingDraft(sender) {
  var tabId = sender && sender.tab && sender.tab.id;
  var key;
  var stored;

  if (!Number.isInteger(tabId)) {
    return { ok: false, payload: null };
  }

  key = PENDING_DRAFT_PREFIX + tabId;
  stored = await storageSessionGet(key);

  if (!stored || !stored[key]) {
    return { ok: true, payload: null };
  }

  await storageSessionRemove(key);
  return {
    ok: true,
    payload: stored[key]
  };
}

async function getDailySummary() {
  var start = new Date();
  var entries;
  var summary = {
    estimated_tokens: 0,
    context_size: 0,
    wasted_tokens: 0,
    productive_tokens: 0,
    turns: 0
  };

  start.setHours(0, 0, 0, 0);
  entries = await globalThis.ClaudeSmartGuardDB.getEntriesFrom(start.getTime());

  entries.forEach(function eachEntry(entry) {
    summary.estimated_tokens += Number(entry.estimated_tokens) || 0;
    summary.context_size += Number(entry.context_size) || 0;
    summary.wasted_tokens += Number(entry.wasted_tokens) || 0;
    summary.productive_tokens += Number(entry.productive_tokens) || 0;
    summary.turns += 1;
  });

  return {
    ok: true,
    summary: summary
  };
}

chrome.runtime.onMessage.addListener(function onMessage(message, sender, sendResponse) {
  (async function routeMessage() {
    if (!message || !message.type) {
      return { ok: false, error: "Missing message type." };
    }

    switch (message.type) {
      case "CSD_OPEN_PRUNED_SESSION":
        return openPrunedSession(message.payload);
      case "CSD_REQUEST_PENDING_DRAFT":
        return consumePendingDraft(sender);
      case "CSD_LOG_ANALYTICS":
        await globalThis.ClaudeSmartGuardDB.addAnalytics(message.entry);
        return { ok: true };
      case "CSD_GET_DAILY_SUMMARY":
        return getDailySummary();
      default:
        return { ok: false, error: "Unsupported message type." };
    }
  }()).then(function onSuccess(result) {
    sendResponse(result);
  }).catch(function onError(error) {
    sendResponse({
      ok: false,
      error: error && error.message ? error.message : String(error)
    });
  });

  return true;
});
