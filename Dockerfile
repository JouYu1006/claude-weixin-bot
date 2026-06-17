# Stage 1: Build TypeScript
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src/ src/
RUN npm ci && npx tsc

# Stage 2: Runtime
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/ dist/

VOLUME /app/state
EXPOSE 8080
CMD ["node", "dist/index.js"]
