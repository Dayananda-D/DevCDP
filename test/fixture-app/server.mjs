// ─── Test fixture app ────────────────────────────────────────────────────────
// A deliberately small app with the properties the integration test needs:
//   • a real external source map, so source-map behaviour is exercised for real
//   • a staged TypeError behind a button click
//   • a standards-based modal, opened on demand
//   • one successful and one failing API call
// Deliberately framework-free and domain-neutral.

import http from "http";

// Bundle lines, indexed from 1. Kept as an array so the test can assert on exact
// line numbers without counting whitespace by hand.
const BUNDLE_LINES = [
  `function saveOrder(order) {`,
  `  const payload = { id: order.id, total: order.total, lines: order.lines };`,
  `  return payload.customer.name;`,
  `}`,
  `function openDialog() {`,
  `  var d = document.createElement('div');`,
  `  d.setAttribute('role', 'dialog');`,
  `  d.setAttribute('aria-modal', 'true');`,
  `  d.style.cssText = 'position:fixed;top:28%;left:30%;width:340px;height:190px;background:#fff;border:1px solid #333;z-index:9000;padding:12px';`,
  `  d.innerHTML = '<h2>Confirm removal</h2><p>This cannot be undone.</p><button>Cancel</button><button>Remove</button>';`,
  `  document.body.appendChild(d);`,
  `}`,
  `window.addEventListener('DOMContentLoaded', function () {`,
  `  document.getElementById('save').addEventListener('click', function () {`,
  `    console.log('save clicked');`,
  `    saveOrder({ id: 41, total: 99.5, lines: [{ sku: 'A1', qty: 2 }] });`,
  `  });`,
  `  document.getElementById('open-dialog').addEventListener('click', openDialog);`,
  `  document.getElementById('popup').addEventListener('click', function () {`,
  `    window.open('/popup.html', '_blank');`,
  `  });`,
  `  document.getElementById('grow').addEventListener('click', function () {`,
  `    var p = document.createElement('p'); p.textContent = 'added ' + Date.now(); document.body.appendChild(p);`,
  `  });`,
  `  fetch('/api/orders').then(function (r) { return r.json(); }).then(function (j) { console.log('orders', j.count); });`,
  `  fetch('/api/broken').catch(function () { console.error('broken endpoint failed'); });`,
  `});`,
];

// The "original" file: the same code behind a 5-line header, so original and
// generated line numbers genuinely differ and a wrong mapping cannot pass.
const ORIGINAL_HEADER = [
  `/*`,
  ` * Fixture source file.`,
  ` * The bundle strips this header, so original line N maps to bundle line N-5.`,
  ` */`,
  ``,
];

export const ORIGINAL_PATH  = "app.src.js";
export const HEADER_OFFSET  = ORIGINAL_HEADER.length;          // 5
export const BUNDLE          = BUNDLE_LINES.join("\n") + `\n//# sourceMappingURL=app.js.map\n`;
export const ORIGINAL        = [...ORIGINAL_HEADER, ...BUNDLE_LINES].join("\n") + "\n";

/** Line numbers the test asserts against. */
export const LINES = {
  bundlePayload:   2,                     // const payload = ...
  originalPayload: 2 + HEADER_OFFSET,     // 7
  bundleThrow:     3,
};

// ── source map ──────────────────────────────────────────────────────────────
// base64-VLQ: 0 → "A", +1 → "C", +5 → "K".
// Line 1 jumps the source cursor forward by HEADER_OFFSET; later lines advance 1.
const vlqZero = "A";
const vlq = n => {
  let v = n < 0 ? ((-n) << 1) | 1 : n << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[digit];
  } while (v > 0);
  return out;
};

const firstSegment = vlqZero + vlqZero + vlq(HEADER_OFFSET) + vlqZero;   // "AAKA"
const nextSegment  = vlqZero + vlqZero + vlq(1) + vlqZero;               // "AACA"
const MAPPINGS = [firstSegment, ...BUNDLE_LINES.slice(1).map(() => nextSegment)].join(";");

export const SOURCE_MAP = {
  version: 3,
  file: "app.js",
  sources: [ORIGINAL_PATH],
  sourcesContent: [ORIGINAL],
  names: [],
  mappings: MAPPINGS,
};

// ── the shape of a real application, in miniature ────────────────────────────
//
// One script with a source map was not enough. A real page loads its own code
// alongside third-party code, sometimes hundreds of files, and search behaviour that
// looks fine against a single script can be useless against that: ranking, coverage
// reporting and per-file caps all only show their behaviour when there is more than
// one place a match could come from. So the fixture now serves a vendor library, a
// handful of application modules, and a term that appears in both.
//
// `SHARED_TERM` appears in vendor code and in application code. A search must
// surface the application's use of it, not only the vendor's.
export const SHARED_TERM = "resolveRecord";

export const VENDOR_PATH = "/node_modules/pretend-lib/dist/pretend.min.js";
const VENDOR = [
  `// pretend-lib — stands in for third-party code`,
  `function ${SHARED_TERM}(a){return a&&a.id?a:null}`,
  `function pretendHelper(x){return ${SHARED_TERM}(x)}`,
  `window.pretendLib={${SHARED_TERM}:${SHARED_TERM},pretendHelper:pretendHelper};`,
].join("\n");

/** Application modules, mirroring a framework that loads a file per unit. */
export const MODULE_COUNT = 24;
const moduleSource = i => [
  `// app module ${i}`,
  `window.appModule${i} = {`,
  `  name: 'module${i}',`,
  `  ${SHARED_TERM}: function (record) {`,
  `    return record && record.id ? record : { id: 0, module: ${i} };`,
  `  },`,
  `};`,
].join("\n");

const INDEX = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>DevCDP fixture app</title></head>
<body style="font:14px system-ui;padding:24px">
  <h1>DevCDP fixture</h1>
  <p>Three buttons, one staged bug.</p>
  <button id="save" data-testid="save-order">Save order</button>
  <button id="open-dialog" data-testid="open-dialog">Open dialog</button>
  <button id="grow" data-testid="grow">Append node</button>
  <button id="popup" data-testid="popup">Open in new tab</button>
  <table role="grid"><tr><th>SKU</th><th>Qty</th></tr><tr><td>A1</td><td>2</td></tr></table>
  <input name="reference" aria-label="Reference" />
  <script src="${VENDOR_PATH}"></script>
${Array.from({ length: MODULE_COUNT }, (_, i) => `  <script src="/app/modules/module${i}.js"></script>`).join("\n")}
  <script src="/app.js"></script>
</body></html>`;

export function startFixture(port = 0) {
  const server = http.createServer((req, res) => {
    const send = (code, type, body, extra = {}) => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...extra });
      res.end(body);
    };
    const url = (req.url || "/").split("?")[0];

    if (url === "/" || url === "/index.html") return send(200, "text/html; charset=utf-8", INDEX);
    if (url === VENDOR_PATH)                  return send(200, "application/javascript; charset=utf-8", VENDOR);

    const mod = /^\/app\/modules\/module(\d+)\.js$/.exec(url);
    if (mod) return send(200, "application/javascript; charset=utf-8", moduleSource(Number(mod[1])));

    if (url === "/app.js")                    return send(200, "application/javascript; charset=utf-8", BUNDLE);
    if (url === "/app.js.map")                return send(200, "application/json", JSON.stringify(SOURCE_MAP));
    if (url === "/popup.html")
      return send(200, "text/html; charset=utf-8",
        `<!doctype html><html><head><meta charset="utf-8"><title>Fixture popup</title></head>`
        + `<body style="font:14px system-ui;padding:24px"><h1>Opened by the app</h1>`
        + `<button id="in-popup" data-testid="in-popup">Act</button></body></html>`);
    if (url === "/api/orders")                return send(200, "application/json", JSON.stringify({ count: 2, orders: [{ id: 41 }, { id: 42 }] }));
    if (url === "/api/broken")                return send(500, "application/json", JSON.stringify({ error: "staged failure" }));
    if (url === "/openapi.json")
      return send(200, "application/json", JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Fixture API", version: "1.0.0" },
        paths: { "/api/orders": { get: { summary: "List orders" } }, "/api/broken": { get: { summary: "Always fails" } } },
        components: { schemas: { Order: { type: "object" } } },
      }));
    send(404, "text/plain", "not found");
  });

  return new Promise(resolve => {
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolve({ server, port: actual, origin: `http://127.0.0.1:${actual}` });
    });
  });
}
