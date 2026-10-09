#include "timezone_mgr.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cctype>
#include <string>
#include "esp_log.h"
#include "cJSON.h"

static const char* TAG = "TZ_MGR";

struct TzMapping {
    const char* id;
    const char* label;
    const char* posix;
    const char* aliases[8];
};

static const TzMapping s_timezones[] = {
    {
        "US/Pacific", "US Pacific (PT)", "PST8PDT,M3.2.0,M11.1.0",
        {"America/Los_Angeles", "PST8PDT", "US/Pacific", "us_pacific", "Pacific", nullptr}
    },
    {
        "US/Mountain", "US Mountain (MT)", "MST7MDT,M3.2.0,M11.1.0",
        {"America/Denver", "America/Edmonton", "MST7MDT", "US/Mountain", "us_mountain", "Mountain", nullptr}
    },
    {
        "US/Arizona", "US Arizona (MST, no DST)", "MST7",
        {"America/Phoenix", "MST", "US/Arizona", "us_arizona", "Arizona", nullptr}
    },
    {
        "US/Central", "US Central (CT)", "CST6CDT,M3.2.0,M11.1.0",
        {"America/Chicago", "America/Winnipeg", "CST6CDT", "US/Central", "us_central", "Central", nullptr}
    },
    {
        "US/Eastern", "US Eastern (ET)", "EST5EDT,M3.2.0,M11.1.0",
        {"America/New_York", "America/Detroit", "America/Toronto", "EST5EDT", "US/Eastern", "us_eastern", "Eastern", nullptr}
    },
    {
        "US/Alaska", "US Alaska (AKT)", "AKST9AKDT,M3.2.0,M11.1.0",
        {"America/Anchorage", "America/Juneau", "AKST9AKDT", "US/Alaska", "us_alaska", "Alaska", nullptr}
    },
    {
        "US/Hawaii", "US Hawaii (HST)", "HST10",
        {"Pacific/Honolulu", "HST", "US/Hawaii", "us_hawaii", "Hawaii", nullptr}
    },
    {
        "Europe/London", "Western Europe / UK (GMT/BST)", "GMT0BST,M3.5.0/1,M10.5.0",
        {"Europe/London", "Europe/Dublin", "Europe/Lisbon", "GB", "GMT0BST", "europe_western", nullptr}
    },
    {
        "Europe/Berlin", "Central Europe (CET/CEST)", "CET-1CEST,M3.5.0,M10.5.0/3",
        {"Europe/Berlin", "Europe/Paris", "Europe/Rome", "Europe/Madrid", "Europe/Amsterdam", "Europe/Brussels", "CET-1CEST", "europe_central", nullptr}
    },
    {
        "Europe/Helsinki", "Eastern Europe (EET/EEST)", "EET-2EEST,M3.5.0/3,M10.5.0/4",
        {"Europe/Helsinki", "Europe/Athens", "Europe/Bucharest", "Europe/Kyiv", "EET-2EEST", "europe_eastern", nullptr}
    },
    {
        "Asia/Tokyo", "Japan (JST)", "JST-9",
        {"Asia/Tokyo", "Japan", "JST-9", "asia_tokyo", nullptr}
    },
    {
        "Australia/Sydney", "Australia Eastern (AEST/AEDT)", "AEST-10AEDT,M10.1.0,M4.1.0/3",
        {"Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Canberra", "AEST-10AEDT", "australia_eastern", nullptr}
    },
    {
        "Australia/Adelaide", "Australia Central (ACST/ACDT)", "ACST-9:30ACDT,M10.1.0,M4.1.0/3",
        {"Australia/Adelaide", "Australia/Darwin", "ACST-9:30ACDT", "australia_central", nullptr}
    },
    {
        "Australia/Perth", "Australia Western (AWST)", "AWST-8",
        {"Australia/Perth", "AWST-8", "australia_western", nullptr}
    },
    {
        "UTC", "UTC / GMT", "UTC0",
        {"UTC", "GMT", "Etc/UTC", "UTC0", nullptr}
    }
};

static const size_t s_num_timezones = sizeof(s_timezones) / sizeof(s_timezones[0]);

static std::string s_current_id = "UTC";
static std::string s_current_posix = "UTC0";

static bool str_equals_ci(const char* a, const char* b) {
    if (!a || !b) return false;
    while (*a && *b) {
        if (std::tolower((unsigned char)*a) != std::tolower((unsigned char)*b)) return false;
        a++;
        b++;
    }
    return *a == *b;
}

static const TzMapping* find_tz(const char* tz_query) {
    if (!tz_query || strlen(tz_query) == 0) return nullptr;
    for (size_t i = 0; i < s_num_timezones; i++) {
        if (str_equals_ci(tz_query, s_timezones[i].id)) {
            return &s_timezones[i];
        }
        for (size_t a = 0; a < 8 && s_timezones[i].aliases[a] != nullptr; a++) {
            if (str_equals_ci(tz_query, s_timezones[i].aliases[a])) {
                return &s_timezones[i];
            }
        }
    }
    return nullptr;
}

static void save_tz_to_preferences(const char* tz_id) {
    const char* filepath = "/spiffs/preferences.json";
    const char* temp_filepath = "/spiffs/preferences.json.tmp";

    cJSON* root = nullptr;
    FILE* f = fopen(filepath, "r");
    if (f) {
        fseek(f, 0, SEEK_END);
        long sz = ftell(f);
        fseek(f, 0, SEEK_SET);
        if (sz > 0) {
            char* buf = (char*)malloc(sz + 1);
            if (buf) {
                fread(buf, 1, sz, f);
                buf[sz] = '\0';
                root = cJSON_Parse(buf);
                free(buf);
            }
        }
        fclose(f);
    }

    if (!root) {
        root = cJSON_CreateObject();
    }

    cJSON_ReplaceItemInObject(root, "timezone", cJSON_CreateString(tz_id));
    if (!cJSON_GetObjectItem(root, "timezone")) {
        cJSON_AddStringToObject(root, "timezone", tz_id);
    }

    char* rendered = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!rendered) return;

    FILE* out = fopen(temp_filepath, "w");
    if (!out) {
        out = fopen(filepath, "w");
        if (out) {
            fputs(rendered, out);
            fclose(out);
        }
    } else {
        fputs(rendered, out);
        fclose(out);
        remove(filepath);
        rename(temp_filepath, filepath);
    }
    free(rendered);
}

bool timezone_mgr_set(const char* tz_id_or_name, bool persist) {
    if (!tz_id_or_name || strlen(tz_id_or_name) == 0) return false;

    const TzMapping* match = find_tz(tz_id_or_name);
    std::string new_id;
    std::string new_posix;

    if (match) {
        new_id = match->id;
        new_posix = match->posix;
    } else if (strchr(tz_id_or_name, ',') || strchr(tz_id_or_name, ':') || isdigit((unsigned char)tz_id_or_name[strlen(tz_id_or_name)-1])) {
        // Fallback: passed a raw POSIX string
        new_id = tz_id_or_name;
        new_posix = tz_id_or_name;
    } else {
        ESP_LOGW(TAG, "Unrecognized timezone '%s', defaulting to UTC", tz_id_or_name);
        new_id = "UTC";
        new_posix = "UTC0";
    }

    s_current_id = new_id;
    s_current_posix = new_posix;

    setenv("TZ", s_current_posix.c_str(), 1);
    tzset();

    ESP_LOGI(TAG, "Timezone set to %s (POSIX: %s)", s_current_id.c_str(), s_current_posix.c_str());

    if (persist) {
        save_tz_to_preferences(s_current_id.c_str());
    }

    return true;
}

const char* timezone_mgr_get_id(void) {
    return s_current_id.c_str();
}

const char* timezone_mgr_get_posix(void) {
    return s_current_posix.c_str();
}

void timezone_mgr_format_local(time_t epoch, char* out_buf, size_t max_len) {
    if (!out_buf || max_len == 0) return;
    struct tm timeinfo;
    localtime_r(&epoch, &timeinfo);
    strftime(out_buf, max_len, "%Y-%m-%d %H:%M:%S", &timeinfo);
}

void timezone_mgr_load_from_fs(void) {
    std::string found_tz = "";

    // 1. Try /spiffs/preferences.json
    FILE* f = fopen("/spiffs/preferences.json", "r");
    if (f) {
        fseek(f, 0, SEEK_END);
        long sz = ftell(f);
        fseek(f, 0, SEEK_SET);
        if (sz > 0) {
            char* buf = (char*)malloc(sz + 1);
            if (buf) {
                fread(buf, 1, sz, f);
                buf[sz] = '\0';
                cJSON* root = cJSON_Parse(buf);
                if (root) {
                    cJSON* tz = cJSON_GetObjectItem(root, "timezone");
                    if (cJSON_IsString(tz) && tz->valuestring && strlen(tz->valuestring) > 0) {
                        found_tz = tz->valuestring;
                    }
                    cJSON_Delete(root);
                }
                free(buf);
            }
        }
        fclose(f);
    }

    // 2. If not found in preferences, check /spiffs/automations.json settings
    if (found_tz.empty()) {
        f = fopen("/spiffs/automations.json", "r");
        if (f) {
            fseek(f, 0, SEEK_END);
            long sz = ftell(f);
            fseek(f, 0, SEEK_SET);
            if (sz > 0) {
                char* buf = (char*)malloc(sz + 1);
                if (buf) {
                    fread(buf, 1, sz, f);
                    buf[sz] = '\0';
                    cJSON* root = cJSON_Parse(buf);
                    if (root) {
                        cJSON* settings = cJSON_GetObjectItem(root, "settings");
                        if (cJSON_IsObject(settings)) {
                            cJSON* tz = cJSON_GetObjectItem(settings, "timezone");
                            if (cJSON_IsString(tz) && tz->valuestring && strlen(tz->valuestring) > 0) {
                                found_tz = tz->valuestring;
                            }
                        }
                        cJSON_Delete(root);
                    }
                    free(buf);
                }
            }
            fclose(f);
        }
    }

    if (found_tz.empty()) {
        found_tz = "UTC";
    }

    timezone_mgr_set(found_tz.c_str(), false);
}

void timezone_mgr_init(void) {
    timezone_mgr_load_from_fs();
}
