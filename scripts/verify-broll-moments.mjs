// scripts/verify-broll-moments.mjs
// Drives the shipped app in headless Chrome and proves issue #130 end to end:
// upload two generated speaker WebM videos through the normal Host/Guest
// controls, add a timed b-roll PNG moment through the real moments UI, prove
// the PNG overlay is visible only inside its scheduled range in preview across
// presets, then click the real Export action and prove the exported video burns
// the PNG into decoded frames only during that same range. No committed media,
// mock previews, verifier-only product paths, or seeded output files are used.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "google-chrome",
    "chromium",
    "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  for (const c of candidates) if (spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0) return c;
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run b-roll verification.");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      child.off("exit", onExit);
      resolve(ok);
    };
    const onExit = () => finish(true);
    const t = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopChrome(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 2000)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 2000);
}

async function removeDirEventually(dir) {
  for (let i = 0; i < 8; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === 7) return;
      await sleep(100 * (i + 1));
    }
  }
}

async function fetchJson(url, attempts = 60) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      last = new Error("HTTP " + r.status);
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw last;
}

function connectWebSocket(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (event) => {
    const m = JSON.parse(event.data);
    if (!m.id || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const send = (method, params = {}) => {
    const callId = ++id;
    ws.send(JSON.stringify({ id: callId, method, params }));
    return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
  };
  return { ws, ready, send };
}

const browserExpression = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const waitFor = async (fn, label, tries) => {
    for (let i = 0; i < (tries || 220); i++) { if (fn()) return; await sleep(50); }
    throw new Error(label);
  };

  async function makeVideo(name, color, freq) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    osc.frequency.value = freq || 440;
    const dest = ac.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const mix = new MediaStream([...stream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const rec = new MediaRecorder(mix, { mimeType });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start(250);
    for (let i = 0; i < 82; i++) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 320, 180);
      await sleep(100);
    }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop();
    ac.close();
    stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }

  async function makePng(name) {
    const canvas = document.createElement("canvas");
    canvas.width = 280; canvas.height = 160;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ff00ff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#00ffff";
    ctx.fillRect(24, 24, canvas.width - 48, canvas.height - 48);
    ctx.fillStyle = "#ff00ff";
    ctx.fillRect(82, 54, 116, 52);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    assert(blob && blob.size > 1000, "generated PNG should have real bytes");
    return new File([blob], name, { type: "image/png" });
  }

  const uploadTo = (input, file) => {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const typeInto = (input, v) => {
    input.value = v;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const stage = () => document.querySelector("#stage-canvas");
  const BROLL_REGION = { x0: 31, y0: 25, x1: 69, y1: 53 };

  function regionStats(canvas, region) {
    const w = canvas.width, h = canvas.height;
    const x0 = Math.floor(region.x0 / 100 * w), x1 = Math.floor(region.x1 / 100 * w);
    const y0 = Math.floor(region.y0 / 100 * h), y1 = Math.floor(region.y1 / 100 * h);
    const data = canvas.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let magenta = 0, cyan = 0, dark = 0, bright = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 180 && g < 90 && b > 180) magenta++;
      if (r < 90 && g > 165 && b > 165) cyan++;
      if (r < 50 && g < 50 && b < 50) dark++;
      if (r > 90 || g > 90 || b > 90) bright++;
    }
    return { magenta: magenta / n, cyan: cyan / n, dark: dark / n, bright: bright / n };
  }

  const brollShownOn = (canvas) => {
    const s = regionStats(canvas, BROLL_REGION);
    return s.magenta > 0.12 && s.cyan > 0.12;
  };
  const brollAbsentOn = (canvas) => {
    const s = regionStats(canvas, BROLL_REGION);
    return s.magenta < 0.02 && s.cyan < 0.02;
  };
  const brollShown = () => brollShownOn(stage());
  const brollAbsent = () => brollAbsentOn(stage());

  await waitFor(() => window.PDC && window.PDC.moments && window.PDC.momentImages
    && document.querySelector('[data-file-bucket="host"]')
    && document.querySelector("#moment-image")
    && document.querySelector("#moment-add")
    && document.querySelector("#export")
    && document.querySelector("#scrub"),
    "shipped b-roll moment controls should exist");

  const scratch = window.PDC.episode.createEpisode({});
  window.PDC.moments.addMoment(scratch, { type: "image", imageName: "overlay.png", start: "0:02", end: "0:06" });
  const at = (t) => window.PDC.moments.activeMoments(scratch, t).map((m) => m.type).join(",");
  assert(at(1.99) === "", "image moment must be absent before its start");
  assert(at(2) === "image" && at(5.99) === "image", "image moment must be active inside [start,end)");
  assert(at(6) === "", "image moment must be absent at its end");

  const [host, guest, png] = await Promise.all([
    makeVideo("host.webm", "#b91c1c", 300),
    makeVideo("guest.webm", "#10b981", 520),
    makePng("broll-proof.png"),
  ]);
  uploadTo(document.querySelector('[data-file-bucket="host"]'), host);
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), guest);
  await waitFor(() => document.querySelectorAll("video[data-speaker]").length === 2, "two decoder videos should exist");
  const vids = [...document.querySelectorAll("video[data-speaker]")];
  await waitFor(
    () => vids.every((v) => v.readyState >= 2 && isFinite(v.duration) && v.duration >= 7.2),
    "uploaded WebM speaker media should decode with a duration covering the b-roll range", 420,
  );

  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split preset should be active");

  const sel = document.querySelector("#moment-type");
  sel.value = "image";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  typeInto(document.querySelector("#moment-start"), "0:02");
  typeInto(document.querySelector("#moment-end"), "0:06");
  document.querySelector("#moment-add").click();
  await waitFor(() => !document.querySelector("#moment-error").hidden, "adding image moment without PNG should be rejected");
  assert(/PNG image/i.test(document.querySelector("#moment-error").textContent), "validation must ask for a PNG image");

  uploadTo(document.querySelector("#moment-image"), png);
  await waitFor(() => /Selected PNG: broll-proof.png/.test(document.querySelector("#moment-image-status").textContent),
    "PNG upload status should show the selected filename");
  assert(document.querySelector("#moment-type").value === "image", "uploading PNG should choose the b-roll image moment type");
  typeInto(document.querySelector("#moment-start"), "0:02");
  typeInto(document.querySelector("#moment-end"), "0:06");
  document.querySelector("#moment-add").click();
  await waitFor(() => document.querySelectorAll("#moment-list li").length === 1, "b-roll image moment should appear in the list");
  const listText = document.querySelector("#moment-list").textContent;
  assert(listText.includes("B-roll") && listText.includes("broll-proof.png") && listText.includes("0:02") && listText.includes("0:06"),
    "moment list should show the b-roll filename and scheduled range");
  assert(document.querySelector("#moment-error").hidden || !document.querySelector("#moment-error").textContent.trim(),
    "valid PNG b-roll moment should clear the validation error");
  await waitFor(() => brollShown(), "preview should show the uploaded b-roll PNG immediately after adding the moment");
  const immediateAfterAdd = regionStats(stage(), BROLL_REGION);

  // PLAYBACK: prove the normal preview can run through the scheduled range and
  // show/hide the PNG without relying only on direct scrub jumps.
  document.querySelector("#restart").click();
  await waitFor(() => brollAbsent(), "live preview should start before the b-roll image appears", 60);
  await waitFor(() => brollShown(), "live preview playback should show the b-roll image inside 0:02-0:06", 120);
  const playbackDuring = regionStats(stage(), BROLL_REGION);
  await waitFor(() => brollAbsent(), "live preview playback should hide the b-roll image after 0:06", 140);
  const playbackAfter = regionStats(stage(), BROLL_REGION);

  const scrub = document.querySelector("#scrub");
  async function scrubTo(t) {
    await waitFor(() => !scrub.disabled && Number(scrub.max) >= 7, "scrub bar should span the uploaded episode", 120);
    scrub.value = String(t);
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(120);
  }
  function pausePreview() {
    const btn = document.querySelector("#play");
    if (btn.textContent.indexOf("Pause") !== -1) btn.click();
  }
  pausePreview();

  await scrubTo(1);
  await waitFor(() => brollAbsent(), "preview at 1s should not show the b-roll image");
  const splitBefore = regionStats(stage(), BROLL_REGION);
  await scrubTo(3.5);
  await waitFor(() => brollShown(), "preview at 3.5s should show the uploaded b-roll PNG");
  const splitDuring = regionStats(stage(), BROLL_REGION);
  await scrubTo(6.5);
  await waitFor(() => brollAbsent(), "preview at 6.5s should hide the b-roll image");
  const splitAfter = regionStats(stage(), BROLL_REGION);

  const presetStats = {};
  for (const presetId of ["stack", "spotlight"]) {
    document.querySelector('[data-preset="' + presetId + '"]').click();
    await waitFor(() => stage().dataset.preset === presetId, presetId + " preset should apply");
    await scrubTo(1);
    await waitFor(() => brollAbsent(), presetId + " preview should not show b-roll before range");
    await scrubTo(3.5);
    await waitFor(() => brollShown(), presetId + " preview should show b-roll during range");
    const during = regionStats(stage(), BROLL_REGION);
    await scrubTo(6.5);
    await waitFor(() => brollAbsent(), presetId + " preview should hide b-roll after range");
    presetStats[presetId] = {
      during,
      momentsListed: document.querySelectorAll("#moment-list li").length,
    };
  }

  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split should be re-applied before export");
  await waitFor(() => !document.querySelector("#export").disabled, "Export should be enabled");
  document.querySelector("#export").click();
  await waitFor(
    () => document.querySelector("#export-download") && document.querySelector("#export-playback"),
    "export should produce a downloadable result", 760,
  );
  const resultText = document.querySelector("#export-result").textContent || "";
  assert(!/failed/i.test(resultText), "export must not report failure: " + resultText);
  const href = document.querySelector("#export-download").getAttribute("href");
  assert(href && href.indexOf("blob:") === 0, "download link should be a real blob URL");
  const blob = await (await fetch(href)).blob();
  assert(blob.size > 4096, "exported file should carry real bytes, got " + blob.size);

  const v = document.createElement("video");
  v.muted = true;
  v.src = URL.createObjectURL(blob);
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
  assert(v.videoWidth > 0 && v.videoHeight > 0, "exported file should be a playable video with dimensions");
  if (!isFinite(v.duration)) {
    v.currentTime = 1e7;
    await waitFor(() => isFinite(v.duration), "exported duration should resolve", 220);
  }
  assert(v.duration >= 6.2, "export should cover the full b-roll range, duration=" + v.duration);

  const probe = document.createElement("canvas");
  probe.width = v.videoWidth;
  probe.height = v.videoHeight;
  async function seekAndSample(t) {
    await new Promise((resolve) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        v.removeEventListener("seeked", fin);
        resolve();
      };
      v.addEventListener("seeked", fin);
      setTimeout(fin, 4000);
      try { v.currentTime = t; } catch (e) { fin(); }
    });
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; resolve(); };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(fin);
      setTimeout(fin, 350);
    });
    probe.getContext("2d").drawImage(v, 0, 0, probe.width, probe.height);
    return {
      t,
      broll: regionStats(probe, BROLL_REGION),
      frame: regionStats(probe, { x0: 0, y0: 0, x1: 100, y1: 100 }),
    };
  }

  const exportedBefore = await seekAndSample(1);
  const exportedDuring = await seekAndSample(3.5);
  const exportedAfter = await seekAndSample(6.5);
  assert(exportedBefore.frame.bright > 0.2, "exported frame at 1s should be nonblank");
  assert(brollAbsentOn(probe), "sanity check probe helper should be callable");
  assert(exportedBefore.broll.magenta < 0.03 && exportedBefore.broll.cyan < 0.03,
    "exported frame at 1s must not contain the b-roll PNG: " + JSON.stringify(exportedBefore.broll));
  assert(exportedDuring.frame.bright > 0.2, "exported frame at 3.5s should be nonblank");
  assert(exportedDuring.broll.magenta > 0.08 && exportedDuring.broll.cyan > 0.08,
    "exported frame at 3.5s must contain the uploaded PNG: " + JSON.stringify(exportedDuring.broll));
  assert(exportedAfter.frame.bright > 0.2, "exported frame at 6.5s should be nonblank");
  assert(exportedAfter.broll.magenta < 0.03 && exportedAfter.broll.cyan < 0.03,
    "exported frame at 6.5s must not contain the b-roll PNG: " + JSON.stringify(exportedAfter.broll));

  return {
    momentsListed: document.querySelectorAll("#moment-list li").length,
    preview: { immediateAfterAdd, playbackDuring, playbackAfter, splitBefore, splitDuring, splitAfter, stack: presetStats.stack, spotlight: presetStats.spotlight },
    exportBytes: blob.size,
    exportDuration: Number(v.duration.toFixed(2)),
    exportSamples: { before: exportedBefore, during: exportedDuring, after: exportedAfter },
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-broll-"));
  const entryUrl = pathToFileURL(path.join(root, "index.html")).href;
  const child = spawn(chrome, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required",
    "--allow-file-access-from-files",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    entryUrl,
  ]);
  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");
    const { ws, ready, send } = connectWebSocket(page.webSocketDebuggerUrl);
    await ready;
    await send("Runtime.enable");
    const result = await send("Runtime.evaluate", {
      expression: browserExpression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 120000,
    });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-broll-moments: OK - uploaded PNG b-roll renders only in range in preview and export");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => {
  console.error(`verify-broll-moments: ${e.message}`);
  process.exit(1);
});
