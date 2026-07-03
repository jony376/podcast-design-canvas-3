// scripts/cdp-product-ui.mjs — drive the shipped product UI through CDP Input/DOM
// (fill + click), matching maintainer headless browser review (not Runtime.evaluate
// value injection on form controls).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

export function startStaticServer(root) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
  };
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      const full = path.join(root, rel);
      if (!full.startsWith(root)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      fs.readFile(full, (err, data) => {
        if (err) {
          res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
          return;
        }
        res.writeHead(200, { "content-type": types[path.extname(full)] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}/index.html` });
    });
  });
}

export async function enableProductUi(send) {
  await send("DOM.enable");
  await send("Runtime.enable");
}

export async function querySelectorNodeId(send, selector) {
  const doc = await send("DOM.getDocument");
  const { nodeId } = await send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector,
  });
  if (!nodeId) throw new Error("Could not find " + selector + " in the product DOM");
  return nodeId;
}

export async function fillInput(send, selector, text) {
  await send("Runtime.evaluate", {
    expression: `(function(){
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("missing " + ${JSON.stringify(selector)});
      el.focus();
      el.select();
    })()`,
  });
  await send("Input.insertText", { text });
}

export async function clickElement(send, selector) {
  const nodeId = await querySelectorNodeId(send, selector);
  const box = await send("DOM.getBoxModel", { nodeId });
  const c = box.model.content;
  const x = (c[0] + c[4]) / 2;
  const y = (c[1] + c[5]) / 2;
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

export async function waitForEvaluate(send, expression, label, tries = 200, intervalMs = 50) {
  for (let i = 0; i < tries; i++) {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (r.result && r.result.value === true) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(label);
}
