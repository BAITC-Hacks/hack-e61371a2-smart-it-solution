FROM node:24.19.0-alpine AS build
WORKDIR /app
COPY Front/package*.json ./
RUN npm ci
COPY Front/index.html Front/tsconfig.json Front/vite.config.ts ./
COPY Front/src ./src
COPY Front/public ./public
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
