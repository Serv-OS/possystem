// ManagerTeam — live floor (who's on, no-shows, breaks) + approvals (timesheets, time off).
// Needs a requireToken workforce read (wf_* is RLS-fenced to BO users; the paired device is anon).
// The pure decisions are ready in src/lib/manager/{team,timesheets}.js. Slice 3.
import { Header, SoonPanel } from './ui';

export default function ManagerTeam({ ctx }) {
  const points = [
    "On shift now, no-shows (with Call + Find cover), breaks due",
    'Live labour £/hr',
  ];
  if (ctx.flags.team_approvals) points.push('Approve timesheets (anomaly flags) → feeds payroll/tronc', 'Approve / decline time off (holiday ledger, 12.07% accrual, coverage warning)');
  return (
    <div>
      <Header title="Team" sub={ctx.flags.team_approvals ? 'Live + approvals' : 'Live floor'} />
      <SoonPanel icon="team" title="Who's on + the approvals inbox" points={points} />
    </div>
  );
}
