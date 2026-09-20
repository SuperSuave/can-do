/**
 * User Preferences & Update Configuration Data Structures
 */

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
}

export const STORAGE_KEY_USER_PREFERENCES = 'can_do_user_preferences';

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  onboarding_completed: false,
  vehicle_id: 'hi5_limited',
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

  return updated;
}
