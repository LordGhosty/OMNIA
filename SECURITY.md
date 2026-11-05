# Release identity and signing

## What the badge means

The footer shows UNVALIDATED SOFTWARE unless verification succeeds. CHECKING SOFTWARE is a temporary background state. VALIDATED SOFTWARE means the signed file inventory matches the pinned Ed25519 release public key, app version, OS and architecture, and every listed file matches its SHA-256 digest. On Windows, the main executable must also have a valid Authenticode signature whose certificate SHA-256 fingerprint is pinned in assets/release-trust.json. The public key, expected publisher name and certificate fingerprints are public configuration, not secrets.

On Windows, verification also rejects extra executable, script and application archive files in the install tree. The setup-created uninstaller is checked separately against the expected publisher.

The file check runs in a worker thread after the opening animation. No integrity result is restored from an editable cache; each launch checks again. This is a point-in-time check of listed files, not continuous monitoring, proof of source reproducibility, a vulnerability audit, antivirus scan or a guarantee about later-loaded files. Administrator access is still an explicit user decision.

**An application cannot be its own independent trust authority.** A malicious fork can replace the verifier, public key or displayed text. Users must obtain the expected publisher identity from a trusted official channel and inspect the OS-verified installer signature before executing unknown software. An unchanged official installer shared by another person remains signed. A signature identifies the signing identity and signed content; it does not guarantee harmless behavior.

## Current state

This 0.0.2 development build is unsigned. No official release key or Windows publisher certificate has been configured. No real signing key has been generated or installed by the implementation work. The badge therefore remains UNVALIDATED SOFTWARE. Tests generate temporary keys only to exercise success and failure paths; those keys are not production credentials.

## Key custody

- Keep the release private key outside the repository, application, USB exports and downloadable artifacts. Use a protected secret store, encrypted backup and restricted signing access. Never paste private keys into chat or commit them.
- Use an Ed25519 key pair for the release inventory; only its PEM public key goes into assets/release-trust.json. Supply the encrypted PEM private key as base64 in OMNIA_RELEASE_PRIVATE_KEY and its passphrase in OMNIA_RELEASE_KEY_PASSWORD through a protected release environment.
- Obtain an OS-trusted Windows signing identity through an appropriate certificate/signing provider. The release inventory key is not an Authenticode certificate and does not establish Windows publisher trust.
- Set windowsPublisherName to the certificate's publisher name, and windowsCertificateSha256 to the allowed SHA-256 fingerprints of its DER certificate. These pins must be deliberately updated for certificate renewal; plan a signed transition before expiry. A change of provider may require a different signing integration.
- Configure Windows signing through electron-builder's supported signing settings/secret store. Do not use a self-signed testing certificate as proof of public publisher trust. Timestamp production signatures. Windows revocation/chain checks can fail when required trust information is unavailable; the badge then stays unvalidated.

## Build order

1. Review source, dependencies, license/source obligations and build configuration. Official signing must not be exposed to pull requests or arbitrary workflows.
2. Configure the public trust identity and an explicit higher release version. scripts/configure-release.cjs rejects publishing without the trust configuration and enables mandatory Windows code signing and update-signature verification.
3. Build with OMNIA_OFFICIAL_RELEASE=1 and protected signing credentials. Windows signs the application first; after-sign.cjs verifies its expected certificate, then signs a manifest covering the packaged files. Linux signs its inventory when AppImage assembly starts, after executable fuses have been finalized. The installer/AppImage is assembled afterward; Windows installer signing is mandatory for an official Windows build. The Linux signing path still requires native Linux validation.
4. Run packaged checks and verify the installer signature independently before publishing. Publish exact corresponding source/build information, dependency notices and checksums through the official channel. A plain checksum downloaded alongside a malicious file is not an independent proof of identity.

The prepared GitHub workflow uses an official-release environment for explicit release builds. Its required reviewers, deployment branch restrictions, protected branches and secret permissions must be configured in GitHub by the owner before signing. A workflow environment name alone does not create those protections. The Windows code-signing provider still needs configuration; missing credentials must fail the official build. Ordinary development builds remain unsigned and do not consume signing secrets.

macOS signing/notarization and packaging are not configured. Linux inventory signatures identify the release key but do not automatically create OS-level publisher trust. Standalone verification/distribution metadata and a public contact/download location still need to be established before release.

## Tool permissions and containment

Each tool receives an independent loopback session and an IPC identity tied to its main renderer frame. A supplied tool name cannot change that identity. HTTP routes, IPC actions, preview/output ownership and administrator operations are checked against the calling tool. Speed Test cannot request network changes; File Search cannot request rename or duplicate removal. The core owns the final native confirmation for privileged operations. Duplicate removal consumes a single-use batch approval for the exact reviewed paths.

On Windows, each backend joins an unnamed Job Object before tool initialization. Its normal child processes inherit the job, with a combined 2 GiB committed-memory ceiling and a 32-process limit. Closing the guard, losing the backend or losing the core terminates that process tree. Failure to establish containment prevents the tool from starting. The guard uses Windows APIs available on both Windows 10 and 11 and adds no separate runtime bundle. Linux does not currently use this Windows process-tree/memory guard.

Job Objects provide lifetime and resource containment, not filesystem or network access control. Tool backends still run as the current user; arbitrary compromised native code can access that user's files and may use OS services outside the normal child-process tree. Renderer processes have Electron sandboxing but are not part of the backend memory job. The limit is per backend, not an application-wide RAM guarantee. A rejected allocation may produce a tool error or a quarantined process; it cannot make every out-of-memory situation recoverable.

The elevated helper checks that its named-pipe server belongs to the core process before authenticating the session. Core-owned dialogs review system changes independently of tool-owned confirmation tokens. Windows rechecks target identities before mutation. This is defense in depth, not protection against an already compromised core or another program controlling the user's session.

## Update and recovery boundaries

Automatic updates use explicitly published stable GitHub releases, never arbitrary commits or pull requests. The Windows installer is checked against the pinned publisher before it becomes installable and again immediately before installation. Installation also requires a verified recovery installer of the current release. Missing recovery assets or verification failures block installation. No GitHub credential is embedded in the app.

OMNIA Recovery is a separate small Windows executable, signed with the application in official builds. It checks the cached installer's Authenticode certificate against its compiled public pins before asking to reinstall. It can run when the main application cannot start. The development helper has no certificate pins and cannot approve an installer. The recovery cache retains one installer; it increases disk use by roughly one installer download, not another runtime copy in every tool.

Tool isolation contains many crashes and hangs, but it does not make arbitrary native code safe. Tool processes run with normal user permissions. Administrative operations use a separate authenticated, fixed-operation broker. A page failure does not roll back an already started Windows operation. Memory exhaustion, operating-system failures, compromised signing credentials and defects in the shared shell need separate mitigation and may require reinstalling.

Before public release, configure the actual signing identity, protected release environment, public repository and trusted download channel. Test an upgrade and a recovery between two distinct signed versions on disposable machines. This has not been possible with the unsigned, unpublished 0.0.2 development build.

## Verifying a download

Obtain the standalone Validator through the official release channel. For a signed release, check its Windows Digital Signatures properties against the published publisher identity before using it. Choose the installer, optionally paste its SHA-256, and select Verify file. The utility hashes the selected file and checks its Windows signature, signed product name and certificate pin while holding the file open. The result covers that executable. Launching the installed app separately checks its signed file inventory. A development build can match a published digest while still showing UNVALIDATED SOFTWARE.

To provision the inventory identity, run these commands in a private signing environment with OpenSSL. Choose a new filename in a restricted directory outside the checkout, enter a strong passphrase when prompted, and back up the encrypted key separately.

```sh
openssl genpkey -algorithm Ed25519 -aes-256-cbc -out omnia-release-private.pem
openssl pkey -in omnia-release-private.pem -pubout -out omnia-release-public.pem
```

Put the public PEM in the trust configuration. Protect the encrypted private PEM and passphrase as described under Key custody. Configure and independently check the Windows publisher identity before signing a release. Protect the default branch and require approval on the official-release and release-review environments. Complete the corresponding-source bundle and review exact third-party notices before publishing a draft.

## License and branding

Source remains GPL-3.0-or-later. TRADEMARKS.md documents permitted identification, verbatim redistribution and the separation between independent forks and official branding. It does not register a trademark or override the GPL. THIRD_PARTY.md lists outstanding dependency/source-distribution work; an authenticity badge does not establish license compliance.
