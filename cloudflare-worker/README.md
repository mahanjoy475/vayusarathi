# VayuSarathi Cloudflare Worker API

This Worker is the backend replacement for the Netlify Functions in VayuSarathi v7.
See the parent `README_MIGRATION.md` for the full setup guide.

## Quick setup

1. Install Node.js LTS and open PowerShell in this folder.
2. Run `npm install`.
3. Run `npx wrangler login`.
4. Run `npx wrangler kv namespace create VERIFICATION_KV`.
5. Copy the returned namespace ID into `wrangler.toml` at `[[kv_namespaces]].id`.
6. Run `npx wrangler deploy`.
7. Configure secrets if desired:
   - `npx wrangler secret put GEMINI_API_KEY`
   - `npx wrangler secret put OPENAI_API_KEY`
   - `npx wrangler secret put CRON_TOKEN`
8. Deploy again with `npx wrangler deploy`.
9. Set the Worker URL plus `/api` in the GitHub Pages `api-config.js`.

## Routes

- `GET /api/health`
- `GET /api/aviation?ids=...&taf=true`
- `GET /api/aviation?nearby=true&lat=...&lon=...`
- `GET|POST /api/verification`
- `GET /api/verification-health`
- `GET|POST /api/gemini-chat`
- `GET|POST /api/ai-chat`
- `GET /api/tropical-watch`
- `POST /api/verification-cron` (requires `Authorization: Bearer <CRON_TOKEN>`)

The verification collector is scheduled hourly by the Cron Trigger in `wrangler.toml`.
