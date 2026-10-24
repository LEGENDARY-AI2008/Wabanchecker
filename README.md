# WhatsApp Ban Checker (Telegram bot)

Send `? 2348012345678` (private or group). The bot sends the logo, then edits the caption with the result.

## Groups
1. BotFather > /setprivacy > choose the bot > **Disable** (so it can see `?` messages)
2. Add the bot to the group and make it **admin**
3. Anyone sends `? 234...`; if the bot is not admin it asks to be made admin. Tagging the bot shows the usage hint.

## Env vars
Copy `.env.example` to `.env` (never commit it). Set `BANCHECK_API_KEY` to your BanCheck API key (live key). "Banned at" and "Checked at" are shown in Nigeria time (Africa/Lagos).

## Admin
- Tap Reply under a ticket, then type your answer
- `/broadcast` (reply to any message, or `/broadcast text`), `/stats`, `/admin`

## Deploy on Render
1. Push to GitHub (`.env` is git-ignored)
2. Render > New > Blueprint > fill the env vars in the dashboard
3. Add a Disk and set `DATA_DIR=/data` to keep user list across redeploys
