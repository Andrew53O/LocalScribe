# YouTube Segment Transcriber

Local-first web app for transcribing a chosen part of a YouTube video from audio. It is designed for videos with no subtitles and supports English, Traditional Chinese Taiwan, Indonesian, and natural English code-switching.

## Requirements

- Node.js 20+
- `yt-dlp`
- `ffmpeg`
- `whisper.cpp`
- A Whisper GGML model file

Recommended local model:

- `large-v3-turbo-q8_0`: about 834 MiB, best default balance for a normal laptop.

Other useful options:

- `large-v3-turbo-q5_0`: about 547 MiB, lighter but a little less accurate.
- `large-v3`: about 2.9 GiB, higher quality but slower and heavier.

Avoid `.en` models for this app because they are English-only.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and set:

   ```env
   WHISPER_CPP_BIN=C:\path\to\whisper-cli.exe
   WHISPER_MODEL_PATH=C:\path\to\ggml-large-v3-turbo-q8_0.bin
   ```

3. Start the app:

   ```bash
   npm run dev
   ```

4. Open `http://127.0.0.1:5173`.

## Optional OpenAI Mode

The app works without an OpenAI API key. If you later add `OPENAI_API_KEY`, the UI can use OpenAI transcription as an optional provider. Local mode remains the default.

## Notes

- Captions and subtitles are not required.
- The app extracts audio for the selected time range, normalizes it, transcribes it, splits it into sentences, and highlights suspicious spans before display.
- The transcript preserves the spoken language. It does not translate.
