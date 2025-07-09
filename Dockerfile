FROM node:20

WORKDIR /app

# 必要なファイルだけ明示的にコピーする（順番も重要）
COPY package*.json ./
COPY index.js ./
COPY settings.json ./
COPY .env ./

RUN ls -la     # デバッグ目的でそのまま残してOK
RUN npm install

EXPOSE 3000
CMD ["node", "index.js"]