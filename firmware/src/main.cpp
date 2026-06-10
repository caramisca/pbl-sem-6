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
// DHT11 single-wire data — pin 7 (plain digital, no timer / interrupt /
// I²C conflict). Needs a 4.7–10 kΩ pull-up to 5 V if using a bare 3-pin
// sensor; 4-pin modules already have it onboard.
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
// Runtime-configurable — stored in RAM, updated via serial commands
// from the bridge. Defaults match the report: fan 60/55, humidifier
// 40/45, gas 30/27 % (=300/270 ppm), temp 26 °C.
float HUMIDITY_HIGH      = 60.0f;  // %RH — fan ON
float HUMIDITY_HIGH_OFF  = 55.0f;  // %RH — fan OFF
float HUMIDITY_LOW       = 40.0f;  // %RH — humidifier ON
float HUMIDITY_LOW_OFF   = 45.0f;  // %RH — humidifier OFF
float TEMP_FAN_ON        = 24.0f;  // °C  — temperature fan ON
float TEMP_FAN_OFF       = 23.0f;  // °C  — temperature fan OFF
float GAS_DANGER_PCT     = 30.0f;  // %   — alarm ON  (≈300 ppm)
float GAS_DANGER_OFF_PCT = 27.0f;  // %   — alarm OFF (≈270 ppm, hysteresis)
float TEMP_HIGH          = 26.0f;  // °C  — warning only
float TEMP_WINDOW_ON     = 24.0f;  // °C  — servo opens window

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
  float gasPct        = 0.0f;   // 0.0 – 100.0 %
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

// MQ-2 readings are used immediately on real hardware.
bool gasReady = true;
int  gasRawAdc = 0; // stored for JSON diagnostics

// ---- Test state --------------------------------------------------------
// Triggered by serial commands from the bridge; temporarily override
// actuator outputs so the user can verify wiring from the web dashboard.
// TEST_NONE → normal control. TEST_LED → blink both indicator LEDs.
// TEST_BUZZER → pulse the piezo buzzer.
enum TestKind { TEST_NONE, TEST_LED, TEST_BUZZER };
TestKind testActive     = TEST_NONE;
unsigned long testStart = 0;
constexpr unsigned long TEST_BLINK_MS = 300;  // on/off phase duration
constexpr unsigned long TEST_DURATION_MS = 2000; // total test length

// =====================================================================
// SENSE
// =====================================================================
void readDht() {
  // ONE forced read per sample, then pull cached values. Calling
  // readHumidity(true) and readTemperature(true) back-to-back triggers
  // two full handshakes ~25 ms apart, which the DHT11 can't service —
  // it needs ≥1 s between reads, so the second one always returns NaN.
  dht.read(true);
  const float h = dht.readHumidity();    // cached, no force
  const float t = dht.readTemperature(); // cached, no force
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

void readGas(unsigned long now) {
  (void)now;
  gasRawAdc = analogRead(PIN_GAS); // 0..1023 on AVR 10-bit ADC
  const float sample = (float)gasRawAdc * 100.0f / ADC_FULL_SCALE; // → 0.0–100.0 %
  // Exponential moving average to suppress sensor noise / cross-sensitivity.
  if (state.gasEma == 0.0f) state.gasEma = sample;
  state.gasEma = GAS_EMA_ALPHA * sample + (1.0f - GAS_EMA_ALPHA) * state.gasEma;
  state.gasPct = state.gasEma;
}

// =====================================================================
// DECIDE — hysteresis-based control logic (matches report §2.0.1.4)
// =====================================================================
void applyHysteresis() {
  // Fan — humidity-based
  if (!state.fanOn && state.humidity >= HUMIDITY_HIGH)              state.fanOn = true;
  else if ( state.fanOn && state.humidity < HUMIDITY_HIGH_OFF)      state.fanOn = false;

  // Fan — temperature-based (hysteresis: ON at >24°C, OFF at <23°C)
  if (!state.fanOn && state.temperature > TEMP_FAN_ON)              state.fanOn = true;
  else if ( state.fanOn && state.temperature < TEMP_FAN_OFF)        state.fanOn = false;

  // Humidifier
  if (!state.humidifierOn && state.humidity <= HUMIDITY_LOW)        state.humidifierOn = true;
  else if ( state.humidifierOn && state.humidity > HUMIDITY_LOW_OFF) state.humidifierOn = false;

  // Mutual exclusion guard — fan wins (mold/safety > comfort).
  if (state.fanOn && state.humidifierOn) state.humidifierOn = false;

  // Gas alarm — triggers buzzer
  if (!state.alarmOn && state.gasPct >= GAS_DANGER_PCT)             state.alarmOn = true;
  else if ( state.alarmOn && state.gasPct < GAS_DANGER_OFF_PCT)     state.alarmOn = false;

  // Force-vent on alarm: get the air moving regardless of RH.
  if (state.alarmOn) state.fanOn = true;

  // Window: open when fan runs, alarm is active, OR temperature hits 24 °C.
  state.windowOpen = state.fanOn || state.alarmOn || (state.temperature >= TEMP_WINDOW_ON);
}

// =====================================================================
// ACT
// =====================================================================
void driveActuators(unsigned long now) {
  // ── Servo always follows normal logic (window position) ──────────
  {
    const int windowAngle = state.windowOpen ? WINDOW_OPEN_DEG : WINDOW_CLOSED_DEG;
    windowServo.write(constrain(windowAngle, WINDOW_CLOSED_DEG, WINDOW_OPEN_DEG));
  }

  // ── LED test override ────────────────────────────────────────────
  if (testActive == TEST_LED) {
    unsigned long elapsed = now - testStart;
    if (elapsed >= TEST_DURATION_MS) {
      // Test finished — restore normal control and send ACK.
      testActive = TEST_NONE;
      digitalWrite(PIN_FAN, LOW);
      digitalWrite(PIN_HUMIDIFIER, LOW);
      Serial.println(F("{\"ack\":\"test-led\",\"status\":\"completed\"}"));
    } else {
      bool ledOn = ((elapsed / TEST_BLINK_MS) % 2) == 0;
      digitalWrite(PIN_FAN,        ledOn ? HIGH : LOW);
      digitalWrite(PIN_HUMIDIFIER, ledOn ? HIGH : LOW);
    }
  } else {
    // Normal LED control
    digitalWrite(PIN_FAN,        state.fanOn        ? HIGH : LOW);
    digitalWrite(PIN_HUMIDIFIER, state.humidifierOn ? HIGH : LOW);
  }

  // ── Buzzer test override ─────────────────────────────────────────
  if (testActive == TEST_BUZZER) {
    unsigned long elapsed = now - testStart;
    if (elapsed >= TEST_DURATION_MS) {
      testActive = TEST_NONE;
      noTone(PIN_BUZZER);
      buzzerActive = false;
      Serial.println(F("{\"ack\":\"test-buzzer\",\"status\":\"completed\"}"));
    } else {
      bool beepOn = ((elapsed / TEST_BLINK_MS) % 2) == 0;
      if (beepOn) {
        tone(PIN_BUZZER, BUZZER_FREQ_HZ);
      } else {
        noTone(PIN_BUZZER);
      }
    }
  } else {
    // Normal buzzer — pulse with melodic "singing" pattern while the alarm latch is set.
    if (state.alarmOn) {
      if (now - lastBuzzerToggleAt > BUZZER_PULSE_MS) {
        lastBuzzerToggleAt = now;
        buzzerActive = !buzzerActive;
        if (buzzerActive) {
          // Melodic rising tone pattern for "singing" effect
          int pitchVariation = (now / 200) % 4; // 4-step pitch pattern
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
  // ── Test mode overlay ───────────────────────────────────────────
  if (testActive != TEST_NONE) {
    lcd.setCursor(0, 0);
    if (testActive == TEST_LED) {
      lcd.print(F("  HARDWARE TEST  "));
      lcd.setCursor(0, 1);
      lcd.print(F("  LED BLINK     "));
    } else {
      lcd.print(F("  HARDWARE TEST  "));
      lcd.setCursor(0, 1);
      lcd.print(F("  BUZZER BEEP   "));
    }
    return;
  }

  // Row 0 — readings. We rewrite the row in-place with trailing spaces
  // instead of lcd.clear() so the panel doesn't flicker every 2 s.
  lcd.setCursor(0, 0);
  lcd.print(F("T:"));
  lcd.print((int)state.temperature);
  lcd.print(F(" H:"));
  lcd.print((int)state.humidity);
  lcd.print(F(" G:"));
  lcd.print((int)state.gasPct);
  lcd.print('%');
  lcd.print(F("  ")); // pad

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
// SERIAL COMMAND PARSER — accepts JSON threshold updates from bridge
//
// Expected format (one JSON object per line):
//   {"cmd":"set-thresholds","humidityHigh":60,"humidityHighOff":55,...}
//
// Gas values arrive in ppm-equivalent (backend convention) and are
// converted to percent (÷10) for the firmware's internal logic.
// =====================================================================
void checkSerialCommands() {
  static String serialBuf = "";
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (serialBuf.length() == 0) continue;
      // Attempt JSON parse
      // We use a lightweight manual parser because ArduinoJson isn't
      // available on this build target.
      const String& s = serialBuf;
      // ── Test commands from web dashboard ─────────────────────────
      if (s.startsWith("{\"cmd\":\"test-led\"")) {
        testActive = TEST_LED;
        testStart = millis();
        Serial.println(F("{\"ack\":\"test-led\",\"status\":\"started\"}"));
      }
      else if (s.startsWith("{\"cmd\":\"test-buzzer\"")) {
        testActive = TEST_BUZZER;
        testStart = millis();
        Serial.println(F("{\"ack\":\"test-buzzer\",\"status\":\"started\"}"));
      }
      else if (s.startsWith("{\"cmd\":\"set-thresholds\"")) {
        // Extract numeric values for each known key
        auto getFloat = [&](const char* key, float deflt) -> float {
          int pos = s.indexOf(key);
          if (pos < 0) return deflt;
          // skip past "key":
          pos += strlen(key) + 2; // key + :"
          if (pos >= (int)s.length()) return deflt;
          const char* numStart = s.c_str() + pos; // after "key": → first digit of value
          // move to the first digit/dot
          while (*numStart && *numStart != ':' && !isdigit(*numStart) && *numStart != '-' && *numStart != '.')
            numStart++;
          return atof(numStart);
        };

        HUMIDITY_HIGH      = getFloat("humidityHigh",      HUMIDITY_HIGH);
        HUMIDITY_HIGH_OFF  = getFloat("humidityHighOff",   HUMIDITY_HIGH_OFF);
        HUMIDITY_LOW       = getFloat("humidityLow",       HUMIDITY_LOW);
        HUMIDITY_LOW_OFF   = getFloat("humidityLowOff",    HUMIDITY_LOW_OFF);
        TEMP_HIGH          = getFloat("tempHigh",          TEMP_HIGH);

        // Gas thresholds arrive in ppm from backend; firmware uses % (÷10)
        float gasDanger    = getFloat("gasDanger",    GAS_DANGER_PCT * 10.0f);
        float gasDangerOff = getFloat("gasDangerOff", GAS_DANGER_OFF_PCT * 10.0f);
        GAS_DANGER_PCT     = gasDanger / 10.0f;
        GAS_DANGER_OFF_PCT = gasDangerOff / 10.0f;

        // Send acknowledgment so the bridge knows it was applied
        Serial.print(F("{\"ack\":\"thresholds\",\"humidityHigh\":"));
        Serial.print(HUMIDITY_HIGH, 0);
        Serial.print(F(",\"humidityHighOff\":"));
        Serial.print(HUMIDITY_HIGH_OFF, 0);
        Serial.print(F(",\"humidityLow\":"));
        Serial.print(HUMIDITY_LOW, 0);
        Serial.print(F(",\"humidityLowOff\":"));
        Serial.print(HUMIDITY_LOW_OFF, 0);
        Serial.print(F(",\"gasDanger\":"));
        Serial.print(GAS_DANGER_PCT * 10.0f, 0);
        Serial.print(F(",\"gasDangerOff\":"));
        Serial.print(GAS_DANGER_OFF_PCT * 10.0f, 0);
        Serial.print(F(",\"tempHigh\":"));
        Serial.print(TEMP_HIGH, 0);
        Serial.println(F("}"));
      }
      serialBuf = "";
    } else {
      if (serialBuf.length() < 256) serialBuf += c;
    }
  }
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

  // --- PIN 5/6 DIAGNOSTIC ---
  Serial.println(F("--- PIN 5/6 diagnostic ---"));
  pinMode(PIN_HUMIDIFIER, OUTPUT);
  digitalWrite(PIN_HUMIDIFIER, HIGH); delay(10);
  Serial.print(F("  pin 5 HIGH -> digitalRead=")); Serial.println(digitalRead(PIN_HUMIDIFIER));
  digitalWrite(PIN_HUMIDIFIER, LOW);  delay(10);
  Serial.print(F("  pin 5 LOW  -> digitalRead=")); Serial.println(digitalRead(PIN_HUMIDIFIER));
  pinMode(PIN_FAN, OUTPUT);
  digitalWrite(PIN_FAN, HIGH); delay(10);
  Serial.print(F("  pin 6 HIGH -> digitalRead=")); Serial.println(digitalRead(PIN_FAN));
  digitalWrite(PIN_FAN, LOW);  delay(10);
  Serial.print(F("  pin 6 LOW  -> digitalRead=")); Serial.println(digitalRead(PIN_FAN));
  // Raw register write: pin5=PE3, pin6=PH3
  DDRE |= (1<<3); PORTE |= (1<<3);
  DDRH |= (1<<3); PORTH |= (1<<3);
  Serial.println(F("  raw PORT write -> both HIGH for 3s, check LEDs NOW"));
  delay(3000);
  PORTE &= ~(1<<3);
  PORTH &= ~(1<<3);
  // Window servo � start closed.
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
  dht.begin(); // default 55 µs pull time — 100 µs overshoots the sensor's 80 µs response pulse
  delay(1500); // DHT11 needs >1 s after power-on before first read

  // --- Startup DHT probe (5 attempts, prints each result) -----------
  Serial.print(F("--- DHT11 probe (data wire -> pin "));
  Serial.print(PIN_DHT);
  Serial.println(F(") ---"));

  // Check DATA line at rest — must be HIGH.
  pinMode(PIN_DHT, INPUT_PULLUP);
  delay(10);
  int dataAtRest = digitalRead(PIN_DHT);
  Serial.print(F("  DATA line at rest: "));
  Serial.println(dataAtRest ? F("HIGH (good — pin connected, pull-up works)") : F("LOW  -> VCC/GND swapped or short!"));

  // Raw watch: drive pin LOW for 25 ms (host start), release, watch 200 µs for
  // sensor to pull it LOW in response. A healthy DHT11 MUST respond here.
  Serial.print(F("  Raw sensor response test: "));
  pinMode(PIN_DHT, OUTPUT);
  digitalWrite(PIN_DHT, LOW);
  delay(25);
  pinMode(PIN_DHT, INPUT_PULLUP);
  delayMicroseconds(50);
  bool sensorResponded = false;
  for (int t = 0; t < 500; t++) {  // watch up to 500 µs
    if (digitalRead(PIN_DHT) == LOW) { sensorResponded = true; break; }
    delayMicroseconds(1);
  }
  Serial.println(sensorResponded ? F("RESPONDED (sensor alive)") : F("NO RESPONSE -> sensor dead or DATA wire not reaching sensor"));

  for (int i = 0; i < 3; i++) {
    delay(2100);
    float h = dht.readHumidity(true);         // force=true
    float t2 = dht.readTemperature(false, true); // force=true
    Serial.print(F("  attempt ")); Serial.print(i + 1);
    if (isnan(h) || isnan(t2)) {
      Serial.println(F(" -> FAILED"));
    } else {
      Serial.print(F(" -> OK  T=")); Serial.print(t2);
      Serial.print(F("C  H=")); Serial.print(h); Serial.println('%');
    }
  }

  // --- MQ-2 wiring check (heater needs power on VCC+GND) ------------
  Serial.println(F("--- MQ-2 probe (scanning A0-A5) ---"));
  {
    // Scan all 6 analog pins — the one that is NOT near 1023 is where AO landed.
    const char* pinNames[] = {"A0","A1","A2","A3","A4","A5"};
    const int   pins[]     = { A0,  A1,  A2,  A3,  A4,  A5 };
    for (int i = 0; i < 6; i++) {
      int v = analogRead(pins[i]);
      Serial.print(F("  ")); Serial.print(pinNames[i]);
      Serial.print(F("=")); Serial.print(v);
      if (v < 950) Serial.print(F("  <-- AO signal here!"));
      Serial.println();
    }
  }
  Serial.println(F("--- probe done ---"));

  pinMode(PIN_GAS, INPUT);
}

void loop() {
  const unsigned long now = millis();
  state.uptimeS = now / 1000UL;

  // Check for serial threshold updates from the bridge
  checkSerialCommands();

  // Sense + decide + render at the sample cadence
  if (now - lastSampleAt >= SAMPLE_INTERVAL_MS) {
    lastSampleAt = now;
    readDht();
    readGas(now);
    applyHysteresis();
    renderDisplay();

    // JSON line per sample — consumed by the Node serial bridge that
    // forwards readings to the backend's WebSocket.
    Serial.print(F("{\"deviceId\":\"")); Serial.print(F(DEVICE_ID));
    Serial.print(F("\",\"dhtValid\":"));    Serial.print(state.dhtValid ? F("true") : F("false"));
    Serial.print(F(",\"humidity\":"));      Serial.print(state.humidity, 1);
    Serial.print(F(",\"temperature\":"));   Serial.print(state.temperature, 1);
    Serial.print(F(",\"gasPct\":"));        Serial.print(state.gasPct, 1);
    Serial.print(F(",\"gas\":"));            Serial.print(state.gasPct * 10.0f, 0);
    Serial.print(F(",\"gasRaw\":"));         Serial.print(gasRawAdc);
    Serial.print(F(",\"gasReady\":"));       Serial.print(gasReady ? F("true") : F("false"));
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
