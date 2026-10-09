/**
 * DOM-level test for the dock wrap.
 *
 * The first attempt marked `row.parentElement` and did nothing, because DSH's
 * slot machinery wraps each registered item: the parent is a WRAPPER, not the
 * dock. Asserting on the CSS text alone could not catch that, so this file
 * builds a fake DOM with the real nesting and runs the shipped finder.
 *
 * Run: node test/dock-wrap.test.mjs
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

/* ------------------------------------------------------------------ *
 * A minimal DOM: enough for querySelectorAll/getElementById/createElement.
 * ------------------------------------------------------------------ */

function makeElement(tag, computed = {}) {
  const el = {
    tagName: String(tag).toUpperCase(),
    parentElement: null,
    children: [],
    attributes: {},
    style: {},
    _computed: computed,
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return name in this.attributes ? this.attributes[name] : null;
    },
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    getBoundingClientRect() {
      return { top: 600, bottom: 628, left: 300, right: 700, width: 400, height: 28 };
    },
  };
  return el;
}

/** Attach a child to a parent (also used to set up ancestor chains). */
function append(parent, child) {
  parent.children.push(child);
  child.parentElement = parent;
  return child;
}

/* ------------------------------------------------------------------ *
 * Extract the shipped helpers and run them against the fake DOM.
 * ------------------------------------------------------------------ */

// Find the declarations inside the bundle so the test runs the real code.
function grab(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in the bundle`);
  let depth = 0;
  let i = source.indexOf("{", start);
  const from = i;
  for (; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${name} from ${from}`);
}

console.log("\ndock wrap — the real finder must pick the dock, not the wrapper\n");

const findDockRowSrc = grab("findDockRow");
const ensureSrc = grab("ensureDockWrap");
// The attribute/style-id constants are module-scope; re-declare the same values
// and confirm the bundle still declares them identically.
const attrMatch = source.match(/const DOCK_WRAP_ATTR = "([^"]+)";/);
const styleIdMatch = source.match(/const DOCK_STYLE_ID = "([^"]+)";/);
const cssMatch = source.match(/const DOCK_WRAP_CSS =\s*([\s\S]*?);\n/);
assert.ok(attrMatch !== null, "DOCK_WRAP_ATTR is not declared");
assert.ok(styleIdMatch !== null, "DOCK_STYLE_ID is not declared");

check("the bundle declares the attribute and style id the test uses", () => {
  assert.equal(attrMatch[1], "data-dsh-quota-dock-wrap");
  assert.equal(styleIdMatch[1], "dsh-quota-dock-style");
});

check("findDockRow skips the slot wrapper and returns the dock flex row", () => {
  // Real nesting: dock (flex row) > wrapper (block) > row.
  const body = makeElement("body", { display: "block" });
  const dock = makeElement("div", { display: "flex", flexDirection: "row" });
  const wrapper = makeElement("div", { display: "block" });
  const row = makeElement("button", { display: "flex", flexDirection: "row" });
  append(body, dock);
  append(dock, wrapper);
  append(wrapper, row);

  globalThis.getComputedStyle = (el) => el._computed ?? { display: "block" };
  const found = new Function(`${findDockRowSrc}; return findDockRow;`)()(row);
  assert.equal(found, dock, "the finder must return the dock, not the wrapper");
  assert.notEqual(found, wrapper, "returning the wrapper is the bug that shipped");
});

check("findDockRow refuses to mark body or html", () => {
  // Only a flex body above the row: the walk must stop and return null rather
  // than making the whole page wrap.
  const body = makeElement("body", { display: "flex", flexDirection: "row" });
  const row = makeElement("button", { display: "flex", flexDirection: "row" });
  append(body, row);

  globalThis.getComputedStyle = (el) => el._computed ?? { display: "block" };
  const found = new Function(`${findDockRowSrc}; return findDockRow;`)()(row);
  assert.equal(found, null, "a flex body must not be marked");
});

check("findDockRow ignores a COLUMN flex container", () => {
  // A column parent already stacks; forcing flex-basis on its child would set a
  // HEIGHT, not a width. It must keep walking.
  const body = makeElement("body", { display: "block" });
  const column = makeElement("div", { display: "flex", flexDirection: "column" });
  const dock = makeElement("div", { display: "flex", flexDirection: "row" });
  const row = makeElement("button", { display: "flex", flexDirection: "row" });
  append(body, column);
  append(column, dock);
  append(dock, row);

  globalThis.getComputedStyle = (el) => el._computed ?? { display: "block" };
  const found = new Function(`${findDockRowSrc}; return findDockRow;`)()(row);
  assert.equal(found, dock, "a column container must be skipped");
});

check("findDockRow stops walking after a bounded depth", () => {
  // A pathological chain of non-flex wrappers must not walk forever.
  const root = makeElement("div", { display: "block" });
  let node = root;
  for (let i = 0; i < 20; i += 1) {
    const next = makeElement("div", { display: "block" });
    append(node, next);
    node = next;
  }
  const row = append(node, makeElement("button", { display: "flex", flexDirection: "row" }));

  globalThis.getComputedStyle = (el) => el._computed ?? { display: "block" };
  const found = new Function(`${findDockRowSrc}; return findDockRow;`)()(row);
  assert.equal(found, null, "the walk must terminate");
});

check("ensureDockWrap marks the dock and injects the stylesheet once", () => {
  const head = makeElement("head");
  const body = makeElement("body", { display: "block" });
  const dock = makeElement("div", { display: "flex", flexDirection: "row" });
  const wrapper = makeElement("div", { display: "block" });
  const row = makeElement("button", { display: "flex", flexDirection: "row" });
  append(body, dock);
  append(dock, wrapper);
  append(wrapper, row);

  const byId = new Map();
  const injected = [];
  globalThis.document = {
    head,
    getElementById: (id) => byId.get(id) ?? null,
    querySelectorAll: (sel) => (sel.includes("row") ? [row] : []),
    createElement: (tag) => {
      const el = makeElement(tag);
      Object.defineProperty(el, "id", {
        get() {
          return this.attributes.id ?? "";
        },
        set(value) {
          this.attributes.id = value;
          byId.set(value, this);
        },
      });
      injected.push(el);
      return el;
    },
  };
  globalThis.getComputedStyle = (el) => el._computed ?? { display: "block" };

  const ensure = new Function(
    `const DOCK_WRAP_ATTR = ${JSON.stringify(attrMatch[1])};` +
      `const DOCK_STYLE_ID = ${JSON.stringify(styleIdMatch[1])};` +
      `const DOCK_WRAP_CSS = "x";` +
      `${findDockRowSrc}; ${ensureSrc}; return ensureDockWrap;`,
  )();

  ensure();
  assert.equal(dock.getAttribute(attrMatch[1]), "1", "the dock must be marked");
  assert.equal(wrapper.getAttribute(attrMatch[1]), null, "the wrapper must NOT be marked");
  assert.equal(injected.length, 1, "exactly one <style> element is injected");

  // Idempotent: a second call must not inject another stylesheet.
  ensure();
  assert.equal(injected.length, 1, "a second call must not inject again");
  assert.equal(dock.getAttribute(attrMatch[1]), "1");
});

check("ensureDockWrap tolerates a DOM-free context", () => {
  const previous = globalThis.document;
  delete globalThis.document;
  const ensure = new Function(
    `const DOCK_WRAP_ATTR = "a"; const DOCK_STYLE_ID = "b"; const DOCK_WRAP_CSS = "c";` +
      `${findDockRowSrc}; ${ensureSrc}; return ensureDockWrap;`,
  )();
  ensure(); // must not throw
  globalThis.document = previous;
});

console.log(`\n  ${checks - failures}/${checks} checks passed\n`);
if (failures > 0) {
  console.log(`  ${failures} check(s) FAILED\n`);
  process.exit(1);
}
