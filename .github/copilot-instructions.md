# Copilot Instructions for khinsider-downloader

This repository currently contains only a project description in `README.md`.

## Project overview

- Purpose: download all MP3 files for a video game soundtrack from `https://downloads.khinsider.com`.
- Input: a khinsider album page URL.
- Behavior: scrape the album page, discover MP3 links, and download each file into the current folder.

## Guidance for AI coding agents

- Start from the README and avoid assuming project language or implementation details unless source files appear.
- If source code is added later, use the project description above to infer the intended behavior.
- Prefer a small, clear implementation that: 1) fetches the album page, 2) extracts MP3 links, 3) downloads files, and 4) saves them in the working directory.
- Document any assumptions in code comments or a new `README.md` section.

## If you add code

- Link new implementation files to this repo's description.
- Keep the tool simple and robust against missing links or malformed pages.
- Use a single command-line entrypoint or script if the project is a downloader utility.
