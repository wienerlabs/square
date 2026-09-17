import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = process.argv[2] ?? join(here, "market-assessment-2026-09.md");

if (!existsSync(source)) {
  console.error(`usage: node build-pdf.mjs [markdown file]\n${source} does not exist`);
  process.exit(2);
}

const CHROME_CANDIDATES = [
  process.env["CHROME"],
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((path) => typeof path === "string");

const chrome = CHROME_CANDIDATES.find((path) => existsSync(path));
if (chrome === undefined) {
  console.error("no Chrome or Chromium was found; set CHROME to one");
  process.exit(1);
}

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(text) {
  return escape(text)
    .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, (_, bold) => `<strong>${bold}</strong>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, lead, url) => `${lead}<a href="${url}">${url}</a>`);
}

function render(markdown) {
  const out = [];
  const lines = markdown.split("\n");
  let index = 0;
  let paragraph = [];

  const flush = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === "") {
      flush();
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (line.startsWith("> ")) {
      flush();
      const quote = [];
      while (index < lines.length && lines[index].startsWith("> ")) {
        quote.push(lines[index].slice(2));
        index += 1;
      }
      out.push(`<blockquote><p>${inline(quote.join(" "))}</p></blockquote>`);
      continue;
    }

    if (line.startsWith("|")) {
      flush();
      const rows = [];
      while (index < lines.length && lines[index].startsWith("|")) {
        rows.push(lines[index]);
        index += 1;
      }
      const cells = (row) =>
        row
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim());
      const header = cells(rows[0]);
      const body = rows.slice(2).filter((row) => !/^\|[\s:|-]+\|$/.test(row)).map(cells);
      out.push(
        `<table><thead><tr>${header.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>` +
          body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("") +
          `</tbody></table>`,
      );
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      flush();
      const items = [];
      while (index < lines.length && (/^[-*]\s+/.test(lines[index]) || /^\s{2,}\S/.test(lines[index]))) {
        if (/^[-*]\s+/.test(lines[index])) items.push(lines[index].replace(/^[-*]\s+/, ""));
        else items[items.length - 1] += ` ${lines[index].trim()}`;
        index += 1;
      }
      out.push(`<ul>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }

  flush();
  return out.join("\n");
}

const markdown = readFileSync(source, "utf8");
const title = markdown.match(/^#\s+(.*)$/m)?.[1] ?? basename(source);

const html = `<!doctype html>
<meta charset="utf-8">
<title>${escape(title)}</title>
<style>
  @page { size: A4; margin: 20mm 18mm; }
  html { font-size: 10.5pt; }
  body {
    margin: 0;
    color: #181925;
    background: #ffffff;
    font-family: "Iowan Old Style", "Palatino", Georgia, serif;
    line-height: 1.55;
  }
  h1 { font-size: 22pt; line-height: 1.2; margin: 0 0 4pt; letter-spacing: -0.4pt; }
  h2 { font-size: 14pt; margin: 22pt 0 6pt; letter-spacing: -0.2pt; border-top: 0.6pt solid #e8e8e8; padding-top: 10pt; }
  h3 { font-size: 11.5pt; margin: 14pt 0 4pt; }
  p { margin: 0 0 8pt; }
  a { color: #4b46c4; text-decoration: none; overflow-wrap: anywhere; }
  code { font-family: "SF Mono", Menlo, monospace; font-size: 9pt; background: #f4f4f6; padding: 0.5pt 2.5pt; border-radius: 2pt; }
  blockquote { margin: 10pt 0; padding: 8pt 12pt; border-left: 2pt solid #918df6; background: #fafaff; }
  blockquote p { margin: 0; font-style: italic; }
  ul { margin: 0 0 8pt; padding-left: 16pt; }
  li { margin: 0 0 4pt; }
  table { border-collapse: collapse; width: 100%; margin: 10pt 0; font-size: 8.5pt; }
  th, td { border: 0.5pt solid #e0e0e4; padding: 4pt 6pt; text-align: left; vertical-align: top; }
  th { background: #f6f6f8; font-weight: 600; }
  h2, h3 { break-after: avoid; }
  table, blockquote, li { break-inside: avoid; }
  .meta { color: #6b6b78; font-size: 9pt; margin: 0 0 18pt; }
</style>
<h1>${escape(title)}</h1>
<p class="meta">Square, wienerlabs/square. Generated from docs/strategy/${basename(source)}</p>
${render(markdown.replace(/^#\s+.*$/m, "").trimStart())}
`;

const htmlPath = source.replace(/\.md$/, ".html");
const pdfPath = source.replace(/\.md$/, ".pdf");
writeFileSync(htmlPath, html);

execFileSync(chrome, [
  "--headless",
  "--disable-gpu",
  "--no-pdf-header-footer",
  `--print-to-pdf=${pdfPath}`,
  `file://${htmlPath}`,
]);

unlinkSync(htmlPath);
console.log(`wrote ${pdfPath}`);
