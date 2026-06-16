# Security

Skill Curator observes successful OpenClaw turns and stores redacted workflow
signals locally. It is intended to identify repeatable procedures, not to store
secrets or full transcripts.

## Reporting

For now, report security concerns through GitHub issues while the repository is
private. Before making the repository public, enable GitHub private vulnerability
reporting or add a dedicated security contact.

## Handling Sensitive Data

- Do not include raw secrets in examples, tests, or issue reports.
- Do not publish private SQLite state databases.
- Review candidate evidence before creating or applying reusable skills.
- Keep `includeCron` disabled unless cron-originated prompts should become
  candidates.
