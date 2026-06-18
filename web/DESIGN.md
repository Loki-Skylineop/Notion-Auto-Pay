# Notion Auto Pay — Redesign plan (MotherDuck-inspired light theme)

Branch: `redesign/motherduck-light`

This redesign moves the dashboard from the previous pure-black "Vercel" theme
to a warm, friendly **light** system inspired by the MotherDuck brand. The
goal is a calm, minimalist surface with crisp typography and gentle, hand-drawn
feeling line icons.

## 1. Design tokens

| Token | Old (dark) | New (light) | Role |
| --- | --- | --- | --- |
| `bg-primary` | `#000000` | `#f4efea` | Page canvas (Bunny Hop cream) |
| `bg-secondary` | `#111111` | `#ece4db` | Inset surface |
| `bg-card` | `#0a0a0a` | `#fbf9f6` | Cards / dialogs |
| `bg-card-hover` | `#161616` | `#f2ebe3` | Card hover |
| `bg-exhausted` | `#1a0f0f` | `#f7e6dd` | Low-credit / warning tint |
| `bg-input` | `#111111` | `#ffffff` | Inputs |
| `text-primary` | `#ededed` | `#383838` | Graphite ink |
| `text-secondary` | `#b0b0b0` | `#5d564e` | Body |
| `text-muted` | `#7a7a7a` | `#8c8278` | Muted |
| `notion-blue` | `#3291ff` | `#1f7fc2` | Readable link/accent on cream |
| `border` | `#242424` | `#ded4c8` | Warm hairline |
| `hairline-strong` | `#3a3a3a` | `#383838` | Signature charcoal edge |

Accent fill color (buttons, highlights): **`#97d4ff`** with a charcoal
`#383838` edge — the MotherDuck button signature.

Brand secondary colors available for accents: Chat Orange `#f9953e`,
November Leaf `#f0b490`, Bunny Hop `#f4ecea`.

## 2. Typography

- **Body**: Inter (Google Fonts), light/regular weights.
- **Headings (h1–h4)**: Aeonik Mono (loaded from MotherDuck CDN, falls back to
  JetBrains Mono / system mono), regular weight, slight positive tracking.
- Monospace token now resolves to Aeonik Mono first.

## 3. Shape & elevation

- Shadows are essentially removed (`shadows: none` in the brand spec).
- Depth is expressed with **1px hairline rings** and, for modals only, a single
  very soft drop.
- Buttons: 2px radius, 2px solid `#383838` border, no shadow.
- Cards: 8px radius, 1px hairline border, 16px padding.
- Spacing scale: xs 8 / sm 16 / md 24 / lg 40 / xl 70.

## 4. Iconography

The existing icon set is already thin-stroke (1.5px), rounded, `currentColor`
Feather-style — kept as-is because it matches the minimalist MotherDuck feel.
Added brand-flavored marks in the same language:

- `IconWave` — the signature double water ripple.
- `IconSpark` — a soft four-point sparkle / star.
- `IconWallet` — rounded wallet for payment surfaces.
- `IconBolt` — quick "auto" action mark.

All icons share the same `baseProps` (24×24 viewBox, stroke 1.5, round caps),
so they inherit theme color automatically.

## 5. Implementation steps

1. `web/src/index.css` — rewrite `@theme` tokens, font loading, mesh/elevation
   helpers for the light system. (done)
2. `web/src/components/Icons.tsx` — add brand line icons. (done)
3. Components consume tokens via Tailwind utilities (`bg-bg-card`,
   `text-text-primary`, `border-border`, ...), so the palette flip cascades
   automatically with no per-component edits required.

## 6. How to preview

```
git fetch origin
git checkout redesign/motherduck-light
cd web && npm install && npm run dev
```

Or build the bundled dashboard via `build.bat` after checking out the branch.
