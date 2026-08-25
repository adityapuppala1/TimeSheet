/**
 * `buildAiUsageWorkbook` mirrors change-export.service.ts's Summary+Detail pattern for the AI
 * usage table's Excel export, now three sheets: Summary, Usage (provider×model), and Daily detail
 * (day×feature×provider×model). Behaviours worth pinning: an unmeasured latency must write the
 * string "not measured", never a blank cell or a literal 0 (either would silently read as "zero
 * milliseconds"); a provider that has never had a call at all (successRatePct null, not 0) must
 * write "n/a", never "0%" — a provider nobody has tried yet is not the same claim as one that
 * fails every time; and the Daily detail sheet's cost share must be computed against the SAME
 * grand total as the Usage sheet, so the two tabs can't disagree about what the numbers add to.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildAiUsageWorkbook, type AiUsageDailyExportRow, type AiUsageExportRow } from "../../src/services/ai-usage-export.service.js";

const ROWS: AiUsageExportRow[] = [
  {
    provider: "Anthropic",
    model: "claude-haiku-4-5",
    calls: 10,
    successCount: 9,
    failureCount: 1,
    successRatePct: 90,
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
    avgLatencyMs: 842,
    latencyMeasuredCalls: 8,
    costUsd: 1.23,
    costSharePct: 60
  },
  {
    provider: "Mistral",
    model: "mistral-large-latest",
    calls: 5,
    successCount: 0,
    failureCount: 5,
    successRatePct: 0,
    inputTokens: 400,
    outputTokens: 200,
    totalTokens: 600,
    avgLatencyMs: null,
    latencyMeasuredCalls: 0,
    costUsd: 0.82,
    costSharePct: 40
  }
];

const DAILY_ROWS: AiUsageDailyExportRow[] = [
  {
    date: "2026-08-10",
    feature: "triage",
    provider: "Anthropic",
    model: "claude-haiku-4-5",
    calls: 10,
    successCount: 9,
    failureCount: 1,
    successRatePct: 90,
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
    avgLatencyMs: 842,
    latencyMeasuredCalls: 8,
    costUsd: 1.23
  },
  {
    date: "2026-08-11",
    feature: "ask_ai",
    provider: "Mistral",
    model: "mistral-large-latest",
    calls: 5,
    successCount: 0,
    failureCount: 5,
    successRatePct: 0,
    inputTokens: 400,
    outputTokens: 200,
    totalTokens: 600,
    avgLatencyMs: null,
    latencyMeasuredCalls: 0,
    costUsd: 0.82
  }
];

describe("buildAiUsageWorkbook", () => {
  it("builds Summary, Usage, and Daily detail sheets from the same rows, with an unmeasured latency spelled out", async () => {
    const buffer = await buildAiUsageWorkbook(ROWS, DAILY_ROWS, {
      generatedBy: "Avery Stone",
      workspace: "hics",
      from: "2026-08-01",
      to: "2026-08-25",
      feature: null
    });

    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(buffer as unknown as ArrayBuffer);

    const sheetNames = reloaded.worksheets.map((ws) => ws.name);
    expect(sheetNames).toEqual(["Summary", "Usage", "Daily detail"]);

    // Usage columns: 1 Provider, 2 Model, 3 Calls, 4 Successes, 5 Failures, 6 Success rate,
    // 7 Input tokens, 8 Output tokens, 9 Total tokens, 10 Avg latency (ms), 11 Latency measured on,
    // 12 Cost, 13 % of total cost.
    const usage = reloaded.getWorksheet("Usage")!;
    expect(usage.rowCount).toBe(ROWS.length + 1);
    expect(usage.getRow(2).getCell(6).value).toBe(90);
    expect(usage.getRow(3).getCell(6).value).toBe(0); // a real 0% success rate, not "n/a"
    expect(usage.getRow(2).getCell(10).value).toBe(842);
    expect(usage.getRow(3).getCell(10).value).toBe("not measured");

    // Daily detail columns: 1 Date, 2 Feature, 3 Provider, 4 Model, 5 Calls, 6 Successes,
    // 7 Failures, 8 Success rate, 9 Input tokens, 10 Output tokens, 11 Total tokens,
    // 12 Avg latency (ms), 13 Latency measured on, 14 Cost, 15 % of total cost.
    const daily = reloaded.getWorksheet("Daily detail")!;
    expect(daily.rowCount).toBe(DAILY_ROWS.length + 1);
    expect(daily.getRow(2).getCell(1).value).toBe("2026-08-10");
    expect(daily.getRow(2).getCell(2).value).toBe("triage");
    expect(daily.getRow(3).getCell(12).value).toBe("not measured");

    // Total cost across both fixture rows is 1.23 + 0.82 = 2.05 — the same grand total the Usage
    // sheet's own costSharePct (60/40) was computed against, so the two sheets must agree exactly.
    const anthropicShare = daily.getRow(2).getCell(15).value as number;
    const mistralShare = daily.getRow(3).getCell(15).value as number;
    expect(anthropicShare).toBeCloseTo(60, 0);
    expect(mistralShare).toBeCloseTo(40, 0);
  });

  it("writes 'n/a' for a provider with no calls yet, never '0%' — those are different claims", async () => {
    const untried: AiUsageExportRow = { ...ROWS[0], calls: 0, successCount: 0, failureCount: 0, successRatePct: null };
    const buffer = await buildAiUsageWorkbook([untried], [], {
      generatedBy: "Avery Stone",
      workspace: "hics",
      from: "2026-08-01",
      to: "2026-08-25",
      feature: null
    });

    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(reloaded.getWorksheet("Usage")!.getRow(2).getCell(6).value).toBe("n/a");
  });
});
