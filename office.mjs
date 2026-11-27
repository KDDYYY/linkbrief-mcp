// Office documents from links: .docx, .pptx, .xlsx and .hwpx (Hangul). All are ZIP files of XML;
// only the XML parts that hold text are unpacked. Binary .hwp is reported as unsupported.
import { strFromU8, unzipSync } from "fflate";

const TYPES = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/hwp+zip": "hwpx",
  "application/vnd.hancom.hwpx": "hwpx",
  "application/x-hwp": "hwp",
  "application/haansofthwp": "hwp",
  "application/vnd.hancom.hwp": "hwp",
};

// Document kind from the Content-Type, or from the file extension when the server sends a generic type.
export function officeKind(type, url) {
  const t = (type || "").split(";")[0].trim().toLowerCase();
  if (TYPES[t]) return TYPES[t];
  if (t && !/^(application\/(octet-stream|zip|x-zip-compressed|download|force-download)|binary\/octet-stream)$/.test(t)) return null;
  return /\.(docx|pptx|xlsx|hwpx|hwp)$/i.exec(new URL(url).pathname)?.[1].toLowerCase() ?? null;
}

const MAX_UNPACKED = 60 * 1024 * 1024;
const WANTED = /^(word\/document\.xml|ppt\/slides\/slide\d+\.xml|xl\/(workbook\.xml|sharedStrings\.xml|styles\.xml|worksheets\/sheet\d+\.xml|_rels\/workbook\.xml\.rels)|docProps\/core\.xml|Contents\/section\d+\.xml)$/;

// Unpacks only the XML parts we read, refusing archives that declare more than MAX_UNPACKED.
// shortcut: trusts the sizes declared in the ZIP headers; switch to streaming inflate with a running cap if hostile files become a concern.
function unpack(bytes) {
  let total = 0;
  const files = unzipSync(new Uint8Array(bytes), {
    filter: (f) => {
      if (!WANTED.test(f.name)) return false;
      total += f.originalSize;
      if (total > MAX_UNPACKED) throw new Error("Document unpacks to more than 60 MB; not read");
      return true;
    },
  });
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
}

const unxml = (s) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, "&");
const texts = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g"))].map((m) => unxml(m[1])).join("");
const byNumber = (prefix, files) => Object.keys(files).filter((k) => k.startsWith(prefix)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
const cell = (s) => s.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
const table = (rows) => {
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => cell(r[i] ?? "")).join(" | ")} |`;
  return [line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
};

function docx(files) {
  const body = files["word/document.xml"] || "";
  const out = [];
  // Top-level paragraphs and tables in document order.
  for (const [block] of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    if (block.startsWith("<w:tbl>")) {
      const rows = [...block.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map(([tr]) => [...tr.matchAll(/<w:tc[ >][\s\S]*?<\/w:tc>/g)].map(([tc]) => texts(tc, "w:t")));
      if (rows.length) out.push(table(rows));
      continue;
    }
    const text = texts(block.replace(/<w:tab\/>/g, "<w:t>\t</w:t>").replace(/<w:br\/>/g, "<w:t>\n</w:t>"), "w:t").trim();
    if (!text) continue;
    const style = /<w:pStyle w:val="([^"]+)"/.exec(block)?.[1] || "";
    const level = /^title$/i.test(style) ? 1 : Number(/^heading\s?(\d)$/i.exec(style)?.[1] || 0);
    out.push(level ? `${"#".repeat(Math.min(level + 1, 6))} ${text}` : text);
  }
  return out.join("\n\n");
}

function pptx(files) {
  return byNumber("ppt/slides/slide", files).map((name, i) => {
    const paras = [...files[name].matchAll(/<a:p>[\s\S]*?<\/a:p>/g)].map(([p]) => texts(p, "a:t").trim()).filter(Boolean);
    return `## Slide ${i + 1}\n\n${paras.join("\n\n")}`;
  }).join("\n\n");
}

const MAX_ROWS = 200;
const MAX_COLS = 50;

// Excel stores dates as day counts; a cell whose number format is a date or time is shown as ISO text.
// Built-in format ids for dates/times (including the CJK locale ones 27-36 and 50-58).
const BUILTIN_DATE = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]);
const BUILTIN_TIME = new Set([18, 19, 20, 21, 32, 33, 45, 46, 47, 55, 56]);
// Per cell style index (the "s" attribute): "date", "datetime", "time" or undefined.
function dateStyles(stylesXml) {
  const custom = Object.fromEntries([...stylesXml.matchAll(/<numFmt [^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)].map(([, id, code]) => [id, unxml(code)]));
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] || "";
  return [...xfs.matchAll(/<xf [^>]*?numFmtId="(\d+)"/g)].map(([, id]) => {
    if (BUILTIN_DATE.has(Number(id))) return Number(id) === 22 ? "datetime" : "date";
    if (BUILTIN_TIME.has(Number(id))) return "time";
    const code = (custom[id] || "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, ""); // drop literals, colours, locales
    if (/[dy]/i.test(code)) return /h/i.test(code) ? "datetime" : "date";
    if (/h/i.test(code)) return "time";
    return undefined;
  });
}
// shortcut: ignores Excel's 1900 leap-year bug, so serials before 1900-03-01 are one day off; such dates are rare in practice.
function excelDate(value, kind, date1904) {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const iso = new Date(Date.UTC(1899, 11, 30) + Math.round((n + (date1904 ? 1462 : 0)) * 86400000)).toISOString();
  return kind === "time" ? iso.slice(11, 16) : kind === "datetime" ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

function xlsx(files) {
  const styles = dateStyles(files["xl/styles.xml"] || "");
  const date1904 = /date1904="(1|true)"/.test(files["xl/workbook.xml"] || "");
  const shared = [...(files["xl/sharedStrings.xml"] || "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) => texts(si, "t"));
  const rels = Object.fromEntries([...(files["xl/_rels/workbook.xml.rels"] || "").matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map(([, id, t]) => [id, `xl/${t.replace(/^\/?xl\//, "")}`]));
  const sheets = [...(files["xl/workbook.xml"] || "").matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map(([, name, id]) => ({ name: unxml(name), file: rels[id] }));
  const col = (ref) => [...ref.replace(/\d+/g, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return sheets.filter((s) => files[s.file]).map((s) => {
    const rows = [...files[s.file].matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)].map(([, row]) => {
      const values = [];
      for (const [, attrs, inner] of row.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
        const kind = /t="(\w+)"/.exec(attrs)?.[1];
        const v = /<v>([^<]*)<\/v>/.exec(inner || "")?.[1];
        const dateKind = !kind || kind === "n" ? styles[Number(/\bs="(\d+)"/.exec(attrs)?.[1])] : undefined;
        values[ref ? col(ref) : values.length] = kind === "s" ? shared[Number(v)] ?? ""
          : kind === "inlineStr" ? texts(inner || "", "t")
            : dateKind && v != null ? excelDate(v, dateKind, date1904) : unxml(v ?? "");
      }
      return Array.from(values.slice(0, MAX_COLS), (x) => x ?? "");
    }).filter((r) => r.some(Boolean));
    if (!rows.length) return `## Sheet: ${s.name}\n\n(empty)`;
    const note = rows.length > MAX_ROWS ? `\n\n(First ${MAX_ROWS} of ${rows.length} rows.)` : "";
    return `## Sheet: ${s.name}\n\n${table(rows.slice(0, MAX_ROWS))}${note}`;
  }).join("\n\n");
}

function hwpx(files) {
  return byNumber("Contents/section", files).map((name) =>
    [...files[name].matchAll(/<hp:p[ >][\s\S]*?<\/hp:p>/g)].map(([p]) => texts(p, "hp:t").trim()).filter(Boolean).join("\n\n"),
  ).join("\n\n");
}

export function officeToMarkdown(bytes, kind) {
  if (kind === "hwp") throw new Error("Old binary .hwp files are not supported. Save it as .hwpx or PDF, or attach it to your agent directly.");
  const files = unpack(bytes);
  const markdown = { docx, pptx, xlsx, hwpx }[kind](files).trim();
  const core = files["docProps/core.xml"] || "";
  return {
    markdown,
    title: texts(core, "dc:title"),
    byline: texts(core, "dc:creator"),
    published: texts(core, "dcterms:created"),
    siteName: { docx: "Word document", pptx: "PowerPoint presentation", xlsx: "Excel workbook", hwpx: "Hangul document" }[kind],
  };
}
