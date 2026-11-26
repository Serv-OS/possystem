// src/lib/choiceKinds.js
//
// THE KINDS OF CHOICE AN OPTION GROUP CAN ASK FOR (modifier_groups.selection_type).
//
//   single          One choice.
//   multiple        Several choices. On the POS and the kiosk the same option can be tapped again
//                   to add another (Coffee Boy: two syrups, an extra sausage twice).
//   multiple_once   Several choices, each option only once (5.12.112).
//   quantity        The same choice more than once, counted (a box of 6).
//
// 5.12.112 (Peter, 26 Nov 2026: "any of the pizza options they can select multiple but only one of
// each", then "launch for the entire system"). "Several choices" let the same option be picked
// twice on the POS and the kiosk, and many venues rely on that, so it stays exactly as it was. The
// new kind is a switch on the group, off unless someone turns it on.
//
// Every ordering screen asks isOnceEach(group): never its own test of the word.
// A screen that has not learned the new kind (an old app build) treats it as "several choices".
export const ONCE_EACH = 'multiple_once';

/** The kind of choice on a group row, in either spelling (store rows are camel, database rows snake). */
export const choiceKindOf = (group) => group?.selectionType ?? group?.selection_type ?? group?._selectionType ?? null;

/** True when the group lets a customer pick several options but each one only once. */
export const isOnceEach = (group) => choiceKindOf(group) === ONCE_EACH;

/** True for the two "several choices" kinds (the same rules for how many, min and max). */
export const isSeveral = (group) => { const k = choiceKindOf(group); return k === 'multiple' || k === ONCE_EACH; };
