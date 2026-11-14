/* Citi Roots in-store TV slideshow
 *
 * Each page sets its category on <body data-category="...">.
 * Optional URL parameters:
 *   ?seconds=15   seconds each product stays on screen (default 15)
 *   ?refresh=30   minutes between checks for a new products.json (default 30)
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var SECONDS = Math.max(4, Number(params.get('seconds')) || 15);
  var REFRESH_MIN = Math.max(1, Number(params.get('refresh')) || 30);
  var RELOAD_HOURS = 12;   // full page reload now and then keeps old TV browsers healthy

  // Live list straight from the repo (updated by the scraper), with the copy
  // deployed alongside this page as a fallback.
  var DATA_URLS = [
    'https://raw.githubusercontent.com/Carpe-Omnia/citiRootsMenu/main/products.json',
    'products.json'
  ];

  var CATEGORY = document.body.getAttribute('data-category');
  var CACHE_KEY = 'citiroots:' + CATEGORY;

  var slidesEl = document.getElementById('slides');
  var dotsEl = document.querySelector('.dots');
  var barEl = document.querySelector('.bar i');
  var countEl = document.querySelector('.count');

  var products = [];      // what's showing now
  var pending = null;     // a newer list waiting to be swapped in
  var index = -1;
  var layers = [makeLayer(), makeLayer()];
  var front = 0;          // which layer is visible
  var nextReady = null;   // promise: the hidden layer is filled and its image decoded

  /* ---------- Fit the 1080x1920 stage to the screen ---------- */
  function fitStage() {
    var s = Math.min(window.innerWidth / 1080, window.innerHeight / 1920);
    document.getElementById('stage').style.transform = 'scale(' + s + ')';
  }
  window.addEventListener('resize', fitStage);
  fitStage();

  /* ---------- Data ---------- */
  function fetchList() {
    var i = 0;
    function attempt() {
      if (i >= DATA_URLS.length) return Promise.reject(new Error('all sources failed'));
      var url = DATA_URLS[i++];
      return fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .catch(attempt);
    }
    return attempt().then(function (all) {
      var seen = {};
      return all.filter(function (p) {
        if (p.category !== CATEGORY || !p.name) return false;
        var key = p.url || p.name;
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      });
    });
  }

  function saveCache(list) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || []; } catch (e) { return []; }
  }

  function checkForUpdates() {
    return fetchList().then(function (list) {
      if (!list.length) return;
      if (JSON.stringify(list) !== JSON.stringify(products)) {
        pending = list;   // swapped in at the next slide change, never mid-slide
        saveCache(list);
      }
    }).catch(function (e) { console.warn('Update check failed, keeping current list', e); });
  }

  /* ---------- Formatting ---------- */
  // Dutchie serves card images at 104px; ask its image CDN for a big version.
  function bigImage(src) {
    if (!src) return '';
    try {
      var u = new URL(src);
      u.searchParams.set('w', '1000');
      u.searchParams.set('h', '1000');
      u.searchParams.set('fit', 'max');
      return u.toString();
    } catch (e) { return src; }
  }

  // "Wana | 1:1:1 Stay Asleep Dreamberry | THC:CBN:CBG | 10pk"
  //   -> title "1:1:1 Stay Asleep Dreamberry", details "THC:CBN:CBG · 10pk"
  function splitName(p) {
    var parts = String(p.name).split('|').map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length > 1 && p.brand && parts[0].toLowerCase() === String(p.brand).toLowerCase()) parts.shift();
    return { title: parts[0] || p.name, details: parts.slice(1).join('  ·  ') };
  }

  function qrSvg(url) {
    if (!url || typeof qrcode === 'undefined') return '';
    var qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
  }

  /* ---------- Slide layers ---------- */
  function makeLayer() {
    var el = document.createElement('div');
    el.className = 'slide';
    el.innerHTML =
      '<div class="photo"><img alt=""><span class="strain"></span></div>' +
      '<div class="info"><div class="brand"></div><div class="name"></div><div class="details"></div></div>' +
      '<div class="bottom">' +
        '<div class="price-block"><div class="price"></div><div class="thc"></div></div>' +
        '<div class="qr-block"><div class="qr"></div><div class="qr-label">Scan to shop</div></div>' +
      '</div>';
    slidesEl.appendChild(el);
    return el;
  }

  function fitName(el) {
    var size = 72;
    el.style.fontSize = size + 'px';
    while (el.scrollHeight > el.clientHeight + 2 && size > 40) {
      size -= 4;
      el.style.fontSize = size + 'px';
    }
  }

  // Fill a hidden layer and resolve once its image is downloaded and decoded,
  // so the cross-fade never shows a half-loaded picture.
  function fillLayer(layer, p) {
    var n = splitName(p);
    layer.querySelector('.brand').textContent = p.brand || '';
    layer.querySelector('.name').textContent = n.title;
    layer.querySelector('.details').textContent = n.details;
    layer.querySelector('.price').textContent = p.price || '';
    layer.querySelector('.thc').textContent = p.thc ? 'THC ' + p.thc : '';
    layer.querySelector('.strain').textContent = p.strain || '';
    layer.querySelector('.qr').innerHTML = qrSvg(p.url || p.embeddedUrl);
    layer.querySelector('.qr-block').style.visibility = (p.url || p.embeddedUrl) ? 'visible' : 'hidden';
    fitName(layer.querySelector('.name'));

    var img = layer.querySelector('img');
    return new Promise(function (resolve) {
      var done = false;
      function finish() { if (!done) { done = true; resolve(); } }
      img.onload = function () {
        if (img.decode) img.decode().then(finish, finish); else finish();
      };
      img.onerror = function () {          // fall back to the original small image
        if (p.img && img.src !== p.img) img.src = p.img; else finish();
      };
      setTimeout(finish, 15000);           // never wait forever on a slow network
      img.src = bigImage(p.img);
    });
  }

  function prepareNext() {
    if (!products.length) return;
    var i = (index + 1) % products.length;
    nextReady = fillLayer(layers[1 - front], products[i]);
  }

  /* ---------- Progress UI ---------- */
  function renderDots() {
    dotsEl.innerHTML = '';
    for (var i = 0; i < products.length; i++) dotsEl.appendChild(document.createElement('span'));
  }
  function markDot(i) {
    var spans = dotsEl.children;
    for (var j = 0; j < spans.length; j++) spans[j].className = j === i ? 'on' : '';
    countEl.textContent = pad(i + 1) + ' / ' + pad(products.length);
  }
  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function runBar() {
    barEl.style.transition = 'none';
    barEl.style.width = '0';
    void barEl.offsetWidth;                // restart the transition
    barEl.style.transition = 'width ' + SECONDS + 's linear';
    barEl.style.width = '100%';
  }

  /* ---------- Main loop ---------- */
  function showEmpty(msg) {
    slidesEl.innerHTML = '<div class="empty">' + msg + '<small>The menu updates automatically</small></div>';
  }

  function applyPending() {
    if (!pending) return false;
    var currentUrl = products[index] ? products[index].url : null;
    products = pending;
    pending = null;
    // Keep going from where we were if that product is still listed
    var pos = -1;
    for (var i = 0; i < products.length; i++) if (products[i].url === currentUrl) pos = i;
    index = pos;
    renderDots();
    return true;
  }

  function advance() {
    if (applyPending()) prepareNext();
    if (!products.length) return;
    nextReady.then(function () {
      index = (index + 1) % products.length;
      var incoming = layers[1 - front];
      var outgoing = layers[front];
      // Restart the photo push-in animation on the incoming slide
      var img = incoming.querySelector('img');
      img.style.animation = 'none'; void img.offsetWidth; img.style.animation = '';
      incoming.className = 'slide active';
      outgoing.className = 'slide';
      front = 1 - front;
      markDot(index);
      runBar();
      // Load the following card in the background once the fade has finished
      setTimeout(prepareNext, 2000);
      setTimeout(advance, SECONDS * 1000);
    });
  }

  function start(list) {
    products = list;
    if (!products.length) { showEmpty('New products coming soon'); return false; }
    renderDots();
    prepareNext();
    advance();
    return true;
  }

  var cached = loadCache();
  fetchList()
    .then(function (list) { saveCache(list); return list; })
    .catch(function () { return cached; })    // offline? show the last good list
    .then(function (list) {
      if (!start(list)) {
        // Nothing to show yet: keep checking and start as soon as products appear
        var wait = setInterval(function () {
          fetchList().then(function (l) {
            if (l.length) { clearInterval(wait); slidesEl.innerHTML = ''; layers = [makeLayer(), makeLayer()]; saveCache(l); start(l); }
          }).catch(function () {});
        }, REFRESH_MIN * 60000);
      }
    });

  setInterval(checkForUpdates, REFRESH_MIN * 60000);

  // Periodic full reload (picks up page/style changes too), but only if the
  // data source is reachable, so an offline TV keeps showing the slideshow.
  setTimeout(function reloadIfOnline() {
    fetch(DATA_URLS[0] + '?t=' + Date.now(), { method: 'HEAD', cache: 'no-store' })
      .then(function (r) { if (r.ok) location.reload(); else throw 0; })
      .catch(function () { setTimeout(reloadIfOnline, 10 * 60000); });
  }, RELOAD_HOURS * 3600000);
})();
