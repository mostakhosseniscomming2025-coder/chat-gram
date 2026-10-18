FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY boot.js backup.js server.js store.js security.js ./
COPY public ./public
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "boot.js"]
