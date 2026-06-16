import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class CuratorStore {
  constructor(databasePath) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        observed_at INTEGER NOT NULL,
        day TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_hash TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        normalized TEXT NOT NULL,
        tokens_json TEXT NOT NULL,
        correction INTEGER NOT NULL,
        procedural INTEGER NOT NULL,
        tool_count INTEGER NOT NULL
      );
	      CREATE INDEX IF NOT EXISTS observations_day_idx ON observations(day);
	      CREATE INDEX IF NOT EXISTS observations_session_idx ON observations(session_hash);
	      CREATE TABLE IF NOT EXISTS candidate_reviews (
	        candidate_id TEXT PRIMARY KEY,
	        status TEXT NOT NULL,
	        note TEXT,
	        author TEXT,
	        updated_at INTEGER NOT NULL
	      );
	      CREATE TABLE IF NOT EXISTS candidate_events (
	        id INTEGER PRIMARY KEY AUTOINCREMENT,
	        candidate_id TEXT NOT NULL,
	        status TEXT NOT NULL,
	        note TEXT,
	        author TEXT,
	        created_at INTEGER NOT NULL
	      );
      CREATE INDEX IF NOT EXISTS candidate_events_candidate_idx ON candidate_events(candidate_id);
      CREATE TRIGGER IF NOT EXISTS observations_ignore_heartbeats
      BEFORE INSERT ON observations
      WHEN NEW.excerpt LIKE '%[OpenClaw heartbeat poll]%'
        OR NEW.excerpt LIKE '%HEARTBEAT_OK%'
        OR NEW.excerpt LIKE '%Read HEARTBEAT.md%'
        OR NEW.excerpt LIKE 'Pre-compaction memory flush%'
        OR NEW.excerpt LIKE '%Store durable memories only in memory/%.md%'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
	    `);
    this.insertStatement = this.db.prepare(`
      INSERT OR IGNORE INTO observations (
        id, observed_at, day, agent_id, session_hash, excerpt, normalized,
        tokens_json, correction, procedural, tool_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  listReviews() {
    return new Map(this.db.prepare(`
      SELECT candidate_id, status, note, author, updated_at
      FROM candidate_reviews
    `).all().map((row) => [row.candidate_id, {
      status: row.status,
      note: row.note,
      author: row.author,
      updatedAt: row.updated_at,
    }]));
  }

  reviewCounts() {
    return this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM candidate_reviews
      GROUP BY status
      ORDER BY status ASC
    `).all().reduce((counts, row) => {
      counts[row.status] = Number(row.count);
      return counts;
    }, {});
  }

  setReview({ candidateId, status, note = null, author = "agent", timestamp = Date.now() }) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT INTO candidate_reviews (candidate_id, status, note, author, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(candidate_id) DO UPDATE SET
          status = excluded.status,
          note = excluded.note,
          author = excluded.author,
          updated_at = excluded.updated_at
      `).run(candidateId, status, note, author, timestamp);

      this.db.prepare(`
        INSERT INTO candidate_events (candidate_id, status, note, author, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(candidateId, status, note, author, timestamp);

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  insert(observation) {
    const result = this.insertStatement.run(
      observation.id,
      observation.observedAt,
      observation.day,
      observation.agentId,
      observation.sessionHash,
      observation.excerpt,
      observation.normalized,
      JSON.stringify(observation.tokens),
      observation.correction ? 1 : 0,
      observation.procedural ? 1 : 0,
      observation.toolCount,
    );
    return Number(result.changes) > 0;
  }

  list({ sinceDays = 30 } = {}) {
    const cutoff = Date.now() - sinceDays * 86_400_000;
    return this.db.prepare(`
      SELECT id, observed_at, day, agent_id, session_hash, excerpt, normalized,
             tokens_json, correction, procedural, tool_count
      FROM observations
      WHERE observed_at >= ?
      ORDER BY observed_at ASC
    `).all(cutoff).map((row) => ({
      id: row.id,
      observedAt: row.observed_at,
      day: row.day,
      agentId: row.agent_id,
      sessionHash: row.session_hash,
      excerpt: row.excerpt,
      normalized: row.normalized,
      tokens: JSON.parse(row.tokens_json),
      correction: Boolean(row.correction),
      procedural: Boolean(row.procedural),
      toolCount: row.tool_count,
    }));
  }

  count() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM observations").get().count);
  }

  close() {
    this.db.close();
  }
}
