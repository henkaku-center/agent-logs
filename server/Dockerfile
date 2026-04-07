FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.js"]
