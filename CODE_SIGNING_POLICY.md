# Code Signing Policy

This document describes how release binaries of **vsgo** are built, signed and
distributed. It is published to satisfy the transparency requirements of the
[SignPath Foundation](https://signpath.org/terms.html) free code signing program
and to let anyone verify that a downloaded binary came from this repository.

Project repository: <https://github.com/EliasSantiago/vsgo>
Maintainer contact: contato@orkestrai.com.br

---

## 1. What vsgo is

vsgo is an AI-first IDE derived from [Code – OSS](https://github.com/microsoft/vscode),
the open source core of Visual Studio Code, licensed under the MIT license. It
embeds a coding agent that runs on the user's own API keys (BYOK) or on locally
hosted models. vsgo is an independent project and is not affiliated with or
endorsed by Microsoft.

All source code, build scripts and CI configuration are public in the repository
above. The project contains no proprietary, closed-source or dual-licensed
components. The bundled built-in extensions (`ms-vscode.js-debug`,
`ms-vscode.js-debug-companion`, `ms-vscode.vscode-js-profile-table`) are MIT
licensed and are downloaded from their public GitHub releases, pinned by version
and verified by SHA-256 in [`product.json`](product.json).

## 2. What gets signed

Only release artifacts produced by the project's public CI are submitted for
signing:

| Artifact | Description |
|---|---|
| `vsgoUserSetup-x64-<version>.exe` | Windows per-user installer (no administrator rights) |
| `vsgoSystemSetup-x64-<version>.exe` | Windows all-users installer (requires elevation) |
| `vsgo.exe` and bundled PE binaries (`*.dll`, `*.node`) | Application executables packaged inside the installers |

Nothing else is signed. In particular, no artifact built on a developer
workstation, no third-party binary, and no artifact from a fork or from an
unreviewed pull request is ever submitted for signing.

## 3. Build and signing process

Releases are built exclusively by GitHub Actions from the
[`release.yml`](.github/workflows/release.yml) workflow in this repository. The
workflow is triggered only by pushing a `v*` tag to the default branch, or by a
manual dispatch, both of which are restricted to maintainers.

1. The workflow checks out the tagged commit of this repository.
2. Dependencies are installed with `npm ci` from the committed `package-lock.json`.
3. Built-in extensions are downloaded and verified against the SHA-256 hashes
   pinned in `product.json`.
4. The Windows application is compiled on a `windows-2022` runner. Native modules
   are compiled on the target operating system; cross-compilation is explicitly
   rejected by the build script.
5. The application binaries are submitted to the signing service and the signed
   binaries are returned to the workflow.
6. The Inno Setup installers are assembled from the signed binaries
   (`scripts/build-win.sh --skip-build --all`).
7. The resulting installers are submitted to the signing service for a second
   signature.
8. Signed installers are published as workflow artifacts and attached to the
   GitHub release for the corresponding tag.

Product name and version metadata are set from `product.json` and
`package.json` by [`build/win32/code.iss`](build/win32/code.iss) (`AppName`,
`AppVersion`, `VersionInfoVersion`) and are consistent across every signed
artifact of a release.

Signing requests are **approved manually** by an Approver (see below) for every
release. No automated or unattended signing is configured.

## 4. Team and roles

The project is currently maintained by a single maintainer, who is also the sole
Approver. Roles are defined as follows:

- **Authors** — anyone who proposes changes to the source code, via pull request.
  External contributions are accepted.
- **Reviewers** — maintainers. Every change originating from outside the
  maintainer team is reviewed by a maintainer before it is merged into the
  default branch. No contribution reaches a release without passing through this
  review.
- **Approvers** — maintainers with release authority. An Approver creates the
  release tag and manually approves each signing request. Only an Approver can
  publish a GitHub release.

| Role | Held by |
|---|---|
| Author | Any contributor |
| Reviewer | [@EliasSantiago](https://github.com/EliasSantiago) |
| Approver | [@EliasSantiago](https://github.com/EliasSantiago) |

If the maintainer team grows, this table is updated in the same commit that
grants the new permissions.

## 5. Account security

All accounts with write access to this repository, and all accounts with access
to the signing service, have **multi-factor authentication enabled**. Signing
service API tokens are stored as GitHub Actions encrypted secrets, are scoped to
this repository, and are never exposed to workflows triggered by pull requests
from forks.

## 6. Distribution

Signed releases are distributed only from:

- GitHub Releases: <https://github.com/EliasSantiago/vsgo/releases>
- The project download page served from the release manifest generated by
  `scripts/make-manifest.sh`

Every release includes a `SHA256SUMS.txt` file listing the SHA-256 hash of each
artifact. Users can verify a download with:

```bash
sha256sum -c SHA256SUMS.txt      # Linux
shasum -a 256 -c SHA256SUMS.txt  # macOS
```

On Windows, the signature of an installer can be inspected through
**Properties → Digital Signatures**, or with PowerShell:

```powershell
Get-AuthenticodeSignature .\vsgoUserSetup-x64-<version>.exe | Format-List
```

Binaries obtained from any other source are not signed by this project and should
not be trusted.

## 7. Privacy

vsgo collects no telemetry and sends no data to servers operated by this project.

The user's source code leaves their machine only when they explicitly configure a
remote AI provider, in which case requests go directly from the user's machine to
that provider using the user's own API key. API keys are stored in the operating
system's credential store. When local models are used, no data leaves the machine.

The project operates no backend service. It therefore collects, stores and
processes no personal data of its users.

Full privacy policy: <https://vsgo.orkestrai.com.br/privacidade>
Terms of use: <https://vsgo.orkestrai.com.br/termos>

## 8. Attribution

Free code signing provided by [SignPath.io](https://signpath.io), certificate by
[SignPath Foundation](https://signpath.org).
