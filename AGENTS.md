# Setting up Dottie: instructions for a coding agent

You are helping a person set up Dottie, an AI assistant that reads their GroupMe chats and changes their iCloud
calendar. Follow these steps in order. Read README.md first for what Dottie is.

## Rules for you, the agent

- **Never handle secrets in chat.** Do not ask the person to paste a key, token or password into the conversation,
  and do not print one. Each secret is entered by the person with `npx wrangler secret put <NAME>` in their own
  terminal, which hides the input.
- **Never sign in for them.** Cloudflare, Apple, GroupMe, Canvas and OpenRouter sign-ins, and creating keys, tokens
  and app-specific passwords, are done by the person in their own browser.
- **Never commit or push** `.dev.vars`, keys, tokens or anything copied from their chats or calendar.
- **Ask before** changing the prompts in `src/agent.js` or `src/groupme.js`, or any limit in the code.
- Stop and ask whenever a step fails in a way this file does not cover.

## Steps

1. **Node.** Run `node --version`. It must be v22.13 or newer (the tests use node:sqlite). If not, help them install a current Node LTS.
2. **Tests.** Run `npm test`. Every test must pass. They are offline and use fakes. If any fail, stop and report it.
3. **Accounts.** Walk them through README steps 2 to 5: an OpenRouter key with a credit limit, an iCloud
   app-specific password (and Calendars turned on in iCloud), the Canvas feed link and token if they want Canvas,
   the GroupMe access token, and a GroupMe group named "Assistant" with only them in it. Tell them to keep each value
   somewhere private until step 7. Mention that the app-specific password also opens their iCloud Mail and Contacts.
4. **Settings.** Ask for their first name, time zone, morning brief hour, and the town for the weather. Fill in
   `NAME`, `TIMEZONE`, `MORNING_HOUR`, `LAT` and `LON` in `wrangler.toml` (look up the coordinates of the town they
   name). Leave the other settings at their defaults unless they ask.
5. **Cloudflare.** They run `npx wrangler login` themselves. Then run `npx wrangler d1 create dottie`, put the
   `database_id` it prints into `wrangler.toml`, run `npx wrangler d1 execute dottie --remote --file schema.sql`,
   and `npx wrangler deploy`. Note the workers.dev address it prints.
6. **Callback key and bot.** Have them run `node -e "console.log(crypto.randomUUID().replaceAll('-',''))"` and keep
   the result. They create the bot at https://dev.groupme.com (Bots, Create Bot) in the "Assistant" group, with the
   callback URL `https://<address>/groupme/<callback key>`, and keep the Bot ID.
7. **Secrets.** They run, one at a time in their own terminal: `npx wrangler secret put` for `OPENROUTER_API_KEY`,
   `GROUPME_TOKEN`, `GROUPME_BOT_ID`, `CALLBACK_KEY`, `ICLOUD_EMAIL`, `ICLOUD_APP_PASSWORD`, and, if they use Canvas,
   `CANVAS_FEED_URL` and `CANVAS_TOKEN`. Run `npx wrangler secret list` to confirm the names exist (it never shows
   values).
8. **Check.** They run `curl -H "Authorization: Bearer <callback key>" "https://<address>/run?job=check"`. It must
   name the Assistant group and list their calendars. A `FAILED` line names the step to redo.
9. **Hand over.** Tell them to run the same curl with `job=welcome` to get the guide in their Assistant chat, to
   text Dottie about themselves, and to mute chats they don't want read ("stop checking <chat name>"). Point them to
   `npx wrangler tail` for live logs and to the Disclaimer in README.md.
