# Dockerfile for the FastAPI license server (v1).
#
# In v1 the server does NOT transcode or encrypt videos — institutes run the
# SVP Encryptor desktop app on their own machines. This image is now ~80%
# smaller than the legacy one: no FFmpeg, no transcode workers, no upload
# staging directory.

FROM python:3.12-slim

# Build tools needed by some Python wheels (bcrypt, asyncpg). FFmpeg is GONE.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        libpq-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies first for better Docker layer caching.
COPY pyproject.toml ./
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir .

# Copy the application source
COPY . .

# Railway / Render / Fly / Heroku inject PORT at runtime; default to 8000 for local.
ENV PORT=8000
# Stream stdout/stderr line-by-line so `docker logs` shows print() output
# immediately. Without this, Python buffers stdout until shutdown, making
# live log tailing useless for debugging.
ENV PYTHONUNBUFFERED=1
EXPOSE 8000

# Run Alembic migrations then start the server.
CMD alembic upgrade head && \
    uvicorn app.main:app --host 0.0.0.0 --port ${PORT}
