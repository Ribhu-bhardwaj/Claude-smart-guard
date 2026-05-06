(function renderPopup() {
  "use strict";

  var DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  document.addEventListener("DOMContentLoaded", function onReady() {
    globalThis.ClaudeSmartGuardDB.getWeeklySummary(7).then(function onSummary(summary) {
      renderSummary(summary);
      renderHeatmap(summary);
    }).catch(function onError() {
      document.getElementById("empty-state").hidden = false;
      document.getElementById("empty-state").textContent = "Unable to load local analytics yet.";
    });
  });

  function renderSummary(summary) {
    var totals = summary.reduce(function accumulate(acc, entry) {
      acc.wasted += entry.wasted;
      acc.productive += entry.productive;
      acc.turns += entry.turns;
      return acc;
    }, {
      wasted: 0,
      productive: 0,
      turns: 0
    });

    document.getElementById("wasted-total").textContent = formatNumber(totals.wasted);
    document.getElementById("productive-total").textContent = formatNumber(totals.productive);
    document.getElementById("turn-total").textContent = formatNumber(totals.turns);
    document.getElementById("empty-state").hidden = totals.turns > 0;
  }

  function renderHeatmap(summary) {
    var heatmap = document.getElementById("heatmap");
    var maxValue = summary.reduce(function takeMax(max, entry) {
      return Math.max(max, entry.wasted, entry.productive);
    }, 1);

    heatmap.innerHTML = "";
    heatmap.appendChild(labelCell(""));

    summary.forEach(function eachEntry(entry) {
      heatmap.appendChild(labelCell(DAY_LABELS[new Date(entry.day).getUTCDay() === 0 ? 6 : new Date(entry.day).getUTCDay() - 1], "day-label"));
    });

    heatmap.appendChild(labelCell("Wasted", "heat-label"));
    summary.forEach(function eachEntry(entry) {
      heatmap.appendChild(buildCell(entry.wasted, maxValue, "rgba(243, 107, 79, 0.82)"));
    });

    heatmap.appendChild(labelCell("Productive", "heat-label"));
    summary.forEach(function eachEntry(entry) {
      heatmap.appendChild(buildCell(entry.productive, maxValue, "rgba(246, 198, 98, 0.82)"));
    });
  }

  function labelCell(text, className) {
    var cell = document.createElement("div");
    cell.textContent = text;
    cell.className = className || "";
    return cell;
  }

  function buildCell(value, maxValue, color) {
    var cell = document.createElement("div");
    var fill = document.createElement("span");
    var intensity = Math.max(0.08, (value || 0) / maxValue);

    cell.className = "cell";
    cell.title = formatNumber(value) + " tokens";
    fill.style.background = color;
    fill.style.opacity = intensity.toFixed(2);
    cell.appendChild(fill);
    return cell;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(Math.round(Number(value) || 0));
  }
}());
