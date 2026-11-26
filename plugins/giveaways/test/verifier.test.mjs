import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verify } from "./verify.mjs";
for (const vector of JSON.parse(
  readFileSync(new URL("vectors/gw-draw-v1.json", import.meta.url), "utf8"),
))
  test("node:crypto reference verifier at winner index " + vector.previous.length, () =>
    assert.deepEqual(verify(vector), vector.expected),
  );
