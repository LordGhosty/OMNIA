# Release identity and signing

## Reporting a vulnerability

Open the [repository’s Security tab](https://github.com/LordGhosty/OMNIA/security). If **Report a vulnerability** is available, send the affected version, impact and steps to reproduce privately. If private reporting is unavailable, ask the maintainer for a private contact channel before sharing exploit details. Exclude signing keys, passwords and personal files from reports.

## What the badge means

The footer shows UNVALIDATED SOFTWARE unless verification succeeds. CHECKING SOFTWARE is temporary. RELEASE SIGNATURE VERIFIED means the file inventory matches the pinned OMNIA RSA-4096 release key, app version, OS and architecture, and every listed file matches its SHA-256 digest. Signatures use RSA PKCS#1 v1.5 with SHA-256 through the platform cryptography libraries. This is an application release identity, not a Windows-certified publisher identity. Windows may display Unknown Publisher or block unsigned executables under its security policies.

On Windows, verification also rejects extra executable, script and application archive files in the install tree. The setup-created uninstaller and late-added update elevation helper have separate release signatures bound to their role and application version.

The file check runs in a worker thread after the opening animation. No integrity result is restored from an editable cache; each launch checks again. This is a point-in-time check, not continuous monitoring, proof of reproducibility, antivirus scanning or a guarantee about later-loaded files. Packaged own-key releases cannot enable administrator access until verification passes. Verification failures do not delete files, disable Windows or deliberately damage the installation.

**An application cannot be its own independent trust authority.** A malicious fork can replace the verifier, public key or displayed text. Obtain the initial installer and Validator from the official repository and confirm the key fingerprint through a separately trusted channel. A fake Validator can lie too. An unchanged official installer shared by another person remains verifiable. A signature proves authorization by a key, not harmless behavior.

## Current state

Version 0.0.3 introduces the owner-controlled release key and GitHub update feed. No Authenticode certificate is configured. The SHA-256 fingerprint of the public key's DER SubjectPublicKeyInfo is `e9b77e3c35c7139f88b22eb72de271fde4039562b715a6da5be173b25b067d2f`. Tests use separate temporary keys.

## Key custody

- Keep the release private key outside the repository, application, USB exports and downloadable artifacts. Use a protected secret store, encrypted backup and restricted signing access. Never paste private keys into chat or commit them.
- The local private key is DPAPI-encrypted for the current Windows account at `%LOCALAPPDATA%/OMNIA Signing/release-key.dpapi`. This does not protect against malicious code already running as that user. Only the PEM public key is committed in `assets/release-trust.json`.
- Create a portable encrypted backup with `node scripts/release-key.cjs backup <path-outside-project.pem>` from an interactive terminal. The hidden passphrase prompt requires at least 16 characters. Store the backup offline and its passphrase separately. Restore on a new Windows account with `node scripts/release-key.cjs restore <backup.pem>`; a mismatched identity is rejected. A DPAPI file alone is not a portable backup.
- For protected CI signing, supply the encrypted PEM as base64 in `OMNIA_RELEASE_PRIVATE_KEY` and its passphrase in `OMNIA_RELEASE_KEY_PASSWORD`. This is optional; local signing keeps the key off GitHub. Never expose signing secrets to pull-request jobs.
- Keep this key stable. Rotation requires a deliberately signed transition while the old key is still available; automatic key discovery or replacement from GitHub is not supported. If the key is lost, a trusted manual reinstall may be needed. If it is compromised, it can authorize malicious updates: stop signing/publishing, announce the compromise through independent channels and distribute a new trust baseline. This design does not provide threshold signatures or compromise recovery from an offline root key.

## Build order

1. Review source, dependencies, license/source obligations and build configuration. Official signing must not be exposed to pull requests or arbitrary workflows.
2. Configure the public identity and an explicit higher version using `scripts/configure-release.cjs`. It checks that the repository matches the pinned identity.
3. Build with `OMNIA_OFFICIAL_RELEASE=1` and the protected key. The finalized application inventory is signed before installer assembly; generated helpers and completed installer assets receive detached signatures. This does not add Authenticode signatures. The Linux signing path still requires native Linux validation; automatic installation/recovery is currently Windows-only.
4. Run packaged checks and verify the installer signature independently before publishing. Publish exact corresponding source/build information, dependency notices and checksums through the official channel. A plain checksum downloaded alongside a malicious file is not an independent proof of identity.

The GitHub workflow uses an official-release environment for explicit release builds. Reviewers, branch restrictions and secret permissions must be configured by the owner; the environment name alone provides no protection. Missing signing credentials fail official builds. Development builds do not consume signing secrets.

Official installers, detached signatures and update metadata are distributed through [OMNIA Releases](https://github.com/LordGhosty/OMNIA/releases). The standalone Windows Validator can check an installer before installation. macOS packaging and notarization are unconfigured. Linux inventory verification identifies the project’s release key.

## Tool permissions and containment

Each tool receives an independent loopback session and an IPC identity tied to its main renderer frame. A supplied tool name cannot change that identity. HTTP routes, IPC actions, preview/output ownership and administrator operations are checked against the calling tool. Speed Test cannot request network changes; File Search cannot request rename or duplicate removal. The core owns the final native confirmation for privileged operations. Duplicate removal consumes a single-use batch approval for the exact reviewed paths.

On Windows, each backend joins an unnamed Job Object before tool initialization. Its normal child processes inherit the job, with a combined 2 GiB committed-memory ceiling and a 32-process limit. Closing the guard, losing the backend or losing the core terminates that process tree. Failure to establish containment prevents the tool from starting. The guard uses Windows APIs available on both Windows 10 and 11 and adds no separate runtime bundle. Linux does not currently use this Windows process-tree/memory guard.

Job Objects provide lifetime and resource containment, not filesystem or network access control. Tool backends still run as the current user; arbitrary compromised native code can access that user's files and may use OS services outside the normal child-process tree. Renderer processes have Electron sandboxing but are not part of the backend memory job. The limit is per backend, not an application-wide RAM guarantee. A rejected allocation may produce a tool error or a quarantined process; it cannot make every out-of-memory situation recoverable.

The elevated helper checks that its named-pipe server belongs to the core process before authenticating the session. Core-owned dialogs review system changes independently of tool-owned confirmation tokens. Windows rechecks target identities before mutation. This is defense in depth, not protection against an already compromised core or another program controlling the user's session.

## Update and recovery boundaries

Automatic updates use explicitly published stable GitHub releases, never arbitrary commits or pull requests. The signed `OMNIA-update.json` is verified before checking the updater listing. Version, product, repository, OS, architecture, role, size and SHA-256 are signed. The installer is verified after download and again before installation. Equal/older versions cannot be installed through the updater, and the highest observed signed feed version is remembered locally. Signed update metadata expires after 90 days; publish a newer release before expiry. Expired or unavailable metadata yields an error, not an authenticated claim that the app is up to date. The local clock must be correct. Replay within the validity window before a newer version has been observed remains possible.

Installation also requires a verified recovery installer of the current release. Missing recovery assets or verification failures block installation. Recovery and manual Validator checks accept an expired signature as historical proof of file authenticity; they do not treat it as permission for a new automatic update. No GitHub credential is embedded in the app.

The update button checks for a release, downloads it on request, and offers a restart. Installation runs silently and preserves the installed component choices and user settings. Active tool operations postpone installation. Downloads are never installed just because the user closes the app.

### Enabling the release feed

The repository is `LordGhosty/OMNIA`. Version 0.0.3 is the first update-enabled baseline. Windows publisher signing is optional and is not used by the current release-key policy.

1. Back up the release key. Verify that the public identity in `assets/release-trust.json` matches the independently retained fingerprint.
2. For the locally signed 0.0.3 package, push the reviewed source commit and select that commit as the target for the new `v0.0.3` tag. Create a regular release and mark it as the latest release so the updater can resolve `releases/latest`.
3. For future builds signed in GitHub Actions, protect the `official-release` and `release-review` environments and restrict signing secrets to the signing environment. Run Build OMNIA from the reviewed default branch with Publish enabled, Beta disabled and a new stable version higher than the source version. The workflow prepares a draft for review.
4. Keep `OMNIA-update.json`, `latest.yml`, `OMNIA-<version>-Setup.exe`, its `.exe.sig` and matching `.exe.blockmap` together. Include `OMNIA-Validator.exe` and its `.sig`, the matching source archive, dependency notices and checksums. Do not edit signatures or version metadata by hand.
5. Publish the verified baseline under `v<version>` and install it manually once. Existing 0.0.2 installations have updates disabled and cannot update themselves into this baseline.
6. Build a second, higher stable version and test check, download, restart, retained settings/components and recovery on disposable Windows installations before publishing it for users. Keep the baseline release and installer available: they are the recovery source for machines updating from it.

Each update needs a new application version and release tag. Replacing an installer under the same version or pushing a source commit is not an update.

OMNIA Recovery is a separate small Windows executable covered by the application inventory. It checks the cached installer's detached signature against its compiled public key before asking to reinstall. It can run when Electron cannot start. The recovery cache retains one installer plus its signature, not another runtime copy in every tool.

Tool isolation contains many crashes and hangs, but it does not make arbitrary native code safe. Tool processes run with normal user permissions. Administrative operations use a separate authenticated, fixed-operation broker. A page failure does not roll back an already started Windows operation. Memory exhaustion, operating-system failures, compromised signing credentials and defects in the shared shell need separate mitigation and may require reinstalling.

The packaged 0.0.3 Hub verified its inventory on Windows 11 x64. Both native utilities verified the release installer. An installed upgrade and restore between two distinct signed releases still needs testing on a disposable Windows system.

## Verifying a download

Obtain the standalone Validator through the official release channel. Download the selected executable's matching `.sig` into the same folder, choose the executable, optionally paste its SHA-256, and select Verify file. The utility hashes it and verifies its signed release identity using Windows cryptography while holding the executable open. The result covers that file, not its source or Windows publisher identity. Launching the installed app separately checks its file inventory. A checksum match alone is not signature verification.

The initial key was provisioned with the following command. Do not run it to replace an existing identity.

```sh
node scripts/release-key.cjs init
```

Protect the default branch and require approval on the official-release and release-review environments. Complete the corresponding-source bundle and review third-party notices before publishing a draft.

## License and branding

Source remains GPL-3.0-or-later. TRADEMARKS.md documents permitted identification, verbatim redistribution and the separation between independent forks and official branding. It does not register a trademark or override the GPL. THIRD_PARTY.md lists outstanding dependency/source-distribution work; an authenticity badge does not establish license compliance.
