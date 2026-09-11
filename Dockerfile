# One image per client: it carries that client's config, contract and source snapshot.
# Build after `npm run docent -- onboard --client <id>`, push to a private registry only.
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

ENV NODE_ENV=production \
    PORT=8080
EXPOSE 8080

# Required at runtime: DOCENT_CLIENT (client id) and DOCENT_TOKEN (at least 24 characters).
# Mount a volume at /app/logs to keep the request log and review queue across restarts.
CMD ["sh", "-c", "exec node bin/docent.js serve --client \"$DOCENT_CLIENT\" --http --host 0.0.0.0 --port \"$PORT\""]
