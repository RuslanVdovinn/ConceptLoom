import { randomBytes } from "node:crypto";

const activeCards = new Map();
const CARD_TTL_MS = 6 * 60 * 60 * 1000;
const FORMATS = new Set(["choice", "free-recall", "prediction", "debugging", "transfer"]);
const VERDICTS = new Set(["accurate", "needs-repair", "knowledge-gap"]);

function cleanText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function rearrange(items, random = Math.random) {
  const copy = [...items];
  for (let cursor = copy.length - 1; cursor > 0; cursor -= 1) {
    const swapWith = Math.floor(random() * (cursor + 1));
    [copy[cursor], copy[swapWith]] = [copy[swapWith], copy[cursor]];
  }
  return copy;
}

function discardExpired(now = Date.now()) {
  for (const [key, card] of activeCards) {
    if (now - card.createdAt > CARD_TTL_MS) activeCards.delete(key);
  }
}

function buildQualityWarnings({ prompt, choices, criteria, closed }) {
  const warnings = [];
  if (closed) {
    const labels = choices.map((choice) => choice.label);
    const lengths = labels.map((label) => label.length).sort((left, right) => left - right);
    const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
    if (labels.length < 3) {
      warnings.push("Only two choices; use three or more when the distinction matters.");
    }
    if (labels.some((label) => label.length > Math.max(40, median * 2))) {
      warnings.push("One choice is much longer than the others; length can cue the answer.");
    }
    if (labels.some((label) => /all of the above|none of the above|все вышеперечисленное|ни один из/i.test(label))) {
      warnings.push("Avoid meta-options such as all/none of the above.");
    }
    if (/\b(not|never|except)\b|(^|\s)не\s/i.test(prompt)) {
      warnings.push("Negative wording can make a choice question ambiguous.");
    }
    const prefixes = labels.map((label) => label.toLowerCase().split(/\s+/).slice(0, 2).join(" "));
    if (prefixes.length >= 2 && new Set(prefixes).size === 1) {
      warnings.push("All choices start the same way; keep alternatives parallel but clearly different.");
    }
  } else {
    if (!criteria || criteria.length < 2) {
      warnings.push("Use at least two criteria for an open response.");
    }
    if (criteria?.some((criterion) => /\b(understand|know|good|correct|appropriate|понима|знает|правильн)/i.test(criterion))) {
      warnings.push("A criterion is vague; describe observable evidence instead.");
    }
  }
  return warnings;
}

export function composeCheckpoint(input, random = Math.random) {
  discardExpired();
  const prompt = cleanText(input.prompt, "prompt");
  const rationale = cleanText(input.rationale, "rationale");
  const format = input.format === undefined ? "choice" : cleanText(input.format, "format");
  if (!FORMATS.has(format)) throw new Error(`format must be one of: ${[...FORMATS].join(", ")}`);
  const sourceRef = typeof input.sourceRef === "string" && input.sourceRef.trim() ? input.sourceRef.trim() : undefined;
  const hasChoices = Array.isArray(input.choices) && input.choices.length > 0;
  const hasExpected = !(Array.isArray(input.expected) && input.expected.length === 0)
    && input.expected !== undefined
    && input.expected !== null
    && input.expected !== "";
  const closed = format === "choice" || hasChoices || hasExpected;
  const token = randomBytes(18).toString("base64url");

  if (!closed) {
    if (!Array.isArray(input.criteria) || input.criteria.length === 0) {
      throw new Error("criteria must contain at least one entry for an open checkpoint");
    }
    const criteria = input.criteria.map((entry, index) => cleanText(entry, `criteria[${index}]`));
    const qualityWarnings = buildQualityWarnings({ prompt, choices: [], criteria, closed: false });
    activeCards.set(token, {
      createdAt: Date.now(),
      mode: "open",
      prompt,
      rationale,
      format,
      criteria,
      sourceRef,
      qualityWarnings,
    });
    return {
      token,
      mode: "open",
      prompt,
      format,
      sourceRef,
      qualityWarnings,
      escapeChoice: { key: "__gap__", label: "I do not know yet" },
      instructions: "Answer without answer choices, or respond with __gap__. Optionally report confidence from 0 to 100.",
    };
  }

  if (!hasChoices || input.choices.length < 2) {
    throw new Error(
      "closed checkpoints require choices with at least two entries; " +
      "omit choices and expected, and provide criteria, for an open checkpoint",
    );
  }
  if (!hasExpected) {
    throw new Error("expected must name at least one choice key for a closed checkpoint");
  }

  const knownKeys = new Set();
  const choices = input.choices.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`choice ${index + 1} must be an object`);
    const key = cleanText(entry.key, `choice ${index + 1} key`);
    const label = cleanText(entry.label, `choice ${index + 1} label`);
    if (knownKeys.has(key)) throw new Error(`choice key '${key}' is duplicated`);
    knownKeys.add(key);
    return { key, label };
  });

  const expected = Array.isArray(input.expected) ? input.expected : [input.expected];
  if (expected.length === 0) throw new Error("expected must name at least one choice key");
  const expectedSet = new Set(expected.map((value) => cleanText(value, "expected key")));
  for (const key of expectedSet) {
    if (!knownKeys.has(key)) throw new Error(`expected key '${key}' is not present in choices`);
  }
  const multiple = input.multiple === true;
  if (!multiple && expectedSet.size !== 1) {
    throw new Error("a single-choice checkpoint must have exactly one expected key");
  }

  const arranged = input.mix === false ? choices : rearrange(choices, random);
  const qualityWarnings = buildQualityWarnings({ prompt, choices, criteria: [], closed: true });
  activeCards.set(token, {
    createdAt: Date.now(),
    mode: "closed",
    prompt,
    rationale,
    choices: arranged,
    expectedSet,
    multiple,
    format,
    sourceRef,
    qualityWarnings,
  });

  return {
    token,
    mode: "closed",
    prompt,
    format,
    sourceRef,
    qualityWarnings,
    multiple,
    choices: arranged,
    escapeChoice: { key: "__gap__", label: "I do not know yet" },
    instructions: multiple
      ? "Select every fitting key, or choose __gap__."
      : "Select one key, or choose __gap__.",
  };
}

export function assessCheckpoint(input) {
  discardExpired();
  const token = cleanText(input.token, "token");
  const card = activeCards.get(token);
  if (!card) throw new Error("checkpoint token is unknown or expired");

  const confidence = input.confidence === undefined ? undefined : Number(input.confidence);
  if (confidence !== undefined && (!Number.isInteger(confidence) || confidence < 0 || confidence > 100)) {
    throw new Error("confidence must be an integer from 0 to 100");
  }

  if (card.mode === "open") {
    const response = cleanText(input.response, "response");
    const admittedGap = response === "__gap__";
    const verdict = admittedGap ? "knowledge-gap" : cleanText(input.verdict, "verdict");
    if (!VERDICTS.has(verdict)) {
      throw new Error("verdict must be accurate, needs-repair, or knowledge-gap");
    }
    activeCards.delete(token);
    const accurate = verdict === "accurate";
    return {
      mode: "open",
      format: card.format,
      outcome: verdict,
      accurate,
      response,
      criteria: card.criteria,
      rationale: card.rationale,
      sourceRef: card.sourceRef,
      confidence,
      calibration: describeCalibration(accurate, confidence),
      note: typeof input.note === "string" && input.note.trim() ? input.note.trim() : undefined,
    };
  }

  const submitted = Array.isArray(input.selected) ? input.selected : [input.selected];
  const selected = submitted.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim());
  const admittedGap = selected.includes("__gap__");
  if (admittedGap && selected.length !== 1) throw new Error("__gap__ cannot be combined with another choice");
  if (!admittedGap && selected.length === 0) throw new Error("selected must contain an answer or __gap__");
  if (!card.multiple && selected.length !== 1) throw new Error("this checkpoint accepts one choice");

  const validKeys = new Set(card.choices.map((choice) => choice.key));
  for (const key of selected) {
    if (key !== "__gap__" && !validKeys.has(key)) throw new Error(`selected key '${key}' does not exist`);
  }

  const selectionSet = new Set(selected);
  const accurate = !admittedGap
    && selectionSet.size === card.expectedSet.size
    && [...selectionSet].every((key) => card.expectedSet.has(key));
  activeCards.delete(token);

  return {
    mode: "closed",
    format: card.format,
    outcome: admittedGap ? "knowledge-gap" : accurate ? "accurate" : "needs-repair",
    accurate,
    selected,
    expected: [...card.expectedSet],
    multiple: card.multiple,
    rationale: card.rationale,
    sourceRef: card.sourceRef,
    confidence,
    calibration: describeCalibration(accurate, confidence),
    note: typeof input.note === "string" && input.note.trim() ? input.note.trim() : undefined,
  };
}

function describeCalibration(accurate, confidence) {
  if (confidence === undefined) return undefined;
  if (!accurate && confidence >= 75) return "overconfident";
  if (accurate && confidence <= 40) return "underconfident";
  return "well-calibrated";
}

export function resetCheckpointsForTests() {
  activeCards.clear();
}
