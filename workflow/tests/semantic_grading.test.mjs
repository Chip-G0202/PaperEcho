import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveSemanticGradeFromStandards, synthesizeFinalGrade } from "../tools/stage1/semantic_grade_synthesis.mjs";

const FOCUS = {
  core_exposure_terms: ["example exposure", "example topic term 033", "example topic term 006"],
  core_biology_terms: ["example biological context", "example topic term 011", "example topic term 018", "example topic term 020"],
  mechanism_terms: ["mechanism", "example topic term 040", "example topic term 038", "example topic term 021"],
};

describe("deriveSemanticGradeFromStandards", () => {
  it("no core term hits: keeps C, does not auto-downgrade", () => {
    const r = deriveSemanticGradeFromStandards({
      item: { title: "A study on general biology", abstract: "" },
      ruleGrade: "C",
      researchFocus: FOCUS,
    });
    assert.equal(r.semanticGrade, "C");
    assert.ok(r.semanticReason.includes("保持"));
    assert.equal(r.semanticSource, "standards");
  });

  it("upgrades C to B when strong biology + mechanism match", () => {
    const r = deriveSemanticGradeFromStandards({
      item: { title: "Synthetic example topic term 011 example topic term 018 mechanism evidence with Unicode 标题", abstract: "" },
      ruleGrade: "C",
      researchFocus: FOCUS,
    });
    assert.equal(r.semanticGrade, "B");
    assert.ok(r.semanticReason.includes("命中") || r.semanticReason.includes("命中"));
  });

  it("uses abstract text together with title for standards matching", () => {
    const r = deriveSemanticGradeFromStandards({
      item: { title: "General example study", abstract: "exampleCellType example topic term 011 example topic term 018 mechanism in synthetic context" },
      ruleGrade: "C",
      researchFocus: FOCUS,
    });
    assert.equal(r.semanticGrade, "B");
  });

  it("uses summary text when abstract is absent", () => {
    const r = deriveSemanticGradeFromStandards({
      item: { title: "General example study", summary: "exampleCellType example topic term 011 example topic term 018 mechanism in synthetic context" },
      ruleGrade: "C",
      researchFocus: FOCUS,
    });
    assert.equal(r.semanticGrade, "B");
  });

  it("upgrades B to A when exposure + strong biology match", () => {
    const r = deriveSemanticGradeFromStandards({
      item: { title: "example exposure example topic term 033 example topic term 018 in example topic term 035 example topic term 011", abstract: "" },
      ruleGrade: "B",
      researchFocus: FOCUS,
    });
    assert.equal(r.semanticGrade, "A");
    assert.equal(r.semanticSource, "standards");
  });

  it("keeps ruleGrade when no core term hits (no auto-downgrade)", () => {
    const r = deriveSemanticGradeFromStandards({
      item: { title: "Synthetic unrelated outcome fixture", abstract: "" },
      ruleGrade: "B",
      researchFocus: FOCUS,
    });
    assert.equal(r.semanticGrade, "B");
    assert.ok(r.semanticReason.includes("保持"));
  });

  it("keeps C when no core term hits (no auto-downgrade to D)", () => {
    const r = deriveSemanticGradeFromStandards({
      item: { title: "Engineering materials study", abstract: "" },
      ruleGrade: "C",
      researchFocus: FOCUS,
    });
    assert.equal(r.semanticGrade, "C");
    assert.ok(r.semanticReason.includes("保持"));
  });

  it("uses auxiliary evidence when supplied", () => {
    const r = deriveSemanticGradeFromStandards({
      item: { title: "A study on biology", abstract: "" },
      ruleGrade: "C",
      searchResults: [
        { title: "exampleCellType example topic term 011 in synthetic context", score: 0.8 },
        { title: "exampleToxicity example topic term 040 mechanism", score: 0.7 },
      ],
      researchFocus: FOCUS,
    });
    assert.equal(r.semanticSource, "standards_with_auxiliary_evidence");
    assert.ok(r.semanticConfidence > 0);
  });

  it("does not depend on feedback signals", () => {
    const r = deriveSemanticGradeFromStandards({
      item: { title: "exampleCellType example topic term 011 example biological context example topic term 018", abstract: "" },
      ruleGrade: "C",
      searchResults: [],
      researchFocus: FOCUS,
    });
    assert.ok(r.semanticGrade);
    assert.ok(!r.semanticReason.includes("反馈"));
    assert.ok(!r.semanticReason.includes("feedback"));
  });

  it("never returns empty semanticGrade when title exists", () => {
    for (const grade of ["A", "B", "C", "D"]) {
      const r = deriveSemanticGradeFromStandards({
        item: { title: "Some title", abstract: "" },
        ruleGrade: grade,
        researchFocus: FOCUS,
      });
      assert.ok(r.semanticGrade, `semanticGrade should not be empty for ruleGrade=${grade}`);
    }
  });
});


  it("no signal + missing abstract: keeps ruleGrade, no downgrade", () => {
    const r = deriveSemanticGradeFromStandards({
      item: { title: "Short title", abstract: "" },
      ruleGrade: "C",
      researchFocus: FOCUS,
    });
    assert.equal(r.semanticGrade, "C");
    assert.ok(r.semanticConfidence >= 0);
  });

  it("no signal + no search: keeps ruleGrade with low confidence", () => {
    const r = deriveSemanticGradeFromStandards({
      item: { title: "Random unrelated title", abstract: "" },
      ruleGrade: "B",
      searchResults: [],
      researchFocus: FOCUS,
    });
    assert.equal(r.semanticGrade, "B");
    assert.ok(r.semanticReason.includes("保持"));
  });

  it("feedback signals do not affect semantic_grade", () => {
    const r = deriveSemanticGradeFromStandards({
      item: { title: "exampleCellType example topic term 011 example biological context", abstract: "" },
      ruleGrade: "C",
      researchFocus: FOCUS,
    });
    assert.ok(r.semanticGrade);
    assert.ok(!r.semanticReason.includes("feedback"));
    assert.ok(!r.semanticReason.includes("反馈"));
    assert.ok(!r.semanticReason.includes("keep"));
    assert.ok(!r.semanticReason.includes("drop"));
  });
describe("synthesizeFinalGrade with standards-based semantic_grade", () => {
  it("C->D semantic grade triggers needs_human_review, final_grade stays C", () => {
    const r = synthesizeFinalGrade({
      ruleGrade: "C",
      semanticGrade: "D",
      semanticReason: "no core terms",
      flags: {},
    });
    assert.equal(r.finalGrade, "C");
    assert.equal(r.needsHumanReview, true);
  });

  it("B->A semantic grade auto-upgrades", () => {
    const r = synthesizeFinalGrade({
      ruleGrade: "B",
      semanticGrade: "A",
      semanticReason: "strong match",
      flags: {},
    });
    assert.equal(r.finalGrade, "A");
    assert.equal(r.needsHumanReview, false);
  });

  it("C->B semantic grade auto-upgrades", () => {
    const r = synthesizeFinalGrade({
      ruleGrade: "C",
      semanticGrade: "B",
      semanticReason: "medium match",
      flags: {},
    });
    assert.equal(r.finalGrade, "B");
    assert.equal(r.needsHumanReview, false);
  });

  it("B->C semantic grade auto-downgrades", () => {
    const r = synthesizeFinalGrade({
      ruleGrade: "B",
      semanticGrade: "C",
      semanticReason: "no core terms",
      flags: {},
    });
    assert.equal(r.finalGrade, "C");
    assert.equal(r.needsHumanReview, false);
  });

  it("isolated empty semanticGrade keeps ruleGrade as evidence and requires manual review", () => {
    const r = synthesizeFinalGrade({
      ruleGrade: "B",
      semanticGrade: "",
      semanticReason: "",
      flags: {},
    });
    assert.equal(r.finalGrade, "B");
    assert.equal(r.needsHumanReview, true);
  });
});
