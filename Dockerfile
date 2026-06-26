# ============================================================================
# Dockerfile — Two-Stage Build for Render Deployment
# ============================================================================
#
# WHY TWO STAGES?
# ----------------
# Stage 1 ("builder") installs all the heavy build tools (g++, cmake, etc.)
# and compiles our server. This image is ~1GB+.
#
# Stage 2 ("runner") is a clean, slim image. We copy ONLY the compiled
# binary and the static files into it. Final image is ~100MB.
#
# This is called a "multi-stage build" — a Docker best practice.
# ============================================================================

# ============================================================================
# STAGE 1: BUILD
# ============================================================================
FROM ubuntu:22.04 AS builder

# Prevent interactive prompts during apt-get
ENV DEBIAN_FRONTEND=noninteractive

# Install build dependencies
RUN apt-get update && apt-get install -y \
    g++ \
    cmake \
    make \
    git \
    libboost-all-dev \
    libasio-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy our source code into the container
WORKDIR /app
COPY CMakeLists.txt server.cpp ./

# Build the project
# -DCROW_FEATURES="ssl" is NOT set — we don't need SSL because Render
# handles HTTPS termination for us (Render's proxy → our plain HTTP server).
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --parallel $(nproc)

# ============================================================================
# STAGE 2: RUN
# ============================================================================
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install only runtime dependencies (much smaller than build deps)
RUN apt-get update && apt-get install -y \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the compiled binary from the builder stage
COPY --from=builder /app/build/chatserver .

# Copy static frontend files
COPY static/ ./static/

# Render sets the PORT environment variable. Our server reads it.
# EXPOSE is just documentation — Render ignores it and uses PORT.
EXPOSE 8080

# Run the server
CMD ["./chatserver"]
