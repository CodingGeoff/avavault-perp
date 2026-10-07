# Optional: migrating the API off Render to Northflank (no-sleep free tier)

You don't need this today — the Render deployment (`DEPLOY.md`) already works, and
pairing it with a free uptime-monitor ping (e.g. UptimeRobot hitting `/orderbook`
every 5 minutes) keeps it warm for as long as judges are looking at it. This file
is here for later, if you want a backend that never sleeps at all without having
to babysit a keep-alive ping.

Northflank's free tier runs up to 2 services + 1 database with **no forced sleep**
(unlike Render's 15-minute idle timeout), at the cost of needing a credit card on
file for identity verification (not charged on the free tier).

This repo includes a `Dockerfile` at the root built specifically for this: a
multi-stage build that compiles `better-sqlite3` from source against whatever Node
version the final image uses (same fix as the Render deploy needed — see
`render.yaml`'s comments for why), so it isn't tied to Northflank specifically and
would also work on Cloud Run, Fly.io, or a plain VM.

## Steps

1. Go to <https://northflank.com> and sign up (GitHub login works).
2. Create a new **Project** (a project is just a folder for your services).
3. Inside the project, click **Create service** → **Combined service**.
4. Connect your GitHub account if asked, select the **`avavault-perp`** repo,
   branch `main`.
5. Under **Build options**, choose **Dockerfile** (Northflank will find the
   `Dockerfile` at the repo root automatically).
6. Under **Networking**, add a public port: internal port `4000`, protocol HTTP.
   Northflank will give you a public HTTPS URL for it.
7. Under **Environment variables**, add the same ones from `render.yaml`:
   ```
   FUJI_RPC_URL = https://api.avax-test.network/ext/bc/C/rpc
   VAULT_ADDRESS = 0x0425352bc3c5293D5629c27525969439Ab9C27b5
   VAULT_ABI_VERSION = v2
   OPERATOR_PRIVATE_KEY = 0x8d86e8677fa7cc8c4173641b8fa60ffb505476ca3e3797e31cd3ea2f028f75f2
   ```
8. Leave compute resources at the free-tier default, click **Create service**.
9. Wait for the Docker build to finish (compiling `better-sqlite3` from source adds
   maybe a minute — that's expected, not a hang).
10. Northflank gives you a public URL like `https://<something>.northflank.app`.
    Put that into the "API 地址" field on
    https://codinggeoff.github.io/avavault-perp/ (or edit the `apiUrl` default in
    `task7-perp-dex/demo/index.html` and `gh-pages` to make it permanent, the same
    way the Render URL is wired in now).

## Notes

- You can keep both Render and Northflank running at the same time — there's no
  conflict; the frontend just points at whichever URL you put in "API 地址".
- If you only want this as insurance and don't want to set it up right now, that's
  completely fine — nothing here is required for the submission.
