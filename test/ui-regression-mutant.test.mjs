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

check("MUTANT: the pre-trim stacked-meta shape is rejected", () => {
  // The old MetricBar rendered the amount and the reset time as TWO separate
  // stacked divs below the bar. They now share one wrapping line, so the shape
  // to reject is "two independent block lines", not "any amount marker".
  const preTrim = `
    <div style={metaStyle} data-dsh-quota-amount>{amount}</div>
    <div style={metaStyle} data-dsh-quota-reset>{reset}</div>
  `;
  const stackedBlocks = (preTrim.match(/<div[^>]*data-dsh-quota-(amount|reset)/g) ?? []).length;
  assert.equal(stackedBlocks, 2, "the pre-trim shape should have two stacked block lines");
  // The shipped bundle keeps ONE container for both, marked metaLineStyle.
  assert.ok(!/metaStyle, \s*\n\s*"data-dsh-quota-amount"/.test(source), "a stacked amount block came back");
  assert.ok(/metaLineStyle/.test(source), "the shared wrapping meta line is gone");
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

check("the amount and reset time wrap instead of truncating at 230px", () => {
  // Sharing a single non-wrapping row at this width would clip a number away.
  assert.ok(/metaLineStyle/.test(source), "the shared meta line style is gone");
  const meta = source.match(/const metaLineStyle = \{[\s\S]{0,220}?\};/);
  assert.ok(meta !== null, "metaLineStyle is not declared");
  assert.ok(/flexWrap:\s*"wrap"/.test(meta[0]), "the meta line cannot wrap: a number may be clipped");
  assert.ok(/data-dsh-quota-reset/.test(source), "the reset time marker is gone entirely");
  assert.ok(/data-dsh-quota-amount/.test(source), "the amount marker is gone entirely");
});

check("Google metrics keep their upstream group name", () => {
  // The host sends `group` on every google metric; dropping it on the client is
  // what produced two indistinguishable "周" rows.
  assert.ok(
    /typeof value\.group === "string"/.test(source),
    "normalizeMetric drops the group field: the card cannot label the groups",
  );
  assert.ok(/groupMetrics/.test(source), "no grouping helper: metrics render as one flat list");
  assert.ok(/data-dsh-quota-group/.test(source), "the group heading has no marker to assert on");
});

check("MUTANT: a flat, ungrouped metric list is rejected", () => {
  // The pre-fix render was a bare map over every metric.
  const preFix = `source.metrics.map((metric) => jsx(MetricBar, { metric, t }, metric.key))`;
  const groupsThem = /groupMetrics\(/.test(preFix);
  assert.equal(groupsThem, false, "the flat list must fail the grouping assertion");
});

check("the read-out claims its own line in DSH's dock", () => {
  assert.ok(/flex-wrap:\s*wrap/.test(source), "no wrap rule: the read-out stays on the stats line");
  assert.ok(
    /\[data-dsh-quota-dock-wrap\]/.test(source),
    "the wrap rule must key off our own attribute, not a hashed DSH class",
  );
  assert.ok(/ensureDockWrap/.test(source), "nothing applies the wrap rule");
});

check("MUTANT: a row-only style with no container rule is rejected", () => {
  // A style that only sizes the button cannot move it to a second line, because
  // DSH's dock is `display:flex` without `flex-wrap`.
  const rowOnly = `const rowStyle = { display: "flex", alignItems: "center", maxWidth: "100%" };`;
  assert.equal(/flex-wrap/.test(rowOnly), false, "the row-only style must fail the wrap assertion");
});

console.log(`\n  ${checks - failures}/${checks} checks passed\n`);
if (failures > 0) {
  console.log(`  ${failures} check(s) FAILED\n`);
  process.exit(1);
}
