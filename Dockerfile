FROM node:22-slim

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/orchestrator/package.json packages/orchestrator/
COPY packages/slack-bridge/package.json packages/slack-bridge/

RUN pnpm install --frozen-lockfile || pnpm install

COPY . .
RUN pnpm build

CMD ["pnpm", "start"]
