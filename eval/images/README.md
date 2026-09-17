# Receipt photos for the eval

This directory holds the photographs the `image` cases in `receipts.eval.json`
point at. **It ships empty on purpose.** A case whose file is missing is reported
as *skipped* and excluded from every metric, so the eval runs green on a fresh
clone — it just has nothing to say about photographs yet.

Photos cannot be invented. A rendered image of receipt text would measure font
rasterization, not what a phone camera actually does to thermal paper, and the
number it produced would be wrong in the flattering direction.

## What to put here

One file per `image` path in the fixture, named exactly as the fixture spells it:

| File | The receipt it should show |
| --- | --- |
| `tasco-spoons.jpg` | A tavern receipt whose only item is cutlery |
| `supermarket-three-way.jpg` | A supermarket run spanning food, cleaning supplies and a pan |
| `pharmacy-medication.jpg` | A pharmacy receipt for prescription medication |
| `hotel.jpg` | A two-night hotel bill |

The receipt in the photo has to be the *same receipt* as the paired text case
(`same_as`), because the comparison only means anything if both sides describe
one purchase. The text of each pair is in `receipts.eval.json`; print it, or
photograph a real receipt and update both the text case and the photo together.

JPEG, PNG, WebP and GIF are accepted, up to 10 MB — the same formats and ceiling
as `POST /api/parse-receipt-image`. The format is read from the file's bytes, not
its extension, so a `.jpg` that is really a PNG still works.

## Photograph them badly

The point is to find where extraction breaks, so shoot the conditions a real
expense claim arrives in — one failure mode per photo rather than all at once,
otherwise a bad score says nothing about which one caused it:

- crumpled or creased across the item lines
- out of focus, or motion-blurred
- shot at an angle, so the lines converge
- lit by one overhead lamp, with glare across the total
- cut short, with the bottom of the till roll out of frame
- faded thermal paper that has been in a wallet for a month

## Running it

```bash
npm run eval                                   # includes the photo cases
npm run eval -- --label photos --out reports/photos.json
```

The `=== Photo vs text ===` section compares each photo against its paired text
case: exact-set-match rate and micro-F1 for both, and the delta between them.
That delta is the price of accepting photographs.

Note that `--limit N` takes the first N cases and the photo cases sit at the end
of the fixture, so a smoke run does not reach them; a pair with only one side run
is excluded from the comparison and listed as incomplete.
