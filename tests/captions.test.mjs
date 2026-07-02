// tests/captions.test.mjs — WebVTT caption import model: parsing, [start, end)
// activation semantics, and persistence across preset/template switches.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDC = loadPDC(root);
const C = PDC.captions;
const E = PDC.episode;

const SAMPLE_VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello from the host

00:00:05.000 --> 00:00:08.000
Guest follow-up line
`;

test("parseTimestamp accepts MM:SS.mmm and HH:MM:SS.mmm", () => {
  assert.equal(C.parseTimestamp("00:01.000"), 1);
  assert.equal(C.parseTimestamp("01:05.500"), 65.5);
  assert.equal(C.parseTimestamp("00:00:03.250"), 3.25);
});

test("parseTimestamp rejects invalid timestamps", () => {
  for (const bad of ["", "abc", "1", "00:xx", "00:00:60.000", null]) {
    assert.ok(Number.isNaN(C.parseTimestamp(bad)), `expected NaN for ${String(bad)}`);
  }
});

test("parseWebVTT extracts timed cues from a valid file", () => {
  const parsed = C.parseWebVTT(SAMPLE_VTT);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.cues.length, 2);
  assert.equal(parsed.cues[0].text, "Hello from the host");
  assert.equal(parsed.cues[0].start, 1);
  assert.equal(parsed.cues[0].end, 4);
  assert.equal(parsed.cues[1].text, "Guest follow-up line");
  assert.equal(parsed.cues[1].start, 5);
  assert.equal(parsed.cues[1].end, 8);
});

test("parseWebVTT accepts comma decimals and single-newline cue blocks", () => {
  const vtt = "WEBVTT\n\n00:00:01,000 --> 00:00:04,000\nComma cue one\n00:00:05,000 --> 00:00:08,000\nComma cue two\n";
  const parsed = C.parseWebVTT(vtt);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.cues.length, 2);
  assert.equal(parsed.cues[0].text, "Comma cue one");
  assert.equal(parsed.cues[1].text, "Comma cue two");
});

test("parseWebVTT accepts optional cue identifiers", () => {
  const vtt = "WEBVTT\n\ncue-1\n00:00:01.000 --> 00:00:04.000\nIdentified cue\n";
  const parsed = C.parseWebVTT(vtt);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.cues[0].text, "Identified cue");
});

test("parseWebVTT rejects files without a WEBVTT header or cues", () => {
  assert.equal(C.parseWebVTT("not a caption file").ok, false);
  assert.equal(C.parseWebVTT("WEBVTT\n\nNOTE\nnothing timed here").ok, false);
});

test("setCaptions stores cues on the episode and clearCaptions removes them", () => {
  const ep = E.createEpisode({});
  const parsed = C.parseWebVTT(SAMPLE_VTT);
  C.setCaptions(ep, "episode.vtt", parsed.cues);
  assert.equal(C.hasCaptions(ep), true);
  assert.equal(ep.captions.fileName, "episode.vtt");
  assert.equal(C.listCues(ep).length, 2);
  C.clearCaptions(ep);
  assert.equal(C.hasCaptions(ep), false);
  assert.deepEqual(C.listCues(ep), []);
});

test("activeCaptionsAt is start-inclusive and end-exclusive", () => {
  const ep = E.createEpisode({});
  C.setCaptions(ep, "episode.vtt", C.parseWebVTT(SAMPLE_VTT).cues);
  const at = (t) => C.activeCaptionsAt(ep, t).map((cue) => cue.text);
  assert.deepEqual(at(1), ["Hello from the host"]);
  assert.deepEqual(at(2.5), ["Hello from the host"]);
  assert.deepEqual(at(4), []);
  assert.deepEqual(at(4.5), []);
  assert.deepEqual(at(5), ["Guest follow-up line"]);
  assert.deepEqual(at(7.5), ["Guest follow-up line"]);
  assert.deepEqual(at(8), []);
});

test("captions survive preset and template switches", () => {
  const ep = E.createEpisode({});
  C.setCaptions(ep, "episode.vtt", C.parseWebVTT(SAMPLE_VTT).cues);
  E.assignMedia(ep, "host", { name: "h.webm", size: 1, type: "video/webm" });
  E.assignMedia(ep, "guest1", { name: "g.webm", size: 1, type: "video/webm" });
  E.setPreset(ep, "stack");
  assert.equal(C.listCues(ep).length, 2);
  const template = PDC.templates.saveTemplate("Show layout", [
    { x: 0, y: 0, w: 50, h: 100 },
    { x: 50, y: 0, w: 50, h: 100 },
  ]);
  E.setPreset(ep, template.id);
  assert.equal(C.activeCaptionsAt(ep, 2).length, 1);
});

test("episodes created before captions still work with lazy import", () => {
  const ep = E.createEpisode({});
  assert.equal(ep.captions, null);
  assert.equal(C.hasCaptions(ep), false);
  assert.deepEqual(C.activeCaptionsAt(ep, 1), []);
});
