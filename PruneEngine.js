(function attachPruneEngine(globalObject) {
  "use strict";

  var MESSAGE_SELECTORS = [
    ".message-bubble",
    '[data-testid*="message"]',
    '[data-testid*="turn"]',
    "main article"
  ];
  var PIN_STORAGE_KEY = "csgPinnedMessageIds";

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

  function dedupeNodes(nodes) {
    var seen = new Set();
    var deduped = [];

    nodes.forEach(function eachNode(node) {
      if (!node || seen.has(node)) {
        return;
      }
      seen.add(node);
      deduped.push(node);
    });

    return deduped;
  }

  function getMessageElements() {
    var nodes = [];

    MESSAGE_SELECTORS.forEach(function eachSelector(selector) {
      Array.prototype.forEach.call(document.querySelectorAll(selector), function eachNode(node) {
        nodes.push(node);
      });
    });

    return dedupeNodes(nodes).filter(function isLikelyMessage(node) {
      var text = (node.innerText || "").trim();
      if (!text) {
        return false;
      }
      if (node.closest('[data-csg-root="1"]') || node.closest("form")) {
        return false;
      }
      if (node.querySelector('div[contenteditable="true"]')) {
        return false;
      }
      return true;
    });
  }

  function inferRole(node) {
    var signal = [
      node.getAttribute("data-role"),
      node.getAttribute("data-author"),
      node.getAttribute("aria-label"),
      node.getAttribute("class"),
      node.getAttribute("data-testid")
    ].join(" ").toLowerCase();

    if (/assistant|claude|bot/.test(signal)) {
      return "assistant";
    }

    if (/user|human|you/.test(signal)) {
      return "user";
    }

    return "context";
  }

  function stableHash(input) {
    var value = String(input || "");
    var hash = 5381;
    var index;

    for (index = 0; index < value.length; index += 1) {
      hash = ((hash << 5) + hash) + value.charCodeAt(index);
      hash &= 0xffffffff;
    }

    return "msg_" + Math.abs(hash).toString(36);
  }

  function extractMessageText(node) {
    var clone = node.cloneNode(true);
    var removable = clone.querySelectorAll("[data-csg-prune-host]");

    Array.prototype.forEach.call(removable, function removeHost(host) {
      host.remove();
    });

    return (clone.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
  }

  function scanMessages(options) {
    var opts = options || {};
    var pinnedIds = new Set(opts.pinnedIds || []);

    return getMessageElements().map(function toMessage(node, index) {
      var text = extractMessageText(node);
      var id = node.getAttribute("data-message-id") ||
        node.id ||
        stableHash(index + ":" + text.slice(0, 240));

      return {
        id: id,
        index: index,
        role: inferRole(node),
        text: text,
        pinned: pinnedIds.has(id),
        element: node
      };
    }).filter(function keepMessage(message) {
      return Boolean(message.text);
    });
  }

  async function getPinnedIds() {
    var stored = await storageLocalGet(PIN_STORAGE_KEY);
    return Array.isArray(stored[PIN_STORAGE_KEY]) ? stored[PIN_STORAGE_KEY] : [];
  }

  async function setPinnedState(messageId, shouldPin) {
    var current = await getPinnedIds();
    var next = new Set(current);

    if (shouldPin) {
      next.add(messageId);
    } else {
      next.delete(messageId);
    }

    await storageLocalSet((function buildPayload() {
      var payload = {};
      payload[PIN_STORAGE_KEY] = Array.from(next);
      return payload;
    }()));

    return Array.from(next);
  }

  function buildContextReference(selectedMessages) {
    var sorted = (selectedMessages || []).slice().sort(function byIndex(a, b) {
      return (a.index || 0) - (b.index || 0);
    });

    return [
      '<context_reference source="Claude Smart-Guard">',
      sorted.map(function toBlock(message, index) {
        var tags = [];
        if (message.pinned) {
          tags.push("PINNED");
        }
        tags.push(String(message.role || "context").toUpperCase());
        return "[#" + (index + 1) + " " + tags.join(" · ") + "]\n" + message.text;
      }).join("\n\n"),
      "</context_reference>"
    ].join("\n");
  }

  globalObject.ClaudeSmartGuard = globalObject.ClaudeSmartGuard || {};
  globalObject.ClaudeSmartGuard.PruneEngine = {
    PIN_STORAGE_KEY: PIN_STORAGE_KEY,
    scanMessages: scanMessages,
    getPinnedIds: getPinnedIds,
    setPinnedState: setPinnedState,
    buildContextReference: buildContextReference
  };
}(globalThis));
