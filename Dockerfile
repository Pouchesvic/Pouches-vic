FROM node:22-bookworm

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY index.html ./
COPY admin.html ./
COPY driver.html ./
COPY sw.js ./

ENV PORT=3000
ENV DATA_DIR=/app/data

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node","server.js"]
