/**
 * Maps the casual phrasing a Retell voice agent will hear into the canonical
 * Xtime "operation codes" that the booking endpoint expects.
 *
 * Codes vary by dealer/OEM. These defaults match what we observed for Subaru
 * service menus on Xtime; override per-dealer via the `dealers` table later.
 */

export interface ServiceMapping {
  code: string;
  description: string;
}

// Codes mirror the `dmsOpcode` values captured from McGovern Subaru's
// /maintenance and /repair endpoints. The route matches against
// `dmsOpcode` first, then falls back to service-name keyword search.
const TABLE: Array<{ match: RegExp; mapping: ServiceMapping }> = [
  // Oil change family — dmsOpcode "1" = "Replace engine oil and filter"
  { match: /\b(oil\s*(?:and|&)?\s*filter|oil\s*change|lof|lube|oil)\b/i,
    mapping: { code: '1', description: 'Replace Engine Oil & Filter' } },

  // Tire rotation — dmsOpcode "3"
  { match: /\b(tire\s*rotat|rotate\s*tires?|rotation)\b/i,
    mapping: { code: '3', description: 'Tire Rotation' } },

  // Tire balance & rotate — dmsOpcode "2"
  { match: /\b(balance|tire\s*balance)\b/i,
    mapping: { code: '2', description: 'Tire Balance & Rotate' } },

  // Brake fluid flush — dmsOpcode "17"
  { match: /\bbrake\s*fluid|brake\s*flush\b/i,
    mapping: { code: '17', description: 'Brake Fluid Flush' } },

  // Brake diagnosis / service — dmsOpcode "BRAKE"
  { match: /\b(brake|pads?|rotors?)\b/i,
    mapping: { code: 'BRAKE', description: 'Brake Service' } },

  // MA state inspection — dmsOpcode "SI"
  { match: /\b(state\s*inspection|sticker|safety\s*inspection)\b/i,
    mapping: { code: 'SI', description: 'State Inspection' } },

  // Battery — dmsOpcode "25" (service) or "12"/"BATTERY" (replacement)
  { match: /\bbattery\s*(replac|swap|new)/i,
    mapping: { code: '12', description: 'Battery Replacement' } },
  { match: /\bbattery\b/i,
    mapping: { code: '25', description: 'Battery Service' } },

  // Cabin air filter — dmsOpcode "CABIN"
  { match: /\b(cabin\s*(?:air\s*)?filter|a\/?c\s*filter)\b/i,
    mapping: { code: 'CABIN', description: 'Cabin Air Filter Replacement' } },

  // Engine air filter — dmsOpcode "5"
  { match: /\b(engine\s*air\s*filter|air\s*cleaner)\b/i,
    mapping: { code: '5', description: 'Engine Air Filter Replacement' } },

  // Wheel alignment — dmsOpcode "11"
  { match: /\b(four\s*wheel\s*)?align/i,
    mapping: { code: '11', description: 'Four Wheel Alignment' } },

  // Wiper blades — dmsOpcode "WIPER"
  { match: /\bwiper/i,
    mapping: { code: 'WIPER', description: 'Wiper Blade Replacement' } },

  // Multi-point inspection — dmsOpcode "22"
  { match: /\b(multi[-\s]*point|mpi)\b/i,
    mapping: { code: '22', description: 'Multi-Point Inspection' } },

  // Recall — dmsOpcode "RECALL"
  { match: /\brecall\b/i,
    mapping: { code: 'RECALL', description: 'Factory Recall' } },

  // Check engine light — dmsOpcode "CEL"
  { match: /\b(check\s*engine|cel|warning\s*light)\b/i,
    mapping: { code: 'CEL', description: 'Check Engine Diagnosis' } },

  // Scheduled mileage menus (e.g. "30k service") — dealer menus
  { match: /\b(\d{1,3})\s*k\b/i,
    mapping: { code: '13', description: 'Scheduled Maintenance' } },

  // Generic inspection — multi-point
  { match: /\binspection\b/i,
    mapping: { code: '22', description: 'Multi-Point Inspection' } },
];

export function resolveServiceCode(input: string | undefined): ServiceMapping {
  const text = (input ?? '').trim();
  for (const row of TABLE) {
    if (row.match.test(text)) return row.mapping;
  }
  // Fallback: punt to a generic "diagnose" so the booking still goes through.
  return { code: 'DIAG', description: text || 'Service Visit' };
}
