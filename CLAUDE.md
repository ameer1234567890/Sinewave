# Notes for AI coding assistants

Read [CONTRIBUTING.md](CONTRIBUTING.md) first; its rules apply to you too.

- **Bump the version in every pull request**: `player/version.js` and `server/package.json`, same number (fix: 0.4.0 → 0.4.1, feature: 0.4.1 → 0.5.0). Say the new version in the pull request description.
- `main` is protected: work on a branch, open a pull request, and wait for the checks to pass.
- Run `cd server && npm test` before pushing; run the e2e test (`e2e/`) when you change the player, pairing, playlists or offline behaviour.
