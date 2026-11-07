// ==========================================================================
// FILE: js/config/credentials.js (JAPAR PUBLIK - FEDERATED DUAL-NODE N1 & N2)
// FUNGSI: Konfigurasi Runtime Katalog Publik JAPAR (Dienkripsi ke RC4 + XOR Vault saat Build)
// ==========================================================================

export const firebaseConfigNode1 = {
  apiKey: "AIzaSyBOCoI-PzDg89AZmAWjryioJj1hIBPuLso",
  authDomain: "japar-b1c5d.firebaseapp.com",
  databaseURL: "https://japar-b1c5d-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "japar-b1c5d",
  storageBucket: "japar-b1c5d.firebasestorage.app",
  messagingSenderId: "332026051029",
  appId: "1:332026051029:web:281bc141eb6ff58f9f255c"
};

export const firebaseConfigNode2 = {
  apiKey: "AIzaSyD1YmNrYAwTOcBGSozKKDztUr8fC0C-lKQ",
  authDomain: "japar-2.firebaseapp.com",
  databaseURL: "https://japar-2-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "japar-2",
  storageBucket: "japar-2.firebasestorage.app",
  messagingSenderId: "805858048959",
  appId: "1:805858048959:web:2f017343aba69c89d67f0a"
};

export const JAPAR_PUBLIC_NODES = [
  { id: "N1", projectId: firebaseConfigNode1.projectId, databaseURL: firebaseConfigNode1.databaseURL, apiKey: firebaseConfigNode1.apiKey },
  { id: "N2", projectId: firebaseConfigNode2.projectId, databaseURL: firebaseConfigNode2.databaseURL, apiKey: firebaseConfigNode2.apiKey }
];

export const firebaseConfig = firebaseConfigNode1;

export const cloudinaryConfig = {
  cloudName: "odo6kdaz",
  uploadPreset: "my-archivestory",
  uploadEndpoint: "https://api.cloudinary.com/v1_1/odo6kdaz/image/upload",
  deliveryBaseUrl: "https://res.cloudinary.com/odo6kdaz/image/upload/f_auto,q_auto,w_400/"
};

export const JAPAR_GAS_MAPS_URL = "https://script.google.com/macros/s/AKfycbwEDdv6dBZ878K93thmk5MgdfqZieEHA_wLXprJfe29EZ5lghRsoP-APysm2HcrK6q8/exec";

export const configPublicMerchant = {
  projectId: firebaseConfig.projectId,
  databaseURL: firebaseConfig.databaseURL,
  gasMapsUrl: JAPAR_GAS_MAPS_URL,
  defaultCenter: { lat: -7.768049, lng: 112.196514 },
  maxRadiusKm: 20.0
};
