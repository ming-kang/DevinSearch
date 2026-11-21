# Releasing

Stable releases are published from `.github/workflows/publish.yml` with npm Trusted Publishing (OIDC). The repository must not contain `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or another npm publishing secret.

## npm Trusted Publisher

One-time setup on npmjs.com (package Settings → Trusted Publisher). All fields are case-sensitive and cannot be edited after creation; delete and recreate to change any.

- Provider: GitHub Actions
- Owner: `ming-kang`; repository: `DevinSearch`; workflow filename: `publish.yml`; environment: empty
- `npm publish` permitted (direct publishing)

npm may accept an upload while still processing the package; public availability can lag.

## Release checklist

1. `npm version x.y.z --no-git-tag-version` — updates `package.json` and `package-lock.json` together.
2. Move the release notes out of `## [Unreleased]` into `## [x.y.z] - YYYY-MM-DD`, keeping an empty `[Unreleased]` section on top.
3. `npm run check` and `npm test` locally; CI performs the full acceptance.
4. Commit and push to `main`, then wait for CI. CI runs the static checks once, builds one tarball, and runs tests plus an install smoke check (`search --help`, `search --version`) on Windows, Linux, and macOS. The `npm-package` artifact is retained for 14 days.
5. Dispatch **Publish npm** from `main` with the same version:

   ```bash
   gh workflow run publish.yml --repo ming-kang/DevinSearch --ref main -f version="x.y.z"
   gh run watch --repo ming-kang/DevinSearch --exit-status
   ```

   The workflow checks the version against its source commit, reuses the successful CI run's `npm-package` artifact for that exact commit, and publishes with provenance. Missing CI or an expired artifact stops publication; rerun CI to supply one. After `npm publish`, a follow-up job tags the source commit `vx.y.z` and creates the GitHub Release from the version's `CHANGELOG.md` section. A green run records an accepted publication; there are no registry polls or runtime smoke tests afterward.

## Failed publication

- A pre-publication check fails → fix it and dispatch the workflow again.
- `npm publish` fails → inspect the error before retrying; npm versions are immutable, and a processing notice or a temporarily missing version does not authorize another upload.
- `npm publish` succeeded but tag/Release failed → rerun only the **Tag and create the GitHub Release** job in the original run; tagging and Release creation are idempotent and keep the original source commit. Do not redispatch the whole workflow or rerun the publish job.
- An accepted package is defective → deprecate it and prepare the next patch version.
