FROM node:22-bookworm-slim AS deps

WORKDIR /app

COPY package*.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci


FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG DATABASE_URL

ENV DATABASE_URL=${DATABASE_URL}

RUN npx prisma generate


FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    NODE_OPTIONS=--no-deprecation \
    PORT=8000

RUN npm install -g pm2

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app ./

EXPOSE 8000

CMD ["pm2-runtime", "ecosystem.config.js"]