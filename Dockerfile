# syntax=docker/dockerfile:1.7

##################
# deps: install once, cached across builds via BuildKit cache mount
##################
FROM node:20-bookworm-slim AS deps
WORKDIR /app

COPY package*.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci

##################
# build: generate prisma client + compile (if you have a build step)
##################
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Dummy value so Prisma's config loader doesn't fail on a missing env var.
# `prisma generate` never actually connects to a database.
ARG DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ibex
ENV DATABASE_URL=${DATABASE_URL}

RUN --mount=type=cache,target=/root/.npm \
    npx prisma generate

# If you have a TS build step, uncomment:
# RUN npm run build

##################
# runtime: slim final image, only what's needed to run
##################
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NODE_OPTIONS="--no-deprecation"

# pm2 only in the final layer, no dev/build tooling carried over
RUN --mount=type=cache,target=/root/.npm \
    npm install -g pm2

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app .

EXPOSE 3000

CMD ["pm2-runtime", "ecosystem.config.js"]