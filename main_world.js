(function bootstrapClaudeSmartGuardBridge() {
  "use strict";

  var BRIDGE_READY_EVENT = "csg:bridge:ready";
  var INJECT_CONTEXT_EVENT = "csg:bridge:inject-context";
  var EDITOR_SELECTORS = [
    'div[contenteditable="true"][data-testid]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]'
  ];

  function findEditor() {
    return document.querySelector(EDITOR_SELECTORS.join(", "));
  }

  function dispatchSyntheticEvents(editor, text) {
    var beforeInput;
    var input;

    beforeInput = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: text,
      inputType: "insertFromPaste"
    });

    input = new InputEvent("input", {
      bubbles: true,
      data: text,
      inputType: "insertFromPaste"
    });

    editor.dispatchEvent(beforeInput);
    editor.dispatchEvent(input);
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: " ",
      code: "Space"
    }));
    editor.dispatchEvent(new KeyboardEvent("keyup", {
      bubbles: true,
      key: " ",
      code: "Space"
    }));
  }

  function injectContextText(text) {
    var editor = findEditor();
    if (!editor) {
      return false;
    }

    editor.focus();
    editor.innerText = text;
    dispatchSyntheticEvents(editor, text);
    return true;
  }

  window.addEventListener(INJECT_CONTEXT_EVENT, function onInject(event) {
    var detail = event && event.detail ? event.detail : {};
    var attempts = 0;
    var timer = window.setInterval(function tryInjection() {
      attempts += 1;
      if (injectContextText(String(detail.text || "")) || attempts > 20) {
        window.clearInterval(timer);
      }
    }, 200);
  });

  window.dispatchEvent(new CustomEvent(BRIDGE_READY_EVENT));
}());
