# Security policy

## Supported versions

Before the first stable release, security fixes are made on `main` and included
in the next `0.2.x` release. After v1.0, the latest major release and the
immediately previous major release will receive coordinated security fixes.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
**Report a vulnerability** flow for this repository. If that flow is
unavailable, contact the repository owner through a private channel listed on
the AugmentWorks website.

Include:

- affected CLI version and operating system
- whether the issue affects auth, config, local packet loading/scoring,
  artifacts, relay, target execution, evidence, or cleanup
- minimal reproduction using synthetic data
- expected impact and any known mitigations

Do not include real connector credentials, customer target secrets, production
data, private packet content, local reports, `.env`, or raw command journals.
Revoke and rotate any credential that was exposed while investigating.

We will acknowledge a complete report, coordinate validation and remediation,
and agree on disclosure timing before publishing details. Please allow a fix to
be released before public disclosure.

## Security design

The CLI's intended boundary, non-goals, telemetry controls, and truth limitation
are described in
[docs/security-model.md](https://github.com/augmentworks-org/augmentworks-cli/blob/main/docs/security-model.md).
The relay wire contract is described in
[docs/protocol.md](https://github.com/augmentworks-org/augmentworks-cli/blob/main/docs/protocol.md).
