FROM node:18-alpine
RUN npm install -g pnpm
WORKDIR /app
COPY . .
RUN cd artifacts/api-server && pnpm install --no-frozen-lockfile && pnpm run build
EXPOSE 8080
CMD ["node", "artifacts/api-server/dist/index.cjs"]
