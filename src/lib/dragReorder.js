// src/lib/dragReorder.js
//
// WHY A DRAG BARELY WORKS, AND THE TWO LINES THAT FIX IT.
//
// Peter, 21 Sep 2026: "dragging categories around is so buggy you can barely do
// it". Every drag in Back Office was written the same way:
//
//   onDragStart={e => { setDragCatId(cat.id); e.dataTransfer.effectAllowed = 'move'; }}
//   onDragOver={e => { e.preventDefault(); setOverCatId(cat.id); }}
//
// Two faults, and both of them are felt rather than seen.
//
// 1. NO setData, SO FIREFOX NEVER STARTS THE DRAG. The HTML drag and drop spec
//    lets a browser refuse a drag whose dataTransfer carries nothing, and
//    Firefox does exactly that: the row lifts a little and drops straight back.
//    Fifteen drag handlers in MenuManager alone, not one of them called
//    setData. Chrome is forgiving, Firefox is not, and the people who reported
//    this are on Firefox (the same browser whose wording gave us the save
//    failure earlier today).
//
// 2. A RE-RENDER ON EVERY dragover EVENT. dragover fires every few milliseconds
//    while the pointer is over a row, and each one called setState with the
//    value it already held. A venue with thirty categories re-rendered the
//    whole list dozens of times a second while you were trying to aim, which is
//    the stickiness in "you can barely do it".
//
// Both are one line each, so they live here and every drag uses them.

/**
 * Start a drag properly.
 *
 * ALWAYS call this in onDragStart. The setData call is not optional: without
 * it Firefox refuses to begin the drag at all.
 */
export function beginDrag(e, id) {
  const dt = e?.dataTransfer;
  if (!dt) return;
  try {
    dt.effectAllowed = 'move';
    // THE LINE FIREFOX INSISTS ON. The value is our own id; nothing reads it
    // back (the component already knows what it picked up), it exists so the
    // browser has a payload and will run the drag.
    dt.setData('text/plain', String(id ?? ''));
  } catch { /* a locked dataTransfer outside a real drag: the drag still works */ }
}

/**
 * Allow a drop here, and mark the row under the pointer WITHOUT re-rendering on
 * every one of the dozens of dragover events a second.
 *
 * @param {DragEvent} e
 * @param {*} next     what the row under the pointer is
 * @param {*} current  what the component currently holds
 * @param {Function} set  the setter, called only when it would change
 */
export function dragOver(e, next, current, set) {
  e.preventDefault();
  if (current !== next) set(next);
}
