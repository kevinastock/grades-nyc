# NYC Grades — avatar design study

Five approved SVG avatars, imported directly by `src/components/shared.ts` for restaurant list/detail avatars and normal/selected map pins. The review sheets and placement notes remain design documentation; only the five avatar files are included in the application.

Open `review.png` for large previews and actual 28/40/52px samples on Oat light/dark card surfaces, plus 40px examples on OpenStreetMap tiles. `review.svg` is the scalable version. Map positions are illustrative, not restaurant records.

| File | Meaning | Letter color | Field |
| --- | --- | --- | --- |
| `grade-a.svg` | Grade A | `#155E9B` | `#F2F5F7` |
| `grade-b.svg` | Grade B | `#237D43` | `#F2F5EE` |
| `grade-c.svg` | Grade C | `#AB5914` | `#FCF4E7` |
| `grade-pending.svg` | Grade pending; source P or Z | `#393431` | `#F3F1ED` |
| `grade-ungraded.svg` | No recorded grade; source null | `#684087` | `#F5F0F7` |

NG means **no recorded grade**, without asserting that a restaurant has never been inspected. The initials keep the multiword states readable at avatar sizes.

## Placement

A, B, and C retain their original letter placement relative to the center of each official artwork's canvas. A single uniform scale of 0.15 is applied to all three source compositions, and each source canvas center maps to `(50, 50)` in the new avatar. This preserves the original differences in size and positioning, including C's leftward placement, instead of independently fitting or recentering each letter.

GP and NG use one common scale of 0.48, with a shared cap line at 30.0704 and baseline at 69.9296 in the 100×100 avatar. Round and diagonal overshoots remain intact.

- GP uses G and P from the official Grade Pending artwork. P's source line is shifted by exactly 108 source units to share G's baseline. The gap follows the source G-to-R spacing, matching the straight left stem of P.
- NG is the intact adjacent NG pair at the end of the official PENDING lettering. Its original spacing, relative size, and shared baseline are preserved.

`placement.json` records these source anchors, scales, and guides. The previous centroid-based recentering utility and measurements have been removed. No automatic optical-centering heuristic is applied to this revision.

## Asset properties

Each file has a 100×100 viewBox, transparent corners, outlined letters, and accessible title/description metadata. The only visible artwork is the circular field and lettering: there are no city seal, wreath, crest, watermark, font, raster, script, filter, or external-resource dependencies in the five SVGs.

All five were rendered and visually reviewed at 28, 40, and 52px. Letter-to-field contrast is at least 4.5:1. The map proof adds a separate white marker halo, which is not part of the assets.

For future integration, give each HTML image an appropriate `alt`, or an empty alt if adjacent text already announces the same state. If inlining an SVG repeatedly, make its title and description IDs unique per instance.

## Sources

Official lettering and source composition:

- [Grade A](https://a816-health.nyc.gov/ABCEatsRestaurants/Content/images/NYCRestaurant_A.svg)
- [Grade B](https://a816-health.nyc.gov/ABCEatsRestaurants/Content/images/NYCRestaurant_B.svg)
- [Grade C](https://a816-health.nyc.gov/ABCEatsRestaurants/Content/images/NYCRestaurant_C.svg)
- [Grade Pending](https://a816-health.nyc.gov/ABCEatsRestaurants/Content/images/NYCRestaurant_GP.svg)
- [Not Yet Graded](https://a816-health.nyc.gov/ABCEatsRestaurants/Content/images/NYCRestaurant_NG.svg) — purple palette reference.

Map proof only: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). Tiles are embedded in the review SVG for offline viewing. These are independent adaptations for the unofficial NYC Grades project.
