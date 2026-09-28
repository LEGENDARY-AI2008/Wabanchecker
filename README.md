# WhatsApp Ban Checker (Telegram bot)

Features: number check (active/banned/unknown), force-join, support tickets (user -> admin -> reply), review requests, broadcast, /stats, inline menu.

## Env vars
Config is in `.env` (BOT_TOKEN, ADMIN_ID comma-separated for many admins, SUPPORT_USERNAME, FORCE_JOIN).

## Admin
- Tap Reply under a ticket, then type your answer
- `/broadcast` (reply to any message, or `/broadcast text`)
- `/stats`

## Deploy on Render
1. Push this folder to GitHub
2. Render > New > Blueprint (uses render.yaml) > fill the env vars in the dashboard
3. Render sets RENDER_EXTERNAL_URL itself; bot switches to webhook automatically

Notes: free Render wipes files on redeploy (user list resets) — add a Render Disk and set DATA_DIR=/data to keep it. Free tier also sleeps when idle; Telegram messages wake it up but first reply is slow.
