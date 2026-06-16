import { createHash } from "node:crypto";

const CORRECTION_PATTERNS = [
  /\b(?:a partir de maintenant|desormais|la prochaine fois|pense a|n'oublie pas de)\b/iu,
  /\b(?:toujours|systematiquement)\b.{0,100}\b(?:utilise|verifie|controle|enregistre|sauvegarde|prefere|demande)\b/iu,
  /\b(?:je prefere|il faut|tu dois)\b.{0,140}\b(?:quand|lorsque|plutot|utiliser|verifier|demander)\b/iu,
  /\b(?:next time|from now on|remember to|make sure to|when asked)\b/iu,
  /\balways\b.{0,80}\b(?:use|check|verify|record|save|prefer)\b/iu,
];

const PROCEDURAL_PATTERNS = [
  /\b(?:analyse|audite|cherche|compare|controle|cree|configure|corrige|deploie|execute|genere|installe|lance|mets a jour|prepare|reinitialise|sauvegarde|verifie)\b/iu,
  /\b(?:analyze|audit|check|compare|configure|create|deploy|execute|fix|generate|install|prepare|reset|run|save|update|verify)\b/iu,
];

const SECRET_PATTERNS = [
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|mot de passe|secret)\b\s*[:=]\s*\S+/giu,
  /\b(?:sk|ghp|glpat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/gu,
  /\b[A-Fa-f0-9]{32,}\b/gu,
];

const STOP_WORDS = new Set([
  "avec", "avoir", "cette", "comme", "dans", "des", "donc", "elle", "faire", "faut", "les", "mais", "nous", "pour", "quand", "que", "qui", "sans", "sur", "une", "vous",
  "about", "after", "before", "from", "have", "into", "that", "the", "then", "this", "with", "your",
]);

const HEARTBEAT_PATTERNS = [
  /^\s*\[openclaw heartbeat poll\]\s*$/iu,
  /^\s*heartbeat_ok\s*$/iu,
  /\bread heartbeat\.md\b/iu,
  /^\s*pre-compaction memory flush\b/iu,
  /\bstore durable memories only in memory\/\d{4}-\d{2}-\d{2}\.md\b/iu,
];

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && typeof item === "object" && ["text", "input_text", "output_text"].includes(item.type))
    .map((item) => typeof item.text === "string" ? item.text : item.text?.value ?? "")
    .filter(Boolean)
    .join("\n");
}

export function extractLatestUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || message.role !== "user") continue;
    const text = extractText(message.content).trim();
    if (text) return text;
  }
  return "";
}

export function countToolCalls(messages) {
  let count = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object" || message.role !== "assistant") continue;
    if (!Array.isArray(message.content)) continue;
    count += message.content.filter((item) => item && typeof item === "object" && ["toolCall", "tool_call"].includes(item.type)).length;
  }
  return count;
}

export function redactText(value) {
  let text = value;
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[EMAIL]")
    .replace(/https?:\/\/\S+/giu, "[URL]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "[IP]");
}

function fold(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase();
}

function stem(token) {
  return token.replace(/(?:ements?|ations?|iques?|istes?|euses?|eurs?|ment|es|s)$/u, "");
}

export function tokenize(value) {
  return [...new Set(
    fold(value)
      .replace(/\[[A-Z]+\]/gu, " ")
      .replace(/[^a-z0-9]+/gu, " ")
      .split(/\s+/u)
      .map(stem)
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  )].sort();
}

export function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function isHeartbeatText(text) {
  return HEARTBEAT_PATTERNS.some((pattern) => pattern.test(text));
}

export function classifyRequest(text, toolCount = 0) {
  const folded = fold(text).replace(/\s+/gu, " ").trim();
  const correction = CORRECTION_PATTERNS.some((pattern) => pattern.test(folded));
  const procedural = toolCount > 0 || PROCEDURAL_PATTERNS.some((pattern) => pattern.test(folded));
  return { correction, procedural };
}

export function buildObservation({ messages, maxExcerptChars, runId, agentId, sessionKey, timestamp }) {
  const rawText = extractLatestUserText(messages);
  if (rawText.length < 20 || rawText.length > 8000) return null;
  if (isHeartbeatText(rawText)) return null;
  const toolCount = countToolCalls(messages);
  const classification = classifyRequest(rawText, toolCount);
  if (!classification.procedural && !classification.correction) return null;

  const redacted = redactText(rawText).replace(/\s+/gu, " ").trim();
  const tokens = tokenize(redacted);
  if (tokens.length < 2) return null;

  const sessionHash = createHash("sha256").update(sessionKey || "unknown").digest("hex").slice(0, 16);
  const normalized = tokens.join(" ");
  return {
    id: runId || createHash("sha256").update(`${timestamp}:${sessionHash}:${normalized}`).digest("hex").slice(0, 32),
    observedAt: timestamp,
    day: new Date(timestamp).toISOString().slice(0, 10),
    agentId: agentId || "unknown",
    sessionHash,
    excerpt: redacted.slice(0, maxExcerptChars),
    normalized,
    tokens,
    correction: classification.correction,
    procedural: classification.procedural,
    toolCount,
  };
}

export function clusterObservations(observations, threshold) {
  const clusters = [];
  for (const observation of observations) {
    let best = null;
    for (const cluster of clusters) {
      const score = jaccard(observation.tokens, cluster.tokens);
      if (!best || score > best.score) best = { cluster, score };
    }
    if (!best || best.score < threshold) {
      clusters.push({ tokens: observation.tokens, observations: [observation] });
      continue;
    }
    best.cluster.observations.push(observation);
    best.cluster.tokens = tokenize(best.cluster.observations.map((item) => item.normalized).join(" "));
  }
  return clusters;
}
