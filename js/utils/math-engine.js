// ==========================================================================
// FILE: js/utils/math-engine.js (JAPAR PUBLIK - JARINGAN KULINER PARE)
// ==========================================================================

import { cloudinaryConfig } from '../config/credentials.js';

export function hitungJarakHaversineKm(lat1, lon1, lat2, lon2) {
    const nLat1 = parseFloat(String(lat1).replace(/,/g, '.'));
    const nLon1 = parseFloat(String(lon1).replace(/,/g, '.'));
    const nLat2 = parseFloat(String(lat2).replace(/,/g, '.'));
    const nLon2 = parseFloat(String(lon2).replace(/,/g, '.'));
    if (isNaN(nLat1) || isNaN(nLon1) || isNaN(nLat2) || isNaN(nLon2)) return 999999;

    const R = 6371;
    const dLat = (nLat2 - nLat1) * Math.PI / 180;
    const dLon = (nLon2 - nLon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(nLat1 * Math.PI / 180) * Math.cos(nLat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export function encodeGeohash(lat, lon, precision = 6) {
    const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
    let idx = 0, bit = 0, evenBit = true, hash = "";
    let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;

    while (hash.length < precision) {
        if (evenBit) {
            const lonMid = (lonMin + lonMax) / 2;
            if (lon >= lonMid) { idx = idx * 2 + 1; lonMin = lonMid; }
            else { idx = idx * 2; lonMax = lonMid; }
        } else {
            const latMid = (latMin + latMax) / 2;
            if (lat >= latMid) { idx = idx * 2 + 1; latMin = latMid; }
            else { idx = idx * 2; latMax = latMid; }
        }
        evenBit = !evenBit;
        if (++bit === 5) { hash += BASE32[idx]; bit = 0; idx = 0; }
    }
    return hash;
}

export function bersihkanPublicIdCloudinary(rawInput) {
    if (!rawInput) return '';
    let str = String(rawInput).trim();
    if (!str) return '';
    if (/^https?:\/\/res\.cloudinary\.com\//i.test(str)) {
        const match = str.match(/\/image\/upload\/(?:f_auto,q_auto,w_\d+\/)?(?:v\d+\/)?(.+)$/i);
        if (match && match[1]) {
            str = match[1];
        }
    }
    if (/^https?:\/\//i.test(str)) return '';
    return str.replace(/^\/+/, '');
}

export function bangunUrlGambarCloudinary(publicId, width = 400, fallbackTitle = 'JAPAR') {
    const cleanId = bersihkanPublicIdCloudinary(publicId);
    if (cleanId) {
        if (cloudinaryConfig && cloudinaryConfig.deliveryBaseUrl) {
            return cloudinaryConfig.deliveryBaseUrl + cleanId;
        }
        const cloudName = (cloudinaryConfig && cloudinaryConfig.cloudName) ? cloudinaryConfig.cloudName : 'odo6kdaz';
        return `https://res.cloudinary.com/${cloudName}/image/upload/f_auto,q_auto,w_400/${cleanId}`;
    }
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(fallbackTitle || 'JAPAR')}&background=191E26&color=F59E0B&bold=true`;
}

export function getWaktuWibPresisiPublik(nowDate = new Date()) {
    try {
        const d = (nowDate instanceof Date && !isNaN(nowDate.getTime())) ? nowDate : new Date();
        const utcMs = d.getTime() + (d.getTimezoneOffset() * 60000);
        const wibDate = new Date(utcMs + (7 * 3600000));
        return {
            hours: wibDate.getHours(),
            minutes: wibDate.getMinutes(),
            day: wibDate.getDay()
        };
    } catch (e) {
        return {
            hours: nowDate.getHours(),
            minutes: nowDate.getMinutes(),
            day: nowDate.getDay()
        };
    }
}

export function uraiJamDanHariDariFieldH(rawH = '08:00-21:00', explicitHd = '') {
    const str = String(rawH || '08:00-21:00').trim();
    const parts = str.split('|');
    const jamClean = (parts[0] || '08:00-21:00').trim();
    const hdRaw = explicitHd || parts[1] || '';
    const allDays = [1, 2, 3, 4, 5, 6, 0];
    if (!hdRaw) {
        return { jamClean, activeDays: allDays };
    }
    const chars = String(hdRaw).includes(',') ? String(hdRaw).split(',') : String(hdRaw).split('');
    const set = new Set();
    chars.forEach(c => {
        const n = parseInt(String(c).trim(), 10);
        if (!isNaN(n) && n >= 0 && n <= 6) set.add(n);
    });
    return {
        jamClean,
        activeDays: set.size > 0 ? Array.from(set) : allDays
    };
}

export function cekDalamJamOperasionalPublik(jamBukaTutupStr, nowDate = new Date(), explicitHd = '') {
    const wib = getWaktuWibPresisiPublik(nowDate);
    const { jamClean, activeDays } = uraiJamDanHariDariFieldH(jamBukaTutupStr, explicitHd);

    if (!jamClean) return activeDays.includes(wib.day);
    if (/24\s*jam/i.test(jamClean) || jamClean === '00:00-24:00' || jamClean === '00:00-23:59') {
        return activeDays.includes(wib.day);
    }

    const match = jamClean.match(/(\d{1,2})[:.](\d{2})\s*[-–—s/d]+\s*(\d{1,2})[:.](\d{2})/i);
    if (!match) return activeDays.includes(wib.day);

    const startH = Math.min(23, Math.max(0, parseInt(match[1], 10) || 0));
    const startM = Math.min(59, Math.max(0, parseInt(match[2], 10) || 0));
    const endH = Math.min(23, Math.max(0, parseInt(match[3], 10) || 0));
    const endM = Math.min(59, Math.max(0, parseInt(match[4], 10) || 0));

    const currentMinutes = wib.hours * 60 + wib.minutes;
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes === endMinutes) return activeDays.includes(wib.day);
    if (startMinutes < endMinutes) {
        if (!activeDays.includes(wib.day)) return false;
        return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    }
    if (currentMinutes >= startMinutes) {
        return activeDays.includes(wib.day);
    }
    if (currentMinutes <= endMinutes) {
        const yesterday = (wib.day + 6) % 7;
        return activeDays.includes(yesterday);
    }
    return false;
}

export function hitungHargaFinalMenuPublik(normalPrice, itemDiscPct = 0, storeDiscPct = 0, skemaDiskon = 'MAX_BEST') {
    const base = Math.max(0, Math.round(Number(normalPrice) || 0));
    const dItem = Math.min(99, Math.max(0, parseInt(itemDiscPct, 10) || 0));
    const dStore = Math.min(99, Math.max(0, parseInt(storeDiscPct, 10) || 0));
    const mode = ['MAX_BEST', 'ITEM_OVERRIDE', 'STACK_ADD'].includes(skemaDiskon) ? skemaDiskon : 'MAX_BEST';

    let pct = 0;
    let sourceLabel = '';

    if (mode === 'STACK_ADD') {
        pct = Math.min(90, dItem + dStore);
        if (dItem > 0 && dStore > 0) sourceLabel = 'Promo Gabungan';
        else if (dItem > 0) sourceLabel = 'Promo Menu';
        else if (dStore > 0) sourceLabel = 'Diskon Resto';
    } else if (mode === 'ITEM_OVERRIDE') {
        if (dItem > 0) {
            pct = dItem;
            sourceLabel = 'Promo Menu';
        } else if (dStore > 0) {
            pct = dStore;
            sourceLabel = 'Diskon Resto';
        }
    } else {
        if (dItem >= dStore && dItem > 0) {
            pct = dItem;
            sourceLabel = 'Promo Menu';
        } else if (dStore > dItem && dStore > 0) {
            pct = dStore;
            sourceLabel = 'Diskon Resto';
        }
    }

    if (pct <= 0) {
        return {
            originalPrice: base,
            finalPrice: base,
            discountPct: 0,
            savedAmount: 0,
            sourceLabel: ''
        };
    }

    const cut = Math.round((base * pct) / 100);
    return {
        originalPrice: base,
        finalPrice: Math.max(0, base - cut),
        discountPct: pct,
        savedAmount: cut,
        sourceLabel
    };
}

export function picuGetarSentuh(ms = 14) {
    try {
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
            navigator.vibrate(ms);
        }
    } catch (e) {}
}

window.hitungJarakHaversineKm = hitungJarakHaversineKm;
window.encodeGeohash = encodeGeohash;
window.bersihkanPublicIdCloudinary = bersihkanPublicIdCloudinary;
window.bangunUrlGambarCloudinary = bangunUrlGambarCloudinary;
window.uraiJamDanHariDariFieldH = uraiJamDanHariDariFieldH;
window.cekDalamJamOperasionalPublik = cekDalamJamOperasionalPublik;
window.hitungHargaFinalMenuPublik = hitungHargaFinalMenuPublik;
window.picuGetarSentuh = picuGetarSentuh;
