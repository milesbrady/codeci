# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Copy package files and install dependencies. The follow-up install of the
# linux-x64-musl rolldown binding works around npm bug #4828 — when the
# lockfile is generated on a different platform (e.g. macOS), npm silently
# skips the platform-specific optional binding and the vite build crashes
# at runtime with "Cannot find native binding".
COPY web/package.json web/package-lock.json ./
RUN npm install \
 && npm install --no-save --no-package-lock @rolldown/binding-linux-x64-musl

# Copy source and build
COPY web/ ./
RUN npm run build

# Final stage
FROM nginx:alpine

# Copy built assets from builder
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy custom nginx config
COPY web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
