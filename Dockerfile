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
COPY packages/cli/package.json ./packages/cli/
COPY packages/config-typescript/package.json ./packages/config-typescript/
COPY packages/config-eslint/package.json ./packages/config-eslint/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY apps/ ./apps/
COPY packages/ ./packages/

# Build receiver + console (... includes transitive deps: core, diagnosis)
RUN pnpm turbo run build --filter=@3am/receiver... --filter=@3am/console...

# Stage 2: runtime
FROM node:22-slim AS runtime

RUN npm install -g pnpm@10.31.0

# Create non-root user for runtime security
RUN groupadd -g 1001 app && useradd -u 1001 -g app -s /bin/sh -m app

WORKDIR /app

# Copy workspace manifests for production install
COPY --chown=app:app package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY --chown=app:app apps/receiver/package.json ./apps/receiver/
COPY --chown=app:app packages/core/package.json ./packages/core/
COPY --chown=app:app packages/diagnosis/package.json ./packages/diagnosis/
COPY --chown=app:app packages/config-typescript/package.json ./packages/config-typescript/
COPY --chown=app:app packages/config-eslint/package.json ./packages/config-eslint/

# Install production deps only
RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts from builder
COPY --chown=app:app --from=builder /app/apps/receiver/dist ./apps/receiver/dist
COPY --chown=app:app --from=builder /app/apps/receiver/src/transport/proto ./apps/receiver/src/transport/proto
COPY --chown=app:app --from=builder /app/apps/console/dist ./apps/console/dist
COPY --chown=app:app --from=builder /app/packages/core/dist ./packages/core/dist
COPY --chown=app:app --from=builder /app/packages/diagnosis/dist ./packages/diagnosis/dist

# Copy receiver package.json for version detection
COPY --chown=app:app apps/receiver/package.json ./apps/receiver/

# Fix ownership of pnpm store and installed node_modules
RUN chown -R app:app /app

ENV NODE_ENV=production
ENV PORT=3000
ENV CONSOLE_DIST_PATH=/app/apps/console/dist

EXPOSE 3000

USER app
CMD ["node", "apps/receiver/dist/server.js"]
