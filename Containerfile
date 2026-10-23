# NovaDesk — complete image for a fresh install (compose.yaml builds this).
#
# The NOVAAPP01 lab builds the same thing in two layers instead — Containerfile.base (system
# packages + npm dependencies) plus Containerfile.overlay (the app) — so a normal release only
# rebuilds the small top layer. Keep the three in step: a change to one of the steps below belongs in
# the matching base/overlay file too.
FROM node:22-slim
WORKDIR /app

# govc (govmomi CLI) drives the ESXi hosts for the decommission automation. A static binary from the
# project's releases; the file name depends on the CPU of the machine that builds the image.
ARG GOVC_VERSION=v0.56.0
RUN set -eu; \
    case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; x86_64|amd64) arch=x86_64 ;; *) echo "no govc build for $(uname -m)"; exit 1 ;; esac; \
    apt-get update && apt-get install -y --no-install-recommends curl ca-certificates; \
    curl -fsSL -o /tmp/govc.tar.gz "https://github.com/vmware/govmomi/releases/download/${GOVC_VERSION}/govc_Linux_${arch}.tar.gz"; \
    tar -xzf /tmp/govc.tar.gz -C /usr/local/bin govc; \
    chmod +x /usr/local/bin/govc; \
    rm /tmp/govc.tar.gz; \
    govc version; \
    apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY views/ ./views/
COPY public/ ./public/

ARG RELEASE_VERSION=
ENV NOVADESK_RELEASE_VERSION=${RELEASE_VERSION}
ENV PORT=8080
ENV HTTPS_PORT=8443
ENV HOST=0.0.0.0
EXPOSE 8080 8443
CMD ["node", "src/server.js"]
