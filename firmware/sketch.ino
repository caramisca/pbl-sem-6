// =====================================================================
// Room Manager — Arduino Mega 2560 firmware
//
// Sense → Decide → Act → Display, exactly as specified in the project
// report. DHT11 + MQ-2 feed an ATmega2560 that drives indicator LEDs,
// a piezo alarm and a window-vent servo, with hysteresis-based control
// logic and a 16x2 I²C LCD for local read-out.
//
// This is the standalone build — no Wi-Fi / MQTT (the Mega has no
// wireless on-board). The control loop is self-contained per NFR 9.
//
// Wokwi: the MQ-2 is replaced by a potentiometer; the fan/humidifier
// are represented by indicator LEDs (which is what the bench build
// physically uses too).
// =====================================================================

#include <Arduino.h>
#include <Wire.h>
#include <DHT.h>
#include <LiquidCrystal_I2C.h>
#include <Servo.h>

// ---- Inlined config (firmware/include/config.h) ----------------------
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
// DHT11 single-wire data. Needs a 4.7–10 kΩ pull-up to 5 V on real HW.
// Wokwi handles the pull-up internally on the dht part.
#define PIN_DHT          7

// MQ-2 analog out → A0 (10-bit ADC, 0..1023).
// In Wokwi this pin is driven by a potentiometer that simulates rising
// gas concentration.
#define PIN_GAS          A0

// Fan indicator output. Drives an LED through 220 Ω (or a relay's IN
// input) — active-HIGH. Flip the level in driveActuators() if you
// later swap in an active-LOW relay board.
#define PIN_FAN          6

// Humidifier indicator output (LED / relay IN).
#define PIN_HUMIDIFIER   5

// Piezo buzzer driven by tone() (Timer 2 on the Mega).
// Any digital pin works; pin 9 is kept clear of the timers we use
// elsewhere (Servo on Timer 5, no PWM conflicts here).
#define PIN_BUZZER       9

// Servo driving the motorised window vent. The Servo library on the
// Mega claims Timer 5 by default, which doesn't collide with tone()
// (Timer 2) or the Wire/Adafruit stack.
#define PIN_WINDOW       10
constexpr int WINDOW_CLOSED_DEG = 0;
constexpr int WINDOW_OPEN_DEG   = 90;  // limit travel to a 90-degree sweep

// I²C bus for the 16x2 LCD uses the Mega's hardware TWI pins:
// SDA = 20, SCL = 21 (no manual definition needed — Wire library
// owns those pins automatically on the Mega).

// ---- Thresholds (hysteresis bands) -----------------------------------
// Match the report exactly: fan 60/55, humidifier 40/45, gas 300/270.
constexpr float HUMIDITY_HIGH      = 60.0f;  // %RH — fan ON
constexpr float HUMIDITY_HIGH_OFF  = 55.0f;  // %RH — fan OFF
constexpr float HUMIDITY_LOW       = 40.0f;  // %RH — humidifier ON
constexpr float HUMIDITY_LOW_OFF   = 45.0f;  // %RH — humidifier OFF
constexpr float TEMP_FAN_ON        = 24.0f;  // °C  — temperature fan ON (hysteresis upper)
constexpr float TEMP_FAN_OFF       = 23.0f;  // °C  — temperature fan OFF (hysteresis lower)
constexpr int   GAS_DANGER_PPM     = 100;    // ppm — alarm ON (~10%)
constexpr int   GAS_DANGER_OFF_PPM = 90;     // ppm — alarm OFF (hysteresis)
constexpr float TEMP_HIGH          = 26.0f;  // °C  — warning only

// MQ-2 analog → ppm scaling for the simulator. The real sensor is
// non-linear (Rs/R0 vs ppm) and needs calibration; here we use a clean
// linear map so the potentiometer span covers the alarm threshold.
// AVR ADC is 10-bit → 0..1023 → 0..1000 ppm.
constexpr int   GAS_PPM_FULL_SCALE = 1000;
constexpr int   ADC_FULL_SCALE     = 1023;

// EMA smoothing factor for the gas reading: new = α·sample + (1−α)·prev.
constexpr float GAS_EMA_ALPHA      = 0.20f;

// ---- Timing ---------------------------------------------------------
constexpr unsigned long SAMPLE_INTERVAL_MS = 2000; // sensor poll
constexpr unsigned long BUZZER_PULSE_MS    = 500;  // alarm beep cadence
constexpr int           BUZZER_FREQ_HZ     = 2200;

// ---- Identity -------------------------------------------------------
#define DEVICE_ID  "rm-living"
#define FW_VERSION "1.4.2-mega"


// ---- Hardware singletons --------------------------------------------
// PCF8574-backed 16x2 LCDs are usually at 0x27; some Chinese clones
// ship at 0x3F — flip this if the screen stays blank with the backlight
// on. (Run an I²C scanner sketch once to be sure.)
constexpr uint8_t LCD_ADDR = 0x27;
constexpr uint8_t LCD_COLS = 16;
constexpr uint8_t LCD_ROWS = 2;

DHT dht(PIN_DHT, DHT11);
LiquidCrystal_I2C lcd(LCD_ADDR, LCD_COLS, LCD_ROWS);
Servo windowServo;

// ---- Runtime state --------------------------------------------------
struct State {
  float humidity      = 50.0f;
  float temperature   = 22.0f;
  int   gasPpm        = 0;
  float gasEma        = 0.0f;
  bool  fanOn         = false;
  bool  humidifierOn  = false;
  bool  alarmOn       = false;
  bool  windowOpen    = false;
  bool  dhtValid      = false;
  unsigned long uptimeS = 0;
};

State state;
unsigned long lastSampleAt       = 0;
unsigned long lastBuzzerToggleAt = 0;
bool          buzzerActive       = false;

// Last good sensor values — held when DHT11 returns NaN so the control
// loop never crashes on a single failed read (NFR 6 — Reliability).
float lastValidHumidity = 50.0f;
float lastValidTemp     = 22.0f;

// =====================================================================
// SENSE
// =====================================================================
void readDht() {
  const float h = dht.readHumidity();
  const float t = dht.readTemperature();
  state.dhtValid = !isnan(h) && !isnan(t);
  if (state.dhtValid) {
    lastValidHumidity = h;
    lastValidTemp     = t;
    state.humidity    = h;
    state.temperature = t;
  } else {
    state.humidity    = lastValidHumidity;
    state.temperature = lastValidTemp;
  }
}

void readGas() {
  const int raw = analogRead(PIN_GAS); // 0..1023 on AVR 10-bit ADC
  const int sample = (int)((float)raw * GAS_PPM_FULL_SCALE / ADC_FULL_SCALE);
  // Exponential moving average to suppress sensor noise / cross-sensitivity.
  if (state.gasEma == 0.0f) state.gasEma = (float)sample;
  state.gasEma = GAS_EMA_ALPHA * sample + (1.0f - GAS_EMA_ALPHA) * state.gasEma;
  state.gasPpm = (int)state.gasEma;
}

// =====================================================================
// DECIDE — hysteresis-based control logic (matches report §2.0.1.4)
// =====================================================================
void applyHysteresis() {
  // Fan — humidity-based control
  if (!state.fanOn && state.humidity > HUMIDITY_HIGH)               state.fanOn = true;
  else if ( state.fanOn && state.humidity < HUMIDITY_HIGH_OFF)      state.fanOn = false;

  // Fan — temperature-based control (hysteresis: ON at >24°C, OFF at <23°C)
  if (!state.fanOn && state.temperature > TEMP_FAN_ON)              state.fanOn = true;
  else if ( state.fanOn && state.temperature < TEMP_FAN_OFF)        state.fanOn = false;

  // Humidifier
  if (!state.humidifierOn && state.humidity < HUMIDITY_LOW)         state.humidifierOn = true;
  else if ( state.humidifierOn && state.humidity > HUMIDITY_LOW_OFF) state.humidifierOn = false;

  // Mutual exclusion guard — fan wins (mold/safety > comfort).
  if (state.fanOn && state.humidifierOn) state.humidifierOn = false;

  // Gas alarm — triggers buzzer
  if (!state.alarmOn && state.gasPpm > GAS_DANGER_PPM)              state.alarmOn = true;
  else if ( state.alarmOn && state.gasPpm < GAS_DANGER_OFF_PPM)     state.alarmOn = false;

  // Force-vent on alarm: get the air moving regardless of RH.
  if (state.alarmOn) state.fanOn = true;

  // Window follows ventilation demand — open whenever the fan runs
  // (high RH) or the gas alarm is latched.
  state.windowOpen = state.fanOn || state.alarmOn;
}

// =====================================================================
// ACT
// =====================================================================
void driveActuators(unsigned long now) {
  digitalWrite(PIN_FAN,        state.fanOn        ? HIGH : LOW);
  digitalWrite(PIN_HUMIDIFIER, state.humidifierOn ? HIGH : LOW);
  {
    const int windowAngle = state.windowOpen ? WINDOW_OPEN_DEG : WINDOW_CLOSED_DEG;
    windowServo.write(constrain(windowAngle, WINDOW_CLOSED_DEG, WINDOW_OPEN_DEG));
  }

  // Buzzer — melodic "singing" pattern while the alarm latch is set
  if (state.alarmOn) {
    if (now - lastBuzzerToggleAt > BUZZER_PULSE_MS) {
      lastBuzzerToggleAt = now;
      buzzerActive = !buzzerActive;
      if (buzzerActive) {
        // Melodic rising tone pattern for "singing" effect — creates a pleasant alarm
        int pitchVariation = (now / 200) % 4; // 4-step pitch pattern cycling every 800ms
        int basePitch = BUZZER_FREQ_HZ;
        int pitches[] = {basePitch, basePitch + 200, basePitch + 400, basePitch + 300};
        tone(PIN_BUZZER, pitches[pitchVariation]);
      } else {
        noTone(PIN_BUZZER);
      }
    }
  } else if (buzzerActive) {
    buzzerActive = false;
    noTone(PIN_BUZZER);
  }
}

// =====================================================================
// DISPLAY — 16x2 LCD layout
//
//   col:  0123456789012345
//   row 0: T:24 H:60 G:300
//   row 1: F:0 H:0 A:0 W:0
//
// Both rows fit inside 16 chars even at the worst case (T:-9, H:99,
// G:1000 → exactly 16). DHT11 returns integer values so we drop the
// decimal place vs the OLED build.
// =====================================================================
void renderDisplay() {
  // Row 0 — readings. We rewrite the row in-place with trailing spaces
  // instead of lcd.clear() so the panel doesn't flicker every 2 s.
  lcd.setCursor(0, 0);
  lcd.print(F("T:"));
  lcd.print((int)state.temperature);
  lcd.print(F(" H:"));
  lcd.print((int)state.humidity);
  lcd.print(F(" G:"));
  lcd.print(state.gasPpm);
  lcd.print(F("    ")); // pad to 16 (covers shrinking gas value)

  // Row 1 — actuator state, single-digit booleans + DHT-fault marker.
  lcd.setCursor(0, 1);
  lcd.print(F("F:"));
  lcd.print(state.fanOn        ? '1' : '0');
  lcd.print(F(" H:"));
  lcd.print(state.humidifierOn ? '1' : '0');
  lcd.print(F(" A:"));
  lcd.print(state.alarmOn      ? '1' : '0');
  lcd.print(F(" W:"));
  lcd.print(state.windowOpen   ? '1' : '0');
  lcd.print(state.dhtValid ? ' ' : '*'); // 16th cell flags a bad DHT read
}

// =====================================================================
// SETUP / LOOP
// =====================================================================
void setup() {
  Serial.begin(9600);
  delay(200);
  Serial.println();
  Serial.print(F("=== Room Manager · Mega firmware "));
  Serial.print(F(FW_VERSION));
  Serial.println(F(" ==="));

  // Actuator pins
  pinMode(PIN_FAN, OUTPUT);
  pinMode(PIN_HUMIDIFIER, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_FAN, LOW);
  digitalWrite(PIN_HUMIDIFIER, LOW);

  // Window servo — start closed.
  windowServo.attach(PIN_WINDOW);
  windowServo.write(WINDOW_CLOSED_DEG);

  // LCD
  Wire.begin();
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print(F("Room Manager"));
  lcd.setCursor(0, 1);
  lcd.print(F("v"));
  lcd.print(F(FW_VERSION));

  // Sensors
  dht.begin();
  pinMode(PIN_GAS, INPUT);
}

void loop() {
  const unsigned long now = millis();
  state.uptimeS = now / 1000UL;

  // Sense + decide + render at the sample cadence
  if (now - lastSampleAt >= SAMPLE_INTERVAL_MS) {
    lastSampleAt = now;
    readDht();
    readGas();
    applyHysteresis();
    renderDisplay();

    // JSON line per sample — consumed by the Node serial bridge that
    // forwards readings to the backend's WebSocket.
    Serial.print(F("{\"deviceId\":\"")); Serial.print(F(DEVICE_ID));
    Serial.print(F("\",\"humidity\":"));    Serial.print(state.humidity, 1);
    Serial.print(F(",\"temperature\":"));   Serial.print(state.temperature, 1);
    Serial.print(F(",\"gas\":"));           Serial.print(state.gasPpm);
    Serial.print(F(",\"fanOn\":"));         Serial.print(state.fanOn ? F("true") : F("false"));
    Serial.print(F(",\"humidifierOn\":"));  Serial.print(state.humidifierOn ? F("true") : F("false"));
    Serial.print(F(",\"alarmOn\":"));       Serial.print(state.alarmOn ? F("true") : F("false"));
    Serial.print(F(",\"windowOpen\":"));    Serial.print(state.windowOpen ? F("true") : F("false"));
    Serial.print(F(",\"uptime\":"));        Serial.print(state.uptimeS);
    Serial.println(F("}"));
  }

  // Drive actuators every iteration so the buzzer pulse stays smooth.
  driveActuators(now);
}
