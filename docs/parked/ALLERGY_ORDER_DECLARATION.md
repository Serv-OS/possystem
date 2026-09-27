# PARKED 27 Sep 2026: declared allergies to the KDS and the kitchen docket

Peter: "even if allergies are not on products, when allergies are selected it should come up on the KDS and the ticket printed" (26 Sep). Parked 27 Sep: "lets park the allergy stuff its too big!"

**Branch state:** this branch = main at v5.9.85 (a05075f2) + allergy-v6 (the last built version, 23 files, about 4,400 lines). It does NOT apply cleanly to main after v5.9.86 (CustomerModal, POSSurface, customerLookup changed).

**Design (approved over three adversarial rounds):** the declaration belongs to the ORDER (session / walk in / tab / scheduled entry / queue entry `declaredAllergens`); the till's Allergen filter chips edit the order on screen and load from it on every order switch; attaching a customer adds their saved allergies ONCE; the kitchen gets only the order's declaration; an explicit "Save to <name>'s profile" button replaces the old silent auto save; a late allergy after a send prints ONE update docket and touches only this order's recorded kitchen tickets (`order.kitchenTickets`); KDS red block per line + banner; docket red "!! ALLERGY !!" + red double height line under each item.

**Open findings at park time (review round 3):** (1) attach once does not survive an Orders Hub reopen (the queue entry does not carry the applied profiles), so re-attaching a customer re-adds a cleared allergy and prints a false "ALLERGY UPDATE NEW" docket; (2) rebase onto current main; `customerWithPhone` can leave a new customer's name undefined (the v5.9.88 crash class).

**If picked up again:** consider the smaller version first: allergies captured on the order and printed at send (no late update machinery), which covers the ask with far less surface.
