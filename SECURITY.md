# Security

Dottie reads your group chats and can change your calendar, so security problems matter here.

## Reporting a problem

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting
("Report a vulnerability" under the Security tab of this repository), or open an issue that only asks for a
private contact, with no details. Include what you found, how to reproduce it,
and what it could let someone do. This is a personal project, so replies may take a few days.

## Keep your own keys safe

- Never paste API keys, tokens, app-specific passwords, your callback key, chat contents or `wrangler tail` logs into
  an issue, pull request or discussion. If you post one by mistake, revoke it at the provider right away: deleting
  the post is not enough.
- Secrets live in Cloudflare (`npx wrangler secret put`), never in `wrangler.toml` or the repository. For local
  development they go in `.dev.vars`, which git ignores.
- Your callback key guards the GroupMe callback and the `/run` and `/test` links, and nothing answers until it is
  set. Keep it private, and make a new one (and update the bot's callback URL) if it leaks.
- Your GroupMe token can read all your chats, and an iCloud app-specific password also opens iCloud Mail and
  Contacts. If either leaks, revoke it: GroupMe at https://dev.groupme.com, Apple at https://account.apple.com.
- The Canvas token is used for GET requests only, and only ever sent to your school's Canvas address. It can still
  do anything you can do in Canvas, so delete it in Canvas settings if it leaks.

## How Dottie handles untrusted text

Group chat messages, web pages, files and Canvas pages can contain text written to trick an AI. Dottie's prompt
treats all of it as information, never instructions, and it only acts on messages you send in your own Assistant
chat. Plans from chats go on your calendar only after you say yes. This lowers the risk but cannot remove it, so
report any way you find around it.
