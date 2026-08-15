FROM node:22-bookworm-slim
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY index.html ./
COPY admin.html ./

ENV PORT=3000
ENV DATA_DIR=/data

RUN mkdir -p /data

EXPOSE 3000

CMD ["node","server.js"]
