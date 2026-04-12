# Security Policy

## Supported Versions

This project is pre-release. Only the latest commit on `main` (and `develop`) is
supported. No security patches are backported to older commits or tags.

## Reporting a Vulnerability

Use **GitHub Private Vulnerability Reporting** (preferred):

1. Go to the [Security tab](../../security) of this repository.
2. Click **"Report a vulnerability"**.
3. Describe the issue, steps to reproduce, and potential impact.

GitHub routes the report privately to the maintainers. You will receive a
response within 7 days. Please do not open a public issue for security matters.

If GitHub PVR is unavailable, contact the maintainer directly through their
GitHub profile. A public email will be added here once the project reaches
stable release.

## Scope

**In scope** (please report these):

- Authentication bypass or token leakage in the OTLP receiver
- Unauthorized access to the console API or incident data
- LLM prompt injection via ingested telemetry payloads
- Secrets or credentials exposed in logs or HTTP responses
- Dependency vulnerabilities with a credible exploit path

**Lower priority** (report if severe, but expect slower response):

- The `validation/` Docker stack — it is a local test harness, not production
- Cosmetic or DoS issues with no realistic attack surface

## Disclosure Policy

We follow coordinated disclosure. Please give us a reasonable window (14 days
for critical, 30 days for others) before public disclosure.
