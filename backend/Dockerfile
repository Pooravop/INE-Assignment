# Backend image for Render. Build context is the REPO ROOT (see render.yaml).
#
# The Playwright base image already contains Chromium, its system libraries and Xvfb.
# The tag MUST match the "playwright" version pinned in backend/package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    # Render's free tier has 512 MB: keep Node's heap small and leave the rest to Chromium.
    NODE_OPTIONS=--max-old-space-size=192 \
    # The store's session check passes a real (headed) browser more often than a headless one.
    # Xvfb (below) gives Chromium a virtual display so it can run headed inside the container.
    SCRAPE_HEADED=1 \
    SCRAPE_CONCURRENCY=1

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --include=dev --ignore-scripts

COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/sql ./sql
RUN npm run build && npm prune --omit=dev --ignore-scripts

EXPOSE 8080
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1920x1080x24", "node", "dist/server.js"]
