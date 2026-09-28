# Free-tier friendly image: Node + ffmpeg + Tesseract with French language data.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tesseract-ocr tesseract-ocr-fra \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY data ./data

ENV NODE_ENV=production \
    OMP_THREAD_LIMIT=1 \
    PORT=10000
EXPOSE 10000
USER node
CMD ["node", "--max-old-space-size=320", "server/index.js"]
