---
name: Anime Editorial
colors:
  surface: '#fff8f7'
  surface-dim: '#ecd5d2'
  surface-bright: '#fff8f7'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#fff0ee'
  surface-container: '#ffe9e6'
  surface-container-high: '#fbe3e0'
  surface-container-highest: '#f5ddda'
  on-surface: '#251817'
  on-surface-variant: '#58413e'
  inverse-surface: '#3b2d2b'
  inverse-on-surface: '#ffedea'
  outline: '#8c716d'
  outline-variant: '#e0bfbb'
  surface-tint: '#ad312b'
  primary: '#a92f29'
  on-primary: '#ffffff'
  primary-container: '#cb473e'
  on-primary-container: '#fffbff'
  inverse-primary: '#ffb4ab'
  secondary: '#5d5e61'
  on-secondary: '#ffffff'
  secondary-container: '#e2e2e5'
  on-secondary-container: '#636467'
  tertiary: '#00685b'
  on-tertiary: '#ffffff'
  tertiary-container: '#008374'
  on-tertiary-container: '#f4fffb'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#ffdad6'
  primary-fixed-dim: '#ffb4ab'
  on-primary-fixed: '#410002'
  on-primary-fixed-variant: '#8b1816'
  secondary-fixed: '#e2e2e5'
  secondary-fixed-dim: '#c6c6c9'
  on-secondary-fixed: '#1a1c1e'
  on-secondary-fixed-variant: '#454749'
  tertiary-fixed: '#82f6e1'
  tertiary-fixed-dim: '#64dac5'
  on-tertiary-fixed: '#00201b'
  on-tertiary-fixed-variant: '#005046'
  background: '#fff8f7'
  on-background: '#251817'
  surface-variant: '#f5ddda'
typography:
  display:
    fontFamily: Inter
    fontSize: 48px
    fontWeight: '800'
    lineHeight: '1.1'
    letterSpacing: 0
  headline-lg:
    fontFamily: Inter
    fontSize: 30px
    fontWeight: '700'
    lineHeight: 36px
    letterSpacing: 0
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
  headline-md:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0
  label-sm:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
rounded:
  sm: 0.125rem
  DEFAULT: 0.375rem
  md: 0.5rem
  lg: 0.5rem
  xl: 0.5rem
  full: 9999px
spacing:
  page-margin: 24px
  gutter: 16px
  section-gap: 48px
  stack-sm: 4px
  stack-md: 8px
  stack-lg: 16px
---

## Brand & Style
The design system is built on an "Anime Editorial" narrative, blending the high-density information of a manga layout with the professional structure of a premium digital publication. The aesthetic is rooted in **Minimalism** and **Modern Corporate** styles, favoring functional density and structural integrity over decorative flair.

The UI should evoke a sense of curated authority. It treats anime data as high-end editorial content, using sharp lines, intentional whitespace, and a monochromatic foundation punctuated by vibrant, meaningful color. Small radii keep the interface precise while preserving enough softness for repeated desktop workflows.

## Colors
The palette is inspired by the printing process. **Paper White** serves as the canvas, providing a warm, non-clinical background. **Ink Black** is used for all primary text and structural borders to ensure maximum legibility and a classic editorial feel.

**Coral Red** is the primary action color, used sparingly for emphasis and high-priority interactions. The supporting semantic colors—**Cyan Blue**, **Amber Yellow**, and **Emerald Green**—are calibrated for visibility against the light background while maintaining a professional, slightly desaturated tone that doesn't distract from the artwork (posters and stills).

## Typography
This design system utilizes **Inter** as the sole typeface to maintain a systematic, utilitarian aesthetic. The hierarchy is driven by weight and capitalization rather than excessive scale changes.

- **Headlines:** Use Bold or ExtraBold weights with zero letter-spacing to keep dense headings stable across platforms.
- **Labels:** Small caps or uppercase labels are used for metadata (e.g., Studio, Season, Status) to create a distinct visual texture compared to body copy.
- **Body:** Standardized at 14px for high-density information tracking, ensuring that large lists and grids remain legible without excessive scrolling.

## Layout & Spacing
The layout follows a **Fixed-Fluid Hybrid** grid. Global page margins are set to 24px. The system relies on a 12-column grid for desktop views, transitioning to a single-column stack on mobile.

Layout components should use 1px solid borders (`#101214` at 10% opacity) to define zones, much like manga panels. Spacing is tight and rhythmic, prioritizing information density. Use 8px increments for vertical stacking and 16px for horizontal gutters between content cards.

## Elevation & Depth
This design system avoids traditional shadows to maintain its "ink on paper" aesthetic. Depth is expressed through:

- **1px Outlines:** The primary method for separating elements. All containers use a subtle border instead of a shadow.
- **Tonal Layering:** Floating elements (like dropdowns or modals) use a slightly elevated white surface with a very crisp, small-radius shadow (2px blur) just to distinguish the overlap.
- **Muted Overlays:** When a modal is active, the background is dimmed with a 40% Ink Black tint to maintain focus.

## Shapes
The shape language is disciplined and geometric.
- **Buttons and Inputs:** Use a 6px radius to feel precise and technical.
- **Media Containers:** Anime posters and thumbnails use an 8px radius to soften imagery without becoming decorative.
- **Selection States:** Active tabs or selected list items use 0px or 6px according to their container hierarchy.

## Components
- **Buttons:** High-contrast 6px blocks. Primary buttons use Coral Red with white text. Ghost buttons use a 1px Ink Black border.
- **Anime Cards:** Standardized 2:3 poster ratio with 8px corners. Title and metadata sit directly below the image without a decorative outer card.
- **Status Chips:** Small rectangular badges with 2px corners. Use semantic background colors at low opacity with readable text.
- **Input Fields:** 1px border with a 6px radius. On focus, the border shifts to Ink Black with a 2px ring offset.
- **Lists:** High-density rows with 1px bottom borders. Hover states use a subtle semantic muted fill.
- **Navigation:** A sidebar or top bar using Ink Black text and minimal icons. The active state uses a Coral Red left stroke and restrained accent fill.
