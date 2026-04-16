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

   ```powershell
   npm install
   ```

2. Copy `.env.example` to `.env`:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Install `yt-dlp` and `ffmpeg`.

   On this machine they are installed in `C:\yt-dlp`. If they are elsewhere, update these lines in `.env`:

   ```env
   YTDLP_BIN=C:\path\to\yt-dlp.exe
   FFMPEG_BIN=C:\path\to\ffmpeg.exe
   ```

4. Download `whisper.cpp` and the recommended model.

   Automatic PowerShell install into this project:

   ```powershell
   New-Item -ItemType Directory -Force -Path tools\downloads, tools\whisper.cpp, models
   curl.exe -L -o tools\downloads\whisper-bin-x64.zip https://sourceforge.net/projects/whisper-cpp.mirror/files/v1.8.2/whisper-bin-x64.zip/download
   tar -xf tools\downloads\whisper-bin-x64.zip -C tools\whisper.cpp
   curl.exe -L -o models\ggml-large-v3-turbo-q8_0.bin "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin?download=true"
   ```

   Then set these lines in `.env`:

   ```env
   WHISPER_CPP_BIN=E:\allProject\13. Youtube Transcribe\tools\whisper.cpp\Release\whisper-cli.exe
   WHISPER_MODEL_PATH=E:\allProject\13. Youtube Transcribe\models\ggml-large-v3-turbo-q8_0.bin
   ```

   Manual download option:

   - Download `whisper-bin-x64.zip` from the `whisper.cpp` release mirror.
   - Extract it and find `whisper-cli.exe`.
   - Download `ggml-large-v3-turbo-q8_0.bin` from `ggerganov/whisper.cpp` on Hugging Face.
   - Put those two absolute paths into `.env`.

5. Start the app:

   ```powershell
   npm run dev
   ```

6. Open `http://127.0.0.1:5173`.

The app now checks `yt-dlp`, `ffmpeg`, `whisper-cli`, and the model file on startup. If any local prerequisite is missing, the UI shows which one failed.

## NVIDIA GPU Acceleration

Yes, this project can use an NVIDIA graphics card. The app runs whatever `whisper-cli.exe` you put in `WHISPER_CPP_BIN`, and it does not pass `--no-gpu`, so a GPU-enabled whisper.cpp build can use the GPU automatically.

For Windows with NVIDIA:

1. Make sure your NVIDIA driver is installed.
2. Download a CUDA/cuBLAS whisper.cpp build instead of the CPU build.
   - CUDA 12.x: `whisper-cublas-12.4.0-bin-x64.zip`
   - CUDA 11.x: `whisper-cublas-11.8.0-bin-x64.zip`
3. Extract it into a local ignored folder, for example `tools\whisper.cpp-cuda`.
4. Set `.env` to the CUDA build:

   ```env
   WHISPER_CPP_BIN=E:\allProject\13. Youtube Transcribe\tools\whisper.cpp-cuda\Release\whisper-cli.exe
   WHISPER_MODEL_PATH=E:\allProject\13. Youtube Transcribe\models\ggml-large-v3-turbo-q8_0.bin
   ```

The model file is the same for CPU and GPU. Only the `whisper-cli.exe` build changes.

## Git Ignore Notes

The model and local tool folders are intentionally ignored:

```gitignore
models/
tools/
```

Do not commit the Whisper model or extracted binaries. The model is large, and each user should download it locally.

## Optional OpenAI Mode

The app works without an OpenAI API key. If you later add `OPENAI_API_KEY`, the UI can use OpenAI transcription as an optional provider. Local mode remains the default.

## Notes

- Captions and subtitles are not required.
- The app extracts audio for the selected time range, normalizes it, transcribes it, splits it into sentences, and highlights suspicious spans before display.
- The transcript preserves the spoken language. It does not translate.
