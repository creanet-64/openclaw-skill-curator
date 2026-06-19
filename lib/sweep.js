import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ACTIVE_PROPOSAL_STATUSES = new Set(["pending", "quarantined"]);

export function slugifySkillName(text, fallback = "curated-workflow") {
  const slug = String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-")
    .slice(0, 48)
    .replace(/-+$/u, "");
  return slug || fallback;
}

export function buildProposalName(candidate) {
  return slugifySkillName(candidate.key || candidate.representative || candidate.id);
}

export function buildProposalDescription(candidate) {
  const source = candidate.representative || candidate.key || "Reusable workflow detected by Skill Curator.";
  const compact = source.replace(/\s+/gu, " ").trim();
  return compact.length <= 150 ? compact : `${compact.slice(0, 147).trim()}...`;
}

export function buildProposalContent(candidate) {
  const evidence = candidate.evidence || [];
  const evidenceLines = evidence.length > 0
    ? evidence.map((item) => `- ${item.day || "unknown"}: ${item.excerpt}`).join("\n")
    : "- No detailed evidence was included in the candidate report.";

  return `# ${buildProposalName(candidate)}

## Purpose

Capture a repeated workflow detected by Skill Curator as a pending, human-reviewed skill proposal.

## When To Use

Use this skill when the user asks for work matching this recurring request:

> ${candidate.representative || candidate.key || candidate.id}

## Procedure

1. Restate the concrete goal in operational terms.
2. Gather the minimum local context needed for the task.
3. Run the relevant checks or edits using the safest available local tools.
4. Report findings, changed files, verification results, and any remaining human decision.
5. Do not apply destructive changes or external actions without explicit approval.

## Candidate Evidence

- Candidate id: \`${candidate.id}\`
- Confidence: ${candidate.confidence}
- Occurrences: ${candidate.occurrences}
- Sessions: ${candidate.sessions}
- Days: ${candidate.days}

${evidenceLines}
`;
}

export function parseWorkshopProposalId(raw) {
  const parsed = JSON.parse(raw || "{}");
  return parsed?.proposal?.record?.id
    || parsed?.record?.id
    || parsed?.id
    || parsed?.proposalId
    || null;
}

export function parseWorkshopList(raw) {
  const parsed = JSON.parse(raw || "{}");
  return Array.isArray(parsed.proposals) ? parsed.proposals : [];
}

export function hasEquivalentActiveProposal(candidate, proposals) {
  const skillName = buildProposalName(candidate);
  return proposals.some((proposal) => ACTIVE_PROPOSAL_STATUSES.has(proposal.status)
    && (proposal.skillKey === skillName || proposal.skillName === skillName));
}

export function runOpenClaw(args) {
  return execFileSync("openclaw", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function createProposal(candidate, { run = runOpenClaw } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "skill-curator-proposal-"));
  const proposalPath = join(directory, "PROPOSAL.md");
  writeFileSync(proposalPath, buildProposalContent(candidate), "utf8");

  try {
    const raw = run([
      "skills", "workshop", "propose-create",
      "--name", buildProposalName(candidate),
      "--description", buildProposalDescription(candidate),
      "--goal", "Create a human-reviewed reusable skill from a repeated Skill Curator workflow candidate.",
      "--evidence", `Skill Curator candidate ${candidate.id}`,
      "--proposal", proposalPath,
      "--json",
    ]);
    return parseWorkshopProposalId(raw);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function sweepReadyCandidates({ report, store, dryRun = false, run = runOpenClaw } = {}) {
  const proposals = parseWorkshopList(run(["skills", "workshop", "list", "--json"]));
  const candidates = (report?.candidates || []).filter((candidate) => candidate.ready
    && candidate.recommendation === "propose"
    && ["observed", "rolled_back"].includes(candidate.status));
  const result = {
    schema: "openclaw.skill-curator.sweep.v1",
    candidatesSeen: report?.candidates?.length || 0,
    eligible: candidates.length,
    proposalsCreated: [],
    skipped: [],
    errors: [],
  };

  for (const candidate of candidates) {
    if (hasEquivalentActiveProposal(candidate, proposals)) {
      result.skipped.push({ candidateId: candidate.id, reason: "equivalent-active-proposal", skillName: buildProposalName(candidate) });
      continue;
    }

    if (dryRun) {
      result.skipped.push({ candidateId: candidate.id, reason: "dry-run", skillName: buildProposalName(candidate) });
      continue;
    }

    try {
      const proposalId = createProposal(candidate, { run });
      if (!proposalId) throw new Error("Skill Workshop did not return a proposal id");
      const note = `Converted to Skill Workshop proposal ${proposalId}`;
      store.setReview({ candidateId: candidate.id, status: "proposed", note, author: "skill-curator-sweep" });
      result.proposalsCreated.push({ candidateId: candidate.id, proposalId, skillName: buildProposalName(candidate) });
    } catch (error) {
      result.errors.push({ candidateId: candidate.id, message: error.message });
    }
  }

  return result;
}
