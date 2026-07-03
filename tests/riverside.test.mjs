// tests/riverside.test.mjs — Riverside link parse/build behavior (DOM-free).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDC = loadPDC(root, {}, ["app/riverside.js"]);
const R = PDC.riverside;

const tracks = {
  host: "http://127.0.0.1:9001/host.webm",
  guest1: "http://127.0.0.1:9001/guest1.webm",
  guest2: "http://127.0.0.1:9001/guest2.webm",
};

test("buildRiversideLink round-trips through parseRiversideLink", () => {
  const link = R.buildRiversideLink(tracks, { title: "Test ep" });
  assert.match(link, /^https:\/\/riverside\.fm\//);
  assert.ok(link.includes("#pdc-synced-tracks="));
  const parsed = R.parseRiversideLink(link);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.title, "Test ep");
  assert.deepEqual(parsed.tracks, tracks);
});

test("parseRiversideLink rejects empty and non-Riverside links", () => {
  assert.equal(R.parseRiversideLink("").ok, false);
  assert.equal(R.parseRiversideLink("https://example.com/foo").ok, false);
  assert.match(R.parseRiversideLink("https://example.com/foo").error, /Riverside/i);
});

test("parseRiversideLink rejects Riverside links without synced track fragment", () => {
  const bad = R.parseRiversideLink("https://riverside.fm/studio/share/abc123");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /synced speaker track/i);
});

test("parseRiversideLink rejects invalid fragment payload", () => {
  const link = "https://riverside.fm/studio/share/x#pdc-synced-tracks=not-json!!!";
  const bad = R.parseRiversideLink(link);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /invalid/i);
});

test("parseRiversideLink requires host and guest1 track URLs", () => {
  const link = R.buildRiversideLink({ guest2: tracks.guest2 });
  const bad = R.parseRiversideLink(link);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Host and Guest 1/i);
});

test("isRiversideHost accepts riverside.fm and subdomains", () => {
  assert.equal(R.isRiversideHost("https://riverside.fm/foo"), true);
  assert.equal(R.isRiversideHost("https://studio.riverside.fm/foo"), true);
  assert.equal(R.isRiversideHost("https://notriverside.fm/foo"), false);
});
