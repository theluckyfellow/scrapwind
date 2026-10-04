FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist /app/dist
COPY server /app/server
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server/index.js"]