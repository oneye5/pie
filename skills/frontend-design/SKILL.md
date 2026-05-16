---
name: frontend-design
description: 'Distinctive, production-grade frontend interfaces that reject generic AI aesthetics. Use when building UI components, pages, or applications — especially when visual quality, creative direction, or aesthetic differentiation matters. Do not use for backend logic, API design, or non-visual code.'
---

# Frontend Design

Create distinctive, production-grade frontend interfaces that avoid generic AI-generated patterns and execute bold creative vision with precise implementation.

## When to Use

- Designing interfaces where visual quality and creative direction are primary success criteria
- Building UI components, pages, or applications that must stand out from typical AI-generated outputs
- Projects where aesthetic differentiation, brand identity, or memorable user experience are explicit requirements
- Refactoring existing frontend code to improve visual polish, typography, color, motion, or spatial composition
- Selecting intentional aesthetic directions (e.g., brutalist, maximalist, retro-futuristic, luxury) rather than default patterns

**Do not use for:**
- Backend logic, API design, database schemas, or non-visual code
- Purely functional components without visual differentiation requirements
- Simple UI modifications that don't require distinctive aesthetic choices
- Accessibility audits or performance optimization as standalone tasks (only include when integrated with aesthetic execution)

## Required Artifacts

- `mockup-description.md` (required): Must contain tone name, typography plan (display/body fonts with sizes/weights), color palette (dominant/accent/background), motion philosophy, spatial composition plan, and key visual details. Must be written before implementation.
- Component implementation files (required): Production-ready code files (`.jsx`, `.tsx`, `.vue`, `.html`, `.css`) implementing the described aesthetic with:
  - One fully realized primary component
  - CSS variables for theme consistency
  - Responsive layout considerations
  - Semantic HTML structure with basic accessibility features
- `final-screenshot.png` (optional): Visual reference if available; otherwise omitted

**Output contract:** All artifacts must collectively demonstrate a cohesive, intentionally differentiated design free from generic AI aesthetics. Code must be deployable without placeholder content.

## Core Rules / Constraints

1. **Reject Generic AI Aesthetics** – No default fonts (Inter, Roboto), purple-on-white gradients, or cookie-cutter component patterns.
2. **Extreme Commitment** – Commit to one distinct direction (e.g., brutalist maximalism, retro-futuristic minimalism) and execute it with precision.
3. **Non-Negotiable Typography** – Pair a distinctive display font with a refined body font.
4. **Intentional Color** – Use a dominant color plus 1-2 sharp accents; avoid neutral-only palettes.
5. **Strategic Motion** – Maximum 2 high-impact animations per component; prioritize CSS-only solutions.
6. **Break Spatial Patterns** – Incorporate asymmetry, diagonal flow, or grid-breaking elements.
7. **Atmospheric Backgrounds** – Include at least one contextual effect (noise, grains, patterns, or complex gradients).
8. **Vision-Matched Complexity** – Implementation effort must scale with the aesthetic (e.g., maximalism requires elaborate code).
9. **Diversify Aesthetics** – Vary fonts and palettes across different projects to avoid a "signature style."
10. **Document First** – All decisions must be recorded in `mockup-description.md` before implementation begins.

## Workflow Phases

### 1. Context & Problem Definition
- Read user requirements and identify core user needs
- Review technical constraints (framework, performance, accessibility)
- Note any brand guidelines or existing design constraints

### 2. Aesthetic Direction Commitment
- Select one extreme aesthetic direction (e.g., "editorial maximalism" or "brutalist minimalism")
- Define the single most memorable aspect (e.g., "dramatic scroll-triggered reveal")
- Write full mockup-description.md entry with all required elements

### 3. Design Validation
- Verify direction rejects generic AI aesthetics using core rules
- Confirm typography and color choices follow constraints
- Sketch layout with at least one distinctive compositional element

### 4. Production Implementation
- Generate component files with required implementation features
- Apply CSS variables for theme consistency
- Implement motion using strategic animation points
- Maintain semantic HTML structure with basic ARIA

### 5. Visual Detail Iteration
- Add one surprising element (custom cursor, unconventional hover effect, etc.)
- Remove any generic or uninspired visual elements
- Verify all design decisions match the original direction

### 6. Final Quality Gate
- Conduct 3-point verification: fonts, colors, layout against generic AI patterns
- Test responsiveness across viewport sizes
- Update mockup-description.md with implementation refinements

## Anti-Patterns & Red Flags

- **Typography:** Using Inter, Roboto, or system defaults without a distinct display font.
- **Color:** Purple gradients on white, monochromatic grays, or generic pastels.
- **Layout:** Centered hero sections, rounded-card grids, or predictable sidebars.
- **Motion:** Bouncy entrances on every element; over-using JS for simple CSS effects.
- **Visuals:** Solid-color backgrounds, default shadows, or a total lack of texture/depth.
- **Mindset:**
  - *"This font is safe/readable"* $\to$ Safe is generic. Distinctive fonts can also be readable.
  - *"The client wants conventional"* $\to$ Push back with one bold, high-impact element.
  - *"I don't have design skills"* $\to$ Follow the workflow: pick an extreme direction and execute precisely.
  - *"Asymmetry looks broken"* $\to$ Align to a grid, then break it deliberately.

## Verification

Before delivery, confirm all items are satisfied:

- [ ] `mockup-description.md` exists with full directional details written before implementation
- [ ] Component files are production-ready with no placeholder content
- [ ] No generic AI aesthetics present in fonts, colors, layout, or motion
- [ ] At least one distinctive visual element is present (custom cursor, unconventional layout, etc.)
- [ ] CSS variables are used consistently across all components
- [ ] Responsiveness validated across 3 viewport sizes
- [ ] Basic accessibility covered (semantic HTML, ARIA where needed)
- [ ] Verification checklist run against final output

Do not deliver if any item is missing. Generic work constitutes failure.