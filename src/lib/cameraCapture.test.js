// cameraCapture.test.js — the photo button must never be able to kill the app.
//
// Peter, 21 Sep 2026: "Manager app crashing. On open checks the open camera
// button crashes the app on iOS."
//
// `<input type="file" capture="environment">` opens the CAMERA picker itself.
// It never reaches the shell's getUserMedia permission handler, so the shell
// cannot refuse it, and iOS terminates any app that touches the camera without
// NSCameraUsageDescription. Seven of the eight iOS targets ship without that
// string, so this rule is what stands between a manager and a dead app.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { iosShell, cameraCaptureAllowed, photoInputProps, photoButtonLabel } from './cameraCapture.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('a normal browser keeps the camera', () => {
  assert.equal(cameraCaptureAllowed({}), true);
  assert.equal(photoInputProps({}).capture, 'environment');
});

test('the Android shell keeps the camera', () => {
  assert.equal(cameraCaptureAllowed({ RposAndroid: {} }), true);
});

test('an iOS build that says it has a camera keeps it', () => {
  assert.equal(cameraCaptureAllowed({ RposIOS: { platform: 'ios', hasCamera: true } }), true);
  assert.equal(photoInputProps({ RposIOS: { hasCamera: true } }).capture, 'environment');
});

test('an iOS build that says it has NO camera never asks for one', () => {
  assert.equal(cameraCaptureAllowed({ RposIOS: { platform: 'ios', hasCamera: false } }), false);
  assert.equal('capture' in photoInputProps({ RposIOS: { hasCamera: false } }), false,
    'the attribute must be ABSENT, not falsy: a browser reads capture="" as the camera');
});

test('an OLD iOS build, which says nothing, is treated as no camera', () => {
  // Every build before 21 Sep 2026 is in this state, including the one on
  // Peter's phone right now. Guessing "probably fine" here is what kills it.
  assert.equal(cameraCaptureAllowed({ RposIOS: { platform: 'ios', version: '5.9.30' } }), false);
});

test('the file input still works, it just opens the library', () => {
  const props = photoInputProps({ RposIOS: { hasCamera: false } });
  assert.equal(props.type, 'file');
  assert.equal(props.accept, 'image/*');
  const invoice = photoInputProps({ RposIOS: { hasCamera: false } }, 'image/*,application/pdf');
  assert.equal(invoice.accept, 'image/*,application/pdf');
});

test('the button says what it will actually do', () => {
  assert.equal(photoButtonLabel({}), 'Take a photo');
  assert.equal(photoButtonLabel({ RposIOS: { hasCamera: false } }), 'Choose a photo');
});

test('a marker that is not an object is not a shell', () => {
  assert.equal(iosShell({ RposIOS: true }), null);
  assert.equal(iosShell({}), null);
  assert.equal(cameraCaptureAllowed(null), true, 'no window at all is a build step, not a phone');
});

// ── the two inputs that can reach the camera ────────────────────────────────

test('no photo input anywhere hard codes capture again', () => {
  for (const rel of ['../surfaces/OperationsSurface.jsx', '../backoffice/sections/Invoices.jsx']) {
    const src = read(rel);
    // Comments may name the attribute; an element may not carry it.
    const code = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(code, /<input[^>]*capture=/, rel + ' must ask the shell, not assume');
    assert.match(code, /photoInputProps\(/, rel + ' uses the shared rule');
  }
});

// ── the iOS side of the same contract ───────────────────────────────────────

test('the shell publishes whether it has a camera', () => {
  const swift = read('../../ios/ServOSPOS/WebView.swift');
  assert.match(swift, /hasCamera: \\\(Config\.allowsCamera\)/, 'the marker carries the flag the web rule reads');
});

test('the Manager app declares the camera it actually uses', () => {
  // Its Ops tab signs checklists off with a photo, so "Manager never scans" was
  // wrong, and being wrong about it killed the app.
  const yml = read('../../ios/project.yml');
  const manager = yml.slice(yml.indexOf('?mode=manager'), yml.indexOf('?mode=manager') + 900);
  assert.match(manager, /RPOSAllowsCamera: true/);
  assert.match(manager, /NSCameraUsageDescription/);
  const plist = read('../../ios/ServOSManager/Info.plist');
  assert.match(plist, /NSCameraUsageDescription/);
});

test('every iOS target that allows the camera also declares why', () => {
  // The pairing that iOS enforces with a kill. One without the other is a crash
  // waiting for somebody to tap a button.
  const yml = read('../../ios/project.yml');
  const blocks = yml.split(/\n  [A-Za-z]/);
  for (const b of blocks) {
    if (!b.includes('RPOSAllowsCamera: true')) continue;
    assert.match(b, /NSCameraUsageDescription/, 'a target grants the camera with no reason string: ' + b.slice(0, 60));
  }
});
