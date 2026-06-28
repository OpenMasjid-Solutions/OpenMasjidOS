// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** The fixed ambient backdrop: a looping ambient scene if enabled, else a custom
 *  wallpaper image if set, else the static aurora + khatam pattern + vignette. */
import { usePrefs } from '../lib/prefs';
import { useAmbient } from '../lib/ambient';

// Only accept a plain http(s) URL with no characters that could break out of
// the CSS url("…") value. Anything else falls back to the gradient scene.
function safeImageUrl(value: string): string | null {
  const v = value.trim();
  return /^https?:\/\/[^\s"'()]+$/i.test(v) ? v : null;
}

export function SceneBackground() {
  const prefs = usePrefs();
  const ambientOn = useAmbient();

  // A looping, muted, hardware-decoded video backdrop. Fixed + behind everything,
  // never interactive; `object-fit: cover` fills the screen at any aspect. The
  // <video> is keyed/static so React never re-renders it = smooth playback.
  if (ambientOn) {
    return (
      <video
        className="scene"
        aria-hidden="true"
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- disablePictureInPicture not in the JSX types yet
        {...({ disablePictureInPicture: true } as any)}
        style={{ objectFit: 'cover', width: '100%', height: '100%', pointerEvents: 'none' }}
        src="/ambient.mp4"
      />
    );
  }

  const img = safeImageUrl(prefs.wallpaperImage);
  if (img) {
    // Set sizing inline: `.scene { background: … }` is a shorthand that resets
    // background-size to `auto`, which would otherwise show a 4K image at native
    // size (cropped to the top-left). Inline always wins, so the image is
    // scaled to fill the screen.
    return (
      <div
        className="scene scene--image"
        aria-hidden="true"
        style={{
          backgroundImage: `url("${img}")`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
        }}
      />
    );
  }
  return <div className="scene" aria-hidden="true" />;
}
