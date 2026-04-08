# Stage 1: Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source and build
COPY . .
# Note: VITE_API_URL can be injected here or handled by Nginx proxy
RUN npm run build

# Stage 2: Serve stage
FROM nginx:alpine

# Copy built files from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Create a default empty gateway.conf so Nginx starts without errors
# The real file is written by the backend via the shared Docker volume
RUN mkdir -p /etc/nginx/nexus-gateway && \
    echo '# Nexus Gateway — initialized (no routes yet)' > /etc/nginx/nexus-gateway/gateway.conf

# Expose port 8000
EXPOSE 8000

CMD ["nginx", "-g", "daemon off;"]
