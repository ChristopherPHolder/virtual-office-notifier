# Security policy

## Supported versions

Only the latest `main` is supported. It's what's deployed, and there are no releases.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through [GitHub's private vulnerability reporting](https://github.com/push-based/virtual-office-notifier/security/advisories/new), with what you found, how to reproduce it and what an attacker could do with it.

I'd especially like to hear about:

- A way to make the bot ping people (`@channel`, `@here`, user mentions) or post links in Slack, for example through a Discord display name or AI output.
- Secrets like the bot token, webhook URL or API keys showing up in logs, errors or the repository.
- A way to deploy to the VM from anywhere other than this repository's `main` branch.

If you come across a leaked token or webhook URL, report it the same way so it can be revoked.

Reports are handled on a best-effort basis, with no guaranteed response time. The software comes with no warranty; see the [license](LICENSE).
