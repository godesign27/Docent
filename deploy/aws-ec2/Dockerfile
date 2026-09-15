# Docent for one client, built from a `docent bundle` folder, for EC2.
# Build with the bundle as context:
#   docker build -f .deploy/<client-id>/deploy/aws-ec2/Dockerfile -t <image> .deploy/<client-id>
# Differs from the repo's root Dockerfile: runs as the unprivileged `node` user (uid 1000),
# can install from an internal npm registry, and has a container health check.
FROM node:22-slim

# Optional: an internal npm registry, e.g. --build-arg NPM_CONFIG_REGISTRY=https://npm.internal.example/
ARG NPM_CONFIG_REGISTRY

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
# The request log and review queue are the only things Docent writes. Mount a host directory owned by uid 1000 here.
RUN mkdir -p /app/logs && chown node:node /app/logs

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Required at runtime: DOCENT_CLIENT (client id) and DOCENT_TOKEN (at least 24 characters).
CMD ["sh", "-c", "exec node bin/docent.js serve --client \"$DOCENT_CLIENT\" --http --host 0.0.0.0 --port \"$PORT\""]
