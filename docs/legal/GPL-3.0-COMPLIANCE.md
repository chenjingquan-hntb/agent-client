# GPL-3.0 Compliance Boundary

This repository is GPL-3.0-only as declared by the upstream project. The full
license text remains in LICENSE, and upstream attribution remains in
NOTICE.md and docs/FORK.md.

## Distribution obligations

When distributing a modified desktop binary or installer, the distributor must
preserve the applicable copyright and license notices, identify material
modifications, and provide the corresponding source under GPL-3.0 terms (or a
valid written offer/other GPL-compliant method). A paid binary, subscription,
or service plan does not remove these obligations.

The brand, product name, icons, signing identity, installer metadata, and release
artifacts need a separate review; they must not imply that the upstream authors
endorse this fork.

## Service boundary

A separately deployed relay or account service can generally remain under its own
license when it communicates with the desktop over a protocol and does not include
or link against GPL client code. This is a design/legal boundary, not a blanket
exception: generated code, shared packages, plugins, SDKs, vendored sources, and
installer bundles must each be reviewed before distribution.

The service must not receive or persist user API keys or chat bodies unless a
separate product and privacy decision explicitly authorizes it. The preferred
model is for the desktop host to receive short-lived authorization and keep
provider credentials within the host boundary.

## Required follow-up

- maintain an SPDX/license inventory for direct and vendored dependencies;
- record every material fork modification in NOTICE.md or a linked changelog;
- include source-offer/source-bundle instructions in release artifacts;
- review trademark/branding and any third-party asset licenses before release;
- obtain specialist legal review before shipping a commercial installer.
