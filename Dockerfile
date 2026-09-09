# Saída do Supabase (AC14): o mesmo motor como container — Cloud Run, ECS, VM ou servidor físico.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY db ./db
COPY package.json ./
USER node
EXPOSE 8787
CMD ["node", "dist/app/main.js"]
