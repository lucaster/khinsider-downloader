#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const http = require('http');
const https = require('https');

const args = process.argv.slice(2);
const helpText = `Usage:
  node download_khinsider.js <album-url> [--output-dir dir] [--replace] [--dry-run]

Options:
  --output-dir dir   save MP3 files into dir (defaults to the album slug folder)
  --replace          overwrite existing files with the same name
  --dry-run          list discovered MP3 files without downloading
  -h, --help         show this help text
`;

function usage(message) {
  if (message) {
    console.error(`Error: ${message}\n`);
    process.exitCode = 1;
  }
  console.error(helpText);
  process.exit(message ? 1 : 0);
}

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  usage();
}

const urlArg = args.find((arg) => !arg.startsWith('-'));
if (!urlArg) {
  usage('missing album page URL');
}

const replaceExisting = args.includes('--replace');
const dryRun = args.includes('--dry-run');

function getDefaultOutputDir(albumUrl) {
  try {
    const parsed = new URL(albumUrl);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length > 0) {
      return path.join(process.cwd(), segments[segments.length - 1]);
    }
  } catch (_) {
    // ignore invalid URL, fallback to cwd
  }
  return process.cwd();
}

function getAlbumOutputDir(albumUrl, html) {
  const titleMatch = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
  if (title) {
    return path.join(process.cwd(), sanitizeFilename(title));
  }
  return getDefaultOutputDir(albumUrl);
}

function getArgValue(option) {
  const index = args.indexOf(option);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/^[\.]+/, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function httpGetText(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { headers: { 'User-Agent': 'Node.js khinsider-downloader/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).toString();
        resolve(httpGetText(redirectUrl));
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`Failed to fetch ${url}: ${res.statusCode} ${res.statusMessage}`));
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

    request.on('error', reject);
  });
}

function downloadStream(url, destination) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { headers: { 'User-Agent': 'Node.js khinsider-downloader/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).toString();
        resolve(downloadStream(redirectUrl, destination));
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`Failed to download ${url}: ${res.statusCode} ${res.statusMessage}`));
        return;
      }

      const file = fs.createWriteStream(destination);
      res.pipe(file);
      res.on('error', reject);
      file.on('error', reject);
      file.on('finish', resolve);
    });

    request.on('error', reject);
  });
}

function parseAnchorLinks(baseUrl, html) {
  const anchors = [];
  const anchorRegex = /<a\b[^>]*\bhref=(['"])([^'">]+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRegex.exec(html))) {
    const href = match[2].trim();
    const text = match[3].replace(/<[^>]+>/g, ' ').trim();
    try {
      const absoluteUrl = new URL(href, baseUrl).toString();
      anchors.push({ href: absoluteUrl, text });
    } catch (_) {
      // ignore invalid URLs
    }
  }

  return anchors;
}

function stripUrlQuery(urlStr) {
  try {
    const url = new URL(urlStr);
    url.search = '';
    return url.toString();
  } catch (_) {
    return urlStr;
  }
}

function chooseSongTitle(candidates, fallbackHref) {
  const normalized = candidates.map((text) => text.trim()).filter(Boolean);
  const badPatterns = [
    /^get_app$/i,
    /^click here$/i,
    /^download$/i,
    /^\d{1,2}:\d{2}$/,
    /^[\d.]+\s*(?:MB|KB|kb|mb)$/i,
    /^\s*$/,
  ];

  for (const text of normalized) {
    if (badPatterns.some((re) => re.test(text))) continue;
    return text;
  }

  if (normalized.length > 0) {
    return normalized[0];
  }

  try {
    return path.basename(new URL(fallbackHref).pathname) || 'track';
  } catch (_) {
    return 'track';
  }
}

function extractAlbumTracks(albumUrl, html) {
  const anchors = parseAnchorLinks(albumUrl, html);
  const tracks = new Map();

  for (const anchor of anchors) {
    if (!isAlbumTrackPageLink(anchor.href, albumUrl)) continue;
    const cleanHref = stripUrlQuery(anchor.href);
    if (!cleanHref.toLowerCase().endsWith('.mp3')) continue;

    if (!tracks.has(cleanHref)) {
      tracks.set(cleanHref, { href: cleanHref, titles: [] });
    }
    tracks.get(cleanHref).titles.push(anchor.text);
  }

  return Array.from(tracks.values()).map((track) => ({
    href: track.href,
    title: chooseSongTitle(track.titles, track.href),
  }));
}

function isAlbumTrackPageLink(candidateHref, albumUrl) {
  try {
    const candidateUrl = new URL(candidateHref);
    const albumUrlObj = new URL(albumUrl);
    const albumPath = albumUrlObj.pathname.replace(/\/$/, '');
    const candidatePath = candidateUrl.pathname.replace(/\/$/, '');
    if (candidateUrl.origin !== albumUrlObj.origin) return false;
    return candidatePath === albumPath || candidatePath.startsWith(`${albumPath}/`);
  } catch (_) {
    return false;
  }
}

function isDirectMp3DownloadLink(href, albumUrl) {
  try {
    const candidateUrl = new URL(href, albumUrl);
    if (!/\.mp3(?:$|\?)/i.test(candidateUrl.pathname + candidateUrl.search)) {
      return false;
    }
    if (isAlbumTrackPageLink(candidateUrl.toString(), albumUrl)) {
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function extractDirectMp3DownloadLink(trackPageUrl, html) {
  const anchors = parseAnchorLinks(trackPageUrl, html);

  for (const anchor of anchors) {
    const text = anchor.text.toLowerCase();
    if (text.includes('click here to download as mp3') && isDirectMp3DownloadLink(anchor.href, trackPageUrl)) {
      return anchor.href;
    }
  }

  const audioRegex = /<audio\b[^>]*\bsrc=(['"])([^'">]+)\1/i;
  const audioMatch = audioRegex.exec(html);
  if (audioMatch) {
    try {
      return new URL(audioMatch[2].trim(), trackPageUrl).toString();
    } catch (_) {
      // ignore invalid URLs
    }
  }

  for (const anchor of anchors) {
    if (isDirectMp3DownloadLink(anchor.href, trackPageUrl)) {
      return anchor.href;
    }
  }

  return null;
}

function uniqueLinks(links) {
  const seen = new Set();
  return links.filter((link) => {
    if (seen.has(link.href)) return false;
    seen.add(link.href);
    return true;
  });
}

function filenameFromTitle(title, href) {
  const sanitized = sanitizeFilename(title || path.basename(new URL(href).pathname));
  return sanitized.toLowerCase().endsWith('.mp3') ? sanitized : `${sanitized}.mp3`;
}

async function run() {
  console.log(`Fetching album page: ${urlArg}`);

  const html = await httpGetText(urlArg);
  const outputDir = getArgValue('--output-dir') || getAlbumOutputDir(urlArg, html);
  const albumTracks = extractAlbumTracks(urlArg, html);
  let mp3Links = [];
  let trackPagesScanned = 0;

  if (albumTracks.length === 0) {
    console.error('No song links were found on the album page.');
    process.exitCode = 1;
    return;
  }

  console.log(`Found ${albumTracks.length} song link${albumTracks.length === 1 ? '' : 's'}; resolving MP3 URLs...`);

  for (const track of albumTracks) {
    try {
      const pageHtml = await httpGetText(track.href);
      const directMp3 = extractDirectMp3DownloadLink(track.href, pageHtml);
      if (!directMp3) {
        console.warn(`Warning: no direct MP3 download link found for ${track.title || track.href}`);
        continue;
      }
      mp3Links.push({ href: directMp3, text: track.title });
      trackPagesScanned += 1;
    } catch (error) {
      console.warn(`Warning: failed to retrieve track page ${track.href}: ${error.message}`);
    }
  }

  mp3Links = uniqueLinks(mp3Links);

  if (mp3Links.length === 0) {
    console.error('No MP3 links were found on the album page or linked track pages.');
    process.exitCode = 1;
    return;
  }

  console.log(`Found ${mp3Links.length} MP3 track${mp3Links.length === 1 ? '' : 's'}` + (trackPagesScanned ? ` after scanning ${trackPagesScanned} track page${trackPagesScanned === 1 ? '' : 's'}` : '') + '.');

  if (dryRun) {
    mp3Links.forEach((link) => console.log(link.href));
    return;
  }

  ensureDirectory(outputDir);
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const link of mp3Links) {
    const filename = filenameFromTitle(link.text, link.href);
    const destination = path.join(outputDir, filename);

    if (fs.existsSync(destination) && !replaceExisting) {
      console.log(`Skipping existing file: ${filename}`);
      skipped += 1;
      continue;
    }

    process.stdout.write(`Downloading ${filename} ... `);
    try {
      await downloadStream(link.href, destination);
      console.log('done');
      downloaded += 1;
    } catch (error) {
      console.log('failed');
      console.error(`  ${error.message}`);
      failed += 1;
    }
  }

  console.log(`\nSummary: downloaded ${downloaded}, skipped ${skipped}, failed ${failed}.`);
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
