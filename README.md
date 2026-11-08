# Meta AI chat app

A responsive, self-hosted AI chat app with a Node.js backend and persistent conversation history. It uses an OpenAI-compatible Chat Completions API; provider credentials are only used by the server and never exposed to the browser.

## Requirements

- Node.js 18 or newer
- An API key and model name from an OpenAI-compatible AI provider

## Run locally

1. Copy `.env.example` to `.env`.
2. Set `AI_API_KEY` and `AI_MODEL`. `AI_BASE_URL` defaults to `https://api.openai.com/v1`; set it to your provider's compatible API base URL if needed.
3. Start the server:

   ```sh
   npm start
   ```

4. Open <http://127.0.0.1:3000>.

The app writes chat history to `data/chats.json` by default. Set `DATA_DIR` to a persistent writable directory when deploying. Back up this directory to retain conversation history.

## Features

- Chat interface with suggestions, responsive layout, and recent conversations
- Create, reopen, and delete chats; conversation history is saved on the server
- Separate signed, HttpOnly guest-session cookie for each browser
- OpenAI-compatible model requests from the backend, with bounded request sizes and timeout handling
- No framework or runtime package dependencies

## Deploy to Render

The repository includes `render.yaml` for Render Blueprints. To deploy:

1. Push this repository to GitHub and create a Render account.
2. In Render, choose **New → Blueprint**, connect this repository, and apply the `render.yaml` blueprint.
3. Enter your OpenAI API key for `AI_API_KEY` and a model available to your API account for `AI_MODEL` when prompted. The blueprint sets the API base URL, production mode, host binding, and a generated session secret.
4. Deploy and open the Render service URL. The `/health` endpoint is used for health checks.

The Blueprint configures a persistent disk at `/var/data`, so conversation history survives service restarts and deploys. Render persistent disks require a paid web-service plan and are attached to a single instance; confirm current Render pricing and plan availability before deploying. Keep `AI_API_KEY` as a secret environment variable and never commit it to the repository.

## Security and deployment notes

This is a single-user/demo application, not a complete multi-user service: guest sessions are not accounts, and anyone who can use a browser profile can access its chats. Use HTTPS in production, set a strong unique `SESSION_SECRET`, restrict access with your hosting platform or add authentication before exposing it publicly, and choose a private persistent data directory. Never commit `.env` or put provider keys in frontend code. For multiple server instances, replace the JSON file store with a transactional database and shared session infrastructure.

The backend expects the provider's `POST {AI_BASE_URL}/chat/completions` endpoint to accept a bearer API key and return `choices[0].message.content`.
