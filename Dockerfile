FROM node:22-bookworm-slim AS deps

WORKDIR /app

COPY package*.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci


FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

COPY . .

ARG DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ibex

ENV DATABASE_URL=${DATABASE_URL}

RUN --mount=type=cache,target=/root/.npm \
    npx prisma generate


FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ARG REDIS_URL=""
ARG REDIS_TLS="false"
ARG REDIS_SSL="false"

ENV NODE_ENV=production \
    NODE_OPTIONS="--no-deprecation" \
    PORT=8000 \
    REDIS_URL=${REDIS_URL} \
    REDIS_TLS=${REDIS_TLS} \
    REDIS_SSL=${REDIS_SSL}

RUN --mount=type=cache,target=/root/.npm \
    npm install -g pm2

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app .

# Ensure local env file is available if present in the build context.
COPY .env .

EXPOSE 8000

CMD ["pm2-runtime", "ecosystem.config.js"]