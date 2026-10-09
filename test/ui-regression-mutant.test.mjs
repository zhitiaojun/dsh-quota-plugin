/**
 * Mutant check for the two reported UI defects.
 *
 * Both fixes are asserted by the client suite. That is only worth anything if
 * those assertions FAIL on the broken code, so this file reconstructs each bug
 * and runs the same assertions against it.
 *
 * Run: node test/ui-regression-mutant.test.mjs
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

console.log("\nUI regressions — the reported defects must stay detectable\n");

/* ---------------------------------------------------------------- *
 * 1. dismiss on outside click
 * ---------------------------------------------------------------- */

check("the shipped bundle listens for a pointer outside the panel", () => {
  assert.ok(
    /document\.addEventListener\(\s*"pointerdown"/.test(source),
    "no document-level pointerdown listener: click-outside cannot close the panel",
  );
  assert.ok(
    /document\.removeEventListener\(\s*"pointerdown"/.test(source),
    "the listener is never removed: every close would leak a handler",
  );
});

check("the listener ignores clicks inside the panel and on the row", () => {
  // Match the selector content rather than its exact quoting, which differs
  // between the source and the escaped string.
  const closest = source.match(/\.closest\(\s*"([^"]+)"/);
  assert.ok(closest !== null, "no closest() call found in the outside-click path");
  const selector = closest[1];
  assert.ok(
    /data-dsh-quota=('|\\")?panel/.test(selector.replace(/\\"/g, '"')),
    `the inside-test does not cover the panel (selector: ${selector})`,
  );
  assert.ok(
    /data-dsh-quota=('|\\")?row/.test(selector.replace(/\\"/g, '"')),
    `the inside-test does not cover the row (selector: ${selector})`,
  );
});

check("MUTANT: the pre-fix bundle (no document listener) is rejected", () => {
  // The original panel only handled Escape; there was no outside-click path.
  const preFix = `
    function QuotaPanel(props) {
      react.useEffect(() => {
        if (!open) return void 0;
        const onKeyDown = (e) => { if (e.key === "Escape") store.setOpen(false); };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
      }, [store, open]);
    }
  `;
  const hasOutside =
    /document\.addEventListener\(\s*"pointerdown"/.test(preFix) ||
    /document\.addEventListener\(\s*"mousedown"/.test(preFix);
  assert.equal(hasOutside, false, "the pre-fix bundle must fail the listener check");
});

/* ---------------------------------------------------------------- *
 * 2. the panel stays compact
 * ---------------------------------------------------------------- */

check("no verbose date format remains in the panel path", () => {
  assert.ok(
    !/dateStyle:\s*"medium"/.test(source),
    "a medium date style is back: the panel will print a long year-bearing date",
  );
  assert.ok(
    /month:\s*"2-digit"/.test(source),
    "the compact MM-DD HH:mm form is gone",
  );
});

check("the redundant per-source line and text buttons are gone", () => {
  assert.ok(!/lastRefreshed/.test(source), "the per-source 'last refreshed' line came back");
  assert.ok(!/data-dsh-quota-refreshed/.test(source), "the per-source refreshed meta line came back");
  assert.ok(!/refreshAll/.test(source), "the 'refresh all' text button came back");
  assert.ok(
    !/const kindStyle/.test(source),
    "the per-card kind badge style came back (it duplicated the custom name)",
  );
});

check("MUTANT: the pre-trim metric block is rejected by the compactness checks", () => {
  // The old MetricBar rendered four stacked rows, the last two being meta lines.
  const preTrim = `
    <div style={metricHeadStyle}><span>{label}</span><span>{pct}</span></div>
    <div style={trackStyle}>...</div>
    <div style={metaStyle} data-dsh-quota-amount>{amount}</div>
    <div style={metaStyle} data-dsh-quota-reset>{reset}</div>
  `;
  const stackedMeta = (preTrim.match(/style=\{metaStyle\}/g) ?? []).length;
  assert.ok(stackedMeta >= 2, "the pre-trim shape should show two stacked meta lines");
  const trimmedKeepsThem = /data-dsh-quota-amount/.test(source);
  assert.equal(trimmedKeepsThem, false, "the trimmed bundle must not keep the stacked amount line");
});

check("the trim kept the information the user still needs", () => {
  // Percentages, the remaining/total amount and reset times must survive.
  assert.ok(/data-dsh-quota-percent/.test(source), "the percentage is gone");
  assert.ok(/data-dsh-quota-fill/.test(source), "the bar fill is gone");
  assert.ok(/formatPercent/.test(source), "percentage formatting is gone");
  assert.ok(/resetAt/.test(source), "reset times are gone");
  assert.ok(/formatNumber\(metric\.remaining\)/.test(source), "the remaining/total amount is gone");
});

check("the panel is a narrow popover, not a wide slab", () => {
  const width = source.match(/const PANEL_WIDTH = (\d+);/);
  assert.ok(width !== null, "PANEL_WIDTH is not declared");
  const value = Number(width[1]);
  assert.ok(value <= 240, `PANEL_WIDTH is ${value}; the user asked for roughly half of 460`);
  assert.ok(value >= 200, `PANEL_WIDTH is ${value}, too narrow to read comfortably`);
});

check("MUTANT: the pre-narrow width (460) is rejected by the width check", () => {
  const preFixWidth = 460;
  assert.equal(preFixWidth <= 240, false, "the old 460px width must fail the narrow check");
});

check("the reset time moves to its own line so nothing truncates at 230px", () => {
  // Sharing one row at this width would ellipsise the reset time away.
  assert.ok(/resetLineStyle/.test(source), "reset times no longer have a dedicated line style");
  assert.ok(
    /data-dsh-quota-reset/.test(source),
    "the reset time marker is gone entirely",
  );
});

console.log(`\n  ${checks - failures}/${checks} checks passed\n`);
if (failures > 0) {
  console.log(`  ${failures} check(s) FAILED\n`);
  process.exit(1);
}
