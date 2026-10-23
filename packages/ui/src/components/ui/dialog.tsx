// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * shadcn Dialog, reduced to the parts we compose ourselves.
 *
 * This deviates from the CLI output more than the other primitives do, and each
 * departure is forced by something that already exists here:
 *
 * 1. NO COMPOSITE `DialogContent`. Upstream's version renders its own Portal and
 *    Overlay as SIBLINGS and centres itself with
 *    `top-[50%] left-[50%] translate-x-[-50%] translate-y-[-50%]`. Our backdrop
 *    (`.modal-backdrop`, app.css) is already `position: fixed; inset: 0;
 *    display: grid; place-items: center`, so the panel is centred by being a
 *    CHILD of the overlay. Those four utilities are therefore deleted rather
 *    than converted — there is no logical `translate-x`, and converting would
 *    have meant inventing a direction-aware transform to replace centring we
 *    already get for free. Radix supports Content nested inside Overlay.
 *
 * 2. NO ANIMATION UTILITIES. Upstream ships `animate-in`, `fade-in-0`,
 *    `zoom-in-95` and friends, which come from tw-animate-css /
 *    tailwindcss-animate. Neither is installed, so they compile to nothing — the
 *    dialog would hard-cut while the source read as though it animated. The
 *    spring entrance and blurred exit are driven by Motion in `Modal.tsx`, which
 *    is what CLAUDE.md §14 asks for and what this product already has.
 *
 * 3. NO `Button` IMPORT. Upstream's `DialogFooter` optionally renders a shadcn
 *    Button, which is not installed and which none of our 25 dialog instances
 *    would use — they build their own footers. Importing it would have broken
 *    the build outright.
 *
 * 4. RTL: `right-4` -> `end-4`, `sm:text-left` -> `sm:text-start`.
 *
 * `ui-design-gates` holds the physical-utility budget at 0 and refuses
 * `animate-in` while no animation plugin is declared, so a plain
 * `shadcn add dialog` that restores any of this fails the build rather than
 * quietly undoing it.
 */
import * as React from 'react';
import { cn } from 'cn';
import { Dialog as DialogPrimitive } from 'radix-ui';

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/** The backdrop. Callers pass `.modal-backdrop`, which also centres its child. */
function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay data-slot="dialog-overlay" className={cn(className)} {...props} />
  );
}

/** The panel. Nested INSIDE the overlay so the backdrop's grid centres it. */
function DialogContent({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Content data-slot="dialog-content" className={cn(className)} {...props} />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn(className)} {...props} />;
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
