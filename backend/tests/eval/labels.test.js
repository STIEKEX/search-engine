import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLabels } from "../../eval/labels.js";

const W = "https://w.test/wiki/";

test("a label follows its page to the page's current URL", () => {
  const out = resolveLabels(new Map([[`${W}Vault`, 2]]), new Map([[`${W}Vault`, `${W}Vault_(architecture)`]]));
  assert.deepEqual([...out], [[`${W}Vault_(architecture)`, 2]]);
});

test("URLs not in the map keep their label unchanged", () => {
  const out = resolveLabels(new Map([[`${W}Castle`, 1]]), new Map());
  assert.deepEqual([...out], [[`${W}Castle`, 1]]);
});

test("aliases of one page merge: the page's own label wins, in any order", () => {
  const pageUrlOf = new Map([[`${W}Perpendicular`, `${W}English_Gothic`], [`${W}Early_English`, `${W}English_Gothic`]]);
  const a = resolveLabels(new Map([[`${W}Perpendicular`, 2], [`${W}English_Gothic`, 1], [`${W}Early_English`, 2]]), pageUrlOf);
  const b = resolveLabels(new Map([[`${W}English_Gothic`, 1], [`${W}Perpendicular`, 2]]), pageUrlOf);
  assert.deepEqual([...a], [[`${W}English_Gothic`, 1]]);
  assert.deepEqual([...b], [[`${W}English_Gothic`, 1]]);
});

test("aliases without a label for the page itself: the highest label", () => {
  const pageUrlOf = new Map([[`${W}A1`, `${W}A`], [`${W}A2`, `${W}A`]]);
  assert.deepEqual([...resolveLabels(new Map([[`${W}A1`, 0], [`${W}A2`, 2]]), pageUrlOf)], [[`${W}A`, 2]]);
});

test("merging shrinks the ideal ranking too: one page is counted once", () => {
  const pageUrlOf = new Map([[`${W}MLK`, `${W}Martin_Luther_King_Jr.`]]);
  const out = resolveLabels(new Map([[`${W}MLK`, 2], [`${W}Martin_Luther_King_Jr.`, 2]]), pageUrlOf);
  assert.equal(out.size, 1);
});
