#include "wifi_board.h"
#include "display/lcd_display.h"
#include "esp_lcd_co5300.h"

#include "codecs/box_audio_codec.h"
#include "application.h"
#include "button.h"
#include "led/single_led.h"
#include "mcp_server.h"
#include "config.h"
#include "power_save_timer.h"
#include "axp2101.h"
#include "i2c_device.h"

#include <esp_log.h>
#include <esp_lcd_panel_vendor.h>
#include <driver/i2c_master.h>
#include <driver/spi_master.h>
#include "esp_io_expander_tca9554.h"
#include "settings.h"

#include <esp_lcd_touch_cst9217.h>
#include <esp_lvgl_port.h>
#include <lvgl.h>

#define TAG "WaveshareEsp32s3TouchAMOLED1inch75"

class Pmic : public Axp2101 {
public:
    Pmic(i2c_master_bus_handle_t i2c_bus, uint8_t addr) : Axp2101(i2c_bus, addr) {
        WriteReg(0x22, 0b110); // PWRON > OFFLEVEL as POWEROFF Source enable
        WriteReg(0x27, 0x10);  // hold 4s to power off

        // Disable All DCs but DC1
        WriteReg(0x80, 0x01);
        // Disable All LDOs
        WriteReg(0x90, 0x00);
        WriteReg(0x91, 0x00);

        // Set DC1 to 3.3V
        WriteReg(0x82, (3300 - 1500) / 100);

        // Set ALDO1 to 3.3V
        WriteReg(0x92, (3300 - 500) / 100);

        // Enable ALDO1(MIC)
        WriteReg(0x90, 0x01);

        WriteReg(0x64, 0x02); // CV charger voltage setting to 4.1V

        WriteReg(0x61, 0x02); // set Main battery precharge current to 50mA
        WriteReg(0x62, 0x08); // set Main battery charger current to 400mA ( 0x08-200mA, 0x09-300mA, 0x0A-400mA )
        WriteReg(0x63, 0x01); // set Main battery term charge current to 25mA
    }
};

#define LCD_OPCODE_WRITE_CMD (0x02ULL)
#define LCD_OPCODE_READ_CMD (0x03ULL)
#define LCD_OPCODE_WRITE_COLOR (0x32ULL)

static const co5300_lcd_init_cmd_t vendor_specific_init[] = {
    // set display to qspi mode
    {0xFE, (uint8_t[]){0x20}, 1, 0},
    {0x19, (uint8_t[]){0x10}, 1, 0},
    {0x1C, (uint8_t[]){0xA0}, 1, 0},

    {0xFE, (uint8_t[]){0x00}, 1, 0},
    {0xC4, (uint8_t[]){0x80}, 1, 0},
    {0x3A, (uint8_t[]){0x55}, 1, 0},
    {0x35, (uint8_t[]){0x00}, 1, 0},
    {0x53, (uint8_t[]){0x20}, 1, 0},
    {0x51, (uint8_t[]){0xFF}, 1, 0},
    {0x63, (uint8_t[]){0xFF}, 1, 0},
    {0x2A, (uint8_t[]){0x00, 0x06, 0x01, 0xD7}, 4, 0},
    {0x2B, (uint8_t[]){0x00, 0x00, 0x01, 0xD1}, 4, 600},
    {0x11, NULL, 0, 600},
    {0x29, NULL, 0, 0},
};

// 在waveshare_amoled_1_75类之前添加新的显示类
class BoardLcdDisplay : public SpiLcdDisplay {
public:
    static void rounder_event_cb(lv_event_t* e) {
        lv_area_t* area = (lv_area_t* )lv_event_get_param(e);
        uint16_t x1 = area->x1;
        uint16_t x2 = area->x2;

        uint16_t y1 = area->y1;
        uint16_t y2 = area->y2;

        // round the start of coordinate down to the nearest 2M number
        area->x1 = (x1 >> 1) << 1;
        area->y1 = (y1 >> 1) << 1;
        // round the end of coordinate up to the nearest 2N+1 number
        area->x2 = ((x2 >> 1) << 1) + 1;
        area->y2 = ((y2 >> 1) << 1) + 1;
    }

    BoardLcdDisplay(esp_lcd_panel_io_handle_t io_handle,
                     esp_lcd_panel_handle_t panel_handle,
                     int width,
                     int height,
                     int offset_x,
                     int offset_y,
                     bool mirror_x,
                     bool mirror_y,
                     bool swap_xy)
        : SpiLcdDisplay(io_handle, panel_handle,
                        width, height, offset_x, offset_y, mirror_x, mirror_y, swap_xy) {
        // Note: UI customization should be done in SetupUI(), not in constructor
        // to ensure lvgl objects are created before accessing them
    }

    virtual void SetupUI() override {
        // Call parent SetupUI() first to create all lvgl objects
        SpiLcdDisplay::SetupUI();

        DisplayLockGuard lock(this);
        lv_obj_set_style_pad_left(status_bar_, LV_HOR_RES*  0.1, 0);
        lv_obj_set_style_pad_right(status_bar_, LV_HOR_RES*  0.1, 0);
        lv_display_add_event_cb(display_, rounder_event_cb, LV_EVENT_INVALIDATE_AREA, NULL);
    }
};

#if CONFIG_ORBIT_AGENT
#include "orbit_display.h"
#include "../../../../relay/.private/device_config.h"
#include <ssid_manager.h>
#include <atomic>
#include <mutex>
#include <http.h>
#include <system_info.h>
#include <wifi_manager.h>
#include <esp_netif.h>
#include <netdb.h>
#else
using CustomLcdDisplay = BoardLcdDisplay;
#endif

class CustomBacklight : public Backlight {
public:
    CustomBacklight(esp_lcd_panel_io_handle_t panel_io) : Backlight(), panel_io_(panel_io) {}

protected:
    esp_lcd_panel_io_handle_t panel_io_;

    virtual void SetBrightnessImpl(uint8_t brightness) override {
        auto display = Board::GetInstance().GetDisplay();
        DisplayLockGuard lock(display);
        uint8_t data[1] = {((uint8_t)((255*  brightness) / 100))};
        int lcd_cmd = 0x51;
        lcd_cmd &= 0xff;
        lcd_cmd <<= 8;
        lcd_cmd |= LCD_OPCODE_WRITE_CMD << 24;
        esp_lcd_panel_io_tx_param(panel_io_, lcd_cmd, &data, sizeof(data));
    }
};

class WaveshareEsp32s3TouchAMOLED1inch75 : public WifiBoard {
private:
    i2c_master_bus_handle_t i2c_bus_;
    Pmic* pmic_ = nullptr;
    Button boot_button_;
    CustomLcdDisplay* display_;
    CustomBacklight* backlight_;
    esp_io_expander_handle_t io_expander = NULL;
    PowerSaveTimer* power_save_timer_;
#if CONFIG_ORBIT_AGENT
    std::atomic<bool> weather_pending_{false};
    bool calendar_request_ = false;
    std::mutex dns_mutex_;
    std::string dns_checked_ip_;

    void OpenWeather(bool calendar = false) {
        if (weather_pending_.exchange(true)) return;
        calendar_request_ = calendar;
        display_->ShowCard(calendar ? "GOOGLE CALENDAR" : "WEATHER", "Updating", calendar ? "Fetching today's agenda..." : "Fetching your local forecast...", calendar ? "Google Calendar" : "Open-Meteo");
        // Fetch independently of voice: no mic activation, OpenAI session or spoken prompt.
        if (xTaskCreate([](void* context) {
            {  // Release HTTP/string resources before FreeRTOS deletes this task.
            auto self = static_cast<WaveshareEsp32s3TouchAMOLED1inch75*>(context);
            const bool calendar = self->calendar_request_;
            auto http = self->GetNetwork()->CreateHttp(4);
            http->SetTimeout(calendar ? 60000 : 25000);
            http->SetHeader("Authorization", std::string("Bearer ") + ORBIT_DEVICE_TOKEN);
            http->SetHeader("Device-Id", SystemInfo::GetMacAddress());
            std::string url = ORBIT_RELAY_URL;
            url = url.substr(0, url.rfind("/ota/")) + (calendar ? "/calendar" : "/weather");
            std::string body;
            bool ok = http->Open("GET", url) && http->GetStatusCode() == 200;
            if (ok) {
                char chunk[512];
                for (;;) {
                    int count = http->Read(chunk, sizeof(chunk));
                    if (count == 0) break;
                    if (count < 0 || body.size() + count > 16384) { ok = false; break; }
                    body.append(chunk, count);
                }
            }
            http->Close();
            Application::GetInstance().Schedule([self, calendar, ok, body = std::move(body)] {
                cJSON* json = ok ? cJSON_Parse(body.c_str()) : nullptr;
                if (calendar) {
                    bool valid = cJSON_IsObject(json);
                    for (auto key : {"title", "value", "body", "source"}) {
                        auto value = cJSON_GetObjectItemCaseSensitive(json, key);
                        valid = valid && cJSON_IsString(value) && strlen(value->valuestring) <= (!strcmp(key, "body") ? 12000 : 240);
                    }
                    if (valid) {
                        auto text = [json](const char* key) { return std::string(cJSON_GetObjectItemCaseSensitive(json, key)->valuestring); };
                        self->display_->ShowCard(text("title"), text("value"), text("body"), text("source"));
                        puts("ORBIT: Calendar app response displayed without voice");
                    } else self->display_->ShowCard("GOOGLE CALENDAR", "Unavailable", "Check Wi-Fi and the Orbit connection, then try again.", "No events verified");
                    cJSON_Delete(json);
                    self->weather_pending_ = false;
                    return;
                }
                bool valid = cJSON_IsObject(json);
                for (auto key : {"city", "temperature", "detail", "humidity", "wind", "rain", "tomorrow", "source"}) {
                    auto value = cJSON_GetObjectItemCaseSensitive(json, key);
                    valid = valid && cJSON_IsString(value) && strlen(value->valuestring) <= 128;
                }
                if (valid) {
                    auto text = [json](const char* key) { return std::string(cJSON_GetObjectItemCaseSensitive(json, key)->valuestring); };
                    self->display_->ShowWeather(text("city"), text("temperature"), text("detail"), text("humidity"),
                        text("wind"), text("rain"), text("tomorrow"), text("source"));
                    puts("ORBIT: Weather app loaded without voice");
                } else {
                    self->display_->ShowCard("WEATHER", "Unavailable", "Check Wi-Fi and the Orbit connection, then tap Weather again.", "No voice session started");
                    puts("ORBIT: Weather app unavailable");
                }
                cJSON_Delete(json);
                self->weather_pending_ = false;
            });
            }
            vTaskDelete(nullptr);
        }, "orbit_weather", 8192, this, 1, nullptr) != pdPASS) {
            weather_pending_ = false;
            display_->ShowCard("WEATHER", "Please retry", "Not enough memory for this request.", "Orbit");
        }
    }
#endif

    void InitializePowerSaveTimer() {
        power_save_timer_ = new PowerSaveTimer(-1, 60, 300);
        power_save_timer_->OnEnterSleepMode([this]() {
            GetDisplay()->SetPowerSaveMode(true);
            GetBacklight()->SetBrightness(20); });
        power_save_timer_->OnExitSleepMode([this]() {
            GetDisplay()->SetPowerSaveMode(false);
            GetBacklight()->RestoreBrightness(); });
        power_save_timer_->OnShutdownRequest([this](){ 
            pmic_->PowerOff(); });
        power_save_timer_->SetEnabled(true);
    }

    void InitializeCodecI2c() {
        // Initialize I2C peripheral
        i2c_master_bus_config_t i2c_bus_cfg = {
            .i2c_port = I2C_NUM_0,
            .sda_io_num = AUDIO_CODEC_I2C_SDA_PIN,
            .scl_io_num = AUDIO_CODEC_I2C_SCL_PIN,
            .clk_source = I2C_CLK_SRC_DEFAULT,
            .flags = {
                .enable_internal_pullup = 1,
            },
        };
        ESP_ERROR_CHECK(i2c_new_master_bus(&i2c_bus_cfg, &i2c_bus_));
    }

    void InitializeTca9554(void) {
        esp_err_t ret = esp_io_expander_new_i2c_tca9554(i2c_bus_, I2C_ADDRESS, &io_expander);
        if (ret != ESP_OK)
            ESP_LOGE(TAG, "TCA9554 create returned error");
        ret = esp_io_expander_set_dir(io_expander, IO_EXPANDER_PIN_NUM_4, IO_EXPANDER_INPUT);
        ESP_ERROR_CHECK(ret);
    }

    void InitializeAxp2101() {
        ESP_LOGI(TAG, "Init AXP2101");
        pmic_ = new Pmic(i2c_bus_, 0x34);
    }

    void InitializeSpi() {
        spi_bus_config_t buscfg = {};
        buscfg.sclk_io_num = EXAMPLE_PIN_NUM_LCD_PCLK;
        buscfg.data0_io_num = EXAMPLE_PIN_NUM_LCD_DATA0;
        buscfg.data1_io_num = EXAMPLE_PIN_NUM_LCD_DATA1;
        buscfg.data2_io_num = EXAMPLE_PIN_NUM_LCD_DATA2;
        buscfg.data3_io_num = EXAMPLE_PIN_NUM_LCD_DATA3;
        buscfg.max_transfer_sz = DISPLAY_WIDTH*  DISPLAY_HEIGHT*  sizeof(uint16_t);
        buscfg.flags = SPICOMMON_BUSFLAG_QUAD;
        ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &buscfg, SPI_DMA_CH_AUTO));
    }

    void InitializeButtons() {
#if CONFIG_ORBIT_AGENT
        // Physical recovery remains available even when the relay or Wi-Fi is unavailable.
        boot_button_.OnLongPress([this]() { EnterWifiConfigMode(); });
#endif
        boot_button_.OnClick([this]() {
            auto& app = Application::GetInstance();
            if (app.GetDeviceState() == kDeviceStateStarting) {
                EnterWifiConfigMode();
                return;
            }
            app.ToggleChatState();
        });

#if CONFIG_USE_DEVICE_AEC
        boot_button_.OnDoubleClick([this]() {
            auto& app = Application::GetInstance();
            if (app.GetDeviceState() == kDeviceStateIdle) {
                app.SetAecMode(app.GetAecMode() == kAecOff ? kAecOnDeviceSide : kAecOff);
            }
        });
#endif
    }

    void InitializeDisplay() {
        esp_lcd_panel_io_handle_t panel_io = nullptr;
        esp_lcd_panel_handle_t panel = nullptr;

        // 液晶屏控制IO初始化
        ESP_LOGD(TAG, "Install panel IO");
        esp_lcd_panel_io_spi_config_t io_config = {};
        io_config.cs_gpio_num = EXAMPLE_PIN_NUM_LCD_CS;
        io_config.dc_gpio_num = GPIO_NUM_NC;
        io_config.spi_mode = 0;
        io_config.pclk_hz = 40 * 1000 * 1000;
        io_config.trans_queue_depth = 10;
        io_config.lcd_cmd_bits = 32;
        io_config.lcd_param_bits = 8;
        io_config.flags.quad_mode = true;
        ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi(SPI2_HOST, &io_config, &panel_io));

        // 初始化液晶屏驱动芯片
        ESP_LOGD(TAG, "Install LCD driver");
        const co5300_vendor_config_t vendor_config = {
            .init_cmds = &vendor_specific_init[0],
            .init_cmds_size = sizeof(vendor_specific_init) / sizeof(co5300_lcd_init_cmd_t),
            .flags = {
                .use_qspi_interface = 1,
            }};

        esp_lcd_panel_dev_config_t panel_config = {};
        panel_config.reset_gpio_num = EXAMPLE_PIN_NUM_LCD_RST;
        panel_config.rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB;
        panel_config.bits_per_pixel = 16;
        panel_config.vendor_config = (void* )&vendor_config;
        ESP_ERROR_CHECK(esp_lcd_new_panel_co5300(panel_io, &panel_config, &panel));
        esp_lcd_panel_set_gap(panel, 0x06, 0);
        esp_lcd_panel_reset(panel);
        esp_lcd_panel_init(panel);
        esp_lcd_panel_invert_color(panel, false);
        esp_lcd_panel_mirror(panel, DISPLAY_MIRROR_X, DISPLAY_MIRROR_Y);
        esp_lcd_panel_disp_on_off(panel, true);
        display_ = new CustomLcdDisplay(panel_io, panel,
                                        DISPLAY_WIDTH, DISPLAY_HEIGHT, DISPLAY_OFFSET_X, DISPLAY_OFFSET_Y, DISPLAY_MIRROR_X, DISPLAY_MIRROR_Y, DISPLAY_SWAP_XY);
        backlight_ = new CustomBacklight(panel_io);
        backlight_->RestoreBrightness();
    }

    void InitializeTouch() {
        esp_lcd_touch_handle_t tp;
        esp_lcd_touch_config_t tp_cfg = {
            .x_max = DISPLAY_WIDTH - 1,
            .y_max = DISPLAY_HEIGHT - 1,
            .rst_gpio_num = PIN_NUM_TOUCH_RST,
            .int_gpio_num = PIN_NUM_TOUCH_INT,
            .levels = {
                .reset = 0,
                .interrupt = 0,
            },
            .flags = {
                .swap_xy = 0,
                .mirror_x = 1,
                .mirror_y = 1,
            },
        };
        esp_lcd_panel_io_handle_t tp_io_handle = NULL;
        esp_lcd_panel_io_i2c_config_t tp_io_config = ESP_LCD_TOUCH_IO_I2C_CST9217_CONFIG();
        tp_io_config.scl_speed_hz = 400*  1000;
        ESP_ERROR_CHECK(esp_lcd_new_panel_io_i2c(i2c_bus_, &tp_io_config, &tp_io_handle));
        ESP_LOGI(TAG, "Initialize touch controller");
        ESP_ERROR_CHECK(esp_lcd_touch_new_i2c_cst9217(tp_io_handle, &tp_cfg, &tp));
        const lvgl_port_touch_cfg_t touch_cfg = {
            .disp = lv_display_get_default(),
            .handle = tp,
        };
        lvgl_port_add_touch(&touch_cfg);
        ESP_LOGI(TAG, "Touch panel initialized successfully");
    }

    // 初始化工具
    void InitializeTools() {
        auto &mcp_server = McpServer::GetInstance();
#if CONFIG_ORBIT_AGENT
        mcp_server.AddTool("self.orbit.weather", "Show a full-screen circular weather card",
            PropertyList({Property("city", kPropertyTypeString), Property("temperature", kPropertyTypeString),
                          Property("detail", kPropertyTypeString), Property("humidity", kPropertyTypeString),
                          Property("wind", kPropertyTypeString), Property("rain", kPropertyTypeString),
                          Property("tomorrow", kPropertyTypeString), Property("source", kPropertyTypeString)}),
            [this](const PropertyList& p) -> ReturnValue {
                for (auto key : {"city", "temperature", "detail", "humidity", "wind", "rain", "tomorrow", "source"})
                    if (p[key].value<std::string>().size() > 128) throw std::runtime_error("Weather field too long");
                display_->ShowWeather(p["city"].value<std::string>(), p["temperature"].value<std::string>(),
                    p["detail"].value<std::string>(), p["humidity"].value<std::string>(), p["wind"].value<std::string>(),
                    p["rain"].value<std::string>(), p["tomorrow"].value<std::string>(), p["source"].value<std::string>());
                return true;
            });
        for (auto name : {"self.orbit.card", "self.orbit.calendar"}) {
        const int body_limit = !strcmp(name, "self.orbit.calendar") ? 12000 : 1200;
        mcp_server.AddTool(name, "Show a bounded information card on the round display",
            PropertyList({Property("title", kPropertyTypeString), Property("value", kPropertyTypeString),
                          Property("body", kPropertyTypeString), Property("source", kPropertyTypeString)}),
            [this, body_limit](const PropertyList& p) -> ReturnValue {
                auto title = p["title"].value<std::string>();
                auto value = p["value"].value<std::string>();
                auto body = p["body"].value<std::string>();
                auto source = p["source"].value<std::string>();
                if (title.empty() || title.size() > 96 || value.size() > 96 || body.size() > body_limit || source.size() > 240)
                    throw std::runtime_error("Card exceeds display limits");
                display_->ShowCard(title, value, body, source);
                return true;
            });
        }
#endif
        mcp_server.AddTool("self.system.reconfigure_wifi",
            "End this conversation and enter WiFi configuration mode.\n"
            "**CAUTION** You must ask the user to confirm this action.",
            PropertyList(), [this](const PropertyList& properties) {
                EnterWifiConfigMode();
                return true;
            });
    }

public:
#ifdef ORBIT_CLOUD_DNS_HOST
    NetworkInterface* GetNetwork() override {
        // Some routers return no IPv4 answer for a newly created Fly hostname.
        // Prefer DHCP DNS; only try a public resolver when this relay lookup fails.
        std::lock_guard<std::mutex> lock(dns_mutex_);
        const auto ip = WifiManager::GetInstance().GetIpAddress();
        if (!ip.empty() && ip != dns_checked_ip_) {
            dns_checked_ip_ = ip;
            addrinfo hints{};
            hints.ai_family = AF_INET;
            hints.ai_socktype = SOCK_STREAM;
            auto resolves = [&hints]() {
                addrinfo* result = nullptr;
                int status = getaddrinfo(ORBIT_CLOUD_DNS_HOST, nullptr, &hints, &result);
                if (result) freeaddrinfo(result);
                return status == 0;
            };
            if (!resolves()) {
                auto* netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
                esp_netif_dns_info_t original{};
                if (netif && esp_netif_get_dns_info(netif, ESP_NETIF_DNS_MAIN, &original) == ESP_OK) {
                    esp_netif_dns_info_t alternate{};
                    alternate.ip.type = ESP_IPADDR_TYPE_V4;
                    alternate.ip.u_addr.ip4.addr = ESP_IP4TOADDR(1, 1, 1, 1);
                    if (esp_netif_set_dns_info(netif, ESP_NETIF_DNS_MAIN, &alternate) == ESP_OK) {
                        if (resolves()) {
                            ESP_LOGW(TAG, "Router DNS missed Orbit; using public DNS on this connection");
                        } else {
                            esp_netif_set_dns_info(netif, ESP_NETIF_DNS_MAIN, &original);
                            ESP_LOGW(TAG, "Orbit DNS lookup unavailable on this connection");
                        }
                    }
                }
            }
        }
        return WifiBoard::GetNetwork();
    }
#endif
    WaveshareEsp32s3TouchAMOLED1inch75() : boot_button_(BOOT_BUTTON_GPIO) {
#if CONFIG_ORBIT_AGENT
        // Only the private relay is used; never activate on the upstream service.
        Settings("wifi", true).SetString("ota_url", ORBIT_RELAY_URL);
        Settings("websocket", true).SetString("token", ORBIT_DEVICE_TOKEN);
#endif
        InitializePowerSaveTimer();
        InitializeCodecI2c();
#if CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_AMOLED_1_75
        InitializeTca9554();
#endif
        InitializeAxp2101();
        InitializeSpi();
        InitializeDisplay();
#if CONFIG_ORBIT_AGENT
        display_->SetWeatherAction([this] { OpenWeather(); });
        display_->SetCalendarAction([this] { OpenWeather(true); });
#endif
        InitializeTouch();
        InitializeButtons();
        InitializeTools();
#if CONFIG_ORBIT_AGENT
        // USB provisioning avoids putting Wi-Fi passwords in firmware or build logs.
        xTaskCreate([](void* context) {
            auto self = static_cast<WaveshareEsp32s3TouchAMOLED1inch75*>(context);
            char line[512];
            while (true) {
                if (!fgets(line, sizeof(line), stdin)) { clearerr(stdin); vTaskDelay(pdMS_TO_TICKS(100)); continue; }
                cJSON* json = cJSON_Parse(line);
                if (!json) continue;
                auto action = cJSON_GetObjectItem(json, "action");
                if (cJSON_IsString(action) && !strcmp(action->valuestring, "wifi")) {
                    auto ssid = cJSON_GetObjectItem(json, "ssid");
                    auto password = cJSON_GetObjectItem(json, "password");
                    if (cJSON_IsString(ssid) && cJSON_IsString(password) && strlen(ssid->valuestring) > 0 &&
                        strlen(ssid->valuestring) <= 32 && strlen(password->valuestring) >= 8 && strlen(password->valuestring) <= 63) {
                        SsidManager::GetInstance().AddSsid(ssid->valuestring, password->valuestring);
                        cJSON_Delete(json);
                        puts("ORBIT: Wi-Fi saved; rebooting");
                        vTaskDelay(pdMS_TO_TICKS(300));
                        esp_restart();
                    }
                } else if (cJSON_IsString(action) && !strcmp(action->valuestring, "calendar")) {
                    Application::GetInstance().Schedule([self] { self->display_->ShowHome(); self->OpenWeather(true); });
                } else if (cJSON_IsString(action) && !strcmp(action->valuestring, "weather")) {
                    Application::GetInstance().Schedule([self] {
                        self->display_->ShowHome();
                        self->OpenWeather();
                    });
                } else if (cJSON_IsString(action) && !strcmp(action->valuestring, "talk")) {
                    Application::GetInstance().Schedule([] { Application::GetInstance().ToggleChatState(); });
                    puts("ORBIT: Talk request accepted");
                } else if (cJSON_IsString(action) && !strcmp(action->valuestring, "swipe_test")) {
                    Application::GetInstance().Schedule([self] {
                        if (Application::GetInstance().GetDeviceState() != kDeviceStateIdle) {
                            puts("ORBIT: Swipe test requires idle device");
                            return;
                        }
                        puts(self->display_->CheckMenuSwipe() ? "ORBIT: Swipe test passed" : "ORBIT: Swipe test FAILED");
                    });
                } else if (cJSON_IsString(action) && !strcmp(action->valuestring, "view")) {
                    auto page = cJSON_GetObjectItem(json, "page");
                    if (cJSON_IsString(page)) {
                        std::string requested = page->valuestring;
                        if (requested == "apps" || requested == "settings" || requested == "home") {
                            Application::GetInstance().Schedule([requested] {
                                auto display = static_cast<CustomLcdDisplay*>(Board::GetInstance().GetDisplay());
                                if (requested == "apps") display->OpenApps();
                                else if (requested == "settings") display->OpenSettings();
                                else display->ShowHome();
                                puts("ORBIT: View changed");
                            });
                        }
                    }
                } else if (cJSON_IsString(action) && !strcmp(action->valuestring, "audio")) {
                    auto volume = cJSON_GetObjectItem(json, "volume");
                    auto gain = cJSON_GetObjectItem(json, "gain");
                    const int output = cJSON_IsNumber(volume) ? volume->valueint : -1;
                    const int input = cJSON_IsNumber(gain) ? gain->valueint : -1;
                    const bool valid = (!volume || (cJSON_IsNumber(volume) && volume->valuedouble == output && output >= 10 && output <= 100)) &&
                        (!gain || (cJSON_IsNumber(gain) && gain->valuedouble == input && (input == 24 || input == 30 || input == 36)));
                    if (valid) Application::GetInstance().Schedule([output, input] {
                        auto codec = Board::GetInstance().GetAudioCodec();
                        if (output >= 0) codec->SetOutputVolume(output);
                        if (input >= 0) {
                            codec->SetInputGain(input);
                            Settings("orbit_audio", true).SetInt("mic_gain", static_cast<int>(codec->input_gain()));
                        }
                        printf("ORBIT_AUDIO: volume=%d gain=%.1f input=%d\n", codec->output_volume(), codec->input_gain(), codec->input_enabled());
                    });
                    else puts("ORBIT: Invalid audio setting");
                } else if (cJSON_IsString(action) && !strcmp(action->valuestring, "screen")) {
                    std::string jpeg;
                    auto screen = dynamic_cast<LvglDisplay*>(Board::GetInstance().GetDisplay());
                    if (screen && screen->SnapshotToJpeg(jpeg, 85)) {
                        puts("ORBIT_IMAGE_BEGIN");
                        for (size_t offset = 0; offset < jpeg.size(); offset += 120) {
                            unsigned char encoded[164]; size_t written = 0;
                            mbedtls_base64_encode(encoded, sizeof(encoded), &written,
                                reinterpret_cast<const unsigned char*>(jpeg.data() + offset),
                                std::min(static_cast<size_t>(120), jpeg.size() - offset));
                            printf("ORBIT_IMAGE:%.*s\n", static_cast<int>(written), encoded);
                        }
                        puts("ORBIT_IMAGE_END");
                    } else { puts("ORBIT: Screenshot failed"); }
                }
                cJSON_Delete(json);
            }
        // Snapshot/JPEG encoding runs here, not on the application's audio task.
        }, "orbit_usb", 16384, this, 1, nullptr);
#endif
    }

    virtual AudioCodec* GetAudioCodec() override {
        static BoxAudioCodec audio_codec(
            i2c_bus_, 
            AUDIO_INPUT_SAMPLE_RATE, 
            AUDIO_OUTPUT_SAMPLE_RATE,
            AUDIO_I2S_GPIO_MCLK, 
            AUDIO_I2S_GPIO_BCLK, 
            AUDIO_I2S_GPIO_WS, 
            AUDIO_I2S_GPIO_DOUT, 
            AUDIO_I2S_GPIO_DIN,
            AUDIO_CODEC_PA_PIN, 
            AUDIO_CODEC_ES8311_ADDR, 
            AUDIO_CODEC_ES7210_ADDR, 
            AUDIO_INPUT_REFERENCE
#if CONFIG_ORBIT_AGENT
            , [] {
                const int saved = Settings("orbit_audio").GetInt("mic_gain", 36);
                return static_cast<float>(saved == 24 || saved == 30 || saved == 36 ? saved : 36);
            }()
#endif
        );
        return &audio_codec;
    }

    virtual Display* GetDisplay() override {
        return display_;
    }

    virtual Backlight* GetBacklight() override {
        return backlight_;
    }

    virtual bool GetBatteryLevel(int &level, bool &charging, bool &discharging) override {
        static bool last_discharging = false;
#if CONFIG_ORBIT_AGENT
        static bool power_state_initialized = false;
#endif
        charging = pmic_->IsCharging();
        discharging = pmic_->IsDischarging();
        if (discharging != last_discharging
#if CONFIG_ORBIT_AGENT
            || !power_state_initialized
#endif
        )
        {
            power_save_timer_->SetEnabled(discharging);
            last_discharging = discharging;
#if CONFIG_ORBIT_AGENT
            power_state_initialized = true;
#endif
        }

        level = pmic_->GetBatteryLevel();
        return true;
    }

    virtual void SetPowerSaveLevel(PowerSaveLevel level) override {
        if (level != PowerSaveLevel::LOW_POWER) {
            power_save_timer_->WakeUp();
        }
        WifiBoard::SetPowerSaveLevel(level);
    }
};

DECLARE_BOARD(WaveshareEsp32s3TouchAMOLED1inch75);
