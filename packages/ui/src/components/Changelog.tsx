// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Renders the project changelog (Settings → Advanced → "What's new").
 *
 * Deliberately NOT a markdown library. The repo has no markdown renderer and no
 * `dangerouslySetInnerHTML` anywhere, and a changelog needs about five
 * constructs — so this walks the text line by line and emits React elements.
 * Nothing is ever interpreted as HTML, which keeps the "no raw HTML in the
 * dashboard" property intact and adds no dependency to a Pi-friendly bundle.
 *
 * Supported: `## version` headings, `-`/`*` bullets, paragraphs, and inline
 * `**bold**` + `` `code` ``. Anything else renders as its own literal text,
 * which is the right failure mode for a file a human edits.
 */
import { useTranslation } from 'react-i18next';
import { isNewerVersion } from '../lib/version';
import { parseChangelog } from '../lib/changelog';

/** Split a line into plain / bold / code runs. Order matters: code first, so a
 *  `**` inside backticks stays literal. */
function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(
        <code key={key++} className="changelog__code">
          {m[1]}
        </code>,
      );
    } else {
      out.push(<strong key={key++}>{m[2]}</strong>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Changelog({ md, currentVersion }: { md: string; currentVersion?: string }) {
  const { t } = useTranslation();
  const sections = parseChangelog(md);
  if (sections.length === 0) {
    // `setting-row__hint` is this repo's muted-text idiom. (The Kiosk's `.muted`
    // utility does not exist here — worth knowing when porting anything else across.)
    return <p className="setting-row__hint">{t('changelog.empty')}</p>;
  }
  return (
    <div className="changelog">
      {sections.map((s, i) => {
        // A release newer than what we're running is the update on offer — the
        // reason most people open this at all, so it gets called out. (The Kiosk has
        // no equivalent: it ships its CHANGELOG inside the image, so it can never see
        // a release it isn't running. We fetch ours, so we can.)
        const isUpcoming =
          Boolean(s.version && currentVersion) && isNewerVersion(currentVersion!, s.version!);
        return (
          <section key={i} className="changelog__release">
            <h3 className="changelog__version">
              {s.version}
              {isUpcoming && (
                <span className="changelog__badge changelog__badge--new">{t('changelog.newer')}</span>
              )}
              {s.version === currentVersion && (
                <span className="changelog__badge changelog__badge--current">
                  {t('changelog.current')}
                </span>
              )}
            </h3>
            <ul className="changelog__list">
              {s.items.map((it, j) =>
                it.kind === 'bullet' ? (
                  <li key={j}>{inline(it.text)}</li>
                ) : (
                  <li key={j} className="changelog__para">
                    {inline(it.text)}
                  </li>
                ),
              )}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
