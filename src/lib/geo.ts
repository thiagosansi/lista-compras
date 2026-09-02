/** Utilidades geográficas (sem dependências). */

export type LatLng = { lat: number; lng: number };

const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Distância em km entre dois pontos pela fórmula de haversine. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Retorna o candidato mais próximo de `origin` (ignora os sem coordenadas). */
export function nearest<T extends { lat: number | null; lng: number | null }>(
  origin: LatLng,
  candidates: T[],
): { item: T; distanceKm: number } | null {
  let best: { item: T; distanceKm: number } | null = null;
  for (const c of candidates) {
    if (c.lat == null || c.lng == null) continue;
    const d = haversineKm(origin, { lat: c.lat, lng: c.lng });
    if (!best || d < best.distanceKm) best = { item: c, distanceKm: d };
  }
  return best;
}
