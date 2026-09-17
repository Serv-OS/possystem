// selectOnFocus: props to spread on a price box so a click or a Tab into it
// selects the whole value. Typing then REPLACES the number instead of landing
// next to it (the "0" that became "05" in the Back Office price boxes).
//
//   <input type="number" {...selectOnFocus} value={...} onChange={...} />
//
// What the user gets:
//   - Tab (or any focus that is not a mouse press) into the box: all selected.
//   - First click into the box: all selected.
//   - Second click, once the box has focus: the caret goes where they clicked.
//   - Press and drag: their own text selection is left alone.
//
// Rules this file keeps (each one is a browser trap, do not "tidy" them away):
//   - Only select() is used. setSelectionRange THROWS on type="number".
//     select() can still throw on odd elements, so every call is swallowed.
//   - On a mouse press we do NOT select inside onFocus. Focus fires in the
//     middle of the press, before the browser places the caret. Selecting there
//     makes the browser think the press landed on selected text, so a drag
//     would move the text instead of selecting it, and the mouse release would
//     collapse the selection again. We wait for the release instead.
//   - preventDefault is NEVER called. On type="number" the little up and down
//     arrows stop repeating on the mouse release default action; blocking it
//     can leave the value counting up on its own.
//   - select() also gives the element focus. The delayed reselect therefore
//     checks the box still has focus, or it would steal focus back.
//   - No hooks and no per input setup, so it is safe inside .map(). The state
//     for a press lives in a WeakMap keyed by the element.
//   - It never reads or writes the value. Parsing, storing and rounding stay
//     with each input's own onChange.

const DRAG_PIXELS = 4; // moved further than this between press and release = a drag

const defaultActiveElement = () => (typeof document !== 'undefined' ? document.activeElement : null);
const defaultDefer = (fn) => setTimeout(fn, 0);

export function createSelectOnFocus({ getActiveElement = defaultActiveElement, defer = defaultDefer } = {}) {
  // element -> { x, y, fresh } of the mouse press that is giving it focus
  const presses = new WeakMap();

  const selectAll = (el) => {
    try {
      if (el && typeof el.select === 'function') el.select();
    } catch {
      // Some input types refuse selection. Leave the caret where it is.
    }
  };

  return {
    onFocus(e) {
      const el = e.currentTarget;
      const press = presses.get(el);
      if (press && press.fresh) return; // this focus comes from a mouse press, onMouseUp decides
      presses.delete(el); // an old press that was released outside the box
      selectAll(el);
    },

    onMouseDown(e) {
      const el = e.currentTarget;
      presses.delete(el); // a press released outside the box never reached onMouseUp
      if (e.button != null && e.button !== 0) return; // main button only
      if (getActiveElement() === el) return; // already focused: a normal click, caret or drag
      // fresh = the focus event that follows in this same turn belongs to this
      // press. A press released outside the box never reaches onMouseUp, so it
      // must stop counting as soon as this turn ends, or a later Tab into the
      // box would be mistaken for a mouse press and not select.
      const press = { x: e.clientX, y: e.clientY, fresh: true };
      presses.set(el, press);
      defer(() => { press.fresh = false; });
    },

    onMouseUp(e) {
      const el = e.currentTarget;
      const press = presses.get(el);
      if (!press) return;
      presses.delete(el);
      const moved = Math.abs((e.clientX ?? press.x) - press.x) > DRAG_PIXELS
        || Math.abs((e.clientY ?? press.y) - press.y) > DRAG_PIXELS;
      if (moved) return; // a drag: keep the text they selected
      selectAll(el);
      // Some browsers finish their own caret placement after this handler.
      defer(() => { if (getActiveElement() === el) selectAll(el); });
    },
  };
}

// The shared instance every price box spreads.
export const selectOnFocus = createSelectOnFocus();
