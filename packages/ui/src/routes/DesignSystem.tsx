// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The design-system gallery — every shared primitive on one page.
 *
 * WHY IT EXISTS. Three of the four things that break when adopting a component
 * library are invisible in the source and only show up on screen: a utility
 * that is physically rather than logically directed, a `dark:` variant wired to
 * the wrong signal, and ink that fails contrast on one theme but not the other.
 * The gates catch the first mechanically; this page is how a person checks the
 * rest in about ten seconds instead of clicking through the whole product.
 *
 * WHAT THE FOUR PANES DO AND DO NOT PROVE — read this before trusting them.
 * An earlier version of this comment claimed a `data-theme` on each pane made
 * everything resolve per pane. Half of that was wrong, and stating it as proven
 * was worse than not testing it:
 *
 *  - TOKENS do resolve per pane. `tokens.css` scopes every value to
 *    `[data-theme=...]`, so a light pane really does paint light surfaces and
 *    light ink, and a contrast problem is visible here.
 *  - TAILWIND'S `dark:` VARIANT DOES NOT. `index.css` defines it as
 *    `:root:not([data-theme="light"])` — it reads <html>, not the nearest
 *    ancestor — so a light pane inside a dark document still has `dark:`
 *    utilities switched ON. Only the root toggle below exercises that, and it
 *    is the real mechanism, which is the point.
 *  - PORTALLED CONTENT ESCAPES THE PANES ENTIRELY. A dropdown or dialog renders
 *    at `document.body`, outside every pane's `dir` and `data-theme`. Radix
 *    takes an explicit `dir`, so the menus below are told their pane's
 *    direction; dialogs are full-screen by nature and follow the root, so they
 *    are driven from the root controls instead of from a pane.
 */
import { useState } from 'react';
import { ExternalLink, RotateCw, Trash2 } from 'lucide-react';
import { Page } from '../components/Page';
import { Modal } from '../components/Modal';
import { Checkbox } from '../components/ui/checkbox';
import { Label } from '../components/ui/label';
import { Switch } from '../components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';

type Dir = 'ltr' | 'rtl';

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

/** The primitives, rendered once per pane. */
function Specimens({ dir }: { dir: Dir }) {
  const [on, setOn] = useState(true);
  const [checked, setChecked] = useState(true);

  return (
    <>
      <Row name="Switch" note="thumb at the INLINE END when on — mirrored in RTL">
        <div className="ds-demo-line">
          <Switch checked={on} onCheckedChange={setOn} id={`ds-switch-${dir}`} />
          <Label htmlFor={`ds-switch-${dir}`}>Share over the internet</Label>
        </div>
        <div className="ds-demo-line">
          <Switch checked={false} disabled id={`ds-switch-off-${dir}`} />
          <Label htmlFor={`ds-switch-off-${dir}`}>Off, disabled</Label>
        </div>
      </Row>

      <Row name="Checkbox" note="tick visible in both themes; label is clickable">
        <div className="ds-demo-line">
          <Checkbox
            checked={checked}
            onCheckedChange={(v) => setChecked(v === true)}
            id={`ds-check-${dir}`}
          />
          <Label htmlFor={`ds-check-${dir}`}>Also delete this app&rsquo;s data</Label>
        </div>
      </Row>

      <Row name="DropdownMenu" note="arrow keys + Escape; portalled, so it is told this pane's dir">
        {/* `dir` is passed explicitly because the content renders at
            document.body, outside this pane's dir attribute. Without it the
            RTL pane would show an LTR menu and the pane would prove nothing. */}
        <DropdownMenu dir={dir}>
          <DropdownMenuTrigger asChild>
            <button className="btn btn--sm">Open menu</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="glass-raised">
            <DropdownMenuItem>
              <ExternalLink size={16} /> Open
            </DropdownMenuItem>
            <DropdownMenuItem>
              <RotateCw size={16} /> Restart
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive">
              <Trash2 size={16} /> Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Row>
    </>
  );
}

/** One pane: a theme and a direction, isolated from the page around it. */
function Pane({ theme, dir }: { theme: 'dark' | 'light'; dir: Dir }) {
  return (
    <section className="ds-pane glass panel" data-theme={theme} dir={dir}>
      <header className="ds-pane__head">
        <strong>{theme}</strong>
        <span className="ds-pane__dir">{dir.toUpperCase()}</span>
      </header>
      <Specimens dir={dir} />
    </section>
  );
}

export function DesignSystem() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [lockedOpen, setLockedOpen] = useState(false);

  // Flips the REAL root attributes, which is the only way to exercise the
  // `dark:` variant and to see a portalled dialog in the other direction.
  const root = document.documentElement;
  const flipTheme = () =>
    root.setAttribute('data-theme', root.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
  const flipDir = () => root.setAttribute('dir', root.getAttribute('dir') === 'rtl' ? 'ltr' : 'rtl');

  return (
    <Page>
      <div className="page-head">
        <h1 className="page-title">Design system</h1>
        <p className="page-sub">
          Every shared primitive, in both themes and both writing directions. The panes cover
          tokens and layout; the two buttons below flip the real root, which is what the{' '}
          <code>dark:</code> variant and any full-screen dialog actually follow.
        </p>
      </div>

      <div className="glass panel ds-controls">
        <button className="btn btn--sm" onClick={flipTheme}>
          Flip root theme
        </button>
        <button className="btn btn--sm" onClick={flipDir}>
          Flip root direction
        </button>
        <button className="btn btn--sm" onClick={() => setDialogOpen(true)}>
          Open dialog
        </button>
        <button className="btn btn--sm btn--danger" onClick={() => setLockedOpen(true)}>
          Open LOCKED dialog
        </button>
      </div>

      <div className="ds-grid">
        <Pane theme="dark" dir="ltr" />
        <Pane theme="dark" dir="rtl" />
        <Pane theme="light" dir="ltr" />
        <Pane theme="light" dir="rtl" />
      </div>

      <Modal open={dialogOpen} onClose={() => setDialogOpen(false)} title="An ordinary dialog">
        <p>
          Escape, the backdrop and the corner X all close this. Tab should stay inside it, and
          closing it should put the focus ring back on the button that opened it.
        </p>
        <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button className="btn" onClick={() => setDialogOpen(false)}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={() => setDialogOpen(false)}>
            Confirm
          </button>
        </div>
      </Modal>

      {/* The one dialog that must refuse every way out. There is no X, Escape
          does nothing and the backdrop does nothing — the only way out is this
          button, which stands in for "the update finished". */}
      <Modal open={lockedOpen} onClose={() => setLockedOpen(false)} locked title="A locked dialog">
        <p>
          This is what an update in progress looks like. Escape, the backdrop and the corner X
          are all inert, and Tab must not escape to the dock behind it.
        </p>
        <button
          className="btn btn--primary"
          style={{ marginTop: '1rem' }}
          onClick={() => setLockedOpen(false)}
        >
          Pretend the update finished
        </button>
      </Modal>
    </Page>
  );
}
