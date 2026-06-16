import { homedir } from "node:os";
import { resolve } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildObservation, isHeartbeatText } from "./lib/analysis.js";
import { installProposalSweepCron, uninstallProposalSweepCron } from "./lib/cron.js";
import { buildCandidateReport } from "./lib/report.js";
import { CuratorStore } from "./lib/store.js";

const DEFAULTS = {
  includeCron: false,
  maxExcerptChars: 600,
  minConfidence: 0.7,
  minOccurrences: 3,
  minSessions: 2,
  similarityThreshold: 0.5,
};

const REVIEW_STATUSES = new Set(["observed", "proposed", "approved", "rejected", "rolled_back"]);

function resolveConfig(raw = {}) {
  return {
    ...DEFAULTS,
    ...raw,
    databasePath: resolve(raw.databasePath || process.env.OPENCLAW_STATE_DIR || `${homedir()}/.openclaw/state`, raw.databasePath ? "" : "skill-curator.sqlite"),
  };
}

export default definePluginEntry({
  id: "skill-curator",
  name: "Skill Curator",
  description: "Observe successful turns and identify repeatable workflow candidates.",
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    const store = new CuratorStore(config.databasePath);

    api.on("agent_end", (event, ctx) => {
      if (!event.success || (!config.includeCron && ctx.jobId)) return;
      const observation = buildObservation({
        messages: event.messages,
        maxExcerptChars: config.maxExcerptChars,
        runId: event.runId || ctx.runId,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        timestamp: Date.now(),
      });
      if (!observation || isHeartbeatText(observation.excerpt)) return;
      if (store.insert(observation)) {
        api.logger.debug(`captured reusable-workflow signal ${observation.id}`);
      }
    }, { timeoutMs: 5_000 });

    api.registerCli(({ program }) => {
      const command = program.command("skill-curator").description("Inspect repeatable workflow candidates");
      command.command("status").description("Show observer state").option("--json", "Output JSON", false).action((options) => {
        const result = { databasePath: config.databasePath, observations: store.count(), reviews: store.reviewCounts(), config };
        process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `Observations: ${result.observations}\nReviews: ${JSON.stringify(result.reviews)}\nDatabase: ${result.databasePath}\n`);
      });
      command.command("report")
        .description("Cluster recent observations and print skill candidates")
        .option("--days <days>", "Lookback window", "30")
        .option("--min-confidence <score>", "Minimum confidence score")
        .option("--min-occurrences <count>", "Minimum matching observations")
        .option("--min-sessions <count>", "Minimum distinct sessions")
        .option("--similarity <score>", "Jaccard similarity threshold")
        .option("--status <status>", "Only print candidates with this review status")
        .option("--ready-only", "Only print ready candidates", false)
        .option("--json", "Output JSON", false)
        .action((options) => {
          const reportConfig = {
            minConfidence: Number(options.minConfidence ?? config.minConfidence),
            minOccurrences: Number(options.minOccurrences ?? config.minOccurrences),
            minSessions: Number(options.minSessions ?? config.minSessions),
            similarityThreshold: Number(options.similarity ?? config.similarityThreshold),
          };
          const report = buildCandidateReport(store.list({ sinceDays: Number(options.days) }), reportConfig, store.listReviews());
          if (options.readyOnly) report.candidates = report.candidates.filter((candidate) => candidate.ready);
          if (options.status) report.candidates = report.candidates.filter((candidate) => candidate.status === options.status);
          process.stdout.write(`${JSON.stringify(report, null, options.json ? 2 : 2)}\n`);
        });
      command.command("review <candidateId> <status>")
        .description("Record a candidate lifecycle decision")
        .option("--note <note>", "Decision note")
        .option("--author <author>", "Decision author", "agent")
        .action((candidateId, status, options) => {
          if (!REVIEW_STATUSES.has(status)) {
            throw new Error(`Unsupported status "${status}". Expected one of: ${[...REVIEW_STATUSES].join(", ")}`);
          }
          store.setReview({ candidateId, status, note: options.note ?? null, author: options.author });
          process.stdout.write(`Candidate ${candidateId} marked ${status}\n`);
        });
      command.command("install-cron")
        .description("Install the daily Skill Workshop proposal sweep cron")
        .option("--cron <expr>", "Cron expression", "20 4 * * *")
        .option("--tz <iana>", "IANA timezone", "Europe/Paris")
        .option("--agent <id>", "Agent id", "main")
        .option("--name <name>", "Cron job name", "Skill Curator proposal sweep")
        .option("--description <text>", "Cron job description")
        .option("--timeout-seconds <count>", "Cron agent timeout seconds", "300")
        .option("--announce", "Announce the cron result instead of silent delivery", false)
        .option("--channel <channel>", "Delivery channel when --announce is used")
        .option("--to <target>", "Delivery target when --announce is used")
        .option("--refresh-existing", "Update existing managed cron jobs instead of returning exists", false)
        .option("--dry-run", "Print the cron add arguments without creating the job", false)
        .option("--json", "Output JSON", false)
        .action((options) => {
          const result = installProposalSweepCron({
            ...options,
            timeoutSeconds: Number(options.timeoutSeconds),
          });
          process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.status}\n`);
        });
      command.command("uninstall-cron")
        .description("Remove Skill Curator proposal sweep cron jobs")
        .option("--dry-run", "Print matching jobs without removing them", false)
        .option("--json", "Output JSON", false)
        .action((options) => {
          const result = uninstallProposalSweepCron(options);
          process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.status}\n`);
        });
    }, { descriptors: [{ name: "skill-curator", description: "Inspect repeatable workflow candidates", hasSubcommands: true }] });
  },
});
