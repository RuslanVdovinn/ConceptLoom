import test from "node:test";
import assert from "node:assert/strict";
import { composeCheckpoint, assessCheckpoint, resetCheckpointsForTests } from "../src/checkpoints.mjs";

test.beforeEach(() => resetCheckpointsForTests());

test("frames a checkpoint without leaking its key or rationale", () => {
  const card = composeCheckpoint({
    prompt: "Which shape has three sides?",
    choices: [{ key: "triangle", label: "Triangle" }, { key: "square", label: "Square" }],
    expected: "triangle",
    rationale: "A triangle is defined by its three sides.",
  }, () => 0.5);
  assert.equal(card.choices.length, 2);
  assert.equal("expected" in card, false);
  assert.equal("rationale" in card, false);
});

test("grades an exact multi-selection", () => {
  const card = composeCheckpoint({
    prompt: "Pick primes",
    choices: [{ key: "2", label: "2" }, { key: "3", label: "3" }, { key: "4", label: "4" }],
    expected: ["2", "3"],
    rationale: "Two and three have exactly two positive divisors.",
    multiple: true,
    mix: false,
  });
  const result = assessCheckpoint({ token: card.token, selected: ["3", "2"] });
  assert.equal(result.outcome, "accurate");
});

test("treats an admitted gap separately from a wrong guess", () => {
  const card = composeCheckpoint({
    prompt: "Pick one",
    choices: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
    expected: "a",
    rationale: "A is expected.",
  });
  const result = assessCheckpoint({ token: card.token, selected: "__gap__" });
  assert.equal(result.outcome, "knowledge-gap");
  assert.equal(result.accurate, false);
});

test("checkpoint tokens can only be assessed once", () => {
  const card = composeCheckpoint({
    prompt: "Pick one",
    choices: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
    expected: "a",
    rationale: "A is expected.",
  });
  assessCheckpoint({ token: card.token, selected: "a" });
  assert.throws(() => assessCheckpoint({ token: card.token, selected: "a" }), /unknown or expired/);
});

test("frames and assesses an open transfer checkpoint without leaking criteria", () => {
  const card = composeCheckpoint({
    format: "transfer",
    prompt: "Apply the principle to a new case.",
    criteria: ["Names the relevant constraint", "Justifies the decision"],
    rationale: "Both the constraint and its consequence are needed.",
  });
  assert.equal(card.format, "transfer");
  assert.equal("criteria" in card, false);
  assert.equal("rationale" in card, false);

  const result = assessCheckpoint({
    token: card.token,
    response: "The new case is limited by the same constraint, so the decision follows.",
    verdict: "accurate",
    confidence: 82,
  });
  assert.equal(result.outcome, "accurate");
  assert.equal(result.calibration, "well-calibrated");
  assert.equal(result.criteria.length, 2);
});

test("warns about weak choice and open-response quality", () => {
  const choice = composeCheckpoint({
    prompt: "Which option is NOT correct?",
    choices: [
      { key: "a", label: "All of the above" },
      { key: "b", label: "B" },
      { key: "c", label: "C" },
    ],
    expected: "b",
    rationale: "B is the exception.",
    mix: false,
  });
  assert.ok(choice.qualityWarnings.some((warning) => /meta-options/.test(warning)));
  assert.ok(choice.qualityWarnings.some((warning) => /Negative wording/.test(warning)));

  const open = composeCheckpoint({
    format: "free-recall",
    prompt: "Explain the mechanism.",
    criteria: ["Understand it"],
    rationale: "The mechanism matters.",
  });
  assert.ok(open.qualityWarnings.some((warning) => /vague/.test(warning)));
});

test("carries a source reference through frame and assessment", () => {
  const card = composeCheckpoint({
    prompt: "Pick one",
    choices: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
    expected: "a",
    rationale: "A is expected.",
    sourceRef: "book p. 42",
  });
  assert.equal(card.sourceRef, "book p. 42");
  const result = assessCheckpoint({ token: card.token, selected: "a" });
  assert.equal(result.sourceRef, "book p. 42");
});

test("detects confident incorrect answers and validates confidence", () => {
  const first = composeCheckpoint({
    prompt: "Pick one",
    choices: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
    expected: "a",
    rationale: "A is expected.",
  });
  const result = assessCheckpoint({ token: first.token, selected: "b", confidence: 90 });
  assert.equal(result.calibration, "overconfident");

  const second = composeCheckpoint({
    prompt: "Pick one",
    choices: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
    expected: "a",
    rationale: "A is expected.",
  });
  assert.throws(() => assessCheckpoint({ token: second.token, selected: "a", confidence: 101 }), /0 to 100/);
});
