// src/lib/aiRequest.js: the request every AI call to api/ sends (v5.11.104).
//
// The AI routes (api/ai.js for the shift assistant, the Back Office assistant and the AI rota;
// api/ai/menu-import.js for the menu import) now check who is asking before they spend the
// Anthropic key. Every caller sends the same two things, built here in one place:
//   - Authorization: Bearer <this session's access token>. In Back Office that is the signed in
//     person's session. On a till it is the paired device's own anonymous session (staff sign in
//     with a PIN, not Supabase Auth), which the server accepts for the shift assistant only when
//     the device is bound to the venue named. ensureAuthToken never swaps a device's identity and
//     never mints an anonymous session on a surface a person signs in on.
//   - location_id: the venue this screen works for (getLocationId: the Back Office's selected
//     venue, or the paired device's venue). The server refuses a venue the login does not reach.
// The building is pure and tested in aiRequestBuild.js; this file only supplies the two reads.

import { ensureAuthToken, getLocationId } from './supabase';
import { buildAiRequest } from './aiRequestBuild';

/** The fetch init for a POST to an AI route, with this session's token and venue. */
export const aiRequestInit = (body) => buildAiRequest(body, { token: ensureAuthToken, location: getLocationId });
