// Office tab: the Claude Office UI, full size, from the agent-office plugin's /office/ proxy.
// Plain JS, no build step. The page is same-origin, so the dashboard session cookie goes with it;
// the office token never reaches the browser (the proxy adds it server side).
(function () {
  var React = window.__HERMES_PLUGIN_SDK__.React;
  var h = React.createElement;
  var SRC = "/api/plugins/agent-office/office/";

  function OfficeTab() {
    return h(
      "div",
      { style: { position: "relative", width: "100%", height: "100%", minHeight: "80vh", display: "flex", flexDirection: "column" } },
      h("iframe", {
        src: SRC,
        title: "Claude Office",
        style: { flex: "1 1 auto", width: "100%", minHeight: "80vh", border: 0 },
      }),
      h(
        "a",
        { href: SRC, target: "_blank", rel: "noopener", style: { fontSize: "12px", padding: "4px 8px" } },
        "Open Claude Office in a new tab"
      )
    );
  }

  window.__HERMES_PLUGINS__.register("claude-office", OfficeTab);
})();
