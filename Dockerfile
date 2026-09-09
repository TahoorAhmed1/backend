FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./

RUN npm ci

RUN npm install -g pm2

COPY . .

RUN npx prisma generate

ENV NODE_OPTIONS="--no-deprecation"

EXPOSE 3000

CMD ["pm2-runtime", "ecosystem.config.js"]