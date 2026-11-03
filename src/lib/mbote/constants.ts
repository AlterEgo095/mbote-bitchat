/** Villes présélectionnées pour créer des canaux géohash (lat, lng) */
export const CITY_PRESETS: { name: string; country: string; lat: number; lng: number }[] = [
  { name: "Kinshasa", country: "RDC", lat: -4.325, lng: 15.322 },
  { name: "Lubumbashi", country: "RDC", lat: -11.6647, lng: 27.4794 },
  { name: "Goma", country: "RDC", lat: -1.6829, lng: 29.2244 },
  { name: "Bukavu", country: "RDC", lat: -2.5083, lng: 28.8608 },
  { name: "Kisangani", country: "RDC", lat: 0.5228, lng: 25.1874 },
  { name: "Matadi", country: "RDC", lat: -5.825, lng: 13.451 },
  { name: "Mbuji-Mayi", country: "RDC", lat: -6.136, lng: 23.5897 },
  { name: "Dakar", country: "Sénégal", lat: 14.6928, lng: -17.4467 },
  { name: "Lagos", country: "Nigéria", lat: 6.5244, lng: 3.3792 },
  { name: "Nairobi", country: "Kenya", lat: -1.2921, lng: 36.8219 },
  { name: "Abidjan", country: "Côte d'Ivoire", lat: 5.36, lng: -4.0083 },
  { name: "Paris", country: "France", lat: 48.8566, lng: 2.3522 },
  { name: "Bruxelles", country: "Belgique", lat: 50.8476, lng: 4.3572 },
];

export const MAX_POST_LENGTH = 500;
export const BOT_NICKNAME = "Mbote Bot";

/** Clés localStorage */
export const LS_IDENTITY = "mbote_identity_v1";
export const LS_OUTBOX = "mbote_outbox_v1";
export const LS_FORCE_OFFLINE = "mbote_force_offline";
export const LS_READ_DMS = "mbote_read_dms";
