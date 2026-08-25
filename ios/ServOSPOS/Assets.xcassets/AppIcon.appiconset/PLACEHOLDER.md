# App icon placeholder

This slot is EMPTY on purpose. No icon has been fabricated.

Before App Store submission:

- **Export** the brand icon from the ServOS Brand Guidelines (v2.0): the Signal green S mark on Ink `#0F1211`.
- **Size**: one PNG, 1024x1024, no alpha channel, no rounded corners (iOS masks it).
- **Add it**: drop the PNG into this folder, name it `AppIcon.png`, and add `"filename" : "AppIcon.png"` to the image entry in `Contents.json` (or just drag it onto the AppIcon slot in Xcode's asset catalog editor).

Until then the app builds and runs with a blank icon; archive validation for the App Store will fail, which is expected.

Note: brand tokens come from the Brand Guidelines HTML, never from code. Orange/cream assets are the STALE previous brand; do not use them.
