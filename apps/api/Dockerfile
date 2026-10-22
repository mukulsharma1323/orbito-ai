FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install
COPY apps/api apps/api
RUN npx prisma generate --schema apps/api/prisma/schema.prisma && npm run build -w @orbito/api
EXPOSE 4000
