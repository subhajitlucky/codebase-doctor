# Security Policy

## Supported versions

The latest published version receives security fixes.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting on this repository (Security → Report a
vulnerability), or email **subhajitpradhan310@gmail.com**.

Please include the affected version, reproduction steps, impact, and any
proof-of-concept. We aim to acknowledge within 72 hours and to ship a fix or
mitigation as fast as practical.

## Scope

In scope:

- the tool leaking secrets or source content it should withhold
- path traversal or unsafe handling of repository content
- supply-chain issues in published artifacts (verify provenance attestations
  on npm for released versions)
- denial of service through crafted input

Out of scope:

- findings the tool reports about your codebase — those are the product
- analysis false negatives or coverage limits; report those as regular
  issues with a fixture

## Design posture

Codebase Doctor is read-only by design: it never writes to target
repositories, never executes repository source, and makes no network request
except an explicitly requested OSV advisory lookup (`--with-advisories`).
Matched secret values are withheld from every finding, fingerprint, error,
and report. Separately authorized `--run-checks` launches repository-owned
validation commands and is never enabled by the MCP server.
