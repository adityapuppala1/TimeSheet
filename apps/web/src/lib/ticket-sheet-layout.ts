/**
 * WHAT: the one decision behind the ticket sheet's shape — one column, or fields beside activity.
 *
 * WHY A PURE FUNCTION: the sheet already has three inputs that bear on this (a phone-sized
 * viewport, a dragged width, the maximize toggle) and V12 adds a fourth (the person closed the
 * activity column). Four booleans decided inline in JSX is exactly the kind of thing that ends
 * up wrong on one combination; here the table is small enough to read and is unit-tested.
 *
 * SOURCE (V12 state file, item 3.16): the reference's task view keeps fields and description in
 * the main column, shows the running activity/comments log in a right section, and lets a person
 * close that section "to keep the task details and description in focus".
 */

/**
 * Two columns need room for two readable measures at the 14px root: a ~520px main column plus
 * a ~400px activity column plus the gutter. Below this the tabs would wrap into ribbon.
 */
export const SPLIT_MIN_SHEET_WIDTH = 960;

export type TicketSheetLayout = "stacked" | "split" | "focus";

export interface TicketSheetLayoutInput {
  /** From `useSheetResize`: false on a phone, where the sheet is the whole screen. */
  resizable: boolean;
  /** The dragged width in px (ignored while maximized). */
  width: number;
  maximized: boolean;
  /** The person chose to close the activity column. */
  activityHidden: boolean;
  /** `window.innerWidth`; what "maximized" resolves to. */
  viewportWidth: number;
}

/** Whether the sheet is currently wide enough that a split is even on offer. */
export function canSplit({ resizable, width, maximized, viewportWidth }: Omit<TicketSheetLayoutInput, "activityHidden">): boolean {
  if (!resizable) return false;
  const effective = maximized ? viewportWidth : width;
  return effective >= SPLIT_MIN_SHEET_WIDTH;
}

export function ticketSheetLayout(input: TicketSheetLayoutInput): TicketSheetLayout {
  if (!canSplit(input)) return "stacked";
  return input.activityHidden ? "focus" : "split";
}

export const ACTIVITY_HIDDEN_KEY = "timesphere.ticket-sheet-activity";

/** Read the remembered choice; anything but the literal "hidden" means shown, which was the only state before. */
export function readActivityHidden(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(ACTIVITY_HIDDEN_KEY) === "hidden";
  } catch {
    return false;
  }
}

export function writeActivityHidden(storage: Pick<Storage, "setItem" | "removeItem"> | undefined, hidden: boolean): void {
  try {
    if (hidden) storage?.setItem(ACTIVITY_HIDDEN_KEY, "hidden");
    else storage?.removeItem(ACTIVITY_HIDDEN_KEY);
  } catch {
    /* private mode: the choice lasts the session only */
  }
}
