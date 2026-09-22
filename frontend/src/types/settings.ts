/**
 * User Preferences & Update Configuration Data Structures
 */

import { resolveDeviceBaseUrl } from '../utils/hostUtils';

export type UpdatePolicy = 'auto' | 'prompt' | 'manual';

export interface UpdateComponentSelection {
  firmware: boolean;
  catalog: boolean;
  frontend: boolean;
}

export interface UpdateScheduleConfig {
  enabled: boolean;
  time: string; // "HH:MM", e.g. "03:00"
}

export interface UserPreferences {
  onboarding_completed: boolean;
  vehicle_id: string;
  unit_system: 'imperial' | 'metric';
  update_policy: UpdatePolicy;
  update_components: UpdateComponentSelection;
  update_schedule: UpdateScheduleConfig;
  ha_prompt_dismissed: boolean;
  last_update_check?: string;
  min_12v_gate_voltage?: number;
  quiet_hours_enabled?: boolean;
  quiet_hours_start?: string;
  quiet_hours_end?: string;
  uds_sleep_delay_sec?: number;
  uds_awake_interval_sec?: number;
}

export const STORAGE_KEY_USER_PREFERENCES = 'can_do_user_preferences';

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  onboarding_completed: false,
  vehicle_id: 'ev6_gtline',
  unit_system: 'imperial',
  update_policy: 'prompt', // Prompt user when updates are detected by default
  update_components: {
    firmware: true,
    catalog: true,
    frontend: true,
  },
  update_schedule: {
    enabled: false,
    time: '03:00',
  },
  ha_prompt_dismissed: false,
  min_12v_gate_voltage: 12.2,
  quiet_hours_enabled: false,
  quiet_hours_start: '22:00',
  quiet_hours_end: '07:00',
  uds_sleep_delay_sec: 10,
  uds_awake_interval_sec: 15,
};

export function getUserPreferences(): UserPreferences {
  if (typeof window === 'undefined') return DEFAULT_USER_PREFERENCES;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_USER_PREFERENCES);
    if (!raw) return DEFAULT_USER_PREFERENCES;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_USER_PREFERENCES,
      ...parsed,
      update_components: {
        ...DEFAULT_USER_PREFERENCES.update_components,
        ...(parsed.update_components || {}),
      },
      update_schedule: {
        ...DEFAULT_USER_PREFERENCES.update_schedule,
        ...(parsed.update_schedule || {}),
      },
    };
  } catch (e) {
    console.error('Failed to parse user preferences from localStorage', e);
    return DEFAULT_USER_PREFERENCES;
  }
}

export async function fetchDevicePreferences(): Promise<UserPreferences | null> {
  if (typeof window === 'undefined') return null;
  try {
    const baseUrl = resolveDeviceBaseUrl();
    const res = await fetch(`${baseUrl}/api/preferences`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        const merged: UserPreferences = {
          ...DEFAULT_USER_PREFERENCES,
          ...data,
          update_components: {
            ...DEFAULT_USER_PREFERENCES.update_components,
            ...(data.update_components || {}),
          },
          update_schedule: {
            ...DEFAULT_USER_PREFERENCES.update_schedule,
            ...(data.update_schedule || {}),
          },
        };
        try {
          localStorage.setItem(STORAGE_KEY_USER_PREFERENCES, JSON.stringify(merged));
        } catch {
          // Ignore localStorage quota errors
        }
        return merged;
      }
    }
  } catch {
    // Offline / device not currently reachable
  }
  return null;
}

export async function savePreferencesToDevice(prefs: UserPreferences): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  try {
    const baseUrl = resolveDeviceBaseUrl();
    const res = await fetch(`${baseUrl}/api/preferences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function saveUserPreferences(prefs: Partial<UserPreferences>): UserPreferences {
  const current = getUserPreferences();
  const updated: UserPreferences = {
    ...current,
    ...prefs,
    update_components: {
      ...current.update_components,
      ...(prefs.update_components || {}),
    },
    update_schedule: {
      ...current.update_schedule,
      ...(prefs.update_schedule || {}),
    },
  };

  try {
    localStorage.setItem(STORAGE_KEY_USER_PREFERENCES, JSON.stringify(updated));
  } catch (e) {
    console.error('Failed to save user preferences to localStorage', e);
  }

  // Push directly to CAN Do hardware device flash/spiffs storage asynchronously
  savePreferencesToDevice(updated).catch(() => {});

  return updated;
}
