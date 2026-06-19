import { execFileSync } from "node:child_process";

export const CRON_MARKER = "managed-by=skill-curator.proposal-sweep";
export const DEFAULT_CRON_NAME = "Skill Curator proposal sweep";
export const DEFAULT_CRON_EXPR = "20 4 * * *";
export const DEFAULT_CRON_TZ = "Europe/Paris";
export const DEFAULT_CRON_AGENT = "main";
export const DEFAULT_CRON_TIMEOUT_SECONDS = 300;

export const PROPOSAL_SWEEP_PROMPT = "Run: openclaw skill-curator sweep --json";

export function managedCronDescription(description = "") {
  return `${CRON_MARKER} ${description}`.trim();
}

export function isManagedSkillCuratorCron(job) {
  return String(job?.description || "").includes(CRON_MARKER)
    || String(job?.name || "") === DEFAULT_CRON_NAME;
}

export function parseCronList(raw) {
  const parsed = JSON.parse(raw || "{}");
  return Array.isArray(parsed.jobs) ? parsed.jobs : [];
}

export function buildCronAddArgs(options = {}) {
  return buildCronUpsertArgs("add", options);
}

export function buildCronEditArgs(jobId, options = {}) {
  return buildCronUpsertArgs("edit", { ...options, jobId });
}

function buildCronUpsertArgs(action, options = {}) {
  const name = options.name || DEFAULT_CRON_NAME;
  const expr = options.cron || DEFAULT_CRON_EXPR;
  const tz = options.tz || DEFAULT_CRON_TZ;
  const agent = options.agent || DEFAULT_CRON_AGENT;
  const timeoutSeconds = String(options.timeoutSeconds || DEFAULT_CRON_TIMEOUT_SECONDS);
  const description = managedCronDescription(options.description || "Run Skill Curator's native sweep for ready candidates.");

  const args = [
    "cron",
    action,
    ...(action === "edit" ? [options.jobId] : []),
    "--name", name,
    "--description", description,
    "--cron", expr,
    "--tz", tz,
    "--agent", agent,
    "--session", "isolated",
    "--message", PROPOSAL_SWEEP_PROMPT,
    "--timeout-seconds", timeoutSeconds,
    "--tools", "*",
  ];

  if (action === "add") args.push("--json");

  if (options.announce) {
    args.push("--announce");
    if (options.channel) args.push("--channel", options.channel);
    if (options.to) args.push("--to", options.to);
  } else {
    args.push("--no-deliver");
  }

  return args;
}

export function runOpenClaw(args) {
  return execFileSync("openclaw", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function listManagedCronJobs(run = runOpenClaw) {
  const jobs = parseCronList(run(["cron", "list", "--json"]));
  return jobs.filter(isManagedSkillCuratorCron);
}

export function installProposalSweepCron(options = {}, run = runOpenClaw) {
  const existing = listManagedCronJobs(run);
  if (existing.length > 0) {
    if (options.refreshExisting) {
      const updated = [];
      for (const job of existing) {
        run(buildCronEditArgs(job.id, options));
        updated.push(job.id);
      }
      return { status: "updated", updated };
    }
    return { status: "exists", jobs: existing };
  }
  if (options.dryRun) {
    return { status: "dry-run", args: buildCronAddArgs(options) };
  }

  const created = JSON.parse(run(buildCronAddArgs(options)) || "{}");
  return { status: "created", job: created.job || created };
}

export function uninstallProposalSweepCron(options = {}, run = runOpenClaw) {
  const existing = listManagedCronJobs(run);
  if (options.dryRun) {
    return { status: "dry-run", jobs: existing };
  }

  const removed = [];
  for (const job of existing) {
    run(["cron", "rm", job.id, "--json"]);
    removed.push(job.id);
  }
  return { status: removed.length > 0 ? "removed" : "not-found", removed };
}
