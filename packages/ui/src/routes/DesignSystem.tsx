// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The design-system gallery — every shared primitive on one page, rendered in
 * both themes and both writing directions at once.
 *
 * WHY IT EXISTS. Three of the four things that break when adopting a component
 * library are invisible in the source and only show up on screen: a utility
 * that is physically rather than logically directed, a `dark:` variant wired to
 * the wrong signal, and ink that fails contrast on one theme but not the other.
 * The gates catch the first mechanically; this page is how a person checks the
 * other two in about ten seconds instead of clicking through the whole product.
 *
 * It is deliberately NOT lazy-loaded behind a feature flag or hidden: it costs a
 * few KB, and a gallery nobody can reach is a gallery nobody looks at. It is
 * plain, unstyled-beyond-tokens, and lists primitives in the order they were
 * added so it doubles as a visible record of what the design system contains.
 *
 * The RTL panes set `dir="rtl"` on a wrapper rather than on <html>, so you can
 * see both directions side by side without switching language — which matters
 * because English is currently the only registered locale (CLAUDE.md §13.1),
 * and the RTL branch of `applyLanguage` therefore never executes at runtime.
 * Without this page, RTL is unfalsifiable in the product.
 */
import { useState } from 'react';
import { Page } from '../components/Page';
import { Checkbox } from '../components/ui/checkbox';
import { Label } from '../components/ui/label';
import { Switch } from '../components/ui/switch';

/** One primitive, shown with a short note on what to look at. */
function Row({ name, note, children }: { name: string; note: string; children: React.ReactNode }) {
  return (
    <div className="ds-row">
      <div className="ds-row__meta">
        <code className="ds-row__name">{name}</code>
        <span className="ds-row__note">{note}</span>
      </div>
      <div className="ds-row__demo">{children}</div>
    </div>
  );
}

/** The primitives, rendered once. Used four times: {light,dark} x {ltr,rtl}. */
function Specimens() {
  const [on, setOn] = useState(true);
  const [checked, setChecked] = useState(true);

  return (
    <>
      <Row name="Switch" note="thumb must sit at the INLINE END when on — mirrored in RTL">
        <div className="ds-demo-line">
          <Switch checked={on} onCheckedChange={setOn} id="ds-switch" />
          <Label htmlFor="ds-switch">Share over the internet</Label>
        </div>
        <div className="ds-demo-line">
          <Switch checked={false} disabled id="ds-switch-off" />
          <Label htmlFor="ds-switch-off">Off, disabled</Label>
        </div>
      </Row>

      <Row name="Checkbox" note="tick visible in both themes; label is clickable">
        <div className="ds-demo-line">
          <Checkbox checked={checked} onCheckedChange={(v) => setChecked(v === true)} id="ds-check" />
          <Label htmlFor="ds-check">Also delete this app&rsquo;s data</Label>
        </div>
        <div className="ds-demo-line">
          <Checkbox checked={false} disabled id="ds-check-off" />
          <Label htmlFor="ds-check-off">Off, disabled</Label>
        </div>
      </Row>

      <Row name="Label" note="inherits the body face, not a Tailwind default">
        <Label>A plain label</Label>
      </Row>
    </>
  );
}

/** One quadrant: a theme and a direction, isolated from the page around it. */
function Pane({ theme, dir }: { theme: 'dark' | 'light'; dir: 'ltr' | 'rtl' }) {
  return (
    // `data-theme` on a wrapper works because tokens.css scopes every value to
    // [data-theme=...] rather than to :root alone, so a subtree can carry the
    // other theme. The same is true of the `dark:` variant, which is mapped to
    // :root:not([data-theme="light"]) — meaning a LIGHT pane nested in a dark
    // document really does turn `dark:` utilities off. That is exactly the
    // wiring this page is here to prove.
    <section className="ds-pane glass panel" data-theme={theme} dir={dir}>
      <header className="ds-pane__head">
        <strong>{theme}</strong>
        <span className="ds-pane__dir">{dir.toUpperCase()}</span>
      </header>
      <Specimens />
    </section>
  );
}

export function DesignSystem() {
  return (
    <Page>
      <div className="page-head">
        <h1 className="page-title">Design system</h1>
        <p className="page-sub">
          Every shared primitive, in both themes and both writing directions. If a control looks
          right in all four panes it is very likely correct everywhere.
        </p>
      </div>

      <div className="ds-grid">
        <Pane theme="dark" dir="ltr" />
        <Pane theme="dark" dir="rtl" />
        <Pane theme="light" dir="ltr" />
        <Pane theme="light" dir="rtl" />
      </div>
    </Page>
  );
}
