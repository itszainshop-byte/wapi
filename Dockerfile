FROM node:22-bookworm-slim

ENV PUPPETEER_SKIP_DOWNLOAD=false \
    USERS_FILE=/tmp/whapi-users.json

# Libraries required by Chromium used by whatsapp-web.js
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
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
        xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for Docker layer caching
COPY package*.json ./

# Install all dependencies, including devDependencies required by Vite
RUN npm install

# Copy the complete application
COPY . .

# Frontend environment variable
ARG VITE_BACKEND_URL
ENV VITE_BACKEND_URL=${VITE_BACKEND_URL}

# Debug project structure before building
RUN echo "===== APP DIRECTORY =====" \
    && pwd \
    && echo "===== ROOT FILES =====" \
    && ls -la \
    && echo "===== INDEX.HTML / VITE CONFIG =====" \
    && find /app -maxdepth 3 \( -name "index.html" -o -name "vite.config.js" -o -name "vite.config.ts" -o -name "vite.config.mjs" \) -print

# Build frontend
RUN npm run build

# Remove development dependencies after build
RUN npm prune --omit=dev

# Create required sessions directory
RUN mkdir -p /app/sessions

# Production environment
ENV NODE_ENV=production \
    PORT=8080

EXPOSE 8080

CMD ["node", "backend/server.js"]
