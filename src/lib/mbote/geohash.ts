/**
 * Encodeur/décodeur Geohash isomorphe (client + serveur).
 * Précisions BitChat : 7=bloc(~150m) 6=quartier 5=ville 4=province 2=pays
 */

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export function encodeGeohash(lat: number, lng: number, precision = 7): string {
  let idx = 0;
  let bit = 0;
  let evenBit = true;
  let hash = "";

  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;

  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        idx = (idx << 1) + 1;
        lngMin = mid;
      } else {
        idx = idx << 1;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        idx = (idx << 1) + 1;
        latMin = mid;
      } else {
        idx = idx << 1;
        latMax = mid;
      }
    }
    evenBit = !evenBit;

    if (++bit === 5) {
      hash += BASE32[idx];
      bit = 0;
      idx = 0;
    }
  }

  return hash;
}

export const PRECISION_LABELS: Record<number, string> = {
  7: "Bloc",
  6: "Quartier",
  5: "Ville",
  4: "Province",
  3: "Région",
  2: "Pays",
};

export function precisionLabel(p: number): string {
  return PRECISION_LABELS[p] ?? `Précision ${p}`;
}

/** Rayon approximatif d'une cellule geohash en mètres */
export function precisionRadius(p: number): string {
  switch (p) {
    case 7: return "~150 m";
    case 6: return "~1,2 km";
    case 5: return "~5 km";
    case 4: return "~40 km";
    case 3: return "~150 km";
    case 2: return "~800 km";
    default: return "—";
  }
}
