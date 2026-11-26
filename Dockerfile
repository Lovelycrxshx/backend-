# Two processes in one image: the Hono gateway on $PORT (public), and the
# vendored dsh-our-free-model standalone service on loopback only.
#
# Bun is installed because the our-free-model free lane's default transport
# runs under it — without bun those models answer with a TRANSPORT error. The
# data directory lives in a volume so the service keeps its forwardKey across
# deploys (the phone pastes that key once).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash || true

ENV BUN_INSTALL=/usr/local
ENV PATH=/usr/local/bin:$PATH
ENV OFM_HOME=/data/ofm
ENV OFM_PORT=18900
ENV PORT=3000

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

RUN mkdir -p /data/ofm
VOLUME ["/data"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
