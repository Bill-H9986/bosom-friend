# Acceptance Standard

## Machine tests cannot prove a product works

A route existing, an HTTP 200, or a console with no error is infrastructure evidence, not user
acceptance. User acceptance must be performed through the real desktop UI.

## Required scenario: delete and refresh

1. Create or import an item in the real UI.
2. Record its visible title/id.
3. Delete it through the UI.
4. Wait for the success state.
5. Reload the desktop window.
6. Assert the item is absent.
7. Assert related data is not restored by another tab.

This exact pattern catches the current draft-deletion class of bug.

## Required scenario: close and restart

1. Launch the installed EXE through the desktop shortcut.
2. Confirm a desktop window appears and no browser opens.
3. Close the window and choose exit.
4. Assert no owned node/python/chrome process remains.
5. Relaunch and assert the previous user data is intact.

## Failure language

Acceptance reports must state observed behavior and exact repro steps. They must not use
"all green", "no errors", or "seems stable" when user-visible behavior was not verified.
