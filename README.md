# Stab Lab

Stab Lab generates **kits of synth stabs** for electronic music. You pick a
character (analogue to digital), a key and a tempo. It builds 4–16 related
stabs with subtle tone and timbre variation, different chords, and different
reverb/delay tails. You can audition them, chop the tails, and export WAVs:
the full mix, or dry and tail stems you can chop or let ring out.

## Run it

```bash
npm install
npm run dev        # builds and serves http://localhost:5173
npm test           # DSP, music and engine tests
npm run build      # dist/index.html: one self-contained file, works offline
npm run render -- --all --out out/   # render a kit per preset from the CLI
```

`dist/index.html` runs straight from disk, so you can open it without the
dev server.

## What's inside

| Stage | Details |
|---|---|
| Oscillators (3 layers + sub + click) | PolyBLEP saw, pulse/PWM, triangle, sine, supersaw (1–9 voices, stereo), 2-op FM with decaying index, CZ-style phase distortion and resonance, additive drawbar organ with percussion. Analogue pitch drift and pitch envelope. |
| Envelopes | Curved ADSR for amp and filter. Note length is set in beats, with optional strum. |
| Envelope followers | Each voice's own loudness drives filter cutoff. A follower on the dry stab ducks the reverb/delay tails. A sidechain from an internal kick pump or an uploaded audio file ducks the stab and/or moves the cutoff. |
| Filters (two slots, serial or parallel) | ZDF ladder, diode (acid), Cytomic SVF LP/HP/BP/notch at 12/24 dB, formant (vowel morph), positive/negative comb. Each has drive, key tracking, velocity and envelope amount. |
| Colour | Tape, tube, wavefolder, hard clip and bitcrush saturation; transient shaper; Juno-style chorus or ensemble; output EQ and width. |
| Space | Tempo-synced stereo, ping-pong and tape delay, with filtering and saturation in the feedback loop. Room, chamber, plate, hall, shimmer and spring reverbs, with pre-delay, damping and a tail high-pass. |
| Chords | 40 chord types from triads to clusters, polychords and "petrushka". Voicings, inversions and doublings. Clickable keyboard for any custom chord. Random chords and mutation, both steered by a Dissonance control. Modes: fixed chord, diatonic progression, random, or mutate chain. |
| Kit variation | Seeded and reproducible. Variation amount, family spread (borrows parts of neighbouring presets) and tail spread (dry to huge across the pads). Per-pad re-roll, mutate and hold. Locks per group. |
| Export | Tail length until silent, snapped to the beat, or fixed bars. Normalise per kit or per stab. 16/24/32-bit WAV at 44.1 or 48 kHz. ZIP with mix and/or dry and tail stems, plus `kit.json`. Drag a pad into a DAW (Chrome/Edge). |

## Layout

```
src/dsp/      oscillators, envelopes, filters, colour, delay, reverb, render (pure JS, no Web Audio)
src/music/    theory (scales, chord vocabulary, naming) and chords (voicing, random, mutate)
src/engine/   patch model + schema + macros, presets, kit variation, export (WAV/ZIP)
src/ui/       the web app
src/worker.js renders stabs off the main thread
```

The DSP renders offline, sample by sample, in plain JavaScript with no
platform APIs. That makes it straightforward to port line for line to C++
(JUCE plugin) or Swift (iOS/AUv3) later. `src/engine/patch.js` `SCHEMA`
doubles as the parameter list for a plugin.
