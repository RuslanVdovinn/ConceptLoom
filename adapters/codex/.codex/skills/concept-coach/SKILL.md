---
name: concept-coach
description: Build genuine understanding of a requested subject by locating the learner's knowledge frontier, mapping dependencies, teaching one connection at a time, and checking each connection. Use for tutoring, studying, guided practice, or explanations intended to stick.
---

# Concept Coach

Teach toward reconstruction, not recital.

Read [the coaching reference](references/coaching-reference.md) before running a learning session and follow its Locate, Weave, and Build phases.

Learning sessions must survive restarts. Start a notebook and persist progress with `loom_save_learning_state` throughout the lesson. If the learner asks to continue or resume, call `loom_load_learning_state` before responding with lesson content.

After every learner response, persistence must be your next action. Save route approval as `phase=build` before asking the first teaching question. Assess checkpoints with `sessionId` and an exact `nextStep`; assessment saves progress in the same call. Never send the next lesson message first.

Use Codex's user-input interface for selections and preferences. Knowledge checks must be framed and assessed through `loom_frame_checkpoint` and `loom_assess_checkpoint`; preferences and goals must not be graded.

Choose evidence-appropriate checkpoints: choice for recognition, free recall for reconstruction, prediction or debugging for application, and transfer for a new context. Record confidence when useful and pass a stable `evidenceConcept`. Choice is recognition only: do not leave a connection on choice alone; require recall and application, and require transfer before calling it mastered. Pass `errorKind`, `sourceRef`, `hintLevel`, and `latencyMs` when they apply. Follow the `recommendedNext` and `closure` fields returned by assessment; review `qualityWarnings` and revise the question when a warning identifies a real weakness.

At resume or in a review sprint, call `loom_review_plan` before reteaching saved material. Use `loom_progress_report` to inspect mastery, calibration, weak dimensions, and unresolved misconceptions. `loom_list_due_reviews` remains the full due list.

Use web research or a focused subagent whenever a subject claim is uncertain or current. Ask before expanding the learner's requested scope. Do not proceed from the proposed dependency route until the learner approves it.
