// src/lib/cameraCapture.js
//
// WHEN A PHOTO BUTTON MAY ASK FOR THE CAMERA, AND WHEN IT MUST NOT.
//
// Peter, 21 Sep 2026: "Manager app crashing. On open checks the open camera
// button crashes the app on iOS." It is not a crash we wrote. `<input
// type="file" capture="environment">` makes WKWebView open the CAMERA picker
// itself, and iOS terminates any app that reaches the camera without
// NSCameraUsageDescription in its Info.plist. Of the eight iOS targets only the
// POS declares that string, so on the Manager app the process is killed the
// instant the button is tapped. No error, no message: gone.
//
// The shell's own getUserMedia guard does not help here. It answers
// requestMediaCapturePermissionFor, which a file input never goes through.
//
// THE RULE: only ask for the camera when we KNOW the shell can survive it.
//   * a normal browser (no shell marker): camera, as before
//   * the Android shell: camera, as before
//   * the iOS shell: ONLY when it says hasCamera === true
//
// An iOS build from before this change says nothing about a camera, so we treat
// it as no camera and drop the attribute. The file input still opens, on the
// photo library, which needs no permission string and cannot kill the app. A
// photo from the library is a smaller loss than an app that dies in front of a
// manager holding a clipboard at 6am.

/** The iOS shell's marker, or null. Injected at document start by WebView.swift. */
export function iosShell(win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  const marker = w && w.RposIOS;
  return marker && typeof marker === 'object' ? marker : null;
}

/**
 * May a file input carry capture="environment" here?
 * @returns {boolean}
 */
export function cameraCaptureAllowed(win) {
  const shell = iosShell(win);
  if (!shell) return true;          // a browser, or the Android shell
  return shell.hasCamera === true;  // iOS: only when the build says so
}

/**
 * The props for a photo input, spread straight onto the element.
 * Keeps `capture` out of the DOM entirely where it is not safe, rather than
 * setting it to something falsy, which the browser still reads as "camera".
 */
export function photoInputProps(win, accept = 'image/*') {
  const props = { type: 'file', accept };
  if (cameraCaptureAllowed(win)) props.capture = 'environment';
  return props;
}

/** What to call the button, so it does not promise a camera it cannot open. */
export function photoButtonLabel(win) {
  return cameraCaptureAllowed(win) ? 'Take a photo' : 'Choose a photo';
}
