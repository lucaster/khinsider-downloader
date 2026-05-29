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

async function downloadWithRetries(url, destination, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (attempt > 1 && fs.existsSync(destination)) {
        fs.unlinkSync(destination);
      }
      await downloadStream(url, destination);
      return;
    } catch (error) {
      if (attempt === attempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

function parseAnchorLinks(baseUrl, html) {
  const anchors = [];
  const anchorRegex = /<a\b[^>]*\bhref=(['"])([^'">]+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRegex.exec(html))) {
    const href = match[2].trim();
    const text = match[3].replace(/<[^>]+>/g, ' ').trim();
    const index = match.index || 0;
    const before = html.slice(Math.max(0, index - 400), index);
    try {
      const absoluteUrl = new URL(href, baseUrl).toString();
      anchors.push({ href: absoluteUrl, text, index, before });
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

    // attempt to extract a CD and track number from the anchor text or nearby HTML
    let trackNum = null;
    let cdNum = null;
    let titleText = anchor.text;

    // 1) check if the anchor text itself starts with a track number like "1. Title" or "01) Title"
    const textNumMatch = /^\s*(\d{1,3})\s*[\.)\-]\s*(.+)$/s.exec(titleText);
    if (textNumMatch) {
      trackNum = parseInt(textNumMatch[1], 10);
      titleText = textNumMatch[2].trim();
    }

    // 2) if not found, inspect the HTML before the anchor for table cells or numbering
    if (anchor.before) {
      // Attempt to find two consecutive <td>NUMBER</td> entries immediately before the song cell
      const twoTdMatch = /<td[^>]*>\s*(\d{1,3})\s*<\/td>\s*<td[^>]*>\s*(\d{1,3})\s*<\/td>\s*$/i.exec(anchor.before);
      if (twoTdMatch) {
        // first is CD, second is track
        cdNum = parseInt(twoTdMatch[1], 10);
        trackNum = parseInt(twoTdMatch[2], 10);
      } else {
        // collect all <td>...</td> contents and extract numbers inside them (handles nested tags)
        const tdContents = Array.from(anchor.before.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/ig)).map((m) => m[1].replace(/<[^>]+>/g, ' ').trim());
        const tdNums = tdContents.map((c) => {
          const nm = /\b(\d{1,3})\b/.exec(c);
          return nm ? parseInt(nm[1], 10) : null;
        }).filter((n) => n !== null);

        if (tdNums.length >= 2) {
          cdNum = tdNums[tdNums.length - 2];
          trackNum = tdNums[tdNums.length - 1];
        } else if (tdNums.length === 1 && trackNum === null) {
          // only one number found in a nearby <td>, assume it's the track number
          trackNum = tdNums[0];
        } else if (trackNum === null) {
          // fallback: look for a plain number followed by a dot just before the anchor
          const plainMatch = /(\d{1,3})\s*[\.)]\s*$/i.exec(anchor.before.replace(/<[^>]+>/g, ' '));
          if (plainMatch) trackNum = parseInt(plainMatch[1], 10);
        }
      }
    }

    if (!tracks.has(cleanHref)) {
      tracks.set(cleanHref, { href: cleanHref, titles: [], numbers: [], cds: [] });
    }
    tracks.get(cleanHref).titles.push(titleText);
    if (trackNum !== null && !tracks.get(cleanHref).numbers.includes(trackNum)) {
      tracks.get(cleanHref).numbers.push(trackNum);
    }
    if (cdNum !== null && !tracks.get(cleanHref).cds.includes(cdNum)) {
      tracks.get(cleanHref).cds.push(cdNum);
    }
  }

  return Array.from(tracks.values()).map((track) => ({
    href: track.href,
    title: chooseSongTitle(track.titles, track.href),
    number: track.numbers && track.numbers.length > 0 ? track.numbers[0] : null,
    cd: track.cds && track.cds.length > 0 ? track.cds[0] : null,
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

function filenameFromTrack(track) {
  const title = track && track.text ? track.text : (track && track.title ? track.title : null);
  const href = track && track.href ? track.href : (track && track.href ? track.href : null);
  const sanitized = sanitizeFilename(title || (href ? path.basename(new URL(href).pathname) : 'track'));
  const nameWithExt = sanitized.toLowerCase().endsWith('.mp3') ? sanitized : `${sanitized}.mp3`;

  // If we have both CD and track numbers, prefix with CD then track (both two digits)
  if (track && typeof track.cd === 'number' && !Number.isNaN(track.cd) && typeof track.number === 'number' && !Number.isNaN(track.number)) {
    const cd = String(track.cd).padStart(2, '0');
    const num = String(track.number).padStart(2, '0');
    return `${cd} - ${num} - ${nameWithExt}`;
  }

  // If only track number is known, keep previous behavior
  if (track && typeof track.number === 'number' && !Number.isNaN(track.number)) {
    const num = String(track.number).padStart(2, '0');
    return `${num} - ${nameWithExt}`;
  }

  return nameWithExt;
}

// backwards-compatible helper in case other code calls filenameFromTitle
function filenameFromTitle(title, href) {
  return filenameFromTrack({ text: title, href });
}

function getUniqueFilename(filename, seen) {
  if (!seen.has(filename)) {
    seen.add(filename);
    return filename;
  }

  const extension = path.extname(filename);
  const baseName = filename.slice(0, filename.length - extension.length);
  let index = 2;
  let candidate = `${baseName} (${index})${extension}`;

  while (seen.has(candidate)) {
    index += 1;
    candidate = `${baseName} (${index})${extension}`;
  }

  seen.add(candidate);
  return candidate;
}

async function run() {
  console.log(`Fetching album page: ${urlArg}`);

  const html = await httpGetText(urlArg);
  const outputDir = getArgValue('--output-dir') || getDefaultOutputDir(urlArg);
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
      mp3Links.push({ href: directMp3, text: track.title, number: track.number, cd: track.cd });
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
    mp3Links.forEach((link) => {
      const filename = filenameFromTrack(link);
      console.log(`${filename} -> ${link.href}`);
    });
    return;
  }

  ensureDirectory(outputDir);
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  const usedFilenames = new Set();

  for (const link of mp3Links) {
    const baseFilename = filenameFromTrack(link);
    const filename = getUniqueFilename(baseFilename, usedFilenames);
    const destination = path.join(outputDir, filename);

    if (fs.existsSync(destination) && !replaceExisting) {
      console.log(`Skipping existing file: ${filename}`);
      skipped += 1;
      continue;
    }

    process.stdout.write(`Downloading ${filename} ... `);
    try {
      await downloadWithRetries(link.href, destination, 3);
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
