// purchasing/OrderPadHeaderLine.jsx: the multi site Order pad's line under the title (multi site
// stock Drop 3, v5.11.96, contract 4.2): 'Next delivery <b>Wed 22 Oct</b> · order by <b>Tue 14:00</b>
// (in 3 h 20 m)'. next is nextDelivery's answer (with supplierName), or { noRules, supplierName }.

import { dayWords, timeLeftWords } from '../../../lib/stock/purchasingRules';
import { noRulesWords } from '../../../lib/stock/purchasingWords';

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dowOf = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();

export default function OrderPadHeaderLine({ next, nowMs = null }) {
  if (!next) return null;
  const line = { fontSize: 13, color: 'var(--t2)', margin: '-6px 0 12px' };
  if (next.noRules) return <div style={line}>{noRulesWords(next.supplierName)}</div>;
  let left = next.minutesLeft;
  if (Number.isFinite(Number(next.orderByMs)) && Number.isFinite(Number(nowMs))) left = Math.floor((Number(next.orderByMs) - Number(nowMs)) / 60000);
  const t = timeLeftWords(left);
  const by = next.orderByHm === '24:00' ? `the end of ${DAY[dowOf(next.orderByYmd)]}` : `${DAY[dowOf(next.orderByYmd)]} ${next.orderByHm}`;
  return (
    <div style={line}>
      {next.supplierName ? `${next.supplierName}: ` : ''}Next delivery <b>{dayWords(next.deliveryYmd)}</b> · order by <b>{by}</b> ({t ? `in ${t}` : 'passed'})
    </div>
  );
}
