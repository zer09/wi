# Platform support

| Surface | Supported or verified scope |
|---|---|
| Native library/build/offline CI | Linux and macOS |
| Wi-managed credential persistence/login path | Linux; suitable WSL Linux environments remain Linux |
| Packaged `wi serve` with managed credentials | Linux-specific authentication dependency |
| Browser acceptance gate | Linux x64 with the pinned Chrome for Testing headless shell |
| Native Windows backend | Withdrawn; no Windows CI or first-party Windows branches |

macOS Cargo success is not evidence that Linux-only managed authentication works on macOS. Browser tests do not certify every installed browser version or OS. Browser clients are separate from native backend targets; this policy does not prohibit a browser on Windows from accessing an appropriately exposed supported server.

The platform regression test scans first-party native source and checks that Ubuntu/macOS CI remain and Windows CI does not. It is an inventory aid, not a complete portability or security audit. Transitive Windows package metadata in dependency lockfiles is not first-party Windows support and should not be deleted indiscriminately.

Normal local service operation uses literal-loopback HTTP. Native TLS, deployment automation, and network-filesystem storage certification are not implemented. Unix filesystem checks do not promise isolation from a hostile same-user process or arbitrary kernel/device failures.

Sources: [`tests/platform_support.rs`](../tests/platform_support.rs), [`Cargo.toml`](../Cargo.toml), [`CI`](../.github/workflows/ci.yml), and [authentication](AUTHENTICATION.md).
