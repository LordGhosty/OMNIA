# Contributing

OMNIA uses CommonJS for native services and plain JavaScript for the interface. Keep each tool's implementation separate from the shell and preserve the shared UI controls.

## Code

- Use short, domain-specific names. Preserve public interfaces unless their callers and tests change together.
- Document exported APIs, inputs, outputs and important failure behavior with JSDoc or the language's equivalent. Do not narrate syntax.
- Reserve inline comments for invariants, non-obvious calculations, compatibility constraints and actionable future work.
- Keep user examples and machine-specific details out of defaults, placeholders and fixtures intended for distribution.
- Retain license notices and required third-party attribution.

## Interface

Use the shared styles in `web/style.css` and shared system controls in `web/system-tools.css`. Tool pages use the same file-drop markup, status messages, clear controls and result actions. Category headings use one font rule, including headings nested under Windows. Tool and platform insignias use neutral gray shades without gradients. Respect reduced motion.

## Fault handling

Native services register with the tool host. Initialization failures and unexpected programming errors quarantine the affected service. Input validation and recoverable operation errors remain ordinary tool results. Reset cannot interrupt active mutations.

Each native tool page has a separate renderer. Tool backends run lazily in supervised utility processes; tools sharing an implementation receive separate service instances. Page crashes, blocked event loops and backend failures quarantine the affected tool. The directory remains in its own renderer. Quarantine is persisted for the current build and can be reset explicitly.

Keep the native shell limited to navigation, dialogs, clipboard, update verification and the fixed-operation administrator broker. A tool process is a crash boundary, not a sandbox for untrusted native code: it still has the user's normal filesystem permissions. Privileged work already accepted by the broker must not be interrupted just because a tool page closes. A core/runtime crash still requires restart or recovery.

Processes start on demand and reuse the packaged runtime. Clean inactive pages have a bounded cache; pages with user input are retained. Do not discard unsaved work to meet a memory target. Test memory on actual workflows rather than claiming a fixed upper bound.

Register tool-specific permissions in `src/access.cjs`; sharing a backend module must not share privileges. Keep process initialization behind the Windows Job Object guard. New system mutations require exact-target validation and core-owned confirmation. Native helpers must remain compatible with .NET Framework 4 and Windows 10 APIs. See `WINDOWS_COMPATIBILITY.md` for the release test matrix.

Use workers or child processes for expensive or failure-prone work. Catch process errors, bound output, enforce timeouts and expose cancellation where the underlying operation supports it. Never use a global exception handler to continue after unknown main-process corruption.

## Checks

Run `npm test`, `npm run source:check` and `npm run format:check`. After a Windows build, run `node scripts/smoke-package.cjs`. It checks actual media/file workflows, separate renderers, crash/hang recovery and detached console streams. Use disposable files and simulated destructive commands; do not test repairs, driver removal, firewall changes or file deletion against personal data.

Workspace configuration, scratch output, credentials, dependencies and build artifacts are excluded from the source repository. The publication check rejects these paths if they are tracked. Do not remove third-party licenses to satisfy a source-content check.

Signing tests generate temporary key pairs. Run them with `node --test tests/release-signature.test.cjs tests/updates.test.cjs tests/recovery.test.cjs tests/validation.test.cjs`. Pull requests and local development builds need no maintainer signing key. For an official Windows build, set `OMNIA_EXPECT_SIGNED=1` when running the packaged smoke check so it verifies the Hub’s displayed signature status. See [release signing and recovery](SECURITY.md).
