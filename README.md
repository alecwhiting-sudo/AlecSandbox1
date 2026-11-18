# Stab Lab by Divurj

Stab Lab generates **kits of synth stabs** for electronic music. It's made by
[Divurj](https://www.divurj.com) (www.divurj.com), alongside [RatMode](https://www.divurj.com/ratmode),
SampleArk and [Visualz](https://visualz-zeta.vercel.app/). It borrows RatMode's
look: flat greys, one acid-orange accent, and recessed knobs drawn like
RatMode's own knob painter (`Source/UI/UIConstants.h` in the RatMode repo).

**Labs marks.** Stab Lab has its own logo, part of a family for future Labs
(Kick Lab, Hat Lab, Snare Lab…). It uses RatMode's circuit-trace style (orange
traces and solder pads on a dark grid) inside a hexagon frame, where RatMode
uses a diamond. Only the glyph inside changes per Lab. Glyphs are defined in
`src/ui/labmark.js`; `node scripts/export-marks.mjs` writes them all to
`brand/*-lab.svg`. To add a Lab, add one entry to `LAB_GLYPHS`.

You pick a character (analogue to digital), a key and a tempo. It builds 4–16
related stabs with subtle tone and timbre variation, different chords, and
different reverb/delay tails. You can audition them, chop the tails, and
export WAVs: the full mix, or dry and tail stems you can chop or let ring out.

## Use it

Live at **https://alecwhiting-sudo.github.io/AlecSandbox1/**, deployed automatically from `main`
by `.github/workflows/pages.yml`.

## Run it locally

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
| Space | Tempo-synced stereo, ping-pong and tape delay, with filtering and saturation in the feedback loop. Tape mode models a worn tape echo, scaled by Grit: biased tanh record saturation, a 110 Hz head bump, darkening gap loss, signal-riding hiss, wow, random wander, flutter, scrape flutter and dropouts. It is gain-normalised so high feedback never runs away. Room, chamber, plate, hall, shimmer and spring reverbs, with pre-delay, damping and a tail high-pass. |
| Chords | 40 chord types from triads to clusters, polychords and "petrushka". Voicings, inversions and doublings. Clickable keyboard for any custom chord. Random chords and mutation, both steered by a Dissonance control. Modes: fixed chord, diatonic progression, random, or mutate chain. |
| Compression | On the Dynamics strip with the limiter. A stereo-linked soft-knee compressor with Amount, Attack and Release on the strip; Ratio and the parallel Mix are in Sound design. **Stab** mode squeezes the hit before it feeds the delay and reverb. **Glue** mode squeezes the stab and its tails together so they pump around the hit, applying one gain to both stems so dry + tail still equal the mix. Light Stab compression is on by default (Amount 0.3). |
| Limiter | A look-ahead peak limiter on the stab plus its tails, on by default. Drive (0–18 dB) makes the stab louder and denser while the peak stays put. It applies one gain to both stems. The waveform panel shows how much it limited. |
| Wave | A quick strip for Osc 1: Saw, Square, Triangle, or Blend, which morphs triangle › saw › square on one slider. Blend is also available on every oscillator in Sound design. |
| Texture | Vinyl-style crackle (density and tone, with occasional deeper pops) and tape hiss, laid on the dry stem at a level relative to the stab. It can follow the sound so it swells and fades with the stab and its tail. Air noise adds breath inside the voice, shaped by the filter and amp envelope. |
| Playback | Click a pad or press 1–8 / Q–I. Space replays the selected pad; Shift+Space plays every pad in turn, each 150 ms after the previous one ends (again or Esc stops). Trigger and Play all buttons sit at the top of Sound design. |
| Reverse | "Reverse" in the waveform panel flips the selected pad, so the tail swells into the hit. It applies to playback, exports, drag-out and the linked folder; reversed files end in `_rev`. Chops still apply, so you can shorten the swell. |
| Key changes | Modulates the kit as it goes across the pads, a new key every 1, 2, 4 or 8 pads. Options: up a semitone (lift), up a whole tone, circle of fifths or fourths, down a minor third (dub), up a minor third (house), chromatic mediants, up a fourth and home again, or random nice changes. Pads show their key; keys stay within a fifth of the home key so the register doesn't drift. |
| Octave | Octave moves the whole kit by −2..+2 octaves. Octave spread puts each pad up to ±1 or ±2 octaves away, seeded, within C1..C7. Register (in the chord builder) sets where the built chord sits. |
| Copy notes | Drop any stab (WAV, AIFF, MP3…) on the page, or use "Copy notes from audio…", and its approximate notes become the chord. It uses harmonic-salience note detection. On our own presets it gets every note exactly right about 80% of the time, and is usually one tension note off otherwise. Bells and heavily filtered sounds are rougher. |
| Stereo | Every render is stereo. A Width macro runs from mono to extra wide, and a quick delay strip offers ping-pong, stereo or tape delay (or off), with time, amount and feedback. |
| Ableton folder | "Link Ableton folder" (Chrome/Edge) writes the current kit as WAVs into a folder and keeps it updated. Add that folder to Live's browser under Places and drag the stabs in from there. The pad ⬇ button saves keepers to a separate folder. |
| Kit variation | Seeded and reproducible. Knob variation (the Vary row under the macros, default 0.3) gives each pad its own small random nudge on every macro knob; hover a pad to see its offsets. Variation amount, family spread (borrows parts of neighbouring presets) and tail spread (dry to huge across the pads). Delay time spread gives each pad its own tempo-synced delay time (1/16 to 1/2, following the BPM), and sometimes a different right-hand time in stereo mode. Per-pad re-roll, mutate and hold. Locks per group. |
| Export | Tail length until silent, snapped to the beat, or fixed bars. Normalise per kit or per stab. 16/24/32-bit WAV at 44.1 or 48 kHz. WAV files only: the mix and/or dry and tail stems. Chrome/Edge write them into a folder you choose (with `kit.json`); other browsers download them one by one. Drag a pad into a DAW (Chrome/Edge). The claude.ai artifact preview cannot save WAVs, so use `dist/index.html` to export. |

## Layout

```
src/dsp/      oscillators, envelopes, filters, colour, delay, reverb, render (pure JS, no Web Audio)
src/music/    theory (scales, chord vocabulary, naming), chords (voicing, random, mutate), detect (notes from audio)
src/engine/   patch model + schema + macros, presets, kit variation, export (WAV)
src/ui/       the web app
src/worker.js renders stabs off the main thread
```

The DSP renders offline, sample by sample, in plain JavaScript with no
platform APIs. That makes it straightforward to port line for line to C++
(JUCE plugin) or Swift (iOS/AUv3) later. `src/engine/patch.js` `SCHEMA`
doubles as the parameter list for a plugin.
