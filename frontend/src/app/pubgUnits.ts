const PUBG_COORDINATE_UNITS_PER_METER = 100;

export function pubgUnitsToMeters(value: number) {
  return value / PUBG_COORDINATE_UNITS_PER_METER;
}

export function pubgUnitsToKilometers(value: number) {
  return pubgUnitsToMeters(value) / 1000;
}

export function formatPubgDistance(value: number) {
  const meters = pubgUnitsToMeters(value);
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)}km`;
  return `${Math.round(meters)}m`;
}
