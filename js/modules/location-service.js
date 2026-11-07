// ==========================================================================
// FILE: js/modules/location-service.js (JAPAR PUBLIK v5.5 - MESIN EKSTRAKTOR
//       GOOGLE MAPS, PLUS CODE, KOORDINAT GPS, & NAMA JALAN OTOMATIS VIA GAS)
// FUNGSI:
//   1. Ekstraksi Titik Lokasi, Kode Plus (Plus Code), Tautan Pendek Google Maps,
//      & Nama Jalan Pelanggan 100% Google Maps + Endpoint GAS JAPAR
//   2. Sistem Cache Berlapis di localStorage (japar_gmaps_buyer_cache_v2 & REVERSE_ADDR_CACHE_KEY)
//      dengan Kunci Grid 4 Desimal (~11m) agar Hemat Limit Kuota Harian GAS
//   3. Saat _boot: perbaruiLokasiGpsPelanggan(false) HANYA mengambil koordinat GPS
//      dan membaca cache lokal (0 tembakan jaringan pasif ke GAS)
// ==========================================================================

import { configPublicMerchant, JAPAR_GAS_MAPS_URL } from '../config/credentials.js';
import { encodeGeohash, picuGetarSentuh } from '../utils/math-engine.js';
import { JaparPageRouter } from '../core/app-shell.js';

const DEFAULT_PARE_COORD = (configPublicMerchant && configPublicMerchant.defaultCenter)
    ? { lat: Number(configPublicMerchant.defaultCenter.lat), lng: Number(configPublicMerchant.defaultCenter.lng) }
    : { lat: -7.768049, lng: 112.196514 };

export const SESSION_GPS_CACHE_KEY = 'japar_user_gps_session_v3';
export const BUYER_GMAPS_CACHE_KEY = 'japar_gmaps_buyer_cache_v2';
export const REVERSE_ADDR_CACHE_KEY = 'japar_rev_addr_cache_v1';
const BUYER_PROFILE_STORAGE_KEY = 'japar_buyer_info_v1';
const MAX_BUYER_GMAPS_CACHE_ENTRIES = 80;
const PLUS_CODE_REGEX = /\b[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,4}\b/i;

let inflightGasExtractPromises = Object.create(null);

export function isValidCoord(lat, lng) {
    const fLat = parseFloat(String(lat ?? '').replace(/,/g, '.'));
    const fLng = parseFloat(String(lng ?? '').replace(/,/g, '.'));
    return !isNaN(fLat) && !isNaN(fLng) && fLat >= -11.5 && fLat <= 6.5 && fLng >= 94.5 && fLng <= 141.5;
}

function cleanBuyerAddressText(rawText) {
    if (!rawText || typeof rawText !== 'string') return '';
    return rawText
        .replace(/^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,4}\s*,?\s*/i, '')
        .replace(/\b[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,4}\b\s*,?\s*/gi, '')
        .replace(/\+/g, ' ')
        .replace(/\s*-\s*Google\s+Maps.*$/i, '')
        .replace(/\s+/g, ' ')
        .replace(/^[,.\s·-]+|[,.\s·-]+$/g, '')
        .trim();
}

export function pangkasTeksJalanHeader(rawStreetOrAddr = '', maxLen = 28) {
    const clean = cleanBuyerAddressText(rawStreetOrAddr);
    if (!clean) return '';
    if (clean.length <= maxLen) return clean;
    const parts = clean.split(/\s*,\s*/).filter(Boolean);
    if (parts.length >= 2) {
        const candidate = `${parts[0]}, ${parts[parts.length - 1].replace(/^(?:Kabupaten|Kab\.?|Kota|Kecamatan|Kec\.?)\s+/i, '')}`;
        if (candidate.length <= maxLen) return candidate;
    }
    return clean.substring(0, maxLen - 1).trim() + '…';
}

function normalizeCacheStringKey(rawStr) {
    return String(rawStr || '').trim().replace(/\s+/g, ' ');
}

function readBuyerGmapsLocalCache(cacheKey) {
    if (!cacheKey) return null;
    try {
        const rawMap = JSON.parse(localStorage.getItem(BUYER_GMAPS_CACHE_KEY) || '{}') || {};
        const item = rawMap[cacheKey];
        if (item && isValidCoord(item.lat, item.lng)) {
            return {
                lat: Number(parseFloat(item.lat).toFixed(6)),
                lng: Number(parseFloat(item.lng).toFixed(6)),
                geohash: String(item.geohash || encodeGeohash(Number(item.lat), Number(item.lng), 6)),
                address: cleanBuyerAddressText(item.address || item.shortStreet || ''),
                shortStreet: cleanBuyerAddressText(item.shortStreet || item.address || ''),
                street: cleanBuyerAddressText(item.street || ''),
                subdistrict: cleanBuyerAddressText(item.subdistrict || ''),
                city: cleanBuyerAddressText(item.city || ''),
                fromCache: true
            };
        }
    } catch (e) {}

    // Fallback cek REVERSE_ADDR_CACHE_KEY jika kunci grid 4 desimal
    if (cacheKey.startsWith('REV_')) {
        const shortCoordKey = cacheKey.slice(4);
        try {
            const revMap = JSON.parse(localStorage.getItem(REVERSE_ADDR_CACHE_KEY) || '{}') || {};
            const revVal = revMap[cacheKey] || revMap[shortCoordKey];
            const coordParts = shortCoordKey.split('_');
            const cLat = parseFloat(coordParts[0]);
            const cLng = parseFloat(coordParts[1]);
            if (revVal && isValidCoord(cLat, cLng)) {
                if (typeof revVal === 'string') {
                    const cleaned = cleanBuyerAddressText(revVal);
                    if (cleaned) {
                        return {
                            lat: Number(cLat.toFixed(6)),
                            lng: Number(cLng.toFixed(6)),
                            geohash: encodeGeohash(cLat, cLng, 6),
                            address: cleaned,
                            shortStreet: cleaned,
                            street: '',
                            subdistrict: '',
                            city: '',
                            fromCache: true
                        };
                    }
                } else if (typeof revVal === 'object' && (revVal.address || revVal.shortStreet)) {
                    return {
                        lat: Number((revVal.lat || cLat).toFixed(6)),
                        lng: Number((revVal.lng || cLng).toFixed(6)),
                        geohash: String(revVal.geohash || encodeGeohash(cLat, cLng, 6)),
                        address: cleanBuyerAddressText(revVal.address || revVal.shortStreet || ''),
                        shortStreet: cleanBuyerAddressText(revVal.shortStreet || revVal.address || ''),
                        street: cleanBuyerAddressText(revVal.street || ''),
                        subdistrict: cleanBuyerAddressText(revVal.subdistrict || ''),
                        city: cleanBuyerAddressText(revVal.city || ''),
                        fromCache: true
                    };
                }
            }
        } catch (e2) {}
    }

    return null;
}

function writeBuyerGmapsLocalCache(primaryKey, payloadObj) {
    if (!payloadObj || !isValidCoord(payloadObj.lat, payloadObj.lng)) return;
    const lat = Number(parseFloat(payloadObj.lat).toFixed(6));
    const lng = Number(parseFloat(payloadObj.lng).toFixed(6));
    const geohash = String(payloadObj.geohash || encodeGeohash(lat, lng, 6));
    const street = cleanBuyerAddressText(payloadObj.street || '');
    const subdistrict = cleanBuyerAddressText(payloadObj.subdistrict || '');
    const city = cleanBuyerAddressText(payloadObj.city || '');
    const computedShort = [street, subdistrict, city].filter(Boolean).join(', ');
    const shortStreet = cleanBuyerAddressText(payloadObj.shortStreet || computedShort || payloadObj.address || '');
    const address = cleanBuyerAddressText(payloadObj.address || shortStreet || '');

    const revGridKey = `REV_${Number(lat).toFixed(4)}_${Number(lng).toFixed(4)}`;
    const plainGridKey = `${Number(lat).toFixed(4)}_${Number(lng).toFixed(4)}`;

    const entryToStore = {
        lat,
        lng,
        geohash,
        address,
        shortStreet: shortStreet || address,
        street,
        subdistrict,
        city,
        ts: Date.now()
    };

    try {
        const rawMap = JSON.parse(localStorage.getItem(BUYER_GMAPS_CACHE_KEY) || '{}') || {};
        const keys = Object.keys(rawMap);
        if (keys.length >= MAX_BUYER_GMAPS_CACHE_ENTRIES) {
            delete rawMap[keys[0]];
        }
        if (primaryKey) {
            rawMap[primaryKey] = entryToStore;
        }
        rawMap[revGridKey] = entryToStore;
        localStorage.setItem(BUYER_GMAPS_CACHE_KEY, JSON.stringify(rawMap));
    } catch (e) {}

    if (address || shortStreet) {
        try {
            const revMap = JSON.parse(localStorage.getItem(REVERSE_ADDR_CACHE_KEY) || '{}') || {};
            revMap[revGridKey] = address || shortStreet;
            revMap[plainGridKey] = address || shortStreet;
            localStorage.setItem(REVERSE_ADDR_CACHE_KEY, JSON.stringify(revMap));
        } catch (e2) {}
    }
}

function getCachedStreetLabelForCoord(lat, lng) {
    if (!isValidCoord(lat, lng)) return '';
    const revGridKey = `REV_${Number(lat).toFixed(4)}_${Number(lng).toFixed(4)}`;
    const cached = readBuyerGmapsLocalCache(revGridKey);
    if (cached && (cached.shortStreet || cached.address)) {
        return cached.shortStreet || cached.address;
    }
    try {
        const savedBuyer = JSON.parse(localStorage.getItem(BUYER_PROFILE_STORAGE_KEY) || '{}') || {};
        if (savedBuyer && (savedBuyer.shortStreet || savedBuyer.address)) {
            return savedBuyer.shortStreet || savedBuyer.address;
        }
    } catch (e) {}
    return '';
}

function muatGpsTersimpanSesi() {
    try {
        const raw = sessionStorage.getItem(SESSION_GPS_CACHE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (
                parsed &&
                isValidCoord(parsed.lat, parsed.lng) &&
                parsed.ts &&
                (Date.now() - Number(parsed.ts)) < 20 * 60 * 1000
            ) {
                return {
                    lat: parseFloat(parsed.lat),
                    lng: parseFloat(parsed.lng),
                    geohash: parsed.geohash || encodeGeohash(parseFloat(parsed.lat), parseFloat(parsed.lng), 6),
                    shortStreet: parsed.shortStreet || '',
                    address: parsed.address || '',
                    isDefault: Boolean(parsed.isDefault),
                    ts: Number(parsed.ts)
                };
            }
        }
    } catch (e) {}

    // Cek juga dari profil tersimpan di localStorage (`japar_buyer_info_v1`) agar tidak hilang saat buka ulang tab
    try {
        const rawProfile = localStorage.getItem(BUYER_PROFILE_STORAGE_KEY);
        if (rawProfile) {
            const prof = JSON.parse(rawProfile);
            if (prof && prof.gps && isValidCoord(prof.gps.lat, prof.gps.lng)) {
                return {
                    lat: Number(parseFloat(prof.gps.lat).toFixed(6)),
                    lng: Number(parseFloat(prof.gps.lng).toFixed(6)),
                    geohash: String(prof.gps.geohash || encodeGeohash(Number(prof.gps.lat), Number(prof.gps.lng), 6)),
                    shortStreet: String(prof.shortStreet || prof.address || ''),
                    address: String(prof.address || ''),
                    isDefault: false,
                    ts: Date.now()
                };
            }
        }
    } catch (e2) {}

    return null;
}

const initialGps = muatGpsTersimpanSesi();

window.JAPAR_USER_GPS_COORD = initialGps || {
    lat: DEFAULT_PARE_COORD.lat,
    lng: DEFAULT_PARE_COORD.lng,
    geohash: encodeGeohash(DEFAULT_PARE_COORD.lat, DEFAULT_PARE_COORD.lng, 6),
    shortStreet: '',
    address: '',
    isDefault: true,
    ts: Date.now()
};

window.JAPAR_EMBEDDED_DELIVERY_GPS = (initialGps && !initialGps.isDefault)
    ? {
        lat: initialGps.lat,
        lng: initialGps.lng,
        geohash: initialGps.geohash || encodeGeohash(initialGps.lat, initialGps.lng, 6)
    }
    : null;

export function getKoordinatPelangganAktif() {
    if (
        window.JAPAR_USER_GPS_COORD &&
        isValidCoord(window.JAPAR_USER_GPS_COORD.lat, window.JAPAR_USER_GPS_COORD.lng)
    ) {
        return {
            lat: parseFloat(window.JAPAR_USER_GPS_COORD.lat),
            lng: parseFloat(window.JAPAR_USER_GPS_COORD.lng),
            geohash: window.JAPAR_USER_GPS_COORD.geohash || encodeGeohash(parseFloat(window.JAPAR_USER_GPS_COORD.lat), parseFloat(window.JAPAR_USER_GPS_COORD.lng), 6),
            shortStreet: window.JAPAR_USER_GPS_COORD.shortStreet || '',
            address: window.JAPAR_USER_GPS_COORD.address || '',
            isDefault: Boolean(window.JAPAR_USER_GPS_COORD.isDefault)
        };
    }
    return {
        lat: DEFAULT_PARE_COORD.lat,
        lng: DEFAULT_PARE_COORD.lng,
        geohash: encodeGeohash(DEFAULT_PARE_COORD.lat, DEFAULT_PARE_COORD.lng, 6),
        shortStreet: '',
        address: '',
        isDefault: true
    };
}

function perbaruiBannerGpsWajibUI(statusGps) {
    const banner = document.getElementById('gpsPromptBanner');
    if (!banner) return;
    if (statusGps === 'ACTIVE') {
        banner.classList.add('hidden');
    } else {
        banner.classList.remove('hidden');
    }
}

export function perbaruiIndikatorGpsHeader(sedangMemuat = false, explicitStreetLabel = '') {
    const btnGps = document.getElementById('btnUpdateUserGps');
    const coord = getKoordinatPelangganAktif();

    if (btnGps) {
        if (sedangMemuat) {
            btnGps.classList.remove('is-gps-active');
            btnGps.innerHTML = `<span class="loc-pin-dot"><i class="fa-solid fa-circle-notch fa-spin"></i></span> <span id="userGpsStatusLabel" class="loc-label-text">Mencari GPS...</span>`;
        } else if (!coord.isDefault) {
            const cachedStreet = explicitStreetLabel || coord.shortStreet || coord.address || getCachedStreetLabelForCoord(coord.lat, coord.lng);
            const displayLabel = pangkasTeksJalanHeader(cachedStreet, 28) || 'Lokasi Saya Aktif';
            btnGps.classList.add('is-gps-active');
            btnGps.innerHTML = `<span class="loc-pin-dot"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg></span> <span id="userGpsStatusLabel" class="loc-label-text"></span> <svg class="loc-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
            const lblEl = btnGps.querySelector('#userGpsStatusLabel');
            if (lblEl) lblEl.textContent = displayLabel;
            perbaruiBannerGpsWajibUI('ACTIVE');
        } else {
            let savedLabel = '';
            try {
                const savedProf = JSON.parse(localStorage.getItem(BUYER_PROFILE_STORAGE_KEY) || '{}') || {};
                savedLabel = pangkasTeksJalanHeader(savedProf.shortStreet || savedProf.address || '', 28);
            } catch (e) {}
            btnGps.classList.toggle('is-gps-active', Boolean(savedLabel));
            btnGps.innerHTML = `<span class="loc-pin-dot"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg></span> <span id="userGpsStatusLabel" class="loc-label-text"></span> <svg class="loc-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
            const lblEl = btnGps.querySelector('#userGpsStatusLabel');
            if (lblEl) lblEl.textContent = savedLabel || 'Atur Lokasi Pengantaran';
            perbaruiBannerGpsWajibUI(savedLabel ? 'ACTIVE' : 'PROMPT');
        }
    }
}

export function simpanDanTerapkanGps(latRaw, lngRaw, extraMeta = null) {
    const lat = Number(parseFloat(String(latRaw).replace(/,/g, '.')).toFixed(6));
    const lng = Number(parseFloat(String(lngRaw).replace(/,/g, '.')).toFixed(6));
    if (!isValidCoord(lat, lng)) return false;

    const geohash = (extraMeta && extraMeta.geohash) ? String(extraMeta.geohash) : encodeGeohash(lat, lng, 6);
    const cachedStreet = (extraMeta && (extraMeta.shortStreet || extraMeta.address))
        ? String(extraMeta.shortStreet || extraMeta.address)
        : getCachedStreetLabelForCoord(lat, lng);

    window.JAPAR_USER_GPS_COORD = {
        lat,
        lng,
        geohash,
        shortStreet: cleanBuyerAddressText(extraMeta?.shortStreet || cachedStreet || ''),
        address: cleanBuyerAddressText(extraMeta?.address || cachedStreet || ''),
        isDefault: false,
        ts: Date.now()
    };
    window.JAPAR_EMBEDDED_DELIVERY_GPS = { lat, lng, geohash };
    try {
        sessionStorage.setItem(SESSION_GPS_CACHE_KEY, JSON.stringify(window.JAPAR_USER_GPS_COORD));
    } catch (e) {}

    perbaruiIndikatorGpsHeader(false, window.JAPAR_USER_GPS_COORD.shortStreet || window.JAPAR_USER_GPS_COORD.address);

    if (window.CatalogOrderEngine && typeof window.CatalogOrderEngine.recalculateDistancesAndRender === 'function') {
        window.CatalogOrderEngine.recalculateDistancesAndRender();
    }
    return true;
}

function tryExtractBuyerCoordLocally(rawStr) {
    const text = String(rawStr || '').trim();
    if (!text) return null;

    let placeName = '';
    let address = '';
    try {
        const decoded = decodeURIComponent(text.replace(/\+/g, ' '));
        const placeMatch = decoded.match(/\/maps\/(?:place|search)\/([^\/@?]+)/i);
        if (placeMatch && placeMatch[1]) {
            const cand = placeMatch[1].trim();
            if (!/^-?\d{1,2}\.\d+\s*,\s*\d{2,3}\.\d+$/.test(cand)) {
                const parts = cand.split(/\s*,\s*/);
                placeName = cleanBuyerAddressText(parts[0]);
                address = parts.length >= 2 ? cleanBuyerAddressText(cand) : placeName;
            }
        }
    } catch (e) {}

    // 1. !3d<lat>!4d<lng>
    const pin3d4d = text.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (pin3d4d) {
        const lat = parseFloat(pin3d4d[1]);
        const lng = parseFloat(pin3d4d[2]);
        if (isValidCoord(lat, lng)) {
            return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), address, placeName };
        }
    }

    // 2. !2d<lng>!3d<lat>
    const pin2d3d = text.match(/!2d(-?\d+\.\d+)!3d(-?\d+\.\d+)/);
    if (pin2d3d) {
        const lng = parseFloat(pin2d3d[1]);
        const lat = parseFloat(pin2d3d[2]);
        if (isValidCoord(lat, lng)) {
            return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), address, placeName };
        }
    }

    // 3. Query param (?q=lat,lng / ?ll= / ?destination=)
    const qMatch = text.match(/[?&](?:q|ll|query|destination|daddr|saddr)=(-?\d{1,2}\.\d+)(?:,|%2C|\s+)(-?\d{2,3}\.\d+)/i);
    if (qMatch) {
        const lat = parseFloat(qMatch[1]);
        const lng = parseFloat(qMatch[2]);
        if (isValidCoord(lat, lng)) {
            return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), address, placeName };
        }
    }

    // 4. @<lat>,<lng>
    const atMatch = text.match(/@(-?\d{1,2}\.\d+),(-?\d{2,3}\.\d+)/);
    if (atMatch) {
        const lat = parseFloat(atMatch[1]);
        const lng = parseFloat(atMatch[2]);
        if (isValidCoord(lat, lng)) {
            return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), address, placeName };
        }
    }

    // 5. Angka koordinat langsung (-7.768049, 112.196514)
    const directMatch = text.match(/^(-?\d{1,2}[.,]\d{3,15})\s*[,\s;]+\s*(\d{2,3}[.,]\d{3,15})$/);
    if (directMatch) {
        const lat = parseFloat(directMatch[1].replace(',', '.'));
        const lng = parseFloat(directMatch[2].replace(',', '.'));
        if (isValidCoord(lat, lng)) {
            return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), address: '', placeName: '' };
        }
    }

    return null;
}

function isStreetComplete(addr = '', place = '') {
    const clean = cleanBuyerAddressText(addr);
    if (!clean || clean.length < 10) return false;
    if (PLUS_CODE_REGEX.test(addr)) return false;
    if (place && clean.toLowerCase() === cleanBuyerAddressText(place).toLowerCase() && !clean.includes(',')) {
        return false;
    }
    return /\b(jl\.?|jalan|gg\.?|gang|dsn\.?|dusun|ds\.?|desa|kel\.?|kec\.?|rt\.?|rw\.?|pare|kediri)\b/i.test(clean) || clean.includes(',');
}

/**
 * Mesin Ekstraktor Google Maps, Plus Code, & Nama Jalan Otomatis via GAS (`JAPAR_GAS_MAPS_URL`)
 * - Lapis 1: Cek Cache Lokal di `localStorage` (`japar_gmaps_buyer_cache_v2` & `REVERSE_ADDR_CACHE_KEY`)
 * - Lapis 2: Ekstraksi Lokal Cepat + Resolusi Jalan via `JAPAR_GAS_MAPS_URL`
 * - Lapis 3: Penyimpanan ke `localStorage`, panggil `simpanDanTerapkanGps(lat, lng)` & update `#userGpsStatusLabel`
 */
export async function ekstrakLokasiDanJalanPelangganViaGas(rawInputOrCoords) {
    if (!rawInputOrCoords) return null;

    const isCoordObject =
        typeof rawInputOrCoords === 'object' &&
        rawInputOrCoords !== null &&
        rawInputOrCoords.lat !== undefined &&
        rawInputOrCoords.lng !== undefined;

    // =========================================================================
    // LAPIS 1: CEK CACHE LOKAL DI `localStorage` (0 PEMAKAIAN KUOTA GAS!)
    // =========================================================================
    if (isCoordObject) {
        const cLat = parseFloat(String(rawInputOrCoords.lat).replace(/,/g, '.'));
        const cLng = parseFloat(String(rawInputOrCoords.lng).replace(/,/g, '.'));
        if (!isValidCoord(cLat, cLng)) return null;

        const revGridKey = `REV_${Number(cLat).toFixed(4)}_${Number(cLng).toFixed(4)}`;
        const cachedByGrid = readBuyerGmapsLocalCache(revGridKey);
        if (cachedByGrid && (cachedByGrid.address || cachedByGrid.shortStreet)) {
            const finalCoordObj = {
                ...cachedByGrid,
                lat: Number(cLat.toFixed(6)),
                lng: Number(cLng.toFixed(6)),
                geohash: encodeGeohash(cLat, cLng, 6),
                fromCache: true
            };
            simpanDanTerapkanGps(finalCoordObj.lat, finalCoordObj.lng, finalCoordObj);
            return finalCoordObj;
        }
    } else {
        const normStr = normalizeCacheStringKey(rawInputOrCoords);
        if (!normStr) return null;

        const cachedByStr = readBuyerGmapsLocalCache(normStr);
        if (cachedByStr && (cachedByStr.address || cachedByStr.shortStreet)) {
            simpanDanTerapkanGps(cachedByStr.lat, cachedByStr.lng, cachedByStr);
            return cachedByStr;
        }
    }

    // Deduplikasi in-flight request
    const inflightKey = isCoordObject
        ? `REV_${Number(rawInputOrCoords.lat).toFixed(4)}_${Number(rawInputOrCoords.lng).toFixed(4)}`
        : normalizeCacheStringKey(rawInputOrCoords);

    if (inflightGasExtractPromises[inflightKey]) {
        return inflightGasExtractPromises[inflightKey];
    }

    // =========================================================================
    // LAPIS 2: EKSTRAKSI LOKAL CEPAT + RESOLUSI JALAN VIA `JAPAR_GAS_MAPS_URL`
    // =========================================================================
    const promise = (async () => {
        try {
            let resolvedLat = null;
            let resolvedLng = null;
            let resolvedAddress = '';
            let resolvedShortStreet = '';
            let resolvedStreet = '';
            let resolvedSubdistrict = '';
            let resolvedCity = '';
            let resolvedPlaceName = '';
            let primaryCacheKey = inflightKey;

            if (isCoordObject) {
                // Skenario B (Objek { lat, lng } dari GPS HP)
                resolvedLat = Number(parseFloat(String(rawInputOrCoords.lat).replace(/,/g, '.')).toFixed(6));
                resolvedLng = Number(parseFloat(String(rawInputOrCoords.lng).replace(/,/g, '.')).toFixed(6));
            } else {
                const rawStr = normalizeCacheStringKey(rawInputOrCoords);
                const isShortlink = /(?:maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(rawStr);
                const isPlusCode = PLUS_CODE_REGEX.test(rawStr) && !/^https?:\/\//i.test(rawStr);
                const localCoord = !isShortlink ? tryExtractBuyerCoordLocally(rawStr) : null;

                if (localCoord && isValidCoord(localCoord.lat, localCoord.lng)) {
                    // Skenario B (Input Tautan Panjang Google Maps atau Angka Koordinat `-7.768049, 112.196514`)
                    resolvedLat = localCoord.lat;
                    resolvedLng = localCoord.lng;
                    resolvedAddress = localCoord.address || '';
                    resolvedPlaceName = localCoord.placeName || '';

                    // Cek apakah koordinat ini sudah punya jalan di cache grid 4 desimal
                    const revGridKey = `REV_${Number(resolvedLat).toFixed(4)}_${Number(resolvedLng).toFixed(4)}`;
                    const cachedGrid = readBuyerGmapsLocalCache(revGridKey);
                    if (cachedGrid && (cachedGrid.address || cachedGrid.shortStreet)) {
                        resolvedAddress = cachedGrid.address || resolvedAddress;
                        resolvedShortStreet = cachedGrid.shortStreet || resolvedAddress;
                        resolvedStreet = cachedGrid.street || '';
                        resolvedSubdistrict = cachedGrid.subdistrict || '';
                        resolvedCity = cachedGrid.city || '';
                    }
                } else {
                    // Skenario A (Input Tautan Pendek `maps.app.goo.gl/...` / `goo.gl/maps/...` atau Kode Plus / Plus Code)
                    const urlInTextMatch = rawStr.match(/https?:\/\/[^\s"'<>]+/i);
                    const targetForUnfurl = urlInTextMatch ? urlInTextMatch[0] : rawStr;
                    const unfurlUrl = `${JAPAR_GAS_MAPS_URL}?action=unfurl&url=${encodeURIComponent(targetForUnfurl)}`;
                    const resp = await fetch(unfurlUrl, {
                        method: 'GET',
                        redirect: 'follow'
                    });
                    if (resp.ok) {
                        const data = await resp.json().catch(() => null);
                        if (data && isValidCoord(data.lat, data.lng)) {
                            resolvedLat = Number(parseFloat(data.lat).toFixed(6));
                            resolvedLng = Number(parseFloat(data.lng).toFixed(6));
                            resolvedStreet = cleanBuyerAddressText(data.street || '');
                            resolvedSubdistrict = cleanBuyerAddressText(data.subdistrict || '');
                            resolvedCity = cleanBuyerAddressText(data.city || '');
                            const computedShort = [resolvedStreet, resolvedSubdistrict, resolvedCity].filter(Boolean).join(', ');
                            resolvedShortStreet = cleanBuyerAddressText(data.shortStreet || computedShort || '');
                            resolvedAddress = cleanBuyerAddressText(data.address || data.formattedAddress || resolvedShortStreet || data.placeName || '');
                            resolvedPlaceName = cleanBuyerAddressText(data.placeName || '');
                        }
                    }
                }
            }

            if (!isValidCoord(resolvedLat, resolvedLng)) {
                return null;
            }

            // Jika nama jalan belum lengkap, panggil `?action=reverse&lat=...&lng=...`
            if (!isStreetComplete(resolvedAddress || resolvedShortStreet, resolvedPlaceName)) {
                const revGridKey = `REV_${Number(resolvedLat).toFixed(4)}_${Number(resolvedLng).toFixed(4)}`;
                const cachedRev = readBuyerGmapsLocalCache(revGridKey);
                if (cachedRev && (cachedRev.address || cachedRev.shortStreet)) {
                    resolvedAddress = cachedRev.address || cachedRev.shortStreet;
                    resolvedShortStreet = cachedRev.shortStreet || resolvedAddress;
                    resolvedStreet = cachedRev.street || resolvedStreet;
                    resolvedSubdistrict = cachedRev.subdistrict || resolvedSubdistrict;
                    resolvedCity = cachedRev.city || resolvedCity;
                } else {
                    const revUrl = `${JAPAR_GAS_MAPS_URL}?action=reverse&lat=${encodeURIComponent(resolvedLat)}&lng=${encodeURIComponent(resolvedLng)}`;
                    const revResp = await fetch(revUrl, {
                        method: 'GET',
                        redirect: 'follow'
                    });
                    if (revResp.ok) {
                        const revData = await revResp.json().catch(() => null);
                        if (revData) {
                            resolvedStreet = cleanBuyerAddressText(revData.street || resolvedStreet || '');
                            resolvedSubdistrict = cleanBuyerAddressText(revData.subdistrict || resolvedSubdistrict || '');
                            resolvedCity = cleanBuyerAddressText(revData.city || resolvedCity || '');
                            const compShort = [resolvedStreet, resolvedSubdistrict, resolvedCity].filter(Boolean).join(', ');
                            resolvedShortStreet = cleanBuyerAddressText(revData.shortStreet || compShort || revData.address || resolvedShortStreet || '');
                            resolvedAddress = cleanBuyerAddressText(revData.address || revData.formattedAddress || resolvedShortStreet || resolvedAddress || '');
                        }
                    }
                }
            }

            if (!resolvedShortStreet) {
                resolvedShortStreet = [resolvedStreet, resolvedSubdistrict, resolvedCity].filter(Boolean).join(', ') || resolvedAddress || resolvedPlaceName;
            }
            if (!resolvedAddress) {
                resolvedAddress = resolvedShortStreet || resolvedPlaceName;
            }

            // =========================================================================
            // LAPIS 3: PENYIMPANAN KE `localStorage` & PENERAPAN OTOMATIS KE UI
            // =========================================================================
            const finalResult = {
                ok: true,
                lat: Number(resolvedLat.toFixed(6)),
                lng: Number(resolvedLng.toFixed(6)),
                geohash: encodeGeohash(resolvedLat, resolvedLng, 6),
                address: resolvedAddress,
                shortStreet: resolvedShortStreet || resolvedAddress,
                street: resolvedStreet,
                subdistrict: resolvedSubdistrict,
                city: resolvedCity,
                placeName: resolvedPlaceName
            };

            writeBuyerGmapsLocalCache(primaryCacheKey, finalResult);
            simpanDanTerapkanGps(finalResult.lat, finalResult.lng, finalResult);

            return finalResult;
        } catch (err) {
            return null;
        } finally {
            delete inflightGasExtractPromises[inflightKey];
        }
    })();

    inflightGasExtractPromises[inflightKey] = promise;
    return promise;
}
window.ekstrakLokasiDanJalanPelangganViaGas = ekstrakLokasiDanJalanPelangganViaGas;

/**
 * Saat `_boot` (`interaktif === false`):
 * HANYA mengambil koordinat GPS perangkat untuk menghitung jarak Haversine warung
 * dan mengecek apakah koordinat tersebut sudah ada di cache lokal `localStorage`
 * TANPA menembak jaringan ke GAS secara pasif.
 */
export function perbaruiLokasiGpsPelanggan(interaktif = false, onSelesai = null) {
    if (!interaktif) {
        const cachedSess = muatGpsTersimpanSesi();
        if (cachedSess && !cachedSess.isDefault) {
            const cachedStreet = cachedSess.shortStreet || cachedSess.address || getCachedStreetLabelForCoord(cachedSess.lat, cachedSess.lng);
            cachedSess.shortStreet = cachedStreet;
            window.JAPAR_USER_GPS_COORD = cachedSess;
            window.JAPAR_EMBEDDED_DELIVERY_GPS = {
                lat: cachedSess.lat,
                lng: cachedSess.lng,
                geohash: cachedSess.geohash || encodeGeohash(cachedSess.lat, cachedSess.lng, 6)
            };
            perbaruiIndikatorGpsHeader(false, cachedStreet);
            if (typeof onSelesai === 'function') onSelesai(cachedSess);
            return;
        }
    }

    if (!navigator.geolocation) {
        perbaruiIndikatorGpsHeader(false);
        if (interaktif && window.CatalogOrderEngine && typeof window.CatalogOrderEngine.showNotice === 'function') {
            window.CatalogOrderEngine.showNotice('Perangkat Anda belum mendukung sensor lokasi. Silakan tempel Link Google Maps atau Kode Plus pada bagian Alamat Saya.');
        }
        if (typeof onSelesai === 'function') onSelesai(getKoordinatPelangganAktif());
        return;
    }

    perbaruiIndikatorGpsHeader(true);

    navigator.geolocation.getCurrentPosition(
        async (pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            // Cek cache lokal terlebih dahulu (0 kuota GAS saat _boot)
            const localStreet = getCachedStreetLabelForCoord(lat, lng);
            simpanDanTerapkanGps(lat, lng, { shortStreet: localStreet, address: localStreet });

            if (interaktif && !localStreet) {
                await ekstrakLokasiDanJalanPelangganViaGas({ lat, lng });
            }
            if (typeof onSelesai === 'function') {
                onSelesai(window.JAPAR_USER_GPS_COORD);
            }
            if ((pos.coords.accuracy || 100) > 40) {
                navigator.geolocation.getCurrentPosition(
                    (hiPos) => {
                        const hiStreet = getCachedStreetLabelForCoord(hiPos.coords.latitude, hiPos.coords.longitude) || window.JAPAR_USER_GPS_COORD?.shortStreet || '';
                        simpanDanTerapkanGps(hiPos.coords.latitude, hiPos.coords.longitude, { shortStreet: hiStreet, address: hiStreet });
                    },
                    () => {},
                    { enableHighAccuracy: true, timeout: 7000, maximumAge: 15000 }
                );
            }
        },
        () => {
            navigator.geolocation.getCurrentPosition(
                async (pos2) => {
                    const lat2 = pos2.coords.latitude;
                    const lng2 = pos2.coords.longitude;
                    const localStreet2 = getCachedStreetLabelForCoord(lat2, lng2);
                    simpanDanTerapkanGps(lat2, lng2, { shortStreet: localStreet2, address: localStreet2 });
                    if (interaktif && !localStreet2) {
                        await ekstrakLokasiDanJalanPelangganViaGas({ lat: lat2, lng: lng2 });
                    }
                    if (typeof onSelesai === 'function') {
                        onSelesai(window.JAPAR_USER_GPS_COORD);
                    }
                },
                () => {
                    perbaruiIndikatorGpsHeader(false);
                    if (interaktif && window.CatalogOrderEngine && typeof window.CatalogOrderEngine.showNotice === 'function') {
                        window.CatalogOrderEngine.showNotice('Pastikan GPS HP Anda sudah dinyalakan atau tempel Link Google Maps / Kode Plus pada halaman Alamat Saya.');
                    }
                    if (typeof onSelesai === 'function') {
                        onSelesai(getKoordinatPelangganAktif());
                    }
                },
                { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
            );
        },
        {
            enableHighAccuracy: false,
            timeout: 3500,
            maximumAge: interaktif ? 10000 : 180000
        }
    );
}

export function sematkanKoordinatGpsPengantaran(onSelesai = null) {
    picuGetarSentuh(15);
    const btnEmbed = document.getElementById('btnEmbedBuyerGps');
    const infoEmbed = document.getElementById('japarEmbeddedGpsInfo');

    if (!navigator.geolocation) {
        const fallback = getKoordinatPelangganAktif();
        window.JAPAR_EMBEDDED_DELIVERY_GPS = {
            lat: fallback.lat,
            lng: fallback.lng,
            geohash: fallback.geohash || encodeGeohash(fallback.lat, fallback.lng, 6)
        };
        if (infoEmbed) {
            infoEmbed.classList.remove('hidden');
            infoEmbed.innerHTML = `<i class="fa-solid fa-circle-check text-emerald"></i> Titik lokasi pengantaran telah disematkan.`;
        }
        if (typeof onSelesai === 'function') onSelesai(window.JAPAR_EMBEDDED_DELIVERY_GPS);
        return;
    }

    if (btnEmbed) {
        btnEmbed.disabled = true;
        btnEmbed.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Mengambil GPS &amp; Nama Jalan...`;
    }

    navigator.geolocation.getCurrentPosition(
        async (pos) => {
            try {
                const lat = pos.coords.latitude;
                const lng = pos.coords.longitude;
                const extracted = await ekstrakLokasiDanJalanPelangganViaGas({ lat, lng });
                const streetText = extracted ? (extracted.address || extracted.shortStreet || '') : '';

                const inpAddr = document.getElementById('japarBuyerAddress');
                if (inpAddr && streetText) {
                    const curVal = inpAddr.value.trim();
                    if (!curVal || curVal.length < 8) {
                        inpAddr.value = streetText;
                        inpAddr.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }

                if (infoEmbed) {
                    infoEmbed.classList.remove('hidden');
                    infoEmbed.innerHTML = streetText
                        ? `<i class="fa-solid fa-circle-check text-emerald"></i> <b>GPS &amp; Jalan Terdeteksi:</b> ${streetText} <span class="text-muted">(${lat.toFixed(5)}, ${lng.toFixed(5)})</span>`
                        : `<i class="fa-solid fa-circle-check text-emerald"></i> Titik GPS pengantaran berhasil disematkan (${lat.toFixed(5)}, ${lng.toFixed(5)}).`;
                }
                if (typeof onSelesai === 'function') {
                    onSelesai(extracted || window.JAPAR_EMBEDDED_DELIVERY_GPS);
                }
            } finally {
                if (btnEmbed) {
                    btnEmbed.disabled = false;
                    btnEmbed.innerHTML = `<i class="fa-solid fa-location-crosshairs"></i> Ambil Titik GPS &amp; Nama Jalan Otomatis`;
                }
            }
        },
        () => {
            if (btnEmbed) {
                btnEmbed.disabled = false;
                btnEmbed.innerHTML = `<i class="fa-solid fa-location-crosshairs"></i> Ambil Titik GPS &amp; Nama Jalan Otomatis`;
            }
            const current = getKoordinatPelangganAktif();
            window.JAPAR_EMBEDDED_DELIVERY_GPS = {
                lat: current.lat,
                lng: current.lng,
                geohash: current.geohash || encodeGeohash(current.lat, current.lng, 6)
            };
            if (infoEmbed) {
                infoEmbed.classList.remove('hidden');
                infoEmbed.innerHTML = `<i class="fa-solid fa-circle-info text-amber"></i> Sensor GPS belum merespons. Silakan gunakan tombol <b>1. Buka Google Maps</b> &rarr; <b>2. Tempel &amp; Ekstrak Jalan Otomatis</b> di atas.`;
            }
            if (typeof onSelesai === 'function') onSelesai(window.JAPAR_EMBEDDED_DELIVERY_GPS);
        },
        { enableHighAccuracy: true, timeout: 8500, maximumAge: 30000 }
    );
}

window.getKoordinatPelangganAktif = getKoordinatPelangganAktif;
window.perbaruiLokasiGpsPelanggan = perbaruiLokasiGpsPelanggan;
window.sematkanKoordinatGpsPengantaran = sematkanKoordinatGpsPengantaran;
window.perbaruiIndikatorGpsHeader = perbaruiIndikatorGpsHeader;

(() => {
    const _boot = () => {
        perbaruiIndikatorGpsHeader(false);
        perbaruiLokasiGpsPelanggan(false);

        const btnUpdateGps = document.getElementById('btnUpdateUserGps');
        if (btnUpdateGps) {
            btnUpdateGps.addEventListener('click', () => {
                picuGetarSentuh(15);
                if (
                    window.CatalogOrderEngine &&
                    typeof window.CatalogOrderEngine.isBuyerProfileComplete === 'function' &&
                    !window.CatalogOrderEngine.isBuyerProfileComplete() &&
                    typeof window.CatalogOrderEngine.openBuyerOnboardingModal === 'function'
                ) {
                    window.CatalogOrderEngine.openBuyerOnboardingModal(() => {
                        perbaruiIndikatorGpsHeader(false);
                    });
                    return;
                }
                if (JaparPageRouter && typeof JaparPageRouter.navigateTo === 'function') {
                    JaparPageRouter.navigateTo('profile');
                }
            });
        }

        const btnBannerGps = document.getElementById('btnBannerActivateGps');
        if (btnBannerGps) {
            btnBannerGps.addEventListener('click', () => {
                picuGetarSentuh(15);
                perbaruiLokasiGpsPelanggan(true);
            });
        }
    };
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _boot, { once: true });
    } else {
        _boot();
    }
})();
