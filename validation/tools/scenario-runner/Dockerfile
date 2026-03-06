FROM node:20-alpine

WORKDIR /app

COPY package.json /app/package.json
RUN npm install --omit=dev

COPY run.js /app/run.js

CMD ["node", "/app/run.js", "third_party_api_rate_limit_cascade"]

