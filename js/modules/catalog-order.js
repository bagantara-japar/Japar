// ==========================================================================
// FILE: js/modules/catalog-order.js (JAPAR PUBLIK v5.1 - MESIN KATALOG REALTIME,
//       PILAR PAKET HEMAT, PEMILIH MINUMAN PAKET (+HARGA) & VARIAN ALA GOFOOD,
//       CATATAN RINCI PER-PORSI, & STRUK WHATSAPP SUPER RINCI)
// ==========================================================================

import { firebaseConfig, configPublicMerchant, JAPAR_PUBLIC_NODES } from '../config/credentials.js';
import {
    hitungJarakHaversineKm,
    encodeGeohash,
    bersihkanPublicIdCloudinary,
    bangunUrlGambarCloudinary,
    uraiJamDanHariDariFieldH,
    cekDalamJamOperasionalPublik,
    hitungHargaFinalMenuPublik,
    picuGetarSentuh
} from '../utils/math-engine.js';
import { FirestoreParser, JaparPageRouter } from '../core/app-shell.js';
import {
    getKoordinatPelangganAktif,
    sematkanKoordinatGpsPengantaran,
    ekstrakLokasiDanJalanPelangganViaGas,
    perbaruiIndikatorGpsHeader,
    simpanDanTerapkanGps
} from './location-service.js';

export const OrderWAValidator = {
    normalizeWA: function(rawInput) {
        if (!rawInput || typeof rawInput !== 'string') return { valid: false, cleanNumber: '' };
        const digits = rawInput.replace(/[^0-9]/g, '');
        let normalized = digits;
        if (digits.startsWith('08')) normalized = '628' + digits.substring(2);
        else if (digits.startsWith('8')) normalized = '628' + digits.substring(1);
        const isValid = /^628[1-9][0-9]{7,11}$/.test(normalized);
        return { valid: isValid, cleanNumber: isValid ? normalized : '' };
    }
};
window.OrderWAValidator = OrderWAValidator;

const OPEN_INDEX_NODES_CACHE_KEY = 'japar_open_index_nodes_v3';
const OPEN_INDEX_CACHE_KEY = 'japar_open_index_cache_v2';
const MENU_DOC_STORAGE_PREFIX = 'japar_menu_doc_v2_';
const ACTIVE_CART_STORAGE_KEY = 'japar_active_cart_v2';
export const BUYER_PROFILE_CACHE_KEY = 'japar_buyer_info_v1';
const ORDER_HISTORY_STORAGE_KEY = 'japar_order_history_v1';

export function readSavedBuyerProfile() {
    try {
        const raw = localStorage.getItem(BUYER_PROFILE_CACHE_KEY);
        if (!raw) return { name: '', wa: '', address: '', shortStreet: '', rawGmapsInput: '', notes: '', gps: null, updatedAt: 0 };
        const parsed = JSON.parse(raw) || {};
        return {
            name: String(parsed.name || '').trim(),
            wa: String(parsed.wa || '').trim(),
            address: String(parsed.address || '').trim(),
            shortStreet: String(parsed.shortStreet || '').trim(),
            rawGmapsInput: String(parsed.rawGmapsInput || '').trim(),
            notes: String(parsed.notes || '').trim(),
            gps: (parsed.gps && !isNaN(parsed.gps.lat) && !isNaN(parsed.gps.lng))
                ? {
                    lat: Number(parseFloat(parsed.gps.lat).toFixed(6)),
                    lng: Number(parseFloat(parsed.gps.lng).toFixed(6)),
                    geohash: String(parsed.gps.geohash || encodeGeohash(Number(parsed.gps.lat), Number(parsed.gps.lng), 6))
                }
                : null,
            updatedAt: Number(parsed.updatedAt || 0)
        };
    } catch (e) {
        return { name: '', wa: '', address: '', shortStreet: '', rawGmapsInput: '', notes: '', gps: null, updatedAt: 0 };
    }
}

export function isBuyerProfileComplete() {
    const prof = readSavedBuyerProfile();
    return Boolean(prof.name && prof.name.length >= 2 && prof.address && prof.address.length >= 5);
}
window.isBuyerProfileComplete = isBuyerProfileComplete;
window.readSavedBuyerProfile = readSavedBuyerProfile;
const MAX_ORDER_HISTORY_ITEMS = 20;

const REVALIDATE_COOLDOWN_MS = 60 * 1000;
const MAX_RADIUS_KM = 20.0;

export const ALLOWED_CULINARY_CATEGORIES = new Set([
    'HIDANGAN_UTAMA',
    'MINUMAN_KOPI',
    'CAMILAN_JAJANAN',
    'ROTI_OLEH_OLEH',
    'PAKET_HEMAT',
    'KULINER',
    'KOPI_JAJANAN',
    'OLEH_OLEH'
]);

export function _normalizeStoreCategory(rawCat, srvFlags = '', kwText = '') {
    const clean = String(rawCat || '').trim().toUpperCase();
    if (clean === 'PAKET_HEMAT') {
        return 'PAKET_HEMAT';
    }
    if (clean === 'HIDANGAN_UTAMA' || clean === 'KULINER') {
        return 'HIDANGAN_UTAMA';
    }
    if (clean === 'ROTI_OLEH_OLEH' || clean === 'OLEH_OLEH') {
        return 'ROTI_OLEH_OLEH';
    }
    if (clean === 'MINUMAN_KOPI') {
        return 'MINUMAN_KOPI';
    }
    if (clean === 'CAMILAN_JAJANAN') {
        return 'CAMILAN_JAJANAN';
    }
    if (clean === 'KOPI_JAJANAN') {
        const flags = String(srvFlags || '');
        const kw = String(kwText || '').toLowerCase();
        const hasSnackFlagOnly = (flags.includes('C') || flags.includes('J')) && !flags.includes('M') && !flags.includes('D');
        const hasSnackKeyword = /\b(kebab|martabak|gorengan|tahu|tempe|dimsum|pentol|cilok|seblak|cireng)\b/i.test(kw);
        if (hasSnackFlagOnly || hasSnackKeyword) {
            return 'CAMILAN_JAJANAN';
        }
        return 'MINUMAN_KOPI';
    }
    return 'HIDANGAN_UTAMA';
}

/**
 * Memecah string opsi minuman (`drk`) atau varian (`var`) yang dipisah koma menjadi array objek opsi:
 * `{ raw: "Es Jeruk (+2000)", label: "Es Jeruk", extraPrice: 2000, display: "Es Jeruk (+Rp 2.000)" }`
 * Mendukung penulisan `(+2000)`, `(+Rp 2.000)`, `(+2rb)`, `(+4.000)`, atau `(+2k)`.
 */
export function _parseOptionChoicesString(rawStr = '') {
    const clean = String(rawStr || '').trim();
    if (!clean) return [];
    const parts = clean.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
    return parts.map(part => {
        const cleanPart = part.replace(/^\+\s*/, '').trim();
        let label = cleanPart;
        let extraPrice = 0;
        const addonMatch = cleanPart.match(/(?:\(\s*\+\s*(?:rp\.?\s*)?(\d+(?:[.,]\d+)?)\s*(rb|ribu|k)?\s*\)|\+\s*(?:rp\.?\s*)?(\d+(?:[.,]\d+)?)\s*(rb|ribu|k)?\s*$)/i);
        if (addonMatch) {
            const numRaw = addonMatch[1] || addonMatch[3] || '0';
            const unitRaw = (addonMatch[2] || addonMatch[4] || '').toLowerCase();
            if (unitRaw === 'rb' || unitRaw === 'ribu' || unitRaw === 'k') {
                extraPrice = Math.round((parseFloat(numRaw.replace(',', '.')) || 0) * 1000);
            } else {
                const cleanDigits = numRaw.replace(/[.,](\d{3})\b/g, '$1').replace(/[^0-9]/g, '');
                const parsed = parseInt(cleanDigits, 10) || 0;
                extraPrice = (parsed > 0 && parsed < 100) ? parsed * 1000 : parsed;
            }
            label = cleanPart.replace(addonMatch[0], '').trim();
        }
        if (!label) label = cleanPart;
        const cleanExtra = Math.max(0, extraPrice);
        const canonicalRaw = cleanExtra > 0 ? `${label} (+${cleanExtra})` : label;
        const display = cleanExtra > 0
            ? `${label} (+Rp ${cleanExtra.toLocaleString('id-ID')})`
            : label;
        return {
            raw: canonicalRaw,
            label,
            extraPrice: cleanExtra,
            display
        };
    });
}
window._parseOptionChoicesString = _parseOptionChoicesString;

function _expandLevelRangeFromText(text = '') {
    const str = String(text || '');
    if (!str) return '';
    const match = str.match(/\b(?:level|lvl|lv)\.?\s*(\d{1,2})\s*(?:[-–—]|s\/d|sampai|to)\s*(\d{1,2})\b/i);
    if (!match) return '';
    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || (end - start) > 15) {
        return '';
    }
    const list = [];
    for (let lv = start; lv <= end; lv++) {
        list.push(`Level ${lv}`);
    }
    return `Level Pedas: ${list.join(', ')}`;
}

/**
 * Fallback Artikulasi Varian Otomatis Tanpa Tulis Database (Zero-DB-Write Fallback):
 * Jika item dari Firestore memiliki `var` yang masih kosong (atau rentang level belum diekspansi),
 * fungsi ini mendeteksi pola level, penyajian, suhu saji, serta saus/sambal dari `itemName` & `rawDesc`.
 */
export function _autoArticulateMissingVarFromItem(itemName = '', rawVar = '', rawDesc = '') {
    const cleanName = String(itemName || '').trim();
    const cleanDesc = String(rawDesc || '').trim();
    let workingVar = String(rawVar || '').trim();

    if (workingVar) {
        const expandedInRaw = _expandLevelRangeFromText(workingVar);
        if (expandedInRaw) {
            const segs = workingVar.split(/\s*\|\s*/).map(seg => {
                if (/\b(?:level|lvl|lv)\.?\s*(\d{1,2})\s*(?:[-–—]|s\/d|sampai|to)\s*(\d{1,2})\b/i.test(seg)) {
                    return expandedInRaw;
                }
                return seg;
            });
            workingVar = segs.join(' | ');
        }
        return workingVar.substring(0, 280);
    }

    const detectedGroups = [];

    // 1. Pola rentang level (contoh: Mie Pedas Gurih Jangkrik (Level 0 - 3))
    const levelGroup = _expandLevelRangeFromText(cleanName) || _expandLevelRangeFromText(cleanDesc);
    if (levelGroup) {
        detectedGroups.push(levelGroup);
    }

    // 2. Pola Metode Penyajian / Suhu Saji dengan garis miring (/)
    if (
        /\b(tim|kukus)\s*\/\s*goreng\b/i.test(cleanName) ||
        /\bgoreng\s*\/\s*(tim|kukus)\b/i.test(cleanName)
    ) {
        detectedGroups.push('Penyajian: Tim (Kukus), Goreng');
    }

    if (
        /\b(ice|es|dingin)\s*\/\s*(hot|panas|hangat)\b/i.test(cleanName) ||
        /\b(hot|panas|hangat)\s*\/\s*(ice|es|dingin)\b/i.test(cleanName)
    ) {
        detectedGroups.push('Suhu Saji: Ice (Dingin), Hot (Panas)');
    }

    if (
        /\b(kuah)\s*\/\s*(goreng)\b/i.test(cleanName) ||
        /\b(goreng)\s*\/\s*(kuah)\b/i.test(cleanName)
    ) {
        detectedGroups.push('Penyajian: Kuah, Goreng');
    }

    if (
        /\b(bakar)\s*\/\s*(goreng)\b/i.test(cleanName) ||
        /\b(goreng)\s*\/\s*(bakar)\b/i.test(cleanName)
    ) {
        detectedGroups.push('Penyajian: Bakar, Goreng');
    }

    // 3. Pola Pilihan Sauce / Saus / Sambal pada deskripsi atau nama menu
    const combinedText = `${cleanName} | ${cleanDesc}`;
    const sauceMatch = combinedText.match(/(?:\bpilihan\s+)?(?:sauce|saus)\s*[:=-]\s*([^)|;\n]+)/i);
    if (sauceMatch && sauceMatch[1]) {
        const sauceList = sauceMatch[1]
            .replace(/[()]/g, '')
            .replace(/\b(?:atau|or|dan)\b/gi, ',')
            .split(/\s*[,/]\s*/)
            .map(s => s.replace(/^[.\s-]+|[.\s-]+$/g, '').trim())
            .filter(Boolean);
        if (sauceList.length > 0) {
            detectedGroups.push(`Pilihan Saus: ${sauceList.join(', ')}`);
        }
    }

    const sambalMatch = combinedText.match(/(?:\bpilihan\s+)?sambal\s*[:=-]\s*([^)|;\n]+)/i);
    if (sambalMatch && sambalMatch[1]) {
        const sambalList = sambalMatch[1]
            .replace(/[()]/g, '')
            .replace(/\b(?:atau|or|dan)\b/gi, ',')
            .split(/\s*[,/]\s*/)
            .map(s => s.replace(/^[.\s-]+|[.\s-]+$/g, '').trim())
            .filter(Boolean);
        if (sambalList.length > 0) {
            detectedGroups.push(`Pilihan Sambal: ${sambalList.join(', ')}`);
        }
    }

    return detectedGroups.join(' | ').substring(0, 280);
}
window._autoArticulateMissingVarFromItem = _autoArticulateMissingVarFromItem;

/**
 * Menguraikan string definisi varian (`rawVarStr`) menjadi array grup varian terstruktur:
 * Mendukung sintaks Multi-Grup (`|`) serta grup Extra Topping Multi-Pilih (`[+]`).
 * Return: `[{ groupIndex, groupTitle, isMulti, options: [{ raw, label, extraPrice, display }] }]`
 */
export function _parseVariantGroups(rawVarStr = '') {
    const clean = String(rawVarStr || '').trim();
    if (!clean) return [];

    const segments = clean
        .split(/\s*\|\s*|\s*;\s*/)
        .map(s => s.trim())
        .filter(Boolean);

    const groups = [];

    segments.forEach(seg => {
        let rawHeader = '';
        let choicesPart = seg;

        const colonIdx = seg.indexOf(':');
        if (colonIdx !== -1) {
            rawHeader = seg.slice(0, colonIdx).trim();
            choicesPart = seg.slice(colonIdx + 1).trim();
        }

        const expandedRange = _expandLevelRangeFromText(choicesPart);
        if (expandedRange) {
            const expColon = expandedRange.indexOf(':');
            if (!rawHeader) rawHeader = expandedRange.slice(0, expColon).trim();
            choicesPart = expandedRange.slice(expColon + 1).trim();
        }

        const options = _parseOptionChoicesString(choicesPart);
        if (options.length === 0) return;

        let isMulti = false;
        let groupTitle = '';

        if (rawHeader) {
            isMulti = /\[\+\]/.test(rawHeader) || /\b(extra|ekstra|topping|toping|tambahan|add[\s-]*on|addon)\b/i.test(rawHeader);
            groupTitle = rawHeader.replace(/\s*\[\+\]\s*/g, '').trim();
        } else {
            const joinedLabels = options.map(o => o.label).join(' ');
            if (/\b(level|lvl|lv|pedas)\b/i.test(joinedLabels)) {
                groupTitle = 'Pilih Level Pedas';
            } else if (/\b(saus|sauce|sambal|bbq|blackpepper|thai\s*hot|teriyaki|keju|matah|bawang|ijo|korek)\b/i.test(joinedLabels)) {
                groupTitle = 'Pilih Saus / Sambal';
            } else if (/\b(ice|hot|dingin|panas|hangat)\b/i.test(joinedLabels)) {
                groupTitle = 'Pilih Suhu Saji';
            } else if (options.length <= 3 && /\b(tim|kukus|goreng|bakar|kuah)\b/i.test(joinedLabels)) {
                groupTitle = 'Pilih Penyajian';
            } else {
                groupTitle = 'Pilih Varian / Lauk';
            }
        }

        groups.push({
            groupIndex: groups.length,
            groupTitle: groupTitle || 'Pilih Varian / Lauk',
            isMulti,
            options
        });
    });

    return groups;
}
window._parseVariantGroups = _parseVariantGroups;

export const CatalogOrderEngine = {
    _rawOpenIndexMap: {},
    _merchantsList: [],
    _activeCategory: 'ALL',
    _activeQuickFilter: 'ALL',
    _selectedRadiusKm: 20.0,
    _searchQuery: '',
    _storeSearchQuery: '',
    _storeSubCategory: 'ALL',
    _preferredReceiveMethod: 'KURIR_WARUNG', // 'KURIR_WARUNG' | 'AMBIL_SENDIRI' | 'MAKAN_DI_TEMPAT'
    _selectedCashDenom: 'PAS', // 'PAS' | '20000' | '50000' | '100000'
    _activeMerchantMeta: null,
    _activeMerchantDoc: null,
    _activeCheckoutState: null,
    _memoryMenuCache: Object.create(null),
    _inflightMenuFetchMap: Object.create(null),
    _lastNetworkFetchTs: 0,
    _cart: {
        uidMerchant: null,
        storeName: '',
        storeAddress: '',
        storeLat: null,
        storeLng: null,
        itemsMap: {}
    },
    _isInitialized: false,
    _isLoadingIndex: false,

    init: function() {
        if (this._isInitialized) {
            this.loadCatalogIndex(false);
            return;
        }
        this._isInitialized = true;
        this._restoreSavedCart();
        this._bindAllEvents();
        this.updateBottomNavBadges();
        this.loadCatalogIndex(true);
    },

    showNotice: function(msg, title = 'INFORMASI') {
        const modal = document.getElementById('japarNoticeModal');
        const titleEl = document.getElementById('japarNoticeModalTitle');
        const msgEl = document.getElementById('japarNoticeModalMsg');
        if (modal && msgEl) {
            if (titleEl) titleEl.textContent = title;
            msgEl.innerHTML = msg;
            modal.classList.remove('hidden');
        }
    },

    openQrisPreviewModal: function(qrisUrl, storeName = 'QRIS Resmi Resto') {
        const modal = document.getElementById('japarQrisPreviewModal');
        const imgEl = document.getElementById('japarQrisModalImg');
        const titleEl = document.getElementById('japarQrisModalStoreName');
        if (!modal || !imgEl) return;
        imgEl.src = qrisUrl;
        if (titleEl) titleEl.textContent = `QRIS • ${storeName}`;
        modal.classList.remove('hidden');
    },

    _formatRp: function(nominal) {
        const val = Math.max(0, Math.round(Number(nominal) || 0));
        return 'Rp ' + val.toLocaleString('id-ID');
    },

    _escapeHtml: function(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    _buildPhotoUrl: function(publicId, fallbackTitle = 'Resto', width = 400) {
        return bangunUrlGambarCloudinary(publicId, width, fallbackTitle);
    },

    _buildStoreGmapsUrl: function(lat, lng, storeName = '') {
        const numLat = parseFloat(lat);
        const numLng = parseFloat(lng);
        if (!isNaN(numLat) && !isNaN(numLng)) {
            return `https://www.google.com/maps/search/?api=1&query=${numLat.toFixed(6)},${numLng.toFixed(6)}`;
        }
        if (storeName) {
            return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(storeName + ' Pare Kediri')}`;
        }
        return 'https://www.google.com/maps';
    },

    _calculateFinalPrice: function(normalPrice, itemDiscPct = 0, storeDiscPct = 0, skemaDiskon = 'MAX_BEST') {
        return hitungHargaFinalMenuPublik(normalPrice, itemDiscPct, storeDiscPct, skemaDiskon);
    },

    _normalizeStoreCategory: function(rawCat, srvFlags = '', kwText = '') {
        return _normalizeStoreCategory(rawCat, srvFlags, kwText);
    },

    _parseOptionChoicesString: function(rawStr = '') {
        return _parseOptionChoicesString(rawStr);
    },

    _autoArticulateMissingVarFromItem: function(itemName = '', rawVar = '', rawDesc = '') {
        return _autoArticulateMissingVarFromItem(itemName, rawVar, rawDesc);
    },

    _parseVariantGroups: function(rawVarStr = '') {
        return _parseVariantGroups(rawVarStr);
    },

    _shortGroupPrefixForVar: function(groupTitle = '') {
        const clean = String(groupTitle || '').trim();
        if (/\b(saus|sauce)\b/i.test(clean)) return 'Saus';
        if (/\bsambal\b/i.test(clean)) return 'Sambal';
        if (/\bsuhu\b/i.test(clean)) return 'Suhu';
        if (/\bpenyajian\b/i.test(clean)) return 'Penyajian';
        if (/\blauk\b/i.test(clean)) return 'Lauk';
        return clean.replace(/^pilih(?:an)?\s+/i, '').trim() || 'Opsi';
    },

    /**
     * Menghasilkan nilai default `selectedVar` saat item pertama kali ditambahkan ke keranjang:
     * Memilih `options[0].raw` untuk setiap grup wajib (`!group.isMulti`), sedangkan grup opsional (`group.isMulti`) dimulai kosong.
     */
    _buildDefaultSelectedVarFromGroups: function(groupsOrRawVar = []) {
        const groups = Array.isArray(groupsOrRawVar)
            ? groupsOrRawVar
            : this._parseVariantGroups(String(groupsOrRawVar || ''));
        if (groups.length === 0) return '';

        const selectionsMap = {};
        groups.forEach(g => {
            if (!g.isMulti && g.options.length > 0) {
                selectionsMap[g.groupIndex] = g.options[0].raw;
            } else {
                selectionsMap[g.groupIndex] = [];
            }
        });
        return this._serializeSelectionsByGroup(selectionsMap, groups);
    },

    /**
     * Menguraikan string gabungan `selectedVar` kembali ke peta pilihan per-grup `{ [groupIndex]: string | string[] }`
     */
    _resolveSelectionsByGroup: function(selectedVarStr = '', groupsOrRawVar = []) {
        const groups = Array.isArray(groupsOrRawVar)
            ? groupsOrRawVar
            : this._parseVariantGroups(String(groupsOrRawVar || ''));
        const map = {};
        if (groups.length === 0) return map;

        const rawStr = String(selectedVarStr || '').trim();
        const rawSegments = rawStr
            ? rawStr.split(/\s*\|\s*/).map(s => s.trim()).filter(Boolean)
            : [];

        // Kumpulkan semua token pilihan (dengan & tanpa prefix grup / tanda +)
        const candidateTokens = [];
        rawSegments.forEach(seg => {
            let body = seg;
            const colonIdx = seg.indexOf(':');
            if (colonIdx !== -1 && colonIdx < 32 && !seg.slice(0, colonIdx).includes('(+')) {
                body = seg.slice(colonIdx + 1).trim();
            }
            body.split(/\s*,\s*/).forEach(tok => {
                const cleanTok = tok.replace(/^\+\s*/, '').trim();
                if (cleanTok) candidateTokens.push(cleanTok);
            });
        });

        const lowerTokens = candidateTokens.map(t => t.toLowerCase());

        groups.forEach(g => {
            if (!g.isMulti) {
                let matchedRaw = '';
                for (const opt of g.options) {
                    const rLow = opt.raw.toLowerCase();
                    const lLow = opt.label.toLowerCase();
                    if (lowerTokens.includes(rLow) || lowerTokens.includes(lLow)) {
                        matchedRaw = opt.raw;
                        break;
                    }
                }
                if (!matchedRaw && g.options.length > 0) {
                    matchedRaw = g.options[0].raw;
                }
                map[g.groupIndex] = matchedRaw;
            } else {
                const picked = [];
                g.options.forEach(opt => {
                    const rLow = opt.raw.toLowerCase();
                    const lLow = opt.label.toLowerCase();
                    if (lowerTokens.includes(rLow) || lowerTokens.includes(lLow)) {
                        picked.push(opt.raw);
                    }
                });
                map[g.groupIndex] = picked;
            }
        });

        return map;
    },

    /**
     * Menyimpan peta pilihan antar-grup ke string `selectedVar` dengan pemisah `" | "`
     * Contoh: `"Level 2 | Saus: BBQ | +Topping Ayam Tabur (+2000), +Telur Ceplok (+4000)"`
     */
    _serializeSelectionsByGroup: function(selectionsMap = {}, groups = []) {
        if (!Array.isArray(groups) || groups.length === 0) return '';
        const outSegments = [];
        const requiredGroupCount = groups.filter(g => !g.isMulti).length;

        groups.forEach(g => {
            if (!g.isMulti) {
                const chosenRaw = String(selectionsMap[g.groupIndex] || g.options[0]?.raw || '').trim();
                if (!chosenRaw) return;
                if (groups.length === 1 || (requiredGroupCount === 1 && /^level\b/i.test(chosenRaw)) || /^level\s*\d/i.test(chosenRaw)) {
                    outSegments.push(chosenRaw);
                } else {
                    const shortPrefix = this._shortGroupPrefixForVar(g.groupTitle);
                    if (chosenRaw.toLowerCase().startsWith(shortPrefix.toLowerCase())) {
                        outSegments.push(chosenRaw);
                    } else {
                        outSegments.push(`${shortPrefix}: ${chosenRaw}`);
                    }
                }
            } else {
                const list = Array.isArray(selectionsMap[g.groupIndex]) ? selectionsMap[g.groupIndex] : [];
                const cleanList = list.map(x => String(x || '').replace(/^\+\s*/, '').trim()).filter(Boolean);
                if (cleanList.length > 0) {
                    outSegments.push(cleanList.map(item => `+${item}`).join(', '));
                }
            }
        });

        return outSegments.join(' | ');
    },

    /**
     * Memperbarui string `selectedVar` ketika chip opsi pada grup `groupIndex` diketuk:
     * - Grup Radio (`!group.isMulti`): ganti pilihan grup tersebut dengan `clickedOptionRaw`
     * - Grup Checkbox (`group.isMulti === true`): toggle aktif/nonaktif `clickedOptionRaw`
     */
    _toggleOrSelectVarGroupOption: function(currentSelectedVarStr = '', rawVarDefinition = '', groupIndex = 0, clickedOptionRaw = '') {
        const groups = this._parseVariantGroups(rawVarDefinition);
        if (groups.length === 0) return String(clickedOptionRaw || '').trim();

        const selectionsMap = this._resolveSelectionsByGroup(currentSelectedVarStr, groups);
        const targetGroup = groups.find(g => g.groupIndex === Number(groupIndex)) || groups[0];
        const cleanClicked = String(clickedOptionRaw || '').replace(/^\+\s*/, '').trim();

        if (!targetGroup.isMulti) {
            selectionsMap[targetGroup.groupIndex] = cleanClicked;
        } else {
            const currentArr = Array.isArray(selectionsMap[targetGroup.groupIndex])
                ? [...selectionsMap[targetGroup.groupIndex]]
                : [];
            const existIdx = currentArr.findIndex(x => x.toLowerCase() === cleanClicked.toLowerCase());
            if (existIdx !== -1) {
                currentArr.splice(existIdx, 1);
            } else {
                currentArr.push(cleanClicked);
            }
            selectionsMap[targetGroup.groupIndex] = currentArr;
        }

        return this._serializeSelectionsByGroup(selectionsMap, groups);
    },

    /**
     * Memformat pilihan `selectedVar` menjadi teks berlabel lengkap untuk struk WhatsApp & riwayat pesanan:
     * Contoh: `"Level Pedas: Level 2 | Pilihan Saus: BBQ | Extra Topping: +Telur Ceplok (+4000)"`
     */
    _formatSelectedVarForDisplay: function(selectedVarStr = '', rawVarDefinition = '') {
        const cleanSelected = String(selectedVarStr || '').trim();
        const cleanDef = String(rawVarDefinition || '').trim();
        if (!cleanSelected && !cleanDef) return '';

        const groups = this._parseVariantGroups(cleanDef);
        if (groups.length === 0) return cleanSelected;

        if (groups.length === 1 && !groups[0].isMulti && !cleanDef.includes(':')) {
            return cleanSelected || (groups[0].options[0]?.raw || '');
        }

        const selectionsMap = this._resolveSelectionsByGroup(cleanSelected, groups);
        const parts = [];
        groups.forEach(g => {
            const cleanTitle = g.groupTitle.replace(/^pilih\s+/i, '').trim() || g.groupTitle;
            if (!g.isMulti) {
                const val = String(selectionsMap[g.groupIndex] || '').trim();
                if (val) {
                    parts.push(`${cleanTitle}: ${val}`);
                }
            } else {
                const arr = Array.isArray(selectionsMap[g.groupIndex]) ? selectionsMap[g.groupIndex] : [];
                if (arr.length > 0) {
                    const formattedAddons = arr.map(x => {
                        const c = String(x || '').replace(/^\+\s*/, '').trim();
                        return `+${c}`;
                    }).join(', ');
                    parts.push(`${cleanTitle}: ${formattedAddons}`);
                }
            }
        });

        return parts.join(' | ');
    },

    /**
     * Menghitung total seluruh `extraPrice` dari opsi minuman atau multi-grup varian/topping yang aktif
     */
    _getExtraPriceForChoice: function(choiceRawOrLabel = '', parsedOptionsOrGroups = []) {
        const target = String(choiceRawOrLabel || '').trim();
        if (!target) return 0;

        let flatOptions = [];
        if (typeof parsedOptionsOrGroups === 'string') {
            flatOptions = this._parseVariantGroups(parsedOptionsOrGroups).flatMap(g => g.options);
        } else if (Array.isArray(parsedOptionsOrGroups) && parsedOptionsOrGroups.length > 0) {
            if (Array.isArray(parsedOptionsOrGroups[0]?.options)) {
                flatOptions = parsedOptionsOrGroups.flatMap(g => g.options || []);
            } else {
                flatOptions = parsedOptionsOrGroups;
            }
        }

        // Pecah target berdasarkan `|` lalu `,` untuk mendukung multi-grup & multi-topping
        const tokens = [];
        target.split(/\s*\|\s*/).forEach(seg => {
            let body = seg.trim();
            if (!body) return;
            const colonIdx = body.indexOf(':');
            if (colonIdx !== -1 && colonIdx < 32 && !body.slice(0, colonIdx).includes('(+')) {
                body = body.slice(colonIdx + 1).trim();
            }
            body.split(/\s*,\s*/).forEach(part => {
                const cleanPart = part.replace(/^\+\s*/, '').trim();
                if (cleanPart) tokens.push(cleanPart);
            });
        });

        let totalExtra = 0;
        tokens.forEach(tok => {
            const lowerTok = tok.toLowerCase();
            let matchedExtra = null;
            if (flatOptions.length > 0) {
                const found = flatOptions.find(o =>
                    o.raw.toLowerCase() === lowerTok ||
                    o.label.toLowerCase() === lowerTok ||
                    o.display.toLowerCase() === lowerTok
                );
                if (found) {
                    matchedExtra = found.extraPrice || 0;
                }
            }
            if (matchedExtra !== null) {
                totalExtra += matchedExtra;
            } else {
                const parsedSingle = _parseOptionChoicesString(tok);
                if (parsedSingle.length > 0) {
                    totalExtra += (parsedSingle[0].extraPrice || 0);
                }
            }
        });

        return totalExtra;
    },

    /**
     * Generator Preset Catatan Kontekstual Cerdas 6-Kategori Hidangan:
     * Menghindari chip tidak relevan (seperti "Nasi Sedikit" pada menu Mie/Bakso/Ramen)
     * dan otomatis menyembunyikan chip "Pedas/Sedang/Tidak Pedas" jika menu sudah punya grup Level/Pedas.
     */
    /**
     * Generator Preset Catatan Kontekstual 9 Subtipe Kuliner Akurat 100%:
     * 1) Minuman Panas (Hot, Hangat, Wedang)
     * 2) Minuman Dingin / Es / Kopi / Tea / Jus
     * 3) Roti, Donat, Kue & Oleh-Oleh
     * 4) Nasi Goreng / Mie Goreng / Kwetiau Goreng / Bihun Goreng
     * 5) Hidangan Berkuah Eksplisit (bakso, soto, rawon, sop, sup, ramen, seblak, gulai, lontong, tongseng, mie kuah/rebus/nyemek, kuah)
     * 6) Mie Level / Mie Pedas / Cwie Mie / Mie Ayam / Bakmi / Yamin / Kwetiau / Bihun (KERING TANPA KUAH - 0% Kuah Pisah & 0% Nasi Sedikit!)
     * 7) Dimsum / Ekkado / Wonton / Camilan / Gorengan / Kebab / Burger
     * 8) Ayam Saus / Ricebowl / Chicken Wings / Katsu
     * 9) Nasi Lalapan / Penyetan / Geprek / Bakar / Lauk Nasi Lainnya
     */
    _getPresetsForCategory: function(katName = '', itemName = '', rawVarStr = '', rawDesc = '') {
        const cleanKat = String(katName || '').trim();
        const cleanName = String(itemName || '').trim();
        const cleanVar = String(rawVarStr || '').trim();
        const cleanDesc = String(rawDesc || '').trim();
        const lowerName = cleanName.toLowerCase();
        const combinedText = `${cleanName} ${cleanDesc}`.toLowerCase();
        const combinedKatAndName = `${cleanKat} ${cleanName}`.toLowerCase();

        const hasExplicitLevelOrSpicyVar =
            /\b(level|lvl|lv|pedas)\b/i.test(cleanVar) ||
            /\b(?:level|lvl|lv)\.?\s*\d{1,2}\s*(?:[-–—]|s\/d|sampai|to)\s*\d{1,2}\b/i.test(cleanName);

        // 1 & 2) Minuman Panas vs Minuman Dingin / Es / Kopi / Tea / Jus
        const isFoodKeyword = /\b(nasi|mie|mi\b|cwie|bakmi|yamin|kwetiau|kwitiau|bihun|ayam|bebek|ikan|bakso|soto|rawon|sop|sup|ramen|seblak|gulai|lontong|tongseng|ricebowl|rice\s*bowl|geprek|penyet|dimsum|ekkado|wonton|siomay|batagor|kebab|burger|donat|roti|kue|brownies|bolu)\b/i.test(lowerName);
        if (
            cleanKat === 'Minuman & Kopi' ||
            (!isFoodKeyword && /\b(minuman|minum|kopi|coffee|es\b|ice\b|teh|tea|jus|juice|susu|milk|coklat|chocolate|matcha|taro|boba|latte|americano|cappuccino|frappe|frappie|mocktail|shake|float|squash|wedang|jeruk|mineral|hot|hangat)\b/i.test(combinedKatAndName))
        ) {
            const hasHot = /\b(hot|hangat|panas|wedang)\b/i.test(combinedText);
            const hasCold = /\b(ice|es|dingin)\b/i.test(combinedText);
            if (hasHot && !hasCold) {
                // 1) Minuman Panas
                return ['Manis Normal', 'Less Sugar', 'Tanpa Gula', 'Gula Pisah'];
            }
            // 2) Minuman Dingin / Es / Kopi / Tea / Jus
            return ['Manis Normal', 'Less Sugar', 'Tanpa Gula', 'Less Ice', 'Normal Ice', 'Es Pisah'];
        }

        // 3) Roti, Donat, Kue & Oleh-Oleh
        if (
            cleanKat === 'Roti, Kue & Oleh-Oleh' ||
            /\b(roti|donat|donut|kue|cake|tart|bolu|brownies|pastry|croissant|bomboloni|cromboloni|waffle|pancake|pukis|terang\s*bulan|martabak\s*manis|dessert|lapis|bakpia|pia|cookies|biskuit|oleh[\s-]*oleh)\b/i.test(combinedKatAndName)
        ) {
            return ['Topping Pisah', 'Potong Kecil', 'Disajikan Hangat', 'Kurangi Manis', 'Kemas Rapi'];
        }

        // 4) Nasi Goreng / Mie Goreng / Kwetiau Goreng / Bihun Goreng (kecuali Mie Pedas / Mie Level / Mie Jangkrik / Cwie Mie)
        const isDryLevelNoodleName = /\b(mie\s*pedas|mi\s*pedas|mie\s*level|mi\s*level|mie\s*jangkrik|mie\s*gacoan|mie\s*setan|mie\s*iblis|mie\s*hompimpa|cwie\s*mie|mie\s*ayam|yamin|yamie)\b/i.test(lowerName);
        if (!isDryLevelNoodleName && /\b(nasi\s*goreng|nasgor|mie\s*goreng|mi\s*goreng|bakmi\s*goreng|kwetiau\s*goreng|kwitiau\s*goreng|bihun\s*goreng)\b/i.test(combinedText)) {
            const baseFried = [
                'Tanpa Sayur',
                'Tanpa Acar',
                'Tanpa Bawang Goreng',
                'Telur Matang',
                'Telur Setengah Matang',
                'Tanpa Kecap',
                'Kerupuk Pisah'
            ];
            return hasExplicitLevelOrSpicyVar
                ? baseFried
                : ['Pedas', 'Sedang', 'Tidak Pedas', ...baseFried];
        }

        // 5) Hidangan Berkuah Eksplisit (HANYA jika nama/deskripsi mengandung kata berkuah eksplisit)
        if (/\b(bakso|soto|rawon|sop|sup|ramen|seblak|gulai|lontong|tongseng|mie\s*kuah|mi\s*kuah|mie\s*rebus|mi\s*rebus|mie\s*nyemek|mi\s*nyemek|kwetiau\s*kuah|bihun\s*kuah|kuah)\b/i.test(combinedText)) {
            const baseSoup = [
                'Kuah Pisah',
                'Sambal/Jeruk Pisah',
                'Tanpa Bawang Goreng',
                'Tanpa Daun Bawang/Seledri',
                'Tanpa Sayur/Tauge'
            ];
            return hasExplicitLevelOrSpicyVar
                ? baseSoup
                : ['Pedas', 'Sedang', 'Tidak Pedas', ...baseSoup];
        }

        // 6) Mie Level / Mie Pedas / Cwie Mie / Mie Ayam / Bakmi / Yamin / Kwetiau / Bihun (KERING TANPA KUAH - 0% Kuah Pisah / Nasi Sedikit!)
        if (/\b(mie|mi|cwie|bakmi|yamin|kwetiau|kwitiau|bihun|spaghetti|pasta)\b/i.test(combinedText)) {
            const baseDryNoodle = [
                'Bumbu/Sambal Pisah',
                'Tanpa Bawang Goreng',
                'Tanpa Daun Bawang',
                'Tanpa Sayur/Sawi',
                'Pangsit/Kerupuk Pisah',
                'Jangan Terlalu Lembek'
            ];
            return hasExplicitLevelOrSpicyVar
                ? baseDryNoodle
                : ['Pedas', 'Sedang', 'Tidak Pedas', ...baseDryNoodle];
        }

        // 7) Dimsum / Ekkado / Wonton / Camilan / Gorengan / Kebab / Burger
        const isMainRiceOrChickenSauce = /\b(nasi|ricebowl|rice\s*bowl|ayam\s*celup|chicken\s*wings|fire\s*wings|katsu|teriyaki|paket\s*nasi|lalapan|penyet|geprek)\b/i.test(combinedText);
        if (
            cleanKat === 'Camilan & Jajanan' ||
            (!isMainRiceOrChickenSauce && /\b(dimsum|ekkado|wonton|gyoza|siomay|batagor|camilan|cemilan|jajanan|gorengan|kebab|burger|hotdog|shawarma|corndog|takoyaki|cireng|cimol|cilok|pentol|sempol|tahu|tempe|mendoan|kentang|french\s*fries|sosis|nugget|pisang\s*goreng|lumpia|risol|martabak|snack)\b/i.test(combinedKatAndName))
        ) {
            return [
                'Saus/Chili Oil Pisah',
                'Mayones Pisah',
                'Hangat Baru Matang',
                'Bumbu Tabur Pisah'
            ];
        }

        // 8) Ayam Saus / Ricebowl / Chicken Wings / Katsu
        if (
            /\b(ricebowl|rice\s*bowl|ayam\s*celup|chicken\s*wings|fire\s*wings|wings|katsu|teriyaki|blackpepper|bbq|mentai|keju|thai\s*hot)\b/i.test(combinedText) ||
            /\b(bbq|blackpepper|thai\s*hot|teriyaki|mentai)\b/i.test(cleanVar)
        ) {
            const baseSauceRice = [
                'Saus Dipisah',
                'Saus/Bumbu Ekstra',
                'Nasi Sedikit',
                'Tanpa Bawang Goreng',
                'Goreng Crispy'
            ];
            return hasExplicitLevelOrSpicyVar
                ? baseSauceRice
                : ['Pedas', 'Sedang', 'Tidak Pedas', ...baseSauceRice];
        }

        // 9) Nasi Lalapan / Penyetan / Geprek / Bakar / Lauk Nasi Lainnya
        const baseRiceLalapan = [
            'Sambal Pisah',
            'Bumbu Ekstra',
            'Nasi Sedikit',
            'Nasi Pisah',
            'Goreng Kering',
            'Tanpa Lalapan/Timun',
            'Tanpa Bawang Goreng'
        ];
        return hasExplicitLevelOrSpicyVar
            ? baseRiceLalapan
            : ['Pedas', 'Sedang', 'Tidak Pedas', ...baseRiceLalapan];
    },

    _togglePresetTagInNote: function(currentNote, tagText) {
        const cleanCurrent = String(currentNote || '').trim();
        const parts = cleanCurrent
            ? cleanCurrent.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean)
            : [];
        const existingIdx = parts.findIndex(p => p.toLowerCase() === tagText.toLowerCase());
        if (existingIdx !== -1) {
            parts.splice(existingIdx, 1);
        } else {
            parts.push(tagText);
        }
        return parts.join(', ').substring(0, 100);
    },

    /**
     * Menormalisasi array catatan per-porsi (`portionNotes`) agar sesuai panjang `qty`
     */
    _normalizePortionNotesArray: function(rawArr, qty) {
        const count = Math.max(1, parseInt(qty, 10) || 1);
        const src = Array.isArray(rawArr) ? rawArr : [];
        const result = [];
        for (let i = 0; i < count; i++) {
            result.push(String(src[i] || '').trim().substring(0, 100));
        }
        return result;
    },

    /**
     * Menormalisasi array pilihan minuman/varian per-porsi (`portionDrinks` / `portionVars`)
     */
    _normalizePortionChoiceArray: function(rawArr, qty, defaultChoice = '') {
        const count = Math.max(1, parseInt(qty, 10) || 1);
        const src = Array.isArray(rawArr) ? rawArr : [];
        const fallback = String(defaultChoice || '').trim();
        const result = [];
        for (let i = 0; i < count; i++) {
            if (src[i] !== undefined && src[i] !== null) {
                result.push(String(src[i]).trim());
            } else {
                result.push(fallback);
            }
        }
        return result;
    },

    /**
     * Membangun HTML Editor Kustomisasi Minuman Paket, Multi-Grup Varian (Level/Saus/Suhu/Extra Topping), & Catatan Hidangan
     * (Mendukung Mode Seragam & Mode Rinci Per-Porsi saat qty > 1)
     */
    _buildItemNoteEditorInnerHTML: function(itemId, itemName, itemKat, cartEntry) {
        const qty = cartEntry ? Math.max(0, parseInt(cartEntry.qty, 10) || 0) : 0;
        if (qty <= 0) return '';

        const effectiveVarStr = this._autoArticulateMissingVarFromItem(itemName, cartEntry.var || '', cartEntry.desc || '');
        if (effectiveVarStr && !cartEntry.var) {
            cartEntry.var = effectiveVarStr;
        }

        const presets = this._getPresetsForCategory(itemKat, itemName, effectiveVarStr, cartEntry.desc || '');
        const currentNote = String(cartEntry.note || '');
        const drinkOptions = this._parseOptionChoicesString(cartEntry.drk || '');
        const varGroups = this._parseVariantGroups(effectiveVarStr);

        const defaultDrinkRaw = drinkOptions.length > 0 ? drinkOptions[0].raw : '';
        const defaultVarRaw = this._buildDefaultSelectedVarFromGroups(varGroups);
        const selectedDrink = String(cartEntry.selectedDrink || defaultDrinkRaw).trim();
        const selectedVar = (cartEntry.selectedVar !== undefined && cartEntry.selectedVar !== null && String(cartEntry.selectedVar).trim() !== '')
            ? String(cartEntry.selectedVar).trim()
            : defaultVarRaw;

        const portionNotes = this._normalizePortionNotesArray(cartEntry.portionNotes, qty);
        const portionDrinks = this._normalizePortionChoiceArray(cartEntry.portionDrinks, qty, selectedDrink);
        const portionVars = this._normalizePortionChoiceArray(cartEntry.portionVars, qty, selectedVar);

        const hasAnyPortionNote = portionNotes.some(n => n.length > 0);
        const usePortionNotes = qty > 1 && (Boolean(cartEntry.usePortionNotes) || hasAnyPortionNote);

        const toggleHeaderHtml = qty > 1
            ? `<div class="item-note-mode-header">
                   <span class="item-note-mode-label">
                       <i class="fa-solid fa-utensils text-emerald"></i>
                       <span>Kustomisasi <b>${qty} Porsi</b> ${this._escapeHtml(itemName)}:</span>
                   </span>
                   <button type="button" class="btn-toggle-portion-notes ${usePortionNotes ? 'is-active' : ''}" data-item-id="${this._escapeHtml(itemId)}">
                       <i class="fa-solid ${usePortionNotes ? 'fa-check-double' : 'fa-list-ol'}"></i>
                       <span>${usePortionNotes ? `Rinci Per Porsi Aktif (${qty} Porsi)` : `+ Rinci Opsi/Catatan Per Porsi (1-${qty})`}</span>
                   </button>
               </div>`
            : '';

        if (!usePortionNotes) {
            const drinkSelectorHtml = drinkOptions.length > 0
                ? `<div class="pkg-choice-group">
                       <div class="pkg-choice-label">
                           <span><i class="fa-solid fa-glass-water text-emerald"></i> Pilih Minuman Paket:</span>
                           <span class="pkg-choice-mode-badge is-required">${drinkOptions.length > 1 ? 'Wajib Pilih 1' : 'Termasuk Paket'}</span>
                       </div>
                       <div class="pkg-choice-chips">
                           ${drinkOptions.map(opt => {
                               const isSel = opt.raw.toLowerCase() === selectedDrink.toLowerCase();
                               return `<button type="button" class="pkg-drink-choice-btn ${isSel ? 'is-selected' : ''}" data-drink-raw="${this._escapeHtml(opt.raw)}">
                                   <i class="fa-solid ${isSel ? 'fa-circle-check' : 'fa-mug-hot'}"></i>
                                   <span>${this._escapeHtml(opt.display)}</span>
                               </button>`;
                           }).join('')}
                       </div>
                   </div>`
                : '';

            const resolvedSelections = this._resolveSelectionsByGroup(selectedVar, varGroups);
            const varGroupsHtml = varGroups.map(group => {
                const isSpicyLevelGroup = /\b(level|lvl|lv|pedas)\b/i.test(group.groupTitle) || group.options.some(o => /^\s*(?:level|lvl|lv)\s*\d/i.test(o.label));
                const unselectedIconClass = isSpicyLevelGroup ? 'fa-fire-flame-curved' : 'fa-utensils';
                if (!group.isMulti) {
                    const activeSingleRaw = String(resolvedSelections[group.groupIndex] || group.options[0]?.raw || '');
                    const labelTitle = /^pilih/i.test(group.groupTitle) ? group.groupTitle : `Pilih ${group.groupTitle}`;
                    return `<div class="pkg-choice-group" data-var-group-idx="${group.groupIndex}" data-is-spicy-group="${isSpicyLevelGroup ? '1' : '0'}">
                        <div class="pkg-choice-label">
                            <span><i class="fa-solid ${isSpicyLevelGroup ? 'fa-fire-flame-curved' : 'fa-sliders'} text-amber"></i> ${this._escapeHtml(labelTitle)}:</span>
                            <span class="pkg-choice-mode-badge is-required">Wajib Pilih 1</span>
                        </div>
                        <div class="pkg-choice-chips">
                            ${group.options.map(opt => {
                                const isSel = opt.raw.toLowerCase() === activeSingleRaw.toLowerCase();
                                return `<button type="button" class="pkg-var-choice-btn ${isSel ? 'is-selected' : ''}" data-group-idx="${group.groupIndex}" data-var-raw="${this._escapeHtml(opt.raw)}">
                                    <i class="fa-solid ${isSel ? 'fa-circle-check' : unselectedIconClass}"></i>
                                    <span>${this._escapeHtml(opt.display)}</span>
                                </button>`;
                            }).join('')}
                        </div>
                    </div>`;
                }

                const activeMultiList = Array.isArray(resolvedSelections[group.groupIndex])
                    ? resolvedSelections[group.groupIndex].map(x => String(x).toLowerCase())
                    : [];
                return `<div class="pkg-choice-group is-multi-group" data-var-group-idx="${group.groupIndex}">
                    <div class="pkg-choice-label">
                        <span><i class="fa-solid fa-layer-group text-emerald"></i> ${this._escapeHtml(group.groupTitle)}:</span>
                        <span class="pkg-choice-mode-badge is-optional">Opsional • Bisa Pilih &gt;1</span>
                    </div>
                    <div class="pkg-choice-chips">
                        ${group.options.map(opt => {
                            const isSel = activeMultiList.includes(opt.raw.toLowerCase());
                            return `<button type="button" class="pkg-var-choice-btn is-multi-addon ${isSel ? 'is-selected' : ''}" data-group-idx="${group.groupIndex}" data-var-raw="${this._escapeHtml(opt.raw)}">
                                <i class="fa-solid ${isSel ? 'fa-square-check' : 'fa-plus'}"></i>
                                <span>${this._escapeHtml(opt.display)}</span>
                            </button>`;
                        }).join('')}
                    </div>
                </div>`;
            }).join('');

            const activeTags = currentNote.toLowerCase().split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
            const presetButtonsHtml = presets.map(tag => {
                const isSelected = activeTags.includes(tag.toLowerCase());
                return `<button type="button" class="note-preset-btn ${isSelected ? 'is-selected' : ''}" data-preset-tag="${this._escapeHtml(tag)}">${this._escapeHtml(tag)}</button>`;
            }).join('');

            const multiPortionHint = qty > 1
                ? `<div class="portion-notes-helper"><i class="fa-regular fa-lightbulb text-amber"></i> Pesan <b>${qty} porsi</b> dengan level, saus, topping, atau catatan berbeda-beda? Ketuk tombol <b>"+ Rinci Opsi/Catatan Per Porsi"</b> di atas.</div>`
                : '';

            const placeholderHint = presets.length >= 2
                ? `misal: ${presets.slice(0, 2).join(', ').toLowerCase()}...`
                : 'misal: bumbu pisah...';

            const summaryNow = this.getCartSummary();
            const matchedOrderIt = summaryNow.orderItems.find(x => x.id === itemId);
            const liveSubtotalBarHtml = matchedOrderIt
                ? `<div class="item-live-subtotal-bar" data-item-id="${this._escapeHtml(itemId)}" style="font-size: 0.64rem; padding: 5px 8px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border-subtle); display: flex; align-items: center; gap: 5px; flex-wrap: wrap;">${this._buildItemLiveSubtotalTextHtml(matchedOrderIt)}</div>`
                : '';

            return `
                ${toggleHeaderHtml}
                ${drinkSelectorHtml}
                ${varGroupsHtml}
                ${liveSubtotalBarHtml}
                <div class="item-note-input-wrap">
                    <i class="fa-solid fa-pen-to-square"></i>
                    <input type="text" maxlength="100" class="item-note-input" value="${this._escapeHtml(currentNote)}" placeholder="${qty > 1 ? `Catatan tambahan ${qty} porsi (opsional)...` : 'Ketik catatan tambahan porsi ini (opsional)...'}">
                </div>
                <div class="note-preset-chips">${presetButtonsHtml}</div>
                ${multiPortionHint}
            `;
        }

        // Mode Rinci Per Porsi (Porsi #1 s/d Porsi #qty)
        const portionCardsHtml = portionNotes.map((pNote, idx) => {
            const curPDrink = portionDrinks[idx] || selectedDrink;
            const curPVar = (portionVars[idx] !== undefined && portionVars[idx] !== null)
                ? portionVars[idx]
                : selectedVar;
            const pResolvedSelections = this._resolveSelectionsByGroup(curPVar, varGroups);

            const pDrinkRowHtml = drinkOptions.length > 0
                ? `<div class="pkg-choice-group" style="margin-bottom: 4px;">
                       <div class="pkg-choice-label">
                           <span style="font-size: 0.58rem; font-weight: 800; color: var(--basil-light);"><i class="fa-solid fa-glass-water"></i> Minuman Porsi #${idx + 1}:</span>
                           <span class="pkg-choice-mode-badge is-required">Wajib Pilih 1</span>
                       </div>
                       <div class="pkg-choice-chips">
                           ${drinkOptions.map(opt => {
                               const isSel = opt.raw.toLowerCase() === curPDrink.toLowerCase();
                               return `<button type="button" class="pkg-drink-choice-btn is-portion-drink ${isSel ? 'is-selected' : ''}" data-portion-idx="${idx}" data-drink-raw="${this._escapeHtml(opt.raw)}">
                                   <i class="fa-solid ${isSel ? 'fa-circle-check' : 'fa-mug-hot'}"></i>
                                   <span>${this._escapeHtml(opt.display)}</span>
                               </button>`;
                           }).join('')}
                       </div>
                   </div>`
                : '';

            const pVarGroupsHtml = varGroups.map(group => {
                const isSpicyLevelGroup = /\b(level|lvl|lv|pedas)\b/i.test(group.groupTitle) || group.options.some(o => /^\s*(?:level|lvl|lv)\s*\d/i.test(o.label));
                const unselectedIconClass = isSpicyLevelGroup ? 'fa-fire-flame-curved' : 'fa-utensils';
                if (!group.isMulti) {
                    const activeSingleRaw = String(pResolvedSelections[group.groupIndex] || group.options[0]?.raw || '');
                    return `<div class="pkg-choice-group" data-var-group-idx="${group.groupIndex}" data-is-spicy-group="${isSpicyLevelGroup ? '1' : '0'}" style="margin-bottom: 4px;">
                        <div class="pkg-choice-label">
                            <span style="font-size: 0.58rem; font-weight: 800; color: var(--honey-light);"><i class="fa-solid ${isSpicyLevelGroup ? 'fa-fire-flame-curved' : 'fa-sliders'}"></i> ${this._escapeHtml(group.groupTitle)} (Porsi #${idx + 1}):</span>
                            <span class="pkg-choice-mode-badge is-required">Wajib Pilih 1</span>
                        </div>
                        <div class="pkg-choice-chips">
                            ${group.options.map(opt => {
                                const isSel = opt.raw.toLowerCase() === activeSingleRaw.toLowerCase();
                                return `<button type="button" class="pkg-var-choice-btn is-portion-var ${isSel ? 'is-selected' : ''}" data-portion-idx="${idx}" data-group-idx="${group.groupIndex}" data-var-raw="${this._escapeHtml(opt.raw)}">
                                    <i class="fa-solid ${isSel ? 'fa-circle-check' : unselectedIconClass}"></i>
                                    <span>${this._escapeHtml(opt.display)}</span>
                                </button>`;
                            }).join('')}
                        </div>
                    </div>`;
                }

                const activeMultiList = Array.isArray(pResolvedSelections[group.groupIndex])
                    ? pResolvedSelections[group.groupIndex].map(x => String(x).toLowerCase())
                    : [];
                return `<div class="pkg-choice-group is-multi-group" data-var-group-idx="${group.groupIndex}" style="margin-bottom: 4px;">
                    <div class="pkg-choice-label">
                        <span style="font-size: 0.58rem; font-weight: 800; color: var(--basil-light);"><i class="fa-solid fa-layer-group"></i> ${this._escapeHtml(group.groupTitle)} (Porsi #${idx + 1}):</span>
                        <span class="pkg-choice-mode-badge is-optional">Opsional • Bisa Pilih &gt;1</span>
                    </div>
                    <div class="pkg-choice-chips">
                        ${group.options.map(opt => {
                            const isSel = activeMultiList.includes(opt.raw.toLowerCase());
                            return `<button type="button" class="pkg-var-choice-btn is-portion-var is-multi-addon ${isSel ? 'is-selected' : ''}" data-portion-idx="${idx}" data-group-idx="${group.groupIndex}" data-var-raw="${this._escapeHtml(opt.raw)}">
                                <i class="fa-solid ${isSel ? 'fa-square-check' : 'fa-plus'}"></i>
                                <span>${this._escapeHtml(opt.display)}</span>
                            </button>`;
                        }).join('')}
                    </div>
                </div>`;
            }).join('');

            const activeTags = pNote.toLowerCase().split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
            const pChipsHtml = presets.map(tag => {
                const isSelected = activeTags.includes(tag.toLowerCase());
                return `<button type="button" class="note-preset-btn is-portion-chip ${isSelected ? 'is-selected' : ''}" data-portion-idx="${idx}" data-preset-tag="${this._escapeHtml(tag)}">${this._escapeHtml(tag)}</button>`;
            }).join('');

            return `
                <div class="portion-note-item-card" data-portion-card-idx="${idx}">
                    <div class="portion-note-top-row">
                        <span class="portion-badge-pill">Porsi #${idx + 1}</span>
                        <input type="text" maxlength="100" class="portion-note-input" data-portion-idx="${idx}" value="${this._escapeHtml(pNote)}" placeholder="Catatan porsi #${idx + 1} (Opsional)">
                    </div>
                    ${pDrinkRowHtml}
                    ${pVarGroupsHtml}
                    <div class="note-preset-chips">${pChipsHtml}</div>
                </div>
            `;
        }).join('');

        const summaryPortionNow = this.getCartSummary();
        const matchedPortionIt = summaryPortionNow.orderItems.find(x => x.id === itemId);
        const livePortionSubtotalBarHtml = matchedPortionIt
            ? `<div class="item-live-subtotal-bar" data-item-id="${this._escapeHtml(itemId)}" style="font-size: 0.64rem; padding: 5px 8px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border-subtle); display: flex; align-items: center; gap: 5px; flex-wrap: wrap;">${this._buildItemLiveSubtotalTextHtml(matchedPortionIt)}</div>`
            : '';

        return `
            ${toggleHeaderHtml}
            <div class="portion-notes-list-wrap">
                <div class="portion-notes-helper">
                    <i class="fa-solid fa-circle-check text-emerald"></i> Atur pilihan level, saus, minuman, extra topping, atau catatan khusus untuk masing-masing porsi di bawah ini:
                </div>
                ${portionCardsHtml}
                ${livePortionSubtotalBarHtml}
            </div>
        `;
    },

    /**
     * Mengikat event interaktif pada kotak editor catatan, pilihan minuman paket, & multi-grup varian/topping
     */
    _bindItemNoteEditorBoxEvents: function(noteBoxEl, itemId, itemName, itemKat) {
        if (!noteBoxEl) return;
        const cartEntry = this._cart?.itemsMap?.[itemId];
        if (!cartEntry || cartEntry.qty <= 0) {
            noteBoxEl.classList.add('hidden');
            noteBoxEl.innerHTML = '';
            return;
        }

        noteBoxEl.classList.remove('hidden');
        noteBoxEl.innerHTML = this._buildItemNoteEditorInnerHTML(itemId, itemName, itemKat, cartEntry);

        const btnTogglePortion = noteBoxEl.querySelector('.btn-toggle-portion-notes');
        if (btnTogglePortion) {
            btnTogglePortion.addEventListener('click', () => {
                picuGetarSentuh(10);
                this._toggleCartItemPortionMode(itemId);
                this._bindItemNoteEditorBoxEvents(noteBoxEl, itemId, itemName, itemKat);
                this._syncRealtimePricingAfterOptionChange(itemId);
            });
        }

        // Event Pilihan Minuman Paket (Mode Seragam)
        noteBoxEl.querySelectorAll('.pkg-drink-choice-btn:not(.is-portion-drink)').forEach(btnDrk => {
            btnDrk.addEventListener('click', () => {
                picuGetarSentuh(10);
                const rawChoice = btnDrk.getAttribute('data-drink-raw') || '';
                this._setCartItemDrinkChoice(itemId, rawChoice);
                noteBoxEl.querySelectorAll('.pkg-drink-choice-btn:not(.is-portion-drink)').forEach(b => {
                    const isSel = (b.getAttribute('data-drink-raw') || '') === rawChoice;
                    b.classList.toggle('is-selected', isSel);
                    const ic = b.querySelector('i');
                    if (ic) ic.className = `fa-solid ${isSel ? 'fa-circle-check' : 'fa-mug-hot'}`;
                });
                this._syncRealtimePricingAfterOptionChange(itemId);
            });
        });

        // Event Pilihan Multi-Grup Varian & Extra Topping (Mode Seragam)
        noteBoxEl.querySelectorAll('.pkg-var-choice-btn:not(.is-portion-var)').forEach(btnVar => {
            btnVar.addEventListener('click', () => {
                picuGetarSentuh(10);
                const groupIdx = parseInt(btnVar.getAttribute('data-group-idx') || '0', 10);
                const rawChoice = btnVar.getAttribute('data-var-raw') || '';
                const entry = this._cart?.itemsMap?.[itemId];
                if (!entry) return;

                const effectiveVarDef = this._autoArticulateMissingVarFromItem(itemName, entry.var || '', entry.desc || '');
                const nextSelectedVar = this._toggleOrSelectVarGroupOption(
                    entry.selectedVar || '',
                    effectiveVarDef,
                    groupIdx,
                    rawChoice
                );
                this._setCartItemVarChoice(itemId, nextSelectedVar);

                const varGroups = this._parseVariantGroups(effectiveVarDef);
                const resolved = this._resolveSelectionsByGroup(nextSelectedVar, varGroups);
                const groupObj = varGroups.find(g => g.groupIndex === groupIdx);
                const groupContainer = noteBoxEl.querySelector(`.pkg-choice-group[data-var-group-idx="${groupIdx}"]`);

                if (groupContainer && groupObj) {
                    if (!groupObj.isMulti) {
                        const activeSingle = String(resolved[groupIdx] || '').toLowerCase();
                        groupContainer.querySelectorAll('.pkg-var-choice-btn:not(.is-portion-var)').forEach(b => {
                            const isSel = (b.getAttribute('data-var-raw') || '').toLowerCase() === activeSingle;
                            b.classList.toggle('is-selected', isSel);
                            const ic = b.querySelector('i');
                            const isSpicyGrp = groupContainer.getAttribute('data-is-spicy-group') === '1';
                            if (ic) ic.className = `fa-solid ${isSel ? 'fa-circle-check' : (isSpicyGrp ? 'fa-fire-flame-curved' : 'fa-utensils')}`;
                        });
                    } else {
                        const activeList = (resolved[groupIdx] || []).map(x => String(x).toLowerCase());
                        groupContainer.querySelectorAll('.pkg-var-choice-btn:not(.is-portion-var)').forEach(b => {
                            const isSel = activeList.includes((b.getAttribute('data-var-raw') || '').toLowerCase());
                            b.classList.toggle('is-selected', isSel);
                            const ic = b.querySelector('i');
                            if (ic) ic.className = `fa-solid ${isSel ? 'fa-square-check' : 'fa-plus'}`;
                        });
                    }
                }
                this._syncRealtimePricingAfterOptionChange(itemId);
            });
        });

        // Event Pilihan Minuman Paket (Mode Rinci Per Porsi)
        noteBoxEl.querySelectorAll('.pkg-drink-choice-btn.is-portion-drink').forEach(btnPDrk => {
            btnPDrk.addEventListener('click', () => {
                picuGetarSentuh(10);
                const pIdx = parseInt(btnPDrk.getAttribute('data-portion-idx'), 10);
                const rawChoice = btnPDrk.getAttribute('data-drink-raw') || '';
                this._setCartItemPortionDrink(itemId, pIdx, rawChoice);
                const cardEl = noteBoxEl.querySelector(`.portion-note-item-card[data-portion-card-idx="${pIdx}"]`);
                if (cardEl) {
                    cardEl.querySelectorAll('.pkg-drink-choice-btn.is-portion-drink').forEach(b => {
                        const isSel = (b.getAttribute('data-drink-raw') || '') === rawChoice;
                        b.classList.toggle('is-selected', isSel);
                        const ic = b.querySelector('i');
                        if (ic) ic.className = `fa-solid ${isSel ? 'fa-circle-check' : 'fa-mug-hot'}`;
                    });
                }
                this._syncRealtimePricingAfterOptionChange(itemId);
            });
        });

        // Event Pilihan Multi-Grup Varian & Extra Topping (Mode Rinci Per Porsi)
        noteBoxEl.querySelectorAll('.pkg-var-choice-btn.is-portion-var').forEach(btnPVar => {
            btnPVar.addEventListener('click', () => {
                picuGetarSentuh(10);
                const pIdx = parseInt(btnPVar.getAttribute('data-portion-idx'), 10);
                const groupIdx = parseInt(btnPVar.getAttribute('data-group-idx') || '0', 10);
                const rawChoice = btnPVar.getAttribute('data-var-raw') || '';
                const entry = this._cart?.itemsMap?.[itemId];
                if (!entry) return;

                const effectiveVarDef = this._autoArticulateMissingVarFromItem(itemName, entry.var || '', entry.desc || '');
                entry.portionVars = this._normalizePortionChoiceArray(entry.portionVars, entry.qty, entry.selectedVar || '');
                const curPVar = entry.portionVars[pIdx] !== undefined ? entry.portionVars[pIdx] : (entry.selectedVar || '');
                const nextPVar = this._toggleOrSelectVarGroupOption(
                    curPVar,
                    effectiveVarDef,
                    groupIdx,
                    rawChoice
                );
                this._setCartItemPortionVar(itemId, pIdx, nextPVar);

                const varGroups = this._parseVariantGroups(effectiveVarDef);
                const resolved = this._resolveSelectionsByGroup(nextPVar, varGroups);
                const groupObj = varGroups.find(g => g.groupIndex === groupIdx);
                const cardEl = noteBoxEl.querySelector(`.portion-note-item-card[data-portion-card-idx="${pIdx}"]`);
                const groupContainer = cardEl
                    ? cardEl.querySelector(`.pkg-choice-group[data-var-group-idx="${groupIdx}"]`)
                    : null;

                if (groupContainer && groupObj) {
                    if (!groupObj.isMulti) {
                        const activeSingle = String(resolved[groupIdx] || '').toLowerCase();
                        groupContainer.querySelectorAll('.pkg-var-choice-btn.is-portion-var').forEach(b => {
                            const isSel = (b.getAttribute('data-var-raw') || '').toLowerCase() === activeSingle;
                            b.classList.toggle('is-selected', isSel);
                            const ic = b.querySelector('i');
                            const isSpicyGrp = groupContainer.getAttribute('data-is-spicy-group') === '1';
                            if (ic) ic.className = `fa-solid ${isSel ? 'fa-circle-check' : (isSpicyGrp ? 'fa-fire-flame-curved' : 'fa-utensils')}`;
                        });
                    } else {
                        const activeList = (resolved[groupIdx] || []).map(x => String(x).toLowerCase());
                        groupContainer.querySelectorAll('.pkg-var-choice-btn.is-portion-var').forEach(b => {
                            const isSel = activeList.includes((b.getAttribute('data-var-raw') || '').toLowerCase());
                            b.classList.toggle('is-selected', isSel);
                            const ic = b.querySelector('i');
                            if (ic) ic.className = `fa-solid ${isSel ? 'fa-square-check' : 'fa-plus'}`;
                        });
                    }
                }
                this._syncRealtimePricingAfterOptionChange(itemId);
            });
        });

        // Event Mode Catatan Umum (1 input untuk semua)
        const singleInp = noteBoxEl.querySelector('.item-note-input');
        if (singleInp) {
            const syncSingleChips = (val) => {
                const activeTags = String(val || '').toLowerCase().split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
                noteBoxEl.querySelectorAll('.note-preset-btn:not(.is-portion-chip)').forEach(b => {
                    const t = (b.getAttribute('data-preset-tag') || '').toLowerCase();
                    b.classList.toggle('is-selected', activeTags.includes(t));
                });
            };

            singleInp.addEventListener('input', (e) => {
                const val = e.target.value;
                this._setCartItemNote(itemId, val);
                syncSingleChips(val);
            });

            noteBoxEl.querySelectorAll('.note-preset-btn:not(.is-portion-chip)').forEach(btnPreset => {
                btnPreset.addEventListener('click', () => {
                    picuGetarSentuh(8);
                    const tag = btnPreset.getAttribute('data-preset-tag') || '';
                    const updatedNote = this._togglePresetTagInNote(singleInp.value, tag);
                    singleInp.value = updatedNote;
                    this._setCartItemNote(itemId, updatedNote);
                    syncSingleChips(updatedNote);
                });
            });
        }

        // Event Mode Catatan Rinci Per Porsi (Porsi #1 s/d Porsi #N)
        noteBoxEl.querySelectorAll('.portion-note-input').forEach(pInp => {
            const pIdx = parseInt(pInp.getAttribute('data-portion-idx'), 10);
            const cardEl = noteBoxEl.querySelector(`.portion-note-item-card[data-portion-card-idx="${pIdx}"]`);

            const syncPortionChips = (val) => {
                if (!cardEl) return;
                const activeTags = String(val || '').toLowerCase().split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
                cardEl.querySelectorAll('.is-portion-chip').forEach(b => {
                    const t = (b.getAttribute('data-preset-tag') || '').toLowerCase();
                    b.classList.toggle('is-selected', activeTags.includes(t));
                });
            };

            pInp.addEventListener('input', (e) => {
                const val = e.target.value;
                this._setCartItemPortionNote(itemId, pIdx, val);
                syncPortionChips(val);
            });
        });

        noteBoxEl.querySelectorAll('.is-portion-chip').forEach(btnChip => {
            btnChip.addEventListener('click', () => {
                picuGetarSentuh(8);
                const pIdx = parseInt(btnChip.getAttribute('data-portion-idx'), 10);
                const tag = btnChip.getAttribute('data-preset-tag') || '';
                const pInp = noteBoxEl.querySelector(`.portion-note-input[data-portion-idx="${pIdx}"]`);
                const currentVal = pInp ? pInp.value : '';
                const updatedVal = this._togglePresetTagInNote(currentVal, tag);
                if (pInp) pInp.value = updatedVal;
                this._setCartItemPortionNote(itemId, pIdx, updatedVal);

                const cardEl = noteBoxEl.querySelector(`.portion-note-item-card[data-portion-card-idx="${pIdx}"]`);
                if (cardEl) {
                    const activeTags = updatedVal.toLowerCase().split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
                    cardEl.querySelectorAll('.is-portion-chip').forEach(b => {
                        const t = (b.getAttribute('data-preset-tag') || '').toLowerCase();
                        b.classList.toggle('is-selected', activeTags.includes(t));
                    });
                }
            });
        });
    },

    _buildItemLiveSubtotalTextHtml: function(matchedItem) {
        if (!matchedItem) return '';
        const addonPart = matchedItem.totalAddonPrice > 0
            ? ` <span class="text-amber">(termasuk +Opsi ${this._formatRp(matchedItem.totalAddonPrice)})</span>`
            : '';
        const formattedVar = this._formatSelectedVarForDisplay(matchedItem.selectedVar || '', matchedItem.var || '');
        const varPreview = (!matchedItem.usePortionNotes && formattedVar)
            ? `<span class="text-muted"> • ${this._escapeHtml(formattedVar)}</span>`
            : '';
        return `<i class="fa-solid fa-receipt text-emerald"></i> <span>Subtotal <b>${matchedItem.qty}x</b>: <b class="text-emerald font-tech">${this._formatRp(matchedItem.subtotal)}</b>${addonPart}${varPreview}</span>`;
    },

    _syncRealtimePricingAfterOptionChange: function(itemId) {
        this.updateFloatingCartBarUI();
        const summary = this.getCartSummary();

        if (itemId) {
            const matchedItem = summary.orderItems.find(x => x.id === itemId);
            if (matchedItem) {
                document.querySelectorAll(`.item-live-subtotal-bar[data-item-id="${itemId}"]`).forEach(barEl => {
                    barEl.innerHTML = this._buildItemLiveSubtotalTextHtml(matchedItem);
                });
            }
        }

        if (this._activeCheckoutState) {
            this._activeCheckoutState.summary = summary;
            this._activeCheckoutState.totalValue = summary.totalValue;
            this._activeCheckoutState.isAutoFullPayment = this._activeCheckoutState.wajibDp && (summary.totalValue <= this._activeCheckoutState.dpMin);

            const totalValEl = document.getElementById('japarCheckoutTotalValue');
            if (totalValEl) totalValEl.textContent = this._formatRp(summary.totalValue);

            if (itemId) {
                const matchedItem = summary.orderItems.find(x => x.id === itemId);
                const metaEl = document.querySelector(`.checkout-item-price-meta[data-item-id="${itemId}"]`);
                if (matchedItem && metaEl) {
                    const origMarkup = matchedItem.originalPrice > matchedItem.basePrice
                        ? `<span style="text-decoration: line-through; color: var(--text-subtle); margin-left: 4px;">${this._formatRp(matchedItem.originalPrice)}</span>`
                        : '';
                    const addonMarkup = matchedItem.totalAddonPrice > 0
                        ? ` <span class="text-amber">(+Opsi ${this._formatRp(matchedItem.totalAddonPrice)})</span>`
                        : '';
                    metaEl.innerHTML = `${this._formatRp(matchedItem.basePrice)}${origMarkup} / porsi${addonMarkup} • Subtotal: <b class="text-emerald">${this._formatRp(matchedItem.subtotal)}</b>`;
                }
            }

            this._updatePaymentBreakdownAndChannelsUI();
            this._updateLiveWaReceiptPreview();
        }
    },

    _getUserRefCoord: function() {
        const coord = getKoordinatPelangganAktif();
        if (coord && !isNaN(coord.lat) && !isNaN(coord.lng)) {
            return { lat: coord.lat, lng: coord.lng };
        }
        return { lat: -7.768049, lng: 112.196514 };
    },

    _getPublicNodesList: function() {
        if (Array.isArray(JAPAR_PUBLIC_NODES) && JAPAR_PUBLIC_NODES.length > 0) {
            return JAPAR_PUBLIC_NODES;
        }
        return [
            {
                id: 'N1',
                projectId: (firebaseConfig && firebaseConfig.projectId) ? firebaseConfig.projectId : 'japar-b1c5d',
                databaseURL: (firebaseConfig && firebaseConfig.databaseURL) ? firebaseConfig.databaseURL : 'https://japar-b1c5d-default-rtdb.asia-southeast1.firebasedatabase.app',
                apiKey: (firebaseConfig && firebaseConfig.apiKey) ? firebaseConfig.apiKey : ''
            },
            {
                id: 'N2',
                projectId: 'japar-2',
                databaseURL: 'https://japar-2-default-rtdb.asia-southeast1.firebasedatabase.app',
                apiKey: ''
            }
        ];
    },

    _readCachedNodesIndex: function() {
        const defaultNodesCache = {
            N1: { etag: '', ts: 0, data: {} },
            N2: { etag: '', ts: 0, data: {} }
        };
        try {
            const raw = localStorage.getItem(OPEN_INDEX_NODES_CACHE_KEY);
            if (!raw) return defaultNodesCache;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return defaultNodesCache;
            for (const node of this._getPublicNodesList()) {
                const nid = node.id;
                const entry = parsed[nid];
                if (entry && typeof entry === 'object') {
                    defaultNodesCache[nid] = {
                        etag: String(entry.etag || ''),
                        ts: Number(entry.ts || 0),
                        data: (entry.data && typeof entry.data === 'object') ? entry.data : {}
                    };
                }
            }
            return defaultNodesCache;
        } catch (e) {
            return defaultNodesCache;
        }
    },

    _saveCachedNodesIndex: function(nodesCacheObj) {
        const now = Date.now();
        this._lastNetworkFetchTs = now;
        try {
            localStorage.setItem(OPEN_INDEX_NODES_CACHE_KEY, JSON.stringify(nodesCacheObj || {}));
        } catch (e) {}
    },

    _mergeNodesOpenIndexMap: function(nodesCacheObj) {
        const merged = {};
        const cache = nodesCacheObj || {};
        for (const node of this._getPublicNodesList()) {
            const nodeId = node.id;
            const nodeEntry = cache[nodeId];
            const nodeData = (nodeEntry && nodeEntry.data && typeof nodeEntry.data === 'object') ? nodeEntry.data : {};
            const normalizedForNode = {};
            for (const [uid, meta] of Object.entries(nodeData)) {
                if (!meta || typeof meta !== 'object') continue;
                normalizedForNode[uid] = Object.assign({}, meta, {
                    nd: (meta.nd === 'N1' || meta.nd === 'N2') ? meta.nd : nodeId
                });
            }
            for (const [uid, candidateMeta] of Object.entries(normalizedForNode)) {
                if (!merged[uid]) {
                    merged[uid] = candidateMeta;
                } else {
                    const existingV = Number(merged[uid].v || 0);
                    const candidateV = Number(candidateMeta.v || 0);
                    if (candidateV >= existingV) {
                        merged[uid] = candidateMeta;
                    }
                }
            }
        }
        return merged;
    },

    _readCachedOpenIndex: function() {
        try {
            const nodesCache = this._readCachedNodesIndex();
            const mergedFromNodes = this._mergeNodesOpenIndexMap(nodesCache);
            const maxTs = Math.max(Number(nodesCache.N1?.ts || 0), Number(nodesCache.N2?.ts || 0));
            if (Object.keys(mergedFromNodes).length > 0 || maxTs > 0) {
                return {
                    timestamp: maxTs || Date.now(),
                    data: mergedFromNodes
                };
            }
            const raw = localStorage.getItem(OPEN_INDEX_CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || !parsed.timestamp || !parsed.data) return null;
            return {
                timestamp: Number(parsed.timestamp),
                data: parsed.data
            };
        } catch (e) {
            return null;
        }
    },

    _saveCachedOpenIndex: function(rawMap) {
        const now = Date.now();
        this._lastNetworkFetchTs = now;
        try {
            localStorage.setItem(OPEN_INDEX_CACHE_KEY, JSON.stringify({
                timestamp: now,
                data: rawMap || {}
            }));
        } catch (e) {}
    },

    loadCatalogIndex: async function(forceRefresh = false, showManualToast = false) {
        if (this._isLoadingIndex) return;

        const now = Date.now();
        const nodesCache = this._readCachedNodesIndex();
        const cachedMergedMap = this._mergeNodesOpenIndexMap(nodesCache);
        const latestCachedTs = Math.max(Number(nodesCache.N1?.ts || 0), Number(nodesCache.N2?.ts || 0));

        if (Object.keys(this._rawOpenIndexMap).length === 0) {
            if (Object.keys(cachedMergedMap).length > 0) {
                this._rawOpenIndexMap = cachedMergedMap;
                if (!this._lastNetworkFetchTs && latestCachedTs > 0) {
                    this._lastNetworkFetchTs = latestCachedTs;
                }
                this.recalculateDistancesAndRender();
            } else {
                const legacyCached = this._readCachedOpenIndex();
                if (legacyCached && legacyCached.data && Object.keys(legacyCached.data).length > 0) {
                    this._rawOpenIndexMap = legacyCached.data;
                    if (!this._lastNetworkFetchTs && legacyCached.timestamp) {
                        this._lastNetworkFetchTs = Number(legacyCached.timestamp);
                    }
                    this.recalculateDistancesAndRender();
                }
            }
        }

        if (!forceRefresh && this._lastNetworkFetchTs > 0 && (now - this._lastNetworkFetchTs) < REVALIDATE_COOLDOWN_MS && Object.keys(this._rawOpenIndexMap).length > 0) {
            this.recalculateDistancesAndRender();
            return;
        }

        this._isLoadingIndex = true;
        const countTextEl = document.getElementById('umkmLiveCountText');
        if (countTextEl && Object.keys(this._rawOpenIndexMap).length === 0) {
            countTextEl.textContent = 'Memuat...';
        }

        try {
            const publicNodes = this._getPublicNodesList();
            const fetchPromises = publicNodes.map(async (node) => {
                const nodeId = node.id;
                const rtdbBase = String(node.databaseURL || '').replace(/\/+$/, '');
                const cachedNode = nodesCache[nodeId] || { etag: '', ts: 0, data: {} };
                const reqHeaders = { 'X-Firebase-ETag': 'true' };
                if (cachedNode.etag) {
                    reqHeaders['If-None-Match'] = cachedNode.etag;
                }

                const queryUrl = `${rtdbBase}/merchants_index.json?orderBy="o"&equalTo=true`;
                let res = await fetch(queryUrl, {
                    method: 'GET',
                    headers: reqHeaders,
                    cache: 'no-store'
                });

                if (res.status === 304) {
                    nodesCache[nodeId] = {
                        etag: cachedNode.etag,
                        ts: Date.now(),
                        data: (cachedNode.data && typeof cachedNode.data === 'object') ? cachedNode.data : {}
                    };
                    return { nodeId, status: 304 };
                }

                if (!res.ok) {
                    res = await fetch(`${rtdbBase}/merchants_index.json`, {
                        method: 'GET',
                        headers: reqHeaders,
                        cache: 'no-store'
                    });
                    if (res.status === 304) {
                        nodesCache[nodeId] = {
                            etag: cachedNode.etag,
                            ts: Date.now(),
                            data: (cachedNode.data && typeof cachedNode.data === 'object') ? cachedNode.data : {}
                        };
                        return { nodeId, status: 304 };
                    }
                }

                if (res.status === 200 || res.ok) {
                    const newEtag = res.headers.get('ETag') || res.headers.get('etag') || cachedNode.etag || '';
                    const rawData = await res.json().catch(() => ({}));
                    const normalizedNodeData = {};
                    if (rawData && typeof rawData === 'object') {
                        for (const [uid, meta] of Object.entries(rawData)) {
                            if (!meta || typeof meta !== 'object') continue;
                            if (Boolean(meta.o) !== true) continue;
                            normalizedNodeData[uid] = Object.assign({}, meta, {
                                nd: meta.nd || nodeId
                            });
                        }
                    }
                    nodesCache[nodeId] = {
                        etag: newEtag,
                        ts: Date.now(),
                        data: normalizedNodeData
                    };
                    return { nodeId, status: 200 };
                }

                throw new Error(`HTTP ${res.status} on node ${nodeId}`);
            });

            const results = await Promise.allSettled(fetchPromises);
            const anySucceeded = results.some(r => r.status === 'fulfilled');

            if (anySucceeded) {
                this._saveCachedNodesIndex(nodesCache);
                this._rawOpenIndexMap = this._mergeNodesOpenIndexMap(nodesCache);
                this._saveCachedOpenIndex(this._rawOpenIndexMap);
                if (showManualToast) {
                    this.showNotice('Daftar tempat usaha dan menu telah diperbarui ke kondisi terbaru.', 'KATALOG DIPERBARUI');
                }
            }
        } catch (err) {
            if (Object.keys(cachedMergedMap).length > 0) {
                this._rawOpenIndexMap = cachedMergedMap;
            }
        } finally {
            this._isLoadingIndex = false;
            this.recalculateDistancesAndRender();
        }
    },

    recalculateDistancesAndRender: function() {
        const refCoord = this._getUserRefCoord();
        const pareCenter = { lat: -7.768049, lng: 112.196514 };
        let userLat = parseFloat(refCoord.lat);
        let userLng = parseFloat(refCoord.lng);
        if (isNaN(userLat) || isNaN(userLng)) {
            userLat = pareCenter.lat;
            userLng = pareCenter.lng;
        }

        const distFromPareCenter = hitungJarakHaversineKm(userLat, userLng, pareCenter.lat, pareCenter.lng);
        const anchorLat = distFromPareCenter > MAX_RADIUS_KM ? pareCenter.lat : userLat;
        const anchorLng = distFromPareCenter > MAX_RADIUS_KM ? pareCenter.lng : userLng;

        const rawMap = this._rawOpenIndexMap || {};
        const openWithinRadius = [];
        const nowDate = new Date();

        for (const [uid, meta] of Object.entries(rawMap)) {
            if (!meta || typeof meta !== 'object' || !meta.n) continue;
            if (Boolean(meta.o) !== true) continue;

            // Fallback aman untuk field opsional Diet Byte RTDB (dsc: 0, dp: false, dm: 'MAX_BEST', as: false, hd: '1,2,3,4,5,6,0')
            const rawH = String(meta.h || '08:00-21:00');
            const rawHd = String(meta.hd || '1,2,3,4,5,6,0');
            const isAutoSchedule = meta.as === true;
            const parsedH = uraiJamDanHariDariFieldH(rawH, rawHd);
            if (isAutoSchedule && !cekDalamJamOperasionalPublik(rawH, nowDate, rawHd)) {
                continue;
            }

            const mLat = parseFloat(String(meta.lat).replace(/,/g, '.'));
            const mLng = parseFloat(String(meta.lng).replace(/,/g, '.'));
            if (isNaN(mLat) || isNaN(mLng)) continue;

            let distKm = hitungJarakHaversineKm(anchorLat, anchorLng, mLat, mLng);
            if (isNaN(distKm) || distKm > MAX_RADIUS_KM) continue;

            const rawCatInput = String(meta.c || 'HIDANGAN_UTAMA').trim().toUpperCase();
            const rawCat = ALLOWED_CULINARY_CATEGORIES.has(rawCatInput) ? rawCatInput : 'HIDANGAN_UTAMA';

            let srvCode = String(meta.srv || '110');
            const canDineIn = srvCode.length >= 1 ? srvCode[0] !== '0' : true;
            const canTakeaway = srvCode.length >= 2 ? srvCode[1] !== '0' : true;
            const canDelivery = srvCode.length >= 3 ? srvCode[2] === '1' : false;
            let srvMenuFlags = srvCode.length > 3 ? srvCode.substring(3) : '';
            const discountMode = ['MAX_BEST', 'ITEM_OVERRIDE', 'STACK_ADD'].includes(meta.dm) ? meta.dm : 'MAX_BEST';
            const dscVal = Math.min(99, Math.max(0, Number(meta.dsc !== undefined ? meta.dsc : 0) || 0));
            const dpVal = meta.dp === true;
            const nodeId = (meta.nd === 'N2' || meta.nd === 'N1') ? meta.nd : 'N1';

            let combinedKw = String(meta.kw || '').toLowerCase();
            let resolvedFullAddr = String(meta.addr || meta.n || '').substring(0, 120);
            try {
                const cachedDoc = this._memoryMenuCache[uid] || JSON.parse(localStorage.getItem(MENU_DOC_STORAGE_PREFIX + uid) || 'null');
                if (cachedDoc && typeof cachedDoc === 'object') {
                    if (cachedDoc.profile && cachedDoc.profile.alamat) {
                        resolvedFullAddr = String(cachedDoc.profile.alamat).trim().substring(0, 120);
                    }
                    if (Array.isArray(cachedDoc.items)) {
                        const activeItems = cachedDoc.items.filter(it => it && it.s !== false);
                        const localWords = activeItems
                            .map(it => `${it.n || ''} ${it.kat || ''} ${it.desc || ''} ${it.drk || ''}`)
                            .join(' ')
                            .toLowerCase();
                        combinedKw = `${combinedKw} ${localWords}`.trim();
                        const dynFlags = this._computeDynamicMenuFlagsFromItems(activeItems, rawCat);
                        if (dynFlags) {
                            srvMenuFlags = dynFlags;
                            srvCode = `${canDineIn ? '1' : '0'}${canTakeaway ? '1' : '0'}${canDelivery ? '1' : '0'}${dynFlags}`;
                        }
                    }
                }
            } catch (eKw) {}

            const cleanCat = this._normalizeStoreCategory(rawCat, srvMenuFlags, `${meta.n || ''} ${combinedKw}`);

            openWithinRadius.push({
                uid,
                nd: nodeId,
                n: String(meta.n || 'Resto Kuliner').substring(0, 60),
                rawCat,
                c: cleanCat,
                lat: mLat,
                lng: mLng,
                gh: String(meta.gh || ''),
                o: Boolean(meta.o),
                h: parsedH.jamClean,
                hd: rawHd,
                as: isAutoSchedule,
                pr: String(meta.pr || '').substring(0, 60),
                img: bersihkanPublicIdCloudinary(meta.img || ''),
                v: Number(meta.v || 0),
                addr: resolvedFullAddr,
                dsc: dscVal,
                dp: dpVal,
                srv: srvCode,
                srvMenuFlags,
                kw: combinedKw,
                canDineIn,
                canTakeaway,
                canDelivery,
                dm: discountMode,
                distKm: Number(distKm.toFixed(2))
            });
        }

        openWithinRadius.sort((a, b) => a.distKm - b.distKm);
        this._merchantsList = openWithinRadius;

        this.renderMerchantListUI();
        this.updateFloatingCartBarUI();
    },

    /**
     * Menghitung 5 karakter flag menu (`UMCRP`) dari daftar item aktif:
     * `[U][M][C][R][P]`
     */
    _computeDynamicMenuFlagsFromItems: function(activeItems = [], fallbackRawCat = 'HIDANGAN_UTAMA') {
        if (!Array.isArray(activeItems) || activeItems.length === 0) return '';
        const normFallback = this._normalizeStoreCategory(fallbackRawCat);
        let hasU = normFallback === 'HIDANGAN_UTAMA';
        let hasM = normFallback === 'MINUMAN_KOPI';
        let hasC = normFallback === 'CAMILAN_JAJANAN';
        let hasR = normFallback === 'ROTI_OLEH_OLEH';
        let hasP = normFallback === 'PAKET_HEMAT';

        activeItems.forEach(it => {
            if (!it || it.s === false) return;
            const kat = String(it.kat || '').toLowerCase();
            const text = `${it.kat || ''} ${it.n || ''}`.toLowerCase();
            if (
                kat === 'paket hemat & combo' ||
                kat === 'paket & spesial' ||
                kat === 'paket hemat' ||
                (Boolean(it.desc) && Boolean(it.drk)) ||
                /\b(paket|combo|hemat|nasi\s*kotak|tumpeng|hampers)\b/i.test(text)
            ) {
                hasP = true;
            }
            if (
                kat === 'hidangan utama' ||
                kat === 'makanan utama' ||
                /\b(hidangan\s*utama|makanan\s*utama|nasi|mie|bakso|soto|rawon|ayam|bebek|ikan|penyet|sate|geprek|pecel|lalapan|lontong|rendang|gulai|sop)\b/i.test(text)
            ) {
                hasU = true;
            }
            if (
                kat === 'minuman & kopi' ||
                kat === 'minuman' ||
                /\b(minuman|kopi|coffee|es\s|teh|jeruk|jus|juice|susu|coklat|boba|matcha|wedang|latte|americano|cappuccino|thai\s*tea|lemon\s*tea|float)\b/i.test(text)
            ) {
                hasM = true;
            }
            if (
                kat === 'camilan & jajanan' ||
                kat === 'camilan' ||
                kat === 'jajanan & kebab' ||
                /\b(kebab|burger|martabak|jajan|camilan|snack|gorengan|tahu|tempe|mendoan|kentang|pentol|cilok|sempol|dimsum|takoyaki|seblak|pisang\s*goreng|cireng|sosis|risol|lumpia|batagor|siomay)\b/i.test(text)
            ) {
                hasC = true;
            }
            if (
                kat === 'roti, kue & oleh-oleh' ||
                kat === 'donat & roti' ||
                /\b(donat|donut|roti|bakery|kue|bolu|brownies|pastry|croissant|bomboloni|cromboloni|waffle|pancake|pukis|terang\s*bulan|tart|cake|dessert|oleh-oleh|keripik|kripik)\b/i.test(text)
            ) {
                hasR = true;
            }
        });

        return `${hasU ? 'U' : '-'}${hasM ? 'M' : '-'}${hasC ? 'C' : '-'}${hasR ? 'R' : '-'}${hasP ? 'P' : '-'}`;
    },

    _syncMerchantFlagsFromLoadedDoc: function(uid, loadedDoc) {
        if (!uid || !loadedDoc) return;
        const targetMerchant = (this._merchantsList || []).find(m => m && m.uid === uid);
        const fullAlamat = String(loadedDoc.profile?.alamat || '').trim().substring(0, 120);
        const resolvedNd = loadedDoc.nd || loadedDoc.profile?.nodeId || targetMerchant?.nd || this._activeMerchantMeta?.nd || 'N1';

        if (fullAlamat) {
            if (this._rawOpenIndexMap && this._rawOpenIndexMap[uid]) {
                this._rawOpenIndexMap[uid].addr = fullAlamat;
            }
            if (targetMerchant) {
                targetMerchant.addr = fullAlamat;
                targetMerchant.nd = resolvedNd;
            }
            if (this._activeMerchantMeta && this._activeMerchantMeta.uid === uid) {
                this._activeMerchantMeta.addr = fullAlamat;
                this._activeMerchantMeta.nd = resolvedNd;
                const storeAddrEl = document.getElementById('storePageAddress');
                if (storeAddrEl) storeAddrEl.textContent = fullAlamat;
            }
            if (this._cart && this._cart.uidMerchant === uid) {
                this._cart.storeAddress = fullAlamat;
                this._persistCart();
                const checkoutAddrEl = document.getElementById('japarCheckoutStoreAddress');
                if (checkoutAddrEl) checkoutAddrEl.textContent = fullAlamat;
                if (this._activeCheckoutState && this._activeCheckoutState.summary && this._activeCheckoutState.summary.uidMerchant === uid) {
                    this._activeCheckoutState.summary.storeAddress = fullAlamat;
                }
            }
        }

        if (!Array.isArray(loadedDoc.items)) return;
        const activeItems = loadedDoc.items.filter(it => it && it.s !== false);
        if (activeItems.length === 0) return;

        const dynFlags = this._computeDynamicMenuFlagsFromItems(activeItems, loadedDoc.profile?.kategori || targetMerchant?.rawCat || 'HIDANGAN_UTAMA');
        const localWords = activeItems
            .map(it => `${it.n || ''} ${it.kat || ''} ${it.desc || ''} ${it.drk || ''}`)
            .join(' ')
            .toLowerCase();

        if (targetMerchant) {
            if (dynFlags) {
                targetMerchant.srvMenuFlags = dynFlags;
                const prefix3 = String(targetMerchant.srv || '110').substring(0, 3).padEnd(3, '0');
                targetMerchant.srv = `${prefix3}${dynFlags}`;
            }
            targetMerchant.kw = `${targetMerchant.kw || ''} ${localWords}`.trim();
            targetMerchant.c = this._normalizeStoreCategory(
                loadedDoc.profile?.kategori || targetMerchant.rawCat || targetMerchant.c,
                targetMerchant.srvMenuFlags,
                `${targetMerchant.n || ''} ${targetMerchant.kw}`
            );
        }
        if (this._activeMerchantMeta && this._activeMerchantMeta.uid === uid) {
            if (dynFlags) {
                this._activeMerchantMeta.srvMenuFlags = dynFlags;
                const prefix3 = String(this._activeMerchantMeta.srv || '110').substring(0, 3).padEnd(3, '0');
                this._activeMerchantMeta.srv = `${prefix3}${dynFlags}`;
            }
            this._activeMerchantMeta.kw = `${this._activeMerchantMeta.kw || ''} ${localWords}`.trim();
            this._activeMerchantMeta.c = this._normalizeStoreCategory(
                loadedDoc.profile?.kategori || this._activeMerchantMeta.rawCat || this._activeMerchantMeta.c,
                this._activeMerchantMeta.srvMenuFlags,
                `${this._activeMerchantMeta.n || ''} ${this._activeMerchantMeta.kw}`
            );
        }
    },

    renderMerchantListUI: function() {
        const listContainer = document.getElementById('umkmMerchantsGrid');
        if (!listContainer) return;

        const q = this._searchQuery.trim().toLowerCase();
        const cat = this._activeCategory;
        const quickFilter = this._activeQuickFilter;
        const selectedRadius = Math.min(MAX_RADIUS_KM, Math.max(1.0, Number(this._selectedRadiusKm) || MAX_RADIUS_KM));

        const openOnlyList = (this._merchantsList || []).filter(m => m && m.o === true && m.distKm <= selectedRadius);

        const countTextEl = document.getElementById('umkmLiveCountText');
        if (countTextEl) {
            countTextEl.textContent = `${openOnlyList.length} Buka`;
        }

        const filtered = openOnlyList.filter(m => {
            const rawCat = String(m.rawCat || m.c || 'HIDANGAN_UTAMA').toUpperCase();
            const srvStr = String(m.srv || '');
            const flags = String(m.srvMenuFlags || (srvStr.length > 3 ? srvStr.substring(3) : ''));
            // Bedakan format srv 8 karakter baru (UMCRP) vs format legacy lama yang mengandung D,J,B,O atau M di indeks 0 flags
            const isNewSrvFormat = /^[UMCRP-]{4,5}$/.test(flags) && !/[DJBO]/.test(flags) && flags[0] !== 'M';
            const isLegacySrv8 = !isNewSrvFormat && (/[DJBO]/.test(flags) || flags[0] === 'M');

            const menuKw = String(m.kw || '').toLowerCase();
            const mCat = this._normalizeStoreCategory(m.c || rawCat, flags, `${m.n || ''} ${menuKw}`);
            const fullText = `${m.n || ''} ${m.pr || ''} ${m.addr || ''} ${menuKw}`.toLowerCase();

            const hasPaketHemat =
                mCat === 'PAKET_HEMAT' ||
                flags.includes('P') ||
                /\b(paket|combo|hemat|nasi\s*kotak|tumpeng|hampers)\b/i.test(menuKw);

            const hasHidanganUtama =
                mCat === 'HIDANGAN_UTAMA' ||
                flags.includes('U') ||
                (flags.includes('M') && (isLegacySrv8 || rawCat === 'KULINER')) ||
                /\b(nasi|mie|bakso|soto|rawon|ayam|bebek|ikan|penyet|sate|geprek|pecel|lalapan|lontong|rendang|gulai|sop)\b/i.test(menuKw);

            const hasMinumanKopi =
                mCat === 'MINUMAN_KOPI' ||
                (flags.includes('M') && !isLegacySrv8 && !['KULINER'].includes(rawCat)) ||
                flags.includes('D') ||
                /\b(kopi|coffee|es\s|teh|jeruk|jus|juice|susu|coklat|boba|matcha|wedang|latte|americano|cappuccino|thai\s*tea|lemon\s*tea|float)\b/i.test(menuKw);

            const hasCamilanJajanan =
                mCat === 'CAMILAN_JAJANAN' ||
                flags.includes('C') ||
                flags.includes('J') ||
                /\b(kebab|burger|martabak|jajan|camilan|snack|gorengan|tahu|tempe|mendoan|kentang|pentol|cilok|sempol|dimsum|takoyaki|seblak|pisang\s*goreng|cireng|sosis|risol|lumpia|batagor|siomay)\b/i.test(menuKw);

            const hasRotiOlehOleh =
                mCat === 'ROTI_OLEH_OLEH' ||
                flags.includes('R') ||
                flags.includes('B') ||
                flags.includes('O') ||
                /\b(donat|donut|roti|bakery|kue|bolu|brownies|pastry|croissant|bomboloni|cromboloni|waffle|pancake|pukis|terang\s*bulan|tart|cake|dessert|oleh-oleh|hampers|keripik|kripik)\b/i.test(menuKw);

            let matchCat = true;
            if (cat === 'PAKET_HEMAT') {
                matchCat = hasPaketHemat;
            } else if (cat === 'HIDANGAN_UTAMA' || cat === 'KULINER') {
                matchCat = hasHidanganUtama;
            } else if (cat === 'MINUMAN_KOPI') {
                matchCat = hasMinumanKopi;
            } else if (cat === 'CAMILAN_JAJANAN') {
                matchCat = hasCamilanJajanan;
            } else if (cat === 'ROTI_OLEH_OLEH' || cat === 'OLEH_OLEH') {
                matchCat = hasRotiOlehOleh;
            } else if (cat === 'KOPI_JAJANAN') {
                matchCat = hasMinumanKopi || hasCamilanJajanan;
            }

            const hasPromo = Boolean((m.pr && m.pr.trim()) || Number(m.dsc) > 0);
            const matchQuick =
                quickFilter === 'ALL' ||
                (quickFilter === 'DELIVERY' && m.canDelivery === true) ||
                (quickFilter === 'DINE_IN' && m.canDineIn !== false) ||
                (quickFilter === 'TAKEAWAY' && m.canTakeaway !== false) ||
                (quickFilter === 'NO_DP' && m.dp !== true) ||
                (quickFilter === 'PROMO' && hasPromo);

            const matchQ = !q || fullText.includes(q);
            return matchCat && matchQuick && matchQ;
        });

        listContainer.innerHTML = '';

        if (filtered.length === 0) {
            const isAllEmpty = openOnlyList.length === 0;
            listContainer.innerHTML = `
                <div class="glass-panel text-center" style="padding: 32px 18px; border-radius: 18px;">
                    <div class="empty-state-icon-circle">
                        <i class="fa-solid fa-utensils"></i>
                    </div>
                    <div class="font-tech text-main font-bold" style="font-size: 0.92rem;">${isAllEmpty ? 'Belum Ada Tempat Makan yang Sedang Buka' : 'Tempat Makan atau Hidangan Tidak Ditemukan'}</div>
                    <p class="text-muted" style="font-size: 0.74rem; margin-top: 5px; line-height: 1.5; max-width: 340px; margin-left: auto; margin-right: auto;">
                        ${isAllEmpty
                            ? 'Saat ini belum ada resto atau tempat usaha kuliner yang sedang buka di sekitar lokasi Anda.'
                            : 'Coba pilih kategori lain atau gunakan kata kunci pencarian yang berbeda.'}
                    </p>
                </div>
            `;
            return;
        }

        const catLabelMap = {
            'HIDANGAN_UTAMA': 'Hidangan Utama',
            'MINUMAN_KOPI': 'Minuman & Kopi',
            'CAMILAN_JAJANAN': 'Camilan & Jajanan',
            'ROTI_OLEH_OLEH': 'Roti, Kue & Oleh-Oleh',
            'PAKET_HEMAT': 'Paket Hemat & Katering',
            'KULINER': 'Hidangan Utama',
            'KOPI_JAJANAN': 'Minuman & Kopi',
            'OLEH_OLEH': 'Roti, Kue & Oleh-Oleh'
        };

        filtered.forEach(m => {
            const card = document.createElement('article');
            card.className = 'umkm-store-card';
            const imgUrl = this._buildPhotoUrl(m.img, m.n, 400);
            const catLabel = catLabelMap[m.c] || 'Kuliner';
            const hasPromo = Boolean((m.pr && m.pr.trim()) || Number(m.dsc) > 0);
            const promoLabel = (m.pr && m.pr.trim()) ? m.pr : `Diskon Resto ${m.dsc}%`;
            const photoBadgeHtml = Number(m.dsc) > 0
                ? `<span class="store-photo-promo-tag">-${m.dsc}%</span>`
                : (hasPromo ? `<span class="store-photo-promo-tag">PROMO</span>` : '');

            const dpBadgeHtml = m.dp === true
                ? `<span class="japar-dp-badge is-require-dp"><i class="fa-solid fa-wallet"></i> Transfer / DP Awal</span>`
                : `<span class="japar-dp-badge is-no-dp"><i class="fa-solid fa-hand-holding-dollar"></i> Bayar di Tempat</span>`;

            const outletTypeBadge = m.canDineIn === false
                ? `<span class="store-service-badge"><i class="fa-solid fa-house-chimney-user"></i> Outlet Rumahan</span>`
                : `<span class="store-service-badge" style="background: var(--go-green-soft); color: var(--go-green);"><i class="fa-solid fa-utensils"></i> Bisa Dine-In</span>`;

            const flags = String(m.srvMenuFlags || '');
            const hasPkgFlag = m.c === 'PAKET_HEMAT' || flags.includes('P') || /\b(paket|combo|hemat)\b/i.test(m.kw || '');
            const pkgStorePill = hasPkgFlag
                ? `<span class="store-service-badge" style="background: var(--go-amber-soft); color: var(--go-amber);"><i class="fa-solid fa-box-open"></i> Ada Paket Hemat</span>`
                : '';

            const storeGmapsUrl = this._buildStoreGmapsUrl(m.lat, m.lng, m.n);

            card.innerHTML = `
                <div style="display: flex; align-items: flex-start; gap: 11px; width: 100%;">
                    <div class="umkm-photo-box" oncontextmenu="return false;">
                        ${photoBadgeHtml}
                        <img src="${imgUrl}" referrerpolicy="no-referrer" loading="lazy" alt="Resto" draggable="false" oncontextmenu="return false;">
                        <div class="image-protect-layer" oncontextmenu="return false;"></div>
                    </div>
                    <div style="flex: 1; min-width: 0;">
                        <div style="display: flex; align-items: center; justify-content: space-between; gap: 5px; flex-wrap: wrap;">
                            <div style="display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
                                <span class="store-cat-pill">${catLabel}</span>
                                ${outletTypeBadge}
                                ${pkgStorePill}
                            </div>
                            <span class="store-open-status-pill">● Buka</span>
                        </div>
                        <h3 class="font-tech font-bold text-main store-card-title" style="font-size: 0.94rem; margin-top: 4px; line-height: 1.26; word-break: break-word;"></h3>
                        <div class="text-muted store-card-addr" style="font-size: 0.7rem; margin-top: 2px; line-height: 1.35; word-break: break-word;"></div>
                        <div style="display: flex; align-items: center; gap: 8px; margin-top: 5px; font-size: 0.68rem; flex-wrap: wrap;">
                            <span class="text-muted"><i class="fa-regular fa-clock"></i> ${this._escapeHtml(m.h || '08:00-21:00')}</span>
                            <span class="text-emerald font-bold"><i class="fa-solid fa-location-dot"></i> ${m.distKm} km</span>
                        </div>
                        ${hasPromo ? `<div class="umkm-promo-pill"><i class="fa-solid fa-tag"></i> <span class="store-card-promo"></span></div>` : ''}
                    </div>
                </div>
                <div class="store-card-cta-footer">
                    <div>${dpBadgeHtml}</div>
                    <div class="store-card-cta-right-group">
                        <a href="${this._escapeHtml(storeGmapsUrl)}" target="_blank" rel="noopener noreferrer" class="store-card-gmaps-btn" title="Buka Titik Lokasi Warung di Google Maps">
                            <i class="fa-solid fa-map-location-dot"></i>
                            <span>Maps Lokasi</span>
                        </a>
                        <span class="store-open-menu-pill">Lihat Menu <i class="fa-solid fa-chevron-right" style="font-size: 0.62rem;"></i></span>
                    </div>
                </div>
            `;

            const titleEl = card.querySelector('.store-card-title');
            if (titleEl) titleEl.textContent = m.n;
            const addrEl = card.querySelector('.store-card-addr');
            if (addrEl) addrEl.textContent = m.addr || m.n;
            const promoEl = card.querySelector('.store-card-promo');
            if (promoEl) promoEl.textContent = promoLabel;

            const btnGmapsCard = card.querySelector('.store-card-gmaps-btn');
            if (btnGmapsCard) {
                btnGmapsCard.addEventListener('click', (e) => {
                    e.stopPropagation();
                    picuGetarSentuh(10);
                });
            }

            card.addEventListener('click', () => {
                picuGetarSentuh(14);
                this.openStorePage(m);
            });

            listContainer.appendChild(card);
        });
    },

    _fetchMerchantDocFromFirestore: async function(uid, expectedVersion, preferredNodeId) {
        if (!uid) return null;

        if (this._inflightMenuFetchMap[uid]) {
            return this._inflightMenuFetchMap[uid];
        }

        const fetchPromise = (async () => {
            try {
                const publicNodes = this._getPublicNodesList();
                const hintNodeId = preferredNodeId ||
                    (this._activeMerchantMeta && this._activeMerchantMeta.uid === uid ? this._activeMerchantMeta.nd : null) ||
                    (this._rawOpenIndexMap && this._rawOpenIndexMap[uid] ? this._rawOpenIndexMap[uid].nd : null) ||
                    'N1';
                const normHint = String(hintNodeId || 'N1').trim().toUpperCase() === 'N2' ? 'N2' : 'N1';

                const orderedNodes = [
                    ...publicNodes.filter(n => n.id === normHint),
                    ...publicNodes.filter(n => n.id !== normHint)
                ];

                for (const node of orderedNodes) {
                    const targetProjectId = node.projectId || (node.id === 'N2' ? 'japar-2' : 'japar-b1c5d');
                    const fsUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(targetProjectId)}/databases/(default)/documents/merchants/${encodeURIComponent(uid)}`;
                    try {
                        const res = await fetch(fsUrl, { method: 'GET', cache: 'no-store' });
                        if (!res.ok) continue;
                        const rawJson = await res.json().catch(() => null);
                        if (!rawJson || !rawJson.fields) continue;

                        const parsedDoc = FirestoreParser.parseFirestoreFields(rawJson.fields);
                        const resolvedVersion = Number(expectedVersion || parsedDoc.v || Date.now());
                        const resolvedNodeId = parsedDoc.profile?.nodeId || node.id || normHint;
                        const cleanDoc = {
                            uid,
                            nd: resolvedNodeId,
                            v: resolvedVersion,
                            profile: parsedDoc.profile || {},
                            items: Array.isArray(parsedDoc.items) ? parsedDoc.items : []
                        };

                        this._memoryMenuCache[uid] = cleanDoc;
                        try {
                            localStorage.setItem(MENU_DOC_STORAGE_PREFIX + uid, JSON.stringify(cleanDoc));
                        } catch (e) {}

                        return cleanDoc;
                    } catch (nodeFetchErr) {
                        // Fallback otomatis ke node pasangan jika gagal jaringan
                    }
                }

                return null;
            } finally {
                delete this._inflightMenuFetchMap[uid];
            }
        })();

        this._inflightMenuFetchMap[uid] = fetchPromise;
        return fetchPromise;
    },

    _getOrLoadMerchantDoc: async function(uid, expectedVersion = 0, preferredNodeId = null) {
        if (!uid) return null;

        const memDoc = this._memoryMenuCache[uid];
        if (memDoc && Array.isArray(memDoc.items)) {
            if (!expectedVersion || Number(memDoc.v) === Number(expectedVersion)) {
                this._syncMerchantFlagsFromLoadedDoc(uid, memDoc);
                return memDoc;
            }
        }

        const storageKey = MENU_DOC_STORAGE_PREFIX + uid;
        try {
            const rawLocal = localStorage.getItem(storageKey);
            if (rawLocal) {
                const parsedLocal = JSON.parse(rawLocal);
                if (
                    parsedLocal &&
                    Array.isArray(parsedLocal.items) &&
                    (!expectedVersion || Number(parsedLocal.v) === Number(expectedVersion))
                ) {
                    this._memoryMenuCache[uid] = parsedLocal;
                    this._syncMerchantFlagsFromLoadedDoc(uid, parsedLocal);
                    return parsedLocal;
                }
            }
        } catch (e) {}

        const resolvedPreferredNode = preferredNodeId ||
            (this._activeMerchantMeta && this._activeMerchantMeta.uid === uid ? this._activeMerchantMeta.nd : null) ||
            (this._rawOpenIndexMap && this._rawOpenIndexMap[uid] ? this._rawOpenIndexMap[uid].nd : null) ||
            'N1';

        const fetchedDoc = await this._fetchMerchantDocFromFirestore(uid, expectedVersion, resolvedPreferredNode);
        if (fetchedDoc) {
            this._syncMerchantFlagsFromLoadedDoc(uid, fetchedDoc);
        }
        return fetchedDoc;
    },

    openStorePage: async function(merchantMeta, pushRoute = true) {
        if (!merchantMeta || !merchantMeta.uid) return;
        this._activeMerchantMeta = merchantMeta;
        this._storeSearchQuery = '';
        this._storeSubCategory = 'ALL';

        const inpStoreSearch = document.getElementById('inputSearchMenuInStore');
        if (inpStoreSearch) inpStoreSearch.value = '';

        const catLabelMap = {
            'HIDANGAN_UTAMA': 'Hidangan Utama',
            'MINUMAN_KOPI': 'Minuman & Kopi',
            'CAMILAN_JAJANAN': 'Camilan & Jajanan',
            'ROTI_OLEH_OLEH': 'Roti, Kue & Oleh-Oleh',
            'PAKET_HEMAT': 'Paket Hemat & Katering',
            'KULINER': 'Hidangan Utama',
            'KOPI_JAJANAN': 'Minuman & Kopi',
            'OLEH_OLEH': 'Roti, Kue & Oleh-Oleh'
        };

        const coverImgEl = document.getElementById('storePageCoverImg');
        const catBadgeEl = document.getElementById('storePageCategoryBadge');
        const outletTypeBadgeEl = document.getElementById('storePageOutletTypeBadge');
        const dpBadgeEl = document.getElementById('storePageDpBadge');
        const titleEl = document.getElementById('storePageTitle');
        const addrEl = document.getElementById('storePageAddress');
        const hoursEl = document.getElementById('storePageHours');
        const distInfoEl = document.getElementById('storePageDistanceInfo');
        const btnGmapsRoute = document.getElementById('btnOpenStoreGmapsRoute');
        const btnHeroGmaps = document.getElementById('btnHeroStoreGmapsLink');
        const promoBannerEl = document.getElementById('storePagePromoBanner');
        const listEl = document.getElementById('storeMenuItemsContainer');

        if (coverImgEl) coverImgEl.src = this._buildPhotoUrl(merchantMeta.img, merchantMeta.n, 400);
        if (catBadgeEl) catBadgeEl.textContent = catLabelMap[merchantMeta.c] || 'Kuliner';
        if (titleEl) titleEl.textContent = merchantMeta.n;
        if (addrEl) addrEl.textContent = merchantMeta.addr || merchantMeta.n;
        if (hoursEl) hoursEl.textContent = merchantMeta.h || '08:00-21:00';
        if (distInfoEl) {
            distInfoEl.innerHTML = merchantMeta.distKm !== undefined
                ? `<i class="fa-solid fa-location-dot"></i> ~${merchantMeta.distKm} km`
                : '';
        }

        const gmapsUrl = this._buildStoreGmapsUrl(merchantMeta.lat, merchantMeta.lng, merchantMeta.n);
        if (btnGmapsRoute) btnGmapsRoute.href = gmapsUrl;
        if (btnHeroGmaps) btnHeroGmaps.href = gmapsUrl;

        if (outletTypeBadgeEl) {
            if (merchantMeta.canDineIn === false) {
                outletTypeBadgeEl.className = 'store-service-badge';
                outletTypeBadgeEl.innerHTML = '<i class="fa-solid fa-house-chimney-user"></i> Outlet Rumahan';
            } else {
                outletTypeBadgeEl.className = 'store-service-badge';
                outletTypeBadgeEl.style.background = 'var(--go-green-soft)';
                outletTypeBadgeEl.style.color = 'var(--go-green)';
                outletTypeBadgeEl.innerHTML = '<i class="fa-solid fa-utensils"></i> Bisa Makan di Tempat';
            }
        }

        if (dpBadgeEl) {
            if (merchantMeta.dp === true) {
                dpBadgeEl.className = 'japar-dp-badge is-require-dp';
                dpBadgeEl.innerHTML = '<i class="fa-solid fa-wallet"></i> Transfer / DP Awal';
            } else {
                dpBadgeEl.className = 'japar-dp-badge is-no-dp';
                dpBadgeEl.innerHTML = '<i class="fa-solid fa-hand-holding-dollar"></i> Bayar di Tempat';
            }
        }

        const hasPromo = Boolean((merchantMeta.pr && merchantMeta.pr.trim()) || Number(merchantMeta.dsc) > 0);
        if (promoBannerEl) {
            if (hasPromo) {
                promoBannerEl.classList.remove('hidden');
                promoBannerEl.innerHTML = `<i class="fa-solid fa-tag"></i> <span>${this._escapeHtml(merchantMeta.pr || `Diskon Resto ${merchantMeta.dsc}%`)}</span>`;
            } else {
                promoBannerEl.classList.add('hidden');
            }
        }

        if (pushRoute) {
            JaparPageRouter.navigateTo('store', { uid: merchantMeta.uid });
        }

        if (listEl) {
            listEl.innerHTML = `
                <div class="glass-panel text-center" style="padding: 26px 16px; border-radius: 16px;">
                    <i class="fa-solid fa-circle-notch fa-spin text-emerald" style="font-size: 1.35rem;"></i>
                    <div class="font-tech text-muted mt-2" style="font-size: 0.76rem;">Menyiapkan Daftar Hidangan Resto...</div>
                </div>
            `;
        }

        const loadedDoc = await this._getOrLoadMerchantDoc(merchantMeta.uid, merchantMeta.v, merchantMeta.nd);
        if (loadedDoc) {
            this._activeMerchantDoc = loadedDoc;
            this._syncMerchantFlagsFromLoadedDoc(merchantMeta.uid, loadedDoc);
            const fullAlamat = String(loadedDoc.profile?.alamat || '').trim().substring(0, 120);
            if (fullAlamat) {
                this._activeMerchantMeta.addr = fullAlamat;
                if (addrEl) addrEl.textContent = fullAlamat;
                if (this._cart && this._cart.uidMerchant === merchantMeta.uid) {
                    this._cart.storeAddress = fullAlamat;
                    this._persistCart();
                }
            }
            if (catBadgeEl && this._activeMerchantMeta) {
                catBadgeEl.textContent = catLabelMap[this._activeMerchantMeta.c] || 'Hidangan Utama';
            }
            this._syncStorePageReceiveModeUI(loadedDoc.profile || {});
            this._renderStoreSubcatChips();
            this._renderActiveStoreMenuItems();
        } else if (listEl) {
            listEl.innerHTML = `<div class="glass-panel text-center text-muted" style="padding: 22px; border-radius: 16px; font-size: 0.76rem;">Daftar hidangan sedang disiapkan oleh pengelola resto.</div>`;
        }
    },

    _syncStorePageReceiveModeUI: function(profileObj) {
        const p = profileObj || {};
        const kurirAktif = Boolean(p.kurirWarungAktif);
        const takeawayAktif = p.melayaniTakeaway !== undefined
            ? Boolean(p.melayaniTakeaway)
            : (this._activeMerchantMeta?.canTakeaway !== false);
        const dineInAktif = p.melayaniDineIn !== undefined
            ? Boolean(p.melayaniDineIn)
            : (this._activeMerchantMeta?.canDineIn !== false);
        const infoOngkir = String(p.infoOngkirWarung || 'Ongkir sesuai pengantaran kurir internal resto').trim();

        const outletBadgeEl = document.getElementById('storePageOutletTypeBadge');
        if (outletBadgeEl) {
            if (!dineInAktif) {
                outletBadgeEl.style.background = 'var(--go-amber-soft)';
                outletBadgeEl.style.color = 'var(--go-amber)';
                outletBadgeEl.innerHTML = '<i class="fa-solid fa-house-chimney-user"></i> Outlet Rumahan (Tanpa Makan di Tempat)';
            } else {
                outletBadgeEl.style.background = 'var(--go-green-soft)';
                outletBadgeEl.style.color = 'var(--go-green)';
                outletBadgeEl.innerHTML = '<i class="fa-solid fa-utensils"></i> Bisa Makan di Tempat';
            }
        }

        const btnDelivery = document.getElementById('btnStoreModeDelivery');
        const btnPickup = document.getElementById('btnStoreModePickup');
        const btnDineIn = document.getElementById('btnStoreModeDineIn');
        const noticeEl = document.getElementById('storeReceiveModeNotice');

        if (btnDelivery) {
            btnDelivery.disabled = !kurirAktif;
            btnDelivery.classList.toggle('hidden', false);
        }
        if (btnPickup) {
            btnPickup.disabled = !takeawayAktif;
            btnPickup.classList.toggle('hidden', !takeawayAktif && (kurirAktif || dineInAktif));
        }
        if (btnDineIn) {
            btnDineIn.disabled = !dineInAktif;
            btnDineIn.classList.toggle('hidden', !dineInAktif);
        }

        let currentMode = this._preferredReceiveMethod;
        if (currentMode === 'KURIR_WARUNG' && !kurirAktif) {
            currentMode = takeawayAktif ? 'AMBIL_SENDIRI' : (dineInAktif ? 'MAKAN_DI_TEMPAT' : 'AMBIL_SENDIRI');
        }
        if (currentMode === 'AMBIL_SENDIRI' && !takeawayAktif) {
            currentMode = kurirAktif ? 'KURIR_WARUNG' : (dineInAktif ? 'MAKAN_DI_TEMPAT' : 'KURIR_WARUNG');
        }
        if (currentMode === 'MAKAN_DI_TEMPAT' && !dineInAktif) {
            currentMode = kurirAktif ? 'KURIR_WARUNG' : 'AMBIL_SENDIRI';
        }
        this._preferredReceiveMethod = currentMode;

        if (btnDelivery) btnDelivery.classList.toggle('active', currentMode === 'KURIR_WARUNG');
        if (btnPickup) btnPickup.classList.toggle('active', currentMode === 'AMBIL_SENDIRI');
        if (btnDineIn) btnDineIn.classList.toggle('active', currentMode === 'MAKAN_DI_TEMPAT');

        if (noticeEl) {
            const nonDineInTag = !dineInAktif
                ? ` <span class="text-amber font-bold">(Outlet Rumahan: Tidak melayani makan di tempat)</span>`
                : '';
            if (currentMode === 'KURIR_WARUNG') {
                noticeEl.innerHTML = `<i class="fa-solid fa-motorcycle text-emerald"></i> <b>Pesan Antar Kurir Outlet:</b> ${this._escapeHtml(infoOngkir)}.${nonDineInTag}`;
            } else if (currentMode === 'MAKAN_DI_TEMPAT') {
                noticeEl.innerHTML = `<i class="fa-solid fa-utensils text-emerald"></i> <b>Makan di Tempat (Dine-In):</b> Pesanan disiapkan untuk disantap langsung di meja resto.`;
            } else {
                noticeEl.innerHTML = `<i class="fa-solid fa-bag-shopping text-emerald"></i> <b>Take Away / Ambil Sendiri:</b> Bebas ongkir, ambil pesanan langsung di lokasi usaha.${nonDineInTag}`;
            }
        }
    },

    _renderStoreSubcatChips: function() {
        const chipWrap = document.getElementById('storePageSubcatChips');
        if (!chipWrap || !this._activeMerchantDoc) return;

        const items = Array.isArray(this._activeMerchantDoc.items) ? this._activeMerchantDoc.items : [];
        const uniqueCats = Array.from(new Set(items.map(it => String(it.kat || 'Hidangan Utama').trim()).filter(Boolean)));

        if (uniqueCats.length <= 1) {
            chipWrap.innerHTML = '';
            return;
        }

        const allTabs = ['ALL', ...uniqueCats];
        chipWrap.innerHTML = '';
        allTabs.forEach(catName => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `drawer-subcat-btn ${this._storeSubCategory === catName ? 'active' : ''}`;
            btn.textContent = catName === 'ALL' ? `Semua (${items.length})` : catName;
            btn.addEventListener('click', () => {
                picuGetarSentuh(8);
                this._storeSubCategory = catName;
                this._renderStoreSubcatChips();
                this._renderActiveStoreMenuItems();
            });
            chipWrap.appendChild(btn);
        });
    },

    /**
     * Merender Daftar Hidangan di Halaman Resto (`#page-store`)
     * Dilengkapi Rincian Isi Paket (`desc`), Pilihan Minuman (`drk`), & Varian (`var`)
     */
    _renderActiveStoreMenuItems: function() {
        const listEl = document.getElementById('storeMenuItemsContainer');
        if (!listEl || !this._activeMerchantDoc || !this._activeMerchantMeta) return;

        const mMeta = this._activeMerchantMeta;
        const mDoc = this._activeMerchantDoc;
        const storeDisc = Number(mDoc.profile?.diskonTokoPersen ?? mMeta.dsc ?? 0);
        const skemaDiskon = ['MAX_BEST', 'ITEM_OVERRIDE', 'STACK_ADD'].includes(mDoc.profile?.skemaDiskonGlobal)
            ? mDoc.profile.skemaDiskonGlobal
            : (mMeta.dm || 'MAX_BEST');
        const allItems = Array.isArray(mDoc.items) ? mDoc.items : [];

        listEl.innerHTML = '';

        if (allItems.length === 0) {
            listEl.innerHTML = `<div class="glass-panel text-center text-muted" style="padding: 22px; border-radius: 16px; font-size: 0.76rem;">Tempat usaha ini belum menambahkan daftar hidangan.</div>`;
            return;
        }

        const qStore = this._storeSearchQuery.trim().toLowerCase();
        const subCat = this._storeSubCategory;

        const items = allItems.filter(it => {
            const itemKat = String(it.kat || 'Hidangan Utama').trim();
            const matchKat = (subCat === 'ALL') || (itemKat === subCat);
            const resolvedVarForSearch = this._autoArticulateMissingVarFromItem(it.n, it.var, it.desc);
            const matchQ = !qStore ||
                String(it.n || '').toLowerCase().includes(qStore) ||
                itemKat.toLowerCase().includes(qStore) ||
                String(it.desc || '').toLowerCase().includes(qStore) ||
                String(it.drk || '').toLowerCase().includes(qStore) ||
                resolvedVarForSearch.toLowerCase().includes(qStore);
            return matchKat && matchQ;
        });

        if (items.length === 0) {
            listEl.innerHTML = `<div class="glass-panel text-center text-muted" style="padding: 20px; border-radius: 16px; font-size: 0.75rem;">Tidak ada hidangan yang cocok dengan kata kunci pencarian.</div>`;
            return;
        }

        items.forEach(item => {
            const isAvailable = item.s !== false;
            const calc = this._calculateFinalPrice(item.p, item.d, storeDisc, skemaDiskon);
            const imgUrl = this._buildPhotoUrl(item.img, item.n, 400);

            const cartEntry = (this._cart.uidMerchant === mMeta.uid && this._cart.itemsMap[item.id])
                ? this._cart.itemsMap[item.id]
                : null;
            const currentQtyInCart = cartEntry ? cartEntry.qty : 0;

            const row = document.createElement('div');
            row.className = `umkm-menu-item-row ${!isAvailable ? 'is-out-of-stock' : ''} ${currentQtyInCart > 0 ? 'has-qty' : ''}`;

            const itemKatClean = String(item.kat || 'Hidangan Utama').trim();
            const isPaketItem =
                itemKatClean === 'Paket Hemat & Combo' ||
                itemKatClean === 'Paket & Spesial' ||
                itemKatClean === 'Paket Hemat' ||
                (Boolean(item.desc) && Boolean(item.drk)) ||
                /\b(paket|combo)\b/i.test(item.n || '');

            const pkgBadgeHtml = isPaketItem
                ? `<span class="menu-item-package-badge"><i class="fa-solid fa-box-open"></i> PAKET HEMAT</span>`
                : '';

            const resolvedCardVar = this._autoArticulateMissingVarFromItem(item.n, item.var, item.desc);
            const pkgCompositionHtml = `
                ${item.desc ? `<div class="menu-item-package-desc"><i class="fa-solid fa-utensils text-emerald"></i> <span><b>Isi:</b> ${this._escapeHtml(item.desc)}</span></div>` : ''}
                ${item.drk ? `<div class="menu-item-package-drink"><i class="fa-solid fa-glass-water text-amber"></i> <span><b>Minuman:</b> ${this._escapeHtml(item.drk)}</span></div>` : ''}
                ${resolvedCardVar ? `<div class="menu-item-package-var"><i class="fa-solid fa-sliders"></i> <span><b>Pilihan:</b> ${this._escapeHtml(resolvedCardVar)}</span></div>` : ''}
            `;

            const priceHtml = calc.discountPct > 0
                ? `<div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 5px;">
                     <span class="font-tech font-bold text-main" style="font-size: 0.9rem;">${this._formatRp(calc.finalPrice)}</span>
                     <span style="font-size: 0.68rem; text-decoration: line-through; color: var(--text-subtle);">${this._formatRp(calc.originalPrice)}</span>
                     <span style="font-size: 0.56rem; font-weight: 800; padding: 2px 6px; border-radius: 6px; background: var(--go-red-soft); color: var(--go-red);">-${calc.discountPct}%${calc.sourceLabel ? ' • ' + calc.sourceLabel : ''}</span>
                   </div>`
                : `<div class="font-tech font-bold text-main" style="font-size: 0.9rem; margin-top: 5px;">${this._formatRp(calc.finalPrice)}</div>`;

            row.innerHTML = `
                <div class="menu-item-main-top">
                    <div style="flex: 1; min-width: 0;">
                        <div style="display: flex; align-items: center; flex-wrap: wrap;">
                            <span class="item-subcat-el" style="font-size: 0.6rem; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em;"></span>
                            ${pkgBadgeHtml}
                        </div>
                        <div class="font-bold text-main item-name-el" style="font-size: 0.88rem; line-height: 1.3; margin-top: 2px;"></div>
                        ${pkgCompositionHtml}
                        ${priceHtml}
                    </div>
                    <div class="menu-item-right-col">
                        <div class="umkm-menu-photo" oncontextmenu="return false;">
                            <img src="${imgUrl}" referrerpolicy="no-referrer" loading="lazy" alt="Hidangan" draggable="false" oncontextmenu="return false;">
                            <div class="image-protect-layer" oncontextmenu="return false;"></div>
                        </div>
                        <div class="umkm-qty-box">
                            ${!isAvailable
                                ? `<span style="font-size: 0.6rem; font-weight: 800; color: var(--go-red); padding: 3px 9px; border-radius: 999px; background: var(--go-red-soft); white-space: nowrap;">Habis Hari Ini</span>`
                                : `<button type="button" class="btn-add-dish ${currentQtyInCart > 0 ? 'hidden' : ''}">+ Tambah</button>
                                   <div class="qty-stepper-control ${currentQtyInCart > 0 ? '' : 'hidden'}">
                                     <button type="button" class="btn-qty-step is-minus btn-umkm-qty-min" aria-label="Kurangi"><i class="fa-solid fa-minus"></i></button>
                                     <span class="font-tech font-bold text-main umkm-item-qty-val" style="font-size: 0.8rem; min-width: 16px; text-align: center;">${currentQtyInCart}</span>
                                     <button type="button" class="btn-qty-step is-plus btn-umkm-qty-plus" aria-label="Tambah"><i class="fa-solid fa-plus"></i></button>
                                   </div>`
                            }
                        </div>
                    </div>
                </div>
                <div class="item-note-editor-box ${currentQtyInCart > 0 ? '' : 'hidden'}"></div>
            `;

            const subcatEl = row.querySelector('.item-subcat-el');
            if (subcatEl) subcatEl.textContent = itemKatClean;
            const nameEl = row.querySelector('.item-name-el');
            if (nameEl) nameEl.textContent = item.n;

            const noteBoxEl = row.querySelector('.item-note-editor-box');
            if (currentQtyInCart > 0) {
                this._bindItemNoteEditorBoxEvents(noteBoxEl, item.id, item.n, itemKatClean);
            }

            if (isAvailable) {
                const btnTambah = row.querySelector('.btn-add-dish');
                const stepperWrap = row.querySelector('.qty-stepper-control');
                const btnMin = row.querySelector('.btn-umkm-qty-min');
                const btnPlus = row.querySelector('.btn-umkm-qty-plus');
                const qtyValEl = row.querySelector('.umkm-item-qty-val');

                const syncRowControls = (newQty) => {
                    if (qtyValEl) qtyValEl.textContent = String(newQty);
                    if (btnTambah) btnTambah.classList.toggle('hidden', newQty > 0);
                    if (stepperWrap) stepperWrap.classList.toggle('hidden', newQty <= 0);
                    row.classList.toggle('has-qty', newQty > 0);
                    this._bindItemNoteEditorBoxEvents(noteBoxEl, item.id, item.n, itemKatClean);
                };

                if (btnTambah) {
                    btnTambah.addEventListener('click', () => {
                        picuGetarSentuh(12);
                        if (!this.isBuyerProfileComplete()) {
                            this.openBuyerOnboardingModal(() => {
                                const q = this._adjustCartItem(mMeta, item, calc, 1);
                                syncRowControls(q);
                            });
                            return;
                        }
                        const q = this._adjustCartItem(mMeta, item, calc, 1);
                        syncRowControls(q);
                    });
                }
                if (btnMin) {
                    btnMin.addEventListener('click', () => {
                        picuGetarSentuh(10);
                        const q = this._adjustCartItem(mMeta, item, calc, -1);
                        syncRowControls(q);
                    });
                }
                if (btnPlus) {
                    btnPlus.addEventListener('click', () => {
                        picuGetarSentuh(12);
                        const q = this._adjustCartItem(mMeta, item, calc, 1);
                        syncRowControls(q);
                    });
                }
            }

            listEl.appendChild(row);
        });
    },

    _toggleCartItemPortionMode: function(itemId) {
        const entry = this._cart?.itemsMap?.[itemId];
        if (!entry || entry.qty <= 1) return;
        entry.portionNotes = this._normalizePortionNotesArray(entry.portionNotes, entry.qty);
        entry.portionDrinks = this._normalizePortionChoiceArray(entry.portionDrinks, entry.qty, entry.selectedDrink || '');
        entry.portionVars = this._normalizePortionChoiceArray(entry.portionVars, entry.qty, entry.selectedVar || '');

        const nextMode = !entry.usePortionNotes;
        entry.usePortionNotes = nextMode;

        if (nextMode && entry.note && !entry.portionNotes.some(n => n.length > 0)) {
            entry.portionNotes[0] = entry.note;
        }
        this._persistCart();
        this.updateFloatingCartBarUI();
        if (this._activeCheckoutState) {
            this._activeCheckoutState.summary = this.getCartSummary();
            this._updateLiveWaReceiptPreview();
        }
    },

    _setCartItemDrinkChoice: function(itemId, rawDrinkChoice) {
        const entry = this._cart?.itemsMap?.[itemId];
        if (!entry) return;
        const clean = String(rawDrinkChoice || '').trim();
        entry.selectedDrink = clean;
        entry.portionDrinks = this._normalizePortionChoiceArray(
            Array(entry.qty).fill(clean),
            entry.qty,
            clean
        );
        this._persistCart();
    },

    _setCartItemVarChoice: function(itemId, rawVarChoice) {
        const entry = this._cart?.itemsMap?.[itemId];
        if (!entry) return;
        const clean = String(rawVarChoice || '').trim();
        entry.selectedVar = clean;
        entry.portionVars = this._normalizePortionChoiceArray(
            Array(entry.qty).fill(clean),
            entry.qty,
            clean
        );
        this._persistCart();
    },

    _setCartItemPortionDrink: function(itemId, portionIdx, rawDrinkChoice) {
        const entry = this._cart?.itemsMap?.[itemId];
        if (!entry) return;
        entry.portionDrinks = this._normalizePortionChoiceArray(entry.portionDrinks, entry.qty, entry.selectedDrink || '');
        const idx = parseInt(portionIdx, 10);
        if (!isNaN(idx) && idx >= 0 && idx < entry.portionDrinks.length) {
            entry.portionDrinks[idx] = String(rawDrinkChoice || '').trim();
            entry.usePortionNotes = true;
        }
        this._persistCart();
    },

    _setCartItemPortionVar: function(itemId, portionIdx, rawVarChoice) {
        const entry = this._cart?.itemsMap?.[itemId];
        if (!entry) return;
        entry.portionVars = this._normalizePortionChoiceArray(entry.portionVars, entry.qty, entry.selectedVar || '');
        const idx = parseInt(portionIdx, 10);
        if (!isNaN(idx) && idx >= 0 && idx < entry.portionVars.length) {
            entry.portionVars[idx] = String(rawVarChoice || '').trim();
            entry.usePortionNotes = true;
        }
        this._persistCart();
    },

    _setCartItemNote: function(itemId, noteText) {
        if (!this._cart || !this._cart.itemsMap || !this._cart.itemsMap[itemId]) return;
        this._cart.itemsMap[itemId].note = String(noteText || '').trim().substring(0, 100);
        this._persistCart();
        this.updateFloatingCartBarUI();
        if (this._activeCheckoutState) {
            this._activeCheckoutState.summary = this.getCartSummary();
            this._updateLiveWaReceiptPreview();
        }
    },

    _setCartItemPortionNote: function(itemId, portionIdx, noteText) {
        const entry = this._cart?.itemsMap?.[itemId];
        if (!entry) return;
        entry.portionNotes = this._normalizePortionNotesArray(entry.portionNotes, entry.qty);
        const idx = parseInt(portionIdx, 10);
        if (!isNaN(idx) && idx >= 0 && idx < entry.portionNotes.length) {
            entry.portionNotes[idx] = String(noteText || '').trim().substring(0, 100);
            entry.usePortionNotes = true;
        }
        this._persistCart();
        this.updateFloatingCartBarUI();
        if (this._activeCheckoutState) {
            this._activeCheckoutState.summary = this.getCartSummary();
            this._updateLiveWaReceiptPreview();
        }
    },

    _adjustCartItem: function(merchantMeta, itemObj, priceCalc, delta) {
        if (this._cart.uidMerchant && this._cart.uidMerchant !== merchantMeta.uid) {
            const hasExistingItems = Object.keys(this._cart.itemsMap || {}).length > 0;
            if (hasExistingItems) {
                this._cart = {
                    uidMerchant: merchantMeta.uid,
                    storeName: merchantMeta.n,
                    storeAddress: merchantMeta.addr || merchantMeta.n,
                    storeLat: merchantMeta.lat,
                    storeLng: merchantMeta.lng,
                    itemsMap: {}
                };
            }
        }

        if (!this._cart.uidMerchant) {
            this._cart.uidMerchant = merchantMeta.uid;
            this._cart.storeName = merchantMeta.n;
            this._cart.storeAddress = merchantMeta.addr || merchantMeta.n;
            this._cart.storeLat = merchantMeta.lat;
            this._cart.storeLng = merchantMeta.lng;
        }

        const rawDesc = String(itemObj.desc || '').trim();
        const rawDrk = String(itemObj.drk || '').trim();
        const rawVar = this._autoArticulateMissingVarFromItem(itemObj.n, itemObj.var, rawDesc);
        const drinkOptions = this._parseOptionChoicesString(rawDrk);
        const varGroups = this._parseVariantGroups(rawVar);
        const defaultDrink = drinkOptions.length > 0 ? drinkOptions[0].raw : '';
        const defaultVar = this._buildDefaultSelectedVarFromGroups(varGroups);

        const existing = this._cart.itemsMap[itemObj.id] || {
            id: itemObj.id,
            name: itemObj.n,
            kat: itemObj.kat || 'Hidangan Utama',
            originalPrice: priceCalc.originalPrice,
            finalPrice: priceCalc.finalPrice,
            discountPct: priceCalc.discountPct,
            desc: rawDesc,
            drk: rawDrk,
            var: rawVar,
            selectedDrink: defaultDrink,
            selectedVar: defaultVar,
            portionDrinks: [],
            portionVars: [],
            note: '',
            usePortionNotes: false,
            portionNotes: [],
            qty: 0
        };

        const nextQty = Math.max(0, existing.qty + delta);
        if (nextQty <= 0) {
            delete this._cart.itemsMap[itemObj.id];
        } else {
            existing.qty = nextQty;
            existing.finalPrice = priceCalc.finalPrice;
            existing.kat = itemObj.kat || existing.kat || 'Hidangan Utama';
            if (rawDesc) existing.desc = rawDesc;
            if (rawDrk) existing.drk = rawDrk;
            if (rawVar) existing.var = rawVar;
            if (!existing.selectedDrink && defaultDrink) existing.selectedDrink = defaultDrink;
            if (!existing.selectedVar && defaultVar) existing.selectedVar = defaultVar;

            existing.portionNotes = this._normalizePortionNotesArray(existing.portionNotes, nextQty);
            existing.portionDrinks = this._normalizePortionChoiceArray(existing.portionDrinks, nextQty, existing.selectedDrink);
            existing.portionVars = this._normalizePortionChoiceArray(existing.portionVars, nextQty, existing.selectedVar);

            if (nextQty === 1 && existing.usePortionNotes) {
                if (!existing.note && existing.portionNotes[0]) {
                    existing.note = existing.portionNotes[0];
                }
                if (existing.portionDrinks[0]) {
                    existing.selectedDrink = existing.portionDrinks[0];
                }
                if (existing.portionVars[0]) {
                    existing.selectedVar = existing.portionVars[0];
                }
                existing.usePortionNotes = false;
            }
            this._cart.itemsMap[itemObj.id] = existing;
        }

        if (Object.keys(this._cart.itemsMap).length === 0) {
            this._cart.uidMerchant = null;
        }

        this._persistCart();
        this.updateFloatingCartBarUI();
        this.updateBottomNavBadges();
        return nextQty;
    },

    _adjustCheckoutCartItemById: function(itemId, delta) {
        if (!this._cart || !this._cart.itemsMap || !this._cart.itemsMap[itemId]) return;
        const entry = this._cart.itemsMap[itemId];
        const nextQty = Math.max(0, (parseInt(entry.qty, 10) || 0) + delta);
        if (nextQty <= 0) {
            delete this._cart.itemsMap[itemId];
        } else {
            entry.qty = nextQty;
            entry.portionNotes = this._normalizePortionNotesArray(entry.portionNotes, nextQty);
            entry.portionDrinks = this._normalizePortionChoiceArray(entry.portionDrinks, nextQty, entry.selectedDrink || '');
            entry.portionVars = this._normalizePortionChoiceArray(entry.portionVars, nextQty, entry.selectedVar || '');
            if (nextQty === 1 && entry.usePortionNotes) {
                if (!entry.note && entry.portionNotes[0]) {
                    entry.note = entry.portionNotes[0];
                }
                if (entry.portionDrinks[0]) {
                    entry.selectedDrink = entry.portionDrinks[0];
                }
                if (entry.portionVars[0]) {
                    entry.selectedVar = entry.portionVars[0];
                }
                entry.usePortionNotes = false;
            }
        }

        if (Object.keys(this._cart.itemsMap).length === 0) {
            this._cart.uidMerchant = null;
        }

        this._persistCart();
        this.updateFloatingCartBarUI();
        this.updateBottomNavBadges();
        if (this._activeMerchantDoc) {
            this._renderActiveStoreMenuItems();
        }
        this.renderCheckoutPage(false);
    },

    _persistCart: function() {
        try {
            localStorage.setItem(ACTIVE_CART_STORAGE_KEY, JSON.stringify(this._cart));
        } catch (e) {}
    },

    _restoreSavedCart: function() {
        try {
            const raw = localStorage.getItem(ACTIVE_CART_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (parsed && parsed.uidMerchant && parsed.itemsMap && typeof parsed.itemsMap === 'object') {
                Object.values(parsed.itemsMap).forEach(entry => {
                    if (!entry || typeof entry !== 'object') return;
                    const articulatedVar = this._autoArticulateMissingVarFromItem(entry.name || '', entry.var || '', entry.desc || '');
                    if (articulatedVar) {
                        entry.var = articulatedVar;
                    }
                    const varGroups = this._parseVariantGroups(entry.var || '');
                    const defaultVar = this._buildDefaultSelectedVarFromGroups(varGroups);
                    if (!entry.selectedVar && defaultVar) {
                        entry.selectedVar = defaultVar;
                    }
                    entry.portionVars = this._normalizePortionChoiceArray(entry.portionVars, entry.qty || 1, entry.selectedVar || '');
                });
                this._cart = parsed;
            } else {
                localStorage.removeItem(ACTIVE_CART_STORAGE_KEY);
            }
        } catch (e) {}
    },

    clearCart: function() {
        this._cart = {
            uidMerchant: null,
            storeName: '',
            storeAddress: '',
            storeLat: null,
            storeLng: null,
            itemsMap: {}
        };
        try { localStorage.removeItem(ACTIVE_CART_STORAGE_KEY); } catch (e) {}
        this.updateFloatingCartBarUI();
        this.updateBottomNavBadges();
        if (this._activeMerchantDoc) {
            this._renderActiveStoreMenuItems();
        }
        if (JaparPageRouter.getCurrentPage() === 'checkout') {
            this.renderCheckoutPage(false);
        }
    },

    /**
     * Menghitung ringkasan keranjang termasuk harga tambahan opsi minuman paket / varian (`unitAddonPrice` & `portionAddonPrice`)
     */
    getCartSummary: function() {
        const entries = Object.values(this._cart.itemsMap || {});
        let totalQty = 0;
        let totalValue = 0;
        let totalSaved = 0;
        const orderItems = [];

        entries.forEach(it => {
            const qty = Math.max(1, parseInt(it.qty, 10) || 1);
            const basePrice = Math.max(0, parseInt(it.finalPrice, 10) || 0);
            const orig = Math.max(basePrice, parseInt(it.originalPrice, 10) || basePrice);
            const cleanNote = String(it.note || '').trim().substring(0, 100);
            const cleanDesc = String(it.desc || '').trim();
            const cleanDrk = String(it.drk || '').trim();
            const cleanVar = this._autoArticulateMissingVarFromItem(it.name || '', it.var || '', cleanDesc);

            const drinkOptions = this._parseOptionChoicesString(cleanDrk);
            const varGroups = this._parseVariantGroups(cleanVar);
            const defaultVar = this._buildDefaultSelectedVarFromGroups(varGroups);

            const selectedDrink = String(it.selectedDrink || (drinkOptions[0]?.raw || '')).trim();
            const selectedVar = (it.selectedVar !== undefined && it.selectedVar !== null && String(it.selectedVar).trim() !== '')
                ? String(it.selectedVar).trim()
                : defaultVar;

            const portionNotes = this._normalizePortionNotesArray(it.portionNotes, qty);
            const portionDrinks = this._normalizePortionChoiceArray(it.portionDrinks, qty, selectedDrink);
            const portionVars = this._normalizePortionChoiceArray(it.portionVars, qty, selectedVar);

            const usePortionNotes = qty > 1 && Boolean(it.usePortionNotes);

            let unitAddonPrice = 0;
            let totalAddonPrice = 0;
            const portionAddonPrices = [];

            if (usePortionNotes) {
                for (let i = 0; i < qty; i++) {
                    const pDrinkExtra = this._getExtraPriceForChoice(portionDrinks[i], drinkOptions);
                    const pVarExtra = this._getExtraPriceForChoice(portionVars[i], varGroups);
                    const pAddon = pDrinkExtra + pVarExtra;
                    portionAddonPrices.push(pAddon);
                    totalAddonPrice += pAddon;
                }
                unitAddonPrice = Math.round(totalAddonPrice / qty);
            } else {
                const drinkExtra = this._getExtraPriceForChoice(selectedDrink, drinkOptions);
                const varExtra = this._getExtraPriceForChoice(selectedVar, varGroups);
                unitAddonPrice = drinkExtra + varExtra;
                totalAddonPrice = unitAddonPrice * qty;
            }

            const effectiveUnitPrice = basePrice + unitAddonPrice;
            const subtotal = (basePrice * qty) + totalAddonPrice;

            totalQty += qty;
            totalValue += subtotal;
            totalSaved += (orig - basePrice) * qty;

            orderItems.push({
                id: it.id,
                name: it.name,
                kat: it.kat || 'Hidangan Utama',
                basePrice: basePrice,
                price: effectiveUnitPrice,
                originalPrice: orig,
                unitAddonPrice: unitAddonPrice,
                totalAddonPrice: totalAddonPrice,
                portionAddonPrices: portionAddonPrices,
                qty: qty,
                subtotal: subtotal,
                desc: cleanDesc,
                drk: cleanDrk,
                var: cleanVar,
                selectedDrink: selectedDrink,
                selectedVar: selectedVar,
                portionDrinks: portionDrinks,
                portionVars: portionVars,
                note: cleanNote,
                usePortionNotes: usePortionNotes,
                portionNotes: portionNotes
            });
        });

        return {
            uidMerchant: this._cart.uidMerchant,
            storeName: this._cart.storeName,
            storeAddress: this._cart.storeAddress,
            storeLat: this._cart.storeLat,
            storeLng: this._cart.storeLng,
            totalQty,
            totalValue,
            totalSaved,
            orderItems
        };
    },

    updateFloatingCartBarUI: function() {
        const summary = this.getCartSummary();
        const barExplore = document.getElementById('umkmFloatingCartBar');
        const barStore = document.getElementById('storeFloatingCartFooter');

        const renderBarContent = (barEl, titleId, totalId, savePillId) => {
            if (!barEl) return;
            if (summary.totalQty > 0 && summary.totalValue > 0) {
                barEl.classList.remove('hidden');
                const tEl = document.getElementById(titleId);
                const vEl = document.getElementById(totalId);
                const sEl = document.getElementById(savePillId);
                if (tEl) {
                    const customCount = summary.orderItems.filter(i =>
                        i.note || i.selectedDrink || i.selectedVar || i.usePortionNotes
                    ).length;
                    const noteIndicator = customCount > 0 ? ` • ${customCount} opsi/catatan` : '';
                    tEl.textContent = `${summary.totalQty} Porsi • ${summary.storeName}${noteIndicator}`;
                }
                if (vEl) {
                    vEl.textContent = this._formatRp(summary.totalValue);
                }
                if (sEl) {
                    if (summary.totalSaved > 0) {
                        sEl.classList.remove('hidden');
                        sEl.textContent = `Hemat ${this._formatRp(summary.totalSaved)}`;
                    } else {
                        sEl.classList.add('hidden');
                    }
                }
            } else {
                barEl.classList.add('hidden');
            }
        };

        renderBarContent(barExplore, 'umkmCartBarStoreSummary', 'umkmCartBarTotalValue', 'umkmCartBarSavePill');
        renderBarContent(barStore, 'storeCartSummaryText', 'storeCartTotalValue', 'storeCartSavePill');
    },

    updateBottomNavBadges: function() {
        const summary = this.getCartSummary();
        const cartBadge = document.getElementById('bottomNavCartBadge');
        if (cartBadge) {
            cartBadge.textContent = String(summary.totalQty);
            cartBadge.classList.toggle('hidden', summary.totalQty <= 0);
        }

        const historyList = this._readOrderHistoryList();
        const ordersBadge = document.getElementById('bottomNavOrdersBadge');
        if (ordersBadge) {
            ordersBadge.textContent = String(historyList.length);
            ordersBadge.classList.toggle('hidden', historyList.length <= 0);
        }
    },

    _parseDeliveryFeeDetails: function(profileObj, estDistKm = null) {
        const p = profileObj || {};
        const rawInfo = String(p.infoOngkirWarung || '').trim();
        const explicitTarif = (p.tarifOngkir !== undefined && p.tarifOngkir !== null && p.tarifOngkir !== '')
            ? Math.max(0, parseInt(String(p.tarifOngkir).replace(/[^0-9]/g, ''), 10) || 0)
            : null;

        if (/\b(gratis|free|tanpa\s*ongkir|rp\s*0\b|^0$)\b/i.test(rawInfo) && (!explicitTarif || explicitTarif === 0)) {
            return {
                nominal: 0,
                isNumeric: true,
                displayLabel: 'Gratis Ongkir (Rp 0)',
                rawNote: rawInfo && !/^0$/.test(rawInfo) ? rawInfo : 'Gratis Ongkir'
            };
        }

        const perKmMatch = rawInfo.match(/(?:rp\.?\s*)?(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(?:rb|ribu|k)?\s*(?:\/|per\s*)\s*km/i);
        if (perKmMatch) {
            let baseRate = parseFloat(perKmMatch[1].replace(/\./g, '').replace(',', '.')) || 0;
            if (/rb|ribu|k/i.test(perKmMatch[0]) && baseRate < 100) baseRate *= 1000;
            else if (baseRate > 0 && baseRate < 100) baseRate *= 1000;
            const kmCount = (estDistKm !== null && !isNaN(estDistKm) && estDistKm > 0) ? Math.max(1, Math.ceil(estDistKm)) : 1;
            const totalPerKm = Math.round(baseRate * kmCount);
            return {
                nominal: totalPerKm,
                isNumeric: true,
                displayLabel: `${this._formatRp(totalPerKm)} (${kmCount} km × ${this._formatRp(baseRate)}/km)`,
                rawNote: rawInfo
            };
        }

        if (explicitTarif !== null && explicitTarif > 0) {
            const extraNote = (rawInfo && !/^\s*(?:rp\.?\s*)?(\d{1,3}(?:[.,]\d{3})*|\d+)\s*$/i.test(rawInfo))
                ? ` (${rawInfo})`
                : '';
            return {
                nominal: explicitTarif,
                isNumeric: true,
                displayLabel: `${this._formatRp(explicitTarif)}${extraNote}`,
                rawNote: rawInfo || this._formatRp(explicitTarif)
            };
        }

        const rbMatch = rawInfo.match(/(?:rp\.?\s*)?(\d+(?:[.,]\d+)?)\s*(?:rb|ribu\b)/i);
        if (rbMatch) {
            const val = Math.round(parseFloat(rbMatch[1].replace(',', '.')) * 1000);
            if (val > 0) {
                return {
                    nominal: val,
                    isNumeric: true,
                    displayLabel: this._formatRp(val),
                    rawNote: rawInfo
                };
            }
        }

        const numMatch = rawInfo.match(/(?:rp\.?\s*)?(\d{1,3}(?:[.,]\d{3})+|[1-9]\d{2,6})\b/i);
        if (numMatch) {
            const val = parseInt(numMatch[1].replace(/[.,]/g, ''), 10) || 0;
            if (val >= 500 && val <= 200000) {
                const isJustNumber = /^\s*(?:rp\.?\s*)?(\d{1,3}(?:[.,]\d{3})*|\d+)\s*$/i.test(rawInfo);
                return {
                    nominal: val,
                    isNumeric: true,
                    displayLabel: isJustNumber ? this._formatRp(val) : `${this._formatRp(val)} (${rawInfo})`,
                    rawNote: isJustNumber ? this._formatRp(val) : rawInfo
                };
            }
        }

        return {
            nominal: 0,
            isNumeric: false,
            displayLabel: rawInfo || 'Sesuai ketentuan kurir resto',
            rawNote: rawInfo || 'Sesuai ketentuan kurir resto'
        };
    },

    _syncSavedBuyerProfileLocksUI: function(forceUnlockName = null, forceUnlockAddr = null) {
        const inpName = document.getElementById('japarBuyerName');
        const inpAddr = document.getElementById('japarBuyerAddress');
        const btnEmbedGps = document.getElementById('btnEmbedBuyerGps');

        const bannerName = document.getElementById('buyerIdentityLockBanner');
        const iconName = document.getElementById('buyerIdentityLockIcon');
        const textName = document.getElementById('buyerIdentityLockText');
        const btnName = document.getElementById('btnToggleBuyerIdentityLock');

        const bannerAddr = document.getElementById('buyerAddressLockBanner');
        const iconAddr = document.getElementById('buyerAddressLockIcon');
        const textAddr = document.getElementById('buyerAddressLockText');
        const btnAddr = document.getElementById('btnToggleBuyerAddressLock');

        let saved = {};
        try {
            saved = JSON.parse(localStorage.getItem(BUYER_PROFILE_CACHE_KEY) || '{}') || {};
        } catch (e) {}

        const hasSavedName = Boolean((inpName?.value || saved.name || '').trim().length >= 2);
        const hasSavedAddr = Boolean((inpAddr?.value || saved.address || '').trim().length >= 5);

        if (forceUnlockName !== null) this._isBuyerNameUnlocked = Boolean(forceUnlockName);
        else if (this._isBuyerNameUnlocked === undefined) this._isBuyerNameUnlocked = !hasSavedName;

        if (forceUnlockAddr !== null) this._isBuyerAddrUnlocked = Boolean(forceUnlockAddr);
        else if (this._isBuyerAddrUnlocked === undefined) this._isBuyerAddrUnlocked = !hasSavedAddr;

        if (bannerName && inpName) {
            if (!hasSavedName && this._isBuyerNameUnlocked) {
                bannerName.classList.add('hidden');
                inpName.readOnly = false;
                inpName.classList.remove('is-locked-input');
            } else {
                bannerName.classList.remove('hidden');
                const locked = !this._isBuyerNameUnlocked;
                inpName.readOnly = locked;
                inpName.classList.toggle('is-locked-input', locked);
                bannerName.classList.toggle('is-editing', !locked);
                if (iconName) iconName.className = locked ? 'fa-solid fa-lock' : 'fa-solid fa-lock-open';
                if (textName) {
                    textName.textContent = locked
                        ? `Tersimpan & Terkunci: ${inpName.value.trim()} (Otomatis dipakai tiap order)`
                        : 'Silakan ubah Nama Pemesan lalu ketuk Simpan & Kunci';
                }
                if (btnName) {
                    btnName.innerHTML = locked
                        ? '<i class="fa-solid fa-pen-to-square"></i><span>Ubah Nama</span>'
                        : '<i class="fa-solid fa-lock"></i><span>Simpan &amp; Kunci</span>';
                }
            }
        }

        if (bannerAddr && inpAddr) {
            if (!hasSavedAddr && this._isBuyerAddrUnlocked) {
                bannerAddr.classList.add('hidden');
                inpAddr.readOnly = false;
                inpAddr.classList.remove('is-locked-input');
                if (btnEmbedGps) btnEmbedGps.disabled = false;
            } else {
                bannerAddr.classList.remove('hidden');
                const locked = !this._isBuyerAddrUnlocked;
                inpAddr.readOnly = locked;
                inpAddr.classList.toggle('is-locked-input', locked);
                const inpCheckoutGmaps = document.getElementById('checkoutGmapsRaw');
                const btnCheckoutExtract = document.getElementById('btnCheckoutExtractGmaps');
                if (inpCheckoutGmaps) {
                    inpCheckoutGmaps.readOnly = locked;
                    inpCheckoutGmaps.classList.toggle('is-locked-input', locked);
                }
                if (btnCheckoutExtract) btnCheckoutExtract.disabled = locked;
                if (btnEmbedGps) btnEmbedGps.disabled = locked;
                bannerAddr.classList.toggle('is-editing', !locked);
                if (iconAddr) iconAddr.className = locked ? 'fa-solid fa-lock' : 'fa-solid fa-lock-open';
                if (textAddr) {
                    textAddr.textContent = locked
                        ? 'Alamat pengantaran tersimpan & dikunci aman saat scroll'
                        : 'Silakan sesuaikan Alamat & Titik GPS lalu ketuk Simpan & Kunci';
                }
                if (btnAddr) {
                    btnAddr.innerHTML = locked
                        ? '<i class="fa-solid fa-pen-to-square"></i><span>Ubah Alamat</span>'
                        : '<i class="fa-solid fa-lock"></i><span>Simpan &amp; Kunci</span>';
                }
            }
        }
    },

    _persistBuyerProfileToStorage: function(overrides = null) {
        const prev = readSavedBuyerProfile();
        const rawName = (overrides?.name !== undefined ? overrides.name : (document.getElementById('japarBuyerName')?.value || document.getElementById('profileBuyerName')?.value || prev.name || '')).trim();
        const rawWa = (overrides?.wa !== undefined ? overrides.wa : (document.getElementById('japarBuyerWA')?.value || document.getElementById('profileBuyerWA')?.value || prev.wa || '')).trim();
        const rawAddr = (overrides?.address !== undefined ? overrides.address : (document.getElementById('japarBuyerAddress')?.value || document.getElementById('profileBuyerAddress')?.value || prev.address || '')).trim();
        const rawShortStreet = (overrides?.shortStreet !== undefined ? overrides.shortStreet : (window.JAPAR_USER_GPS_COORD?.shortStreet || prev.shortStreet || rawAddr)).trim();
        const rawGmapsInput = (overrides?.rawGmapsInput !== undefined ? overrides.rawGmapsInput : (document.getElementById('checkoutGmapsRaw')?.value || document.getElementById('profileGmapsRaw')?.value || prev.rawGmapsInput || '')).trim();
        const rawNotes = (overrides?.notes !== undefined ? overrides.notes : (document.getElementById('japarBuyerNotes')?.value || prev.notes || '')).trim();
        const embedded = overrides?.gps || window.JAPAR_EMBEDDED_DELIVERY_GPS || prev.gps;

        const nextGps = (embedded && !isNaN(embedded.lat) && !isNaN(embedded.lng))
            ? {
                lat: Number(parseFloat(embedded.lat).toFixed(6)),
                lng: Number(parseFloat(embedded.lng).toFixed(6)),
                geohash: String(embedded.geohash || encodeGeohash(Number(embedded.lat), Number(embedded.lng), 6))
            }
            : null;

        const nextObj = {
            name: rawName,
            wa: rawWa,
            address: rawAddr,
            shortStreet: rawShortStreet || rawAddr,
            rawGmapsInput,
            notes: rawNotes,
            gps: nextGps,
            updatedAt: Date.now()
        };

        try {
            localStorage.setItem(BUYER_PROFILE_CACHE_KEY, JSON.stringify(nextObj));
        } catch (e) {}

        // Sinkronkan lintas form Checkout, Halaman Alamat Saya (#page-profile), dan Header
        const syncField = (id, val) => {
            const el = document.getElementById(id);
            if (el && val && document.activeElement !== el) el.value = val;
        };
        syncField('japarBuyerName', nextObj.name);
        syncField('japarBuyerWA', nextObj.wa);
        syncField('japarBuyerAddress', nextObj.address);
        syncField('checkoutGmapsRaw', nextObj.rawGmapsInput);
        syncField('profileBuyerName', nextObj.name);
        syncField('profileBuyerWA', nextObj.wa);
        syncField('profileBuyerAddress', nextObj.address);
        syncField('profileGmapsRaw', nextObj.rawGmapsInput);

        if (nextObj.gps) {
            simpanDanTerapkanGps(nextObj.gps.lat, nextObj.gps.lng, {
                geohash: nextObj.gps.geohash,
                shortStreet: nextObj.shortStreet,
                address: nextObj.address
            });
        } else {
            perbaruiIndikatorGpsHeader(false, nextObj.shortStreet || nextObj.address);
        }
        return nextObj;
    },

    renderBuyerProfilePage: function() {
        const saved = readSavedBuyerProfile();
        const inpName = document.getElementById('profileBuyerName');
        const inpWa = document.getElementById('profileBuyerWA');
        const inpGmaps = document.getElementById('profileGmapsRaw');
        const inpAddr = document.getElementById('profileBuyerAddress');
        const statusInfo = document.getElementById('profileGpsStatusInfo');
        const badgeEl = document.getElementById('profileSavedStatusBadge');

        if (inpName) inpName.value = saved.name || '';
        if (inpWa) inpWa.value = saved.wa || '';
        if (inpGmaps) inpGmaps.value = saved.rawGmapsInput || '';
        if (inpAddr) inpAddr.value = saved.address || '';

        if (badgeEl) {
            badgeEl.textContent = isBuyerProfileComplete() ? 'Tersimpan & Aktif' : 'Belum Lengkap';
        }

        if (statusInfo) {
            if (saved.gps && (saved.shortStreet || saved.address)) {
                statusInfo.classList.remove('hidden');
                statusInfo.innerHTML = `<i class="fa-solid fa-circle-check text-emerald"></i> <b>Titik &amp; Jalan Aktif:</b> ${this._escapeHtml(saved.shortStreet || saved.address)} <span class="text-muted">(${saved.gps.lat.toFixed(6)}, ${saved.gps.lng.toFixed(6)} • Geohash: ${saved.gps.geohash})</span>`;
            } else {
                statusInfo.classList.add('hidden');
            }
        }

        const isComplete = isBuyerProfileComplete();
        this._syncProfilePageLockUI(!isComplete);
    },

    _syncProfilePageLockUI: function(forceUnlock = null) {
        const saved = readSavedBuyerProfile();
        const hasSaved = Boolean(saved.name.length >= 2 && saved.address.length >= 5);
        if (forceUnlock !== null) {
            this._isProfilePageUnlocked = Boolean(forceUnlock);
        } else if (this._isProfilePageUnlocked === undefined) {
            this._isProfilePageUnlocked = !hasSaved;
        }

        const banner = document.getElementById('profileAddressLockBanner');
        const icon = document.getElementById('profileAddressLockIcon');
        const text = document.getElementById('profileAddressLockText');
        const btn = document.getElementById('btnToggleProfileAddressLock');
        const fieldIds = ['profileBuyerName', 'profileBuyerWA', 'profileGmapsRaw', 'profileBuyerAddress'];
        const btnExtract = document.getElementById('btnProfileExtractGmaps');
        const btnDetect = document.getElementById('btnProfileDetectGps');

        if (!banner) return;
        if (!hasSaved && this._isProfilePageUnlocked) {
            banner.classList.add('hidden');
            fieldIds.forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.readOnly = false;
                    el.classList.remove('is-locked-input');
                }
            });
            if (btnExtract) btnExtract.disabled = false;
            if (btnDetect) btnDetect.disabled = false;
            return;
        }

        banner.classList.remove('hidden');
        const locked = !this._isProfilePageUnlocked;
        banner.classList.toggle('is-editing', !locked);
        fieldIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.readOnly = locked;
                el.classList.toggle('is-locked-input', locked);
            }
        });
        if (btnExtract) btnExtract.disabled = locked;
        if (btnDetect) btnDetect.disabled = locked;
        if (icon) icon.className = locked ? 'fa-solid fa-lock' : 'fa-solid fa-lock-open';
        if (text) {
            text.textContent = locked
                ? 'Profil & Alamat Anda dikunci aman agar tidak terubah saat layar digulir'
                : 'Mode Edit Aktif: Silakan ubah Alamat / Titik Google Maps lalu tekan Simpan';
        }
        if (btn) {
            btn.innerHTML = locked
                ? '<i class="fa-solid fa-pen-to-square"></i><span>Ubah Alamat</span>'
                : '<i class="fa-solid fa-lock"></i><span>Kunci Alamat</span>';
        }
    },

    _getMerchantPaymentProfile: function(uidMerchant) {
        let rawProfile = null;
        const matchedMeta = (this._merchantsList || []).find(m => m && m.uid === uidMerchant) || this._activeMerchantMeta || null;

        if (this._activeMerchantDoc && this._activeMerchantDoc.uid === uidMerchant && this._activeMerchantDoc.profile) {
            rawProfile = this._activeMerchantDoc.profile;
        }
        if (!rawProfile && uidMerchant && this._memoryMenuCache[uidMerchant]?.profile) {
            rawProfile = this._memoryMenuCache[uidMerchant].profile;
        }
        if (!rawProfile && uidMerchant) {
            try {
                const rawLocal = localStorage.getItem(MENU_DOC_STORAGE_PREFIX + uidMerchant);
                if (rawLocal) {
                    const parsed = JSON.parse(rawLocal);
                    if (parsed && parsed.profile) {
                        rawProfile = parsed.profile;
                    }
                }
            } catch (e) {}
        }

        const p = rawProfile || {};
        const rawWa = String(p.wa || p.noWa || p.whatsapp || '').trim();
        const waNorm = OrderWAValidator.normalizeWA(rawWa);

        const wajibDp = (p.wajibDp !== undefined)
            ? Boolean(p.wajibDp)
            : Boolean(matchedMeta ? matchedMeta.dp : false);

        const dpMin = Math.max(5000, Number(p.dpMin ?? p.minDp ?? 10000) || 10000);
        const qrisPublicId = bersihkanPublicIdCloudinary(p.qrisPublicId || p.qrisCloudinaryId || p.qrisImg || p.qris || '');

        const ewalletObj = (p.ewallet && typeof p.ewallet === 'object') ? p.ewallet : {};
        const ewallet = {
            provider: String(ewalletObj.provider || p.ewalletProvider || '').trim(),
            number: String(ewalletObj.number || p.ewalletNumber || '').trim(),
            holder: String(ewalletObj.holder || ewalletObj.name || p.ewalletName || p.ewalletHolder || '').trim()
        };

        const bankObj = (p.bank && typeof p.bank === 'object') ? p.bank : {};
        const bank = {
            name: String(bankObj.name || p.bankName || '').trim(),
            number: String(bankObj.number || p.bankNumber || '').trim(),
            holder: String(bankObj.holder || p.bankHolder || '').trim()
        };

        const kurirWarungAktif = Boolean(p.kurirWarungAktif);
        const melayaniTakeaway = p.melayaniTakeaway !== undefined
            ? Boolean(p.melayaniTakeaway)
            : (matchedMeta ? matchedMeta.canTakeaway !== false : true);
        const melayaniDineIn = p.melayaniDineIn !== undefined
            ? Boolean(p.melayaniDineIn)
            : (matchedMeta ? matchedMeta.canDineIn !== false : true);
        const tarifOngkir = p.tarifOngkir !== undefined ? Math.max(0, Number(p.tarifOngkir) || 0) : null;
        const infoOngkirWarung = String(p.infoOngkirWarung || 'Ongkir sesuai pengantaran kurir resto').trim();

        return {
            wa: waNorm.cleanNumber || rawWa.replace(/[^0-9]/g, '').replace(/^0/, '62'),
            wajibDp,
            dpMin,
            qrisPublicId,
            ewallet,
            bank,
            kurirWarungAktif,
            melayaniTakeaway,
            melayaniDineIn,
            tarifOngkir,
            infoOngkirWarung
        };
    },

    _generateOrderRefCode: function() {
        const rand4 = Math.floor(1000 + Math.random() * 9000);
        return `#JPR-${rand4}`;
    },

    _copyTextToClipboard: function(text, labelInfo = 'Nomor pembayaran') {
        const val = String(text || '').trim();
        if (!val) return;
        const notifyCopied = () => {
            picuGetarSentuh(18);
            this.showNotice(`${labelInfo} berhasil disalin ke papan klip.`, 'BERHASIL DISALIN');
        };
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(val).then(notifyCopied).catch(() => {
                this._fallbackCopyText(val);
                notifyCopied();
            });
        } else {
            this._fallbackCopyText(val);
            notifyCopied();
        }
    },

    _fallbackCopyText: function(val) {
        try {
            const ta = document.createElement('textarea');
            ta.value = val;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        } catch (e) {}
    },

    isBuyerProfileComplete: function() {
        return isBuyerProfileComplete();
    },

    openBuyerOnboardingModal: function(onCompletedCallback = null) {
        this._pendingOnboardingCallback = typeof onCompletedCallback === 'function' ? onCompletedCallback : null;
        const modal = document.getElementById('japarBuyerOnboardingModal');
        if (!modal) {
            if (typeof onCompletedCallback === 'function') onCompletedCallback();
            return;
        }
        const saved = readSavedBuyerProfile();
        const inpName = document.getElementById('onboardBuyerName');
        const inpWa = document.getElementById('onboardBuyerWA');
        const inpRaw = document.getElementById('onboardGmapsRaw');
        const inpAddr = document.getElementById('onboardBuyerAddress');
        const statusInfo = document.getElementById('onboardGpsStatusInfo');

        if (inpName && saved.name) inpName.value = saved.name;
        if (inpWa && saved.wa) inpWa.value = saved.wa;
        if (inpRaw && saved.rawGmapsInput) inpRaw.value = saved.rawGmapsInput;
        if (inpAddr && saved.address) inpAddr.value = saved.address;
        if (statusInfo) {
            if (saved.gps && saved.shortStreet) {
                statusInfo.classList.remove('hidden');
                statusInfo.innerHTML = `<i class="fa-solid fa-circle-check text-emerald"></i> <b>Lokasi Tersimpan:</b> ${this._escapeHtml(saved.shortStreet)} (${saved.gps.lat.toFixed(5)}, ${saved.gps.lng.toFixed(5)})`;
            } else {
                statusInfo.classList.add('hidden');
            }
        }
        modal.classList.remove('hidden');
        setTimeout(() => {
            if (inpName && !inpName.value.trim()) inpName.focus();
            else if (inpAddr && !inpAddr.value.trim()) inpAddr.focus();
        }, 60);
    },

    openCheckoutPage: async function() {
        if (!this.isBuyerProfileComplete()) {
            this.openBuyerOnboardingModal(async () => {
                JaparPageRouter.navigateTo('checkout');
                await this.renderCheckoutPage(true);
            });
            return;
        }
        JaparPageRouter.navigateTo('checkout');
        await this.renderCheckoutPage(true);
    },

    renderCheckoutPage: async function(generateNewRef = false) {
        const summary = this.getCartSummary();
        const emptyStateEl = document.getElementById('checkoutEmptyState');
        const activeContentEl = document.getElementById('checkoutActiveContent');
        const stNameEl = document.getElementById('japarCheckoutStoreName');

        if (summary.totalQty === 0 || summary.orderItems.length === 0) {
            if (emptyStateEl) emptyStateEl.classList.remove('hidden');
            if (activeContentEl) activeContentEl.classList.add('hidden');
            if (stNameEl) stNameEl.textContent = 'Belum ada hidangan dipilih';
            return;
        }

        if (emptyStateEl) emptyStateEl.classList.add('hidden');
        if (activeContentEl) activeContentEl.classList.remove('hidden');

        if (!this._activeMerchantDoc || this._activeMerchantDoc.uid !== summary.uidMerchant) {
            const matchedMeta = (this._merchantsList || []).find(m => m && m.uid === summary.uidMerchant);
            const expectedV = matchedMeta ? Number(matchedMeta.v || 0) : 0;
            const preferredNd = matchedMeta?.nd || this._rawOpenIndexMap?.[summary.uidMerchant]?.nd || 'N1';
            const docLoaded = await this._getOrLoadMerchantDoc(summary.uidMerchant, expectedV, preferredNd);
            if (docLoaded) {
                this._activeMerchantDoc = docLoaded;
            }
        }
        if (this._activeMerchantDoc && this._activeMerchantDoc.uid === summary.uidMerchant) {
            const fullAlamatCheckout = String(this._activeMerchantDoc.profile?.alamat || '').trim().substring(0, 120);
            if (fullAlamatCheckout) {
                this._cart.storeAddress = fullAlamatCheckout;
                summary.storeAddress = fullAlamatCheckout;
                if (this._activeMerchantMeta && this._activeMerchantMeta.uid === summary.uidMerchant) {
                    this._activeMerchantMeta.addr = fullAlamatCheckout;
                }
                this._persistCart();
            }
        }

        const profile = this._getMerchantPaymentProfile(summary.uidMerchant);
        const wajibDp = Boolean(profile.wajibDp);
        const dpMin = Math.max(5000, Number(profile.dpMin) || 10000);
        const totalValue = summary.totalValue;
        const isAutoFullPayment = wajibDp && (totalValue <= dpMin);

        const availableTransferChannels = [];
        if (profile.qrisPublicId) {
            availableTransferChannels.push({ id: 'QRIS', label: 'QRIS Resmi Resto' });
        }
        if (profile.ewallet && profile.ewallet.provider && profile.ewallet.number) {
            availableTransferChannels.push({
                id: 'EWALLET',
                label: `E-Wallet ${profile.ewallet.provider} (${profile.ewallet.number} a.n. ${profile.ewallet.holder || summary.storeName})`
            });
        }
        if (profile.bank && profile.bank.name && profile.bank.number) {
            availableTransferChannels.push({
                id: 'BANK',
                label: `Bank ${profile.bank.name} (${profile.bank.number} a.n. ${profile.bank.holder || summary.storeName})`
            });
        }

        const hasTransferChannels = availableTransferChannels.length > 0;
        const defaultTransferChannel = hasTransferChannels
            ? availableTransferChannels[0].label
            : 'Transfer / QRIS Sesuai Konfirmasi WhatsApp Resto';

        const prevScheme = (!generateNewRef && this._activeCheckoutState) ? this._activeCheckoutState.payScheme : null;
        let resolvedScheme = wajibDp
            ? (isAutoFullPayment ? 'FULL' : (prevScheme === 'FULL' ? 'FULL' : 'DP_MIN'))
            : (prevScheme === 'TRANSFER_LUNAS' && hasTransferChannels ? 'TRANSFER_LUNAS' : 'TUNAI');

        let initialDelivery = this._preferredReceiveMethod || 'KURIR_WARUNG';
        if (initialDelivery === 'KURIR_WARUNG' && !profile.kurirWarungAktif) {
            initialDelivery = profile.melayaniTakeaway ? 'AMBIL_SENDIRI' : (profile.melayaniDineIn ? 'MAKAN_DI_TEMPAT' : 'AMBIL_SENDIRI');
        }
        if (initialDelivery === 'AMBIL_SENDIRI' && !profile.melayaniTakeaway) {
            initialDelivery = profile.kurirWarungAktif ? 'KURIR_WARUNG' : (profile.melayaniDineIn ? 'MAKAN_DI_TEMPAT' : 'KURIR_WARUNG');
        }
        if (initialDelivery === 'MAKAN_DI_TEMPAT' && !profile.melayaniDineIn) {
            initialDelivery = profile.kurirWarungAktif ? 'KURIR_WARUNG' : 'AMBIL_SENDIRI';
        }

        const existingRef = (this._activeCheckoutState && this._activeCheckoutState.refCode && !generateNewRef)
            ? this._activeCheckoutState.refCode
            : this._generateOrderRefCode();

        this._activeCheckoutState = {
            refCode: existingRef,
            summary,
            profile,
            wajibDp,
            dpMin,
            totalValue,
            isAutoFullPayment,
            hasTransferChannels,
            availableTransferChannels,
            payScheme: resolvedScheme,
            selectedTransferChannel: (this._activeCheckoutState && this._activeCheckoutState.selectedTransferChannel)
                ? this._activeCheckoutState.selectedTransferChannel
                : defaultTransferChannel,
            nominalTransferAwal: 0,
            sisaBayar: 0,
            deliveryMethod: initialDelivery
        };

        const refBadge = document.getElementById('japarCheckoutRefCodeBadge');
        if (refBadge) refBadge.textContent = this._activeCheckoutState.refCode;
        if (stNameEl) stNameEl.textContent = summary.storeName;
        const stAddrEl = document.getElementById('japarCheckoutStoreAddress');
        if (stAddrEl) stAddrEl.textContent = summary.storeAddress || summary.storeName;
        const btnMapsLink = document.getElementById('btnCheckoutStoreMapsLink');
        if (btnMapsLink) {
            btnMapsLink.href = this._buildStoreGmapsUrl(summary.storeLat, summary.storeLng, summary.storeName);
        }

        const qtyBadgeEl = document.getElementById('japarCheckoutTotalQtyBadge');
        if (qtyBadgeEl) qtyBadgeEl.textContent = `${summary.totalQty} Porsi`;
        const totalValEl = document.getElementById('japarCheckoutTotalValue');
        if (totalValEl) totalValEl.textContent = this._formatRp(totalValue);
        const savedInfoEl = document.getElementById('japarCheckoutSavedInfo');
        if (savedInfoEl) {
            if (summary.totalSaved > 0) {
                savedInfoEl.classList.remove('hidden');
                savedInfoEl.textContent = `Hemat Potongan Diskon: ${this._formatRp(summary.totalSaved)}`;
            } else {
                savedInfoEl.classList.add('hidden');
            }
        }

        // Render Daftar Item + Editor Kustomisasi Paket & Catatan di Halaman Checkout
        const itemsListEl = document.getElementById('japarCheckoutItemsList');
        if (itemsListEl) {
            itemsListEl.innerHTML = '';
            summary.orderItems.forEach(it => {
                const row = document.createElement('div');
                row.className = 'checkout-editable-item-row';
                const origMarkup = it.originalPrice > it.basePrice
                    ? `<span style="text-decoration: line-through; color: var(--text-subtle); margin-left: 4px;">${this._formatRp(it.originalPrice)}</span>`
                    : '';
                const addonMarkup = it.totalAddonPrice > 0
                    ? ` <span class="text-amber">(+Opsi ${this._formatRp(it.totalAddonPrice)})</span>`
                    : '';
                const descLineHtml = it.desc
                    ? `<div class="menu-item-package-desc" style="margin-top: 3px;"><i class="fa-solid fa-utensils text-emerald"></i> <span><b>Isi:</b> ${this._escapeHtml(it.desc)}</span></div>`
                    : '';

                row.innerHTML = `
                    <div class="checkout-item-top-bar">
                        <div style="flex: 1; min-width: 0;">
                            <div class="font-bold text-main" style="font-size: 0.82rem; line-height: 1.3;">${this._escapeHtml(it.name)}</div>
                            ${descLineHtml}
                            <div class="text-muted checkout-item-price-meta" data-item-id="${this._escapeHtml(it.id)}" style="font-size: 0.68rem; margin-top: 2px;">${this._formatRp(it.basePrice)}${origMarkup} / porsi${addonMarkup} • Subtotal: <b class="text-emerald">${this._formatRp(it.subtotal)}</b></div>
                        </div>
                        <div class="qty-stepper-control">
                            <button type="button" class="btn-qty-step is-minus" aria-label="Kurangi"><i class="fa-solid ${it.qty <= 1 ? 'fa-trash-can' : 'fa-minus'}"></i></button>
                            <span class="font-tech font-bold text-main" style="font-size: 0.8rem; min-width: 16px; text-align: center;">${it.qty}</span>
                            <button type="button" class="btn-qty-step is-plus" aria-label="Tambah"><i class="fa-solid fa-plus"></i></button>
                        </div>
                    </div>
                    <div class="item-note-editor-box"></div>
                `;

                const noteBoxEl = row.querySelector('.item-note-editor-box');
                this._bindItemNoteEditorBoxEvents(noteBoxEl, it.id, it.name, it.kat);

                const btnMin = row.querySelector('.is-minus');
                const btnPlus = row.querySelector('.is-plus');
                if (btnMin) {
                    btnMin.addEventListener('click', () => {
                        picuGetarSentuh(10);
                        this._adjustCheckoutCartItemById(it.id, -1);
                    });
                }
                if (btnPlus) {
                    btnPlus.addEventListener('click', () => {
                        picuGetarSentuh(12);
                        this._adjustCheckoutCartItemById(it.id, 1);
                    });
                }
                itemsListEl.appendChild(row);
            });
        }

        try {
            const rawSavedBuyer = localStorage.getItem(BUYER_PROFILE_CACHE_KEY);
            if (rawSavedBuyer) {
                const savedBuyer = JSON.parse(rawSavedBuyer);
                const inpName = document.getElementById('japarBuyerName');
                const inpWa = document.getElementById('japarBuyerWA');
                const inpAddr = document.getElementById('japarBuyerAddress');
                const inpGmapsRaw = document.getElementById('checkoutGmapsRaw');
                const inpNotes = document.getElementById('japarBuyerNotes');
                if (inpName && !inpName.value && savedBuyer.name) inpName.value = savedBuyer.name;
                if (inpWa && !inpWa.value && savedBuyer.wa) inpWa.value = savedBuyer.wa;
                if (inpAddr && !inpAddr.value && savedBuyer.address) inpAddr.value = savedBuyer.address;
                if (inpGmapsRaw && !inpGmapsRaw.value && savedBuyer.rawGmapsInput) inpGmapsRaw.value = savedBuyer.rawGmapsInput;
                if (inpNotes && !inpNotes.value && savedBuyer.notes) inpNotes.value = savedBuyer.notes;
                if (savedBuyer.gps && !isNaN(savedBuyer.gps.lat) && !isNaN(savedBuyer.gps.lng) && !window.JAPAR_EMBEDDED_DELIVERY_GPS) {
                    window.JAPAR_EMBEDDED_DELIVERY_GPS = {
                        lat: Number(savedBuyer.gps.lat),
                        lng: Number(savedBuyer.gps.lng)
                    };
                }
            }
        } catch (e) {}
        const hasLoadedName = Boolean((document.getElementById('japarBuyerName')?.value || '').trim().length >= 2);
        const hasLoadedAddr = Boolean((document.getElementById('japarBuyerAddress')?.value || '').trim().length >= 5);
        this._syncSavedBuyerProfileLocksUI(!hasLoadedName, !hasLoadedAddr);

        this._refreshDeliveryMethodUI();
        this._renderDynamicPaymentSection();
        this._updatePaymentBreakdownAndChannelsUI();
        this._updateLiveWaReceiptPreview();
    },

    _refreshDeliveryMethodUI: function() {
        const st = this._activeCheckoutState;
        if (!st) return;

        const isKurirActive = Boolean(st.profile.kurirWarungAktif);
        const isTakeawayActive = st.profile.melayaniTakeaway !== false;
        const isDineInActive = st.profile.melayaniDineIn !== false;

        const optKurir = document.getElementById('optDeliveryKurirWarung');
        const cardKurir = document.getElementById('cardDeliveryKurirWarung');
        const badgeKurir = document.getElementById('badgeDeliveryKurirStatus');
        const infoKurir = document.getElementById('japarKurirWarungOngkirInfo');

        const optAmbil = document.getElementById('optDeliveryAmbilSendiri');
        const cardAmbil = document.getElementById('cardDeliveryAmbilSendiri');

        const optDineIn = document.getElementById('optDeliveryMakanDiTempat');
        const cardDineIn = document.getElementById('cardDeliveryMakanDiTempat');

        const addrSection = document.getElementById('japarDeliveryAddressSection');
        const dineInDetailsBox = document.getElementById('japarDineInDetailsBox');
        const packagingWrap = document.getElementById('japarPackagingPrefsWrap');
        const pickupAddrBox = document.getElementById('japarPickupStoreAddressBox');
        const pickupBoxTitle = document.getElementById('japarPickupBoxTitle');
        const distBadge = document.getElementById('japarDeliveryDistanceBadge');

        if (distBadge && st.summary.storeLat && st.summary.storeLng) {
            const refC = this._getUserRefCoord();
            const dKm = hitungJarakHaversineKm(refC.lat, refC.lng, st.summary.storeLat, st.summary.storeLng);
            distBadge.textContent = dKm < 100 ? `Jarak ~${dKm.toFixed(2)} km` : '';
        }

        if (optKurir && cardKurir && badgeKurir && infoKurir) {
            optKurir.disabled = !isKurirActive;
            cardKurir.style.opacity = isKurirActive ? '1' : '0.52';
            cardKurir.style.cursor = isKurirActive ? 'pointer' : 'not-allowed';
            badgeKurir.textContent = isKurirActive ? 'TERSEDIA' : 'NONAKTIF';
            badgeKurir.style.background = isKurirActive ? 'var(--go-green-soft)' : 'var(--surface-3)';
            badgeKurir.style.color = isKurirActive ? 'var(--go-green)' : 'var(--text-subtle)';
            infoKurir.textContent = isKurirActive
                ? `${st.profile.infoOngkirWarung || 'Ongkir sesuai pengantaran kurir resto'}`
                : 'Layanan pengantaran kurir internal tidak diaktifkan pada tempat usaha ini.';
        }

        if (cardAmbil && optAmbil) {
            optAmbil.disabled = !isTakeawayActive;
            cardAmbil.classList.toggle('hidden', !isTakeawayActive && (isKurirActive || isDineInActive));
        }

        if (cardDineIn && optDineIn) {
            optDineIn.disabled = !isDineInActive;
            cardDineIn.classList.toggle('hidden', !isDineInActive);
        }

        if (!isKurirActive && st.deliveryMethod === 'KURIR_WARUNG') {
            st.deliveryMethod = isTakeawayActive ? 'AMBIL_SENDIRI' : 'MAKAN_DI_TEMPAT';
        }
        if (!isDineInActive && st.deliveryMethod === 'MAKAN_DI_TEMPAT') {
            st.deliveryMethod = isKurirActive ? 'KURIR_WARUNG' : 'AMBIL_SENDIRI';
        }

        this._preferredReceiveMethod = st.deliveryMethod;

        if (optKurir) optKurir.checked = (st.deliveryMethod === 'KURIR_WARUNG');
        if (optAmbil) optAmbil.checked = (st.deliveryMethod === 'AMBIL_SENDIRI');
        if (optDineIn) optDineIn.checked = (st.deliveryMethod === 'MAKAN_DI_TEMPAT');

        if (cardKurir) {
            const activeK = st.deliveryMethod === 'KURIR_WARUNG';
            cardKurir.style.borderColor = activeK ? 'var(--go-green)' : 'var(--border-soft)';
            cardKurir.style.background = activeK ? 'var(--go-green-soft)' : 'var(--surface-2)';
        }
        if (cardAmbil) {
            const activeA = st.deliveryMethod === 'AMBIL_SENDIRI';
            cardAmbil.style.borderColor = activeA ? 'var(--go-green)' : 'var(--border-soft)';
            cardAmbil.style.background = activeA ? 'var(--go-green-soft)' : 'var(--surface-2)';
        }
        if (cardDineIn) {
            const activeD = st.deliveryMethod === 'MAKAN_DI_TEMPAT';
            cardDineIn.style.borderColor = activeD ? 'var(--go-green)' : 'var(--border-soft)';
            cardDineIn.style.background = activeD ? 'var(--go-green-soft)' : 'var(--surface-2)';
        }

        if (addrSection) {
            addrSection.style.display = (st.deliveryMethod === 'KURIR_WARUNG') ? 'flex' : 'none';
        }
        if (dineInDetailsBox) {
            dineInDetailsBox.classList.toggle('hidden', st.deliveryMethod !== 'MAKAN_DI_TEMPAT');
        }
        if (packagingWrap) {
            packagingWrap.classList.toggle('hidden', st.deliveryMethod === 'MAKAN_DI_TEMPAT');
        }
        if (pickupAddrBox) {
            const isAtStore = (st.deliveryMethod === 'AMBIL_SENDIRI' || st.deliveryMethod === 'MAKAN_DI_TEMPAT');
            pickupAddrBox.classList.toggle('hidden', !isAtStore);
            if (pickupBoxTitle) {
                pickupBoxTitle.innerHTML = st.deliveryMethod === 'MAKAN_DI_TEMPAT'
                    ? `<i class="fa-solid fa-utensils text-emerald"></i> Lokasi Makan di Tempat (Resto):`
                    : `<i class="fa-solid fa-location-dot text-emerald"></i> Lokasi Pengambilan Pesanan:`;
            }
        }

        this._updateLiveWaReceiptPreview();
    },

    _renderDynamicPaymentSection: function() {
        const st = this._activeCheckoutState;
        if (!st) return;

        const ruleBadge = document.getElementById('japarDpRuleBadge');
        const noticeEl = document.getElementById('japarDpChoiceNotice');
        const optionsWrap = document.getElementById('japarPaymentSchemeOptions');
        const payMethodsBox = document.getElementById('japarMerchantPaymentMethodsBox');

        if (!optionsWrap || !payMethodsBox) return;

        if (st.wajibDp) {
            if (ruleBadge) {
                ruleBadge.className = 'japar-dp-badge is-require-dp';
                ruleBadge.textContent = `Wajib DP (Min. ${this._formatRp(st.dpMin)})`;
            }

            if (st.isAutoFullPayment) {
                st.payScheme = 'FULL';
                if (noticeEl) {
                    noticeEl.innerHTML = `Total harga hidangan (<b>${this._formatRp(st.totalValue)}</b>) tidak melebihi batas minimal DP resto (<b>${this._formatRp(st.dpMin)}</b>), sehingga dikunci ke <b>Bayar Lunas</b>.`;
                }
                optionsWrap.innerHTML = `
                    <label style="display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-radius: 12px; border: 1.5px solid var(--go-green); background: var(--go-green-soft); cursor: default;">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <input type="radio" name="japarPaySchemeRadio" value="FULL" checked disabled style="accent-color: var(--go-green);">
                            <span class="font-tech text-main font-bold" style="font-size: 0.76rem;">Bayar Lunas</span>
                        </div>
                        <span class="font-tech font-bold text-emerald" style="font-size: 0.86rem;">${this._formatRp(st.totalValue)}</span>
                    </label>
                `;
            } else {
                if (noticeEl) {
                    noticeEl.innerHTML = `Pilih skema pembayaran awal untuk memproses pesanan Anda:`;
                }
                optionsWrap.innerHTML = `
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 7px;">
                        <label id="cardSchemeDpMin" style="display: flex; flex-direction: column; gap: 3px; padding: 9px 11px; border-radius: 12px; border: 1.5px solid var(--go-green); background: var(--go-green-soft); cursor: pointer;">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <input type="radio" name="japarPaySchemeRadio" value="DP_MIN" ${st.payScheme === 'DP_MIN' ? 'checked' : ''} style="accent-color: var(--go-green);">
                                <span class="font-tech text-main font-bold" style="font-size: 0.72rem;">Transfer DP Minimal</span>
                            </div>
                            <span class="font-tech font-bold text-emerald" style="font-size: 0.84rem; padding-left: 20px;">${this._formatRp(st.dpMin)}</span>
                        </label>
                        <label id="cardSchemeFull" style="display: flex; flex-direction: column; gap: 3px; padding: 9px 11px; border-radius: 12px; border: 1px solid var(--border-soft); background: var(--surface-2); cursor: pointer;">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <input type="radio" name="japarPaySchemeRadio" value="FULL" ${st.payScheme === 'FULL' ? 'checked' : ''} style="accent-color: var(--go-green);">
                                <span class="font-tech text-main font-bold" style="font-size: 0.72rem;">Bayar Lunas</span>
                            </div>
                            <span class="font-tech font-bold text-main" style="font-size: 0.84rem; padding-left: 20px;">${this._formatRp(st.totalValue)}</span>
                        </label>
                    </div>
                `;
            }
        } else {
            if (ruleBadge) {
                ruleBadge.className = 'japar-dp-badge is-no-dp';
                ruleBadge.textContent = 'Bayar di Tempat';
            }
            if (noticeEl) {
                noticeEl.innerHTML = `Pilih skema pembayaran yang Anda inginkan:`;
            }

            const transferOptionHtml = st.hasTransferChannels
                ? `<label id="cardSchemeTransferLunas" style="display: flex; align-items: flex-start; gap: 9px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--border-soft); background: var(--surface-2); cursor: pointer;">
                        <input type="radio" name="japarPaySchemeRadio" value="TRANSFER_LUNAS" ${st.payScheme === 'TRANSFER_LUNAS' ? 'checked' : ''} style="margin-top: 3px; accent-color: var(--go-green);">
                        <div style="flex: 1; min-width: 0;">
                            <div class="font-tech text-main font-bold" style="font-size: 0.76rem;">Transfer Lunas (QRIS / E-Wallet / Bank)</div>
                            <div class="text-muted" style="font-size: 0.67rem; margin-top: 2px;">Transfer penuh sebesar <b>${this._formatRp(st.totalValue)}</b> ke kanal pembayaran resmi resto.</div>
                        </div>
                   </label>`
                : '';

            optionsWrap.innerHTML = `
                <label id="cardSchemeTunai" style="display: flex; align-items: flex-start; gap: 9px; padding: 10px 12px; border-radius: 12px; border: 1.5px solid var(--go-green); background: var(--go-green-soft); cursor: pointer;">
                    <input type="radio" name="japarPaySchemeRadio" value="TUNAI" ${st.payScheme === 'TUNAI' ? 'checked' : ''} style="margin-top: 3px; accent-color: var(--go-green);">
                    <div style="flex: 1; min-width: 0;">
                        <div class="font-tech text-main font-bold" style="font-size: 0.76rem;">Bayar Tunai di Tempat / Saat Diterima</div>
                        <div class="text-muted" style="font-size: 0.67rem; margin-top: 2px;">Transfer awal Rp 0 • Pembayaran dilakukan saat pesanan disajikan, diambil, atau diantar.</div>
                    </div>
                </label>
                ${transferOptionHtml}
            `;
        }

        optionsWrap.querySelectorAll('input[name="japarPaySchemeRadio"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                if (!this._activeCheckoutState) return;
                this._activeCheckoutState.payScheme = e.target.value;
                this._updatePaymentBreakdownAndChannelsUI();
            });
        });

        this._renderOfficialPaymentChannels(payMethodsBox);
        this._updatePaymentBreakdownAndChannelsUI();
    },

    _renderOfficialPaymentChannels: function(payBox) {
        const st = this._activeCheckoutState;
        if (!st || !payBox) return;

        const p = st.profile;
        const blocks = [];

        if (p.qrisPublicId) {
            const qrisUrl = this._buildPhotoUrl(p.qrisPublicId, 'QRIS', 400);
            blocks.push(`
                <div style="background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: 13px; padding: 11px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 9px; gap: 6px; flex-wrap: wrap;">
                        <label style="display: flex; align-items: center; gap: 7px; cursor: pointer; font-family: 'Outfit', sans-serif; font-size: 0.74rem; font-weight: 800; color: var(--text-primary);">
                            <input type="radio" name="japarMerchantPayChannel" value="QRIS Resmi Resto" ${st.selectedTransferChannel === 'QRIS Resmi Resto' ? 'checked' : ''} style="accent-color: var(--go-green);">
                            <i class="fa-solid fa-qrcode text-emerald"></i> QRIS RESMI RESTO
                        </label>
                        <button type="button" class="btn-zoom-qris btn-text-action" data-qris-url="${this._escapeHtml(qrisUrl)}">
                            <i class="fa-solid fa-magnifying-glass-plus"></i> Perbesar QRIS
                        </button>
                    </div>
                    <div class="btn-zoom-qris" data-qris-url="${this._escapeHtml(qrisUrl)}" style="position: relative; width: 160px; height: 160px; margin: 0 auto; border-radius: 12px; overflow: hidden; border: 1px solid var(--border-soft); background: #ffffff; cursor: pointer;" oncontextmenu="return false;" title="Ketuk untuk memperbesar QRIS">
                        <img src="${qrisUrl}" referrerpolicy="no-referrer" alt="QRIS Resto" style="width: 100%; height: 100%; object-fit: contain; display: block;" draggable="false" oncontextmenu="return false;">
                        <div class="image-protect-layer" oncontextmenu="return false;"></div>
                    </div>
                </div>
            `);
        }

        if (p.ewallet && p.ewallet.provider && p.ewallet.number) {
            const ewLabel = `E-Wallet ${p.ewallet.provider} (${p.ewallet.number} a.n. ${p.ewallet.holder || st.summary.storeName})`;
            const isChecked = st.selectedTransferChannel === ewLabel || (!p.qrisPublicId && st.selectedTransferChannel.includes(p.ewallet.provider));
            blocks.push(`
                <div style="background: var(--surface-2); border: 1px solid var(--border-soft); border-radius: 12px; padding: 9px 11px; display: flex; align-items: center; justify-content: space-between; gap: 9px;">
                    <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer; flex: 1; min-width: 0;">
                        <input type="radio" name="japarMerchantPayChannel" value="${this._escapeHtml(ewLabel)}" ${isChecked ? 'checked' : ''} style="margin-top: 3px; accent-color: var(--go-green);">
                        <div style="min-width: 0;">
                            <div class="font-tech text-emerald font-bold" style="font-size: 0.7rem;"><i class="fa-solid fa-mobile-screen-button"></i> E-WALLET ${this._escapeHtml(p.ewallet.provider)}</div>
                            <div class="font-tech text-main font-bold" style="font-size: 0.82rem; margin-top: 1px;">${this._escapeHtml(p.ewallet.number)}</div>
                            <div class="text-muted" style="font-size: 0.65rem;">a.n. ${this._escapeHtml(p.ewallet.holder || st.summary.storeName)}</div>
                        </div>
                    </label>
                    <button type="button" class="btn-copy-merchant-rek" data-copy-val="${this._escapeHtml(p.ewallet.number)}" data-copy-label="Nomor ${this._escapeHtml(p.ewallet.provider)}" style="background: var(--go-green-soft); border: 1px solid var(--go-green-border); color: var(--go-green); border-radius: 999px; padding: 5px 11px; font-size: 0.66rem; font-weight: 700; cursor: pointer; flex-shrink: 0;">
                        <i class="fa-regular fa-copy"></i> Salin
                    </button>
                </div>
            `);
        }

        if (p.bank && p.bank.name && p.bank.number) {
            const bkLabel = `Bank ${p.bank.name} (${p.bank.number} a.n. ${p.bank.holder || st.summary.storeName})`;
            const isDefaultChecked = !p.qrisPublicId && !(p.ewallet && p.ewallet.provider && p.ewallet.number);
            blocks.push(`
                <div style="background: var(--surface-2); border: 1px solid var(--border-soft); border-radius: 12px; padding: 9px 11px; display: flex; align-items: center; justify-content: space-between; gap: 9px;">
                    <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer; flex: 1; min-width: 0;">
                        <input type="radio" name="japarMerchantPayChannel" value="${this._escapeHtml(bkLabel)}" ${isDefaultChecked ? 'checked' : ''} style="margin-top: 3px; accent-color: var(--go-green);">
                        <div style="min-width: 0;">
                            <div class="font-tech text-main font-bold" style="font-size: 0.7rem;"><i class="fa-solid fa-building-columns text-emerald"></i> BANK ${this._escapeHtml(p.bank.name)}</div>
                            <div class="font-tech text-main font-bold" style="font-size: 0.82rem; margin-top: 1px;">${this._escapeHtml(p.bank.number)}</div>
                            <div class="text-muted" style="font-size: 0.65rem;">a.n. ${this._escapeHtml(p.bank.holder || st.summary.storeName)}</div>
                        </div>
                    </label>
                    <button type="button" class="btn-copy-merchant-rek" data-copy-val="${this._escapeHtml(p.bank.number)}" data-copy-label="Rekening ${this._escapeHtml(p.bank.name)}" style="background: var(--go-green-soft); border: 1px solid var(--go-green-border); color: var(--go-green); border-radius: 999px; padding: 5px 11px; font-size: 0.66rem; font-weight: 700; cursor: pointer; flex-shrink: 0;">
                        <i class="fa-regular fa-copy"></i> Salin
                    </button>
                </div>
            `);
        }

        if (blocks.length === 0) {
            blocks.push(`
                <div style="background: var(--surface-2); border: 1px dashed var(--border-strong); border-radius: 10px; padding: 9px 11px; font-size: 0.68rem; color: var(--text-secondary);">
                    <i class="fa-solid fa-circle-info text-emerald"></i> Rincian rekening atau QRIS pembayaran akan diinformasikan langsung melalui WhatsApp Resto.
                </div>
            `);
        }

        payBox.innerHTML = blocks.join('');

        payBox.querySelectorAll('input[name="japarMerchantPayChannel"]').forEach(radio => {
            if (radio.checked) st.selectedTransferChannel = radio.value;
            radio.addEventListener('change', (e) => {
                if (e.target.checked) {
                    st.selectedTransferChannel = e.target.value;
                    this._updateLiveWaReceiptPreview();
                }
            });
        });

        payBox.querySelectorAll('.btn-copy-merchant-rek').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._copyTextToClipboard(btn.getAttribute('data-copy-val'), btn.getAttribute('data-copy-label'));
            });
        });

        payBox.querySelectorAll('.btn-zoom-qris').forEach(el => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                picuGetarSentuh(10);
                const url = el.getAttribute('data-qris-url');
                if (url) {
                    this.openQrisPreviewModal(url, st.summary.storeName);
                }
            });
        });
    },

    _updatePaymentBreakdownAndChannelsUI: function() {
        const st = this._activeCheckoutState;
        if (!st) return;

        let estDistKm = null;
        if (st.summary && st.summary.storeLat && st.summary.storeLng) {
            const embedded = window.JAPAR_EMBEDDED_DELIVERY_GPS;
            const activeGps = getKoordinatPelangganAktif();
            const tLat = (embedded && !isNaN(embedded.lat)) ? embedded.lat : activeGps?.lat;
            const tLng = (embedded && !isNaN(embedded.lng)) ? embedded.lng : activeGps?.lng;
            if (tLat && tLng) {
                const d = hitungJarakHaversineKm(tLat, tLng, st.summary.storeLat, st.summary.storeLng);
                if (d < 100) estDistKm = Number(d.toFixed(2));
            }
        }

        const isKurirDelivery = st.deliveryMethod === 'KURIR_WARUNG';
        const parsedOngkir = isKurirDelivery
            ? this._parseDeliveryFeeDetails(st.profile, estDistKm)
            : { nominal: 0, isNumeric: true, displayLabel: 'Rp 0 (Tanpa Ongkir)', rawNote: '' };

        st.ongkirNominal = isKurirDelivery ? parsedOngkir.nominal : 0;
        st.ongkirDisplayLabel = parsedOngkir.displayLabel;
        st.ongkirIsNumeric = parsedOngkir.isNumeric;
        st.grandTotalValue = st.totalValue + st.ongkirNominal;

        const ongkirRowEl = document.getElementById('japarCheckoutOngkirRow');
        const ongkirValEl = document.getElementById('japarCheckoutOngkirValue');
        const grandTotalValEl = document.getElementById('japarCheckoutGrandTotalValue');
        if (ongkirRowEl && ongkirValEl) {
            if (isKurirDelivery) {
                ongkirRowEl.classList.remove('hidden');
                ongkirRowEl.style.display = 'flex';
                ongkirValEl.textContent = parsedOngkir.isNumeric
                    ? (parsedOngkir.nominal > 0 ? this._formatRp(parsedOngkir.nominal) : 'Gratis (Rp 0)')
                    : parsedOngkir.displayLabel;
            } else {
                ongkirRowEl.classList.add('hidden');
                ongkirRowEl.style.display = 'none';
            }
        }
        if (grandTotalValEl) {
            grandTotalValEl.textContent = this._formatRp(st.grandTotalValue);
        }

        if (st.wajibDp) {
            if (st.isAutoFullPayment || st.payScheme === 'FULL') {
                st.nominalTransferAwal = st.grandTotalValue;
                st.sisaBayar = 0;
            } else {
                st.nominalTransferAwal = st.dpMin;
                st.sisaBayar = Math.max(0, st.grandTotalValue - st.dpMin);
            }
        } else {
            if (st.payScheme === 'TRANSFER_LUNAS') {
                st.nominalTransferAwal = st.grandTotalValue;
                st.sisaBayar = 0;
            } else {
                st.nominalTransferAwal = 0;
                st.sisaBayar = st.grandTotalValue;
            }
        }

        const cardDpMin = document.getElementById('cardSchemeDpMin');
        const cardFull = document.getElementById('cardSchemeFull');
        if (cardDpMin && cardFull) {
            const isDp = st.payScheme === 'DP_MIN';
            cardDpMin.style.borderColor = isDp ? 'var(--go-green)' : 'var(--border-soft)';
            cardDpMin.style.background = isDp ? 'var(--go-green-soft)' : 'var(--surface-2)';
            cardFull.style.borderColor = !isDp ? 'var(--go-green)' : 'var(--border-soft)';
            cardFull.style.background = !isDp ? 'var(--go-green-soft)' : 'var(--surface-2)';
        }

        const cardTunai = document.getElementById('cardSchemeTunai');
        const cardTransferLunas = document.getElementById('cardSchemeTransferLunas');
        if (cardTunai) {
            const isTunai = st.payScheme === 'TUNAI';
            cardTunai.style.borderColor = isTunai ? 'var(--go-green)' : 'var(--border-soft)';
            cardTunai.style.background = isTunai ? 'var(--go-green-soft)' : 'var(--surface-2)';
        }
        if (cardTransferLunas) {
            const isTrans = st.payScheme === 'TRANSFER_LUNAS';
            cardTransferLunas.style.borderColor = isTrans ? 'var(--go-green)' : 'var(--border-soft)';
            cardTransferLunas.style.background = isTrans ? 'var(--go-green-soft)' : 'var(--surface-2)';
        }

        const elTransfer = document.getElementById('japarSummaryNominalTransfer');
        const elSisa = document.getElementById('japarSummarySisaBayar');
        if (elTransfer) elTransfer.textContent = this._formatRp(st.nominalTransferAwal);
        if (elSisa) elSisa.textContent = this._formatRp(st.sisaBayar);

        const payMethodsBox = document.getElementById('japarMerchantPaymentMethodsBox');
        if (payMethodsBox) {
            const showChannels = st.wajibDp || st.payScheme === 'TRANSFER_LUNAS';
            payMethodsBox.style.display = showChannels ? 'flex' : 'none';
        }

        const cashChangeSec = document.getElementById('japarCashChangeSection');
        if (cashChangeSec) {
            cashChangeSec.classList.toggle('hidden', st.sisaBayar <= 0);
        }
        this._syncCashChangeCalculatorUI();
        this._updateLiveWaReceiptPreview();
    },

    _syncCashChangeCalculatorUI: function() {
        const st = this._activeCheckoutState;
        const summaryEl = document.getElementById('japarCashChangeSummaryText');
        if (!st || !summaryEl) return;

        const sisa = st.sisaBayar;
        document.querySelectorAll('#japarCashDenomChips .cash-denom-btn').forEach(btn => {
            const denom = btn.getAttribute('data-cash-denom');
            const numVal = parseInt(denom, 10);
            if (!isNaN(numVal) && numVal < sisa) {
                btn.disabled = true;
                btn.style.opacity = '0.38';
                if (this._selectedCashDenom === denom) {
                    this._selectedCashDenom = 'PAS';
                }
            } else {
                btn.disabled = false;
                btn.style.opacity = '1';
            }
            btn.classList.toggle('active', denom === this._selectedCashDenom);
        });

        if (this._selectedCashDenom === 'PAS') {
            summaryEl.innerHTML = `<i class="fa-solid fa-circle-check text-emerald"></i> Pembayaran tunai menyiapkan <b>Uang Pas (${this._formatRp(sisa)})</b>.`;
        } else {
            const denomVal = parseInt(this._selectedCashDenom, 10) || sisa;
            const kembalian = Math.max(0, denomVal - sisa);
            summaryEl.innerHTML = `<i class="fa-solid fa-coins text-amber"></i> Membayar dengan pecahan <b>${this._formatRp(denomVal)}</b> → Mohon kurir/kasir menyiapkan <b>Kembalian ${this._formatRp(kembalian)}</b>.`;
        }
    },

    _collectLiveCheckoutOrderData: function() {
        const st = this._activeCheckoutState;
        if (!st) return null;

        const rawName = (document.getElementById('japarBuyerName')?.value || '').trim();
        const rawAddress = (document.getElementById('japarBuyerAddress')?.value || '').trim();
        const rawNotes = (document.getElementById('japarBuyerNotes')?.value || '').trim();

        const tableNumber = (document.getElementById('japarDineInTableNumber')?.value || '').trim();
        const paxCount = Math.max(1, parseInt(document.getElementById('japarDineInPax')?.value || '1', 10) || 1);

        const timePref = document.getElementById('japarOrderTimePref')?.value || 'SEKARANG';
        const customTime = (document.getElementById('japarOrderCustomTime')?.value || '12:00').trim();
        let jadwalWaktuText = 'Segera / Sekarang';
        if (timePref === '15_MENIT') jadwalWaktuText = 'Sekitar 15 - 20 Menit Lagi';
        else if (timePref === '30_MENIT') jadwalWaktuText = 'Sekitar 30 Menit Lagi';
        else if (timePref === 'JADWAL_JAM') jadwalWaktuText = `Terjadwal Pukul ${customTime} WIB`;

        const packagingList = [];
        if (st.deliveryMethod !== 'MAKAN_DI_TEMPAT') {
            if (document.getElementById('chkNeedCutlery')?.checked) {
                packagingList.push('Butuh Sendok/Sedotan');
            }
            if (document.getElementById('chkSeparateSauce')?.checked) {
                packagingList.push('Kuah/Sambal Dipisah');
            }
            if (document.getElementById('chkLabelPackage')?.checked) {
                packagingList.push('Beri Label Catatan di Bungkus');
            }
        }

        let kanalPembayaran = 'Bayar Tunai di Tempat';
        if (st.wajibDp || st.payScheme === 'TRANSFER_LUNAS') {
            const checkedChannel = document.querySelector('input[name="japarMerchantPayChannel"]:checked');
            kanalPembayaran = checkedChannel ? checkedChannel.value : st.selectedTransferChannel;
        }

        let cashDenomNominal = 0;
        let cashKembalianNominal = 0;
        let cashDenomInfo = '';
        if (st.sisaBayar > 0) {
            if (this._selectedCashDenom === 'PAS') {
                cashDenomInfo = `Uang Pas (${this._formatRp(st.sisaBayar)})`;
            } else {
                cashDenomNominal = parseInt(this._selectedCashDenom, 10) || st.sisaBayar;
                cashKembalianNominal = Math.max(0, cashDenomNominal - st.sisaBayar);
                cashDenomInfo = `Pecahan ${this._formatRp(cashDenomNominal)} (Siapkan Kembalian ${this._formatRp(cashKembalianNominal)})`;
            }
        }

        let buyerGpsLink = '';
        let estDistKm = null;
        if (st.deliveryMethod === 'KURIR_WARUNG') {
            const embedded = window.JAPAR_EMBEDDED_DELIVERY_GPS;
            const activeGps = getKoordinatPelangganAktif();
            const targetLat = (embedded && !isNaN(embedded.lat)) ? embedded.lat : activeGps?.lat;
            const targetLng = (embedded && !isNaN(embedded.lng)) ? embedded.lng : activeGps?.lng;
            if (targetLat && targetLng && (!activeGps?.isDefault || embedded)) {
                buyerGpsLink = `https://www.google.com/maps?q=${Number(targetLat).toFixed(6)},${Number(targetLng).toFixed(6)}`;
            }
            if (targetLat && targetLng && st.summary.storeLat && st.summary.storeLng) {
                const d = hitungJarakHaversineKm(targetLat, targetLng, st.summary.storeLat, st.summary.storeLng);
                if (d < 100) estDistKm = Number(d.toFixed(2));
            }
        }

        const currentSummary = this.getCartSummary();
        st.totalValue = currentSummary.totalValue;
        st.grandTotalValue = currentSummary.totalValue + (st.ongkirNominal || 0);

        return {
            refCode: st.refCode,
            uidMerchant: currentSummary.uidMerchant,
            storeName: currentSummary.storeName,
            storeAddress: currentSummary.storeAddress,
            storeLat: currentSummary.storeLat,
            storeLng: currentSummary.storeLng,
            merchantWa: st.profile.wa,
            infoOngkirWarung: st.profile.infoOngkirWarung,
            ongkirNominal: st.ongkirNominal || 0,
            ongkirDisplayLabel: st.ongkirDisplayLabel || st.profile.infoOngkirWarung || '',
            ongkirIsNumeric: Boolean(st.ongkirIsNumeric),
            grandTotalValue: st.grandTotalValue,
            buyerName: rawName || '(Nama Pemesan)',
            buyerAddress: rawAddress,
            buyerGpsLink,
            estDistKm,
            buyerNotes: rawNotes,
            deliveryMethod: st.deliveryMethod,
            tableNumber,
            paxCount,
            jadwalWaktuText,
            packagingList,
            totalQty: currentSummary.totalQty,
            totalValue: currentSummary.totalValue,
            totalSaved: currentSummary.totalSaved,
            nominalTransferAwal: st.nominalTransferAwal,
            sisaBayar: st.sisaBayar,
            kanalPembayaran,
            cashDenomNominal,
            cashKembalianNominal,
            cashDenomInfo,
            items: currentSummary.orderItems
        };
    },

    /**
     * Memformat rincian Isi Paket (`desc`), Pilihan Minuman (`selectedDrink`/`portionDrinks`),
     * Pilihan Varian (`selectedVar`/`portionVars`), & Catatan untuk 1 item menu pada struk WhatsApp
     */
    _formatItemNotesForWhatsApp: function(itemObj) {
        const qty = Math.max(1, parseInt(itemObj.qty, 10) || 1);
        const lines = [];
        const rawVarDef = this._autoArticulateMissingVarFromItem(itemObj.name || '', itemObj.var || '', itemObj.desc || '');

        if (itemObj.desc) {
            lines.push(`   📦 *Isi Paket:* ${itemObj.desc}`);
        }

        const pNotes = Array.isArray(itemObj.portionNotes) ? itemObj.portionNotes : [];
        const pDrinks = Array.isArray(itemObj.portionDrinks) ? itemObj.portionDrinks : [];
        const pVars = Array.isArray(itemObj.portionVars) ? itemObj.portionVars : [];
        const isPortionMode = qty > 1 && Boolean(itemObj.usePortionNotes);

        if (isPortionMode) {
            lines.push(`   📝 *Rincian Per Porsi (${qty} Porsi):*`);
            for (let i = 0; i < qty; i++) {
                const pDrk = String(pDrinks[i] || itemObj.selectedDrink || '').trim();
                const rawPVar = pVars[i] !== undefined ? String(pVars[i]).trim() : String(itemObj.selectedVar || '').trim();
                const formattedPVar = this._formatSelectedVarForDisplay(rawPVar, rawVarDef);
                const pNote = String(pNotes[i] || '').trim();

                const bracketParts = [];
                if (pDrk) bracketParts.push(`Minum: ${pDrk}`);
                if (formattedPVar) {
                    if (formattedPVar.includes(':')) {
                        bracketParts.push(formattedPVar);
                    } else {
                        bracketParts.push(`Varian: ${formattedPVar}`);
                    }
                }
                const bracketStr = bracketParts.length > 0 ? `[${bracketParts.join(' | ')}]` : '';

                if (bracketStr && pNote) {
                    lines.push(`   • *Porsi #${i + 1}:* ${bracketStr} — ${pNote}`);
                } else if (bracketStr) {
                    lines.push(`   • *Porsi #${i + 1}:* ${bracketStr}`);
                } else if (pNote) {
                    lines.push(`   • *Porsi #${i + 1}:* ${pNote}`);
                } else {
                    lines.push(`   • *Porsi #${i + 1}:* Normal / Standar`);
                }
            }
            return lines.join('\n');
        }

        const cleanDrink = String(itemObj.selectedDrink || '').trim();
        const cleanVar = String(itemObj.selectedVar || '').trim();
        const formattedVar = this._formatSelectedVarForDisplay(cleanVar, rawVarDef);
        const cleanGeneralNote = String(itemObj.note || '').trim();

        if (cleanDrink) {
            lines.push(`   🥤 *Minuman Paket:* *${cleanDrink}*`);
        }
        if (formattedVar) {
            if (formattedVar.includes('|') || formattedVar.includes(':')) {
                lines.push(`   🎛️ *Opsi Pilihan:* *${formattedVar}*`);
            } else {
                lines.push(`   🍗 *Varian/Lauk:* *${formattedVar}*`);
            }
        }
        if (cleanGeneralNote) {
            lines.push(`   📝 *Catatan:* ${cleanGeneralNote}`);
        }

        if (lines.length === 0) {
            return `   _(Tanpa catatan khusus / Standar)_`;
        }
        return lines.join('\n');
    },

    /**
     * Membangun Template Teks WhatsApp yang Sangat Jelas, Mudah Dibaca, dan Tidak Luput dari Penglihatan
     */
    buildMerchantWhatsAppText: function(orderData) {
        if (!orderData) return '';
        const isKurirResto = orderData.deliveryMethod === 'KURIR_WARUNG';
        const isDineIn = orderData.deliveryMethod === 'MAKAN_DI_TEMPAT';

        const serviceBlockLines = [];
        if (isDineIn) {
            serviceBlockLines.push(`🍽️ *LAYANAN: [ DINE-IN • MAKAN DI TEMPAT ]*`);
            serviceBlockLines.push(`🪑 *Meja / Area:* *${orderData.tableNumber || 'Menyesuaikan di Lokasi'}*`);
            serviceBlockLines.push(`👥 *Jumlah Tamu:* *${orderData.paxCount || 1} Orang*`);
            serviceBlockLines.push(`⏰ *Waktu Saji:* *${orderData.jadwalWaktuText || 'Segera / Sekarang'}*`);
        } else if (isKurirResto) {
            serviceBlockLines.push(`🛵 *LAYANAN: [ DELIVERY • DIANTAR KURIR RESTO ]*`);
            serviceBlockLines.push(`⏰ *Waktu Antar:* *${orderData.jadwalWaktuText || 'Segera / Sekarang'}*`);
            serviceBlockLines.push(`📍 *Alamat & Patokan:* *${orderData.buyerAddress || '(Mohon isi alamat & patokan)'}*`);
            if (orderData.estDistKm !== null && orderData.estDistKm !== undefined) {
                serviceBlockLines.push(`📏 *Estimasi Jarak:* ~${orderData.estDistKm} km dari warung`);
            }
            if (orderData.buyerGpsLink) {
                serviceBlockLines.push(`🗺️ *Titik GPS Maps:* ${orderData.buyerGpsLink}`);
            }
            if (Array.isArray(orderData.packagingList) && orderData.packagingList.length > 0) {
                serviceBlockLines.push(`🥡 *Kelengkapan Bungkus:* *${orderData.packagingList.join(', ')}*`);
            }
        } else {
            serviceBlockLines.push(`🛍️ *LAYANAN: [ TAKE AWAY • BUNGKUS AMBIL SENDIRI ]*`);
            serviceBlockLines.push(`⏰ *Waktu Ambil:* *${orderData.jadwalWaktuText || 'Segera / Sekarang'}*`);
            if (Array.isArray(orderData.packagingList) && orderData.packagingList.length > 0) {
                serviceBlockLines.push(`🥡 *Kelengkapan Bungkus:* *${orderData.packagingList.join(', ')}*`);
            }
        }

        serviceBlockLines.push(`👤 *Pemesan:* *${orderData.buyerName}* _(Sesuai Nomor WA Pengirim Ini)_`);
        if (orderData.buyerNotes) {
            serviceBlockLines.push(`📌 *Catatan Umum:* _${orderData.buyerNotes}_`);
        }

        const totalPorsiCount = orderData.totalQty || (orderData.items || []).reduce((acc, it) => acc + (parseInt(it.qty, 10) || 1), 0);
        const itemsFormattedBlocks = (orderData.items || []).map((it, idx) => {
            const titleLine = `*${idx + 1}. [${it.qty}x] ${it.name}*`;
            const baseUnit = it.basePrice !== undefined ? it.basePrice : it.price;
            const addonText = it.totalAddonPrice > 0 ? ` (+Opsi ${this._formatRp(it.totalAddonPrice)})` : '';
            const priceLine = `   💰 ${it.qty} x ${this._formatRp(baseUnit)}${addonText} = *${this._formatRp(it.subtotal)}*`;
            const noteBlock = this._formatItemNotesForWhatsApp(it);
            return [titleLine, priceLine, noteBlock].join('\n');
        }).join('\n\n');

        const paymentLines = [];
        const ongkirNom = isKurirResto ? (Number(orderData.ongkirNominal) || 0) : 0;
        const grandTotal = Number(orderData.grandTotalValue) || (Number(orderData.totalValue || 0) + ongkirNom);

        paymentLines.push(`• Subtotal Harga Menu: *${this._formatRp(orderData.totalValue)}*${orderData.totalSaved > 0 ? ` _(Hemat Diskon ${this._formatRp(orderData.totalSaved)})_` : ''}`);
        if (isKurirResto) {
            if (ongkirNom > 0) {
                paymentLines.push(`• Biaya Ongkir Kurir: *${this._formatRp(ongkirNom)}*`);
                paymentLines.push(`• *TOTAL TAGIHAN (MENU + ONGKIR): ${this._formatRp(grandTotal)}*`);
            } else {
                paymentLines.push(`• Biaya Ongkir Kurir: *${orderData.ongkirDisplayLabel || 'Sesuai ketentuan kurir resto'}*`);
            }
        }

        if (orderData.nominalTransferAwal <= 0) {
            paymentLines.push(`• Metode Bayar: *BAYAR TUNAI DI TEMPAT / COD*`);
            paymentLines.push(`• *TAGIHAN TUNAI: ${this._formatRp(orderData.sisaBayar)}*`);
            if (orderData.cashDenomNominal > 0) {
                paymentLines.push(`• Uang Disiapkan: *${this._formatRp(orderData.cashDenomNominal)}*`);
                paymentLines.push(`• *SIAPKAN KEMBALIAN: ${this._formatRp(orderData.cashKembalianNominal)}*`);
            } else {
                paymentLines.push(`• Info Uang Tunai: *Uang Pas (${this._formatRp(orderData.sisaBayar)})*`);
            }
        } else if (orderData.sisaBayar > 0) {
            paymentLines.push(`• Metode Bayar: *TRANSFER DP AWAL*`);
            paymentLines.push(`• Kanal Transfer: ${orderData.kanalPembayaran}`);
            paymentLines.push(`• *TRANSFER DP SEKARANG: ${this._formatRp(orderData.nominalTransferAwal)}*`);
            paymentLines.push(`• *SISA BAYAR DI TEMPAT: ${this._formatRp(orderData.sisaBayar)}*`);
            if (orderData.cashDenomInfo) {
                paymentLines.push(`• Info Tunai Sisa: *${orderData.cashDenomInfo}*`);
            }
        } else {
            paymentLines.push(`• Metode Bayar: *TRANSFER LUNAS*`);
            paymentLines.push(`• Kanal Transfer: ${orderData.kanalPembayaran}`);
            paymentLines.push(`• *NOMINAL DITRANSFER: ${this._formatRp(orderData.nominalTransferAwal)} (LUNAS)*`);
            paymentLines.push(`• *SISA TAGIHAN: Rp 0*`);
        }

        return [
            `🧾 *PESANAN KULINER - JAPAR*`,
            `🏪 *Warung:* *${orderData.storeName}*`,
            `🔖 *Kode Order:* *${orderData.refCode}*`,
            `━━━━━━━━━━━━━━━━━━━━`,
            ...serviceBlockLines,
            `━━━━━━━━━━━━━━━━━━━━`,
            `📋 *DETAIL PESANAN (${totalPorsiCount} PORSI):*`,
            ``,
            itemsFormattedBlocks,
            `━━━━━━━━━━━━━━━━━━━━`,
            `💳 *RINCIAN PEMBAYARAN:*`,
            ...paymentLines,
            ``,
            orderData.nominalTransferAwal > 0
                ? `Mohon konfirmasi pesanan saya. Bukti transfer pembayaran saya lampirkan bersama pesan ini. Terima kasih.`
                : `Mohon konfirmasi pesanan saya agar dapat segera disiapkan oleh dapur. Terima kasih.`
        ].join('\n');
    },

    buildMerchantWhatsAppUrl: function(orderData) {
        if (!orderData) return '';
        const cleanWaResto = String(orderData.merchantWa || '').replace(/[^0-9]/g, '').replace(/^0/, '62');
        const text = this.buildMerchantWhatsAppText(orderData);
        return `https://wa.me/${cleanWaResto}?text=${encodeURIComponent(text)}`;
    },

    _updateLiveWaReceiptPreview: function() {
        const previewEl = document.getElementById('japarLiveWaReceiptPreview');
        if (!previewEl || !this._activeCheckoutState) return;
        const liveData = this._collectLiveCheckoutOrderData();
        if (liveData) {
            previewEl.textContent = this.buildMerchantWhatsAppText(liveData);
        }
    },

    _readOrderHistoryList: function() {
        try {
            const raw = localStorage.getItem(ORDER_HISTORY_STORAGE_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    },

    _saveOrderToHistory: function(orderPayload, waUrl) {
        try {
            const currentList = this._readOrderHistoryList();
            const record = {
                ...orderPayload,
                waUrl: waUrl,
                createdAt: Date.now()
            };
            const updated = [record, ...currentList.filter(it => it && it.refCode !== record.refCode)].slice(0, MAX_ORDER_HISTORY_ITEMS);
            localStorage.setItem(ORDER_HISTORY_STORAGE_KEY, JSON.stringify(updated));
            this.updateBottomNavBadges();
        } catch (e) {}
    },

    clearOrderHistory: function() {
        try {
            localStorage.removeItem(ORDER_HISTORY_STORAGE_KEY);
        } catch (e) {}
        this.updateBottomNavBadges();
        this.renderOrderHistoryPage();
    },

    renderOrderHistoryPage: function() {
        const container = document.getElementById('orderHistoryListContainer');
        const btnClear = document.getElementById('btnClearOrderHistory');
        if (!container) return;

        const historyList = this._readOrderHistoryList();
        if (btnClear) {
            btnClear.classList.toggle('hidden', historyList.length === 0);
        }

        container.innerHTML = '';

        if (historyList.length === 0) {
            container.innerHTML = `
                <div class="glass-panel text-center" style="padding: 32px 18px; border-radius: 18px;">
                    <div class="empty-state-icon-circle">
                        <i class="fa-solid fa-receipt"></i>
                    </div>
                    <h2 class="font-tech text-main font-bold" style="font-size: 0.96rem;">Belum Ada Riwayat Pesanan</h2>
                    <p class="text-muted" style="font-size: 0.75rem; margin-top: 5px; line-height: 1.5; max-width: 330px; margin-left: auto; margin-right: auto;">
                        Pesanan kuliner yang Anda kirimkan ke WhatsApp resto akan otomatis tercatat di halaman ini beserta catatan menunya.
                    </p>
                    <button type="button" id="btnExploreFromEmptyOrders" class="btn-primary" style="margin-top: 14px;">
                        <i class="fa-solid fa-compass"></i>
                        <span>Cari Kuliner Sekarang</span>
                    </button>
                </div>
            `;
            const btnExp = document.getElementById('btnExploreFromEmptyOrders');
            if (btnExp) {
                btnExp.addEventListener('click', () => {
                    picuGetarSentuh(10);
                    JaparPageRouter.navigateTo('explore');
                });
            }
            return;
        }

        historyList.forEach(order => {
            const card = document.createElement('article');
            card.className = 'order-history-card';

            const dateStr = order.createdAt
                ? new Date(order.createdAt).toLocaleString('id-ID', {
                    day: '2-digit', month: 'short', year: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                })
                : '-';

            const itemsSummaryHtml = (order.items || []).map(it => {
                const subTags = [];
                const formattedHistVar = this._formatSelectedVarForDisplay(it.selectedVar || '', it.var || '');
                if (it.desc) subTags.push(`Isi: ${this._escapeHtml(it.desc)}`);
                if (it.selectedDrink) subTags.push(`Minum: ${this._escapeHtml(it.selectedDrink)}`);
                if (formattedHistVar) subTags.push(`${formattedHistVar.includes(':') ? '' : 'Varian: '}${this._escapeHtml(formattedHistVar)}`);
                if (it.note) subTags.push(`Catatan: ${this._escapeHtml(it.note)}`);

                let noteTag = '';
                if (it.usePortionNotes && Array.isArray(it.portionNotes)) {
                    const pList = [];
                    const q = Math.max(1, parseInt(it.qty, 10) || 1);
                    for (let i = 0; i < q; i++) {
                        const pd = it.portionDrinks?.[i] || it.selectedDrink || '';
                        const pv = it.portionVars?.[i] || it.selectedVar || '';
                        const pn = it.portionNotes?.[i] || '';
                        const parts = [pd, pv, pn].filter(Boolean).join(' • ');
                        pList.push(`Porsi #${i + 1}: ${this._escapeHtml(parts || 'Normal')}`);
                    }
                    noteTag = `<div style="font-size: 0.65rem; color: var(--go-amber); padding-left: 12px;"><i class="fa-solid fa-list-ol"></i> ${pList.join(' | ')}</div>`;
                } else if (subTags.length > 0) {
                    noteTag = `<div style="font-size: 0.65rem; color: var(--go-amber); padding-left: 12px;"><i class="fa-solid fa-pen-to-square"></i> ${subTags.join(' • ')}</div>`;
                }
                return `<div>• <b>${it.qty}x</b> ${this._escapeHtml(it.name)} <span class="text-muted">(${this._formatRp(it.subtotal)})</span>${noteTag}</div>`;
            }).join('');

            let receiveText = 'Take Away / Ambil Sendiri';
            if (order.deliveryMethod === 'KURIR_WARUNG') receiveText = 'Pesan Antar Kurir Resto';
            else if (order.deliveryMethod === 'MAKAN_DI_TEMPAT') receiveText = 'Dine-In / Makan di Tempat';

            const waLink = order.waUrl || this.buildMerchantWhatsAppUrl(order);

            card.innerHTML = `
                <div class="order-history-top">
                    <div style="min-width: 0; flex: 1;">
                        <div class="order-history-store">${this._escapeHtml(order.storeName || 'Resto Kuliner')}</div>
                        <div class="order-history-time"><i class="fa-regular fa-calendar"></i> ${this._escapeHtml(dateStr)} • ${this._escapeHtml(receiveText)}</div>
                    </div>
                    <span class="checkout-ref-pill">${this._escapeHtml(order.refCode || '#JPR')}</span>
                </div>

                <div class="order-history-items">
                    ${itemsSummaryHtml}
                </div>

                <div class="order-history-meta-box">
                    <div style="display: flex; justify-content: space-between;">
                        <span class="text-muted">Total Harga Hidangan:</span>
                        <strong class="text-main font-tech">${this._formatRp(order.totalValue)}</strong>
                    </div>
                    <div style="display: flex; justify-content: space-between;">
                        <span class="text-muted">Transfer Awal / Sisa di Tempat:</span>
                        <span class="text-emerald font-bold">${this._formatRp(order.nominalTransferAwal)} / ${this._formatRp(order.sisaBayar)}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between;">
                        <span class="text-muted">Kanal Pembayaran:</span>
                        <span class="text-main">${this._escapeHtml(order.kanalPembayaran || '-')}</span>
                    </div>
                </div>

                <div class="order-history-actions">
                    <button type="button" class="btn-order-secondary btn-reorder-store">
                        <i class="fa-solid fa-rotate-right"></i>
                        <span>Pesan Lagi</span>
                    </button>
                    <a href="${this._escapeHtml(waLink)}" target="_blank" rel="noopener noreferrer" class="btn-order-primary">
                        <i class="fa-brands fa-whatsapp"></i>
                        <span>Hubungi WA Resto</span>
                    </a>
                </div>
            `;

            const btnReorder = card.querySelector('.btn-reorder-store');
            if (btnReorder) {
                btnReorder.addEventListener('click', async () => {
                    picuGetarSentuh(14);
                    if (Array.isArray(order.items) && order.items.length > 0) {
                        const restoredMap = {};
                        order.items.forEach(oldIt => {
                            const q = Math.max(1, parseInt(oldIt.qty, 10) || 1);
                            const baseP = oldIt.basePrice !== undefined ? oldIt.basePrice : oldIt.price;
                            restoredMap[oldIt.id] = {
                                id: oldIt.id,
                                name: oldIt.name,
                                kat: oldIt.kat || 'Hidangan Utama',
                                originalPrice: oldIt.originalPrice || baseP,
                                finalPrice: baseP,
                                discountPct: 0,
                                desc: oldIt.desc || '',
                                drk: oldIt.drk || '',
                                var: oldIt.var || '',
                                selectedDrink: oldIt.selectedDrink || '',
                                selectedVar: oldIt.selectedVar || '',
                                portionDrinks: this._normalizePortionChoiceArray(oldIt.portionDrinks, q, oldIt.selectedDrink || ''),
                                portionVars: this._normalizePortionChoiceArray(oldIt.portionVars, q, oldIt.selectedVar || ''),
                                note: oldIt.note || '',
                                usePortionNotes: Boolean(oldIt.usePortionNotes),
                                portionNotes: this._normalizePortionNotesArray(oldIt.portionNotes, q),
                                qty: q
                            };
                        });
                        this._cart = {
                            uidMerchant: order.uidMerchant,
                            storeName: order.storeName,
                            storeAddress: order.storeAddress || order.storeName,
                            storeLat: order.storeLat || null,
                            storeLng: order.storeLng || null,
                            itemsMap: restoredMap
                        };
                        this._persistCart();
                        this.updateFloatingCartBarUI();
                        this.updateBottomNavBadges();
                    }

                    const matchedOpen = (this._merchantsList || []).find(m => m && m.uid === order.uidMerchant && m.o === true);
                    if (matchedOpen) {
                        this.openStorePage(matchedOpen);
                    } else {
                        await this.loadCatalogIndex(true);
                        const rechecked = (this._merchantsList || []).find(m => m && m.uid === order.uidMerchant && m.o === true);
                        if (rechecked) {
                            this.openStorePage(rechecked);
                        } else {
                            this.openCheckoutPage();
                        }
                    }
                });
            }

            container.appendChild(card);
        });
    },

    _executeCheckoutSubmission: function() {
        const st = this._activeCheckoutState;
        if (!st) return;

        const rawName = (document.getElementById('japarBuyerName')?.value || '').trim();
        const rawAddress = (document.getElementById('japarBuyerAddress')?.value || '').trim();

        if (rawName.length < 2) {
            this._syncSavedBuyerProfileLocksUI(true, null);
            document.getElementById('japarBuyerName')?.focus();
            this.showNotice('Harap isi <b>Nama Pemesan</b> terlebih dahulu (cukup diisi 1 kali, selanjutnya otomatis tersimpan).');
            return;
        }

        if (st.deliveryMethod === 'KURIR_WARUNG' && rawAddress.length < 5) {
            this._syncSavedBuyerProfileLocksUI(null, true);
            document.getElementById('japarBuyerAddress')?.focus();
            this.showNotice('Harap lengkapi <b>Alamat Lengkap &amp; Patokan Lokasi</b> untuk memudahkan pengantaran kurir resto (otomatis tersimpan untuk pesanan berikutnya).');
            return;
        }

        if (!st.profile.wa) {
            this.showNotice('Nomor WhatsApp resto belum terdaftar pada profil tempat usaha ini.');
            return;
        }

        this._persistBuyerProfileToStorage();
        this._syncSavedBuyerProfileLocksUI(false, false);

        const orderPayload = this._collectLiveCheckoutOrderData();
        orderPayload.buyerName = rawName;

        const waUrl = this.buildMerchantWhatsAppUrl(orderPayload);

        this._saveOrderToHistory(orderPayload, waUrl);
        this.clearCart();
        JaparPageRouter.navigateTo('orders');
        window.open(waUrl, '_blank', 'noopener,noreferrer');
    },

    _bindAllEvents: function() {
        JaparPageRouter.onPageChanged((pageName) => {
            if (pageName === 'explore') {
                this.loadCatalogIndex(false);
            } else if (pageName === 'checkout') {
                this.renderCheckoutPage(false);
            } else if (pageName === 'orders') {
                this.renderOrderHistoryPage();
            } else if (pageName === 'profile') {
                this.renderBuyerProfilePage();
            }
        });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this.loadCatalogIndex(false);
            }
        });

        document.querySelectorAll('.umkm-cat-filter-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                picuGetarSentuh(10);
                document.querySelectorAll('.umkm-cat-filter-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                this._activeCategory = chip.getAttribute('data-umkm-cat') || 'ALL';
                this.renderMerchantListUI();
            });
        });

        const selRadius = document.getElementById('selectRadiusKm');
        if (selRadius) {
            selRadius.addEventListener('change', (e) => {
                picuGetarSentuh(10);
                const val = parseFloat(e.target.value || '20') || 20.0;
                this._selectedRadiusKm = Math.min(MAX_RADIUS_KM, Math.max(1.0, val));
                this.renderMerchantListUI();
            });
        }

        document.querySelectorAll('.subfilter-pill').forEach(pill => {
            pill.addEventListener('click', () => {
                picuGetarSentuh(10);
                document.querySelectorAll('.subfilter-pill').forEach(p => p.classList.remove('active'));
                pill.classList.add('active');
                this._activeQuickFilter = pill.getAttribute('data-quick-filter') || 'ALL';
                this.renderMerchantListUI();
            });
        });

        const searchInp = document.getElementById('inputSearchUmkmCatalog');
        const btnClearSearch = document.getElementById('btnClearSearchUmkmCatalog');
        if (searchInp) {
            searchInp.addEventListener('input', (e) => {
                this._searchQuery = e.target.value || '';
                if (btnClearSearch) {
                    btnClearSearch.classList.toggle('hidden', this._searchQuery.length === 0);
                }
                this.renderMerchantListUI();
            });
        }
        if (btnClearSearch && searchInp) {
            btnClearSearch.addEventListener('click', () => {
                searchInp.value = '';
                this._searchQuery = '';
                btnClearSearch.classList.add('hidden');
                this.renderMerchantListUI();
            });
        }

        const btnRefresh = document.getElementById('btnRefreshUmkmCatalog');
        if (btnRefresh) {
            btnRefresh.addEventListener('click', () => {
                picuGetarSentuh(14);
                this.loadCatalogIndex(true, true);
            });
        }

        const btnBackStore = document.getElementById('btnBackFromStorePage');
        if (btnBackStore) {
            btnBackStore.addEventListener('click', () => {
                picuGetarSentuh(10);
                JaparPageRouter.navigateTo('explore');
            });
        }

        const inpStoreSearch = document.getElementById('inputSearchMenuInStore');
        if (inpStoreSearch) {
            inpStoreSearch.addEventListener('input', (e) => {
                this._storeSearchQuery = e.target.value || '';
                this._renderActiveStoreMenuItems();
            });
        }

        const btnModeDelivery = document.getElementById('btnStoreModeDelivery');
        const btnModePickup = document.getElementById('btnStoreModePickup');
        const btnModeDineIn = document.getElementById('btnStoreModeDineIn');

        if (btnModeDelivery) {
            btnModeDelivery.addEventListener('click', () => {
                if (btnModeDelivery.disabled) return;
                picuGetarSentuh(10);
                this._preferredReceiveMethod = 'KURIR_WARUNG';
                this._syncStorePageReceiveModeUI(this._activeMerchantDoc?.profile || {});
            });
        }
        if (btnModePickup) {
            btnModePickup.addEventListener('click', () => {
                if (btnModePickup.disabled) return;
                picuGetarSentuh(10);
                this._preferredReceiveMethod = 'AMBIL_SENDIRI';
                this._syncStorePageReceiveModeUI(this._activeMerchantDoc?.profile || {});
            });
        }
        if (btnModeDineIn) {
            btnModeDineIn.addEventListener('click', () => {
                if (btnModeDineIn.disabled) return;
                picuGetarSentuh(10);
                this._preferredReceiveMethod = 'MAKAN_DI_TEMPAT';
                this._syncStorePageReceiveModeUI(this._activeMerchantDoc?.profile || {});
            });
        }

        document.querySelectorAll('.btn-clear-umkm-cart').forEach(btn => {
            btn.addEventListener('click', () => {
                picuGetarSentuh(14);
                this.clearCart();
            });
        });

        document.querySelectorAll('.btn-umkm-checkout-handshake').forEach(btn => {
            btn.addEventListener('click', () => {
                picuGetarSentuh(16);
                this.openCheckoutPage();
            });
        });

        const btnBackCheckout = document.getElementById('btnBackFromCheckoutPage');
        if (btnBackCheckout) {
            btnBackCheckout.addEventListener('click', () => {
                picuGetarSentuh(10);
                if (this._activeMerchantMeta) {
                    JaparPageRouter.navigateTo('store', { uid: this._activeMerchantMeta.uid });
                } else {
                    JaparPageRouter.navigateTo('explore');
                }
            });
        }

        const btnAddMoreFromCheckout = document.getElementById('btnAddMoreItemsFromCheckout');
        if (btnAddMoreFromCheckout) {
            btnAddMoreFromCheckout.addEventListener('click', () => {
                picuGetarSentuh(10);
                const summary = this.getCartSummary();
                const matchedMeta = (this._merchantsList || []).find(m => m && m.uid === summary.uidMerchant) || this._activeMerchantMeta;
                if (matchedMeta) {
                    this.openStorePage(matchedMeta);
                } else {
                    JaparPageRouter.navigateTo('explore');
                }
            });
        }

        const btnExploreEmptyCart = document.getElementById('btnExploreFromEmptyCart');
        if (btnExploreEmptyCart) {
            btnExploreEmptyCart.addEventListener('click', () => {
                picuGetarSentuh(10);
                JaparPageRouter.navigateTo('explore');
            });
        }

        document.querySelectorAll('input[name="japarDeliveryMethod"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                if (!this._activeCheckoutState || e.target.disabled) return;
                this._activeCheckoutState.deliveryMethod = e.target.value;
                this._refreshDeliveryMethodUI();
            });
        });

        const selTimePref = document.getElementById('japarOrderTimePref');
        const inpCustomTime = document.getElementById('japarOrderCustomTime');
        if (selTimePref) {
            selTimePref.addEventListener('change', (e) => {
                const isCustom = e.target.value === 'JADWAL_JAM';
                if (inpCustomTime) inpCustomTime.classList.toggle('hidden', !isCustom);
                this._updateLiveWaReceiptPreview();
            });
        }
        if (inpCustomTime) {
            inpCustomTime.addEventListener('change', () => this._updateLiveWaReceiptPreview());
        }

        document.querySelectorAll('#japarCashDenomChips .cash-denom-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                picuGetarSentuh(10);
                this._selectedCashDenom = btn.getAttribute('data-cash-denom') || 'PAS';
                this._syncCashChangeCalculatorUI();
                this._updateLiveWaReceiptPreview();
            });
        });

        [
            'chkNeedCutlery',
            'chkSeparateSauce',
            'chkLabelPackage',
            'japarDineInTableNumber',
            'japarDineInPax',
            'japarBuyerAddress',
            'japarBuyerName',
            'japarBuyerWA',
            'japarBuyerNotes'
        ].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', () => this._updateLiveWaReceiptPreview());
                el.addEventListener('change', () => this._updateLiveWaReceiptPreview());
            }
        });

        const btnCopyReceipt = document.getElementById('btnCopyWaReceiptText');
        if (btnCopyReceipt) {
            btnCopyReceipt.addEventListener('click', () => {
                const liveData = this._collectLiveCheckoutOrderData();
                if (liveData) {
                    const text = this.buildMerchantWhatsAppText(liveData);
                    this._copyTextToClipboard(text, 'Teks Struk Pesanan WhatsApp');
                }
            });
        }

        const btnEmbedGps = document.getElementById('btnEmbedBuyerGps');
        if (btnEmbedGps) {
            btnEmbedGps.addEventListener('click', () => {
                sematkanKoordinatGpsPengantaran(() => {
                    this._persistBuyerProfileToStorage();
                    this._updatePaymentBreakdownAndChannelsUI();
                    this._updateLiveWaReceiptPreview();
                });
            });
        }

        const btnLockName = document.getElementById('btnToggleBuyerIdentityLock');
        if (btnLockName) {
            btnLockName.addEventListener('click', () => {
                picuGetarSentuh(10);
                if (this._isBuyerNameUnlocked) {
                    const val = (document.getElementById('japarBuyerName')?.value || '').trim();
                    if (val.length < 2) {
                        this.showNotice('Ketik minimal 2 karakter pada Nama Pemesan sebelum mengunci.');
                        return;
                    }
                    this._persistBuyerProfileToStorage();
                    this._syncSavedBuyerProfileLocksUI(false, null);
                } else {
                    this._syncSavedBuyerProfileLocksUI(true, null);
                    document.getElementById('japarBuyerName')?.focus();
                }
            });
        }

        const btnLockAddr = document.getElementById('btnToggleBuyerAddressLock');
        if (btnLockAddr) {
            btnLockAddr.addEventListener('click', () => {
                picuGetarSentuh(10);
                if (this._isBuyerAddrUnlocked) {
                    const val = (document.getElementById('japarBuyerAddress')?.value || '').trim();
                    if (val.length < 5) {
                        this.showNotice('Ketik alamat lengkap & patokan lokasi terlebih dahulu sebelum mengunci.');
                        return;
                    }
                    this._persistBuyerProfileToStorage();
                    this._syncSavedBuyerProfileLocksUI(null, false);
                } else {
                    this._syncSavedBuyerProfileLocksUI(null, true);
                    document.getElementById('japarBuyerAddress')?.focus();
                }
            });
        }

        ['japarBuyerName', 'japarBuyerAddress', 'japarBuyerNotes'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', () => this._persistBuyerProfileToStorage());
            }
        });

        // Helper bersama untuk tombol "2. Tempel & Ekstrak Jalan Otomatis" (Onboarding, Profile, & Checkout)
        const jalankanEkstraksiGmapsPelanggan = async (rawInputId, addrInputId, statusInfoId, btnEl) => {
            picuGetarSentuh(12);
            const inpRaw = document.getElementById(rawInputId);
            const inpAddr = document.getElementById(addrInputId);
            const statusEl = document.getElementById(statusInfoId);

            let rawVal = String(inpRaw?.value || '').trim();
            if (!rawVal && navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
                try {
                    const clip = await navigator.clipboard.readText();
                    if (clip && clip.trim()) {
                        rawVal = clip.trim();
                        if (inpRaw) inpRaw.value = rawVal;
                    }
                } catch (e) {}
            }

            if (!rawVal) {
                if (inpRaw) inpRaw.focus();
                this.showNotice('Salin <b>Link Bagikan Google Maps (maps.app.goo.gl)</b> atau <b>Kode Plus (contoh: 75JX+8J Pare)</b> terlebih dahulu, lalu tempel pada kolom input.');
                return;
            }

            const origHtml = btnEl ? btnEl.innerHTML : '';
            if (btnEl) {
                btnEl.disabled = true;
                btnEl.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Mengekstrak Jalan...';
            }

            try {
                const res = await ekstrakLokasiDanJalanPelangganViaGas(rawVal);
                if (res && !isNaN(res.lat) && !isNaN(res.lng)) {
                    const streetDisplay = res.address || res.shortStreet || '';
                    if (inpAddr && streetDisplay) {
                        inpAddr.value = streetDisplay;
                        inpAddr.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                    if (statusEl) {
                        statusEl.classList.remove('hidden');
                        statusEl.innerHTML = `<i class="fa-solid fa-circle-check text-emerald"></i> <b>Jalan &amp; Titik Terdeteksi ${res.fromCache ? '(Cache 0-Kuota)' : '(Google Maps GAS)'}:</b> ${this._escapeHtml(res.shortStreet || streetDisplay)} <span class="text-muted">(${res.lat.toFixed(6)}, ${res.lng.toFixed(6)})</span>`;
                    }
                    this._persistBuyerProfileToStorage({
                        address: inpAddr?.value?.trim() || streetDisplay,
                        shortStreet: res.shortStreet || streetDisplay,
                        rawGmapsInput: rawVal,
                        gps: { lat: res.lat, lng: res.lng, geohash: res.geohash }
                    });
                    if (this._activeCheckoutState) {
                        this._updatePaymentBreakdownAndChannelsUI();
                        this._updateLiveWaReceiptPreview();
                    }
                } else {
                    this.showNotice('Titik lokasi belum terbaca. Pastikan menempelkan <b>Link Bagikan Google Maps</b>, <b>Kode Plus (contoh: 75JX+8J Pare)</b>, atau angka koordinat yang valid.');
                }
            } finally {
                if (btnEl) {
                    btnEl.disabled = false;
                    btnEl.innerHTML = origHtml;
                }
            }
        };

        // Helper bersama untuk tombol Deteksi dari Sensor GPS HP
        const jalankanDeteksiGpsJalanPelanggan = (addrInputId, statusInfoId, btnEl) => {
            picuGetarSentuh(14);
            if (!navigator.geolocation) {
                this.showNotice('Perangkat ini tidak mendukung sensor GPS. Gunakan tombol <b>1. Buka Google Maps</b> lalu tempel Link atau Kode Plus.');
                return;
            }
            const origHtml = btnEl ? btnEl.innerHTML : '';
            if (btnEl) {
                btnEl.disabled = true;
                btnEl.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Membaca GPS &amp; Nama Jalan...';
            }

            navigator.geolocation.getCurrentPosition(
                async (pos) => {
                    try {
                        const lat = pos.coords.latitude;
                        const lng = pos.coords.longitude;
                        const res = await ekstrakLokasiDanJalanPelangganViaGas({ lat, lng });
                        const streetDisplay = res ? (res.address || res.shortStreet || '') : '';
                        const inpAddr = document.getElementById(addrInputId);
                        const statusEl = document.getElementById(statusInfoId);

                        if (inpAddr && streetDisplay) {
                            inpAddr.value = streetDisplay;
                            inpAddr.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                        if (statusEl) {
                            statusEl.classList.remove('hidden');
                            statusEl.innerHTML = streetDisplay
                                ? `<i class="fa-solid fa-circle-check text-emerald"></i> <b>GPS &amp; Jalan Terdeteksi:</b> ${this._escapeHtml(res.shortStreet || streetDisplay)} <span class="text-muted">(${lat.toFixed(6)}, ${lng.toFixed(6)})</span>`
                                : `<i class="fa-solid fa-circle-check text-emerald"></i> <b>Koordinat GPS Terdeteksi:</b> ${lat.toFixed(6)}, ${lng.toFixed(6)}`;
                        }
                        this._persistBuyerProfileToStorage({
                            address: inpAddr?.value?.trim() || streetDisplay,
                            shortStreet: res?.shortStreet || streetDisplay,
                            gps: { lat, lng, geohash: res?.geohash || encodeGeohash(lat, lng, 6) }
                        });
                        if (this._activeCheckoutState) {
                            this._updatePaymentBreakdownAndChannelsUI();
                            this._updateLiveWaReceiptPreview();
                        }
                    } finally {
                        if (btnEl) {
                            btnEl.disabled = false;
                            btnEl.innerHTML = origHtml;
                        }
                    }
                },
                (err) => {
                    if (btnEl) {
                        btnEl.disabled = false;
                        btnEl.innerHTML = origHtml;
                    }
                    this.showNotice('Gagal membaca sensor GPS (' + (err?.message || 'Izin ditolak') + '). Silakan gunakan tombol <b>1. Buka Google Maps</b> &rarr; <b>2. Tempel &amp; Ekstrak Jalan Otomatis</b>.');
                },
                { enableHighAccuracy: true, timeout: 8500, maximumAge: 30000 }
            );
        };

        // Event Ekstraktor Google Maps di Checkout
        const btnCheckoutExtractGmaps = document.getElementById('btnCheckoutExtractGmaps');
        if (btnCheckoutExtractGmaps) {
            btnCheckoutExtractGmaps.addEventListener('click', () => {
                jalankanEkstraksiGmapsPelanggan('checkoutGmapsRaw', 'japarBuyerAddress', 'japarEmbeddedGpsInfo', btnCheckoutExtractGmaps);
            });
        }

        // Event Modal Setup Pertama Kali Memesan (#japarBuyerOnboardingModal)
        const onboardingModal = document.getElementById('japarBuyerOnboardingModal');
        const btnCloseOnboard = document.getElementById('btnCloseBuyerOnboardingModal');
        const btnOnboardExtract = document.getElementById('btnOnboardExtractGmaps');
        const btnOnboardGps = document.getElementById('btnOnboardDetectGps');
        const btnSaveOnboard = document.getElementById('btnSaveBuyerOnboarding');

        if (btnCloseOnboard && onboardingModal) {
            btnCloseOnboard.addEventListener('click', () => {
                onboardingModal.classList.add('hidden');
                this._pendingOnboardingCallback = null;
            });
        }
        if (btnOnboardExtract) {
            btnOnboardExtract.addEventListener('click', () => {
                jalankanEkstraksiGmapsPelanggan('onboardGmapsRaw', 'onboardBuyerAddress', 'onboardGpsStatusInfo', btnOnboardExtract);
            });
        }
        if (btnOnboardGps) {
            btnOnboardGps.addEventListener('click', () => {
                jalankanDeteksiGpsJalanPelanggan('onboardBuyerAddress', 'onboardGpsStatusInfo', btnOnboardGps);
            });
        }
        if (btnSaveOnboard) {
            btnSaveOnboard.addEventListener('click', () => {
                picuGetarSentuh(15);
                const nameVal = (document.getElementById('onboardBuyerName')?.value || '').trim();
                const waVal = (document.getElementById('onboardBuyerWA')?.value || '').trim();
                const rawGmapsVal = (document.getElementById('onboardGmapsRaw')?.value || '').trim();
                const addrVal = (document.getElementById('onboardBuyerAddress')?.value || '').trim();

                if (nameVal.length < 2) {
                    document.getElementById('onboardBuyerName')?.focus();
                    this.showNotice('Harap isi <b>Nama Pemesan</b> (minimal 2 karakter).');
                    return;
                }
                if (addrVal.length < 5) {
                    document.getElementById('onboardBuyerAddress')?.focus();
                    this.showNotice('Harap isi <b>Alamat Lengkap &amp; Patokan Rumah/Kos</b> (atau gunakan tombol Tempel Google Maps / Deteksi GPS di atas).');
                    return;
                }

                this._persistBuyerProfileToStorage({
                    name: nameVal,
                    wa: waVal,
                    rawGmapsInput: rawGmapsVal,
                    address: addrVal
                });
                this._syncSavedBuyerProfileLocksUI(false, false);

                if (onboardingModal) onboardingModal.classList.add('hidden');
                const cb = this._pendingOnboardingCallback;
                this._pendingOnboardingCallback = null;
                if (typeof cb === 'function') cb();
            });
        }

        // Event Halaman Profil & Alamat Saya (#page-profile)
        const btnBackProfile = document.getElementById('btnBackFromProfilePage');
        if (btnBackProfile) {
            btnBackProfile.addEventListener('click', () => {
                picuGetarSentuh(10);
                JaparPageRouter.navigateTo('explore');
            });
        }

        const btnToggleProfileLock = document.getElementById('btnToggleProfileAddressLock');
        if (btnToggleProfileLock) {
            btnToggleProfileLock.addEventListener('click', () => {
                picuGetarSentuh(10);
                if (this._isProfilePageUnlocked) {
                    const nVal = (document.getElementById('profileBuyerName')?.value || '').trim();
                    const aVal = (document.getElementById('profileBuyerAddress')?.value || '').trim();
                    if (nVal.length < 2 || aVal.length < 5) {
                        this.showNotice('Lengkapi Nama Pemesan dan Alamat Lengkap terlebih dahulu sebelum mengunci.');
                        return;
                    }
                    this._persistBuyerProfileToStorage({
                        name: nVal,
                        wa: (document.getElementById('profileBuyerWA')?.value || '').trim(),
                        rawGmapsInput: (document.getElementById('profileGmapsRaw')?.value || '').trim(),
                        address: aVal
                    });
                    this._syncProfilePageLockUI(false);
                } else {
                    this._syncProfilePageLockUI(true);
                    document.getElementById('profileBuyerAddress')?.focus();
                }
            });
        }

        const btnProfileExtractGmaps = document.getElementById('btnProfileExtractGmaps');
        if (btnProfileExtractGmaps) {
            btnProfileExtractGmaps.addEventListener('click', () => {
                jalankanEkstraksiGmapsPelanggan('profileGmapsRaw', 'profileBuyerAddress', 'profileGpsStatusInfo', btnProfileExtractGmaps);
            });
        }

        const btnProfileDetectGps = document.getElementById('btnProfileDetectGps');
        if (btnProfileDetectGps) {
            btnProfileDetectGps.addEventListener('click', () => {
                jalankanDeteksiGpsJalanPelanggan('profileBuyerAddress', 'profileGpsStatusInfo', btnProfileDetectGps);
            });
        }

        const btnSaveProfilePage = document.getElementById('btnSaveBuyerProfilePage');
        if (btnSaveProfilePage) {
            btnSaveProfilePage.addEventListener('click', () => {
                picuGetarSentuh(15);
                const nameVal = (document.getElementById('profileBuyerName')?.value || '').trim();
                const waVal = (document.getElementById('profileBuyerWA')?.value || '').trim();
                const gmapsVal = (document.getElementById('profileGmapsRaw')?.value || '').trim();
                const addrVal = (document.getElementById('profileBuyerAddress')?.value || '').trim();

                if (nameVal.length < 2) {
                    this._syncProfilePageLockUI(true);
                    document.getElementById('profileBuyerName')?.focus();
                    this.showNotice('Harap isi <b>Nama Pemesan</b> (minimal 2 karakter).');
                    return;
                }
                if (addrVal.length < 5) {
                    this._syncProfilePageLockUI(true);
                    document.getElementById('profileBuyerAddress')?.focus();
                    this.showNotice('Harap isi <b>Alamat Lengkap &amp; Patokan Rumah/Kos</b>.');
                    return;
                }

                this._persistBuyerProfileToStorage({
                    name: nameVal,
                    wa: waVal,
                    rawGmapsInput: gmapsVal,
                    address: addrVal
                });
                this._syncProfilePageLockUI(false);
                this._syncSavedBuyerProfileLocksUI(false, false);
                this.renderBuyerProfilePage();
                this.showNotice('Identitas dan Alamat Pengantaran Anda berhasil disimpan permanen di perangkat ini.', 'ALAMAT TERSIMPAN');
            });
        }

        const btnSubmitCheckout = document.getElementById('btnSubmitJaparCheckout');
        if (btnSubmitCheckout) {
            btnSubmitCheckout.addEventListener('click', () => {
                picuGetarSentuh(18);
                this._executeCheckoutSubmission();
            });
        }

        const btnBackOrders = document.getElementById('btnBackFromOrdersPage');
        if (btnBackOrders) {
            btnBackOrders.addEventListener('click', () => {
                picuGetarSentuh(10);
                JaparPageRouter.navigateTo('explore');
            });
        }

        const btnClearHistory = document.getElementById('btnClearOrderHistory');
        if (btnClearHistory) {
            btnClearHistory.addEventListener('click', () => {
                picuGetarSentuh(14);
                this.clearOrderHistory();
            });
        }

        const qrisModal = document.getElementById('japarQrisPreviewModal');
        const closeQrisModal = () => {
            if (qrisModal) qrisModal.classList.add('hidden');
        };
        const btnCloseQris = document.getElementById('btnCloseQrisPreviewModal');
        const btnDoneQris = document.getElementById('btnDoneQrisPreviewModal');
        if (btnCloseQris) btnCloseQris.addEventListener('click', closeQrisModal);
        if (btnDoneQris) btnDoneQris.addEventListener('click', closeQrisModal);

        const btnCloseNotice = document.getElementById('btnCloseJaparNoticeModal');
        const noticeModal = document.getElementById('japarNoticeModal');
        if (btnCloseNotice && noticeModal) {
            btnCloseNotice.addEventListener('click', () => {
                noticeModal.classList.add('hidden');
            });
        }
    }
};

window.CatalogOrderEngine = CatalogOrderEngine;

(() => {
    const _boot = () => {
        if (document.getElementById('umkmMerchantsGrid')) {
            CatalogOrderEngine.init();
        }
    };
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _boot, { once: true });
    } else {
        _boot();
    }
})();
