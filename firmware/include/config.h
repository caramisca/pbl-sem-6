#pragma once

// =====================================================================
// Room Manager — Arduino Mega 2560 firmware configuration
// Pin map, thresholds (with hysteresis), timing.
//
// Note: the Mega has no Wi-Fi/Bluetooth, so this build implements the
// project's NFR 9 "Standalone Fallback Mode" — sensing, decision,
// actuation, display, alarm. Remote MQTT telemetry is not available
// without an external Wi-Fi shield (e.g. ESP-01 over Serial1).
// =====================================================================

// ---- Pin map (Arduino Mega 2560) -------------------------------------
// DHT11 single-wire data — pin 22 (plain digital on the Mega's 22-53 header,
// pure GPIO, no timer, no interrupt, no conflict with Servo/tone/I2C).
// Needs a 4.7–10 kΩ pull-up to 5 V on real HW.
#define PIN_DHT          22

// MQ-2 analog out → A0 (10-bit ADC, 0..1023).
// In Wokwi this pin is driven by a potentiometer that simulates rising
// gas concentration.
#define PIN_GAS          A0

// Relay channel for the ventilation fan. Active-HIGH; flip the level
// in driveActuators() if your relay board is active-LOW.
#define PIN_FAN          6

// Relay channel for the humidifier.
#define PIN_HUMIDIFIER   5

// Piezo buzzer driven by tone() (Timer 2 on the Mega).
// Any digital pin works; pin 9 keeps the buzzer away from the timers
// the Adafruit graphics libraries occasionally touch.
#define PIN_BUZZER       9

// I²C bus for the SSD1306 OLED uses the Mega's hardware TWI pins:
// SDA = 20, SCL = 21 (no manual definition needed — Wire library
// owns those pins automatically on the Mega).

// ---- Thresholds (hysteresis bands) -----------------------------------
// Runtime-configurable via serial commands from the bridge.
// These are the factory defaults — they can be overridden at runtime.
// Match the report exactly: fan 60/55, humidifier 40/45, gas 300/270.
#define DEFAULT_HUMIDITY_HIGH      60.0f  // %RH — fan ON
#define DEFAULT_HUMIDITY_HIGH_OFF  55.0f  // %RH — fan OFF
#define DEFAULT_HUMIDITY_LOW       40.0f  // %RH — humidifier ON
#define DEFAULT_HUMIDITY_LOW_OFF   45.0f  // %RH — humidifier OFF
#define DEFAULT_TEMP_FAN_ON        24.0f  // °C  — temperature fan ON (hysteresis upper)
#define DEFAULT_TEMP_FAN_OFF       23.0f  // °C  — temperature fan OFF (hysteresis lower)
#define DEFAULT_GAS_DANGER_PCT     30.0f  // %   — alarm ON  (≈300 ppm)
#define DEFAULT_GAS_DANGER_OFF_PCT 27.0f  // %   — alarm OFF (≈270 ppm, hysteresis)
#define DEFAULT_TEMP_HIGH          26.0f  // °C  — warning only
constexpr float TEMP_WINDOW_ON     = 24.0f;  // °C  — servo opens window

// ADC full scale for MQ-2 percent conversion.
// AVR ADC is 10-bit → 0..1023 → maps to 0.0–100.0 %.
constexpr int   ADC_FULL_SCALE     = 1023;

// EMA smoothing factor for the gas reading: new = α·sample + (1−α)·prev.
constexpr float GAS_EMA_ALPHA      = 0.20f;

// ---- Timing ---------------------------------------------------------
constexpr unsigned long SAMPLE_INTERVAL_MS = 2000; // sensor poll
constexpr unsigned long BUZZER_PULSE_MS    = 500;  // alarm beep cadence
constexpr int           BUZZER_FREQ_HZ     = 1000; // lower frequency for less shrill tone

// ---- Identity -------------------------------------------------------
#define DEVICE_ID  "rm-living"
#define FW_VERSION "1.4.2-mega"
