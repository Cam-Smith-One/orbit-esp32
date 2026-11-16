#pragma once

namespace orbit_display {
enum class GestureDirection { Left, Right, Up, Down };

constexpr int PageAfterGesture(int page, GestureDirection direction) {
    if (page == -1 && direction == GestureDirection::Up) return -2;
    if (page == -2 && direction == GestureDirection::Down) return -1;
    return page;
}

constexpr bool ShouldHandleMenuClick(bool swiped) { return !swiped; }
}  // namespace orbit_display

#ifndef ORBIT_GESTURE_CHECK
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <deque>
#include <functional>
#include <string>
#include <stdexcept>

#include <esp_log.h>
#include <esp_timer.h>

#include "orb_pixels.h"
#include "settings.h"

// Board-only UI: keep the existing panel, touch, audio and power drivers intact.
class CustomLcdDisplay : public BoardLcdDisplay {
    struct Card {
        std::string title, value, body, source;
        bool weather = false;
        std::string humidity, wind, rain, tomorrow;
    };
    std::deque<Card> cards_;
    std::string last_response_;
    int page_ = -1;
    lv_obj_t *root_ = nullptr, *orb_ = nullptr, *glow_ = nullptr;
    lv_obj_t *state_ = nullptr, *caption_ = nullptr, *clock_ = nullptr, *battery_ = nullptr;
    lv_obj_t *card_ = nullptr, *title_ = nullptr, *value_ = nullptr, *body_ = nullptr, *body_scroll_ = nullptr;
    lv_obj_t *source_ = nullptr, *hint_ = nullptr;
    lv_obj_t *apps_ = nullptr, *settings_ = nullptr, *app_buttons_[4] = {};
    lv_obj_t *apps_status_ = nullptr, *settings_status_ = nullptr, *settings_back_ = nullptr;
    lv_obj_t *volume_slider_ = nullptr, *gain_slider_ = nullptr, *volume_value_ = nullptr, *gain_value_ = nullptr;
    lv_obj_t *weather_page_ = nullptr, *weather_city_ = nullptr, *weather_temp_ = nullptr;
    lv_obj_t *weather_detail_ = nullptr, *weather_humidity_ = nullptr, *weather_wind_ = nullptr;
    lv_obj_t *weather_rain_ = nullptr, *weather_tomorrow_ = nullptr, *weather_source_ = nullptr;
    lv_obj_t *weather_icon_glow_ = nullptr, *weather_sun_ = nullptr, *weather_cloud_ = nullptr;
    lv_obj_t *weather_cloud_left_ = nullptr, *weather_cloud_right_ = nullptr;
    lv_obj_t *weather_precip_[3] = {nullptr, nullptr, nullptr};
    std::function<void()> weather_action_;
    std::function<void()> calendar_action_;
    lv_timer_t* animation_ = nullptr;
    float phase_ = 0;
    bool sleeping_ = false;
    bool swiped_ = false;
    bool wake_only_ = false;
    DeviceState last_chrome_state_ = kDeviceStateUnknown;
    int last_chrome_page_ = -2;
    bool chrome_ready_ = false;
    bool gesture_consumed_ = false;
    static constexpr int kOrbPixels = 240;
    uint16_t* pixels_ = nullptr;
    OrbNormal* normals_ = nullptr;
    uint64_t orb_render_total_us_ = 0;
    uint32_t orb_render_frames_ = 0;
    uint32_t orb_render_max_us_ = 0;
    float tint_[3] = {45, 145, 255};
    float mood_[3] = {45, 145, 255};

    static void ReplaceAll(std::string& text, const char* from, const char* to) {
        const size_t from_len = strlen(from);
        const size_t to_len = strlen(to);
        for (size_t pos = 0; (pos = text.find(from, pos)) != std::string::npos; pos += to_len) {
            text.replace(pos, from_len, to);
        }
    }

    static std::string NormalizeText(const char* value) {
        std::string text = value ? value : "";
        ReplaceAll(text, "\xE2\x80\x90", "-");
        ReplaceAll(text, "\xE2\x80\x91", "-");
        ReplaceAll(text, "\xE2\x80\x92", "-");
        ReplaceAll(text, "\xE2\x80\x93", "-");
        ReplaceAll(text, "\xE2\x80\x94", "-");
        ReplaceAll(text, "\xE2\x88\x92", "-");
        ReplaceAll(text, "\xE2\x80\x98", "'");
        ReplaceAll(text, "\xE2\x80\x99", "'");
        ReplaceAll(text, "\xE2\x80\x9C", "\"");
        ReplaceAll(text, "\xE2\x80\x9D", "\"");
        ReplaceAll(text, "\xE2\x80\xA6", "...");
        ReplaceAll(text, "\xC2\xA0", " ");
        ReplaceAll(text, "\xC2\xB7", " | ");
        ReplaceAll(text, "\xE2\x80\xA2", "*");
        return text;
    }

    static void SetText(lv_obj_t* obj, const char* value) {
        if (!obj) return;
        const auto text = NormalizeText(value);
        const char* current = lv_label_get_text(obj);
        if (current && text == current) return;
        lv_label_set_text(obj, text.c_str());
    }

    static void SetText(lv_obj_t* obj, const std::string& value) {
        SetText(obj, value.c_str());
    }

    enum class WeatherIconKind { Unknown, Clear, PartlyCloudy, Cloudy, Rain, Snow };

    static WeatherIconKind WeatherKind(const std::string& detail) {
        auto text = NormalizeText(detail.c_str());
        std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) {
            return static_cast<char>(std::tolower(c));
        });
        if (text.find("snow") != std::string::npos || text.find("sleet") != std::string::npos ||
            text.find("ice pellets") != std::string::npos || text.find("icy") != std::string::npos ||
            text.find("freezing") != std::string::npos) return WeatherIconKind::Snow;
        if (text.find("rain") != std::string::npos || text.find("drizzle") != std::string::npos ||
            text.find("shower") != std::string::npos || text.find("storm") != std::string::npos ||
            text.find("thunder") != std::string::npos) return WeatherIconKind::Rain;
        if (text.find("partly") != std::string::npos || text.find("mostly sunny") != std::string::npos ||
            text.find("mostly cloudy") != std::string::npos) {
            return WeatherIconKind::PartlyCloudy;
        }
        if (text.find("clear") != std::string::npos || text.find("sunny") != std::string::npos) {
            return WeatherIconKind::Clear;
        }
        if (text.find("cloud") != std::string::npos || text.find("overcast") != std::string::npos ||
            text.find("fog") != std::string::npos || text.find("haze") != std::string::npos) {
            return WeatherIconKind::Cloudy;
        }
        return WeatherIconKind::Unknown;
    }

    void UpdateWeatherIcon(const std::string& detail) {
        if (!weather_sun_ || !weather_icon_glow_) return;
        const auto kind = WeatherKind(detail);
        const bool show_sun = kind == WeatherIconKind::Clear || kind == WeatherIconKind::PartlyCloudy;
        const bool show_cloud = kind == WeatherIconKind::PartlyCloudy || kind == WeatherIconKind::Cloudy ||
                                kind == WeatherIconKind::Rain || kind == WeatherIconKind::Snow;
        const bool show_precip = kind == WeatherIconKind::Rain || kind == WeatherIconKind::Snow;
        lv_obj_set_flag(weather_icon_glow_, LV_OBJ_FLAG_HIDDEN, kind == WeatherIconKind::Unknown);
        lv_obj_set_flag(weather_sun_, LV_OBJ_FLAG_HIDDEN, !show_sun);
        lv_obj_set_flag(weather_cloud_, LV_OBJ_FLAG_HIDDEN, !show_cloud);
        lv_obj_set_flag(weather_cloud_left_, LV_OBJ_FLAG_HIDDEN, !show_cloud);
        lv_obj_set_flag(weather_cloud_right_, LV_OBJ_FLAG_HIDDEN, !show_cloud);
        for (auto* drop : weather_precip_) lv_obj_set_flag(drop, LV_OBJ_FLAG_HIDDEN, !show_precip);
        const uint32_t cloud_color = kind == WeatherIconKind::Rain ? 0xD7EBFF : 0xE5F2FF;
        const uint32_t precip_color = kind == WeatherIconKind::Snow ? 0xFFFFFF : 0xBFE8FF;
        lv_obj_set_style_bg_color(weather_cloud_, lv_color_hex(cloud_color), 0);
        lv_obj_set_style_bg_color(weather_cloud_left_, lv_color_hex(cloud_color), 0);
        lv_obj_set_style_bg_color(weather_cloud_right_, lv_color_hex(cloud_color), 0);
        for (auto* drop : weather_precip_) lv_obj_set_style_bg_color(drop, lv_color_hex(precip_color), 0);
    }

    static const char* DeviceStateLabel(DeviceState state) {
        switch (state) {
        case kDeviceStateStarting: return "Starting";
        case kDeviceStateWifiConfiguring: return "Wi-Fi setup";
        case kDeviceStateIdle: return "Standby";
        case kDeviceStateConnecting: return "Connecting";
        case kDeviceStateListening: return "Listening";
        case kDeviceStateSpeaking: return "Speaking";
        case kDeviceStateNotifying: return "Notifying";
        case kDeviceStateUpgrading: return "Updating";
        case kDeviceStateActivating: return "Activating";
        case kDeviceStateAudioTesting: return "Audio test";
        case kDeviceStateFatalError: return "Error";
        case kDeviceStateUnknown:
        default: return "Unknown";
        }
    }

    static uint32_t DeviceStateColor(DeviceState state) {
        switch (state) {
        case kDeviceStateListening: return 0x9CFFFF;
        case kDeviceStateSpeaking:
        case kDeviceStateNotifying: return 0xFFD4EA;
        case kDeviceStateConnecting:
        case kDeviceStateStarting: return 0xFFE1A8;
        case kDeviceStateFatalError: return 0xFFC09A;
        default: return 0xE8F3FF;
        }
    }

    static bool IsActiveSession(DeviceState state) {
        return state == kDeviceStateConnecting || state == kDeviceStateListening ||
               state == kDeviceStateSpeaking || state == kDeviceStateNotifying;
    }

    static std::string ResponseExcerpt(const char* value) {
        auto text = NormalizeText(value);
        constexpr size_t kMaxExcerptBytes = 240;
        if (text.size() > kMaxExcerptBytes) {
            const size_t limit = kMaxExcerptBytes - 3;
            size_t safe_end = 0;
            while (safe_end < limit) {
                const unsigned char lead = static_cast<unsigned char>(text[safe_end]);
                size_t width = 1;
                if ((lead & 0x80) == 0) width = 1;
                else if ((lead & 0xE0) == 0xC0) width = 2;
                else if ((lead & 0xF0) == 0xE0) width = 3;
                else if ((lead & 0xF8) == 0xF0) width = 4;
                if (safe_end + width > limit || safe_end + width > text.size()) break;
                safe_end += width;
            }
            text.resize(safe_end);
            text += "...";
        }
        return text;
    }

    void SetCaptionText(const char* content, bool remember_response) {
        if (!caption_) return;
        const auto excerpt = ResponseExcerpt(content);
        if (remember_response && !excerpt.empty()) last_response_ = excerpt;
        if (!excerpt.empty()) {
            SetText(caption_, excerpt);
        } else if (!last_response_.empty()) {
            SetText(caption_, last_response_);
        } else {
            SetText(caption_, "Your pocket voice companion");
        }
    }

    void UpdateSessionChrome(bool force = false) {
        if (!hint_) return;
        const auto state = Application::GetInstance().GetDeviceState();
        SetText(apps_status_, IsActiveSession(state) ? "Voice session active" : "Swipe down for Orbit");
        SetText(settings_status_, IsActiveSession(state) ? "Voice session active" : "Back to Apps");
        const bool page_changed = page_ != last_chrome_page_;
        const bool state_changed = state != last_chrome_state_;
        if (!force && chrome_ready_ && !page_changed && !state_changed) return;

        const bool weather = page_ >= 0 && page_ < static_cast<int>(cards_.size()) && cards_[page_].weather;
        if (weather) {
            char footer[64];
            if (IsActiveSession(state)) {
                std::snprintf(footer, sizeof(footer), "%s / %d of %d", DeviceStateLabel(state), page_ + 1,
                              static_cast<int>(cards_.size()));
            } else {
                std::snprintf(footer, sizeof(footer), "Swipe cards / %d of %d", page_ + 1,
                              static_cast<int>(cards_.size()));
            }
            SetText(hint_, footer);
            lv_obj_set_style_text_color(hint_, lv_color_hex(0xFFFFFF), 0);
        } else if (page_ >= 0 && page_ < static_cast<int>(cards_.size())) {
            char footer[64];
            std::snprintf(footer, sizeof(footer), "Card %d of %d / swipe", page_ + 1,
                          static_cast<int>(cards_.size()));
            SetText(hint_, footer);
            lv_obj_set_style_text_color(hint_, lv_color_hex(0xB9C9E1), 0);
        } else {
            SetText(hint_, state == kDeviceStateListening ? "Tap to end" : state == kDeviceStateSpeaking ? "Tap to interrupt" : "Tap to talk / up: Apps");
            lv_obj_set_style_text_color(hint_, lv_color_hex(0xA9BCD8), 0);
        }

        last_chrome_state_ = state;
        last_chrome_page_ = page_;
        chrome_ready_ = true;
    }

    lv_obj_t* Label(lv_obj_t* parent, int y, int width, const lv_font_t* font, uint32_t color,
                    int height = 0, lv_label_long_mode_t mode = LV_LABEL_LONG_WRAP) {
        auto obj = lv_label_create(parent);
        lv_obj_set_width(obj, width);
        lv_obj_align(obj, LV_ALIGN_TOP_MID, 0, y);
        lv_obj_set_style_text_font(obj, font, 0);
        lv_obj_set_style_text_color(obj, lv_color_hex(color), 0);
        lv_obj_set_style_text_align(obj, LV_TEXT_ALIGN_CENTER, 0);
        if (height > 0) {
            lv_obj_set_height(obj, height);
            lv_label_set_long_mode(obj, mode);
        }
        lv_obj_add_flag(obj, static_cast<lv_obj_flag_t>(LV_OBJ_FLAG_EVENT_BUBBLE | LV_OBJ_FLAG_GESTURE_BUBBLE));
        SetText(obj, "");
        return obj;
    }

    lv_obj_t* Sphere(lv_obj_t* parent, int size, uint32_t color) {
        auto obj = lv_obj_create(parent);
        lv_obj_remove_style_all(obj);
        lv_obj_set_size(obj, size, size);
        lv_obj_set_style_radius(obj, LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_bg_color(obj, lv_color_hex(color), 0);
        lv_obj_set_style_bg_opa(obj, LV_OPA_COVER, 0);
        lv_obj_remove_flag(obj, static_cast<lv_obj_flag_t>(LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE));
        lv_obj_add_flag(obj, static_cast<lv_obj_flag_t>(LV_OBJ_FLAG_EVENT_BUBBLE | LV_OBJ_FLAG_GESTURE_BUBBLE));
        return obj;
    }

    lv_obj_t* Pill(lv_obj_t* parent, int x, int y, int width, int height) {
        auto obj = lv_obj_create(parent);
        lv_obj_remove_style_all(obj);
        lv_obj_align(obj, LV_ALIGN_TOP_LEFT, x, y);
        lv_obj_set_size(obj, width, height);
        lv_obj_set_style_radius(obj, 18, 0);
        lv_obj_set_style_bg_color(obj, lv_color_white(), 0);
        lv_obj_set_style_bg_opa(obj, LV_OPA_10, 0);
        lv_obj_set_style_border_width(obj, 1, 0);
        lv_obj_set_style_border_color(obj, lv_color_hex(0xC5E2FF), 0);
        lv_obj_set_style_border_opa(obj, LV_OPA_20, 0);
        lv_obj_remove_flag(obj, static_cast<lv_obj_flag_t>(LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE));
        lv_obj_add_flag(obj, static_cast<lv_obj_flag_t>(LV_OBJ_FLAG_EVENT_BUBBLE | LV_OBJ_FLAG_GESTURE_BUBBLE));
        return obj;
    }

    void WakeOnTouch() {
        if (!sleeping_) return;
        sleeping_ = false;
        wake_only_ = true;
        if (animation_) lv_timer_resume(animation_);
        Application::GetInstance().Schedule([] {
            Board::GetInstance().SetPowerSaveLevel(PowerSaveLevel::PERFORMANCE);
        });
    }

    void RenderPage() {
        bool showing = page_ >= 0 && page_ < static_cast<int>(cards_.size());
        bool weather = showing && cards_[page_].weather;
        bool calendar = showing && cards_[page_].title == "GOOGLE CALENDAR";
        lv_obj_set_flag(state_, LV_OBJ_FLAG_HIDDEN, calendar);
        lv_obj_set_height(card_, calendar ? 280 : 252);
        lv_obj_align(card_, LV_ALIGN_TOP_MID, 0, calendar ? 108 : 136);
        lv_obj_set_height(body_scroll_, calendar ? 110 : 78);
        lv_obj_set_y(source_, calendar ? 228 : 196);
        lv_obj_set_flag(apps_, LV_OBJ_FLAG_HIDDEN, page_ != -2);
        lv_obj_set_flag(settings_, LV_OBJ_FLAG_HIDDEN, page_ != -3);
        lv_obj_set_flag(hint_, LV_OBJ_FLAG_HIDDEN, page_ <= -2);
        lv_obj_set_flag(weather_page_, LV_OBJ_FLAG_HIDDEN, !weather);
        lv_obj_set_flag(card_, LV_OBJ_FLAG_HIDDEN, !showing || weather);
        lv_obj_set_flag(orb_, LV_OBJ_FLAG_HIDDEN, page_ != -1);
        lv_obj_set_flag(caption_, LV_OBJ_FLAG_HIDDEN, page_ != -1);
        if (weather) {
            const auto& c = cards_[page_];
            SetText(weather_city_, c.title.empty() ? "Weather" : c.title.c_str());
            auto weather_value = NormalizeText(c.value.empty() ? "--" : c.value.c_str());
            const lv_font_t* weather_font = &lv_font_montserrat_48;
            lv_point_t weather_value_size;
            lv_text_get_size(&weather_value_size, weather_value.c_str(), weather_font, 0, 0, 4096,
                             LV_TEXT_FLAG_NONE);
            if (weather_value_size.x > 136 || weather_value_size.y > 60) {
                weather_font = &lv_font_montserrat_32;
                lv_text_get_size(&weather_value_size, weather_value.c_str(), weather_font, 0, 0, 4096,
                                 LV_TEXT_FLAG_NONE);
                if (weather_value_size.x > 136 || weather_value_size.y > 60) weather_font = &lv_font_montserrat_22;
            }
            lv_obj_set_style_text_font(weather_temp_, weather_font, 0);
            SetText(weather_temp_, weather_value);
            SetText(weather_detail_, c.body.empty() ? "No condition data" : c.body.c_str());
            SetText(weather_humidity_, c.humidity.empty() ? "Humidity\n--" : c.humidity.c_str());
            SetText(weather_wind_, c.wind.empty() ? "Wind\n--" : c.wind.c_str());
            SetText(weather_rain_, c.rain.empty() ? "Rain\n--" : c.rain.c_str());
            SetText(weather_tomorrow_, c.tomorrow.empty() ? "No forecast data" : c.tomorrow.c_str());
            SetText(weather_source_, c.source.empty() ? "Source unavailable" : c.source.c_str());
            UpdateWeatherIcon(c.body);
        }
        if (showing) {
            const auto& c = cards_[page_];
            SetText(title_, c.title.empty() ? "Card" : c.title.c_str());
            auto value = NormalizeText(c.value.empty() ? "--" : c.value.c_str());
            const lv_font_t* value_font = &lv_font_montserrat_18;
            for (auto font : {&lv_font_montserrat_32, &lv_font_montserrat_22}) {
                lv_point_t size;
                lv_text_get_size(&size, value.c_str(), font, 0, 0, 4096, LV_TEXT_FLAG_NONE);
                if (size.x <= 284 && size.y <= 45) { value_font = font; break; }
            }
            lv_obj_set_style_text_font(value_, value_font, 0);
            SetText(value_, value);
            SetText(body_, c.body.empty() ? "No details" : c.body.c_str());
            lv_obj_scroll_to_y(body_scroll_, 0, LV_ANIM_OFF);
            SetText(source_, c.source.empty() ? "No source" : c.source.c_str());
        }
        UpdateSessionChrome(true);
    }

    void Animate() {
        if (sleeping_) return;
        const auto state = Application::GetInstance().GetDeviceState();
        UpdateSessionChrome();
        bool speaking = state == kDeviceStateSpeaking;
        bool listening = state == kDeviceStateListening;
        bool voice = listening && Application::GetInstance().GetAudioService().IsVoiceDetected();
        phase_ += speaking ? 0.12f : voice ? 0.10f : 0.035f;
        if (phase_ > 6.283185f) phase_ -= 6.283185f;
        // ponytail: state-driven animation, not a sample-accurate waveform visualizer.
        for (int c = 0; c < 3; ++c) tint_[c] += (mood_[c] - tint_[c]) * .055f;
        if (pixels_ && normals_ && page_ == -1) {
            const int64_t render_started_us = esp_timer_get_time();
            orb_render(pixels_, normals_, kOrbPixels, phase_, tint_);
            const int64_t render_elapsed_us = esp_timer_get_time() - render_started_us;
            if (render_elapsed_us >= 0) {
                const auto elapsed_us = static_cast<uint32_t>(render_elapsed_us);
                orb_render_total_us_ += elapsed_us;
                orb_render_max_us_ = std::max(orb_render_max_us_, elapsed_us);
                ++orb_render_frames_;
                if (orb_render_frames_ == 120) {
                    ESP_LOGI("OrbitUI", "Orb render mean=%llu max=%u us",
                             static_cast<unsigned long long>(orb_render_total_us_ / orb_render_frames_),
                             orb_render_max_us_);
                    orb_render_total_us_ = 0;
                    orb_render_max_us_ = 0;
                    orb_render_frames_ = 0;
                }
            }
            lv_obj_invalidate(glow_);
        }
    }

    void UpdateAudioLabels() {
        SetText(volume_value_, std::to_string(lv_slider_get_value(volume_slider_)) + "%");
        static constexpr const char* names[] = {"Low", "Balanced", "High"};
        SetText(gain_value_, names[std::clamp(static_cast<int>(lv_slider_get_value(gain_slider_)), 0, 2)]);
    }

    void LoadAudioSettings() {
        auto codec = Board::GetInstance().GetAudioCodec();
        lv_slider_set_value(volume_slider_, std::clamp(codec->output_volume(), 10, 100), LV_ANIM_OFF);
        lv_slider_set_value(gain_slider_, codec->input_gain() < 27 ? 0 : codec->input_gain() < 33 ? 1 : 2, LV_ANIM_OFF);
        UpdateAudioLabels();
    }

    void SelectApp(int index) {
        if (index == 0) {
            page_ = -1;
            RenderPage();
            auto action = calendar_action_;
            if (action) Application::GetInstance().Schedule([action] { action(); });
            return;
        }
        else if (index == 1) {
            page_ = -1;
            RenderPage();
            auto action = weather_action_;
            if (action) Application::GetInstance().Schedule([action] { action(); });
            return;
        }
        else if (index == 3) { LoadAudioSettings(); page_ = -3; }
        else {
            page_ = -1;
            for (size_t i = 0; i < cards_.size(); ++i) {
                if (index == 2 && cards_[i].title.find("NOTE") != std::string::npos) {
                    page_ = static_cast<int>(i);
                    break;
                }
            }
            if (page_ == -1) {
                cards_.push_front(Card{"VOICE NOTES", "Keep a thought", "Say 'Record a note'. Wait for the invitation, then dictate. Ask 'List my notes' to find it later.", "Notes stay on your Mac"});
                if (cards_.size() > 6) cards_.pop_back();
                page_ = 0;
            }
        }
        RenderPage();
    }

    void SetupApps() {
        apps_ = Sphere(root_, 466, 0x03070E);
        lv_obj_align(apps_, LV_ALIGN_TOP_LEFT, 0, 0);
        SetText(Label(apps_, 40, 240, &lv_font_montserrat_32, 0xF4F8FF), "Apps");
        apps_status_ = Label(apps_, 84, 290, &lv_font_montserrat_18, 0x9CAEC8, 26, LV_LABEL_LONG_DOT);
        static constexpr const char* titles[] = {"Calendar", "Weather", "Notes", "Settings"};
        static constexpr uint32_t colors[] = {0x255EDD, 0x116689, 0xAC6230, 0x3D465A};
        for (int i = 0; i < 4; ++i) {
            int x = (i & 1) ? 255 : 107;
            int y = i < 2 ? 128 : 270;
            auto button = app_buttons_[i] = Sphere(apps_, 104, colors[i]);
            lv_obj_align(button, LV_ALIGN_TOP_LEFT, x, y);
            lv_obj_add_flag(button, LV_OBJ_FLAG_CLICKABLE);
            lv_obj_set_style_bg_grad_color(button, lv_color_hex(0x101E37), 0);
            lv_obj_set_style_bg_grad_dir(button, LV_GRAD_DIR_VER, 0);
            lv_obj_set_style_border_width(button, 1, 0);
            lv_obj_set_style_border_color(button, lv_color_hex(0x90B2E9), 0);
            lv_obj_set_style_border_opa(button, LV_OPA_30, 0);
            lv_obj_set_style_transform_scale_x(button, 240, LV_STATE_PRESSED);
            lv_obj_set_style_transform_scale_y(button, 240, LV_STATE_PRESSED);
            lv_obj_set_style_transform_pivot_x(button, 52, 0);
            lv_obj_set_style_transform_pivot_y(button, 52, 0);
            if (i == 0) {
                auto paper = Sphere(button, 58, 0xEDF4FF);
                lv_obj_align(paper, LV_ALIGN_CENTER, 0, 0);
                lv_obj_set_style_radius(paper, 10, 0);
                auto band = Sphere(paper, 58, 0xDB526A);
                lv_obj_set_size(band, 58, 14);
                lv_obj_align(band, LV_ALIGN_TOP_MID, 0, 0);
                SetText(Label(paper, 19, 50, &lv_font_montserrat_22, 0x173454), LV_SYMBOL_LIST);
            } else if (i == 1) {
                auto sun = Sphere(button, 30, 0xFFE3A0);
                lv_obj_align(sun, LV_ALIGN_TOP_LEFT, 50, 23);
                auto cloud = Sphere(button, 36, 0xE8F5FF);
                lv_obj_align(cloud, LV_ALIGN_TOP_LEFT, 35, 37);
                auto cloud_left = Sphere(button, 26, 0xE8F5FF);
                lv_obj_align(cloud_left, LV_ALIGN_TOP_LEFT, 23, 47);
            } else {
                SetText(Label(button, 34, 84, &lv_font_montserrat_32, 0xF5FAFF), i == 2 ? LV_SYMBOL_EDIT : LV_SYMBOL_SETTINGS);
            }
            auto title = Label(apps_, y + 109, 116, &lv_font_montserrat_18, 0xDDE9FA, 26, LV_LABEL_LONG_DOT);
            lv_obj_align(title, LV_ALIGN_TOP_LEFT, x - 6, y + 109);
            SetText(title, titles[i]);
            lv_obj_add_event_cb(button, [](lv_event_t* event) {
                auto self = static_cast<CustomLcdDisplay*>(lv_event_get_user_data(event));
                lv_event_stop_bubbling(event);
                self->gesture_consumed_ = true;
                if (self->wake_only_) { self->wake_only_ = false; return; }
                if (!orbit_display::ShouldHandleMenuClick(self->swiped_)) return;
                auto target = static_cast<lv_obj_t*>(lv_event_get_current_target(event));
                for (int i = 0; i < 4; ++i) if (self->app_buttons_[i] == target) self->SelectApp(i);
            }, LV_EVENT_CLICKED, this);
        }
        settings_ = Sphere(root_, 466, 0x03070E);
        lv_obj_align(settings_, LV_ALIGN_TOP_LEFT, 0, 0);
        SetText(Label(settings_, 40, 260, &lv_font_montserrat_32, 0xF4F8FF), "Settings");
        settings_status_ = Label(settings_, 84, 290, &lv_font_montserrat_18, 0x9CAEC8, 26, LV_LABEL_LONG_DOT);
        SetText(Label(settings_, 124, 270, &lv_font_montserrat_18, 0x9CAEC8), "Speaker volume");
        volume_value_ = Label(settings_, 152, 270, &lv_font_montserrat_22, 0xF4F8FF);
        SetText(Label(settings_, 236, 270, &lv_font_montserrat_18, 0x9CAEC8), "Mic sensitivity");
        gain_value_ = Label(settings_, 264, 270, &lv_font_montserrat_22, 0xF4F8FF);
        for (int i = 0; i < 2; ++i) {
            auto slider = lv_slider_create(settings_);
            if (i == 0) volume_slider_ = slider; else gain_slider_ = slider;
            lv_obj_set_size(slider, 260, 12);
            lv_obj_align(slider, LV_ALIGN_TOP_MID, 0, i == 0 ? 199 : 311);
            lv_slider_set_range(slider, i == 0 ? 10 : 0, i == 0 ? 100 : 2);
            lv_obj_set_ext_click_area(slider, 22);
            lv_obj_set_style_bg_color(slider, lv_color_hex(0x22334F), LV_PART_MAIN);
            lv_obj_set_style_bg_color(slider, lv_color_hex(0x65B8FF), LV_PART_INDICATOR);
            lv_obj_set_style_bg_color(slider, lv_color_hex(0xF4F8FF), LV_PART_KNOB);
            lv_obj_set_style_pad_all(slider, 9, LV_PART_KNOB);
            lv_obj_add_flag(slider, LV_OBJ_FLAG_EVENT_BUBBLE);
            lv_obj_remove_flag(slider, LV_OBJ_FLAG_GESTURE_BUBBLE);
            lv_obj_add_event_cb(slider, [](lv_event_t* event) {
                auto self = static_cast<CustomLcdDisplay*>(lv_event_get_user_data(event));
                if (lv_event_get_code(event) == LV_EVENT_VALUE_CHANGED) self->UpdateAudioLabels();
                if (lv_event_get_code(event) != LV_EVENT_RELEASED || self->wake_only_) return;
                auto target = static_cast<lv_obj_t*>(lv_event_get_current_target(event));
                int value = lv_slider_get_value(target);
                bool volume = target == self->volume_slider_;
                Application::GetInstance().Schedule([volume, value] {
                    auto codec = Board::GetInstance().GetAudioCodec();
                    if (volume) codec->SetOutputVolume(std::clamp(value, 10, 100));
                    else {
                        int gain = 24 + std::clamp(value, 0, 2) * 6;
                        codec->SetInputGain(gain);
                        Settings("orbit_audio", true).SetInt("mic_gain", static_cast<int>(codec->input_gain()));
                    }
                });
            }, LV_EVENT_ALL, this);
        }
        SetText(Label(settings_, 351, 280, &lv_font_montserrat_18, 0x9CAEC8, 44), "High hears farther.\nLower it in noisy rooms.");
        settings_back_ = Sphere(settings_, 58, 0x172B46);
        lv_obj_align(settings_back_, LV_ALIGN_TOP_MID, 0, 398);
        lv_obj_add_flag(settings_back_, LV_OBJ_FLAG_CLICKABLE);
        SetText(Label(settings_back_, 16, 48, &lv_font_montserrat_22, 0xE7F5FF), LV_SYMBOL_LEFT);
        lv_obj_add_event_cb(settings_back_, [](lv_event_t* event) {
            auto self = static_cast<CustomLcdDisplay*>(lv_event_get_user_data(event));
            lv_event_stop_bubbling(event);
            self->gesture_consumed_ = true;
            if (self->wake_only_) { self->wake_only_ = false; return; }
            if (!orbit_display::ShouldHandleMenuClick(self->swiped_)) return;
            self->page_ = -2;
            self->RenderPage();
        }, LV_EVENT_CLICKED, this);
    }

public:
    void SetWeatherAction(std::function<void()> callback) { weather_action_ = callback; }
    void SetCalendarAction(std::function<void()> callback) { calendar_action_ = callback; }
    void OpenApps() { DisplayLockGuard lock(this); if (!apps_) return; page_ = -2; RenderPage(); }
    void OpenSettings() { DisplayLockGuard lock(this); if (!settings_) return; LoadAudioSettings(); page_ = -3; RenderPage(); }
    void ShowHome() { DisplayLockGuard lock(this); if (!apps_) return; page_ = -1; RenderPage(); }
    // Exercise LVGL hit testing and gesture routing, not just page arithmetic.
    bool CheckMenuSwipe() {
        DisplayLockGuard lock(this);
        if (!root_) return false;
        page_ = -1;
        RenderPage();
        lv_obj_update_layout(root_);
        lv_indev_data_t sample{};
        auto pointer = lv_indev_create();
        if (!pointer) return false;
        lv_indev_set_type(pointer, LV_INDEV_TYPE_POINTER);
        lv_indev_set_display(pointer, lv_obj_get_display(root_));
        lv_indev_set_mode(pointer, LV_INDEV_MODE_EVENT);
        lv_indev_set_user_data(pointer, &sample);
        lv_indev_set_read_cb(pointer, [](lv_indev_t* input, lv_indev_data_t* data) {
            *data = *static_cast<lv_indev_data_t*>(lv_indev_get_user_data(input));
        });
        sample.state = LV_INDEV_STATE_PRESSED;
        sample.point.x = 233;
        for (int y = 390; y >= 210; y -= 30) {
            sample.point.y = y;
            lv_indev_read(pointer);
        }
        sample.state = LV_INDEV_STATE_RELEASED;
        lv_indev_read(pointer);
        lv_indev_delete(pointer);
        return page_ == -2;
    }
    using BoardLcdDisplay::BoardLcdDisplay;
    ~CustomLcdDisplay() override {
        if (animation_) lv_timer_delete(animation_);
        free(pixels_);
        free(normals_);
    }

    void SetupUI() override {
        BoardLcdDisplay::SetupUI();
        DisplayLockGuard lock(this);
        if (root_) return;

        root_ = lv_obj_create(lv_screen_active());
        lv_obj_remove_style_all(root_);
        lv_obj_set_size(root_, 466, 466);
        lv_obj_set_style_radius(root_, LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_clip_corner(root_, true, 0);
        lv_obj_set_style_bg_color(root_, lv_color_hex(0x03070E), 0);
        lv_obj_set_style_bg_opa(root_, LV_OPA_COVER, 0);
        // Stop gestures here; LVGL otherwise skips Orbit and dispatches to the base screen.
        lv_obj_remove_flag(root_, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_remove_flag(root_, LV_OBJ_FLAG_GESTURE_BUBBLE);
        lv_obj_add_flag(root_, LV_OBJ_FLAG_CLICKABLE);

        auto brand = Label(root_, 28, 180, &lv_font_montserrat_18, 0xA4B4CE, 26, LV_LABEL_LONG_DOT);
        SetText(brand, "O R B I T");
        clock_ = Label(root_, 61, 80, &lv_font_montserrat_18, 0x708099, 26, LV_LABEL_LONG_DOT);
        lv_obj_set_x(clock_, -104);
        battery_ = Label(root_, 61, 90, &lv_font_montserrat_18, 0x708099, 26, LV_LABEL_LONG_DOT);
        lv_obj_set_x(battery_, 104);
        state_ = Label(root_, 98, 300, &lv_font_montserrat_22, 0xD8E6FF, 30, LV_LABEL_LONG_DOT);
        const auto initial_state = Application::GetInstance().GetDeviceState();
        SetText(state_, DeviceStateLabel(initial_state));
        lv_obj_set_style_text_color(state_, lv_color_hex(DeviceStateColor(initial_state)), 0);

        orb_ = Sphere(root_, 260, 0x03070E);
        lv_obj_align(orb_, LV_ALIGN_TOP_MID, 0, 120);
        pixels_ = static_cast<uint16_t*>(heap_caps_malloc(kOrbPixels * kOrbPixels * sizeof(uint16_t), MALLOC_CAP_SPIRAM));
        normals_ = static_cast<OrbNormal*>(heap_caps_malloc(kOrbPixels * kOrbPixels * sizeof(OrbNormal), MALLOC_CAP_SPIRAM));
        if (!pixels_ || !normals_) ESP_ERROR_CHECK(ESP_ERR_NO_MEM);
        orb_normals(normals_, kOrbPixels);
        orb_render(pixels_, normals_, kOrbPixels, 0, tint_);
        glow_ = lv_canvas_create(orb_);
        lv_canvas_set_buffer(glow_, pixels_, kOrbPixels, kOrbPixels, LV_COLOR_FORMAT_RGB565);
        lv_obj_center(glow_);

        caption_ = Label(root_, 383, 280, &lv_font_montserrat_18, 0xA9BCD8, 30, LV_LABEL_LONG_DOT);
        SetCaptionText("", false);

        card_ = lv_obj_create(root_);
        lv_obj_remove_style_all(card_);
        lv_obj_set_size(card_, 324, 252);
        lv_obj_align(card_, LV_ALIGN_TOP_MID, 0, 136);
        lv_obj_set_style_radius(card_, 28, 0);
        lv_obj_set_style_bg_color(card_, lv_color_hex(0x0B1524), 0);
        lv_obj_set_style_bg_grad_color(card_, lv_color_hex(0x122A48), 0);
        lv_obj_set_style_bg_grad_dir(card_, LV_GRAD_DIR_VER, 0);
        lv_obj_set_style_bg_opa(card_, LV_OPA_COVER, 0);
        lv_obj_set_style_clip_corner(card_, true, 0);
        lv_obj_set_style_border_width(card_, 1, 0);
        lv_obj_set_style_border_color(card_, lv_color_hex(0x28496D), 0);
        lv_obj_set_style_border_opa(card_, LV_OPA_50, 0);
        lv_obj_remove_flag(card_, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_add_flag(card_, static_cast<lv_obj_flag_t>(LV_OBJ_FLAG_EVENT_BUBBLE | LV_OBJ_FLAG_GESTURE_BUBBLE));
        auto card_wash = Sphere(card_, 170, 0x1B708E);
        lv_obj_set_style_bg_opa(card_wash, LV_OPA_10, 0);
        lv_obj_align(card_wash, LV_ALIGN_TOP_LEFT, 178, -52);
        title_ = Label(card_, 18, 284, &lv_font_montserrat_18, 0x6CDBEB, 28, LV_LABEL_LONG_DOT);
        value_ = Label(card_, 53, 284, &lv_font_montserrat_32, 0xF1F5FF, 45, LV_LABEL_LONG_WRAP);
        auto card_rule = lv_obj_create(card_);
        lv_obj_remove_style_all(card_rule);
        lv_obj_align(card_rule, LV_ALIGN_TOP_LEFT, 28, 96);
        lv_obj_set_size(card_rule, 268, 1);
        lv_obj_set_style_radius(card_rule, LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_bg_color(card_rule, lv_color_hex(0x3E718D), 0);
        lv_obj_set_style_bg_opa(card_rule, LV_OPA_50, 0);
        lv_obj_remove_flag(card_rule, static_cast<lv_obj_flag_t>(LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE));
        lv_obj_add_flag(card_rule, static_cast<lv_obj_flag_t>(LV_OBJ_FLAG_EVENT_BUBBLE | LV_OBJ_FLAG_GESTURE_BUBBLE));
        body_scroll_ = lv_obj_create(card_);
        lv_obj_remove_style_all(body_scroll_);
        lv_obj_set_size(body_scroll_, 284, 78);
        lv_obj_align(body_scroll_, LV_ALIGN_TOP_MID, 0, 104);
        lv_obj_set_scroll_dir(body_scroll_, LV_DIR_VER);
        lv_obj_set_scrollbar_mode(body_scroll_, LV_SCROLLBAR_MODE_AUTO);
        lv_obj_set_style_width(body_scroll_, 2, LV_PART_SCROLLBAR);
        lv_obj_set_style_bg_color(body_scroll_, lv_color_hex(0x6CDBEB), LV_PART_SCROLLBAR);
        lv_obj_add_flag(body_scroll_, static_cast<lv_obj_flag_t>(LV_OBJ_FLAG_EVENT_BUBBLE | LV_OBJ_FLAG_GESTURE_BUBBLE));
        body_ = Label(body_scroll_, 0, 274, &lv_font_montserrat_18, 0xBBCBE2);
        lv_obj_set_style_text_align(body_, LV_TEXT_ALIGN_LEFT, 0);
        lv_obj_set_style_text_line_space(body_, 2, 0);
        source_ = Label(card_, 196, 284, &lv_font_montserrat_18, 0xA9BCD8, 28, LV_LABEL_LONG_DOT);

        weather_page_ = lv_obj_create(root_);
        lv_obj_remove_style_all(weather_page_);
        lv_obj_set_size(weather_page_, 466, 466);
        lv_obj_set_style_radius(weather_page_, LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_clip_corner(weather_page_, true, 0);
        lv_obj_set_style_bg_color(weather_page_, lv_color_hex(0x285CD6), 0);
        lv_obj_set_style_bg_grad_color(weather_page_, lv_color_hex(0x173B74), 0);
        lv_obj_set_style_bg_grad_dir(weather_page_, LV_GRAD_DIR_VER, 0);
        lv_obj_set_style_bg_opa(weather_page_, LV_OPA_COVER, 0);
        lv_obj_remove_flag(weather_page_, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_add_flag(weather_page_, static_cast<lv_obj_flag_t>(LV_OBJ_FLAG_EVENT_BUBBLE | LV_OBJ_FLAG_GESTURE_BUBBLE));
        lv_obj_align(weather_page_, LV_ALIGN_TOP_LEFT, 0, 0);

        weather_city_ = Label(weather_page_, 25, 280, &lv_font_montserrat_22, 0xFFFFFF, 26, LV_LABEL_LONG_DOT);
        lv_obj_align(weather_city_, LV_ALIGN_TOP_LEFT, 93, 25);
        weather_temp_ = Label(weather_page_, 92, 136, &lv_font_montserrat_48, 0xFFFFFF, 60, LV_LABEL_LONG_DOT);
        lv_obj_align(weather_temp_, LV_ALIGN_TOP_LEFT, 96, 92);
        lv_obj_set_style_transform_scale_x(weather_temp_, 384, 0);
        lv_obj_set_style_transform_scale_y(weather_temp_, 384, 0);
        lv_obj_set_style_transform_pivot_x(weather_temp_, 68, 0);
        lv_obj_set_style_transform_pivot_y(weather_temp_, 30, 0);

        weather_icon_glow_ = Sphere(weather_page_, 100, 0xB6E4FF);
        lv_obj_set_style_bg_opa(weather_icon_glow_, LV_OPA_10, 0);
        lv_obj_align(weather_icon_glow_, LV_ALIGN_TOP_LEFT, 300, 72);
        weather_sun_ = Sphere(weather_page_, 40, 0xFFE39E);
        lv_obj_align(weather_sun_, LV_ALIGN_TOP_LEFT, 337, 83);
        weather_cloud_ = Sphere(weather_page_, 48, 0xE5F2FF);
        lv_obj_align(weather_cloud_, LV_ALIGN_TOP_LEFT, 316, 116);
        weather_cloud_left_ = Sphere(weather_page_, 34, 0xF8FBFF);
        lv_obj_align(weather_cloud_left_, LV_ALIGN_TOP_LEFT, 300, 128);
        weather_cloud_right_ = Sphere(weather_page_, 34, 0xE5F2FF);
        lv_obj_align(weather_cloud_right_, LV_ALIGN_TOP_LEFT, 343, 130);
        weather_precip_[0] = Sphere(weather_page_, 8, 0xBFE8FF);
        lv_obj_align(weather_precip_[0], LV_ALIGN_TOP_LEFT, 314, 154);
        weather_precip_[1] = Sphere(weather_page_, 8, 0xBFE8FF);
        lv_obj_align(weather_precip_[1], LV_ALIGN_TOP_LEFT, 330, 164);
        weather_precip_[2] = Sphere(weather_page_, 8, 0xBFE8FF);
        lv_obj_align(weather_precip_[2], LV_ALIGN_TOP_LEFT, 347, 154);

        weather_detail_ = Label(weather_page_, 174, 300, &lv_font_montserrat_18, 0xF1F6FF, 30, LV_LABEL_LONG_DOT);
        lv_obj_align(weather_detail_, LV_ALIGN_TOP_LEFT, 83, 174);
        auto humidity_pill = Pill(weather_page_, 46, 208, 118, 62);
        weather_humidity_ = Label(humidity_pill, 7, 104, &lv_font_montserrat_18, 0xF1F6FF, 48, LV_LABEL_LONG_DOT);
        lv_obj_align(weather_humidity_, LV_ALIGN_TOP_LEFT, 7, 7);
        auto wind_pill = Pill(weather_page_, 174, 208, 118, 62);
        weather_wind_ = Label(wind_pill, 7, 104, &lv_font_montserrat_18, 0xF1F6FF, 48, LV_LABEL_LONG_DOT);
        lv_obj_align(weather_wind_, LV_ALIGN_TOP_LEFT, 7, 7);
        auto rain_pill = Pill(weather_page_, 302, 208, 118, 62);
        weather_rain_ = Label(rain_pill, 7, 104, &lv_font_montserrat_18, 0xF1F6FF, 48, LV_LABEL_LONG_DOT);
        lv_obj_align(weather_rain_, LV_ALIGN_TOP_LEFT, 7, 7);

        auto tomorrow = lv_obj_create(weather_page_);
        lv_obj_remove_style_all(tomorrow);
        lv_obj_align(tomorrow, LV_ALIGN_TOP_LEFT, 58, 276);
        lv_obj_set_size(tomorrow, 350, 98);
        lv_obj_set_style_bg_color(tomorrow, lv_color_white(), 0);
        lv_obj_set_style_bg_opa(tomorrow, LV_OPA_10, 0);
        lv_obj_set_style_radius(tomorrow, 22, 0);
        lv_obj_set_style_border_width(tomorrow, 1, 0);
        lv_obj_set_style_border_color(tomorrow, lv_color_hex(0xB1D3FF), 0);
        lv_obj_set_style_border_opa(tomorrow, LV_OPA_40, 0);
        lv_obj_remove_flag(tomorrow, static_cast<lv_obj_flag_t>(LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE));
        lv_obj_add_flag(tomorrow, static_cast<lv_obj_flag_t>(LV_OBJ_FLAG_EVENT_BUBBLE | LV_OBJ_FLAG_GESTURE_BUBBLE));
        auto tomorrow_title = Label(tomorrow, 11, 300, &lv_font_montserrat_18, 0xFFFFFF, 26, LV_LABEL_LONG_DOT);
        lv_obj_align(tomorrow_title, LV_ALIGN_TOP_LEFT, 25, 11);
        SetText(tomorrow_title, "Tomorrow");
        weather_tomorrow_ = Label(tomorrow, 40, 310, &lv_font_montserrat_18, 0xFFFFFF, 48, LV_LABEL_LONG_DOT);
        lv_obj_align(weather_tomorrow_, LV_ALIGN_TOP_LEFT, 20, 40);
        weather_source_ = Label(weather_page_, 383, 280, &lv_font_montserrat_18, 0xE0EFFF, 26, LV_LABEL_LONG_DOT);
        lv_obj_align(weather_source_, LV_ALIGN_TOP_LEFT, 93, 383);
        hint_ = Label(root_, 416, 200, &lv_font_montserrat_18, 0x7E90AF, 26, LV_LABEL_LONG_DOT);
        lv_obj_align(hint_, LV_ALIGN_TOP_LEFT, 133, 416);
        SetupApps();

        lv_obj_add_event_cb(root_, [](lv_event_t* e) {
            auto self = static_cast<CustomLcdDisplay*>(lv_event_get_user_data(e));
            switch (lv_event_get_code(e)) {
            case LV_EVENT_PRESSED: {
                self->wake_only_ = false;
                self->WakeOnTouch();
                self->swiped_ = false;
                self->gesture_consumed_ = false;
                auto target = static_cast<lv_obj_t*>(lv_event_get_target(e));
                self->gesture_consumed_ = self->page_ <= -2 && target != self->root_;
                break;
            }
            case LV_EVENT_SCROLL_BEGIN:
                self->swiped_ = true;
                self->gesture_consumed_ = true;
                break;
            case LV_EVENT_GESTURE: {
                auto indev = lv_indev_active();
                if (!indev) return;
                auto dir = lv_indev_get_gesture_dir(indev);
                orbit_display::GestureDirection direction;
                if (dir == LV_DIR_LEFT) direction = orbit_display::GestureDirection::Left;
                else if (dir == LV_DIR_RIGHT) direction = orbit_display::GestureDirection::Right;
                else if (dir == LV_DIR_TOP) direction = orbit_display::GestureDirection::Up;
                else if (dir == LV_DIR_BOTTOM) direction = orbit_display::GestureDirection::Down;
                else return;
                self->swiped_ = true;
                self->gesture_consumed_ = true;
                self->wake_only_ = false;
                const int next_page = orbit_display::PageAfterGesture(self->page_, direction);
                if (next_page != self->page_) {
                    self->page_ = next_page;
                    self->RenderPage();
                    break;
                }
                if (dir != LV_DIR_LEFT && dir != LV_DIR_RIGHT) break;
                if (self->page_ < -1 || (self->page_ < 0 && self->cards_.empty())) break;
                int n = static_cast<int>(self->cards_.size()) + 1;
                self->page_ = (self->page_ + 1 + (dir == LV_DIR_LEFT ? 1 : n - 1)) % n - 1;
                self->RenderPage();
                break;
            }
            case LV_EVENT_SHORT_CLICKED:
                if (self->gesture_consumed_) return;
                // Menu widgets consume their own CLICKED/RELEASED event. Keep
                // the first-wake guard until their handler has seen it.
                if (self->page_ <= -2) return;
                if (self->wake_only_) {
                    self->wake_only_ = false;
                    return;
                }
                if (self->swiped_) return;
                if (self->page_ >= 0) {
                    self->page_ = -1;
                    self->RenderPage();
                    return;
                }
                if (Application::GetInstance().GetDeviceState() == kDeviceStateIdle && self->state_) {
                    self->SetText(self->state_, "Connecting");
                    lv_obj_set_style_text_color(self->state_, lv_color_hex(self->DeviceStateColor(kDeviceStateConnecting)), 0);
                }
                Application::GetInstance().Schedule([] { Application::GetInstance().ToggleChatState(); });
                break;
            default:
                break;
            }
        }, LV_EVENT_ALL, this);

        animation_ = lv_timer_create([](lv_timer_t* t) {
            static_cast<CustomLcdDisplay*>(lv_timer_get_user_data(t))->Animate();
        }, 50, this);
        RenderPage();
    }

    void SetStatus(const char* status) override {
        DisplayLockGuard lock(this);
        if (state_) {
            const auto device_state = Application::GetInstance().GetDeviceState();
            SetText(state_, status && *status ? status : DeviceStateLabel(device_state));
            lv_obj_set_style_text_color(state_, lv_color_hex(DeviceStateColor(device_state)), 0);
        }
        UpdateSessionChrome(true);
    }

    void SetChatMessage(const char* role, const char* content) override {
        DisplayLockGuard lock(this);
        if (!content) return;
        if (!caption_) {
            if (role && strcmp(role, "assistant") == 0) {
                const auto excerpt = ResponseExcerpt(content);
                if (!excerpt.empty()) last_response_ = excerpt;
            }
            return;
        }
        if (role && strcmp(role, "system") == 0 && strlen(content) > 80) {
            cards_.push_front({"SETUP", "", content, "Orbit device"});
            if (cards_.size() > 6) cards_.pop_back();
            page_ = 0;
            RenderPage();
        } else {
            SetCaptionText(content, role && strcmp(role, "assistant") == 0);
        }
    }

    void ClearChatMessages() override {
        DisplayLockGuard lock(this);
        SetCaptionText("", false);
    }

    void SetEmotion(const char* emotion) override {
        if (!emotion) return;
        DisplayLockGuard lock(this);
        const float* color = nullptr;
        const float calm[] = {45, 145, 255}, happy[] = {255, 192, 70}, curious[] = {158, 108, 255};
        const float excited[] = {248, 90, 195}, concerned[] = {245, 149, 64};
        if (!strcmp(emotion, "happy")) color = happy;
        else if (!strcmp(emotion, "curious")) color = curious;
        else if (!strcmp(emotion, "excited")) color = excited;
        else if (!strcmp(emotion, "concerned")) color = concerned;
        else color = calm;
        std::copy(color, color + 3, mood_);
    }

    void ShowNotification(const char* text, int = 3000) override { SetChatMessage("system", text); }
    void ShowNotification(const std::string& text, int ms = 3000) override { ShowNotification(text.c_str(), ms); }

    void SetPowerSaveMode(bool on) override {
        DisplayLockGuard lock(this);
        sleeping_ = on;
        if (animation_) {
            if (on) lv_timer_pause(animation_);
            else lv_timer_resume(animation_);
        }
    }

    void UpdateStatusBar(bool = false) override {
        if (!root_) return;
        int level = 0;
        bool charging = false, discharging = false;
        bool battery = Board::GetInstance().GetBatteryLevel(level, charging, discharging);
        time_t now = time(nullptr);
        struct tm local;
        localtime_r(&now, &local);
        DisplayLockGuard lock(this);
        char clock_text[8];
        if (local.tm_year >= 124) {
            std::snprintf(clock_text, sizeof(clock_text), "%02d:%02d", local.tm_hour, local.tm_min);
        } else {
            std::snprintf(clock_text, sizeof(clock_text), "--:--");
        }
        SetText(clock_, clock_text);
        char battery_text[16];
        if (battery) std::snprintf(battery_text, sizeof(battery_text), "%s%d%%", charging ? "+" : "", level);
        else std::snprintf(battery_text, sizeof(battery_text), "--");
        SetText(battery_, battery_text);
    }

    void ShowCard(const std::string& title, const std::string& value,
                  const std::string& body, const std::string& source) {
        DisplayLockGuard lock(this);
        if (!root_) throw std::runtime_error("Display not ready");
        cards_.push_front({title, value, body, source});
        if (cards_.size() > 6) cards_.pop_back();
        if (page_ >= -1) page_ = 0;
        RenderPage();
    }

    void ShowWeather(const std::string& city, const std::string& temperature, const std::string& detail,
                     const std::string& humidity, const std::string& wind, const std::string& rain,
                     const std::string& tomorrow, const std::string& source) {
        DisplayLockGuard lock(this);
        if (!root_) throw std::runtime_error("Display not ready");
        cards_.push_front({city, temperature, detail, source, true, humidity, wind, rain, tomorrow});
        if (cards_.size() > 6) cards_.pop_back();
        if (page_ >= -1) page_ = 0;
        RenderPage();
    }
};
#endif
