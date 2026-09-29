FROM node:20-alpine
WORKDIR /app
COPY relay.mjs portal.mjs ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "relay.mjs"]
