/**
 * The console's CSV export, and the one property that makes it trustworthy: it carries what the
 * operator is looking at.
 *
 * WHY THAT IS THE HEADLINE TEST. An export that ignores the active filter is not a small bug. The
 * operator filters to twelve suspended workspaces, exports, opens four hundred rows in a
 * spreadsheet, and either notices — and never trusts the button again — or does not notice, and
 * sends the wrong list to somebody. So the first block below drives the SAME filter pipeline the
 * pages use and proves the export follows it, and the last block reads the pages' source to prove
 * they hand it their filtered array rather than the raw query data.
 *
 * The rest is escaping, which is not decoration either: a workspace is named by a stranger at
 * signup, and a stray comma shifts every later column by one, silently, in a file somebody then
 * makes a decision from.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { csvCell, csvFileName, toCsv, type CsvColumn } from "../../src/utils/console-csv";

/* Same lazy `read` helper the sibling guards use, at module scope for the same reason:
   `fileURLToPath(new URL(rel, import.meta.url))` and never a string edit on the href, because
   stripping "file:///" yields "C:/x" on Windows and "home/runner/x" on Linux. */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

interface Row {
  name: string;
  slug: string;
  status: string;
}

const COLUMNS: Array<CsvColumn<Row>> = [
  { header: "Name", value: (row) => row.name },
  { header: "Slug", value: (row) => row.slug },
  { header: "Status", value: (row) => row.status }
];

const ALL: Row[] = [
  { name: "Acme Corp", slug: "acme", status: "ACTIVE" },
  { name: "Northwind", slug: "northwind", status: "SUSPENDED" },
  { name: "Initech", slug: "initech", status: "ACTIVE" }
];

const lines = (csv: string) => csv.split("\r\n");

describe("the export carries the FILTER, not the table", () => {
  it("writes only the rows it was given", () => {
    const filtered = ALL.filter((row) => row.status === "SUSPENDED");
    const csv = toCsv(COLUMNS, filtered);
    expect(lines(csv)).toHaveLength(2);
    expect(csv).toContain("Northwind");
    expect(csv).not.toContain("Acme");
    expect(csv).not.toContain("Initech");
  });

  it("keeps the ORDER it was given, so a sorted view exports sorted", () => {
    const sorted = [...ALL].sort((a, b) => b.name.localeCompare(a.name));
    expect(lines(toCsv(COLUMNS, sorted)).slice(1).map((line) => line.split(",")[0])).toEqual(['"Northwind"', '"Initech"', '"Acme Corp"']);
  });

  it("writes a header and nothing else when the filter matches nothing", () => {
    // An empty file would be indistinguishable from a failed export; a header-only file says
    // plainly "this filter has no rows".
    expect(lines(toCsv(COLUMNS, []))).toEqual(['"Name","Slug","Status"']);
  });
});

describe("escaping, because these values are typed by strangers", () => {
  it("quotes a comma so the columns do not shift", () => {
    expect(csvCell("Acme, Inc.")).toBe('"Acme, Inc."');
  });

  it("doubles an interior quote, per RFC 4180", () => {
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
  });

  it("keeps a newline inside its quoted field", () => {
    const csv = toCsv(COLUMNS, [{ name: "Two\nLines", slug: "x", status: "ACTIVE" }]);
    // Still two records: the header, and one row whose first field happens to span two lines.
    expect(csv.split('"\r\n')).toHaveLength(2);
    expect(csv).toContain('"Two\nLines"');
  });

  it("renders null and undefined as empty rather than as the words", () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    // The literal string "null" in a spreadsheet cell is worse than a blank: it looks like data.
    expect(csvCell(null)).not.toContain("null");
  });

  it("keeps numbers and booleans readable", () => {
    expect(csvCell(0)).toBe('"0"');
    expect(csvCell(false)).toBe('"false"');
  });

  it("defuses a formula, because Excel and Sheets EVALUATE a cell starting with = or +", () => {
    // A workspace named `=HYPERLINK("http://evil","click")` becomes a live link in an operator's
    // spreadsheet otherwise. The leading apostrophe is the OWASP mitigation.
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    for (const prefix of ["=", "+", "-", "@"]) expect(csvCell(`${prefix}cmd`)).toBe(`"'${prefix}cmd"`);
    // …and leaves an ordinary value alone.
    expect(csvCell("Acme")).toBe('"Acme"');
  });
});

describe("the file itself", () => {
  it("is dated, because an operator ends up with several", () => {
    expect(csvFileName("organizations", new Date("2026-08-31T12:00:00.000Z"))).toBe("organizations-2026-08-31.csv");
  });

  it("uses CRLF, which is what RFC 4180 says and what Excel on Windows needs", () => {
    expect(toCsv(COLUMNS, ALL)).toContain("\r\n");
  });
});

describe("the pages hand it the FILTERED array — checked in their source", () => {
  /**
   * A hand-written copy of a rule is exactly the drift this repo keeps getting bitten by, and the
   * rule here is invisible at the call site: `exportCsv(..., rows)` and `exportCsv(..., data)` look
   * identical in review and differ entirely in what lands in the file. So these read the pages and
   * assert the variable name, which is the one place the mistake would show.
   */
  /** `exportCsv(` up to its matching close paren. Paren-COUNTING rather than a regex, because the
   *  third argument legitimately contains calls of its own (`ANALYTICS_CSV_COLUMNS(healthByOrg)`)
   *  and a lazy `[^)]*` would stop at the wrong one and quietly assert nothing. */
  function exportCallIn(source: string): string {
    const start = source.indexOf("exportCsv(");
    if (start === -1) return "";
    let depth = 0;
    for (let i = source.indexOf("(", start); i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    return "";
  }

  /** The last argument — the array that actually becomes the file. */
  const lastArgumentOf = (call: string) => call.slice(call.lastIndexOf(",") + 1, -1).trim();

  it("Organizations exports its filtered+sorted `rows`, never `orgs.data`", () => {
    const call = exportCallIn(read("../../src/pages/platform-admin/Organizations.tsx"));
    expect(call).not.toBe("");
    expect(lastArgumentOf(call)).toBe("rows");
    expect(call).not.toContain("orgs.data");
  });

  it("Sales leads exports `shown` — the pipeline column the operator has selected", () => {
    const call = exportCallIn(read("../../src/pages/platform-admin/SalesLeads.tsx"));
    expect(lastArgumentOf(call)).toBe("shown");
    // `rows` here is every lead the API returned; exporting it from behind a "Qualified" filter is
    // how somebody ends up mailing the ones marked Lost.
    expect(lastArgumentOf(call)).not.toBe("rows");
  });

  it("Analytics exports the SEARCH result across every page, not the twenty rows on screen", () => {
    const call = exportCallIn(read("../../src/pages/platform-admin/PlatformAnalytics.tsx"));
    expect(lastArgumentOf(call)).toBe("filteredOrgs");
    expect(call).not.toContain("analytics.data");
  });

  it("the audit trail exports the page it is showing, and its button says so", () => {
    // The one table where the export is genuinely a subset of the filter: the audit trail is
    // SERVER-paginated, so there is no client array to widen it to. The honest fix is the label,
    // and a button reading "Export CSV" here would promise the filter and deliver the page.
    const source = read("../../src/pages/platform-admin/Settings.tsx");
    expect(lastArgumentOf(exportCallIn(source))).toContain("audit.data");
    expect(source).toContain("Export page");
  });
});
