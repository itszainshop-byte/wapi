FROM node:22-bookworm-slim

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    USERS_FILE=/tmp/whapi-users.json

# Install system dependencies AND Chromium browser
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libu2f-udev \
    libvulkan1 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the full source BEFORE npm install, since a package.json
# lifecycle script (prepare/postinstall) triggers "vite build"
# automatically on install — it needs src/ and index.html present.
COPY . .

ARG VITE_BACKEND_URL
ENV VITE_BACKEND_URL=${VITE_BACKEND_URL}

RUN npm install
RUN npm prune --omit=dev
RUN mkdir -p /tmp/whapi-sessions

ENV NODE_ENV=production \
  PORT=8080 \
  SESSION_ROOT=/tmp/whapi-sessions

EXPOSE 8080

CMD ["node", "backend/server.js"]
