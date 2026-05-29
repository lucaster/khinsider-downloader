# khinsider-downloader

## Description

A tool that downloads all the mp3 files of a videogame soundtrack from the website [khinsider](https://downloads.khinsider.com).

The user provides the url of a web page of an album, for example:
https://downloads.khinsider.com/game-soundtracks/album/rumble-roses-xx-xbox-360-gamerip-2006

## Scraping info

The album page contains a link for every song in the album. The song's link's text is the title of the song, which should be used to name the final mp3 file, and it leads to the song's web page. The song's web page contains a link to download the actual mp3 file. This link usually contains this text: "Click here to download as MP3"

## Usage

Run the downloader with Node.js:

```bash
node download_khinsider.js <album-url>
```

Optional flags:

- `--output-dir dir` — save MP3 files into a different directory.
- `--replace` — overwrite existing files.
- `--dry-run` — list discovered MP3 links without downloading.

By default, files are saved into a folder named after the album slug from the URL. For example, the URL `https://downloads.khinsider.com/game-soundtracks/album/rumble-roses-xx-xbox-360-gamerip-2006` will save into `./rumble-roses-xx-xbox-360-gamerip-2006`.

# Tech details

- A simple command line
- NodeJS
