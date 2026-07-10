FROM rust:1.93-bookworm AS builder

RUN apt-get -o Acquire::Retries=5 update && apt-get install -y --fix-missing --no-install-recommends \
    libwebkit2gtk-4.1-dev \
    libappindicator3-dev \
    librsvg2-dev \
    patchelf \
    pkg-config \
    libssl-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY crates/charm-web-server ./crates/charm-web-server
COPY src-tauri ./src-tauri

RUN cargo build --release -p charm-web-server

FROM debian:bookworm-slim

RUN apt-get -o Acquire::Retries=5 update && apt-get install -y --fix-missing --no-install-recommends \
    libsqlite3-0 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/target/release/charm-web-server /usr/local/bin/charm-web-server

ENV CHARM_WEB_SERVER_ADDR=0.0.0.0:8787

EXPOSE 8787

ENTRYPOINT ["/usr/local/bin/charm-web-server"]
