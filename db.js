(function attachClaudeSmartGuardDB(globalObject) {
  "use strict";

  var DB_NAME = "claude-smart-guard";
  var DB_VERSION = 1;
  var ANALYTICS_STORE = "analytics";
  var DAY_MS = 24 * 60 * 60 * 1000;

  function rejectMissingIndexedDB() {
    return Promise.reject(new Error("IndexedDB is not available in this context."));
  }

  function openDB() {
    if (typeof indexedDB === "undefined") {
      return rejectMissingIndexedDB();
    }

    return new Promise(function executor(resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function onUpgrade() {
        var db = request.result;
        var store;

        if (!db.objectStoreNames.contains(ANALYTICS_STORE)) {
          store = db.createObjectStore(ANALYTICS_STORE, {
            keyPath: "id",
            autoIncrement: true
          });
          store.createIndex("timestamp", "timestamp", { unique: false });
          store.createIndex("intent_category", "intent_category", { unique: false });
        }
      };

      request.onsuccess = function onSuccess() {
        resolve(request.result);
      };

      request.onerror = function onError() {
        reject(request.error || new Error("Unable to open analytics database."));
      };
    });
  }

  function normalizeEntry(entry) {
    var safeEntry = entry || {};
    return {
      timestamp: Number(safeEntry.timestamp) || Date.now(),
      intent_category: String(safeEntry.intent_category || "general"),
      estimated_tokens: Number(safeEntry.estimated_tokens) || 0,
      context_size: Number(safeEntry.context_size) || 0,
      waste_potential: Number(safeEntry.waste_potential) || 0,
      ttl_penalty: Number(safeEntry.ttl_penalty) || 1,
      similarity: Number(safeEntry.similarity) || 0,
      wasted_tokens: Number(safeEntry.wasted_tokens) || 0,
      productive_tokens: Number(safeEntry.productive_tokens) || 0,
      density_multiplier: Number(safeEntry.density_multiplier) || 1
    };
  }

  async function addAnalytics(entry) {
    var db = await openDB();
    var normalized = normalizeEntry(entry);

    return new Promise(function executor(resolve, reject) {
      var transaction = db.transaction(ANALYTICS_STORE, "readwrite");
      var store = transaction.objectStore(ANALYTICS_STORE);
      var request = store.add(normalized);

      request.onsuccess = function onSuccess() {
        resolve(normalized);
      };

      request.onerror = function onError() {
        reject(request.error || new Error("Unable to write analytics entry."));
      };

      transaction.oncomplete = function onComplete() {
        db.close();
      };

      transaction.onabort = function onAbort() {
        db.close();
      };

      transaction.onerror = function onTransactionError() {
        db.close();
      };
    });
  }

  async function getEntriesFrom(fromTimestamp) {
    var db = await openDB();
    var floor = Number(fromTimestamp) || 0;

    return new Promise(function executor(resolve, reject) {
      var transaction = db.transaction(ANALYTICS_STORE, "readonly");
      var store = transaction.objectStore(ANALYTICS_STORE);
      var index = store.index("timestamp");
      var range = IDBKeyRange.lowerBound(floor);
      var request = index.openCursor(range);
      var entries = [];

      request.onsuccess = function onSuccess(event) {
        var cursor = event.target.result;
        if (!cursor) {
          resolve(entries);
          return;
        }

        entries.push(cursor.value);
        cursor.continue();
      };

      request.onerror = function onError() {
        reject(request.error || new Error("Unable to read analytics entries."));
      };

      transaction.oncomplete = function onComplete() {
        db.close();
      };

      transaction.onabort = function onAbort() {
        db.close();
      };

      transaction.onerror = function onTransactionError() {
        db.close();
      };
    });
  }

  function getEntriesSince(dayCount) {
    var days = Math.max(1, Number(dayCount) || 1);
    return getEntriesFrom(Date.now() - (days * DAY_MS));
  }

  async function getWeeklySummary(dayCount) {
    var totalDays = Math.max(1, Number(dayCount) || 7);
    var start = new Date();
    var cursorDate;
    var dayMap = {};
    var orderedDays = [];
    var index;
    var entries;

    start.setUTCHours(0, 0, 0, 0);
    start = new Date(start.getTime() - ((totalDays - 1) * DAY_MS));

    for (index = 0; index < totalDays; index += 1) {
      cursorDate = new Date(start.getTime() + (index * DAY_MS));
      orderedDays.push(cursorDate.toISOString().slice(0, 10));
      dayMap[orderedDays[orderedDays.length - 1]] = {
        day: orderedDays[orderedDays.length - 1],
        wasted: 0,
        productive: 0,
        turns: 0
      };
    }

    entries = await getEntriesFrom(start.getTime());
    entries.forEach(function eachEntry(entry) {
      var dayKey = new Date(entry.timestamp).toISOString().slice(0, 10);
      if (!dayMap[dayKey]) {
        return;
      }

      dayMap[dayKey].wasted += Number(entry.wasted_tokens) || 0;
      dayMap[dayKey].productive += Number(entry.productive_tokens) || 0;
      dayMap[dayKey].turns += 1;
    });

    return orderedDays.map(function toOrderedSummary(dayKey) {
      return dayMap[dayKey];
    });
  }

  globalObject.ClaudeSmartGuardDB = {
    DB_NAME: DB_NAME,
    addAnalytics: addAnalytics,
    getEntriesFrom: getEntriesFrom,
    getEntriesSince: getEntriesSince,
    getWeeklySummary: getWeeklySummary
  };
}(globalThis));
