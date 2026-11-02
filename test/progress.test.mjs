import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildNextRecommendation,
  buildProgressReport,
  buildReviewPlan,
  listDueReviews,
  loadLearningState,
  recordCheckpointAssessment,
  saveLearningState,
} from "../src/progress.mjs";
import { assessCheckpoint, composeCheckpoint } from "../src/checkpoints.mjs";

test("persists and restores a learning session", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-progress-"));
  await saveLearningState(root, {
    sessionId: "ja4-basics",
    topic: "JA4",
    goal: "Understand JA4 fingerprints",
    phase: "build",
    route: ["TLS ClientHello", "JA4 components"],
    secured: ["TLS ClientHello"],
    gaps: [],
    currentStep: "TLS ClientHello",
    nextStep: "Explain JA4 components",
  });

  const restored = await loadLearningState(root, { sessionId: "ja4-basics" });
  assert.equal(restored.state.nextStep, "Explain JA4 components");
  assert.deepEqual(restored.state.secured, ["TLS ClientHello"]);
  const diskState = JSON.parse(await readFile(join(root, ".concept-loom/sessions/ja4-basics.json"), "utf8"));
  assert.equal(diskState.revision, 1);
});

test("returns the latest state and session summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-progress-"));
  await saveLearningState(root, {
    sessionId: "first",
    topic: "First",
    goal: "Learn first",
    phase: "locate",
    nextStep: "Probe",
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
  await saveLearningState(root, {
    sessionId: "second",
    topic: "Second",
    goal: "Learn second",
    phase: "weave",
    nextStep: "Approve route",
  });

  const restored = await loadLearningState(root);
  assert.equal(restored.state.sessionId, "second");
  assert.equal(restored.sessions.length, 2);
});

test("updates a session atomically and increments its revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-progress-"));
  const base = {
    sessionId: "topic",
    topic: "Topic",
    goal: "Learn topic",
    phase: "build",
    nextStep: "Step one",
  };
  await saveLearningState(root, base);
  const updated = await saveLearningState(root, { ...base, secured: ["Step one"], nextStep: "Step two" });
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.secured, ["Step one"]);
});

test("records checkpoint outcome before the lesson continues", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-progress-"));
  await saveLearningState(root, {
    sessionId: "ja4",
    topic: "JA4",
    goal: "Understand JA4",
    phase: "build",
    route: ["TLS", "JA4"],
    nextStep: "Check TLS understanding",
  });

  const updated = await recordCheckpointAssessment(root, {
    sessionId: "ja4",
    currentStep: "TLS",
    nextStep: "Explain JA4 fields",
    securedConnection: "TLS ClientHello structure",
  }, {
    outcome: "accurate",
    selected: ["client-hello"],
  });

  assert.equal(updated.nextStep, "Explain JA4 fields");
  assert.deepEqual(updated.secured, ["TLS ClientHello structure"]);
  assert.equal(updated.lastCheckpoint.outcome, "accurate");
  assert.equal(updated.evidence["TLS ClientHello structure"].dimensions.recognition, "demonstrated");
  assert.equal(updated.evidence["TLS ClientHello structure"].attempts, 1);
  assert.equal(updated.revision, 2);
});

test("tracks transfer evidence, confidence, hints, and delayed review", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-progress-"));
  await saveLearningState(root, {
    sessionId: "transactions",
    topic: "Transactions",
    goal: "Choose isolation levels",
    phase: "build",
    mode: "practice",
    route: ["Atomicity", "Isolation"],
    routeExtensions: [{ concept: "Write skew", dependsOn: ["Isolation"], reason: "Found during practice" }],
    nextStep: "Try a transfer problem",
  });

  const updated = await recordCheckpointAssessment(root, {
    sessionId: "transactions",
    currentStep: "Isolation",
    nextStep: "Review tomorrow",
    evidenceConcept: "Isolation trade-offs",
    hintUsed: false,
  }, {
    format: "transfer",
    outcome: "accurate",
    response: "Use serializable because the invariant spans rows.",
    confidence: 85,
    calibration: "well-calibrated",
  });

  const evidence = updated.evidence["Isolation trade-offs"];
  assert.equal(updated.mode, "practice");
  assert.equal(updated.routeExtensions[0].concept, "Write skew");
  assert.equal(evidence.dimensions.transfer, "demonstrated");
  assert.equal(evidence.transferPassed, true);
  assert.equal(evidence.lastConfidence, 85);
  assert.match(evidence.reviewAfter, /^\d{4}-\d{2}-\d{2}T/);

  const reviews = await listDueReviews(root, { now: "2100-01-01T00:00:00.000Z" });
  assert.equal(reviews.due.length, 1);
  assert.equal(reviews.due[0].concept, "Isolation trade-offs");
});

test("infers due reviews for legacy evidence without reviewAfter", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-progress-"));
  await saveLearningState(root, {
    sessionId: "legacy",
    topic: "Legacy",
    goal: "Review old evidence",
    phase: "review",
    nextStep: "Review legacy concepts",
  });

  const path = join(root, ".concept-loom/sessions/legacy.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.updatedAt = "2026-01-01T00:00:00.000Z";
  state.evidence = {
    "old-concept": { attempts: 1, consecutiveSuccesses: 1, lastOutcome: "accurate" },
  };
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const reviews = await listDueReviews(root, { now: "2026-01-03T00:00:00.000Z" });
  assert.equal(reviews.due.length, 1);
  assert.equal(reviews.due[0].concept, "old-concept");
  assert.equal(reviews.due[0].inferred, true);
});

test("raises mastery from recognition to transfer", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-progress-"));
  await saveLearningState(root, {
    sessionId: "mastery",
    topic: "Mastery",
    goal: "Climb the mastery ladder",
    phase: "build",
    nextStep: "Start",
  });

  const choice = composeCheckpoint({
    prompt: "Pick one",
    choices: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
    expected: "a",
    rationale: "A is expected.",
  });
  let state = await recordCheckpointAssessment(root, {
    sessionId: "mastery",
    currentStep: "concept",
    nextStep: "Recall it",
    securedConnection: "concept",
    evidenceConcept: "concept",
  }, assessCheckpoint({ token: choice.token, selected: "a" }));
  assert.equal(state.evidence.concept.masteryLevel, "recognized");

  const recall = composeCheckpoint({
    format: "free-recall",
    prompt: "Explain it",
    criteria: ["Names the mechanism"],
    rationale: "The mechanism is the answer.",
  });
  state = await recordCheckpointAssessment(root, {
    sessionId: "mastery",
    currentStep: "concept",
    nextStep: "Apply it",
    securedConnection: "concept",
    evidenceConcept: "concept",
  }, assessCheckpoint({ token: recall.token, response: "The mechanism follows.", verdict: "accurate" }));
  assert.equal(state.evidence.concept.masteryLevel, "recalled");

  const application = composeCheckpoint({
    format: "prediction",
    prompt: "Predict the outcome",
    criteria: ["States the consequence"],
    rationale: "The consequence follows from the mechanism.",
  });
  state = await recordCheckpointAssessment(root, {
    sessionId: "mastery",
    currentStep: "concept",
    nextStep: "Transfer it",
    securedConnection: "concept",
    evidenceConcept: "concept",
  }, assessCheckpoint({ token: application.token, response: "It will fail.", verdict: "accurate" }));
  assert.equal(state.evidence.concept.masteryLevel, "applied");

  const transfer = composeCheckpoint({
    format: "transfer",
    prompt: "Use it in a new case",
    criteria: ["Keeps the underlying dependency"],
    rationale: "The same dependency governs the new case.",
  });
  state = await recordCheckpointAssessment(root, {
    sessionId: "mastery",
    currentStep: "concept",
    nextStep: "Next",
    securedConnection: "concept",
    evidenceConcept: "concept",
  }, assessCheckpoint({ token: transfer.token, response: "The same dependency applies.", verdict: "accurate" }));
  assert.equal(state.evidence.concept.masteryLevel, "transferred");
});

test("records error taxonomy, misconceptions, hints, latency, and source references", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-progress-"));
  await saveLearningState(root, {
    sessionId: "errors",
    topic: "Errors",
    goal: "Repair a misconception",
    phase: "build",
    nextStep: "Start",
  });

  const first = composeCheckpoint({
    format: "free-recall",
    prompt: "Explain it",
    criteria: ["Names the mechanism"],
    rationale: "The mechanism is the answer.",
    sourceRef: "book p. 42",
  });
  let state = await recordCheckpointAssessment(root, {
    sessionId: "errors",
    currentStep: "concept",
    nextStep: "Repair it",
    securedConnection: "concept",
    evidenceConcept: "concept",
    errorKind: "misconception",
    misconception: "Confuses the mechanism with its side effect.",
    misconceptionCorrection: "The mechanism is independent of the side effect.",
    hintLevel: 2,
    latencyMs: 5000,
  }, assessCheckpoint({ token: first.token, response: "The side effect is the mechanism.", verdict: "needs-repair", confidence: 90 }));

  assert.equal(state.evidence.concept.lastErrorKind, "misconception");
  assert.equal(state.evidence.concept.errorCounts.misconception, 1);
  assert.equal(state.evidence.concept.lastHintLevel, 2);
  assert.equal(state.evidence.concept.hintUsed, true);
  assert.equal(state.evidence.concept.lastLatencyMs, 5000);
  assert.equal(state.evidence.concept.lastSourceRef, "book p. 42");
  assert.equal(state.misconceptions.length, 1);
  assert.equal(state.misconceptions[0].repaired, false);

  const repair = composeCheckpoint({
    format: "free-recall",
    prompt: "Explain it again",
    criteria: ["Names the mechanism"],
    rationale: "The mechanism is the answer.",
  });
  state = await recordCheckpointAssessment(root, {
    sessionId: "errors",
    currentStep: "concept",
    nextStep: "Next",
    securedConnection: "concept",
    evidenceConcept: "concept",
    misconceptionRepaired: true,
  }, assessCheckpoint({ token: repair.token, response: "The mechanism is independent.", verdict: "accurate" }));
  assert.equal(state.misconceptions[0].repaired, true);
});

test("recommends the next evidence step from mastery", () => {
  const choice = buildNextRecommendation(
    { masteryLevel: "recognized", dimensions: { recognition: "demonstrated" } },
    { outcome: "accurate" },
  );
  assert.equal(choice.closure, "provisional");
  assert.equal(choice.recommendedNext, "free-recall");

  const applied = buildNextRecommendation(
    { masteryLevel: "applied", dimensions: { recall: "demonstrated", application: "demonstrated" } },
    { outcome: "accurate" },
  );
  assert.equal(applied.recommendedNext, "transfer");

  const transferred = buildNextRecommendation(
    { masteryLevel: "transferred", transferPassed: true },
    { outcome: "accurate" },
  );
  assert.equal(transferred.closure, "mastered");
  assert.equal(transferred.recommendedNext, "review-later");

  const misconception = buildNextRecommendation(
    { masteryLevel: "recognized", lastErrorKind: "misconception" },
    { outcome: "needs-repair" },
  );
  assert.equal(misconception.closure, "open");
  assert.equal(misconception.recommendedNext, "contrast-and-retest");
});

test("builds an interleaved review plan and a progress report", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-progress-"));
  await saveLearningState(root, {
    sessionId: "alpha",
    topic: "Alpha",
    goal: "Learn alpha",
    phase: "review",
    nextStep: "Review alpha",
  });
  const alpha = composeCheckpoint({
    prompt: "Pick one",
    choices: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
    expected: "a",
    rationale: "A is expected.",
  });
  await recordCheckpointAssessment(root, {
    sessionId: "alpha",
    currentStep: "alpha-concept",
    nextStep: "Review alpha",
    securedConnection: "alpha-concept",
    evidenceConcept: "alpha-concept",
  }, assessCheckpoint({ token: alpha.token, selected: "a" }));

  await saveLearningState(root, {
    sessionId: "beta",
    topic: "Beta",
    goal: "Learn beta",
    phase: "review",
    nextStep: "Review beta",
  });
  const beta = composeCheckpoint({
    format: "free-recall",
    prompt: "Explain beta",
    criteria: ["Names the mechanism"],
    rationale: "The mechanism is the answer.",
  });
  await recordCheckpointAssessment(root, {
    sessionId: "beta",
    currentStep: "beta-concept",
    nextStep: "Review beta",
    securedConnection: "beta-concept",
    evidenceConcept: "beta-concept",
  }, assessCheckpoint({ token: beta.token, response: "The mechanism follows.", verdict: "accurate" }));

  const plan = await buildReviewPlan(root, { limit: 2, now: "2100-01-01T00:00:00.000Z" });
  assert.equal(plan.plan.length, 2);
  assert.deepEqual(new Set(plan.plan.map((item) => item.topic)), new Set(["Alpha", "Beta"]));
  assert.equal(plan.plan.find((item) => item.topic === "Alpha").suggestedFormat, "free-recall");
  assert.equal(plan.plan.find((item) => item.topic === "Beta").suggestedFormat, "prediction");

  const alphaPlan = await buildReviewPlan(root, {
    sessionId: "alpha",
    minutes: 10,
    now: "2100-01-01T00:00:00.000Z",
  });
  assert.equal(alphaPlan.sessionId, "alpha");
  assert.equal(alphaPlan.plan.length, 1);
  assert.ok(alphaPlan.estimatedMinutes > 0);

  const budgetPlan = await buildReviewPlan(root, { minutes: 5, now: "2100-01-01T00:00:00.000Z" });
  assert.ok(budgetPlan.estimatedMinutes <= 5);

  const report = await buildProgressReport(root, { sessionId: "alpha", now: "2100-01-01T00:00:00.000Z" });
  assert.equal(report.sessionId, "alpha");
  assert.equal(report.mastery.recognized, 1);
  assert.equal(report.dueCount, 1);
  assert.match(report.markdown, /Progress: Alpha/);
});
