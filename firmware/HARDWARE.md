# Room Manager — Real-World Hardware Build

This document describes the physical Arduino Mega 2560 build. The
Wokwi simulation in `firmware/diagram.json` mirrors this hardware
exactly — the only deliberate substitution is a potentiometer in
place of the MQ-2 (so the simulator can sweep gas concentrations
without a real flame).

---

## 1. Bill of Materials

| # | Component | Qty | Notes |
|---|-----------|----:|-------|
| 1 | Arduino Mega 2560 (Rev 3) | 1 | Or any 100 % pin-compatible clone |
| 2 | DHT11 temperature + humidity sensor | 1 | 4-pin module preferred (onboard pull-up); the bare 3-pin part needs an external 4.7–10 kΩ pull-up on DATA |
| 3 | MQ-2 gas sensor module | 1 | Pre-assembled board with onboard load resistor + comparator |
| 4 | 16x2 character LCD with I²C backpack (PCF8574) | 1 | 4 pins: GND, VCC, SDA, SCL. Default address 0x27 — some clones use 0x3F |
| 5 | SG90 micro servo | 1 | Drives the window vent. MG90S works too |
| 6 | 5 mm LED, red | 1 | "FAN" indicator (the project uses an LED in place of a real fan) |
| 7 | 5 mm LED, blue | 1 | "HUM" humidifier indicator |
| 8 | 220 Ω resistor | 2 | Current limiter for each LED |
| 9 | Active piezo buzzer | 1 | Passive piezo also fine — the firmware uses `tone()` |
| 10 | Breadboard + jumper wires | 1 set | Or perfboard + soldered headers |
| 11 | 5 V DC supply, ≥ 1 A (USB phone charger) | 1 | Powers the **servo only** — see §5 |
| 12 | USB-B cable | 1 | Powers + flashes the Mega |

No relays and no separate 12 V supply: the project uses LEDs as
visual stand-ins for the fan and humidifier, so all logic-level
outputs drive LEDs through a 220 Ω resistor.

---

## 2. Pin Map

This is the authoritative pin list. It mirrors the `#define`s at the
top of `sketch.ino`.

| Function | Mega Pin | Component side | Notes |
|---|---|---|---|
| DHT11 data | D7 | DHT11 `DATA` (or pin 2 on bare part) | 4.7 kΩ pull-up to 5 V on the data line if using the 3-pin bare sensor |
| MQ-2 analog | A0 | MQ-2 `AOUT` | Use AOUT, not DOUT — firmware reads the analog level |
| Humidifier LED | D5 | LED anode (via 220 Ω) | LED cathode → GND |
| Fan LED | D6 | LED anode (via 220 Ω) | LED cathode → GND |
| Buzzer | D9 | Buzzer `+` | `tone()` uses Timer 2; no other timer-2 PWM is used |
| Window servo PWM | D10 | Servo orange/yellow signal | Servo lib uses Timer 5 on Mega — no clash with `tone()` |
| LCD SDA | D20 (SDA) | LCD `SDA` | Hardware I²C — do not move |
| LCD SCL | D21 (SCL) | LCD `SCL` | Hardware I²C — do not move |
| 5 V rail | 5V | DHT11 VCC, LCD VCC, MQ-2 VCC | Mega's onboard regulator handles these comfortably |
| Servo 5 V | external 5 V | Servo red | **Do not** power the servo from the Mega 5 V — see §5 |
| Ground | GND (any) | Every component | Common ground tied to the external 5 V supply too |

---

## 3. Breadboard Layout

A standard 830-point breadboard with two power rails on each side. We
only use the rails on **one** side of the board — the other side is
just for spacing.

```
  Top rail    (red strip):   +5V from the Mega
  Bottom rail (blue strip):  GND from the Mega + servo PSU GND

  Mid columns:
    cols  1– 5   DHT11
    cols  8–12   MQ-2
    cols 15–17   FAN LED + 220 Ω
    cols 19–21   HUM LED + 220 Ω
    cols 24–25   Buzzer
    LCD + servo: wired off-board with female-male jumpers
```

You can place the LCD and servo directly on the breadboard if you
have the headers, but it's easier to keep them off-board on flying
leads — both are bulky.

---

## 4. Step-by-Step Wiring

**Do every step with the Mega unplugged from USB.** Plug it in only
at step 30. Use the colours below — they make later debugging
trivial. Each step is one wire.

### A · Power rails (steps 1–4)

| # | From | To | Wire |
|---|------|----|------|
| 1 | Mega `5V` | Breadboard `+` rail (top) | red |
| 2 | Mega `GND` | Breadboard `−` rail (bottom) | black |
| 3 | `+` rail left end | `+` rail right end | red (jumper across the gap if your board isn't bridged) |
| 4 | `−` rail left end | `−` rail right end | black |

### B · LCD 16×2 (I²C, 4 pins) — steps 5–8

The LCD has 4 labelled pins on its backpack: `GND`, `VCC`, `SDA`,
`SCL`. Use female-to-male jumpers.

| # | From | To | Wire |
|---|------|----|------|
| 5 | LCD `GND` | Breadboard `−` rail | black |
| 6 | LCD `VCC` | Breadboard `+` rail | red |
| 7 | LCD `SDA` | Mega `D20 (SDA)` | blue |
| 8 | LCD `SCL` | Mega `D21 (SCL)` | yellow |

### C · DHT11 (3-pin module: `+`/`out`/`-`, or 4-pin: VCC/DATA/NC/GND) — steps 9–11

Push the DHT11 module into cols 1–3 (or use jumpers).

| # | From | To | Wire |
|---|------|----|------|
| 9 | DHT11 `+` (VCC) | Breadboard `+` rail | red |
| 10 | DHT11 `-` (GND) | Breadboard `−` rail | black |
| 11 | DHT11 `out` (DATA) | Mega `D7` | green |

### D · MQ-2 gas sensor (4 pins: VCC, GND, DOUT, AOUT) — steps 12–14

Leave `DOUT` unconnected — the firmware reads the analog channel.

| # | From | To | Wire |
|---|------|----|------|
| 12 | MQ-2 `VCC` | Breadboard `+` rail | red |
| 13 | MQ-2 `GND` | Breadboard `−` rail | black |
| 14 | MQ-2 `AOUT` | Mega `A0` | yellow |

### E · FAN indicator LED (red) + 220 Ω — steps 15–17

Place the LED with the **long leg (anode) on the left** in cols
15–16. Place the 220 Ω resistor between col 17 and a free row.

| # | From | To | Wire |
|---|------|----|------|
| 15 | LED FAN cathode (short leg) | Breadboard `−` rail | black |
| 16 | LED FAN anode (long leg) | One end of 220 Ω resistor | (legs touching on the breadboard, no jumper needed) |
| 17 | Other end of 220 Ω | Mega `D6` | green |

### F · HUM indicator LED (blue) + 220 Ω — steps 18–20

Same pattern, two columns over.

| # | From | To | Wire |
|---|------|----|------|
| 18 | LED HUM cathode | Breadboard `−` rail | black |
| 19 | LED HUM anode | One end of 220 Ω resistor | (touching) |
| 20 | Other end of 220 Ω | Mega `D5` | green |

### G · Active piezo buzzer — steps 21–22

The buzzer's `+` is the longer leg (or marked with a `+` symbol on
top).

| # | From | To | Wire |
|---|------|----|------|
| 21 | Buzzer `+` | Mega `D9` | purple |
| 22 | Buzzer `−` | Breadboard `−` rail | black |

### H · Servo SG90 — steps 23–26

**Critical:** the servo is powered from the **external 5 V supply**,
not the Mega. You only share the *signal* with the Mega; the power
and ground come from the phone-charger PSU.

| # | From | To | Wire |
|---|------|----|------|
| 23 | Servo brown (GND) | External 5 V PSU `−` | black |
| 24 | Servo red (VCC) | External 5 V PSU `+` | red |
| 25 | Servo orange/yellow (signal) | Mega `D10` | orange |
| 26 | External 5 V PSU `−` | Breadboard `−` rail | black (this ties the two grounds together — without it the servo will twitch) |

### I · Bring-up — steps 27–32

| # | Action |
|---|--------|
| 27 | Double-check **all** GND lines reach the same `−` rail. |
| 28 | Confirm no wire goes from the Mega `5V` pin to the servo. |
| 29 | Plug the external 5 V supply into the wall. The servo should snap to 0° (closed position). |
| 30 | Plug the Mega's USB into the PC. Green PWR LED on the Mega lights up. |
| 31 | LCD shows `Room Manager` on row 0, `v1.4.2-mega` on row 1, then switches to `T:.. H:.. G:..` after ~2 s. |
| 32 | If the LCD backlight is on but text is missing, turn the small blue trim-pot on the I²C backpack until the characters appear. If the screen is completely dead, your backpack is at `0x3F` — flip `LCD_ADDR` in `sketch.ino` and re-flash. |

### J · Smoke test — steps 33–36

| # | Action | Expected |
|---|--------|----------|
| 33 | Breathe on the DHT11 for 5 s. | Humidity rises past 60 → red FAN LED on, servo rotates to 90° (open). |
| 34 | Stop breathing, wait. | Humidity falls below 55 → FAN LED off, servo back to 0°. |
| 35 | With sensor in dry room (or no breath), wait. | If RH < 40, blue HUM LED on. |
| 36 | Hold a lit match ~30 cm from the MQ-2. | Buzzer pulses at ~1 Hz, FAN LED forced on, servo opens. Reading on row 0 climbs past 300 ppm. |

If any step misbehaves, open the serial monitor at 9600 baud — the
firmware emits a JSON line every 2 s with all four state booleans
plus the raw readings.

---

## 5. Why the Servo Needs Its Own 5 V

An SG90 draws ~ 100 mA at idle and can spike to **600–800 mA** during
movement or stall. The Mega's onboard 5 V regulator is rated for about
500 mA total and is already shared by the LCD, DHT11 and MQ-2.
Powering the servo from the Mega will brown-out the rail, reset the
MCU mid-loop, and produce intermittent LCD corruption.

The fix is a small dedicated 5 V supply (a phone charger via a USB
breakout works fine). Wire its + to the servo red, its − to the servo
brown, and tie that − to the Mega GND so the PWM signal has a common
reference. Do **not** connect its + to the Mega's 5 V pin.

---

## 6. MQ-2 Calibration

The simulator's potentiometer maps cleanly onto 0–1000 ppm. A real
MQ-2 does not — its response is logarithmic in `Rs/R0`, and `R0` has
to be measured per-sensor in clean air after the 24 h burn-in.

Quick procedure for a rough calibration:

1. Run the sensor in clean indoor air for at least 24 hours.
2. Read the raw ADC value over Serial — that's your `clean_air_raw`.
3. Treat that level as ~ 0 ppm of LPG/CH₄.
4. Pick the alarm threshold experimentally: a lit match held 30 cm
   away should push the value well past it. Adjust `GAS_DANGER_PPM`
   and `GAS_DANGER_OFF_PPM` until the alarm latches on the match and
   releases when the smoke clears.

For a publishable calibration, follow the datasheet's `Rs/R0` curves
and use a logarithmic conversion in `readGas()`. This is out of scope
for the current firmware.

---

## 7. Pull-Up & Decoupling Notes

- **DHT11 pull-up:** 4.7–10 kΩ between DATA and VCC. The 4-pin DHT11
  *modules* already include this; the bare 3-pin sensors do not.
- **LCD I²C pull-ups:** the PCF8574 backpack ships with 4.7 kΩ
  pull-ups on SDA/SCL — do not add more.
- **Power decoupling:** put a 100 nF ceramic capacitor across the 5 V
  rail close to the LCD, and a 470 µF electrolytic close to the
  servo's external 5 V supply. Both are insurance against the
  brown-outs that ruin a long demo.

---

## 8. Mechanical: The Window Vent

The servo opens a hinged window flap rather than the building window
itself. A simple build:

1. Cut a rectangular hole in the enclosure wall.
2. Hinge a piece of acrylic or thin MDF along the top edge.
3. Glue the servo horn (or a short push-rod) to the inside face of
   the flap, with the servo body screwed to the enclosure.
4. Set `WINDOW_CLOSED_DEG` and `WINDOW_OPEN_DEG` in `sketch.ino` to
   match your geometry. Most builds use 0° / 90°, but adjust if the
   horn's neutral position points the wrong way.

The Wokwi simulation visualises this as a rotating arm — there is
no actual flap in the simulator, so all you see is the angle change.

---

## 9. LCD Layout

The 16×2 panel shows two fixed rows. The firmware overwrites each
cell instead of calling `lcd.clear()` per render so the screen does
not flicker on every 2 s sample.

```
  col:  0123456789012345
  row 0: T:24 H:60 G:300
  row 1: F:0 H:0 A:0 W:0
```

- `T` — temperature in °C (DHT11 returns integers, so no decimals)
- `H` — relative humidity in %
- `G` — gas reading in ppm (0–1000)
- `F` — fan LED state (0/1)
- `H` — humidifier LED state (0/1)
- `A` — alarm latch (0/1)
- `W` — window servo state (0 closed, 1 open)
- A trailing `*` on row 1 means the last DHT read failed and the
  displayed temperature/humidity are the previous good values.

---

## 10. Differences from the Wokwi Simulation

| Wokwi part | Real-world part |
|---|---|
| `wokwi-potentiometer` on A0 | MQ-2 module's AOUT (with calibration) |
| `wokwi-led` × 2 (FAN, HUM) | 5 mm LEDs through 220 Ω resistors |
| `wokwi-buzzer` | Active piezo, same wiring |
| `wokwi-servo` | SG90 with **separate** 5 V supply |
| `wokwi-dht22` | DHT11 4-pin module — both speak the same single-wire protocol; the firmware uses `DHT11` driver type |
| `wokwi-lcd1602` (I²C mode) | 16x2 LCD with PCF8574 I²C backpack at 0x27 |
| `wokwi-arduino-mega` | Real Mega 2560 |

The firmware itself is identical between simulator and bench — no
`#ifdef WOKWI` shims. Anything that runs on the simulator runs on
the bench, given the wiring above.
