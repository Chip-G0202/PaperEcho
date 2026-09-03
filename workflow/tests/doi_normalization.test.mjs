import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeDoi } from "../tools/lib/doi_normalization.mjs";

describe("normalizeDoi", () => {
  it("normalizes DOI prefixes and URL forms", () => {
    assert.equal(normalizeDoi("doi:10.0000/example.001BC"), "10.0000/example.001bc");
    assert.equal(normalizeDoi("https://doi.org/10.0000/example.001BC"), "10.0000/example.001bc");
    assert.equal(normalizeDoi("http://dx.doi.org/10.0000/example.001BC"), "10.0000/example.001bc");
  });

  it("normalizes whitespace and case", () => {
    assert.equal(normalizeDoi("  DOI: 10.0000/example.055  "), "10.0000/example.055");
  });

  it("returns empty string for missing or non-DOI values", () => {
    assert.equal(normalizeDoi(null), "");
    assert.equal(normalizeDoi(undefined), "");
    assert.equal(normalizeDoi(""), "");
    assert.equal(normalizeDoi("not a doi 10.0000/example.005"), "");
    assert.equal(normalizeDoi("https://example.com/10.0000/example.005"), "");
  });
});
