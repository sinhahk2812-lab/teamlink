FROM node:22-alpine
WORKDIR /app
RUN npm init -y >/dev/null && npm install ws@8
COPY server.js ./relay/server.js
ENV PORT=8080
EXPOSE 8080
CMD ["node", "relay/server.js"]
