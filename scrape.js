// Scrapes Citi Roots menu sections and writes products.json
//   - New Arrivals   (the "new-items" collection page)
//   - Staff Picks    (carousel on the menu home page)
//   - Top Sellers    (carousel on the menu home page)
// Usage: node scrape.js [--headed] [--check-link]
const { chromium } = require('playwright');
const fs = require('fs');

const SITE_MENU = 'https://citirootsdispensarynj.com/menu/';
const NEW_ITEMS_URL = `${SITE_MENU}?dtche%5Bpath%5D=collections%2Fnew-items`;
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
  for (let attempt = 0; attempt < 30; attempt++) {
    for (const frame of page.frames()) {
      const count = await frame.locator(selector).count().catch(() => 0);
      if (count > 0) return frame;
    }
    await page.waitForTimeout(1000);
  }
  return null;
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
      category: ctx.category,
      url: slug ? `${ctx.siteMenu}?dtche%5Bpath%5D=product%2F${slug}` : null,
      embeddedUrl: link ? link.href : null,
    };
  });
}

async function scrapeNewArrivals(page, browser) {
  const CARD = '[data-testid="product-list-item"]';
  await page.goto(NEW_ITEMS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await passAgeGate(page);

  const frame = await findFrameWith(page, CARD);
  if (!frame) await failWithDebug(page, browser, 'No New Arrivals products found.');

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

async function scrapeCarousels(page, browser) {
  await page.goto(SITE_MENU, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await passAgeGate(page);

  const frame = await findFrameWith(page, '[data-testid="homepage-carousel-sections"]');
  if (!frame) await failWithDebug(page, browser, 'Menu homepage carousels not found.');

  // Carousel sections are deferred: scroll down so they all render.
  for (let i = 0; i < 15; i++) {
    await frame.evaluate(() => window.scrollBy(0, 800));
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(600);
  }

  const all = [];
  for (const [id, category] of Object.entries(CAROUSELS)) {
    const heading = `[data-testid="${id}-carousel-heading"]`;
    await frame.locator(heading).waitFor({ timeout: 20000 }).catch(() => {});

    // Click "Next" until the carousel stops loading new cards.
    const count = await frame.evaluate(async (heading) => {
      let sec = document.querySelector(heading);
      if (!sec) return -1;
      while (sec && !sec.querySelector('[data-testid="carousel-product-card"]')) sec = sec.parentElement;
      if (!sec) return 0;
      sec.setAttribute('data-scrape-section', heading); // tag it so we can find it again
      const next = sec.querySelector('[class*="carousel-v2__NextButton"]');
      const n = () => sec.querySelectorAll('[data-testid="carousel-product-card"]').length;
      let stable = 0, last = n();
      for (let i = 0; i < 40 && next && stable < 3; i++) {
        next.click();
        await new Promise(r => setTimeout(r, 900));
        const now = n();
        stable = now === last ? stable + 1 : 0;
        last = now;
      }
      return last;
    }, heading);

    if (count <= 0) {
      console.warn(`${category}: carousel not found or empty (skipped)`);
      continue;
    }
    const items = await frame.$$eval(
      `[data-scrape-section='${heading}'] [data-testid="carousel-product-card"]`,
      extractCards,
      { category, siteMenu: SITE_MENU }
    );
    console.log(`${category}: ${items.length}`);
    all.push(...items);
  }
  return all;
}

(async () => {
  const browser = await chromium.launch({ headless: !HEADED });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const { items: newArrivals, frame: newItemsFrame } = await scrapeNewArrivals(page, browser);

  // Optional: click the first New Arrivals card and compare real vs built URL.
  if (process.argv.includes('--check-link') && newArrivals[0]) {
    await newItemsFrame.locator('[data-testid="product-list-item"] a').first().click();
    await page.waitForTimeout(4000);
    console.log('\nBuilt url :', newArrivals[0].url);
    console.log('Real url  :', decodeURIComponent(page.url()), '\n');
  }

  const carouselItems = await scrapeCarousels(page, browser);

  const products = [...newArrivals, ...carouselItems];
  fs.writeFileSync(OUT, JSON.stringify(products, null, 2));
  console.log(`Wrote ${products.length} products to ${OUT}`);
  await browser.close();
})();
