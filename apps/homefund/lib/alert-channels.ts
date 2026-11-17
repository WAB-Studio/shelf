// How long an account may go without an alert before it reads as silent (RF-251).
export const SILENT_AFTER_DAYS = 7;

export type AlertChannelFacts = {
  accountId: string;
  accountName: string;
  // The latest delivery that landed on the account (ISO UTC) and the way it arrived; null when none ever did.
  lastAlertAt: string | null;
  lastVia: "email" | "phone" | null;
  alertsLast30Days: number;
};

// `active`: an alert in the last week. `silent`: it had alerts, none for a week, while another account kept
// receiving. `quiet`: no alert for a week but nothing else is arriving either, so nothing points at this account.
// `never`: no alert has ever reached it.
export type AlertChannelStatus = "active" | "silent" | "quiet" | "never";

export type AlertChannel = AlertChannelFacts & {
  status: AlertChannelStatus;
  // Whole days since the last alert; null when none ever came.
  daysSince: number | null;
};

const DAY_MS = 86_400_000;

/**
 * Reads each account's silence against the others', so a week with no alert anywhere (a holiday, a paused
 * phone) warns about no account in particular.
 */
export function readAlertChannels(facts: AlertChannelFacts[], now: Date): AlertChannel[] {
  const days = (iso: string | null): number | null =>
    iso === null ? null : Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / DAY_MS));
  const withDays = facts.map((fact) => ({ fact, daysSince: days(fact.lastAlertAt) }));
  const someoneActive = withDays.some((one) => one.daysSince !== null && one.daysSince < SILENT_AFTER_DAYS);

  return withDays.map(({ fact, daysSince }) => {
    let status: AlertChannelStatus;
    if (daysSince === null) status = "never";
    else if (daysSince < SILENT_AFTER_DAYS) status = "active";
    else status = someoneActive ? "silent" : "quiet";
    return { ...fact, status, daysSince };
  });
}
