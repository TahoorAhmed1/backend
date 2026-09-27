FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y openssl \
    && rm -rf /var/lib/apt/lists/*

ARG DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ibex
ENV DATABASE_URL=${DATABASE_URL}

COPY package*.json ./

# Copy Prisma before npm ci because npm ci runs prisma generate
COPY prisma ./prisma
COPY prisma.config.js ./

RUN npm ci

RUN npm install -g pm2

COPY . .

ENV NODE_OPTIONS="--no-deprecation"

EXPOSE 3000

CMD ["pm2-runtime", "ecosystem.config.js"]