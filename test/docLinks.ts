// Link extraction and resolution for the documents drift check (issue #76, W4).
//
// Pure functions over Markdown text plus a filesystem lookup, so the check's own logic can be
// exercised on fixtures (including a deliberately broken document) rather than trusted by
// inspection. Only what GitHub renders as a link is looked at: inline `[text](target)` and
// `![alt](target)`, and `[label]: target` reference definitions. Fenced and inline code are
// skipped, since a shell command in a README is not a link.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

export interface DocLink {
  /** The target exactly as written, e.g. `evidence/exhibit-c.md#results`. */
  target: string;
  /** True for `![alt](target)`. */
  image: boolean;
}

function stripFences(markdown: string): string {
  return markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
}

function stripCode(markdown: string): string {
  return stripFences(markdown).replace(/`[^`\n]*`/g, "");
}

export function extractLinks(markdown: string): DocLink[] {
  const text = stripCode(markdown);
  const links: DocLink[] = [];
  const inline = /(!?)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  for (const m of text.matchAll(inline)) links.push({ target: m[2]!, image: m[1] === "!" });
  const definition = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/gm;
  for (const m of text.matchAll(definition)) links.push({ target: m[1]!, image: false });
  return links;
}

/** GitHub's heading anchor: lowercased, markup and punctuation dropped, spaces to hyphens. */
export function githubSlug(heading: string): string {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

export function headingAnchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  for (const m of stripFences(markdown).matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) {
    const slug = githubSlug(m[1]!);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    anchors.add(n === 0 ? slug : `${slug}-${n}`);
  }
  return anchors;
}

function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target);
}

/**
 * Everything wrong with the relative links of one document: a target that does not exist, a
 * target that escapes the repository, or a `#fragment` that matches no heading of a Markdown
 * target. External links (`https:`, `mailto:`) are not fetched.
 */
export function linkProblems(docPath: string, markdown: string, repoRoot: string): string[] {
  const problems: string[] = [];
  const docDir = dirname(docPath);
  for (const { target } of extractLinks(markdown)) {
    if (isExternal(target)) continue;
    const hash = target.indexOf("#");
    const rawPath = hash === -1 ? target : target.slice(0, hash);
    let resolved: string;
    let fragment: string;
    try {
      fragment = hash === -1 ? "" : decodeURIComponent(target.slice(hash + 1));
      const decoded = decodeURIComponent(rawPath);
      resolved = rawPath === "" ? docPath : decoded.startsWith("/") ? resolve(repoRoot, `.${decoded}`) : resolve(docDir, decoded);
    } catch {
      problems.push(`${target}: not a valid path`);
      continue;
    }
    const rel = relative(repoRoot, resolved);
    if (rel === ".." || rel.startsWith(`..${sep}`)) {
      problems.push(`${target}: points outside the repository`);
      continue;
    }
    if (rawPath !== "" && !existsSync(resolved)) {
      problems.push(`${target}: ${rel} does not exist`);
      continue;
    }
    if (fragment !== "" && resolved.endsWith(".md") && (rawPath === "" || statSync(resolved).isFile())) {
      const body = resolved === docPath ? markdown : readFileSync(resolved, "utf8");
      if (!headingAnchors(body).has(fragment.toLowerCase())) problems.push(`${target}: no heading "#${fragment}" in ${rel}`);
    }
  }
  return problems;
}

/** Resolved repo-relative paths of every image the document embeds. */
export function embeddedImages(docPath: string, markdown: string, repoRoot: string): string[] {
  return extractLinks(markdown)
    .filter((l) => l.image && !isExternal(l.target))
    .map((l) => relative(repoRoot, resolve(dirname(docPath), decodeURIComponent(l.target.split("#")[0]!))));
}
