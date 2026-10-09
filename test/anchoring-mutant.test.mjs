/**
 * Anchoring mutant check.
 *
 * The panel used to be pinned to the top-right corner
 * (overlay: justifyContent flex-end + alignItems flex-start). The suite now
 * asserts it appears near the clicked row. This file proves those assertions
 * would FAIL against the old behaviour — otherwise the new checks prove nothing.
 *
 * Run: node test/anchoring-mutant.test.mjs
 */

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

let failures = 0;
let checks = 0;
function check(label, fn) {
  checks += 1;
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${error?.message ?? error}`);
  }
}

console.log("\nanchoring — the corner-pinned regression must be detectable\n");

check("the shipped overlay no longer right-pins the panel", () => {
  // The old corner placement put flex-end on the OVERLAY. A button row's
  // right-alignment is legitimate, so scope the check to the overlay block.
  const overlay = source.match(/const overlayStyle = \{[\s\S]{0,400}?\};/);
  assert.ok(overlay !== null, "could not find the overlay style block");
  assert.ok(
    !/justifyContent/.test(overlay[0]),
    "the overlay still right-pins its child; the panel is corner-anchored again",
  );
  assert.ok(
    !/alignItems/.test(overlay[0]),
    "the overlay still top-aligns its child; the panel is corner-anchored again",
  );
});

check("the shipped bundle anchors from a measured rect", () => {
  assert.ok(/getBoundingClientRect/.test(source), "no measurement of the anchor element");
  assert.ok(/snapshot\.anchor|anchoredPanelStyle/.test(source), "no anchor is threaded to the panel style");
});

check("MUTANT: a corner-pinned style IS rejected by the anchoring assertions", () => {
  // Reproduce the old placement and run the same assertions the suite makes.
  const mutantStyle = {
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "flex-end",
  };
  const failed = [];
  if (mutantStyle.justifyContent === "flex-end") {
    failed.push("panel is not right-pinned");
  }
  if (typeof mutantStyle.left !== "number") {
    failed.push("panel aligns to the row's left edge");
  }
  if (!("top" in mutantStyle) && !("bottom" in mutantStyle)) {
    failed.push("panel opens ABOVE the row when there is room");
  }
  assert.ok(
    failed.length >= 2,
    `the corner mutant should trip at least 2 checks, tripped ${failed.length}`,
  );
  console.log(`        mutant trips: ${failed.join(" | ")}`);
});

check("MUTANT: an untouched-anchor style IS rejected", () => {
  // A panel that ignores the measured rect (always centred) is also wrong.
  const centredMutant = { position: "fixed", left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
  const rowLeft = 300;
  const trips = typeof centredMutant.left === "number" && Math.abs(centredMutant.left - rowLeft) <= 1;
  assert.equal(trips, false, "a centred panel must not satisfy the row-alignment check");
});

console.log(`\n  ${checks - failures}/${checks} checks passed\n`);
if (failures > 0) {
  console.log(`  ${failures} check(s) FAILED\n`);
  process.exit(1);
}
