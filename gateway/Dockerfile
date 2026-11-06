FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY chains.json ./
USER node
EXPOSE 8080
CMD ["node", "src/index.js"]
