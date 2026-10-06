# Security policy

## Supported versions

The Final Commit is pre-alpha. Only the latest commit on `main` is supported.

## Reporting a vulnerability

Report privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability**. This uses GitHub private vulnerability
reporting, so the report is visible only to the maintainer until a fix is
published.

Do not open a public issue or pull request for a security problem.

Useful details:

- what an attacker can do, and under what conditions
- steps to reproduce, using an invented project (issue keys like `NOVA-1`),
  never real work content
- the Claude Code version and OS you tested on

In scope, among other things:

- secrets, work content, or personal data committed to this repository
- a way for work content to bypass the privacy filter and reach a model prompt
- any network call the mod makes other than to the user's configured Jira and
  the user's own Claude Code session

This is a one-person project, so responses are best effort and there is no
fixed response time.
