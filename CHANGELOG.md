# Changelog

## 0.3.0 - 2026-06-19

- Add `openclaw skill-curator sweep` to create pending Skill Workshop proposals directly from ready candidates.
- Update the managed proposal sweep cron to call the native sweep command instead of relying on an agent prompt.
- Skip candidates when an equivalent pending Skill Workshop proposal already exists.

## 0.2.1 - 2026-06-18

- Ignore internal cron and dream diary prompts during observation capture and candidate reports.

## 0.2.0 - 2026-06-16

- Prepare the plugin for external packaging.
- Add the optional proposal sweep cron installer.
- Add `install-cron --refresh-existing` for managed cron updates.
- Remove local historical runtime files from the published package.
- Keep Skill Workshop proposal application manual by design.
