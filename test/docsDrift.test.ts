// Documents drift check (issue #76, W4): the README, the writeup and the recommendation matrix
// must keep pointing at things that exist, and the charts they embed must be what the generator
// produces from the committed reports today.
//
// Two layers. The first runs the checking logic on small fixtures, including deliberately broken
// ones, so a check that cannot fail is caught here. The second applies it to the real documents.
//
// What this does not check, by design: the figures quoted in prose. Those are verified by hand
// against the exhibits, the way Exhibit H's record-consistency check was, not parsed out of text.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CHART_FILES } from "../load-harness/chartsRender.js";
import { buildCharts } from "../load-harness/charts.js";
import { embeddedImages, extractLinks, githubSlug, headingAnchors, linkProblems } from "./docLinks.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const README = join(ROOT, "README.md");
const WRITEUP = join(ROOT, "docs", "writeup.md");
const MATRIX = join(ROOT, "docs", "recommendation-matrix.md");

describe("link extraction", () => {
  it("finds inline links, images and reference definitions, and skips code", () => {
    const md = [
      "See [the exhibit](docs/evidence/a.md#results) and ![chart](docs/charts/x.svg).",
      "[ref]: docs/ref.md",
      "`[inline](not-a-link.md)`",
      "```bash",
      "echo '[fenced](also-not.md)'",
      "```",
      "An external [site](https://example.com/x) too.",
    ].join("\n");
    expect(extractLinks(md)).toEqual([
      { target: "docs/evidence/a.md#results", image: false },
      { target: "docs/charts/x.svg", image: true },
      { target: "https://example.com/x", image: false },
      { target: "docs/ref.md", image: false },
    ]);
  });

  it("computes GitHub heading anchors, including repeats", () => {
    expect(githubSlug("What this does **not** show")).toBe("what-this-does-not-show");
    expect(githubSlug("The `pessimistic` default (and why)")).toBe("the-pessimistic-default-and-why");
    expect([...headingAnchors("# A\n## B c\n## B c\n```\n# not a heading\n```\n")]).toEqual(["a", "b-c", "b-c-1"]);
  });
});

describe("link resolution", () => {
  const fixtureRoots: string[] = [];
  afterAll(() => {
    for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
  });

  function fixtureRepo() {
    const root = mkdtempSync(join(tmpdir(), "docs-drift-"));
    fixtureRoots.push(root);
    mkdirSync(join(root, "docs", "evidence"), { recursive: true });
    writeFileSync(join(root, "docs", "evidence", "a.md"), "# Results\n\ntext\n");
    writeFileSync(join(root, "docs", "b.md"), "# Other\n");
    return root;
  }

  it("accepts links that resolve, with and without a heading fragment", () => {
    const root = fixtureRepo();
    const doc = join(root, "docs", "w.md");
    const md = "[a](evidence/a.md) [b](evidence/a.md#results) [c](b.md) [self](#intro) [x](https://example.com)\n\n# Intro\n";
    expect(linkProblems(doc, md, root)).toEqual([]);
  });

  it("flags a missing file, a missing heading and a target outside the repository", () => {
    const root = fixtureRepo();
    const doc = join(root, "docs", "w.md");
    const md = "[gone](evidence/missing.md) [h](evidence/a.md#nope) [out](../../outside.md) [self](#absent)\n";
    const problems = linkProblems(doc, md, root);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain("evidence/missing.md");
    expect(problems[1]).toContain("#nope");
    expect(problems[2]).toContain("outside the repository");
    expect(problems[3]).toContain("#absent");
  });

  it("lists the images a document embeds, repo-relative", () => {
    const root = fixtureRepo();
    const doc = join(root, "docs", "w.md");
    expect(embeddedImages(doc, "![a](charts/x.svg) [not](b.md) ![e](https://example.com/y.png)", root)).toEqual([join("docs", "charts", "x.svg")]);
  });
});

describe("the real documents", () => {
  const docs = [
    ["README.md", README],
    ["docs/writeup.md", WRITEUP],
    ["docs/recommendation-matrix.md", MATRIX],
  ] as const;

  for (const [name, path] of docs) {
    it(`${name} exists`, () => {
      expect(existsSync(path), `${name} is missing`).toBe(true);
    });

    it(`${name}: every relative link resolves`, () => {
      expect(linkProblems(path, readFileSync(path, "utf8"), ROOT)).toEqual([]);
    });
  }

  it("every chart a document embeds equals what the generator produces now", async () => {
    const generated = await buildCharts();
    for (const [name, path] of docs) {
      for (const image of embeddedImages(path, readFileSync(path, "utf8"), ROOT)) {
        if (!image.startsWith(join("docs", "charts"))) continue;
        const file = basename(image);
        expect(generated[file], `${name} embeds ${image}, which the generator does not produce`).toBeDefined();
        expect(readFileSync(join(ROOT, image), "utf8"), `${image} is stale: run npm run charts`).toBe(generated[file]);
      }
    }
  });

  it("the writeup embeds all four charts", () => {
    const embedded = new Set(embeddedImages(WRITEUP, readFileSync(WRITEUP, "utf8"), ROOT).map((p) => basename(p)));
    for (const file of Object.values(CHART_FILES)) expect(embedded.has(file), `${file} is not embedded in docs/writeup.md`).toBe(true);
  });
});
