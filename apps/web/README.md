# Web App

## Environment Variables

For local development, secrets are encrypted using the `FOUNDRY_SECRETS_KEY` environment variable. This key must be set in your root `.env` file:

```
FOUNDRY_SECRETS_KEY=your_base64_32byte_key
```

The API route explicitly loads the root `.env` file using `dotenv.config()` to ensure this variable is available. If you change the key, restart your dev server.

## Running Locally

- Ensure `.env` exists at the repo root with `FOUNDRY_SECRETS_KEY` set.
- Start the dev server as usual (`pnpm dev` or `npm run dev`).
- The secrets API will now be able to access the key and upsert secrets.
- Set `FOUNDRY_DISABLE_AUTH=true` if you need to temporarily expose pages and API routes for remote debugging.
