/**
 * WHAT: which preset names a date range on the range picker's button (components/ui/date-range-picker.tsx).
 *
 * Several presets can describe the SAME range: on the 1st, "This month" is just today; on a Monday,
 * "This week" is just today; on 1 January, four of them are. The button used to name whichever
 * matched first, so choosing "This month" on the 1st read back "Today" — correct dates, wrong words,
 * and the person reasonably wonders whether their click took. The preset the person CHOSE wins for
 * as long as it still describes the range; anything else falls back to the first match.
 */

export interface DatePreset {
  label: string;
  range: () => { from: string; to: string };
}

export function activePresetFor<P extends DatePreset>(presets: readonly P[], value: { from: string; to: string }, chosen: string | null): P | undefined {
  const describes = (preset: P) => {
    const range = preset.range();
    return range.from === value.from && range.to === value.to;
  };
  return (chosen ? presets.find((preset) => preset.label === chosen && describes(preset)) : undefined) ?? presets.find(describes);
}
