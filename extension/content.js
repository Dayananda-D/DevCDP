// ─── DevCDP content script ───────────────────────────────────────────────────
// The MCP server process has no channel to this extension, and building one
// (websocket, native messaging) would be another moving part to install and
// supervise. Instead the server's injected agent leaves a marker attribute on
// <html>, and we watch for it. One-way, zero config, survives SPA routing.
//
//   data-devcdp-session      → human label, e.g. "DevCDP · session 1"
//   data-devcdp-session-id   → stable session identity, used to group tabs
//   data-devcdp-session-no   → 1,2,3… used to pick the group colour

(function () {
  "use strict";

  var lastState = null;

  function read() {
    var de = document.documentElement;
    if (!de) return null;
    var id = de.getAttribute("data-devcdp-session-id");
    if (!id) return null;
    return {
      sessionId: id,
      label: de.getAttribute("data-devcdp-session") || "DevCDP",
      sessionNo: parseInt(de.getAttribute("data-devcdp-session-no") || "1", 10) || 1,
      groupMode: de.getAttribute("data-devcdp-group-mode") === "single" ? "single" : "session",
    };
  }

  function push() {
    var now = read();
    var key = now ? now.sessionId + "|" + now.label + "|" + now.groupMode : null;
    if (key === lastState) return;
    lastState = key;

    try {
      chrome.runtime.sendMessage(
        now ? { type: "devcdp:claim", session: now } : { type: "devcdp:release" },
        function (reply) {
          void chrome.runtime.lastError;                 // swallow "no receiver"
          // Report the outcome back into the DOM, so the server (and the test
          // suite) can verify grouping actually happened rather than assuming it.
          try {
            var de = document.documentElement;
            if (!de) return;
            if (reply && reply.ok && reply.groupId != null) {
              de.setAttribute("data-devcdp-group", String(reply.groupId));
              if (reply.color) de.setAttribute("data-devcdp-group-color", reply.color);
              de.removeAttribute("data-devcdp-group-error");
            } else {
              de.removeAttribute("data-devcdp-group");
              de.removeAttribute("data-devcdp-group-color");
              // Say why. Without this, "the extension is installed but grouping threw"
              // was indistinguishable from "no extension is installed", and the status
              // tool confidently reported the wrong one of the two.
              if (reply && reply.error) de.setAttribute("data-devcdp-group-error", String(reply.error).slice(0, 120));
              else de.removeAttribute("data-devcdp-group-error");
            }
          } catch (_) {}
        }
      );
    } catch (_) {}
  }

  push();

  try {
    new MutationObserver(push).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-devcdp-session", "data-devcdp-session-id", "data-devcdp-session-no"],
    });
  } catch (_) {}

  // SPA route changes can replace <html> wholesale in extreme cases.
  window.addEventListener("pageshow", push);
})();
