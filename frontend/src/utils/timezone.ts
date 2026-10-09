/**
 * Standard Timezones supported across CAN Do ESP32 firmware and web UI.
 */

export interface StandardTimezone {
  id: string;
  label: string;
}

export const STANDARD_TIMEZONES: StandardTimezone[] = [
  { id: 'US/Pacific', label: 'US Pacific (PT)' },
  { id: 'US/Mountain', label: 'US Mountain (MT)' },
  { id: 'US/Arizona', label: 'US Arizona (MST, no DST)' },
  { id: 'US/Central', label: 'US Central (CT)' },
  { id: 'US/Eastern', label: 'US Eastern (ET)' },
  { id: 'US/Alaska', label: 'US Alaska (AKT)' },
  { id: 'US/Hawaii', label: 'US Hawaii (HST)' },
  { id: 'Europe/London', label: 'Western Europe / UK (GMT/BST)' },
  { id: 'Europe/Berlin', label: 'Central Europe (CET/CEST)' },
  { id: 'Europe/Helsinki', label: 'Eastern Europe (EET/EEST)' },
  { id: 'Asia/Tokyo', label: 'Japan (JST)' },
  { id: 'Australia/Sydney', label: 'Australia Eastern (AEST/AEDT)' },
  { id: 'Australia/Adelaide', label: 'Australia Central (ACST/ACDT)' },
  { id: 'Australia/Perth', label: 'Australia Western (AWST)' },
  { id: 'UTC', label: 'UTC / GMT' },
];

/**
 * Detect browser's local timezone and map to the nearest standard timezone ID.
 */
export function detectBrowserTimezone(): string {
  try {
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!browserTz) return 'US/Pacific';

    const lower = browserTz.toLowerCase();

    // Direct matches
    for (const tz of STANDARD_TIMEZONES) {
      if (tz.id.toLowerCase() === lower) return tz.id;
    }

    // Common regional mappings
    if (lower.includes('los_angeles') || lower.includes('vancouver') || lower.includes('tijuana') || lower.includes('pacific')) {
      return 'US/Pacific';
    }
    if (lower.includes('denver') || lower.includes('edmonton') || lower.includes('mountain') || lower.includes('boise')) {
      return 'US/Mountain';
    }
    if (lower.includes('phoenix')) {
      return 'US/Arizona';
    }
    if (lower.includes('chicago') || lower.includes('winnipeg') || lower.includes('central') || lower.includes('mexico_city')) {
      return 'US/Central';
    }
    if (lower.includes('new_york') || lower.includes('toronto') || lower.includes('detroit') || lower.includes('eastern') || lower.includes('montreal')) {
      return 'US/Eastern';
    }
    if (lower.includes('anchorage') || lower.includes('alaska') || lower.includes('juneau')) {
      return 'US/Alaska';
    }
    if (lower.includes('honolulu') || lower.includes('hawaii')) {
      return 'US/Hawaii';
    }
    if (lower.includes('london') || lower.includes('dublin') || lower.includes('lisbon')) {
      return 'Europe/London';
    }
    if (lower.includes('berlin') || lower.includes('paris') || lower.includes('rome') || lower.includes('madrid') || lower.includes('amsterdam') || lower.includes('brussels') || lower.includes('warsaw') || lower.includes('vienna')) {
      return 'Europe/Berlin';
    }
    if (lower.includes('helsinki') || lower.includes('athens') || lower.includes('bucharest') || lower.includes('kyiv')) {
      return 'Europe/Helsinki';
    }
    if (lower.includes('tokyo') || lower.includes('japan')) {
      return 'Asia/Tokyo';
    }
    if (lower.includes('sydney') || lower.includes('melbourne') || lower.includes('brisbane') || lower.includes('canberra')) {
      return 'Australia/Sydney';
    }
    if (lower.includes('adelaide') || lower.includes('darwin')) {
      return 'Australia/Adelaide';
    }
    if (lower.includes('perth')) {
      return 'Australia/Perth';
    }

    // Offset-based approximation if unknown city
    const offsetMin = -new Date().getTimezoneOffset();
    if (offsetMin === -480 || offsetMin === -420) return 'US/Pacific';
    if (offsetMin === -360 || offsetMin === -300) return 'US/Central';
    if (offsetMin === -300 || offsetMin === -240) return 'US/Eastern';
    if (offsetMin === 0 || offsetMin === 60) return 'Europe/London';
    if (offsetMin === 60 || offsetMin === 120) return 'Europe/Berlin';

    return 'UTC';
  } catch {
    return 'US/Pacific';
  }
}

/**
 * Returns user-friendly label for a timezone identifier.
 */
export function getTimezoneLabel(tzId?: string): string {
  if (!tzId) return 'UTC / GMT';
  const found = STANDARD_TIMEZONES.find(t => t.id.toLowerCase() === tzId.toLowerCase());
  return found ? found.label : tzId;
}
