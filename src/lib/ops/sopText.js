// src/lib/ops/sopText.js (5.12.62): the words of an SOP file, read in the browser.
//
// A plain text file is read here. A PDF or a photo goes to api/sop-text.js as base64 (the model
// reads the words out of it), with this session's token and the venue, like the invoice scan.
// Returns { text, error }. Never throws.

import { aiRequestInit } from '../aiRequest';
import { sopReadable, cleanSopText } from './sopRules.js';
import { contentTypeFor } from './formRules.js';

const readAs = (file, how) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error || new Error('Could not read the file'));
  if (how === 'text') r.readAsText(file); else r.readAsDataURL(file);
});

/** The SOP's words out of a File (or Blob with a name). { text, error }. */
export async function readSopText(file, fetchImpl = (typeof fetch !== 'undefined' ? fetch : null)) {
  const can = sopReadable(file);
  if (!can.ok) return { text: '', error: new Error(can.error) };
  try {
    if (can.how === 'text') {
      const text = cleanSopText(await readAs(file, 'text'));
      return text ? { text, error: null } : { text: '', error: new Error('That file has no words in it.') };
    }
    if (!fetchImpl) return { text: '', error: new Error('This needs a live connection to ServOS.') };
    const dataUrl = String(await readAs(file, 'dataUrl'));
    const image = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const type = contentTypeFor(file);
    const media_type = type === 'application/pdf' ? 'application/pdf' : (type.startsWith('image/') ? (type === 'image/jpg' ? 'image/jpeg' : type) : 'application/pdf');
    const res = await fetchImpl('/api/sop-text', await aiRequestInit({ image, media_type }));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { text: '', error: new Error(body.error || 'Could not read the words out of the file.') };
    const text = cleanSopText(body.text);
    return text ? { text, error: null } : { text: '', error: new Error('No words could be read out of that file.') };
  } catch (e) {
    return { text: '', error: new Error(e?.message || 'Could not read the file.') };
  }
}
