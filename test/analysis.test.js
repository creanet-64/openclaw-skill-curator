import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildObservation, classifyRequest, clusterObservations, redactText } from "../lib/analysis.js";
import { buildCronAddArgs, buildCronEditArgs, installProposalSweepCron, uninstallProposalSweepCron } from "../lib/cron.js";
import { buildCandidateReport } from "../lib/report.js";
import { CuratorStore } from "../lib/store.js";
import { buildProposalName, parseWorkshopProposalId, sweepReadyCandidates } from "../lib/sweep.js";

test("detects French durable corrections", () => {
  const result = classifyRequest("Désormais, vérifie toujours le statut avant de répondre.", 0);
  assert.equal(result.correction, true);
  assert.equal(result.procedural, true);
});

test("redacts common secrets and identifiers", () => {
  const result = redactText("api_key=abc123456 contact admin@example.org sur 192.168.1.20 https://example.org/x");
  assert.equal(result.includes("abc123456"), false);
  assert.equal(result.includes("admin@example.org"), false);
  assert.equal(result.includes("192.168.1.20"), false);
  assert.equal(result.includes("https://example.org/x"), false);
});

test("builds a bounded successful-turn observation", () => {
  const observation = buildObservation({
    messages: [
      { role: "user", content: "Vérifie les sauvegardes Proxmox et résume les erreurs éventuelles." },
      { role: "assistant", content: [{ type: "toolCall", name: "exec" }] },
    ],
    maxExcerptChars: 80,
    runId: "run-1",
    agentId: "main",
    sessionKey: "agent:main:main",
    timestamp: Date.UTC(2026, 5, 13),
  });
  assert.equal(observation.id, "run-1");
  assert.equal(observation.toolCount, 1);
  assert.equal(observation.day, "2026-06-13");
  assert.ok(observation.excerpt.length <= 80);
});

test("ignores OpenClaw heartbeat polls", () => {
  const observation = buildObservation({
    messages: [
      { role: "user", content: "[OpenClaw heartbeat poll]" },
      { role: "assistant", content: [{ type: "toolCall", name: "exec" }] },
    ],
    maxExcerptChars: 600,
    runId: "heartbeat-run",
    agentId: "main",
    sessionKey: "agent:main:heartbeat",
    timestamp: Date.UTC(2026, 5, 16),
  });

  assert.equal(observation, null);
});

test("ignores pre-compaction memory flush prompts", () => {
  const observation = buildObservation({
    messages: [
      { role: "user", content: "Pre-compaction memory flush. Store durable memories only in memory/2026-06-16.md (create memory/ if needed)." },
      { role: "assistant", content: [{ type: "toolCall", name: "exec" }] },
    ],
    maxExcerptChars: 600,
    runId: "flush-run",
    agentId: "main",
    sessionKey: "agent:main:flush",
    timestamp: Date.UTC(2026, 5, 16),
  });

  assert.equal(observation, null);
});

test("ignores scheduled cron prompts", () => {
  const observation = buildObservation({
    messages: [
      { role: "user", content: "[cron:job-id nightly-openclaw-maintenance] Dans /home/alphadm/.openclaw/workspace, exécute via tool exec: openclaw tasks maintenance --apply." },
      { role: "assistant", content: [{ type: "toolCall", name: "exec" }] },
    ],
    maxExcerptChars: 600,
    runId: "cron-run",
    agentId: "main",
    sessionKey: "agent:main:cron",
    timestamp: Date.UTC(2026, 5, 18),
  });

  assert.equal(observation, null);
});

test("ignores dream diary generation prompts", () => {
  const observation = buildObservation({
    messages: [
      { role: "user", content: "Write a dream diary entry from these memory fragments: - Camille a choisi le nom Michel. Recurring themes: camille, cron." },
      { role: "assistant", content: [{ type: "toolCall", name: "exec" }] },
    ],
    maxExcerptChars: 600,
    runId: "dream-run",
    agentId: "main",
    sessionKey: "agent:main:dream",
    timestamp: Date.UTC(2026, 5, 18),
  });

  assert.equal(observation, null);
});

test("excludes stored internal observations from candidate reports", () => {
  const useful = buildObservation({
    messages: [{ role: "user", content: "Vérifie les sauvegardes Proxmox et résume les erreurs éventuelles." }],
    maxExcerptChars: 600,
    runId: "useful-run",
    agentId: "main",
    sessionKey: "agent:main:useful",
    timestamp: Date.UTC(2026, 5, 16),
  });
  const heartbeat = {
    ...useful,
    id: "old-heartbeat-run",
    excerpt: "[OpenClaw heartbeat poll]",
    normalized: "heartbeat openclaw poll",
    tokens: ["heartbeat", "openclaw", "poll"],
  };
  const cron = {
    ...useful,
    id: "old-cron-run",
    excerpt: "[cron:job-id nightly-openclaw-maintenance] Dans /home/alphadm/.openclaw/workspace, exécute via tool exec: openclaw tasks maintenance --apply.",
    normalized: "cron nightly openclaw maintenance",
    tokens: ["cron", "nightly", "openclaw", "maintenance"],
  };
  const dream = {
    ...useful,
    id: "old-dream-run",
    excerpt: "Write a dream diary entry from these memory fragments: - Camille a choisi le nom Michel.",
    normalized: "write dream diary entry memory fragments camille michel",
    tokens: ["write", "dream", "diary", "entry", "memory", "fragments", "camille", "michel"],
  };

  const report = buildCandidateReport([useful, heartbeat, cron, dream], { minConfidence: 0, minOccurrences: 1, minSessions: 1, similarityThreshold: 0.45 });
  assert.equal(report.observations, 1);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].representative, useful.excerpt);
});

test("promotes repeated observations across sessions into a ready candidate", () => {
  const observations = [
    ["r1", "s1", "2026-06-10", "Vérifie les sauvegardes Proxmox et résume les erreurs."],
    ["r2", "s2", "2026-06-11", "Contrôle les sauvegardes Proxmox puis résume les erreurs."],
    ["r3", "s3", "2026-06-12", "Vérifie les sauvegardes Proxmox et signale les erreurs."],
  ].map(([runId, sessionKey, day, text]) => buildObservation({
    messages: [{ role: "user", content: text }],
    maxExcerptChars: 600,
    runId,
    agentId: "main",
    sessionKey,
    timestamp: Date.parse(`${day}T10:00:00Z`),
  }));

  const clusters = clusterObservations(observations, 0.45);
  assert.equal(clusters.length, 1);
  const report = buildCandidateReport(observations, { minConfidence: 0.7, minOccurrences: 3, minSessions: 2, similarityThreshold: 0.45 });
  assert.equal(report.candidates[0].ready, true);
  assert.match(report.candidates[0].id, /^skill-[a-f0-9]{16}$/u);
  assert.equal(report.candidates[0].status, "observed");
  assert.equal(report.candidates[0].recommendation, "propose");
  assert.equal(report.candidates[0].sessions, 3);
});

test("attaches candidate review lifecycle state to reports", () => {
  const observation = buildObservation({
    messages: [{ role: "user", content: "Vérifie les sauvegardes Proxmox et résume les erreurs." }],
    maxExcerptChars: 600,
    runId: "review-run",
    agentId: "main",
    sessionKey: "agent:main:review",
    timestamp: Date.UTC(2026, 5, 13),
  });
  const initial = buildCandidateReport([observation], { minConfidence: 0, minOccurrences: 1, minSessions: 1, similarityThreshold: 0.45 });
  const candidateId = initial.candidates[0].id;
  const reviewed = buildCandidateReport([observation], { minConfidence: 0, minOccurrences: 1, minSessions: 1, similarityThreshold: 0.45 }, new Map([[candidateId, {
    status: "approved",
    note: "Useful as a recurring runbook.",
    author: "test",
    updatedAt: 1,
  }]]));

  assert.equal(reviewed.candidates[0].status, "approved");
  assert.equal(reviewed.candidates[0].review.author, "test");
  assert.equal(reviewed.candidates[0].recommendation, "hold");
});

test("persists and deduplicates observations in SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "skill-curator-"));
  const store = new CuratorStore(join(directory, "curator.sqlite"));
  const observation = buildObservation({
    messages: [{ role: "user", content: "Analyse les sauvegardes Proxmox et signale les erreurs importantes." }],
    maxExcerptChars: 600,
    runId: "dedupe-run",
    agentId: "main",
    sessionKey: "agent:main:test",
    timestamp: Date.UTC(2026, 5, 13),
  });

  assert.equal(store.insert(observation), true);
  assert.equal(store.insert(observation), false);
  assert.equal(store.count(), 1);
  assert.equal(store.list()[0].id, "dedupe-run");
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("persists candidate lifecycle reviews and counts by status", () => {
  const directory = mkdtempSync(join(tmpdir(), "skill-curator-"));
  const store = new CuratorStore(join(directory, "curator.sqlite"));

  store.setReview({ candidateId: "skill-test", status: "proposed", note: "Review this", author: "test", timestamp: 1 });
  store.setReview({ candidateId: "skill-test", status: "approved", note: "Looks good", author: "test", timestamp: 2 });

  const reviews = store.listReviews();
  assert.equal(reviews.get("skill-test").status, "approved");
  assert.equal(reviews.get("skill-test").note, "Looks good");
  assert.deepEqual(store.reviewCounts(), { approved: 1 });

  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("builds a native proposal sweep cron command", () => {
  const args = buildCronAddArgs({ cron: "15 10 * * *", tz: "Europe/Paris", agent: "main", timeoutSeconds: 240 });

  assert.deepEqual(args.slice(0, 2), ["cron", "add"]);
  assert.ok(args.includes("--message"));
  assert.ok(args.includes("Skill Curator proposal sweep"));
  assert.ok(args.includes("--session"));
  assert.ok(args.includes("isolated"));
  assert.ok(args.includes("--no-deliver"));
  assert.ok(args.includes("--tools"));
  assert.ok(args.includes("*"));
  assert.equal(args[args.indexOf("--cron") + 1], "15 10 * * *");
  assert.equal(args[args.indexOf("--timeout-seconds") + 1], "240");
});

test("proposal sweep cron install is idempotent", () => {
  const calls = [];
  const existing = {
    jobs: [{
      id: "job-1",
      name: "Skill Curator proposal sweep",
      description: "managed-by=skill-curator.proposal-sweep",
    }],
  };
  const run = (args) => {
    calls.push(args);
    return JSON.stringify(existing);
  };

  const result = installProposalSweepCron({}, run);

  assert.equal(result.status, "exists");
  assert.equal(result.jobs[0].id, "job-1");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["cron", "list", "--json"]);
});

test("proposal sweep cron install can update managed jobs", () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === "cron" && args[1] === "list") {
      return JSON.stringify({
        jobs: [{ id: "job-1", name: "Skill Curator proposal sweep", description: "managed-by=skill-curator.proposal-sweep" }],
      });
    }
    return "{}";
  };

  const result = installProposalSweepCron({ refreshExisting: true, cron: "20 4 * * *" }, run);

  assert.equal(result.status, "updated");
  assert.deepEqual(result.updated, ["job-1"]);
  assert.deepEqual(calls.at(-1), buildCronEditArgs("job-1", { refreshExisting: true, cron: "20 4 * * *" }));
});

test("proposal sweep cron uninstall removes managed jobs", () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === "cron" && args[1] === "list") {
      return JSON.stringify({
        jobs: [
          { id: "job-1", name: "Skill Curator proposal sweep", description: "managed-by=skill-curator.proposal-sweep" },
          { id: "job-2", name: "Other", description: "unrelated" },
        ],
      });
    }
    return "{}";
  };

  const result = uninstallProposalSweepCron({}, run);

  assert.equal(result.status, "removed");
  assert.deepEqual(result.removed, ["job-1"]);
  assert.deepEqual(calls.at(-1), ["cron", "rm", "job-1", "--json"]);
});

test("parses Skill Workshop proposal ids from supported JSON shapes", () => {
  assert.equal(parseWorkshopProposalId(JSON.stringify({ id: "proposal-1" })), "proposal-1");
  assert.equal(parseWorkshopProposalId(JSON.stringify({ record: { id: "proposal-2" } })), "proposal-2");
  assert.equal(parseWorkshopProposalId(JSON.stringify({ proposal: { record: { id: "proposal-3" } } })), "proposal-3");
});

test("sweep dry-run reports eligible candidates without creating proposals", () => {
  const candidate = {
    id: "skill-demo",
    key: "demo release checklist",
    ready: true,
    confidence: 0.9,
    status: "observed",
    recommendation: "propose",
    occurrences: 3,
    sessions: 2,
    days: 2,
    evidence: [],
    representative: "Check this demo release checklist.",
  };
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return JSON.stringify({ proposals: [] });
  };
  const store = { setReview: () => assert.fail("dry-run must not set reviews") };

  const result = sweepReadyCandidates({ report: { candidates: [candidate] }, store, dryRun: true, run });

  assert.equal(result.eligible, 1);
  assert.equal(result.proposalsCreated.length, 0);
  assert.deepEqual(result.skipped, [{ candidateId: "skill-demo", reason: "dry-run", skillName: "demo-release-checklist" }]);
  assert.deepEqual(calls, [["skills", "workshop", "list", "--json"]]);
});

test("sweep creates pending proposals and marks candidates proposed", () => {
  const candidate = {
    id: "skill-demo",
    key: "demo release checklist",
    ready: true,
    confidence: 0.9,
    status: "observed",
    recommendation: "propose",
    occurrences: 3,
    sessions: 2,
    days: 2,
    evidence: [{ day: "2026-06-18", excerpt: "Check this demo release checklist." }],
    representative: "Check this demo release checklist.",
  };
  const reviews = [];
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === "skills" && args[1] === "workshop" && args[2] === "list") {
      return JSON.stringify({ proposals: [] });
    }
    assert.deepEqual(args.slice(0, 3), ["skills", "workshop", "propose-create"]);
    assert.ok(args.includes("--proposal"));
    return JSON.stringify({ proposal: { record: { id: "demo-proposal-1" } } });
  };
  const store = { setReview: (review) => reviews.push(review) };

  const result = sweepReadyCandidates({ report: { candidates: [candidate] }, store, run });

  assert.deepEqual(result.proposalsCreated, [{ candidateId: "skill-demo", proposalId: "demo-proposal-1", skillName: "demo-release-checklist" }]);
  assert.equal(result.errors.length, 0);
  assert.equal(reviews[0].candidateId, "skill-demo");
  assert.equal(reviews[0].status, "proposed");
  assert.equal(reviews[0].author, "skill-curator-sweep");
  assert.equal(calls.length, 2);
});

test("sweep skips candidates with equivalent active proposals", () => {
  const candidate = {
    id: "skill-demo",
    key: "demo release checklist",
    ready: true,
    confidence: 0.9,
    status: "observed",
    recommendation: "propose",
    occurrences: 3,
    sessions: 2,
    days: 2,
    evidence: [],
    representative: "Check this demo release checklist.",
  };
  const run = (args) => {
    assert.deepEqual(args, ["skills", "workshop", "list", "--json"]);
    return JSON.stringify({ proposals: [{ status: "pending", skillKey: buildProposalName(candidate) }] });
  };
  const store = { setReview: () => assert.fail("duplicate proposal must not set reviews") };

  const result = sweepReadyCandidates({ report: { candidates: [candidate] }, store, run });

  assert.deepEqual(result.skipped, [{ candidateId: "skill-demo", reason: "equivalent-active-proposal", skillName: "demo-release-checklist" }]);
  assert.equal(result.proposalsCreated.length, 0);
});
