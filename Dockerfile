# AppStory in one box: Node, Chromium, FFmpeg and the free Kokoro voice model.
#
#   docker build -t app-story .
#   docker run --rm -it -v "$PWD:/work" app-story check acme
#
# Run it from your project folder (the one with apps/ and .env); videos land in output/.
# On Linux, add --user "$(id -u):$(id -g)" so the files it writes belong to you.

# ---- build the npm package from the sources
FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN npm install -g npm@12
COPY . .
RUN npm ci && npm run build && npm pack ./dist/app-story --pack-destination /tmp

# ---- the image people run
FROM node:24-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    APP_STORY_HOME=/work \
    HOME=/tmp
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /tmp/app-story-*.tgz /tmp/
# Install scripts are not needed: the voice model's native parts ship prebuilt.
RUN npm install -g --ignore-scripts /tmp/app-story-*.tgz \
 && rm /tmp/app-story-*.tgz \
 && cd /usr/local/lib/node_modules/app-story \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*
# Download the voice model and the word timing model now, so the first video needs no download
# (same models as KOKORO_DEFAULTS and WORD_TIMING_MODEL).
RUN cd /usr/local/lib/node_modules/app-story \
 && node --input-type=module -e "const { KokoroTTS } = await import('kokoro-js'); await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'cpu' });" \
 && node --input-type=module -e "const { pipeline } = await import('@huggingface/transformers'); await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base.en_timestamped', { dtype: 'fp32', device: 'cpu' });"
WORKDIR /work
ENTRYPOINT ["app-story"]
CMD ["--help"]
