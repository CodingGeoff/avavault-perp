# Portable container build for the AvaVault Perp matching-engine + API server.
# Works on any Docker-based host: Northflank, Google Cloud Run, Fly.io, a plain VM, etc.
# (The Render deployment does NOT use this file — Render builds directly from
# render.yaml's buildCommand/startCommand instead. This Dockerfile is an alternative
# path for migrating off Render later, or for hosts that only accept a Dockerfile.)

FROM node:20.18.1-bookworm-slim AS build

# build-essential + python3 are required to compile better-sqlite3's native addon
# from source (see render.yaml comments for why we always build from source instead
# of trusting a prebuilt binary: prebuilt binaries are tied to one exact Node ABI,
# and silently reusing one built for a different Node major version crashes at
# runtime with ERR_DLOPEN_FAILED).
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY task7-perp-dex/matching-engine ./task7-perp-dex/matching-engine
RUN cd task7-perp-dex/matching-engine && npm install && npm run build

COPY task7-perp-dex/server ./task7-perp-dex/server
RUN cd task7-perp-dex/server && npm install && npm rebuild better-sqlite3 --build-from-source

# ---- Runtime stage: no compiler toolchain, smaller final image ----
FROM node:20.18.1-bookworm-slim

WORKDIR /app
COPY --from=build /app/task7-perp-dex ./task7-perp-dex

WORKDIR /app/task7-perp-dex/server
ENV PORT=4000
EXPOSE 4000

CMD ["npm", "start"]
