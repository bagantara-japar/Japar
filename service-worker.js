// ==========================================================================
// FILE: service-worker.js (JAPAR PUBLIK v4.8 - JARINGAN KULINER PARE PWA CACHE)
// FUNGSI:
//   1. Strategi Network-First dengan fallback Cache untuk index.html, CSS, dan JS
//   2. Strategi Cache-First khusus untuk aset gambar/ikon statis
// ==========================================================================

const firebaseConfig = {
  apiKey: "AIzaSyBOCoI-PzDg89AZmAWjryioJj1hIBPuLso",
  authDomain: "japar-b1c5d.firebaseapp.com",
  databaseURL: "https://japar-b1c5d-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "japar-b1c5d",
  storageBucket: "japar-b1c5d.firebasestorage.app",
  messagingSenderId: "332026051029",
  appId: "1:332026051029:web:281bc141eb6ff58f9f255c"
};

const cloudinaryConfig = {
  cloudName: "odo6kdaz",
  uploadPreset: "my-archivestory",
  uploadEndpoint: "https://api.cloudinary.com/v1_1/odo6kdaz/image/upload",
  deliveryBaseUrl: "https://res.cloudinary.com/odo6kdaz/image/upload/f_auto,q_auto,w_400/"
};

const CACHE_NAME = 'japar-publik-v4.8.0';
const STATIC_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './css/theme.css',
    './assets/logo.png',
    './assets/icon-192.png',
    './assets/icon-512.png'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS).catch(() => {});
        })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve()))
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = req_event_extract(event);
    if (!req || req.method !== 'GET') return;
    const url = new URL(req.url);

    if (url.origin === self.location.origin) {
        const isStaticImageOrFont = /\.(png|jpg|jpeg|webp|svg|ico|woff2?)$/i.test(url.pathname);
        if (isStaticImageOrFont) {
            event.respondWith(
                caches.match(req).then((cached) => {
                    if (cached) return cached;
                    return fetch(req).then((netRes) => {
                        if (netRes && netRes.status === 200) {
                            const clone = netRes.clone();
                            caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => {});
                        }
                        return netRes;
                    });
                })
            );
            return;
        }

        // Network-First dengan fallback Cache untuk HTML, CSS, JS, dan manifest
        event.respondWith(
            fetch(req)
                .then((netRes) => {
                    if (netRes && netRes.status === 200) {
                        const clone = netRes.clone();
                        caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => {});
                    }
                    return netRes;
                })
                .catch(() => {
                    return caches.match(req).then((cachedRes) => {
                        if (cachedRes) return cachedRes;
                        if (req.mode === 'navigate') {
                            return caches.match('./index.html');
                        }
                        return cachedRes;
                    });
                })
        );
    }
});

function req_event_extract(event) {
    return event && event.request ? event.request : null;
}
