<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Contributing to OpenMasjidOS

Thank you for helping build free software for masajid. This document covers how
to contribute **and the licensing terms your contribution is made under** —
please read the licensing section before opening a pull request.

## How to contribute

1. Open an issue describing the change (bug or feature) before large work, so we
   can agree on the approach.
2. Fork, branch, and keep commits small with [Conventional Commit](https://www.conventionalcommits.org/)
   messages (`feat:`, `fix:`, `docs:`, `chore:` …).
3. Before pushing: `npm run build` must pass, `tsc` and ESLint must be clean, and
   the change must work in **both** light/dark themes and **both** LTR/RTL. New
   user-facing strings go through i18next. See `CLAUDE.md` for the full bar.
4. Open a pull request. Every source file carries an SPDX header
   (`// SPDX-License-Identifier: AGPL-3.0-only`) — keep it on new files.

## Licensing of your contributions (please read)

OpenMasjidOS is published under the **GNU Affero General Public License v3.0
(AGPL-3.0-only)** — see [`LICENSE`](./LICENSE) — and contributions are governed by
the **OpenMasjidOS Contributor License Agreement** — see [`CLA.md`](./CLA.md),
the canonical legal text. The summary below is for convenience; the CLA controls.

**1. Inbound license + Developer Certificate of Origin.** You contribute under
the same AGPL-3.0-only as the project, and by submitting a contribution you
certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/)
(you wrote it, or have the right to submit it). Sign off each commit:

```
git commit -s -m "feat: ..."
```

which adds a `Signed-off-by: Your Name <you@example.com>` trailer.

**2. Copyright-license grant for relicensing.** So that the project can be
sustained — including by offering **commercial / proprietary licenses** to
organisations that cannot accept AGPL terms — you additionally grant
**OpenMasjid-Solutions** a **perpetual, worldwide, non-exclusive, royalty-free,
irrevocable** license to use, reproduce, modify, prepare derivative works of,
publicly display and perform, sublicense, and **distribute your contribution and
derivative works under any license terms, including terms different from
AGPL-3.0 (e.g. a commercial/proprietary license)**.

You retain copyright in your contribution; this grant is a license, not an
assignment, and does **not** restrict your own use of your contribution.

The public tree stays AGPL-3.0 — this grant only lets the maintainer offer
**additional** commercial licenses (dual licensing). It does not let anyone take
the public AGPL code proprietary.

**3. Patents.** You grant the project and its users a license to any patents you
hold that are necessarily infringed by your contribution, on the same terms as
above.

### Signing the CLA

You sign the CLA **once**, automatically, on your first pull request: the CLA
bot comments with a link to [`CLA.md`](./CLA.md) and asks you to reply with the
exact sentence

> I have read the CLA Document and I hereby sign the CLA

Your signature is recorded under `signatures/` and future PRs are recognised
automatically.

If you cannot agree to the relicensing grant in §2 of the CLA, you may still
contribute **under AGPL-3.0 only** — say so explicitly in your PR, and we will
either accept it AGPL-only or discuss an alternative. Contributions without a
clear statement, once the CLA is signed, are taken to be under the terms above.

## Apps are separate

End-user apps live in their **own repositories** and run as separate containers
at arm's length from the core (see `CLAUDE.md` §3). They are **not** covered by
this CONTRIBUTING file or the core's AGPL — app authors license their apps as
they wish.
