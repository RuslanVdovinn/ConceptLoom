import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const PHASES = new Set(["locate", "weave", "build", "transfer", "review", "complete"]);
const MODES = new Set(["guided", "practice", "review", "challenge"]);
const CHECKPOINT_DIMENSIONS = {
  choice: "recognition",
  "free-recall": "recall",
  prediction: "application",
  debugging: "application",
  transfer: "transfer",
};
const ERROR_KINDS = new Set(["slip", "gap", "misconception", "retrieval-failure"]);
const MASTERY_LEVELS = ["unseen", "recognized", "recalled", "applied", "transferred"];

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalText(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, label);
}

function textList(value, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => requiredText(entry, `${label}[${index}]`));
}

function objectValue(value, label) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function routeExtensionList(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("routeExtensions must be an array");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`routeExtensions[${index}] must be an object`);
    }
    return {
      concept: requiredText(entry.concept, `routeExtensions[${index}].concept`),
      dependsOn: textList(entry.dependsOn, `routeExtensions[${index}].dependsOn`) ?? [],
      reason: optionalText(entry.reason, `routeExtensions[${index}].reason`),
      addedAt: optionalText(entry.addedAt, `routeExtensions[${index}].addedAt`) ?? new Date().toISOString(),
    };
  });
}

function optionalInteger(value, label, minimum, maximum) {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function misconceptionList(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("misconceptions must be an array");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`misconceptions[${index}] must be an object`);
    }
    return {
      concept: requiredText(entry.concept, `misconceptions[${index}].concept`),
      wrongModel: requiredText(entry.wrongModel, `misconceptions[${index}].wrongModel`),
      correction: optionalText(entry.correction, `misconceptions[${index}].correction`),
      sourceRef: optionalText(entry.sourceRef, `misconceptions[${index}].sourceRef`),
      repaired: entry.repaired === true,
      createdAt: optionalText(entry.createdAt, `misconceptions[${index}].createdAt`) ?? new Date().toISOString(),
      repairedAt: optionalText(entry.repairedAt, `misconceptions[${index}].repairedAt`),
    };
  });
}

function demonstrated(dimensions, name) {
  if (Array.isArray(dimensions)) return dimensions.includes(name);
  return dimensions?.[name] === "demonstrated";
}

export function deriveMastery(dimensions, transferPassed = false) {
  if (transferPassed || demonstrated(dimensions, "transfer")) return "transferred";
  if (demonstrated(dimensions, "application")) return "applied";
  if (demonstrated(dimensions, "recall")) return "recalled";
  if (demonstrated(dimensions, "recognition")) return "recognized";
  return "unseen";
}

export function buildNextRecommendation(evidence, assessment = {}) {
  const masteryLevel = evidence?.masteryLevel ?? deriveMastery(evidence?.dimensions, evidence?.transferPassed === true);
  if (assessment.outcome !== "accurate") {
    const errorKind = evidence?.lastErrorKind;
    if (errorKind === "misconception") {
      return {
        masteryLevel,
        closure: "open",
        recommendedNext: "contrast-and-retest",
        reason: "A wrong model is active; use a counterexample, then retest.",
      };
    }
    if (errorKind === "gap") {
      return {
        masteryLevel,
        closure: "open",
        recommendedNext: "prerequisite",
        reason: "A prerequisite is missing; repair it before retrying this connection.",
      };
    }
    if (errorKind === "retrieval-failure") {
      return {
        masteryLevel,
        closure: "open",
        recommendedNext: "spaced-recall",
        reason: "The knowledge exists but did not retrieve; use a shorter spaced retry.",
      };
    }
    return {
      masteryLevel,
      closure: "open",
      recommendedNext: "retest",
      reason: "The connection needs repair before moving on.",
    };
  }

  if (masteryLevel === "transferred") {
    return {
      masteryLevel,
      closure: "mastered",
      recommendedNext: "review-later",
      reason: "Transfer passed; schedule maintenance review.",
    };
  }
  if (masteryLevel === "applied") {
    return {
      masteryLevel,
      closure: "provisional",
      recommendedNext: "transfer",
      reason: "Application is demonstrated; test it in a new context.",
    };
  }
  if (masteryLevel === "recalled") {
    return {
      masteryLevel,
      closure: "provisional",
      recommendedNext: "prediction",
      reason: "Recall is demonstrated; add an application check.",
    };
  }
  return {
    masteryLevel,
    closure: "provisional",
    recommendedNext: "free-recall",
    reason: "Recognition is not enough; reconstruct the idea without cues.",
  };
}

function safeSessionId(value) {
  const id = requiredText(value, "sessionId");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
    throw new Error("sessionId may contain only letters, numbers, underscores, and hyphens");
  }
  return id;
}

function storageDirectory(baseDirectory) {
  return resolve(baseDirectory, ".concept-loom", "sessions");
}

function statePath(baseDirectory, sessionId) {
  return join(storageDirectory(baseDirectory), `${safeSessionId(sessionId)}.json`);
}

async function readState(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveLearningState(baseDirectory, input) {
  const sessionId = safeSessionId(input.sessionId);
  const destination = statePath(baseDirectory, sessionId);
  const previous = await readState(destination);
  const phase = requiredText(input.phase, "phase").toLowerCase();
  if (!PHASES.has(phase)) throw new Error(`phase must be one of: ${[...PHASES].join(", ")}`);
  const mode = optionalText(input.mode, "mode")?.toLowerCase() ?? previous?.mode ?? "guided";
  if (!MODES.has(mode)) throw new Error(`mode must be one of: ${[...MODES].join(", ")}`);

  const now = new Date().toISOString();
  const state = {
    schemaVersion: 2,
    sessionId,
    topic: requiredText(input.topic, "topic"),
    goal: requiredText(input.goal, "goal"),
    phase,
    mode,
    notebookPath: optionalText(input.notebookPath, "notebookPath"),
    route: textList(input.route, "route") ?? [],
    secured: textList(input.secured, "secured") ?? [],
    gaps: textList(input.gaps, "gaps") ?? [],
    misconceptions: misconceptionList(input.misconceptions) ?? previous?.misconceptions ?? [],
    evidence: objectValue(input.evidence, "evidence") ?? previous?.evidence ?? {},
    routeExtensions: routeExtensionList(input.routeExtensions) ?? previous?.routeExtensions ?? [],
    currentStep: optionalText(input.currentStep, "currentStep"),
    nextStep: requiredText(input.nextStep, "nextStep"),
    learnerContext: optionalText(input.learnerContext, "learnerContext"),
    lastCheckpoint: input.lastCheckpoint ?? previous?.lastCheckpoint,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    revision: (previous?.revision ?? 0) + 1,
  };

  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
  return state;
}

export async function loadLearningState(baseDirectory, input = {}) {
  if (input.sessionId) {
    const sessionId = safeSessionId(input.sessionId);
    const state = await readState(statePath(baseDirectory, sessionId));
    if (!state) throw new Error(`learning session '${sessionId}' was not found`);
    return { state };
  }

  const directory = storageDirectory(baseDirectory);
  let names;
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (error?.code === "ENOENT") return { state: null, sessions: [] };
    throw error;
  }

  const states = (await Promise.all(names.map((name) => readState(join(directory, name)))))
    .filter(Boolean)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    state: states[0] ?? null,
    sessions: states.map(({ sessionId, topic, goal, phase, nextStep, updatedAt }) => ({
      sessionId,
      topic,
      goal,
      phase,
      nextStep,
      updatedAt,
    })),
  };
}

export async function listDueReviews(baseDirectory, input = {}) {
  const now = input.now ? new Date(requiredText(input.now, "now")) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error("now must be an ISO date");
  const { sessions } = await loadLearningState(baseDirectory);
  const due = [];
  for (const summary of sessions) {
    const { state } = await loadLearningState(baseDirectory, { sessionId: summary.sessionId });
    for (const [concept, evidence] of Object.entries(state.evidence ?? {})) {
      if (!evidence) continue;
      let inferred = false;
      let reviewAt = null;
      if (evidence.reviewAfter) {
        const stored = new Date(evidence.reviewAfter);
        if (!Number.isNaN(stored.getTime())) reviewAt = stored;
      }
      if (!reviewAt) {
        inferred = true;
        const base = new Date(evidence.lastSuccessfulRetrieval ?? evidence.lastAttemptAt ?? state.updatedAt);
        if (Number.isNaN(base.getTime())) continue;
        reviewAt = addDays(base, reviewIntervalDays(evidence.consecutiveSuccesses));
      }
      if (reviewAt <= now) {
        due.push({
          sessionId: state.sessionId,
          topic: state.topic,
          concept,
          reviewAfter: reviewAt.toISOString(),
          inferred,
          masteryLevel: evidence.masteryLevel ?? deriveMastery(evidence.dimensions, evidence.transferPassed === true),
          lastFormat: evidence.lastFormat,
          lastOutcome: evidence.lastOutcome,
          lastConfidence: evidence.lastConfidence,
          lastCalibration: evidence.lastCalibration,
          lastErrorKind: evidence.lastErrorKind,
          transferPassed: evidence.transferPassed === true,
        });
      }
    }
  }
  due.sort((left, right) => left.reviewAfter.localeCompare(right.reviewAfter));
  return { asOf: now.toISOString(), due };
}

const REVIEW_MINUTES = { choice: 1, "free-recall": 3, prediction: 3, debugging: 3, transfer: 5 };

function estimateReviewMinutes(format) {
  return REVIEW_MINUTES[format] ?? 3;
}

function suggestedReviewFormat(item) {
  if (item.masteryLevel === "transferred") return "free-recall";
  if (item.masteryLevel === "applied") return "transfer";
  if (item.masteryLevel === "recalled") return "prediction";
  if (item.masteryLevel === "recognized") return "free-recall";
  const next = {
    choice: "free-recall",
    "free-recall": "prediction",
    prediction: "transfer",
    debugging: "transfer",
    transfer: "free-recall",
  };
  return next[item.lastFormat] ?? "free-recall";
}

function reviewPriority(item, asOf) {
  const overdueDays = Math.max(0, Math.floor((asOf.getTime() - new Date(item.reviewAfter).getTime()) / 86_400_000));
  let score = overdueDays;
  if (item.lastErrorKind === "misconception") score += 12;
  if (item.lastCalibration === "overconfident") score += 10;
  if (item.transferPassed !== true) score += 3;
  if (item.masteryLevel === "recognized") score += 2;
  return score;
}

function reviewReason(item, asOf) {
  const overdueDays = Math.max(0, Math.floor((asOf.getTime() - new Date(item.reviewAfter).getTime()) / 86_400_000));
  const reasons = [`overdue ${overdueDays}d`];
  if (item.inferred) reasons.push("date inferred");
  if (item.lastErrorKind) reasons.push(`last error: ${item.lastErrorKind}`);
  if (item.masteryLevel) reasons.push(`mastery ${item.masteryLevel}`);
  if (item.transferPassed !== true) reasons.push("transfer not passed");
  return reasons.join("; ");
}

export async function buildReviewPlan(baseDirectory, input = {}) {
  const limit = optionalInteger(input.limit ?? 5, "limit", 1, 10);
  const minutes = optionalInteger(input.minutes, "minutes", 5, 120);
  const sessionId = input.sessionId ? safeSessionId(input.sessionId) : undefined;
  const { asOf, due } = await listDueReviews(baseDirectory, { now: input.now });
  const asOfDate = new Date(asOf);
  const filtered = sessionId ? due.filter((item) => item.sessionId === sessionId) : due;
  const sorted = [...filtered].sort((left, right) => reviewPriority(right, asOfDate) - reviewPriority(left, asOfDate));
  const groups = new Map();
  for (const item of sorted) {
    const key = `${item.sessionId}\u0000${item.topic}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const queues = [...groups.values()].sort((left, right) => reviewPriority(right[0], asOfDate) - reviewPriority(left[0], asOfDate));

  const candidate = [];
  while (queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const item = queue.shift();
      if (item) candidate.push(item);
    }
  }

  const plan = [];
  let estimatedMinutes = 0;
  for (const item of candidate) {
    const suggestedFormat = suggestedReviewFormat(item);
    const itemMinutes = estimateReviewMinutes(suggestedFormat);
    if (minutes !== undefined && plan.length > 0 && estimatedMinutes + itemMinutes > minutes) continue;
    plan.push({
      ...item,
      suggestedFormat,
      estimatedMinutes: itemMinutes,
      reason: reviewReason(item, asOfDate),
    });
    estimatedMinutes += itemMinutes;
    if (plan.length >= limit) break;
  }

  return {
    asOf,
    sessionId: sessionId ?? null,
    requestedMinutes: minutes ?? null,
    estimatedMinutes,
    plan,
  };
}

export async function buildProgressReport(baseDirectory, input = {}) {
  const loaded = input.sessionId
    ? (await loadLearningState(baseDirectory, { sessionId: input.sessionId })).state
    : (await loadLearningState(baseDirectory)).state;
  if (!loaded) {
    return {
      sessionId: null,
      mastery: Object.fromEntries(MASTERY_LEVELS.map((level) => [level, 0])),
      calibration: { "well-calibrated": 0, overconfident: 0, underconfident: 0, unknown: 0 },
      dueCount: 0,
      evidenceCount: 0,
      securedCount: 0,
      unresolvedMisconceptions: 0,
      markdown: "No learning state found yet.",
    };
  }

  const state = loaded;
  const mastery = Object.fromEntries(MASTERY_LEVELS.map((level) => [level, 0]));
  const calibration = { "well-calibrated": 0, overconfident: 0, underconfident: 0, unknown: 0 };
  const weakDimensions = {};
  for (const evidence of Object.values(state.evidence ?? {})) {
    if (!evidence) continue;
    const level = evidence.masteryLevel ?? deriveMastery(evidence.dimensions, evidence.transferPassed === true);
    mastery[level] = (mastery[level] ?? 0) + 1;
    if (evidence.lastCalibration && calibration[evidence.lastCalibration] !== undefined) {
      calibration[evidence.lastCalibration] += 1;
    } else {
      calibration.unknown += 1;
    }
    const dimensions = Array.isArray(evidence.dimensions) ? {} : (evidence.dimensions ?? {});
    for (const [dimension, result] of Object.entries(dimensions)) {
      if (result === "needs-work") weakDimensions[dimension] = (weakDimensions[dimension] ?? 0) + 1;
    }
  }

  const { due } = await listDueReviews(baseDirectory, { now: input.now });
  const dueCount = input.sessionId
    ? due.filter((item) => item.sessionId === input.sessionId).length
    : due.length;
  const unresolvedMisconceptions = (state.misconceptions ?? []).filter((entry) => entry.repaired !== true).length;
  const evidenceCount = Object.keys(state.evidence ?? {}).length;
  const securedCount = (state.secured ?? []).length;
  const markdown = [
    `# Progress: ${state.topic}`,
    "",
    `- Evidence: ${evidenceCount}`,
    `- Secured: ${securedCount}`,
    `- Due: ${dueCount}`,
    `- Mastery: ${MASTERY_LEVELS.map((level) => `${level} ${mastery[level]}`).join(", ")}`,
    `- Calibration: well ${calibration["well-calibrated"]}, over ${calibration.overconfident}, under ${calibration.underconfident}, unknown ${calibration.unknown}`,
    `- Weak dimensions: ${Object.keys(weakDimensions).length ? Object.entries(weakDimensions).map(([name, count]) => `${name} ${count}`).join(", ") : "none"}`,
    `- Unresolved misconceptions: ${unresolvedMisconceptions}`,
  ].join("\n");

  return {
    sessionId: state.sessionId,
    topic: state.topic,
    goal: state.goal,
    mastery,
    calibration,
    weakDimensions,
    dueCount,
    evidenceCount,
    securedCount,
    unresolvedMisconceptions,
    markdown,
  };
}

function addUnique(items, value) {
  return value && !items.includes(value) ? [...items, value] : items;
}

export async function recordCheckpointAssessment(baseDirectory, input, assessment) {
  const sessionId = safeSessionId(input.sessionId);
  const { state: previous } = await loadLearningState(baseDirectory, { sessionId });
  const securedConnection = optionalText(input.securedConnection, "securedConnection");
  const gap = optionalText(input.gap, "gap");
  const errorKind = optionalText(input.errorKind, "errorKind");
  if (errorKind && !ERROR_KINDS.has(errorKind)) {
    throw new Error(`errorKind must be one of: ${[...ERROR_KINDS].join(", ")}`);
  }
  const hintLevel = optionalInteger(input.hintLevel, "hintLevel", 0, 3);
  const latencyMs = optionalInteger(input.latencyMs, "latencyMs", 0, 86_400_000);
  const sourceRef = optionalText(input.sourceRef, "sourceRef") ?? assessment.sourceRef;
  const hintUsed = input.hintUsed === true || (hintLevel ?? 0) > 0;
  const secured = assessment.outcome === "accurate"
    ? addUnique(previous.secured ?? [], securedConnection)
    : previous.secured ?? [];
  const gaps = assessment.outcome === "knowledge-gap"
    ? addUnique(previous.gaps ?? [], gap ?? input.currentStep ?? previous.currentStep)
    : previous.gaps ?? [];
  const evidenceConcept = optionalText(input.evidenceConcept, "evidenceConcept")
    ?? securedConnection
    ?? input.currentStep
    ?? previous.currentStep;
  const evidence = { ...(previous.evidence ?? {}) };
  const now = new Date().toISOString();
  if (evidenceConcept) {
    const earlier = evidence[evidenceConcept] ?? {};
    const format = assessment.format ?? "choice";
    const dimension = CHECKPOINT_DIMENSIONS[format] ?? "recognition";
    const dimensionResult = assessment.outcome === "accurate" ? "demonstrated" : "needs-work";
    const consecutiveSuccesses = assessment.outcome === "accurate" ? (earlier.consecutiveSuccesses ?? 0) + 1 : 0;
    const earlierDimensions = Array.isArray(earlier.dimensions)
      ? Object.fromEntries(earlier.dimensions.map((name) => [name, "demonstrated"]))
      : (earlier.dimensions ?? {});
    const dimensions = { ...earlierDimensions, [dimension]: dimensionResult };
    const transferPassed = earlier.transferPassed === true || (format === "transfer" && assessment.outcome === "accurate");
    const errorCounts = { ...(earlier.errorCounts ?? {}) };
    if (errorKind) errorCounts[errorKind] = (errorCounts[errorKind] ?? 0) + 1;
    evidence[evidenceConcept] = {
      ...earlier,
      attempts: (earlier.attempts ?? 0) + 1,
      successes: (earlier.successes ?? 0) + (assessment.outcome === "accurate" ? 1 : 0),
      consecutiveSuccesses,
      dimensions,
      masteryLevel: deriveMastery(dimensions, transferPassed),
      lastFormat: format,
      lastOutcome: assessment.outcome,
      lastConfidence: assessment.confidence,
      lastCalibration: assessment.calibration,
      lastErrorKind: errorKind,
      lastHintLevel: hintLevel,
      lastLatencyMs: latencyMs,
      lastSourceRef: sourceRef,
      errorCounts,
      hintUsed,
      transferPassed,
      lastAttemptAt: now,
      lastSuccessfulRetrieval: assessment.outcome === "accurate"
        ? now
        : earlier.lastSuccessfulRetrieval,
      reviewAfter: nextReviewDate(consecutiveSuccesses, assessment.outcome, {
        hintLevel,
        hintUsed,
        confidence: assessment.confidence,
      }),
    };
  }

  let misconceptions = [...(previous.misconceptions ?? [])];
  if (input.misconception) {
    misconceptions.push({
      concept: evidenceConcept ?? input.currentStep ?? "unassigned",
      wrongModel: requiredText(input.misconception, "misconception"),
      correction: optionalText(input.misconceptionCorrection, "misconceptionCorrection"),
      sourceRef,
      repaired: false,
      createdAt: now,
    });
  }
  if (input.misconceptionRepaired === true && evidenceConcept) {
    misconceptions = misconceptions.map((entry) => (
      entry.concept === evidenceConcept && entry.repaired !== true
        ? { ...entry, repaired: true, repairedAt: now }
        : entry
    ));
  }

  return saveLearningState(baseDirectory, {
    ...previous,
    currentStep: input.currentStep ?? previous.currentStep,
    nextStep: requiredText(input.nextStep, "nextStep"),
    secured,
    gaps,
    misconceptions,
    evidence,
    lastCheckpoint: {
      outcome: assessment.outcome,
      selected: assessment.selected,
      response: assessment.response,
      format: assessment.format ?? "choice",
      confidence: assessment.confidence,
      calibration: assessment.calibration,
      errorKind,
      sourceRef,
      hintLevel,
      latencyMs,
      note: assessment.note,
      assessedAt: now,
    },
  });
}

const REVIEW_INTERVALS = [1, 3, 7, 14, 30];

function reviewIntervalDays(consecutiveSuccesses) {
  const index = Math.min(Math.max((consecutiveSuccesses ?? 1) - 1, 0), REVIEW_INTERVALS.length - 1);
  return REVIEW_INTERVALS[index];
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function nextReviewDate(consecutiveSuccesses, outcome, options = {}) {
  let days = outcome === "accurate" ? reviewIntervalDays(consecutiveSuccesses) : 1;
  if (outcome === "accurate") {
    const hintLevel = options.hintLevel ?? (options.hintUsed ? 1 : 0);
    const confidence = options.confidence;
    if (hintLevel > 0 || (typeof confidence === "number" && confidence < 50)) {
      days = Math.max(1, Math.round(days / 2));
    } else if (typeof confidence === "number" && confidence >= 80) {
      days = Math.round(days * 1.5);
    }
  }
  return addDays(new Date(), Math.min(days, 60)).toISOString();
}
