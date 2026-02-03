# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build arguments for environment variables
# Note: Database labels and names are now fetched from the backend API at runtime
# Only VITE_API_URL is needed for build time (but will be overridden at runtime by config.js)
ARG VITE_API_URL=http://localhost:3000

ENV VITE_API_URL=$VITE_API_URL

# Build the application
RUN npm run build

## Production stage - using nginx to serve static files
FROM nginx:alpine

# Copy built files
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost/ || exit 1

# Startup script to inject runtime config
RUN echo '#!/bin/sh' > /docker-entrypoint.sh && \
    echo 'BACKEND_URL=${BACKEND_URL:-http://localhost:3000}' >> /docker-entrypoint.sh && \
    echo 'sed -i "s|BACKEND_URL_PLACEHOLDER|$BACKEND_URL|g" /usr/share/nginx/html/config.js' >> /docker-entrypoint.sh && \
    echo 'exec nginx -g "daemon off;"' >> /docker-entrypoint.sh && \
    chmod +x /docker-entrypoint.sh

# Start with config injection
CMD ["/docker-entrypoint.sh"]
