# Stage 1: builder
FROM node:22-slim AS builder

# Install pnpm
RUN npm install -g pnpm@10.31.0

WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY apps/receiver/package.json ./apps/receiver/
COPY apps/console/package.json ./apps/console/
COPY packages/core/package.json ./packages/core/
COPY packages/diagnosis/package.json ./packages/diagnosis/
COPY packages/config-typescript/package.json ./packages/config-typescript/
COPY packages/config-eslint/package.json ./packages/config-eslint/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY apps/ ./apps/
COPY packages/core/ ./packages/core/
COPY packages/diagnosis/ ./packages/diagnosis/
COPY packages/config-typescript/ ./packages/config-typescript/
COPY packages/config-eslint/ ./packages/config-eslint/

# Build receiver + console (turbo handles dependency order: core first)
RUN pnpm turbo run build --filter=@3am/receiver --filter=@3am/console

# Stage 2: runtime
FROM node:22-slim AS runtime

RUN npm install -g pnpm@10.31.0

WORKDIR /app

# Copy workspace manifests for production install
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY apps/receiver/package.json ./apps/receiver/
COPY packages/core/package.json ./packages/core/
COPY packages/diagnosis/package.json ./packages/diagnosis/
COPY packages/config-typescript/package.json ./packages/config-typescript/
COPY packages/config-eslint/package.json ./packages/config-eslint/

# Install production deps only
RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts from builder
COPY --from=builder /app/apps/receiver/dist ./apps/receiver/dist
COPY --from=builder /app/apps/receiver/src/transport/proto ./apps/receiver/src/transport/proto
COPY --from=builder /app/apps/console/dist ./apps/console/dist
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/diagnosis/dist ./packages/diagnosis/dist

# Copy receiver package.json for version detection
COPY apps/receiver/package.json ./apps/receiver/

ENV NODE_ENV=production
ENV PORT=3000
ENV CONSOLE_DIST_PATH=/app/apps/console/dist

EXPOSE 3000

CMD ["node", "apps/receiver/dist/server.js"]
