// Scrapes Citi Roots menu sections and writes products.json
//   - New Arrivals   (the "new-items" collection page)
//   - Staff Picks    (carousel on the menu home page)
//   - Top Sellers    (carousel on the menu home page)
// Usage: node scrape.js [--headed]
const { chromium } = require('playwright');
const fs = require('fs');

const SITE_MENU = 'https://citirootsdispensarynj.com/menu/';
// Pages are read straight from Dutchie (the menu the Citi Roots site embeds in an
// iframe), which avoids the iframe failing to load or never scrolling into view.
const EMBED_MENU = 'https://dutchie.com/embedded-menu/citi-roots/';
const NEW_ITEMS_URL = `${EMBED_MENU}collections/new-items`;
const OUT = 'products.json';
const HEADED = process.argv.includes('--headed');

// Homepage carousels to scrape: Dutchie heading test id -> category label
const CAROUSELS = {
  'staff-picks': 'Staff Picks',
  'top-sellers': 'Top Sellers',
};

// The age gate can live on the main page or inside the Dutchie iframe,
// so check every frame for a "21 or older" button.
async function passAgeGate(page) {
  for (let attempt = 0; attempt < 10; attempt++) {
    for (const frame of page.frames()) {
      const btn = frame.getByRole('button', { name: /21 or older|i am 21|yes/i }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        console.log('Age gate passed');
        return true;
      }
    }
    await page.waitForTimeout(1000);
  }
  console.log('No age gate found (continuing anyway)');
  return false;
}

// Find whichever frame contains `selector` (the menu lives in a Dutchie iframe).
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
async function openWithRetry(page, browser, url, selector, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await passAgeGate(page);
      const frame = await findFrameWith(page, selector);
      if (frame) return frame;
      console.warn(`${label}: page didn't load (attempt ${attempt}/3)`);
    } catch (e) {
      console.warn(`${label}: ${e.message.split('\n')[0]} (attempt ${attempt}/3)`);
    }
    await page.waitForTimeout(5000 * attempt);
  }
  await failWithDebug(page, browser, `${label}: gave up after 3 attempts.`);
}

async function failWithDebug(page, browser, msg) {
  await page.screenshot({ path: 'debug.png', fullPage: true });
  console.error(`${msg} Saved debug.png. Frames seen:`);
  page.frames().forEach(f => console.error('  ', f.url()));
  await browser.close();
  process.exit(1);
}

// Runs in the page: turns product card elements into plain objects.
// Works for both the list cards (New Items) and the carousel cards (homepage).
// Class names end in random hashes (e.g. card-name__Name-sc-336c9886-0 jjVYQI),
// so we match on the stable prefix instead.
function extractCards(cards, ctx) {
  return cards.map(card => {
    const text = sel => card.querySelector(sel)?.textContent.trim() || null;
    const link = card.querySelector('a[href]');
    const href = link?.getAttribute('href') || null; // /embedded-menu/citi-roots/product/<slug>
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
    return {
      name: text('[class*="card-name__Name"]'),
      brand: text('[data-testid="card-brand"]'),
      img: card.querySelector('img')?.getAttribute('src') || null,
      price,
      thc: thc ? thc.replace(/^THC:\s*/i, '') : null,
      strain,
      category: ctx.category,
      url: slug ? `${ctx.siteMenu}?dtche%5Bpath%5D=product%2F${slug}` : null,
      embeddedUrl: link ? link.href : null,
    };
  });
}

async function scrapeNewArrivals(page, browser) {
  const CARD = '[data-testid="product-list-item"]';
  const frame = await openWithRetry(page, browser, NEW_ITEMS_URL, CARD, 'New Arrivals');

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

  const items = await frame.$$eval(CARD, extractCards, { category: 'New Arrivals', siteMenu: SITE_MENU });
  console.log(`New Arrivals: ${items.length}`);
  return { items, frame };
}

// The homepage carousels are scraped from Dutchie's menu page directly (the same
// menu the Citi Roots site embeds). Inside the embedded iframe the carousels never
// scroll into view in a headless browser, so they don't load past the first 7 cards.
async function scrapeCarousels(page, browser) {
  const frame = await openWithRetry(page, browser, EMBED_MENU,
    '[data-testid="homepage-carousel-sections"]', 'Homepage carousels');

  // Carousel sections are deferred: scroll down so they all render.
  await page.mouse.move(640, 450);
  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(600);
  }

  const all = [];
  for (const [id, category] of Object.entries(CAROUSELS)) {
    const heading = `[data-testid="${id}-carousel-heading"]`;
    const headingLoc = frame.locator(heading).first();
    const found = await headingLoc.waitFor({ timeout: 20000 }).then(() => true, () => false);
    if (!found) {
      console.warn(`${category}: carousel not found (skipped)`);
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
      console.warn(`${category}: carousel is empty (skipped)`);
      continue;
    }

    const section = frame.locator(`[data-scrape-section='${heading}']`);
    const cards = section.locator('[data-testid="carousel-product-card"]');
    const next = section.locator('[class*="carousel-v2__NextButton"]').first();

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

    const items = await cards.evaluateAll(extractCards, { category, siteMenu: SITE_MENU });
    console.log(`${category}: ${items.length}`);
    all.push(...items);
  }
  return all;
}

(async () => {
  const browser = await chromium.launch({ headless: !HEADED });
  
  // Create a browser context with a standard desktop User-Agent and viewport
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const { items: newArrivals } = await scrapeNewArrivals(page, browser);

  const carouselItems = await scrapeCarousels(page, browser);

  const products = [...newArrivals, ...carouselItems];
  if (!products.length) {
    console.error('Scraped 0 products; leaving products.json unchanged.');
    await browser.close();
    process.exit(1);
  }
  fs.writeFileSync(OUT, JSON.stringify(products, null, 2));
  console.log(`Wrote ${products.length} products to ${OUT}`);
  await browser.close();
})();