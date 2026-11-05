# Windows compatibility

The packaged desktop target is Windows 10 22H2 (build 19045) and Windows 11, x64. Windows ARM64, 32-bit Windows and Windows Server are not validated release targets. Compatibility does not extend an operating system's Microsoft support lifecycle; use a serviced Windows installation.

The installer carries Electron, media binaries and native helpers. The helpers use the Windows-provided .NET Framework 4 runtime; Windows controls use Windows PowerShell 5.1, CIM and the NetAdapter, DnsClient, Storage and NetSecurity modules. OpenSSH Client is optional: SSH Key Forge reports when it is missing. Device support, Group Policy and account permissions can restrict individual operations. A failed tool must leave the directory and other tools usable.

## Evidence

- Windows 11 x64: local automated application tests and capability inventory.
- Windows 10 22H2 x64: compatibility target; native desktop, installer and system-operation validation is still pending.
- Hosted Windows CI: useful regression coverage, but Windows Server runners do not substitute for testing either desktop OS.

Do not label Windows 10 as verified until the same packaged candidate passes on an actual Windows 10 installation or VM. Record the installer SHA-256, exact OS build, account type and results with each release candidate. Do not include private machine inventory in published reports.

## Release matrix

Run these checks on disposable Windows 10 and Windows 11 VMs, using a standard account and an administrator account:

1. Install without a developer environment. Check per-user installation, shortcuts, launch, close, uninstall and reinstall.
2. Run `node scripts/check-windows.cjs compatibility.json` in a development checkout to record available commands. This reads capabilities; it does not validate application behavior or change settings.
3. Run `npm test` and, after packaging, `node scripts/verify-package.cjs` and `node scripts/smoke-package.cjs`. Preserve the reports from `.qa/`. The native smoke covers all tool pages, file/media workflows, navigation and renderer crash/hang recovery.
4. Check UAC refusal, approval, disabling the session and cancellation of the core confirmation. Attempt cross-tool operations through the regression fixtures; no privileged command should run without the correct tool and confirmation.
5. On disposable fixtures only, verify driver backup/removal, firewall edits and undo, USB operations, and maintenance results/restart requirements. A successful simulated test is not evidence that an actual Windows mutation succeeds.
6. Check large media files, low disk space, unavailable OpenSSH, non-English Windows, Unicode paths, offline operation and restrictive policies. Verify failed tools can be reset while other tools still work.
7. Use two distinct signed versions to test update download, invalid-signature rejection, interrupted installation and recovery with the independent recovery utility. Do not publish until actual signing pins, release keys and the protected GitHub release environment are configured.

Never run destructive release checks against personal disks, drivers or firewall rules.
