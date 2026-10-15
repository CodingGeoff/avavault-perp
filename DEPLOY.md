# Deploying the live API (backend)

The static demo UI is already live at **https://codinggeoff.github.io/avavault-perp/**.
It talks to a backend (matching engine + WebSocket API + real on-chain settlement) that
needs an always-on Node process, so it can't live on GitHub Pages — it needs to be
deployed separately. This repo includes a ready-made blueprint (`render.yaml`) for
[Render](https://render.com)'s free tier, which requires no credit card.

This part needs a few manual clicks on your own Render account (I can't click buttons
in your browser), but it's been pre-tested end-to-end in the sandbox against the real
deployed `VaultV2` contract on Fuji, so it should "just work."

## Steps (about 5 minutes)

1. Go to <https://dashboard.render.com/> and sign up / log in (GitHub login is easiest).
2. Click **New +** → **Blueprint**.
3. Connect your GitHub account if asked, then select the **`avavault-perp`** repo.
   Render will auto-detect `render.yaml` at the repo root and show one service:
   **`avavault-perp-dex-api`**.
4. Click **Apply** / **Create New Resources**. It will ask you to fill in the one
   secret environment variable that isn't in the blueprint file (on purpose, so it's
   never committed to git):

   ```
   OPERATOR_PRIVATE_KEY = 0x8d86e8677fa7cc8c4173641b8fa60ffb505476ca3e3797e31cd3ea2f028f75f2
   ```

   This is the already-deployed demo operator key on Avalanche Fuji **testnet** — the
   key's own address is `0xF7ac5cF5D95256E960DF21229B140edFE31b5c9b` (that's the
   `operator`/`owner` of the deployed contracts; `0x0425352bc3c5293D5629c27525969439Ab9C27b5`
   is the `VaultV2` **contract** address, not the key). It holds no real funds, and
   every settlement it can trigger is additionally gated by
   each user's own EIP-712 signature (that's the whole point of `VaultV2` — see the
   main README), so a public demo exposure of this key is low-risk. If you'd rather
   use a fresh key of your own, you'd need to call the vault's owner-only operator
   update function first — not necessary for the demo to work.

5. Wait for the build to finish (~2-3 minutes — it runs `npm install` for both the
   matching engine and the server, plus a TypeScript build). Render will give you a
   public URL that looks like:

   ```
   https://avavault-perp-dex-api.onrender.com
   ```

6. Open **https://codinggeoff.github.io/avavault-perp/** and check the "API 地址"
   field already defaults to that exact URL. If Render gave you a different
   subdomain (it will if `avavault-perp-dex-api` was already taken), either:
   - type the real URL into that field in the browser before connecting (works
     immediately, no redeploy needed), or
   - edit `task7-perp-dex/demo/index.html`'s `apiUrl` input value and the `gh-pages`
     branch to match permanently.

7. Click "连接钱包并登录" with a browser wallet (e.g. MetaMask) set to Avalanche Fuji
   testnet. You can place orders against the live order book; a crossing order
   triggers a real `settleWithAuthorization` transaction, verifiable on
   [Snowtrace](https://testnet.snowtrace.io/address/0x0425352bc3c5293D5629c27525969439Ab9C27b5).

## Keeping it awake (optional, recommended during judging)

Render's free web services spin down after ~15 minutes of no traffic and take
~30-50 seconds to cold-start on the next request. To avoid judges hitting that
delay, set up a free external ping every 5 minutes:

1. Sign up at <https://uptimerobot.com> (free).
2. New Monitor → HTTP(s) → URL: `https://avavault-perp-dex-api.onrender.com/orderbook`
3. Check interval: 5 minutes (free tier minimum).

This keeps the service warm without touching the deployment itself. If you want a
backend that genuinely never sleeps instead of relying on a keep-alive ping, see
`NORTHFLANK_DEPLOY.md` for a no-sleep free-tier alternative.

## Notes on the free tier

- Render's free web services spin down after ~15 minutes of no traffic and take
  ~30-50 seconds to cold-start on the next request. That's fine for judges clicking
  in during review; just don't expect an instant response if nobody's visited in a
  while.
- The SQLite order book file lives on Render's ephemeral disk, so it resets on
  redeploy/restart — that's fine for a demo (seed script is in
  `task7-perp-dex/demo/seed_orderbook.mjs` if you want to pre-populate it again).
- Every push to `main` redeploys this service on Render (even docs/CI-only commits).
  While it is redeploying or spinning up, Render's edge answers browser requests
  *instantly* with a 503 loading page that has no CORS headers, so the demo page's
  `fetch` fails immediately and DevTools shows a CORS error. That is expected: the
  page keeps retrying until the API is up (hover the API pill or read the log panel
  for the exact reason). A red "请求被拦截" pill instead means the request never
  reached the server — usually an ad-blocker/privacy extension or a proxy.
- `GET /` returns a small JSON pointer (it used to be Express's default
  `Cannot GET /`, which never meant the service was down); use `/health` for checks.
