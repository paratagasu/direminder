# @discordjs/voice 0.19 は Node.js 22.12 以上が必要
FROM node:22

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
