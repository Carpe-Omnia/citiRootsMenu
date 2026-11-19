/* Mobile product feed: products from the dispensaries nearest the visitor,
 * one full-screen card at a time, swiped vertically.
 *
 * Data:
 *   data/stores.json            every store we have product data for, with its
 *                               map position (built by build-pages.js)
 *   data/<store>/products.json  that store's products (written by scrape.js)
 *   assets/nj-zips.json         ZIP code centre points, for the "enter a ZIP" option
 *
 * Only the nearest stores' products are loaded at first; more stores are loaded
 * (in order of distance) as the visitor nears the end of the feed.
 */
(function () {
  'use strict';

  var STORES_PER_BATCH = 6;      // how many stores' products to load at a time
  var LOAD_MORE_WHEN_LEFT = 4;   // cards left before loading the next batch

  var $ = function (id) { return document.getElementById(id); };
  var gate = $('gate'), feed = $('feed'), topbar = $('topbar');

  var state = {
    loc: null,          // { lat, lng, label }
    stores: [],         // sorted by distance
    nextStore: 0,       // index of the next store to load
    loading: false,
    cards: 0,
  };

  /* ---------- small helpers ---------- */
  function store(key, val) {
    try { if (val === undefined) return JSON.parse(localStorage.getItem(key)); localStorage.setItem(key, JSON.stringify(val)); }
    catch (e) { return null; }
  }
  function getJSON(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function miles(a, b) {
    var R = 3958.8, toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad, dLng = (b.lng - a.lng) * toRad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function milesLabel(m) {
    if (m == null) return '';
    if (m < 1) return 'Under 1 mi away';
    return '≈ ' + (m < 10 ? m.toFixed(1) : Math.round(m)) + ' mi away';
  }
  // Dutchie serves card images small; ask its image CDN for a bigger one.
  function bigImage(src) {
    if (!src) return '';
    try {
      var u = new URL(src);
      u.searchParams.set('w', '800'); u.searchParams.set('h', '800'); u.searchParams.set('fit', 'max');
      return u.toString();
    } catch (e) { return src; }
  }
  // "Wana | 1:1:1 Stay Asleep | THC:CBN:CBG | 10pk" -> title + details, brand prefix dropped
  function splitName(p) {
    var parts = String(p.name).split('|').map(function (s) { return s.trim(); }).filter(Boolean);
    var norm = function (t) { return String(t).toLowerCase().replace(/[^a-z0-9]/g, ''); };
    if (parts.length > 1 && p.brand && norm(parts[0]) === norm(p.brand)) parts.shift();
    return { title: parts[0] || p.name, details: parts.slice(1).join(' · ') };
  }
  function singular(title) {   // "Staff Picks" -> "Staff Pick", "Specials" -> "Special"
    return String(title).replace(/s$/i, '').replace(/ie$/i, 'y');
  }
  // Same order all day for a given visitor, different tomorrow
  function seededShuffle(arr, seed) {
    var a = arr.slice(), s = seed;
    for (var i = a.length - 1; i > 0; i--) {
      s = (s * 9301 + 49297) % 233280;
      var j = Math.floor((s / 233280) * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------- location ---------- */
  var zipTable = null;
  function zips() {
    return zipTable ? Promise.resolve(zipTable)
      : getJSON('assets/nj-zips.json').then(function (t) { zipTable = t; return t; });
  }
  function nearestTown(lat, lng) {
    return zips().then(function (t) {
      var best = null, bestD = Infinity;
      for (var z in t) {
        var d = miles({ lat: lat, lng: lng }, { lat: t[z][0], lng: t[z][1] });
        if (d < bestD) { bestD = d; best = t[z][2]; }
      }
      return bestD < 25 ? best : null;
    }).catch(function () { return null; });
  }
  function useGPS() {
    msg('Finding you...');
    if (!navigator.geolocation) { msg("This browser can't share location. Enter a ZIP code instead."); showZip(); return; }
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude, lng = pos.coords.longitude;
      nearestTown(lat, lng).then(function (town) {
        start({ lat: lat, lng: lng, label: town ? 'Near ' + town : 'Near you' });
      });
    }, function () {
      msg("Couldn't get your location. Enter a ZIP code instead.");
      showZip();
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 10 * 60 * 1000 });
  }
  function useZip(zip) {
    zips().then(function (t) {
      var hit = t[zip];
      if (!hit) { msg("That doesn't look like a New Jersey ZIP code."); return; }
      start({ lat: hit[0], lng: hit[1], label: hit[2] + ' ' + zip });
    }).catch(function () { msg("Couldn't load ZIP codes. Check your connection and try again."); });
  }
  function msg(t) { $('gateMsg').textContent = t || ''; }
  function showZip() { $('zipForm').hidden = false; $('zipInput').focus(); }

  /* ---------- feed ---------- */
  function start(loc) {
    state.loc = loc;
    store('feed:loc', loc);
    store('feed:21', true);
    $('locLabel').textContent = loc.label;
    gate.hidden = true; topbar.hidden = false; feed.hidden = false;
    feed.innerHTML = '';
    feed.scrollTop = 0;
    state.cards = 0; state.nextStore = 0; state.hinted = false;

    getJSON('data/stores.json').then(function (d) {
      state.stores = d.stores.map(function (s) {
        s.distance = (s.lat != null && s.lng != null) ? miles(loc, s) : null;
        return s;
      }).sort(function (a, b) {
        return (a.distance == null ? 1e9 : a.distance) - (b.distance == null ? 1e9 : b.distance);
      });
      return loadMore();
    }).catch(function () {
      feed.innerHTML = endCard("Couldn't load dispensaries", 'Check your connection and try again.');
    });
  }

  function loadMore() {
    if (state.loading || state.nextStore >= state.stores.length) return Promise.resolve();
    state.loading = true;
    var batch = state.stores.slice(state.nextStore, state.nextStore + STORES_PER_BATCH);
    state.nextStore += batch.length;
    var seed = Number(new Date().toISOString().slice(0, 10).replace(/-/g, '')) % 233280;

    return Promise.all(batch.map(function (s) {
      return getJSON(s.products).then(function (list) {
        // one card per product per store, keeping its first section label
        var seen = {}, items = [];
        list.forEach(function (p) {
          var key = p.url || p.name;
          if (!p.name || seen[key]) return;
          seen[key] = true; items.push(p);
        });
        return seededShuffle(items, seed + s.id.length).map(function (p) { return { p: p, s: s }; });
      }).catch(function () { return []; });
    })).then(function (lists) {
      // Interleave stores so the feed mixes dispensaries, nearest first
      var out = [], more = true;
      for (var i = 0; more; i++) {
        more = false;
        lists.forEach(function (l) { if (i < l.length) { out.push(l[i]); more = true; } });
      }
      var frag = document.createDocumentFragment();
      out.forEach(function (x) { frag.appendChild(card(x.p, x.s)); });
      var end = feed.querySelector('.card-end'); if (end) end.remove();
      feed.appendChild(frag);
      state.cards += out.length;
      if (state.nextStore >= state.stores.length) {
        feed.insertAdjacentHTML('beforeend', endCard(
          state.cards ? "That's everything near you" : 'No dispensaries found yet',
          state.cards ? 'More dispensaries are being added. Check back soon.' : 'We are adding more of New Jersey every week.'));
      }
      watchCards();
      state.loading = false;
      if (!out.length) return loadMore();   // that batch had nothing; try the next
    });
  }

  function card(p, s) {
    var n = splitName(p);
    var section = (s.sections || []).filter(function (x) { return x.title === p.category; })[0] || {};
    var accent = section.accent || ['#9be873', '#2fc0c4'];
    var d = s.display || {};
    var theme = d.theme || 'default';
    var strain = /indica|sativa|hybrid/i.test(p.strain || '') ? p.strain : '';
    var kind = /hybrid/i.test(strain) ? 'hybrid' : /indica/i.test(strain) ? 'indica' : /sativa/i.test(strain) ? 'sativa' : '';
    var maps = s.address ? 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(s.address) : null;
    var link = p.url || p.embeddedUrl || s.website;

    var el = document.createElement('article');
    el.className = 'card';
    el.setAttribute('data-theme', theme);
    el.style.setProperty('--accent', accent[0]);
    el.style.setProperty('--accent-2', accent[1] || accent[0]);
    // full URL: a relative url() inside a CSS variable resolves against the stylesheet, not the page
    if (d.background) el.style.setProperty('--pattern', 'url("' + new URL(d.background, location.href).href + '")');

    el.innerHTML =
      '<div class="card-inner">' +
        '<div class="store-row">' +
          (d.wordmark
            ? '<img class="wordmark" src="' + esc(d.wordmark) + '" alt="' + esc(s.name) + '">'
            : '<span class="store-name">' + esc(s.name) + '</span>') +
          (d.emblem ? '<img class="emblem" src="' + esc(d.emblem) + '" alt="">' : '') +
        '</div>' +
        '<div class="meta-row">' +
          (maps ? '<a class="distance" href="' + esc(maps) + '" target="_blank" rel="noopener">' : '<span class="distance">') +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>' +
            '<span>' + esc(milesLabel(s.distance)) + (s.city ? ' · ' + esc(s.city) : '') + '</span>' +
          (maps ? '</a>' : '</span>') +
          '<span class="section-tag">' + esc(singular(p.category || '')) + '</span>' +
        '</div>' +
        '<div class="photo">' +
          '<img alt="' + esc(n.title) + '" data-src="' + esc(bigImage(p.img)) + '" data-fallback="' + esc(p.img || '') + '">' +
          (strain ? '<span class="strain" data-strain="' + kind + '">' + esc(strain) + '</span>' : '') +
          (p.deal ? '<span class="deal">' + esc(p.deal) + '</span>' : '') +
        '</div>' +
        '<div class="panel">' +
          (p.brand ? '<div class="brand">' + esc(p.brand) + '</div>' : '') +
          '<h2 class="name">' + esc(n.title) + '</h2>' +
          (n.details ? '<div class="details">' + esc(n.details) + '</div>' : '') +
          '<div class="price-row">' +
            (p.price ? '<span class="price">' + esc(p.price) + '</span>' : '') +
            (p.was ? '<s class="was">' + esc(p.was) + '</s>' : '') +
            (p.thc ? '<span class="thc">' + esc(/^[a-z]/i.test(p.thc) ? p.thc : 'THC ' + p.thc) + '</span>' : '') +
          '</div>' +
          (link ? '<a class="cta" href="' + esc(link) + '" target="_blank" rel="noopener">View product at ' + esc(s.name) +
            ' <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14V3zM5 5h6v2H7v10h10v-4h2v6H5V5z"/></svg></a>' : '') +
        '</div>' +
      '</div>' +
      '';
    if (!state.hinted) {   // only the very first card gets the "Swipe up" hint
      state.hinted = true;
      el.insertAdjacentHTML('beforeend', '<div class="swipe-hint" aria-hidden="true">Swipe up</div>');
    }
    return el;
  }

  function endCard(title, sub) {
    return '<article class="card card-end"><div class="card-inner end-inner">' +
      '<h2>' + esc(title) + '</h2><p>' + esc(sub) + '</p>' +
      '<button class="btn btn-ghost" type="button" onclick="document.getElementById(\'changeLocation\').click()">Change location</button>' +
      '</div></article>';
  }

  // Load photos just before a card comes into view, and fetch more stores near the end.
  var io = null;
  function watchCards() {
    if (!('IntersectionObserver' in window)) {
      feed.querySelectorAll('img[data-src]').forEach(loadImg);
      return;
    }
    if (!io) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          var img = e.target.querySelector('img[data-src]');
          if (img) loadImg(img);
          var cards = feed.querySelectorAll('.card');
          var idx = Array.prototype.indexOf.call(cards, e.target);
          if (idx >= cards.length - LOAD_MORE_WHEN_LEFT) loadMore();
        });
      }, { root: feed, rootMargin: '150% 0px 150% 0px' });
    }
    feed.querySelectorAll('.card:not([data-watched])').forEach(function (c) {
      c.setAttribute('data-watched', '1');
      io.observe(c);
    });
  }
  function loadImg(img) {
    var src = img.getAttribute('data-src');
    img.removeAttribute('data-src');
    img.onerror = function () {
      var fb = img.getAttribute('data-fallback');
      if (fb && img.src !== fb) img.src = fb;
    };
    if (src) img.src = src;
  }

  /* ---------- wiring ---------- */
  $('useLocation').addEventListener('click', useGPS);
  $('showZip').addEventListener('click', function () { msg(''); showZip(); });
  $('zipForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var z = $('zipInput').value.trim();
    if (!/^\d{5}$/.test(z)) { msg('Enter a 5-digit ZIP code.'); return; }
    useZip(z);
  });
  $('changeLocation').addEventListener('click', function () {
    topbar.hidden = true; feed.hidden = true; gate.hidden = false;
    msg(''); $('zipForm').hidden = true;
  });
  feed.addEventListener('scroll', function () {
    var hint = feed.querySelector('.swipe-hint');
    if (hint && feed.scrollTop > 40) hint.remove();
  }, { passive: true });

  // Returning visitors who already confirmed their age go straight to the feed
  var saved = store('feed:loc');
  if (saved && store('feed:21')) start(saved); else gate.hidden = false;
})();
