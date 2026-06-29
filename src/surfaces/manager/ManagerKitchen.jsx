// ManagerKitchen — stock to order (below par + 86 + incoming deliveries) and batch cooks due.
// Needs a requireToken stock read + the new prep_schedule table (additive). Pure decisions are ready
// in src/lib/manager/kitchen.js. NOT the live KDS ticket rail — that stays as-is. Slice 4.
import { Header, SoonPanel } from './ui';

export default function ManagerKitchen() {
  return (
    <div>
      <Header title="Kitchen" sub="Stock ordering + batch cooks" />
      <SoonPanel icon="fire" title="Order stock + record batch cooks" points={[
        'Items below par (qty · par · supplier) + 86 / sold-out',
        'Raise a purchase order per supplier · incoming deliveries (ETA)',
        'Batch cooks due today — tick done (qty · who · when), overdue flagged',
        'Reads stock + prep only — never the live KDS order rail',
      ]} />
    </div>
  );
}
