/** The fixed ambient backdrop: a custom wallpaper image if set, else the static
 *  aurora + khatam pattern + vignette. */
import { usePrefs } from '../lib/prefs';

// Only accept a plain http(s) URL with no characters that could break out of
// the CSS url("…") value. Anything else falls back to the gradient scene.
function safeImageUrl(value: string): string | null {
  const v = value.trim();
  return /^https?:\/\/[^\s"'()]+$/i.test(v) ? v : null;
}

export function SceneBackground() {
  const prefs = usePrefs();
  const img = safeImageUrl(prefs.wallpaperImage);
  if (img) {
    return (
      <div
        className="scene scene--image"
        aria-hidden="true"
        style={{ backgroundImage: `url("${img}")` }}
      />
    );
  }
  return <div className="scene" aria-hidden="true" />;
}
