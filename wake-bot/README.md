# wake-bot «Разбуди меня»

Telegram bot for two people. When she can't sleep she presses **🌙 Не спится**, and his iPhone rings
loudly through silent mode and Sleep focus until he taps *Acknowledge*. Then she gets "Он проснулся 💛".

- The ring comes from **Pushover** emergency priority (Critical Alert on iOS). A plain Telegram
  message can't ring through silent mode, and bots can't call.
- **📣 Позвать** does the same for daytime "he isn't answering and she needs something"; while it rings, whatever she writes is forwarded to him.
- The alarm repeats every 30 s for up to 30 min. She can cancel it. If he doesn't wake, she is told.
- Only two people can use it: the first `/start` is the owner, the invite link he gets adds her.
  Everyone else is ignored. `/invite` makes a new link and disconnects the old one.
- Owner commands: `/test` (ring without telling her), `/stop`, `/invite`, `/status`.

## Setup

1. iPhone: install Pushover, sign in, allow notifications **and Critical Alerts**.
   In Pushover → Settings, make sure Critical Alerts are on for emergency priority.
2. pushover.net: copy *Your User Key*, create an application, copy its *API Token*.
3. @BotFather: `/newbot`, copy the token.
4. On the Mac, `~/.wake-bot.env` (chmod 600):
   ```
   TELEGRAM_TOKEN='...'
   PUSHOVER_TOKEN='...'
   PUSHOVER_USER='...'
   ```
5. `cd wake-bot && npx wrangler login && ./scripts/deploy.sh`
6. Open the bot, press Start (you become the owner), send the link to her, try `/test`.

State lives in a KV namespace `wake-bot` (owner, partner, invite code, current alarm).
