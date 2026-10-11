FROM node:24-bookworm-slim
WORKDIR /app
COPY source-host/ ./
USER node
EXPOSE 9120
CMD ["node", "server.mjs"]
