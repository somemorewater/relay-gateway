FROM rust:1-slim AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=build /app/target/release/relay-verifier /usr/local/bin/relay-verifier
EXPOSE 7001
CMD ["relay-verifier"]
