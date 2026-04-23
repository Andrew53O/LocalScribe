# TODO

## Project Specification Review

These items came from the project specification review against the actual README, API types, server pipeline, client workflow, tests, and dependency audit.

## Highest-Value Issues

- [x] Fix `/api/health` so it checks all configured model paths and reports selected-model readiness accurately.
- [x] Harden YouTube cache with metadata validation, lock files, and cache cleanup docs/UI.
- [x] Add a single-job queue or configurable concurrency limit, plus a cancel endpoint. For now, support only one running job at a time.
- [ ] Jobs are memory-only and disappear on restart.
- [ ] OpenAI mode has lower timestamp quality than local Whisper because it returns one guessed segment per chunk.
- [ ] Dependency audit reports Fastify and Vite/esbuild vulnerabilities that need a careful upgrade pass.

## Specification Gaps

- The API contract is still informal: endpoint request/response shapes, status meanings, progress fields, and error formats should be documented.
- The YouTube cache policy needs max size, cleanup behavior, invalidation rules, and safety notes.
- The job lifecycle should define how long results live, what happens after restart, and how partial results behave.
- Upload behavior should document allowed formats, cleanup timing, and common failure cases.
- A license is needed before publishing as a public open-source repository.

## Testing Gaps

- Full mocked job pipeline tests for YouTube cache miss/hit/fallback.
- Upload pipeline tests with mocked `ffmpeg`.
- Health endpoint tests for model-specific env vars.
- Failure tests for missing selected model, bad upload, bad cache file, unavailable `yt-dlp`, and cancellation.
- Frontend tests for interactive sync, settings persistence, history restore, and screenshot generation.
