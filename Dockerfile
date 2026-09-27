FROM node:22-bookworm-slim

WORKDIR /app

ARG DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ibex
ENV DATABASE_URL=${DATABASE_URL}

COPY package*.json ./

RUN npm ci

RUN npm install -g pm2

COPY . .

RUN npx prisma generate

ENV NODE_OPTIONS="--no-deprecation"

EXPOSE 3000

CMD ["pm2-runtime", "ecosystem.config.js"]