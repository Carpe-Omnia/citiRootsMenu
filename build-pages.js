// Generates the TV pages from the store configs:
//   stores/<store>.json  ->  <store>/<section>.html  (+ <store>/index.html listing them)
//
// Run after adding or editing a store:   npm run build
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;

// The GitHub repo the live product data is read from (raw.githubusercontent.com).
function repoSlug() {
  try {
    const url = execSync('git config --get remote.origin.url', { cwd: ROOT }).toString().trim();
    const m = url.match(/github\.com[:/](.+?\/.+?)(\.git)?$/);
    if (m) return m[1];
  } catch (e) {}
  return 'Carpe-Omnia/citiRootsMenu';
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// "Popular Flower" -> "Popular<br>Flower" so titles sit on two big lines
function titleHtml(title) {
  const i = title.indexOf(' ');
  return i < 0 ? esc(title) : esc(title.slice(0, i)) + '<br>' + esc(title.slice(i + 1));
}

function page(store, section, repo) {
  const d = store.display;
  const sources = [
    `https://raw.githubusercontent.com/${repo}/main/data/${store.id}/products.json`,
    `../data/${store.id}/products.json`,
  ].join('|');
  const [a1, a2] = section.accent || ['#c8f169', '#8fd14f'];
  const emblem = d.emblem
    ? `\n    <div class="emblem"><img src="../${esc(d.emblem)}" alt=""></div>` : '';
  // Optional large, faint brand mark behind everything
  const watermark = d.watermark
    ? `\n  <div class="watermark"><img src="../${esc(d.watermark)}" alt=""></div>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(store.name)} | ${esc(section.title)}</title>
<link rel="stylesheet" href="../assets/display.css">
</head>
<body data-store="${esc(store.id)}" data-store-theme="${esc(d.theme || store.id)}"
      data-category="${esc(section.title)}" data-sources="${esc(sources)}"
      style="--accent: ${esc(a1)}; --accent-2: ${esc(a2)};${d.background ? ` --pattern: url(../${esc(d.background)});` : ''}"${d.background ? ' class="has-pattern"' : ''}>
<div id="stage">
  <div class="glow one"></div>
  <div class="glow two"></div>${watermark}
  <header>
    <div class="eyebrow"><img class="wordmark" src="../${esc(d.wordmark)}" alt="${esc(store.name)}"><span class="rule"></span><span class="count"></span></div>${emblem}
    <h1>${titleHtml(section.title)}</h1>
    <p class="tagline">${esc(section.tagline || '')}</p>
  </header>
  <div id="slides"></div>
  <footer>
    <div class="dots"></div>
    <div class="bar"><i></i></div>
  </footer>
</div>
<script src="../assets/qrcode.js"></script>
<script src="../assets/display.js"></script>
</body>
</html>
`;
}

function indexPage(store) {
  const links = store.sections
    .map(s => `  <li><a href="${esc(s.id)}.html">${esc(s.title)}</a></li>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(store.name)} TV menus</title>
<meta name="robots" content="noindex">
<style>body{font:24px/1.6 system-ui,sans-serif;background:#111;color:#eee;padding:60px}a{color:#9be873}</style>
</head><body>
<h1>${esc(store.name)} TV menus</h1>
<p>Open one page per TV. Double-click (or press OK twice on the remote) for fullscreen.</p>
<ul>
${links}
</ul>
<p>Add <code>?seconds=20</code> to a link to change how long each product stays up.</p>
</body></html>
`;
}

const repo = repoSlug();
const stores = fs.readdirSync(path.join(ROOT, 'stores')).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(ROOT, 'stores', f), 'utf8')));

for (const store of stores) {
  const dir = path.join(ROOT, store.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const section of store.sections) {
    fs.writeFileSync(path.join(dir, `${section.id}.html`), page(store, section, repo));
  }
  fs.writeFileSync(path.join(dir, 'index.html'), indexPage(store));
  console.log(`${store.name}: ${store.sections.map(s => `${store.id}/${s.id}.html`).join(', ')}`);
}
console.log(`Live data is read from github.com/${repo}`);
