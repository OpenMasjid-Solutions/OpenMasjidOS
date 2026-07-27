// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Parses CHANGELOG.md into the shape the "What's new" panel renders.
 *
 * Deliberately not a markdown library: the repo has no markdown renderer and no
 * `dangerouslySetInnerHTML` anywhere, and a changelog needs about five
 * constructs. Keeping this a PURE function (no JSX) means it can be exercised
 * on its own — the rendering lives in components/Changelog.tsx.
 *
 * Recognised: `## version` headings, `-`/`*` bullets, and plain paragraphs.
 * Anything else is kept as its own literal line, which is the right failure mode
 * for a file a human edits by hand.
 */

export interface ChangelogItem {
  kind: 'bullet' | 'para';
  text: string;
}

export interface ChangelogSection {
  version: string;
  items: ChangelogItem[];
}

export function parseChangelog(md: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | null = null;
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('<!--')) continue; // SPDX / licence header
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) {
      current = { version: h2[1]!.trim(), items: [] };
      sections.push(current);
      continue;
    }
    // The `# What's new…` title, and the editing note above the first release.
    if (line.startsWith('#') || !current) continue;
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    current.items.push(
      bullet ? { kind: 'bullet', text: bullet[1]! } : { kind: 'para', text: line },
    );
  }
  return sections;
}
