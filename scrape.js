// Scrapes dispensary menus into data/<store>/products.json, one config per store
// in stores/<store>.json (menu URL, sections to read, product link pattern).
//
// Usage:
//   node scrape.js                  scrape every store in stores/
//   node scrape.js got-your-six     scrape one store (or several, space-separated)
//   node scrape.js --headed         show the browser while it runs
//
// Section types (all Dutchie menus share these building blocks):
//   "list"      a product list page, e.g. path "collections/new-items"
//   "carousel"  a carousel on the menu home page, by its Dutchie id, e.g. "staff-picks"
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HEADED = process.argv.includes('--headed');
const STORES_DIR = path.join(__dirname, 'stores');
const DATA_DIR = path.join(__dirname, 'data');

function loadStores(ids) {
  const all = fs.readdirSync(STORES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(STORES_DIR, f), 'utf8')));
  if (!ids.length) return all;
  const picked = all.filter(s => ids.includes(s.id));
  const unknown = ids.filter(id => !all.some(s => s.id === id));
  if (unknown.length) throw new Error(`Unknown store(s): ${unknown.join(', ')}`);
  return picked;
}

// The age gate can live on the main page or inside an embedded menu iframe,
// so check every frame for a "21 or older" / "Yes" button.
async function passAgeGate(page) {
  for (let attempt = 0; attempt < 10; attempt++) {
    for (const frame of page.frames()) {
      const btn = frame.getByRole('button', { name: /21 or older|i am 21|yes/i }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        console.log('  Age gate passed');
        return true;
      }
    }
    await page.waitForTimeout(1000);
  }
  console.log('  No age gate found (continuing anyway)');
  return false;
}

// Find whichever frame contains `selector`.
async function findFrameWith(page, selector) {
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const frame of page.frames()) {
      const count = await frame.locator(selector).count().catch(() => 0);
      if (count > 0) return frame;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

// Open a page, pass the age gate and wait for `selector`; retry if it doesn't show up.
async function openWithRetry(page, store, url, selector, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await passAgeGate(page);
      const frame = await findFrameWith(page, selector);
      if (frame) return frame;
      console.warn(`  ${label}: page didn't load (attempt ${attempt}/3)`);
    } catch (e) {
      console.warn(`  ${label}: ${e.message.split('\n')[0]} (attempt ${attempt}/3)`);
    }
    await page.waitForTimeout(5000 * attempt);
  }
  const shot = `debug-${store.id}.png`;
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  throw new Error(`${label}: gave up after 3 attempts (saved ${shot})`);
}

// Runs in the page: turns product card elements into plain objects.
// Works for both the list cards and the carousel cards.
// Class names end in random hashes (e.g. card-name__Name-sc-336c9886-0 jjVYQI),
// so we match on the stable prefix instead.
function extractCards(cards, ctx) {
  return cards.map(card => {
    const text = sel => card.querySelector(sel)?.textContent.trim() || null;
    const link = card.querySelector('a[href]');
    const href = link?.getAttribute('href') || null; // .../product/<slug>
    const slug = href ? href.split('/product/')[1]?.split(/[?#]/)[0] : null;
    const potencies = [...card.querySelectorAll('[class*="card-potency__PotencyItem"]')]
      .map(el => el.textContent.trim());
    const thc = potencies.find(p => /^THC:/i.test(p));
    // Strain pill (Indica, Sativa, Hybrid, Indica-Hybrid...). Some products show
    // other labels there (e.g. "THC", "CBD"), so keep only real strain types.
    const strainText = text('[data-testid="card-strain"]');
    const strain = strainText && /indica|sativa|hybrid/i.test(strainText) ? strainText : null;
    // List cards: tile-price__Price. Carousel cards: card-price__ActivePrice,
    // or the first $ amount in card-price__Price when there is no discount.
    let price = text('[class*="tile-price__Price"]') || text('[class*="card-price__ActivePrice"]');
    if (!price) {
      const m = (text('[class*="card-price__Price"]') || '').match(/\$[\d,.]+/);
      price = m ? m[0] : null;
    }
    // Product page: the store's own pattern if it has one, otherwise the card's link.
    const url = ctx.productUrl && slug
      ? ctx.productUrl.replace('{slug}', slug)
      : (link ? link.href : null);
    return {
      name: text('[class*="card-name__Name"]'),
      brand: text('[data-testid="card-brand"]'),
      img: card.querySelector('img')?.getAttribute('src') || null,
      price,
      thc: thc ? thc.replace(/^THC:\s*/i, '') : null,
      strain,
      category: ctx.category,
      url,
      embeddedUrl: link ? link.href : null,
    };
  });
}

// Carousels can loop around and show the same product twice.
function dedupe(items) {
  const seen = new Set();
  return items.filter(p => {
    const key = p.url || p.name;
    if (!p.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function joinUrl(base, rel) {
  return new URL(rel, base.endsWith('/') ? base : base + '/').toString();
}

async function scrapeList(page, store, section) {
  const CARD = '[data-testid="product-list-item"]';
  const frame = await openWithRetry(page, store, joinUrl(store.menuUrl, section.path), CARD, section.title);

  // Scroll until no new cards appear (lazy loading).
  let prev = -1;
  for (let i = 0; i < 20; i++) {
    const n = await frame.locator(CARD).count();
    if (n === prev) break;
    prev = n;
    await frame.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.mouse.wheel(0, 5000);
    await page.waitForTimeout(1500);
  }
  return frame.$$eval(CARD, extractCards, { category: section.title, productUrl: store.productUrl });
}

// All carousel sections of a store come from one visit to its menu home page.
async function scrapeCarousels(page, store, sections) {
  const results = {};
  if (!sections.length) return results;

  const frame = await openWithRetry(page, store, store.menuUrl,
    '[data-testid="homepage-carousel-sections"]', 'Menu home page');

  // Carousel sections are deferred: scroll down so they all render.
  await page.mouse.move(640, 450);
  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(600);
  }

  for (const section of sections) {
    const heading = `[data-testid="${section.carousel}-carousel-heading"]`;
    const headingLoc = frame.locator(heading).first();
    const found = await headingLoc.waitFor({ timeout: 20000 }).then(() => true, () => false);
    if (!found) {
      console.warn(`  ${section.title}: carousel not found`);
      results[section.id] = [];
      continue;
    }
    await headingLoc.scrollIntoViewIfNeeded();

    // Tag the carousel's section so we can target it.
    const tagged = await frame.evaluate((heading) => {
      let sec = document.querySelector(heading);
      while (sec && !sec.querySelector('[data-testid="carousel-product-card"]')) sec = sec.parentElement;
      if (!sec) return false;
      sec.setAttribute('data-scrape-section', heading);
      return true;
    }, heading);
    if (!tagged) {
      console.warn(`  ${section.title}: carousel is empty`);
      results[section.id] = [];
      continue;
    }

    const box = frame.locator(`[data-scrape-section='${heading}']`);
    const cards = box.locator('[data-testid="carousel-product-card"]');
    const next = box.locator('[class*="carousel-v2__NextButton"]').first();

    // Click "Next" (a real click, with the carousel on screen) until no new cards load.
    let last = await cards.count();
    let stable = 0;
    for (let i = 0; i < 40 && stable < 3; i++) {
      const clicked = await next.click({ timeout: 5000 }).then(() => true, () => false);
      if (!clicked) break;
      await page.waitForTimeout(1200);
      const now = await cards.count();
      stable = now === last ? stable + 1 : 0;
      last = now;
    }

    results[section.id] = await cards.evaluateAll(extractCards,
      { category: section.title, productUrl: store.productUrl });
  }
  return results;
}

async function scrapeStore(browser, store) {
  console.log(`\n=== ${store.name} ===`);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  const outFile = path.join(DATA_DIR, store.id, 'products.json');
  let previous = [];
  try { previous = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) {}

  try {
    const bySection = {};
    for (const section of store.sections.filter(s => s.type === 'list')) {
      bySection[section.id] = await scrapeList(page, store, section);
    }
    Object.assign(bySection,
      await scrapeCarousels(page, store, store.sections.filter(s => s.type === 'carousel')));

    const products = [];
    let fresh = 0;
    for (const section of store.sections) {
      let items = dedupe(bySection[section.id] || []);
      if (items.length) {
        fresh++;
        console.log(`  ${section.title}: ${items.length}`);
      } else {
        // Keep showing the last good list for this section rather than going blank.
        items = previous.filter(p => p.category === section.title);
        console.warn(`  ${section.title}: nothing scraped, keeping ${items.length} from last run`);
      }
      products.push(...items);
    }
    if (!fresh) throw new Error('every section came back empty');

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(products, null, 2) + '\n');
    console.log(`  Wrote ${products.length} products to ${path.relative(__dirname, outFile)}`);
    return true;
  } catch (e) {
    console.error(`  ${store.name} failed: ${e.message}. Its products.json was left unchanged.`);
    return false;
  } finally {
    await context.close();
  }
}

(async () => {
  const ids = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const stores = loadStores(ids);
  const browser = await chromium.launch({ headless: !HEADED });
  let ok = true;
  for (const store of stores) {
    if (!(await scrapeStore(browser, store))) ok = false;
  }
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
