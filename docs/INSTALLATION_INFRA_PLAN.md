# Installation Infrastructure Plan

## Goal
Provide a low-friction setup flow for Windows, macOS, and Linux that users can start from a cloned repo with one command or a double-clickable entrypoint.

## UX target
1. User clones the repo.
2. User runs a single local installer entrypoint.
3. Installer checks prerequisites and fixes what it safely can.
4. Installer prompts only for global installs or auth/provider setup.
5. Installer restores project tooling, installs recommended extras, verifies the result, and prints next steps.

## Architecture
Use **one shared bootstrap core** with thin OS-specific launchers:
- `scripts/bootstrap.mjs` — source of truth for install/update logic
- `install.ps1` + optional `install.cmd` — Windows entrypoints
- `install.sh` + optional `install.command` — macOS/Linux entrypoints

This keeps behavior consistent across platforms without duplicating logic.

## Installer responsibilities
1. Detect OS, shell context, repo root, and write permissions.
2. Check for `node`, `npm`, `pi`, and optional `code`.
3. If `pi` is missing, offer to install it automatically.
4. Set and persist `PI_CODING_AGENT_DIR`.
5. Restore PI packages via `pi update`.
6. Migrate or preserve `auth.json` and local `sessions/` history when applicable, including repair of reachable absolute/`~` legacy `sessionDir` overrides.
7. Make the local session-history model explicit, including sensitivity, working-directory bucketing caveats, git-ignored status, and override precedence (`PI_CODING_AGENT_SESSION_DIR`). Document that relative `sessionDir` overrides require manual cleanup.
8. Check whether PI auth, provider, and default model are configured.
9. If not configured, guide the user through provider/auth setup.
10. Install recommended tools/extensions.
11. Verify the final setup and print a concise summary.

## Product decisions
- **Do not build the VS Code extension on the user machine by default.** Download a CI-built VSIX or publish to the marketplace.
- **Make the installer idempotent.** Rerunning it should update/repair, not duplicate or overwrite important local state.
- **Treat PI session JSONL as first-class local state.** Preserve and migrate `sessions/` locally; do not treat it as disposable cache, but do keep it out of the portable repo state.
- **Be explicit about sensitivity.** `sessions/` can contain raw transcripts and image payloads; users should know that it is local sensitive data and git-ignored by default.
- **Prompt sparingly.** Only ask for consent when installing global dependencies or when user input is required.
- **Treat extension/tooling installs as optional but recommended.** Core PI setup should not fail just because `code` is unavailable.

## Implementation phases
### Phase 1 — Cross-platform bootstrap
- Add `install.sh`
- Refactor current Windows-only logic into `scripts/bootstrap.mjs`
- Reduce `install.ps1` to a thin wrapper
- Add clear logging and failure messages

### Phase 2 — Auth and provider onboarding
- Detect missing auth/provider/model state
- Add guided setup prompts for required missing config
- Make the flow safe to skip and rerun later

### Phase 3 — Extension/tooling distribution
- Build VSIX in CI
- Download/install the prebuilt VSIX during bootstrap
- Add optional recommended extras

### Phase 4 — Release hardening
- Pin versions with a release manifest
- Support update/repair runs cleanly
- Add checksums and release assets for safer installs

## Success criteria
- One local command works on Windows, macOS, and Linux.
- The installer is safe to rerun.
- Session history survives migration/repair runs locally without becoming part of the portable repo state.
- The retention model documents sensitivity, git-ignored status, and working-directory bucketing behavior clearly.
- Missing PI/auth/provider state is detected and handled clearly.
- Core setup succeeds even if optional extras are skipped.
- Users end with a working `pi` setup and clear next steps.
