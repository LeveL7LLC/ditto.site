import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCloneRequestOptions, resolveCloneOptions } from "../src/options.js";

test("respectRobots defaults to true", () => {
  assert.equal(resolveCloneOptions({}).respectRobots, true);
  assert.equal(normalizeCloneRequestOptions({}).respectRobots, undefined);
});

test("respectRobots can be disabled per request", () => {
  const normalized = normalizeCloneRequestOptions({ respectRobots: false });
  assert.equal(normalized.respectRobots, false);
  assert.equal(resolveCloneOptions(normalized).respectRobots, false);
});
