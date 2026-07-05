## Charm design system — how to build with it

Charm is a **dark-first** Matrix client design system. Components are shadcn-style
React primitives (Radix under the hood) styled with **Tailwind v4 utility classes
bound to semantic design tokens**.

### Setup — no provider, dark by default

There is **no theme provider component**. The design tokens live on `:root`/`body`
via the bound `styles.css`, so the canvas is dark out of the box and components
render correctly with no wrapper. Just render them:

```jsx
<Button>Save changes</Button>
```

- **Theme:** dark is the default. For light mode, set `data-theme="light"` on an
  ancestor (e.g. `<html data-theme="light">`); the same token names resolve to
  light values under that selector. Do not hand-pick hex colors — use the token
  utilities below so both themes work.
- **Canvas:** `body` already carries `background-color: var(--color-bg-base)` and
  `font-family: var(--font-sans)`. Put page content on `bg-background text-foreground`.
- **Fonts:** `font-sans` = Manrope, `font-mono` = JetBrains Mono (shipped via
  `styles.css` → `fonts/`). No font setup needed.
- **Tooltips** need a `TooltipProvider` ancestor (wrap once near the root).

### Styling idiom — semantic token utilities, not raw colors

Style your own layout/containers with these token-backed utility families (each
maps to a `--color-*` token, so it is theme-correct). These names are compiled
into the bound `_ds_bundle.css`, so use them verbatim:

| Surface / text | Utilities |
|---|---|
| Page & panels | `bg-background`, `bg-card`, `bg-popover`, `bg-muted` |
| Text | `text-foreground`, `text-muted-foreground`, `text-popover-foreground` |
| Brand / actions | `bg-primary` + `text-primary-foreground`, `bg-secondary` + `text-secondary-foreground` |
| Accent (hover/active rows) | `bg-accent` |
| Danger | `bg-destructive`, `text-destructive` |
| Borders | `border`, `border-input` |

Layout/spacing/typography use ordinary Tailwind utilities (`flex`, `flex-col`,
`gap-2`, `rounded-lg`, `text-sm`, `p-4`, …). Prefer the token utilities above over
literal colors so content sits correctly on the dark (or light) canvas.

### Where the truth lives

- **Styling:** the bound `styles.css` and its `@import`s (`_ds_bundle.css` for
  component styles + the `--color-*` / `--font-*` tokens, `fonts/fonts.css`). Read
  these before choosing colors.
- **Per component:** each `<Name>.d.ts` is the prop contract; each `<Name>.prompt.md`
  shows intended composition and variants.

### One idiomatic example

```jsx
// A settings row on the dark canvas — library components for the controls,
// token utilities for your own layout glue.
<div className="flex flex-col gap-2 bg-background p-4 text-foreground">
  <Label htmlFor="server">Homeserver</Label>
  <Input id="server" placeholder="matrix.org" />
  <div className="flex gap-2">
    <Button variant="ghost">Cancel</Button>
    <Button>Save</Button>
  </div>
</div>
```
