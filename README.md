# Zoomable Number Line

An infinitely zoomable number line rendered on `<canvas>`. Drag the line to
zoom toward the pointer and watch the tick labels keep producing **exact**
decimals long after IEEE-754 floats would have dissolved into noise.

Built on a small arbitrary-precision decimal type (`Num`) rather than
`Number`, so the window bounds stay meaningful at 40+ significant digits.

## Demo

Open `index.html` directly in a browser — no build step, no dependencies.

```
open index.html
```

## Controls

| Input | Action |
| --- | --- |
| Click / drag on the line | Zoom toward the pointer (continues while held) |
| Drag near the left/right edge | Pan continuously |
| `Shift` + hold | Reverse the zoom direction |
| Mouse wheel | Zoom in / out (proportional to scroll) |
| Double click | Zoom in fast |
| `↑` / `↓`, `W` / `S`, `+` / `-` | Zoom in / out |
| `←` / `→`, `A` / `D` | Pan |
| `R` | Reset to −1 … 11 |
| Toolbar buttons | Zoom in, zoom out, reset |

## Features

- **Exact deep zoom.** Tick positions and labels are computed with arbitrary
  precision, so zooming to 5.0000000000000000001 is stable instead of drifting.
- **Nice-number ticks.** Steps are always from the 1 / 2 / 5 × 10ᵏ family, so
  labels read `0.5, 1, 1.5 …` rather than `0.3333333`.
- **HiDPI aware.** The backing store follows `devicePixelRatio` (capped at 3×)
  and re-syncs on resize, so the line stays crisp without wasting pixels.
- **Signed colouring.** Negative spans render red, positive blue, split at zero
  with a softening gradient.
- **Value markers.** Arbitrary points can be pinned with a label (π by default).
- **Framerate safe.** Zoom is geometric, so N queued steps collapse into one
  `pow()` and one redraw; the pending queue is clamped so a fast flick cannot
  run away after input stops.
- **Responsive.** Touch drag, edge auto-pan, and a compact toolbar on small
  screens.

## Usage

```html
<canvas id="numberline"></canvas>
<script src="ZoomableNumberline.js"></script>
<script>
  const line = numberzoomMain("#numberline", {
    onChange(state) {
      // state.zoomLevel  - signed zoom steps
      // state.zoomInQ    - pending zoom direction
      // state.range      - "start … end" label
      console.log(state.range);
    },
  });

  line.zoomBy(24);        // positive zooms in
  line.setZoomIn(false);  // flip the default direction
  line.reset();
</script>
```

`numberzoomMain(canvasOrSelector, options)` returns a `Numberline`. Calling it
again for the same canvas returns the existing instance. The canvas sizes
itself from its CSS box, so set `width` / `height` in CSS.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `zoomStep` | `1.02` | Magnification per zoom step |
| `edge` | `60` | Edge-pan activation distance, in px |
| `edgeSpeed` | `0.0006` | Edge-pan rate |
| `maxDigits` | `40` | Precision retained while zooming |
| `maxTicks` | `400` | Hard cap on ticks drawn per frame |
| `onChange` | — | Called with `{ zoomLevel, zoomInQ, range }` |

### API

| Member | Description |
| --- | --- |
| `zoomBy(steps)` | Queue zoom steps; positive zooms in |
| `setZoomIn(on)` / `toggleZoomIn()` | Set the default zoom direction |
| `reset()` | Return to the initial window |
| `resize()` | Re-read the CSS box and DPR |
| `getRangeLabel()` | Current window as a string |
| `destroy()` | Stop the animation loop |

## Notes on the numerics

`Num` stores a sign, an unsigned digit string, and a decimal exponent. That
keeps labels exact at depths where a double has no significant bits left.
Two details matter for correctness:

- **Conversion to `Number`** happens in a single `Number(mantissa + "e" + exp)`
  call. Extracting a fixed 17-digit window and then scaling by a power of ten
  rounds twice and can land one ULP off.
- **Digit trimming** only ever discards least-significant digits. It does not
  renormalise trailing zeros, because doing so changes the value.

## License

MIT — see [LICENSE](LICENSE). Originally a prototype by
[pratikh](https://github.com/pratikh/numberline-zooming).
