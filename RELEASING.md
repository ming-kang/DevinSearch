# Releasing DevinSearch

Stable releases are published from `.github/workflows/publish.yml` with npm Trusted Publishing (OIDC). The repository must not contain `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or another npm publishing secret.

## npm Trusted Publisher

One-time configuration on npmjs.com (package Settings → Trusted Publisher):

- Provider: GitHub Actions
- GitHub owner: `ming-kang`
- Repository: `DevinSearch`
- Workflow filename: `publish.yml`
- Environment: empty
- Allowed actions: `npm publish` permitted (direct publishing)

All fields are case-sensitive and a connection cannot be edited after creation; delete and recreate it to change any field. npm can accept an upload while it is still processing the package; public availability may follow later.

## Release checklist

1. Update `package.json` and `package-lock.json` together:

   ```bash
   npm version x.y.z --no-git-tag-version
   ```

2. Move the release notes out of `## [Unreleased]` into `## [x.y.z] - YYYY-MM-DD` and keep an empty `[Unreleased]` section on top.
3. Run `npm run check` and `npm test` locally. CI performs the complete release acceptance.
4. Commit and push the release change to `main`, then wait for CI to pass. CI runs the static checks once, builds one tarball, and runs tests plus an installation smoke check of that same tarball (`search --help`, `search --version`) on Windows, Linux and macOS. The `npm-package` artifact is retained for 14 days.
5. Dispatch **Publish npm** from `main` with the same version:

   ```bash
   gh workflow run publish.yml --repo ming-kang/DevinSearch --ref main -f version="x.y.z"
   gh run watch --repo ming-kang/DevinSearch --exit-status
   ```

   The workflow checks that the requested version matches its source commit, selects successful CI for that exact commit on `main`, downloads its `npm-package` artifact and publishes it with provenance. Missing CI or an expired artifact stops publication; rerun CI to supply the artifact.

   A successful `npm publish` completes publication; the only following steps tag that workflow's source commit as `vx.y.z` and create the GitHub Release from the version's `CHANGELOG.md` section. A green run records an accepted publication without promising immediate registry availability; there are no post-publication registry polls or runtime smoke tests.

## Failed publication

If a pre-publication check fails, fix it and dispatch the workflow again. If `npm publish` fails, inspect its error before retrying; npm versions are immutable, and a processing notice or temporarily missing public version does not authorize another upload.

If `npm publish` succeeded and only tag/Release creation failed, rerun the failed **Tag and create the GitHub Release** job in the original run — tagging and Release creation are idempotent and retain the original run's source commit. Do not redispatch the entire workflow or rerun its successful publish job.

If an accepted package is defective, deprecate it and prepare the next patch version.
