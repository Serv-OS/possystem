// ManagerReports — owner money + open-table states. Needs a requireToken manager-snapshot edge fn
// (the paired device is anon-scoped, so it can't call the BO-gated owner-snapshot directly). Slice 2.
import { Header, SoonPanel } from './ui';

export default function ManagerReports({ ctx }) {
  return (
    <div>
      <Header title="Reports" sub={ctx.flags.reports_readonly ? 'View only' : "Today's takings + tables"} />
      <SoonPanel icon="reports" title="Takings & live floor" points={[
        'Net sales today (ex-VAT) vs forecast, orders, avg check, labour %',
        'Open tables: dining · held · seated-no-order · stalled',
        'Stalled tables with a one-tap “nudge server”',
        'This venue (multi-site reporting stays in Back Office)',
      ]} />
    </div>
  );
}
