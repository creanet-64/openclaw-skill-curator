import { createHash } from "node:crypto";
import { clusterObservations, isIgnoredObservationText } from "./analysis.js";

function candidateKeyFor(cluster) {
  const [first, ...rest] = cluster.observations.map((item) => new Set(item.tokens));
  if (!first) return "empty";

  const common = [...first].filter((token) => rest.every((tokens) => tokens.has(token)));
  const signatureTokens = (common.length >= 2 ? common : cluster.tokens).slice(0, 14);
  return signatureTokens.join(" ");
}

function candidateIdFor(key) {
  return `skill-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function confidenceFor({ occurrences, sessions, days, corrections, toolCalls }, config) {
  const occurrenceScore = Math.min(1, occurrences / config.minOccurrences);
  const sessionScore = Math.min(1, sessions / config.minSessions);
  const correctionScore = occurrences === 0 ? 0 : Math.min(1, corrections / occurrences);
  const dayScore = Math.min(1, days / 3);
  const toolScore = Math.min(1, toolCalls / Math.max(1, occurrences));

  return Number((
    occurrenceScore * 0.35 +
    sessionScore * 0.30 +
    correctionScore * 0.20 +
    dayScore * 0.10 +
    toolScore * 0.05
  ).toFixed(3));
}

export function buildCandidateReport(observations, config, reviews = new Map()) {
  const candidateObservations = observations.filter((observation) => !isIgnoredObservationText(observation.excerpt));
  const clusters = clusterObservations(candidateObservations, config.similarityThreshold)
    .map((cluster) => {
      const sessions = new Set(cluster.observations.map((item) => item.sessionHash));
      const days = new Set(cluster.observations.map((item) => item.day));
      const corrections = cluster.observations.filter((item) => item.correction).length;
      const occurrences = cluster.observations.length;
      const toolCalls = cluster.observations.reduce((sum, item) => sum + item.toolCount, 0);
      const key = candidateKeyFor(cluster);
      const id = candidateIdFor(key);
      const confidence = confidenceFor({ occurrences, sessions: sessions.size, days: days.size, corrections, toolCalls }, config);
      const structurallyReady = occurrences >= config.minOccurrences && sessions.size >= config.minSessions;
      const ready = structurallyReady && confidence >= config.minConfidence;
      const review = reviews.get(id) ?? { status: "observed", note: null, author: null, updatedAt: null };
      return {
        id,
        key,
        ready,
        confidence,
        status: review.status,
        review,
        recommendation: ready && ["observed", "rolled_back"].includes(review.status) ? "propose" : "hold",
        occurrences,
        sessions: sessions.size,
        days: days.size,
        corrections,
        toolCalls,
        representative: cluster.observations.at(-1).excerpt,
        evidence: cluster.observations.slice(-5).map((item) => ({
          day: item.day,
          agentId: item.agentId,
          excerpt: item.excerpt,
          correction: item.correction,
        })),
      };
    })
    .sort((left, right) => Number(right.ready) - Number(left.ready) || right.occurrences - left.occurrences || right.corrections - left.corrections);

  return {
    schema: "openclaw.skill-curator.report.v2",
    generatedAt: new Date().toISOString(),
    thresholds: {
      minOccurrences: config.minOccurrences,
      minSessions: config.minSessions,
      minConfidence: config.minConfidence,
      similarityThreshold: config.similarityThreshold,
    },
    observations: candidateObservations.length,
    candidates: clusters,
  };
}
