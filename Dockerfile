# Pharmacogenomic Cascade Testing -- container image for the public demonstration.
#
# There is no build step. Node runs the TypeScript directly, which is why the
# image is this small and why there is no builder stage to keep in sync.
#
# The only dependency is PGlite, which is WebAssembly, so nothing here needs a
# compiler and the image is architecture-independent.

FROM node:22-slim

ENV NODE_ENV=production \
    PCT_PUBLIC_DEMO=1 \
    PCT_DATA_DIR=:memory: \
    PORT=8080

WORKDIR /app

# Dependencies first, so a code change does not re-resolve the lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY db ./db
COPY src ./src
COPY scripts ./scripts

# Never run as root. The in-memory database needs no writable volume.
USER node

EXPOSE 8080

# The platform's own probe hits /healthz; this is for anyone running the image
# directly.
HEALTHCHECK --interval=30s --timeout=4s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/api/server.ts"]
