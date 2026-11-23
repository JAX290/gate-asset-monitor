# ---------------------------------------------------------------------------
# Gate Asset Monitor - minimal, dependency-free image
# ---------------------------------------------------------------------------
FROM node:22-alpine

# Run as non-root for safety
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

# Persist snapshots here (mount a volume)
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data

EXPOSE 8787
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/auth/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
