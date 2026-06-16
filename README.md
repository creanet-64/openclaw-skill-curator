# Skill Curator

Skill Curator is a passive learning plugin for OpenClaw.

It watches successful agent conversations, detects tasks that keep coming back, and suggests them as reusable skill candidates. In practice, it helps OpenClaw notice patterns such as "the user often asks me to check Proxmox backups" and turn that repeated workflow into a pending Skill Workshop proposal.

The goal is not to let the agent create or enable skills on its own. The plugin learns from repetition, prepares a candidate, and leaves the final decision to a human.

## What it does

Skill Curator turns repeated successful work into reviewable skill proposals:

- it observes normal OpenClaw agent turns after they finish successfully;
- it stores redacted snippets of procedural requests and outcomes;
- it clusters similar observations across sessions;
- it scores repeated workflows by confidence;
- it reports candidates that look stable enough to become skills;
- optionally, a daily cron can create pending Skill Workshop proposals for ready candidates.

## What it does not do

Skill Curator deliberately separates learning from activation:

- observations are redacted snippets from successful procedural turns;
- candidates are clustered observations with stable-ish IDs and confidence scores;
- reviews record lifecycle decisions: `observed`, `proposed`, `approved`, `rejected`, `rolled_back`;
- promotion into a real skill stays outside the observer and should go through the normal Skill Workshop flow.

It never applies, installs, or enables a generated skill automatically.

## CLI

```bash
openclaw skill-curator status
openclaw skill-curator report --ready-only
openclaw skill-curator review skill-0123456789abcdef proposed --note "Candidate for Skill Workshop"
openclaw skill-curator install-cron --json
openclaw skill-curator uninstall-cron --json
```

## Review flow

Use Skill Curator as a detector, not as an automatic installer.

1. Let normal agent turns accumulate observations.
2. List candidates:

```bash
openclaw skill-curator report --json
openclaw skill-curator report --ready-only --json
```

3. When a candidate is `ready` and `recommendation` is `propose`, inspect its evidence.
4. Create or revise a Skill Workshop proposal from the candidate.
5. Mark the candidate lifecycle state:

```bash
openclaw skill-curator review skill-0123456789abcdef proposed \
  --note "Converted to Skill Workshop proposal <proposal-id>" \
  --author main
```

6. Apply, reject, or quarantine the Skill Workshop proposal only after explicit human approval.

The expected lifecycle is:

```text
observed -> proposed -> approved|rejected|rolled_back
```

`approved` means the candidate has already been handled outside Skill Curator. It does not install or activate a skill by itself.

## Proposal sweep cron

The observer hook captures signals automatically, but reports and Skill Workshop proposals are not created unless something checks the report.

Install the optional daily sweep:

```bash
openclaw skill-curator install-cron --json
```

Defaults:

- schedule: `20 4 * * *`
- timezone: `Europe/Paris`
- agent: `main`
- session target: `isolated`
- delivery: none

The installed cron asks an isolated agent to:

- run `openclaw skill-curator report --ready-only --json`;
- ignore candidates already `proposed`, `approved`, or `rejected`;
- create compact pending Skill Workshop proposals for new `ready` candidates with `recommendation: propose`;
- mark converted candidates as `proposed`;
- never apply proposals automatically.

The installer is idempotent. It detects existing jobs with the marker `managed-by=skill-curator.proposal-sweep`.

Dry-run:

```bash
openclaw skill-curator install-cron --dry-run --json
```

Update an existing managed sweep after changing defaults:

```bash
openclaw skill-curator install-cron --refresh-existing --json
```

Remove managed sweep jobs:

```bash
openclaw skill-curator uninstall-cron --json
```

## Install

From a local checkout:

```bash
openclaw plugins install ./plugins/skill-curator --link
openclaw plugins inspect skill-curator --runtime --json
```

After enabling or updating the plugin, restart or reload the Gateway so the startup hook is loaded by the running Gateway.

## Publish

Before publishing, choose the final package owner/name. For ClawHub, scoped package names must match the publisher owner.

Validate locally:

```bash
npm test
openclaw plugins inspect skill-curator --runtime --json
openclaw skill-curator install-cron --dry-run --json
```

Publish with ClawHub:

```bash
npm i -g clawhub
clawhub login
clawhub package publish <owner>/openclaw-skill-curator --dry-run
clawhub package publish <owner>/openclaw-skill-curator
```

Users can then install with:

```bash
openclaw plugins install clawhub:<owner>/openclaw-skill-curator
```

## End-to-end test

Use a neutral demo workflow when testing the plugin. Do not rely on local scripts, private infrastructure, or machine-specific examples.

Example prompt:

```text
TEST_SKILL_CURATOR_DEMO: Check this demo release checklist and report missing items, risks, and next action: docs ready, tests pending, rollback plan missing.
```

### Quick detector test

Use this when you only want to confirm that observation capture and clustering work.

1. Send the example prompt once in a normal OpenClaw chat.
2. Run the report with relaxed thresholds:

```bash
openclaw skill-curator report \
  --ready-only \
  --min-occurrences 1 \
  --min-sessions 1 \
  --min-confidence 0.3 \
  --json
```

Expected result:

- the report is not empty;
- a candidate references the demo release checklist request;
- the candidate has `recommendation: "propose"` when it passes the relaxed thresholds.

These relaxed thresholds are for testing only. They are intentionally noisier than the production defaults.

### Full readiness test

Use this when you want to test the real readiness behavior.

1. Open three separate OpenClaw sessions.
2. In each session, send the same demo prompt or a very close variation.
3. Run:

```bash
openclaw skill-curator report --ready-only --json
```

Expected result:

- the report contains one ready candidate for the demo release checklist workflow;
- the candidate shows at least three observations;
- the candidate shows at least two distinct sessions;
- the candidate status is `observed`;
- the candidate recommendation is `propose`.

If the report is empty, verify that the prompts were sent in distinct OpenClaw sessions. A `/reset` may clear chat context while keeping the same `sessionKey`, so it may still count as one session.

## Confidence

The report score combines repeat count, distinct sessions, explicit corrections, day spread, and tool usage. A candidate is `ready` only when it passes the configured minimum occurrence/session thresholds and `minConfidence`.

Default readiness thresholds:

- `minOccurrences`: 3
- `minSessions`: 2
- `minConfidence`: 0.7
- `similarityThreshold`: 0.5

For local testing inside a single session, lower the session threshold explicitly:

```bash
openclaw skill-curator report --ready-only --min-sessions 1 --min-confidence 0.5 --json
```

Do not use those relaxed thresholds as the default unless noisy candidate generation is acceptable.

## Session behavior

`minSessions` counts distinct OpenClaw `sessionKey` values. A `/reset` can clear or compact conversation context while keeping the same `sessionKey`; it will still count as the same session.

To test multi-session readiness, use a genuinely new chat/session or another channel that produces a different `sessionKey`. Confirm the active key from the UI `/status` output or the OpenClaw `session_status` / `sessions_list` tools.

## Safety and filtering

Captured observations are redacted before storage. Heartbeat and memory-flush messages are ignored before candidate generation and by the SQLite insert trigger. Keep promotion decisions in Skill Workshop so the human can inspect the proposed procedure before anything becomes durable runtime behavior.
