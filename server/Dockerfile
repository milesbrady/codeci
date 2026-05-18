# Build stage
FROM golang:1.25-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /app

COPY server/go.mod server/go.sum ./
RUN go mod download

COPY server/ ./

# Pure-Go build (PostgreSQL driver has no CGO dependency).
# Build the package, not just main.go — the package now spans multiple files
# (version.go declares Version, etc.) and `go build main.go` would skip them.
ARG APP_VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags "-X main.Version=${APP_VERSION}" -o main .

# Final stage
FROM alpine:latest

RUN apk add --no-cache \
    git \
    ca-certificates \
    docker-cli \
    bash \
    curl

# Install kubectl — used by execution.k8sRunner when RUNNER_BACKEND=kubernetes
# (Helm deploy). Pinned to a recent stable v1.31.x that works against EKS 1.29+.
RUN ARCH="$(uname -m)" \
    && case "$ARCH" in \
         x86_64) KARCH="amd64" ;; \
         aarch64) KARCH="arm64" ;; \
         *) echo "unsupported arch: $ARCH" && exit 1 ;; \
       esac \
    && curl -fsSL -o /usr/local/bin/kubectl \
        "https://dl.k8s.io/release/v1.31.4/bin/linux/${KARCH}/kubectl" \
    && chmod +x /usr/local/bin/kubectl

WORKDIR /app

COPY --from=builder /app/main .

RUN mkdir -p /app/pipelines

ENV PORT=8080
ENV PIPELINES_DIR=/app/pipelines

EXPOSE 8080

CMD ["./main"]
