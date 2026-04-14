FROM node:24-alpine

WORKDIR /app

COPY package.json postinstall.js ./
RUN npm install --omit=dev

COPY server.js backend-wrapper.js ./

USER 1000
EXPOSE 3000

CMD ["node", "server.js"]
