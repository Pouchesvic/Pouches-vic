FROM node:22-bookworm

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY index.html ./
COPY admin.html ./
COPY driver.html ./
COPY sw.js ./
COPY platform-extension.js ./
COPY platform-admin.js ./
COPY platform-driver.js ./
COPY platform-storefront.js ./
COPY scanner.html ./
COPY PLATFORM-ARCHITECTURE.md ./

ENV PORT=3000
ENV DATA_DIR=/app/data

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["npm","start"]
